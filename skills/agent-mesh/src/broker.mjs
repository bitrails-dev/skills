/**
 * @file broker.mjs
 * @description The Agent Mesh Broker Daemon.
 * Single writer for SQLite, hosts the local IPC server, manages single-flight actor queues,
 * turn coalescing, hop limits, and event log streaming.
 */

import { existsSync, writeFileSync, unlinkSync, appendFileSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { initDatabase, MeshRepository } from "./db.mjs";
import { getIpcAddress, startIpcServer } from "./ipc.mjs";
import { createClaudeDriver } from "./drivers/claude.mjs";
import { createOpenCodeDriver } from "./drivers/opencode.mjs";
import { createPiDriver } from "./drivers/pi.mjs";
import { createAntigravityDriver } from "./drivers/antigravity.mjs";
import { createCodexDriver } from "./drivers/codex.mjs";
import { createAcpDriver } from "./drivers/acp.mjs";
import { ensureAgentWorktree } from "./worktree.mjs";
import { VERSION } from "./version.mjs";

/**
 * Safe process liveness check.
 * On Windows and POSIX, process.kill(pid, 0) throws ESRCH if the process is dead.
 * EPERM means the process is alive but belongs to another user / elevated context.
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

export class AgentMeshBroker {
  /**
   * @param {string} [cwd=process.cwd()] - Target repository root directory.
   * @param {object} [options={}] - Optional broker configuration.
   * @param {string} [options.version] - Broker version override.
   * @param {number} [options.drainTimeoutMs] - Timeout in ms for draining active turns.
   */
  constructor(cwd = process.cwd(), options = {}) {
    this.cwd = resolve(cwd);
    this.version = options.version !== undefined ? options.version : VERSION;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 5000;
    this.draining = false;
    this.stopped = new Promise((resolve) => {
      this.stoppedResolve = resolve;
    });

    this.meshDir = join(this.cwd, ".agent-mesh");
    this.logsDir = join(this.meshDir, "logs");
    this.dbPath = join(this.meshDir, "mesh.db");
    this.brokerPidPath = join(this.meshDir, "broker.json");
    this.ipcAddress = getIpcAddress(this.cwd);

    mkdirSync(this.logsDir, { recursive: true });

    this.db = initDatabase(this.dbPath);
    this.repo = new MeshRepository(this.db);

    this.drivers = new Map();
    this.busyAgents = new Set();
    this.activeTurns = new Map(); // agentId -> AbortController
    this.turnRetries = new Map(); // agentId -> consecutive failed turns
    this.messageRetries = new Map(); // ticketId -> retry attempts
    this.ipcServer = null;
    this.maintenanceTimer = null;
    this.running = false;

    // Register built-in drivers
    this.registerDriver("claude", createClaudeDriver());
    this.registerDriver("opencode", createOpenCodeDriver());
    this.registerDriver("pi", createPiDriver());
    this.registerDriver("antigravity", createAntigravityDriver());
    this.registerDriver("codex", createCodexDriver());
    this.registerDriver("acp", createAcpDriver());

    // Alias map to prevent duplicate session records
    this.aliases = new Map([
      ["agy", "antigravity"],
    ]);
  }

  /**
   * Resolves canonical agent name.
   * @param {string} name
   */
  resolveAgent(name) {
    return this.aliases.get(name) || name;
  }

  /**
   * Registers a harness driver with the broker.
   * @param {string} name
   * @param {object} driver
   */
  registerDriver(name, driver) {
    this.drivers.set(name, driver);
  }

  /**
   * Starts the broker daemon and IPC server.
   */
  async start() {
    this.running = true;

    // 1. Start IPC server first to guarantee exclusive broker ownership
    this.ipcServer = await startIpcServer(this.ipcAddress, (req) => this.handleIpcRequest(req));

    // 2. B2: Requeue any messages that were left in 'claimed' state by a previous crash
    this.db.exec("UPDATE messages SET status = 'pending' WHERE status = 'claimed';");

    // 3. Record daemon PID and active version (omitted if null to simulate legacy daemon)
    const brokerMeta = {
      pid: process.pid,
      cwd: this.cwd,
      ipcAddress: this.ipcAddress,
      startedAt: Date.now(),
    };
    if (this.version) {
      brokerMeta.version = this.version;
    }
    writeFileSync(this.brokerPidPath, JSON.stringify(brokerMeta, null, 2));

    // Mirror active broker pointer to user-global ~/.agent-mesh/broker.json atomically
    try {
      const meshHome = process.env.MESH_HOME || homedir();
      const globalMeshDir = join(meshHome, ".agent-mesh");
      mkdirSync(globalMeshDir, { recursive: true });
      const globalBrokerPath = join(globalMeshDir, "broker.json");
      const tmpPath = `${globalBrokerPath}.${process.pid}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(brokerMeta, null, 2), "utf8");
      renameSync(tmpPath, globalBrokerPath);
    } catch {}

    // 4. Register process exit cleanup
    const cleanup = () => this.stop();
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);

    // 5. Start maintenance timer (30s) for background lease reaping and dispatch
    this.maintenanceTimer = setInterval(() => {
      this.reapStaleLeases();
      this.scheduleDispatch();
    }, 30000);

    // 6. Initial check for pending messages across all registered harnesses
    this.scheduleDispatch();

    return { ok: true, pid: process.pid, address: this.ipcAddress };
  }

  /**
   * Handles incoming IPC requests from mesh CLI or agent tools.
   * @param {object} req
   */
  async handleIpcRequest(req) {
    if (this.draining && req.action !== "ping") {
      return { ok: false, error: "broker is draining", retryable: true };
    }

    switch (req.action) {
      case "ping":
        return { ok: true, version: this.version || undefined, pid: process.pid };

      case "restart":
      case "shutdown": {
        this.draining = true;
        setImmediate(() => this.gracefulShutdown());
        return { ok: true, draining: true, version: this.version };
      }

      case "send":
      case "ask": {
        const msg = req.payload;
        let toTarget = msg.to;
        let toSession = msg.toSession || null;
        if (typeof toTarget === "string" && toTarget.includes("@")) {
          const parts = toTarget.split("@");
          toTarget = parts[0];
          toSession = parts[1];
        }
        msg.to = this.resolveAgent(toTarget);
        msg.toSession = toSession;
        msg.from = this.resolveAgent(msg.from);

        if (!msg.id) msg.id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        if (msg.hops === undefined) msg.hops = 0;

        // Hop limit check (H3)
        if (msg.hops >= 6) {
          return { ok: false, error: `Hop limit reached (${msg.hops} >= 6). Message dropped.` };
        }

        const res = this.repo.enqueueMessage(msg);
        this.scheduleDispatch();
        return { ok: true, ticket: msg.id, createdAt: res.createdAt };
      }

      case "reply": {
        const { ticket, from, to, body } = req.payload;
        const targetTo = this.resolveAgent(to);
        const sourceFrom = this.resolveAgent(from);
        const parent = this.repo.getMessage(ticket);
        const hops = parent ? (parent.hops || 0) + 1 : 1;

        if (hops >= 6) {
          return { ok: false, error: `Hop limit exceeded (${hops} >= 6).` };
        }

        const replyMsg = {
          id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          conversationId: parent?.conversation_id || "conv-default",
          parentId: ticket,
          from: sourceFrom,
          to: targetTo,
          kind: "reply",
          priority: 1, // Replies get higher priority
          hops,
          body,
        };

        const res = this.repo.enqueueMessage(replyMsg);
        this.scheduleDispatch();
        return { ok: true, ticket: replyMsg.id, parentId: ticket };
      }

      case "session_event": {
        const { harness, sessionId, event, pid, cwd, origin } = req.payload;
        const resolvedHarness = this.resolveAgent(harness);
        const res = this.repo.updateSessionEvent({
          harness: resolvedHarness,
          sessionId,
          event,
          pid: Number(pid) || null,
          cwd: cwd || this.cwd,
          origin: origin || "interactive",
        });

        // Dual-writer rule: if a human starts interacting with a session currently used by a headless turn, abort it
        if (event === "start" || event === "busy") {
          if (this.activeTurns.has(resolvedHarness)) {
            const currentTurn = this.activeTurns.get(resolvedHarness);
            if (currentTurn.sessionId === sessionId) {
              currentTurn.abort();
            }
          }
        }

        return { ok: true, state: res.state };
      }

      case "status": {
        this.reapStaleLeases();
        const pending = this.repo.getPendingCounts();
        const liveSessions = this.repo.listLiveSessions();
        const activeSessions = [];
        for (const [harness] of this.drivers) {
          const sess = this.repo.getActiveSession(harness);
          if (sess) activeSessions.push(sess);
        }

        return {
          ok: true,
          pid: process.pid,
          version: this.version,
          busyAgents: Array.from(this.busyAgents),
          pendingCounts: pending,
          sessions: activeSessions,
          liveSessions,
        };
      }

      case "inbox": {
        const targetAgent = this.resolveAgent(req.payload.agent);
        const messages = req.payload.delivered
          ? this.repo.getDeliveredMessages(targetAgent, req.payload.limit || 20)
          : this.repo.getPendingMessages(targetAgent);
        return { ok: true, messages };
      }

      case "ack": {
        // H5: consumers (stop hook) confirm delivery of previously claimed tickets
        const ids = Array.isArray(req.payload.ids) ? req.payload.ids : [];
        for (const id of ids) {
          this.repo.markDelivered(id);
        }
        return { ok: true, acknowledged: ids.length };
      }

      case "claim_inbox": {
        // Atomically claims messages so interactive hooks consume them without duplicates
        const targetAgent = this.resolveAgent(req.payload.agent);
        const sessionId = req.payload.sessionId || null;
        const messages = this.repo.claimMessagesForAgent(targetAgent, sessionId);
        return { ok: true, messages };
      }

      case "lease_acquire": {
        const agent = this.resolveAgent(req.payload.agent);
        const driver = this.drivers.get(agent);
        if (!driver) {
          return { ok: false, error: `No driver registered for agent: ${agent}` };
        }

        // If turn is in flight, abort it (its own cleanup restores messages and clears busy)
        if (this.activeTurns.has(agent)) {
          this.activeTurns.get(agent).abort();
        }

        // Track holder PID so stale leases can be reaped when the holder dies (H6)
        const leaseHolder = req.payload.pid ? `human-cli@${req.payload.pid}` : "human-cli";

        let session = this.repo.getActiveSession(agent);
        if (!session) {
          const opened = await driver.open({ cwd: this.cwd });
          this.repo.upsertSession({
            harness: agent,
            sessionId: opened.id,
            cwd: opened.cwd,
            state: "human-held",
            leaseHolder,
          });
          session = { harness: agent, session_id: opened.id, cwd: opened.cwd };
        } else {
          this.repo.updateSessionState(session.session_id, "human-held", leaseHolder);
        }

        const attachArgv = driver.attachArgv({ harness: agent, id: session.session_id, cwd: session.cwd });
        return {
          ok: true,
          agent,
          sessionId: session.session_id,
          attachArgv,
        };
      }

      case "lease_release": {
        const agent = this.resolveAgent(req.payload.agent);
        const session = this.repo.getActiveSession(agent);
        if (session) {
          this.repo.updateSessionState(session.session_id, "idle", null);
        }
        this.scheduleDispatch();
        return { ok: true, agent };
      }

      default:
        return { ok: false, error: `Unknown action: ${req.action}` };
    }
  }

  /**
   * Schedules a sweep to dispatch turns for any idle agents with pending messages.
   */
  scheduleDispatch() {
    setImmediate(() => this.dispatchPending());
  }

  /**
   * Releases human-held leases whose holder process is gone (H6)
   * and transitions dead interactive sessions to closed.
   */
  reapStaleLeases() {
    // 1. Check all live sessions with a recorded PID
    try {
      const live = this.repo.listLiveSessions();
      for (const sess of live) {
        if (sess.pid && !isProcessAlive(sess.pid)) {
          if (sess.origin === "interactive") {
            this.repo.updateSessionState(sess.session_id, "closed", null);
          } else if (sess.state === "human-held") {
            this.repo.updateSessionState(sess.session_id, "idle", null);
          }
        } else if (sess.state === "busy" && sess.updated_at && Date.now() - sess.updated_at > 10 * 60 * 1000) {
          // Stale busy session sweep (skip if currently executing an in-flight headless turn)
          const isInFlight = Array.from(this.activeTurns.values()).some((ctrl) => ctrl.sessionId === sess.session_id);
          if (!isInFlight) {
            this.repo.updateSessionState(sess.session_id, "idle", null);
          }
        }
      }
    } catch {}

    // 2. Also check human-cli@<pid> lease_holders
    for (const [harness] of this.drivers) {
      const s = this.repo.getActiveSession(harness);
      if (s?.state !== "human-held" || !s.lease_holder?.includes("@")) continue;
      const match = s.lease_holder.match(/^human-cli@(\d+)$/);
      if (match) {
        const pid = Number(match[1]);
        if (!isProcessAlive(pid)) {
          this.repo.updateSessionState(s.session_id, "idle", null);
        }
      }
    }
  }

  /**
   * Core Single-Flight Actor dispatch loop.
   */
  async dispatchPending() {
    if (!this.running) return;

    this.reapStaleLeases();

    for (const [agentId, driver] of this.drivers) {
      if (this.busyAgents.has(agentId)) continue;

      // B1: Dual-Writer Protection: Skip automated turns if session lease is human-held
      // or if an active interactive human session exists (it will consume via stop hook / prompt)
      const currentSession = this.repo.getActiveSession(agentId);
      if (currentSession?.state === "human-held") continue;
      if (currentSession?.origin === "interactive" && currentSession?.state !== "closed") continue;

      // Atomically claim all pending messages for this agent
      const messages = this.repo.claimMessagesForAgent(agentId);
      if (!messages || messages.length === 0) continue;

      // Execute single turn asynchronously; never let a turn crash the broker (H1)
      this.busyAgents.add(agentId);
      this.runAgentTurn(agentId, driver, messages)
        .catch((err) => {
          try {
            this.repo.updateSessionStateIf(
              this.repo.getActiveSession(agentId)?.session_id,
              "error",
              "busy"
            );
            for (const m of messages) {
              this.repo.restorePending(m.id);
            }
          } catch {}
          console.error(`[agent-mesh] dispatch error for ${agentId}:`, err?.message || err);
        })
        .finally(() => {
          this.busyAgents.delete(agentId);
          this.scheduleDispatch(); // Re-check in case new messages arrived during turn
        });
    }
  }

  /**
   * Coalesces claimed messages into one prompt and triggers a driver turn.
   * @param {string} agentId
   * @param {object} driver
   * @param {Array<object>} messages
   */
  async runAgentTurn(agentId, driver, messages) {
    const logFile = join(this.logsDir, `${agentId}.jsonl`);
    // H1: log writes must never crash the broker (EBUSY, AV locks, full disk)
    const log = (entry) => {
      try {
        appendFileSync(logFile, `${JSON.stringify({ ...entry, timestamp: new Date().toISOString() })}\n`, "utf8");
      } catch {}
    };

    // C2 race guard: a lease may have been acquired after dispatch claimed these messages
    const preCheck = this.repo.getActiveSession(agentId);
    if (preCheck?.state === "human-held") {
      for (const m of messages) {
        this.repo.restorePending(m.id);
      }
      log({ t: "turn_deferred", reason: "human-held lease", tickets: messages.map((m) => m.id) });
      return;
    }

    // ADR-005: Isolate writing agents in dedicated git worktrees
    let agentCwd = this.cwd;
    try {
      agentCwd = ensureAgentWorktree(this.cwd, agentId);
    } catch (err) {
      log({ t: "worktree_fallback", error: err.message, cwd: agentCwd });
    }

    // C4: agents must know who they are and how to reply
    const maxHops = Math.max(...messages.map((m) => m.hops || 0));
    const meshCli = join(import.meta.dirname, "..", "scripts", "mesh.mjs");
    const turnEnv = {
      MESH_AGENT: agentId,
      MESH_HOPS: String(maxHops),
      MESH_CONVERSATION: messages[0].conversation_id || "conv-default",
      MESH_IPC_ADDRESS: this.ipcAddress,
    };

    // 1. Turn Coalescing with identity + reply routing instructions
    const promptHeader = `[AGENT-MESH INBOX: ${messages.length} pending message(s)]\n`;
    const promptBody = messages
      .map(
        (m, idx) =>
          `=== Message #${idx + 1} ===\nFrom: ${m.from_agent}\nKind: ${m.kind}\nTicket: ${m.id}\nPriority: ${m.priority}\n\n${m.body}\n`
      )
      .join("\n----------------------------------------\n\n");
    const promptFooter = `
--- AGENT MESH ROUTING ---
You are agent '${agentId}' in the agent-mesh coordination network (repo: ${this.cwd}).
Your env carries MESH_AGENT=${agentId}, MESH_HOPS=${maxHops} (max 5), MESH_CONVERSATION, MESH_IPC_ADDRESS.
To reply to a message (asynchronous, fire-and-forget — send it, then finish your turn):
  node ${meshCli} reply --ticket <ticket-id> --to <recipient> "<your response>"
To start a new conversation with another agent:
  node ${meshCli} ask --to <agent> "<message>"
Process the message(s) above, take appropriate action, and reply via the CLI.`;
    const coalescedPrompt = `${promptHeader}\n${promptBody}${promptFooter}`;

    log({ t: "turn_start", count: messages.length, tickets: messages.map((m) => m.id), cwd: agentCwd, hops: maxHops });

    // 2. Open or reuse session
    let session = this.repo.getActiveSession(agentId);
    if (!session) {
      const opened = await driver.open({ cwd: agentCwd });
      this.repo.upsertSession({
        harness: agentId,
        sessionId: opened.id,
        cwd: opened.cwd || agentCwd,
        state: "busy",
      });
      session = { harness: agentId, session_id: opened.id, cwd: opened.cwd || agentCwd };
    } else {
      this.repo.updateSessionState(session.session_id, "busy");
    }

    const abortController = new AbortController();
    abortController.sessionId = session.session_id;
    this.activeTurns.set(agentId, abortController);

    /**
     * H2: failure policy — one retry per message batch, then dead-letter with diagnostics.
     * Aborts (lease takeover) restore to pending without consuming the retry.
     * @param {string} reason
     */
    const handleFailure = (reason, stderr) => {
      this.repo.updateSessionStateIf(session.session_id, "error", "busy");
      for (const m of messages) {
        const attempts = (this.messageRetries.get(m.id) || 0) + 1;
        this.messageRetries.set(m.id, attempts);
        if (attempts <= 1) {
          this.repo.restorePending(m.id);
          log({ t: "turn_retry", attempt: attempts, reason, stderr: stderr || null, tickets: messages.map((m) => m.id) });
        } else {
          this.messageRetries.delete(m.id);
          this.repo.markDead(m.id);
          log({ t: "turn_failed", attempts, reason, stderr: stderr || null, tickets: messages.map((m) => m.id) });
        }
      }
    };

    try {
      const sessionRef = { harness: agentId, id: session.session_id, cwd: session.cwd || agentCwd };
      const eventStream = driver.turn(sessionRef, coalescedPrompt, abortController.signal, { env: turnEnv });

      let failed = null;
      for await (const event of eventStream) {
        log(event);

        if (event.t === "session_init" && event.sessionId) {
          this.repo.upsertSession({
            harness: agentId,
            sessionId: event.sessionId,
            cwd: agentCwd,
            state: "busy",
          });
          session.session_id = event.sessionId;
        }

        if (event.t === "error" && !failed) {
          failed = { reason: event.message, stderr: event.stderr };
        }
      }

      if (abortController.signal.aborted) {
        // Aborted mid-turn (lease takeover): restore messages to pending
        for (const m of messages) {
          this.repo.restorePending(m.id);
        }
      } else if (failed) {
        handleFailure(failed.reason, failed.stderr);
      } else {
        for (const m of messages) {
          this.messageRetries.delete(m.id);
          this.repo.markDelivered(m.id);
        }
        // Success may follow an error event; accept both 'busy' and 'error' origins
        if (!this.repo.updateSessionStateIf(session.session_id, "idle", "busy")) {
          this.repo.updateSessionStateIf(session.session_id, "idle", "error");
        }
        log({ t: "turn_complete", tickets: messages.map((m) => m.id) });
      }
    } catch (err) {
      log({ t: "turn_crash", error: err.message });
      if (abortController.signal.aborted) {
        for (const m of messages) {
          this.repo.restorePending(m.id);
        }
      } else {
        handleFailure(`driver crashed: ${err.message}`);
      }
    } finally {
      if (this.activeTurns.get(agentId) === abortController) {
        this.activeTurns.delete(agentId);
      }
    }
  }

  /**
   * Shuts down the broker and IPC server cleanly with in-flight drain and WAL checkpoint.
   * @param {{ drainMs?: number }} [options={}]
   */
  async gracefulShutdown({ drainMs } = {}) {
    this.running = false;
    this.draining = true;

    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }

    const timeout = drainMs !== undefined ? drainMs : this.drainTimeoutMs;
    const startDrain = Date.now();
    while (this.activeTurns.size > 0 && Date.now() - startDrain < timeout) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // Abort any remaining active turns (aborted controllers trigger turn cleanup to restore messages)
    for (const [, controller] of this.activeTurns) {
      controller.abort();
    }

    // Wait briefly for aborted turns to finish their cleanup/finally blocks
    const abortWait = Date.now();
    while (this.activeTurns.size > 0 && Date.now() - abortWait < 500) {
      await new Promise((r) => setTimeout(r, 20));
    }
    this.activeTurns.clear();

    // Checkpoint SQLite WAL before releasing pipe
    if (this.db) {
      try {
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {}
    }

    // Close IPC server and force close any lingering client sockets
    if (this.ipcServer) {
      await new Promise((res) => {
        this.ipcServer.close(() => res());
        this.ipcServer.closeAllConnections?.();
      });
      this.ipcServer = null;
    }

    // Clean up broker.json
    if (existsSync(this.brokerPidPath)) {
      try {
        unlinkSync(this.brokerPidPath);
      } catch {}
    }

    // Clean up user-global broker.json only if owned by this process
    try {
      const globalBrokerPath = join(homedir(), ".agent-mesh", "broker.json");
      if (existsSync(globalBrokerPath)) {
        const globalData = JSON.parse(readFileSync(globalBrokerPath, "utf8"));
        if (globalData?.pid === process.pid) {
          unlinkSync(globalBrokerPath);
        }
      }
    } catch {}

    // Close DB
    if (this.db) {
      try {
        this.db.close();
        this.db = null;
      } catch {}
    }

    if (this.stoppedResolve) {
      this.stoppedResolve();
    }
  }

  /**
   * Immediate shutdown alias for test teardown and signal handlers.
   */
  async stop() {
    return this.gracefulShutdown({ drainMs: 0 });
  }
}

// Standalone runner
if (process.argv[1]?.endsWith("broker.mjs")) {
  const broker = new AgentMeshBroker(process.cwd());
  broker
    .start()
    .then((info) => {
      console.log(`agent-mesh broker started (PID: ${info.pid}, v${broker.version})`);
      console.log(`IPC Address: ${info.address}`);
    })
    .catch((err) => {
      console.error(`Failed to start broker: ${err.message}`);
      process.exit(1);
    });

  // Runner terminates when graceful shutdown settles
  broker.stopped.then(() => {
    process.exit(0);
  });
}
