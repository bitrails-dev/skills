/**
 * @file broker.mjs
 * @description The Agent Mesh Broker Daemon.
 * Single writer for SQLite, hosts the local IPC server, manages single-flight actor queues,
 * turn coalescing, hop limits, and event log streaming.
 */

import { existsSync, writeFileSync, unlinkSync, appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { initDatabase, MeshRepository } from "./db.mjs";
import { getIpcAddress, startIpcServer } from "./ipc.mjs";
import { createClaudeDriver } from "./drivers/claude.mjs";
import { createOpenCodeDriver } from "./drivers/opencode.mjs";
import { createPiDriver } from "./drivers/pi.mjs";
import { createAntigravityDriver } from "./drivers/antigravity.mjs";
import { createCodexDriver } from "./drivers/codex.mjs";
import { createAcpDriver } from "./drivers/acp.mjs";
import { ensureAgentWorktree } from "./worktree.mjs";

export class AgentMeshBroker {
  /**
   * @param {string} cwd - Target repository root directory.
   */
  constructor(cwd = process.cwd()) {
    this.cwd = resolve(cwd);
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
    this.ipcServer = null;
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

    // 3. Record daemon PID
    writeFileSync(
      this.brokerPidPath,
      JSON.stringify(
        {
          pid: process.pid,
          cwd: this.cwd,
          ipcAddress: this.ipcAddress,
          startedAt: Date.now(),
        },
        null,
        2
      )
    );

    // 4. Register process exit cleanup
    const cleanup = () => this.stop();
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);

    // 5. Initial check for pending messages across all registered harnesses
    this.scheduleDispatch();

    return { ok: true, pid: process.pid, address: this.ipcAddress };
  }

  /**
   * Handles incoming IPC requests from mesh CLI or agent tools.
   * @param {object} req
   */
  async handleIpcRequest(req) {
    switch (req.action) {
      case "send":
      case "ask": {
        const msg = req.payload;
        msg.to = this.resolveAgent(msg.to);
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

      case "status": {
        const pending = this.repo.getPendingCounts();
        const activeSessions = [];
        for (const [harness] of this.drivers) {
          const sess = this.repo.getActiveSession(harness);
          if (sess) activeSessions.push(sess);
        }

        return {
          ok: true,
          pid: process.pid,
          busyAgents: Array.from(this.busyAgents),
          pendingCounts: pending,
          sessions: activeSessions,
        };
      }

      case "inbox": {
        const targetAgent = this.resolveAgent(req.payload.agent);
        const messages = this.repo.getPendingMessages(targetAgent);
        return { ok: true, messages };
      }

      case "claim_inbox": {
        // H2: Atomically claims messages so interactive hooks consume them without duplicates
        const targetAgent = this.resolveAgent(req.payload.agent);
        const messages = this.repo.claimMessagesForAgent(targetAgent);
        return { ok: true, messages };
      }

      case "lease_acquire": {
        const agent = this.resolveAgent(req.payload.agent);
        const driver = this.drivers.get(agent);
        if (!driver) {
          return { ok: false, error: `No driver registered for agent: ${agent}` };
        }

        // If turn is in flight, abort it and restore claimed messages to pending
        if (this.activeTurns.has(agent)) {
          this.activeTurns.get(agent).abort();
          this.busyAgents.delete(agent);
          this.db.exec("UPDATE messages SET status = 'pending' WHERE to_agent = ? AND status = 'claimed';", [agent]);
        }

        let session = this.repo.getActiveSession(agent);
        if (!session) {
          const opened = await driver.open({ cwd: this.cwd });
          this.repo.upsertSession({
            harness: agent,
            sessionId: opened.id,
            cwd: opened.cwd,
            state: "human-held",
            leaseHolder: "human-cli",
          });
          session = { harness: agent, session_id: opened.id, cwd: opened.cwd };
        } else {
          this.repo.updateSessionState(session.session_id, "human-held", "human-cli");
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
   * Core Single-Flight Actor dispatch loop.
   */
  async dispatchPending() {
    if (!this.running) return;

    for (const [agentId, driver] of this.drivers) {
      if (this.busyAgents.has(agentId)) continue;

      // B1: Dual-Writer Protection: Skip automated turns if session lease is human-held
      const currentSession = this.repo.getActiveSession(agentId);
      if (currentSession?.state === "human-held") continue;

      // Atomically claim all pending messages for this agent
      const messages = this.repo.claimMessagesForAgent(agentId);
      if (!messages || messages.length === 0) continue;

      // Execute single turn asynchronously
      this.busyAgents.add(agentId);
      this.runAgentTurn(agentId, driver, messages).finally(() => {
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
    const log = (entry) => {
      appendFileSync(logFile, `${JSON.stringify({ ...entry, timestamp: new Date().toISOString() })}\n`, "utf8");
    };

    // ADR-005: Isolate writing agents in dedicated git worktrees
    const agentCwd = ensureAgentWorktree(this.cwd, agentId);

    // 1. Turn Coalescing
    const promptHeader = `[AGENT-MESH INBOX: ${messages.length} pending message(s)]\n`;
    const promptBody = messages
      .map(
        (m, idx) =>
          `=== Message #${idx + 1} ===\nFrom: ${m.from_agent}\nKind: ${m.kind}\nTicket: ${m.id}\nPriority: ${m.priority}\n\n${m.body}\n`
      )
      .join("\n----------------------------------------\n\n");
    const coalescedPrompt = `${promptHeader}\n${promptBody}\nInstructions: Process the above message(s) and take appropriate action. To reply to any request, state your response clearly.`;

    log({ t: "turn_start", count: messages.length, tickets: messages.map((m) => m.id), cwd: agentCwd });

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
    this.activeTurns.set(agentId, abortController);

    try {
      const sessionRef = { harness: agentId, id: session.session_id, cwd: session.cwd || agentCwd };
      const eventStream = driver.turn(sessionRef, coalescedPrompt, abortController.signal);

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

        if (event.t === "error") {
          log({ t: "turn_error", error: event.message });
          this.repo.updateSessionStateIf(session.session_id, "error", "busy");
        }
      }

      // 3. Mark all claimed messages as delivered only if turn was not aborted
      if (!abortController.signal.aborted) {
        for (const m of messages) {
          this.repo.markDelivered(m.id);
        }
        this.repo.updateSessionStateIf(session.session_id, "idle", "busy");
        log({ t: "turn_complete", tickets: messages.map((m) => m.id) });
      } else {
        // Aborted mid-turn: restore messages to pending
        for (const m of messages) {
          this.db.exec("UPDATE messages SET status = 'pending' WHERE id = ?;", [m.id]);
        }
      }
    } catch (err) {
      log({ t: "turn_crash", error: err.message });
      if (abortController.signal.aborted) {
        for (const m of messages) {
          this.db.exec("UPDATE messages SET status = 'pending' WHERE id = ?;", [m.id]);
        }
      } else {
        this.repo.updateSessionStateIf(session.session_id, "error", "busy");
        // On actual crash, mark claimed messages dead to avoid stranding
        for (const m of messages) {
          this.repo.markDead(m.id);
        }
      }
    } finally {
      this.activeTurns.delete(agentId);
    }
  }

  /**
   * Shuts down the broker and IPC server cleanly.
   */
  async stop() {
    this.running = false;

    // Abort active turns
    for (const [agentId, controller] of this.activeTurns) {
      controller.abort();
    }
    this.activeTurns.clear();

    // Close IPC server
    if (this.ipcServer) {
      this.ipcServer.close();
      this.ipcServer = null;
    }

    // Clean up broker.json
    if (existsSync(this.brokerPidPath)) {
      try {
        unlinkSync(this.brokerPidPath);
      } catch {}
    }

    // Close DB
    if (this.db) {
      try {
        this.db.close();
      } catch {}
    }
  }
}

// Standalone runner
if (process.argv[1]?.endsWith("broker.mjs")) {
  const broker = new AgentMeshBroker(process.cwd());
  broker
    .start()
    .then((info) => {
      console.log(`agent-mesh broker started (PID: ${info.pid})`);
      console.log(`IPC Address: ${info.address}`);
    })
    .catch((err) => {
      console.error(`Failed to start broker: ${err.message}`);
      process.exit(1);
    });
}
