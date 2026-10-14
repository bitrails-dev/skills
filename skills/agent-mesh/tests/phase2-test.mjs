/**
 * @file phase2-test.mjs
 * @description Test suite for Phase 2 of agent-mesh:
 * Worktree isolation, session leasing, and OpenCode driver mechanics.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentMeshBroker } from "../src/broker.mjs";
import { sendIpcRequest } from "../src/ipc.mjs";
import { ensureAgentWorktree, removeAgentWorktree } from "../src/worktree.mjs";
import { createOpenCodeDriver } from "../src/drivers/opencode.mjs";

import { mkdtempSync as __mkHome } from "node:fs";
import { tmpdir as __tmpHome } from "node:os";
import { join as __joinHome } from "node:path";

// Isolate from the user's live broker/state: hooks and CLI children inherit this MESH_HOME.
process.env.MESH_HOME = __mkHome(__joinHome(__tmpHome(), "mesh-test-home-"));


// Skip the (slow) process-tree walk in tests; the direct parent is the harness stand-in.
process.env.MESH_NO_PID_WALK = "1";

describe("Phase 2: Worktree Isolation & Session Leasing Validation", () => {
  let testRepo;
  let broker;
  let ipcAddr;

  before(async () => {
    testRepo = mkdtempSync(join(tmpdir(), "mesh-wt-repo-"));
    // Initialize a git repo for worktree testing
    execFileSync("git", ["init"], { cwd: testRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: testRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: testRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: testRepo, stdio: "ignore" });

    broker = new AgentMeshBroker(testRepo);
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

  test("1. ensureAgentWorktree creates isolated worktree branch", () => {
    const wtPath = ensureAgentWorktree(testRepo, "claude-worker");
    assert.ok(existsSync(wtPath));
    assert.match(wtPath, /claude-worker/);

    // Verify git branch in worktree
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd: wtPath,
      encoding: "utf8",
    }).trim();
    assert.equal(branch, "mesh/claude-worker/workspace");
  });

  test("2. Session lease acquisition pauses broker and returns attachArgv", async () => {
    const leaseRes = await sendIpcRequest(ipcAddr, {
      action: "lease_acquire",
      payload: { agent: "claude" },
    });

    assert.equal(leaseRes.ok, true);
    assert.equal(leaseRes.agent, "claude");
    assert.ok(Array.isArray(leaseRes.attachArgv));
    assert.ok(leaseRes.attachArgv.length >= 1);

    // Check status reports session as human-held
    const statusRes = await sendIpcRequest(ipcAddr, { action: "status" });
    const claudeSession = statusRes.sessions.find((s) => s.harness === "claude");
    assert.equal(claudeSession?.state, "human-held");

    // Release lease
    const releaseRes = await sendIpcRequest(ipcAddr, {
      action: "lease_release",
      payload: { agent: "claude" },
    });
    assert.equal(releaseRes.ok, true);

    // Verify status returns to idle
    const updatedStatus = await sendIpcRequest(ipcAddr, { action: "status" });
    const idleSession = updatedStatus.sessions.find((s) => s.harness === "claude");
    assert.equal(idleSession?.state, "idle");
  });

  test("3. OpenCode driver declares concurrentViewers and server delivery", async () => {
    const opencodeDriver = createOpenCodeDriver({ port: 4096 });
    assert.equal(opencodeDriver.name, "opencode");
    assert.equal(opencodeDriver.caps.delivery, "server");
    assert.equal(opencodeDriver.caps.concurrentViewers, true);

    const session = await opencodeDriver.open({ cwd: testRepo });
    const attachCmd = opencodeDriver.attachArgv(session);
    assert.deepEqual(attachCmd, ["opencode", "attach", "http://127.0.0.1:4096"]);
  });
});
