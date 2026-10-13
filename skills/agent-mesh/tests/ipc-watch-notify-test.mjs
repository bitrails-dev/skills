/**
 * @file ipc-watch-notify-test.mjs
 * @description Test suite for multi-tier IPC resolution, authentic PID resolution,
 * hook audit logging, and CLI doctor/watch integration.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveIpcAddress, getIpcAddress } from "../src/ipc.mjs";
import {
  resolveTrueHarnessPid,
  appendHookAuditLog,
  isProcessAlive,
  getMeshHome,
} from "../src/hooks/common.mjs";

test("Multi-Tier IPC Resolution, PID Caching, and Audit Log Suite", async (t) => {
  await t.test("1. resolveIpcAddress prioritizes MESH_IPC_ADDRESS env override", () => {
    const origEnv = process.env.MESH_IPC_ADDRESS;
    try {
      process.env.MESH_IPC_ADDRESS = "\\\\.\\pipe\\custom-override-pipe";
      const resolved = resolveIpcAddress(process.cwd());
      assert.equal(resolved, "\\\\.\\pipe\\custom-override-pipe");
    } finally {
      if (origEnv !== undefined) process.env.MESH_IPC_ADDRESS = origEnv;
      else delete process.env.MESH_IPC_ADDRESS;
    }
  });

  await t.test("2. resolveIpcAddress discovers local workspace broker.json", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mesh-local-ipc-"));
    const meshDir = join(tmpDir, ".agent-mesh");
    const brokerJson = join(meshDir, "broker.json");
    try {
      execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
      const expectedPipe = "\\\\.\\pipe\\agent-mesh-test-local";
      mkdirSync(meshDir, { recursive: true });
      writeFileSync(brokerJson, JSON.stringify({ pid: process.pid, ipcAddress: expectedPipe }), "utf8");

      const resolved = resolveIpcAddress(tmpDir);
      assert.equal(resolved, expectedPipe);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("3. resolveTrueHarnessPid caches resolved PID to disk for fast lookup", () => {
    const testSession = `test-sess-${Date.now()}`;
    const pid = resolveTrueHarnessPid(testSession);
    assert.ok(Number.isInteger(pid) && pid > 0);

    const cachePath = join(getMeshHome(), ".agent-mesh", "pids", `${testSession}.pid`);
    assert.ok(existsSync(cachePath), "PID cache file must be created");
    const cachedPid = Number(readFileSync(cachePath, "utf8").trim());
    assert.equal(cachedPid, pid);

    // Subsequent call must return cached PID immediately
    const rechecked = resolveTrueHarnessPid(testSession);
    assert.equal(rechecked, pid);

    // Cleanup
    try {
      rmSync(cachePath, { force: true });
    } catch {}
  });

  await t.test("4. appendHookAuditLog writes structured JSONL to hooks.log", () => {
    const logPath = join(getMeshHome(), ".agent-mesh", "logs", "hooks.log");
    const markerSession = `audit-sess-${Date.now()}`;

    appendHookAuditLog({
      harness: "antigravity",
      event: "PreInvocation",
      sessionId: markerSession,
      pid: process.pid,
      ok: true,
      durationMs: 4,
    });

    assert.ok(existsSync(logPath), "hooks.log must exist");
    const content = readFileSync(logPath, "utf8");
    assert.ok(content.includes(markerSession), "Marker session must be logged");
    assert.ok(content.includes('"harness":"antigravity"'));
  });

  await t.test("5. CLI mesh doctor runs without errors", () => {
    const cliPath = join(import.meta.dirname, "..", "scripts", "mesh.mjs");
    const out = execFileSync("node", [cliPath, "doctor"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    assert.ok(out.includes("AGENT MESH HOOKS DIAGNOSTICS"));
    assert.ok(out.includes("BROKER DAEMON STATUS"));
    assert.ok(out.includes("RECENT HOOK AUDIT LOG"));
  });
});
