/**
 * @file mesh-routing-test.mjs
 * @description Regression suite for C4 (agent identity, reply routing, inbox, hop pass-through),
 * H1/H2 (turn crash resilience + retry/dead-letter policy), H5 (stop hook claim/ack/loop-guard),
 * H6 (stale lease reaping), and Windows-safe child spawning.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { AgentMeshBroker } from "../src/broker.mjs";
import { sendIpcRequest } from "../src/ipc.mjs";
import { spawnChild } from "../src/drivers/base.mjs";

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

async function waitFor(fn, timeout = 5000, interval = 25) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error("waitFor timed out");
}

describe("Phase 5: Routing, Resilience & Hardening", () => {
  let testRepo;
  let broker;
  let ipcAddr;

  // Mutable mock driver behavior for the 'claude' agent
  let captured = { prompt: null, opts: null };
  let turnCalls = 0;
  let failMode = "none"; // 'none' | 'always' | 'first'

  before(async () => {
    testRepo = mkdtempSync(join(tmpdir(), "mesh-routing-"));
    broker = new AgentMeshBroker(testRepo);

    broker.registerDriver("claude", {
      name: "claude",
      caps: { delivery: "resume", midTurnInject: false, interrupt: true, concurrentViewers: false, mcp: false, preEditHook: false },
      async probe() {
        return { ok: true };
      },
      async open(spec) {
        return { harness: "claude", id: "sess-routing", cwd: spec.cwd };
      },
      async *turn(session, prompt, signal, opts) {
        turnCalls++;
        captured = { prompt, opts };
        if (failMode === "always" || (failMode === "first" && turnCalls === 1)) {
          yield { t: "error", message: "simulated driver failure", retryable: true };
          return;
        }
        yield { t: "text", text: "mock turn ok" };
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

  test("1. spawnChild executes bare command names on the host platform", async () => {
    const child = spawnChild("node", ["-e", "console.log('mesh-spawn-ok')"]);
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    const code = await new Promise((r) => child.on("close", r));
    assert.equal(code, 0);
    assert.match(out, /mesh-spawn-ok/);
  });

  test("2. C4: turn prompt carries identity + reply instructions; driver receives MESH_* env", async () => {
    const res = await sendIpcRequest(ipcAddr, {
      action: "ask",
      payload: { from: "human-cli", to: "claude", body: "Analyze hop routing please" },
    });
    assert.equal(res.ok, true);

    await waitFor(() => broker.repo.getMessage(res.ticket)?.status === "delivered");

    assert.match(captured.prompt, /You are agent 'claude'/);
    assert.match(captured.prompt, /mesh\.mjs reply --ticket/);
    assert.match(captured.prompt, /MESH_AGENT=claude/);
    assert.equal(captured.opts?.env?.MESH_AGENT, "claude");
    assert.equal(captured.opts?.env?.MESH_HOPS, "0");
    assert.equal(captured.opts?.env?.MESH_CONVERSATION, "conv-default");
  });

  test("3. H2: failed turn retries once, then recovers and delivers", async () => {
    turnCalls = 0;
    failMode = "first";
    const res = await sendIpcRequest(ipcAddr, {
      action: "ask",
      payload: { from: "human-cli", to: "claude", body: "retry me" },
    });

    await waitFor(() => broker.repo.getMessage(res.ticket)?.status === "delivered");
    assert.equal(turnCalls, 2, "exactly one retry should occur");

    const log = readFileSync(join(testRepo, ".agent-mesh", "logs", "claude.jsonl"), "utf8");
    assert.match(log, /turn_retry/);
    assert.match(log, /simulated driver failure/);
    failMode = "none";
  });

  test("4. H2: repeated failure dead-letters the batch with diagnostics", async () => {
    turnCalls = 0;
    failMode = "always";
    const res = await sendIpcRequest(ipcAddr, {
      action: "ask",
      payload: { from: "human-cli", to: "claude", body: "doomed message" },
    });

    await waitFor(() => broker.repo.getMessage(res.ticket)?.status === "dead");
    assert.equal(turnCalls, 2, "initial attempt + one retry, then dead-letter");

    const log = readFileSync(join(testRepo, ".agent-mesh", "logs", "claude.jsonl"), "utf8");
    assert.match(log, /turn_failed/);
    failMode = "none";
  });

  test("5. C4: CLI inherits MESH_AGENT/MESH_HOPS from env; mesh inbox lists pending", async () => {
    const lease = await sendIpcRequest(ipcAddr, {
      action: "lease_acquire",
      payload: { agent: "claude", pid: process.pid },
    });
    assert.equal(lease.ok, true);

    const cli = join(import.meta.dirname, "../scripts/mesh.mjs");
    const proc = await runChild(process.execPath, [cli, "ask", "--to", "claude", "hop pass-through body"], {
      cwd: testRepo,
      env: { ...process.env, MESH_AGENT: "codex", MESH_HOPS: "3", MESH_IPC_ADDRESS: ipcAddr },
    });
    assert.equal(proc.status, 0, proc.stderr);

    const pending = broker.repo.getPendingMessages("claude");
    const msg = pending.find((m) => m.body === "hop pass-through body");
    assert.ok(msg, "message must remain pending under human-held lease");
    assert.equal(msg.from_agent, "codex");
    assert.equal(msg.hops, 4, "agent-sent ask must increment hops from 3 to 4");

    const inboxProc = await runChild(process.execPath, [cli, "inbox", "claude"], {
      cwd: testRepo,
      env: { ...process.env, MESH_IPC_ADDRESS: ipcAddr },
    });
    assert.equal(inboxProc.status, 0, inboxProc.stderr);
    assert.match(inboxProc.stdout, /hop pass-through body/);
  });

  test("6. H5: stop hook claims, blocks, acks; loop guard leaves messages pending", async () => {
    const hookPath = join(import.meta.dirname, "../src/hooks/stop-hook.mjs");

    // Lease already held from test 5, so dispatch leaves messages for the hook
    const enq = await sendIpcRequest(ipcAddr, {
      action: "ask",
      payload: { from: "pi", to: "claude", body: "urgent review request body" },
    });
    assert.equal(enq.ok, true);

    const first = await runChild(process.execPath, [hookPath], {
      cwd: testRepo,
      env: { ...process.env, MESH_IPC_ADDRESS: ipcAddr },
      input: JSON.stringify({ session_id: "abc", stop_hook_active: false }),
    });
    const decision = JSON.parse(first.stdout.trim().split("\n").pop());
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /urgent review request body/);
    assert.equal(broker.repo.getMessage(enq.ticket).status, "delivered", "ack must mark ticket delivered");

    const delivered = await runChild(
      process.execPath,
      [join(import.meta.dirname, "../scripts/mesh.mjs"), "inbox", "claude", "--delivered"],
      { cwd: testRepo, env: { ...process.env, MESH_IPC_ADDRESS: ipcAddr } }
    );
    assert.match(delivered.stdout, /urgent review request body/);

    // Loop guard: stop_hook_active from stdin must short-circuit without claiming (empty stdout on allow)
    const enq2 = await sendIpcRequest(ipcAddr, {
      action: "ask",
      payload: { from: "pi", to: "claude", body: "must stay pending" },
    });
    const second = await runChild(process.execPath, [hookPath], {
      cwd: testRepo,
      env: { ...process.env, MESH_IPC_ADDRESS: ipcAddr },
      input: JSON.stringify({ session_id: "abc", stop_hook_active: true }),
    });
    assert.equal(second.stdout.trim(), "", "allow path must write empty stdout");
    assert.equal(broker.repo.getMessage(enq2.ticket).status, "pending");

    const release = await sendIpcRequest(ipcAddr, {
      action: "lease_release",
      payload: { agent: "claude" },
    });
    assert.equal(release.ok, true);
  });

  test("7. H6: stale lease with dead holder PID is reaped on status", async () => {
    const session = broker.repo.getActiveSession("claude");
    broker.repo.updateSessionState(session.session_id, "human-held", "human-cli@999999999");

    const status = await sendIpcRequest(ipcAddr, { action: "status" });
    assert.equal(status.ok, true);
    const reaped = status.sessions.find((s) => s.harness === "claude");
    assert.equal(reaped?.state, "idle", "dead holder lease must be reaped to idle");
  });
});
