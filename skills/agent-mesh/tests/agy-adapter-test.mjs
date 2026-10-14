/**
 * @file agy-adapter-test.mjs
 * @description Integration test suite for the Antigravity (agy) presence hook adapter.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentMeshBroker } from "../src/broker.mjs";
import { sendIpcRequest } from "../src/ipc.mjs";

/**
 * Spawns agy-presence-hook.mjs as a child process and pipes JSON to stdin.
 * @param {object} inputPayload
 * @param {object} envOverrides
 * @returns {Promise<{ stdout: string, json: object, exitCode: number }>}
 */
function runAgyHook(inputPayload, envOverrides = {}) {
  const hookScript = join(import.meta.dirname, "../src/hooks/agy-presence-hook.mjs");

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookScript], {
      env: { ...process.env, ...envOverrides },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("close", (code) => {
      try {
        const trimmed = stdout.trim();
        const json = trimmed ? JSON.parse(trimmed) : null;
        resolve({ stdout: trimmed, json, exitCode: code });
      } catch (err) {
        reject(new Error(`Failed to parse adapter stdout as JSON: '${stdout}'. Error: ${err.message}. Stderr: ${stderr}`));
      }
    });

    child.stdin.write(JSON.stringify(inputPayload));
    child.stdin.end();
  });
}

test("Antigravity (agy) Presence Hook Adapter Suite", async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "mesh-agy-test-"));
  const broker = new AgentMeshBroker(tmpDir);
  await broker.start();

  const conversationId = "conv-agy-uuid-1234";

  try {
    await t.test("0. SessionStart registers start session with broker and emits {}", async () => {
      const res = await runAgyHook(
        {
          conversationId,
          workspacePaths: [tmpDir],
          event: "SessionStart",
        },
        { MESH_IPC_ADDRESS: broker.ipcAddress }
      );

      assert.equal(res.exitCode, 0);
      assert.deepEqual(res.json, {});

      // Verify broker session state
      const statusRes = await sendIpcRequest(broker.ipcAddress, { action: "status" });
      const agySess = (statusRes.liveSessions || []).find((s) => s.session_id === conversationId);
      assert.ok(agySess, "Session must be registered with broker on SessionStart");
      assert.equal(agySess.harness, "antigravity");
      assert.equal(agySess.state, "idle");
    });

    await t.test("1. PreInvocation payload emits {} and registers busy session with broker", async () => {
      const res = await runAgyHook(
        {
          conversationId,
          workspacePaths: [tmpDir],
          event: "PreInvocation",
        },
        { MESH_IPC_ADDRESS: broker.ipcAddress }
      );

      assert.equal(res.exitCode, 0);
      assert.deepEqual(res.json, {});

      // Verify broker session state
      const statusRes = await sendIpcRequest(broker.ipcAddress, { action: "status" });
      const agySess = (statusRes.liveSessions || []).find((s) => s.session_id === conversationId);
      assert.ok(agySess, "Session must be registered with broker");
      assert.equal(agySess.harness, "antigravity");
      assert.equal(agySess.state, "busy");
    });

    await t.test("2. Stop with pending inbox messages emits continue decision and acks ticket", async () => {
      // Enqueue message for antigravity
      await sendIpcRequest(broker.ipcAddress, {
        action: "send",
        payload: {
          from: "claude",
          to: "antigravity",
          body: "Please review the test suite updates.",
        },
      });

      const res = await runAgyHook(
        {
          conversationId,
          workspacePaths: [tmpDir],
          event: "Stop",
        },
        { MESH_IPC_ADDRESS: broker.ipcAddress }
      );

      assert.equal(res.exitCode, 0);
      assert.equal(res.json.decision, "continue");
      assert.ok(res.json.reason.includes("Please review the test suite updates"));

      // Verify inbox was acknowledged (empty now)
      const inboxRes = await sendIpcRequest(broker.ipcAddress, {
        action: "inbox",
        payload: { agent: "antigravity" },
      });
      assert.equal(inboxRes.messages.length, 0, "Inbox messages must be acknowledged");
    });

    await t.test("3. Stop with empty inbox emits allow decision and transitions session to idle", async () => {
      const res = await runAgyHook(
        {
          conversationId,
          workspacePaths: [tmpDir],
          event: "Stop",
        },
        { MESH_IPC_ADDRESS: broker.ipcAddress }
      );

      assert.equal(res.exitCode, 0);
      assert.equal(res.json.decision, "allow");

      const statusRes = await sendIpcRequest(broker.ipcAddress, { action: "status" });
      const agySess = (statusRes.liveSessions || []).find((s) => s.session_id === conversationId);
      assert.equal(agySess.state, "idle");
    });

    await t.test("4. Headless MESH_AGENT guard emits safe defaults with zero broker calls", async () => {
      const res = await runAgyHook(
        {
          conversationId: "headless-turn-id",
          event: "Stop",
        },
        { MESH_IPC_ADDRESS: broker.ipcAddress, MESH_AGENT: "claude" }
      );

      assert.equal(res.exitCode, 0);
      assert.equal(res.json.decision, "allow");
    });
  } finally {
    await broker.stop();
  }

  await t.test("5. Adapter emits valid JSON and exits 0 even when broker daemon is offline", async () => {
    // Broker stopped; dummy socket address
    const offlineAddr = "offline-pipe-dummy";

    const preRes = await runAgyHook(
      { conversationId: "offline-id", event: "PreInvocation" },
      { MESH_IPC_ADDRESS: offlineAddr }
    );
    assert.equal(preRes.exitCode, 0);
    assert.deepEqual(preRes.json, {});

    const stopRes = await runAgyHook(
      { conversationId: "offline-id", event: "Stop" },
      { MESH_IPC_ADDRESS: offlineAddr }
    );
    assert.equal(stopRes.exitCode, 0);
    assert.equal(stopRes.json.decision, "allow");

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
