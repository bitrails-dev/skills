/**
 * @file presence-test.mjs
 * @description Test suite for Inversion of Control session discovery and lifecycle presence:
 * - session_event registration with authentic UUIDs & PIDs
 * - Targeted session delivery (--to agent@sessionId)
 * - Automatic process reaping when holder process terminates
 * - PID reuse / /clear superseding
 * - Universal presence-hook stdout hygiene and message injection
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { AgentMeshBroker } from "../src/broker.mjs";
import { sendIpcRequest } from "../src/ipc.mjs";

function runChild(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (options.input) {
      proc.stdin.write(options.input);
    }
    proc.stdin.end();
    proc.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    proc.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    proc.on("error", reject);
    proc.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

describe("Session Discovery & Lifecycle Presence Suite", () => {
  let testRepo;
  let broker;
  let ipcAddr;

  before(async () => {
    testRepo = mkdtempSync(join(tmpdir(), "mesh-presence-"));
    broker = new AgentMeshBroker(testRepo);

    broker.registerDriver("claude", {
      name: "claude",
      caps: { delivery: "resume", midTurnInject: false, interrupt: true, concurrentViewers: false, mcp: false, preEditHook: false },
      async probe() { return { ok: true }; },
      async open(spec) { return { harness: "claude", id: "sess-p-test", cwd: spec.cwd }; },
      async *turn(session, prompt, signal, opts) {
        yield { t: "text", text: "ok" };
        yield { t: "done", session };
      },
      attachArgv: (s) => ["claude", "--resume", s.id],
    });

    const startInfo = await broker.start();
    ipcAddr = startInfo.address;
  });

  after(async () => {
    if (broker) await broker.stop();
    if (existsSync(testRepo)) {
      try {
        rmSync(testRepo, { recursive: true, force: true });
      } catch {}
    }
  });

  test("1. session_event registers live interactive session with authentic UUID", async () => {
    const res = await sendIpcRequest(ipcAddr, {
      action: "session_event",
      payload: {
        harness: "claude",
        sessionId: "auth-uuid-1234",
        event: "start",
        pid: process.pid,
        cwd: testRepo,
        origin: "interactive",
      },
    });
    assert.equal(res.ok, true);
    assert.equal(res.state, "idle");

    const status = await sendIpcRequest(ipcAddr, { action: "status" });
    assert.equal(status.ok, true);
    const live = status.liveSessions.find((s) => s.session_id === "auth-uuid-1234");
    assert.ok(live, "Live session must be listed in status");
    assert.equal(live.origin, "interactive");
    assert.equal(live.pid, process.pid);
  });

  test("2. Targeted message routing: --to claude@<sessionId> isolates delivery", async () => {
    // Register second session
    await sendIpcRequest(ipcAddr, {
      action: "session_event",
      payload: {
        harness: "claude",
        sessionId: "auth-uuid-target-5678",
        event: "start",
        pid: process.pid,
        cwd: testRepo,
        origin: "interactive",
      },
    });

    // Enqueue message specifically targeted to auth-uuid-target-5678
    const enq = await sendIpcRequest(ipcAddr, {
      action: "ask",
      payload: {
        from: "pi",
        to: "claude@auth-uuid-target-5678",
        body: "Confidential for session 5678 only",
      },
    });
    assert.equal(enq.ok, true);

    // Terminal 1 (auth-uuid-1234) attempts claim: should receive 0 messages
    const claim1 = await sendIpcRequest(ipcAddr, {
      action: "claim_inbox",
      payload: { agent: "claude", sessionId: "auth-uuid-1234" },
    });
    assert.equal(claim1.ok, true);
    assert.equal(claim1.messages.length, 0, "Non-targeted session must not steal messages");

    // Terminal 2 (auth-uuid-target-5678) attempts claim: receives the targeted message
    const claim2 = await sendIpcRequest(ipcAddr, {
      action: "claim_inbox",
      payload: { agent: "claude", sessionId: "auth-uuid-target-5678" },
    });
    assert.equal(claim2.ok, true);
    assert.equal(claim2.messages.length, 1);
    assert.equal(claim2.messages[0].body, "Confidential for session 5678 only");

    // Acknowledge receipt
    await sendIpcRequest(ipcAddr, {
      action: "ack",
      payload: { ids: [enq.ticket] },
    });
  });

  test("3. Process reaper: dead process PID transitions session to closed", async () => {
    // Spawn a temporary node child process
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });
    const childPid = child.pid;

    await sendIpcRequest(ipcAddr, {
      action: "session_event",
      payload: {
        harness: "claude",
        sessionId: "ephemeral-sess-9999",
        event: "start",
        pid: childPid,
        cwd: testRepo,
        origin: "interactive",
      },
    });

    let status = await sendIpcRequest(ipcAddr, { action: "status" });
    assert.ok(status.liveSessions.some((s) => s.session_id === "ephemeral-sess-9999"));

    // Terminate the child process
    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 100));

    // Next status check reaps dead PID
    status = await sendIpcRequest(ipcAddr, { action: "status" });
    const found = status.liveSessions.find((s) => s.session_id === "ephemeral-sess-9999");
    assert.equal(found, undefined, "Dead child session must be reaped from live sessions");

    const dbSession = broker.repo.getMessage ? broker.repo.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("ephemeral-sess-9999") : null;
    assert.equal(dbSession?.state, "closed");
  });

  test("4. PID reuse / /clear: new session with same PID supersedes old session", async () => {
    await sendIpcRequest(ipcAddr, {
      action: "session_event",
      payload: {
        harness: "claude",
        sessionId: "clear-old-session-1111",
        event: "start",
        pid: 88887,
        cwd: testRepo,
        origin: "interactive",
      },
    });

    // User runs /clear in Claude Code: same terminal PID, brand new session ID
    await sendIpcRequest(ipcAddr, {
      action: "session_event",
      payload: {
        harness: "claude",
        sessionId: "clear-new-session-2222",
        event: "start",
        pid: 88887,
        cwd: testRepo,
        origin: "interactive",
      },
    });

    const oldSess = broker.repo.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("clear-old-session-1111");
    const newSess = broker.repo.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("clear-new-session-2222");

    assert.equal(oldSess.state, "closed", "Old session must be superseded to closed");
    assert.equal(newSess.state, "idle", "New session must be active and idle");
  });

  test("5. Universal presence hook: clean stdout on SessionStart and block injection on Stop", async () => {
    const hookScript = join(import.meta.dirname, "../src/hooks/presence-hook.mjs");

    // 1. SessionStart must emit nothing to stdout
    const startProc = await runChild(process.execPath, [hookScript], {
      cwd: testRepo,
      env: { ...process.env, MESH_IPC_ADDRESS: ipcAddr },
      input: JSON.stringify({
        session_id: "presence-hook-session-3333",
        hook_event_name: "SessionStart",
        cwd: testRepo,
      }),
    });
    assert.equal(startProc.status, 0);
    assert.equal(startProc.stdout.trim(), "", "SessionStart hook must print nothing to stdout");

    // Verify session registered in broker
    const status = await sendIpcRequest(ipcAddr, { action: "status" });
    assert.ok(status.liveSessions.some((s) => s.session_id === "presence-hook-session-3333"));

    // 2. Queue a message for this session
    const enq = await sendIpcRequest(ipcAddr, {
      action: "ask",
      payload: { from: "pi", to: "claude@presence-hook-session-3333", body: "Check this presence test" },
    });
    assert.equal(enq.ok, true);

    // 3. Stop hook triggers with waiting messages: must emit decision: block
    const stopProc = await runChild(process.execPath, [hookScript], {
      cwd: testRepo,
      env: { ...process.env, MESH_IPC_ADDRESS: ipcAddr },
      input: JSON.stringify({
        session_id: "presence-hook-session-3333",
        hook_event_name: "Stop",
        stop_hook_active: false,
      }),
    });
    assert.equal(stopProc.status, 0);
    const decision = JSON.parse(stopProc.stdout.trim().split("\n").pop());
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /Check this presence test/);

    // 4. Second Stop with no messages: must output empty string and exit 0
    const emptyStop = await runChild(process.execPath, [hookScript], {
      cwd: testRepo,
      env: { ...process.env, MESH_IPC_ADDRESS: ipcAddr },
      input: JSON.stringify({
        session_id: "presence-hook-session-3333",
        hook_event_name: "Stop",
        stop_hook_active: false,
      }),
    });
    assert.equal(emptyStop.status, 0);
    assert.equal(emptyStop.stdout.trim(), "", "Stop hook with no waiting messages must print nothing");

    // 5. SessionEnd: cleans up session and marks closed in broker
    const endProc = await runChild(process.execPath, [hookScript], {
      cwd: testRepo,
      env: { ...process.env, MESH_IPC_ADDRESS: ipcAddr },
      input: JSON.stringify({
        session_id: "presence-hook-session-3333",
        hook_event_name: "SessionEnd",
        cwd: testRepo,
      }),
    });
    assert.equal(endProc.status, 0);

    const afterEndStatus = await sendIpcRequest(ipcAddr, { action: "status" });
    const endedSess = afterEndStatus.liveSessions.find((s) => s.session_id === "presence-hook-session-3333");
    assert.equal(endedSess, undefined, "Ended session must not be present in liveSessions");
  });

  test("6. Codex harness presence: registers and announces under codex harness name", async () => {
    const hookScript = join(import.meta.dirname, "../src/hooks/presence-hook.mjs");

    const codexStart = await runChild(process.execPath, [hookScript, "--harness", "codex", "--event", "SessionStart"], {
      cwd: testRepo,
      env: { ...process.env, MESH_IPC_ADDRESS: ipcAddr },
      input: JSON.stringify({
        session_id: "codex-test-session-5555",
        cwd: testRepo,
      }),
    });
    assert.equal(codexStart.status, 0);

    const status = await sendIpcRequest(ipcAddr, { action: "status" });
    const codexSess = status.liveSessions.find((s) => s.session_id === "codex-test-session-5555");
    assert.ok(codexSess, "Codex session must be registered");
    assert.equal(codexSess.harness, "codex");
    assert.equal(codexSess.state, "idle");
  });
});
