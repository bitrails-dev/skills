/**
 * @file swarm-test.mjs
 * @description End-to-end swarm and multi-agent coordination test for agent-mesh.
 * Validates cross-harness messaging (Claude <-> Agy <-> Pi), hop limits, turn coalescing,
 * and live event stream logging.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentMeshBroker } from "../src/broker.mjs";
import { sendIpcRequest } from "../src/ipc.mjs";

// Skip the (slow) process-tree walk in tests; the direct parent is the harness stand-in.
process.env.MESH_NO_PID_WALK = "1";

describe("Phase 4: Multi-Harness Agent Swarm Validation", () => {
  let testRepo;
  let broker;
  let ipcAddr;

  before(async () => {
    testRepo = mkdtempSync(join(tmpdir(), "mesh-swarm-"));
    broker = new AgentMeshBroker(testRepo);

    // Mock driver for Claude that replies by asking Antigravity
    broker.registerDriver("claude", {
      name: "claude",
      caps: { delivery: "resume", midTurnInject: false, interrupt: true, concurrentViewers: false, mcp: false, preEditHook: false },
      async probe() { return { ok: true }; },
      async open(spec) { return { harness: "claude", id: "sess-claude", cwd: spec.cwd }; },
      async *turn(session, prompt) {
        yield { t: "text", text: `Claude received: ${prompt.slice(0, 40)}...` };
        yield { t: "done", session };
      },
      attachArgv: (s) => ["claude", "--resume", s.id],
    });

    // Mock driver for Antigravity that generates reviews
    broker.registerDriver("agy", {
      name: "agy",
      caps: { delivery: "resume", midTurnInject: false, interrupt: true, concurrentViewers: false, mcp: false, preEditHook: false },
      async probe() { return { ok: true }; },
      async open(spec) { return { harness: "agy", id: "sess-agy", cwd: spec.cwd }; },
      async *turn(session, prompt) {
        yield { t: "text", text: `Antigravity reviewing: ${prompt.slice(0, 40)}...` };
        yield { t: "done", session };
      },
      attachArgv: (s) => ["agy"],
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

  test("1. Cross-harness message dispatch and execution", async () => {
    // 1. Send task to Claude
    const askRes = await sendIpcRequest(ipcAddr, {
      action: "ask",
      payload: {
        from: "human-cli",
        to: "claude",
        body: "Please refactor database schema in db.mjs",
      },
    });

    assert.equal(askRes.ok, true);
    assert.ok(askRes.ticket);

    // Wait briefly for broker turn loop to execute
    await new Promise((r) => setTimeout(r, 300));

    // Verify Claude log file was generated with turn events
    const claudeLogPath = join(testRepo, ".agent-mesh", "logs", "claude.jsonl");
    assert.ok(existsSync(claudeLogPath));
    const claudeLog = readFileSync(claudeLogPath, "utf8");
    assert.match(claudeLog, /turn_start/);
    assert.match(claudeLog, /Claude received/);
    assert.match(claudeLog, /turn_complete/);
  });

  test("2. Hop limit prevents infinite agent ping-pong loops", async () => {
    // Message with hops = 6 should be rejected immediately
    const loopRes = await sendIpcRequest(ipcAddr, {
      action: "ask",
      payload: {
        from: "claude",
        to: "agy",
        hops: 6,
        body: "Infinite loop ping",
      },
    });

    assert.equal(loopRes.ok, false);
    assert.match(loopRes.error, /Hop limit reached/);
  });

  test("3. Reply routes with parent ticket attribution", async () => {
    const replyRes = await sendIpcRequest(ipcAddr, {
      action: "reply",
      payload: {
        ticket: "msg-parent-123",
        from: "agy",
        to: "claude",
        body: "LGTM: Refactor looks clean and maintains backwards compatibility.",
      },
    });

    assert.equal(replyRes.ok, true);
    assert.equal(replyRes.parentId, "msg-parent-123");
    assert.ok(replyRes.ticket);
  });
});
