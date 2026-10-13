/**
 * @file version-migration-test.mjs
 * @description Test suite for ADR-008: version handshake, drain-and-rebind, WAL checkpoints,
 * and EADDRINUSE retry resilience.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { VERSION, semverLt } from "../src/version.mjs";
import { AgentMeshBroker } from "../src/broker.mjs";
import { sendIpcRequest, startIpcServer, getIpcAddress } from "../src/ipc.mjs";
import { ensureBroker, stopBroker, awaitPipeRelease } from "../src/daemon.mjs";
import { initDatabase } from "../src/db.mjs";

// Isolate test broker from user-global ~/.agent-mesh
process.env.MESH_HOME = mkdtempSync(join(tmpdir(), "mesh-test-home-"));

async function safeRmSync(dir) {
  for (let i = 0; i < 15; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

test("ADR-008: Version Handshake & Migration Suite", async (t) => {
  await t.test("1. semverLt correctly evaluates numeric triples and prereleases", () => {
    assert.equal(semverLt("1.0.0", "1.0.1"), true);
    assert.equal(semverLt("1.2.0", "1.10.0"), true);
    assert.equal(semverLt("1.9.9", "2.0.0"), true);
    assert.equal(semverLt("1.0.0", "1.0.0"), false);
    assert.equal(semverLt("2.0.0", "1.9.9"), false);
    assert.equal(semverLt("1.0.0-rc.1", "1.0.0"), true);
    assert.equal(semverLt("1.0.0", "1.0.0-rc.1"), false);
    assert.equal(semverLt("1.0.0-alpha", "1.0.0-beta"), true);
    assert.equal(semverLt(null, "1.0.0"), false);
    assert.equal(semverLt("1.0.0", undefined), false);
  });

  await t.test("2. Broker handshake reports version in broker.json, ping, and status", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mesh-ver-test-"));
    const broker = new AgentMeshBroker(tmpDir, { version: "1.2.3" });

    try {
      await broker.start();
      const addr = broker.ipcAddress;

      // 1. broker.json
      const brokerJson = JSON.parse(readFileSync(broker.brokerPidPath, "utf8"));
      assert.equal(brokerJson.version, "1.2.3");
      assert.equal(brokerJson.pid, process.pid);

      // 2. ping IPC action
      const pingRes = await sendIpcRequest(addr, { action: "ping" });
      assert.equal(pingRes.ok, true);
      assert.equal(pingRes.version, "1.2.3");
      assert.equal(pingRes.pid, process.pid);

      // 3. status IPC action
      const statusRes = await sendIpcRequest(addr, { action: "status" });
      assert.equal(statusRes.ok, true);
      assert.equal(statusRes.version, "1.2.3");
    } finally {
      await broker.stop();
      await safeRmSync(tmpDir);
    }
  });

  await t.test("3. Graceful shutdown drains in-flight turn and checkpoints SQLite WAL", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mesh-drain-test-"));
    const broker = new AgentMeshBroker(tmpDir, { version: "1.1.0", drainTimeoutMs: 2000 });

    let turnCompleted = false;
    broker.registerDriver("mock-agent", {
      open: async () => ({ id: "mock-sess-1", cwd: tmpDir }),
      async *turn(session) {
        await new Promise((r) => setTimeout(r, 200));
        turnCompleted = true;
        yield { t: "done", session };
      },
    });

    try {
      await broker.start();
      const addr = broker.ipcAddress;

      // Enqueue message to start a turn
      await sendIpcRequest(addr, {
        action: "send",
        payload: { from: "human", to: "mock-agent", body: "work" },
      });

      // Allow turn to start
      await new Promise((r) => setTimeout(r, 40));

      // Trigger restart/shutdown
      const restartRes = await sendIpcRequest(addr, { action: "restart" });
      assert.equal(restartRes.ok, true);
      assert.equal(restartRes.draining, true);

      // Wait for broker to finish graceful shutdown
      await broker.stopped;

      assert.equal(turnCompleted, true, "In-flight turn should have completed during drain");

      // Verify DB reopens cleanly after WAL checkpoint
      const db = initDatabase(join(tmpDir, ".agent-mesh", "mesh.db"));
      const delivered = db.prepare("SELECT status FROM messages WHERE to_agent = 'mock-agent'").all();
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0].status, "delivered");
      db.close();
    } finally {
      await broker.stop();
      await safeRmSync(tmpDir);
    }
  });

  await t.test("4. Drain timeout aborts hung turn and restores messages to pending", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mesh-timeout-test-"));
    const broker = new AgentMeshBroker(tmpDir, { version: "1.1.0", drainTimeoutMs: 150 });

    broker.registerDriver("hanging-agent", {
      open: async () => ({ id: "mock-sess-hang", cwd: tmpDir }),
      async *turn(session, prompt, signal) {
        yield await new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      },
    });

    try {
      await broker.start();
      const addr = broker.ipcAddress;

      await sendIpcRequest(addr, {
        action: "send",
        payload: { from: "human", to: "hanging-agent", body: "hang" },
      });

      await new Promise((r) => setTimeout(r, 40));

      // Trigger restart with short timeout
      await sendIpcRequest(addr, { action: "restart" });
      await broker.stopped;

      // Verify DB restored the message to 'pending'
      const db = initDatabase(join(tmpDir, ".agent-mesh", "mesh.db"));
      const messages = db.prepare("SELECT status FROM messages WHERE to_agent = 'hanging-agent'").all();
      assert.equal(messages.length, 1);
      assert.equal(messages[0].status, "pending");
      db.close();
    } finally {
      await broker.stop();
      await safeRmSync(tmpDir);
    }
  });

  await t.test("5. startIpcServer retries on EADDRINUSE and binds once handle is released", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mesh-eaddrinuse-test-"));
    const addr = getIpcAddress(tmpDir);

    // Bind a temporary blocking server to simulate pipe occupancy
    const blocker = createServer();
    await new Promise((res) => blocker.listen(addr, res));

    // Release blocker after 400ms
    setTimeout(() => {
      blocker.close();
    }, 400);

    // startIpcServer with 2000ms retryMs should absorb the temporary conflict
    const server = await startIpcServer(addr, async () => ({ ok: true }), { retryMs: 2000 });
    assert.ok(server);

    await new Promise((res) => server.close(res));
    await safeRmSync(tmpDir);
  });

  await t.test("6. Legacy daemon with missing version triggers hard-kill fallback", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mesh-legacy-test-"));
    // Broker simulating legacy v1.0.0 without version metadata in broker.json or ping
    const broker = new AgentMeshBroker(tmpDir, { version: null });
    await broker.start();
    const addr = broker.ipcAddress;

    let forceKillCalled = false;
    const mockForceKill = (pid) => {
      forceKillCalled = true;
      broker.stop();
    };

    try {
      // ensureBroker should see missing version and invoke fallback kill
      const info = await ensureBroker({
        rootDir: tmpDir,
        address: addr,
        forceKill: mockForceKill,
      });

      assert.equal(forceKillCalled, true, "Legacy unversioned daemon should trigger forceKill");
      assert.ok(info.pid);
    } finally {
      await broker.stop();
      await stopBroker({ rootDir: tmpDir, address: addr });
      await new Promise((r) => setTimeout(r, 100));
      await safeRmSync(tmpDir);
    }
  });
});
