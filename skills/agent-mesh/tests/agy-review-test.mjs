/**
 * Findings of the Antigravity review: PowerShell resolution, atomic + backed-up config writes, wait never strands
 * mail, safe stream writes, setup selection by any installed component, purge guard. Isolated, silent.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { PassThrough, Writable } from "node:stream";

process.env.MESH_SILENT = "1";
process.env.MESH_HOME = mkdtempSync(join(tmpdir(), "mesh-test-home-"));

const { AgentMeshBroker } = await import("../src/broker.mjs");
const { sendIpcRequest } = await import("../src/ipc.mjs");
const { resolvePowershell } = await import("../src/harnesses/shared/process.mjs");
const { atomicWriteText } = await import("../src/harnesses/shared/fs-atomic.mjs");
const { uninstallNestedHooks, installNestedHooks, installJsonMcp, uninstallJsonMcp, installTomlMcp } = await import("../src/harnesses/shared/install.mjs");
const { safeWrite } = await import("../src/presence/safe-write.mjs");

const CLI = join(import.meta.dirname, "..", "scripts", "mesh.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

// ---- A ---------------------------------------------------------------------------------------------------------

test("PowerShell resolution prefers pwsh.exe, falls back to Windows PowerShell 5.1", () => {
  const both = new Set([join("C:\\ps7", "pwsh.exe"), join("C:\\sys", "powershell.exe")]);
  const only51 = new Set([join("C:\\sys", "powershell.exe")]);
  const env = { PATH: "C:\\ps7;C:\\sys" };
  assert.equal(resolvePowershell(env, (p) => both.has(p)), "pwsh.exe");
  assert.equal(resolvePowershell(env, (p) => only51.has(p)), "powershell.exe");
  assert.equal(resolvePowershell({ PATH: "" }, () => false), "powershell.exe", "default PATH always has 5.1");
});

// ---- B + E -----------------------------------------------------------------------------------------------------

test("config writes are atomic (no tmp left) and back up the pre-change file only when it changes", () => {
  const d = tmp("mesh-atomic-");
  const p = join(d, "config.json");
  assert.equal(atomicWriteText(p, "one\n"), true);
  assert.equal(existsSync(p + ".bak"), false, "no backup for a new file");
  assert.equal(atomicWriteText(p, "one\n"), false, "unchanged content: no write");
  assert.equal(atomicWriteText(p, "two\n"), true);
  assert.equal(readFileSync(p + ".bak", "utf8"), "one\n");
  assert.deepEqual(readdirSync(d).filter((n) => n.endsWith(".tmp")), []);
});

test("every uninstall path that changes a user config leaves a .bak of the pre-change state", () => {
  const d = tmp("mesh-bak-");
  // nested hooks (Claude/Codex settings)
  const hooks = join(d, "settings.json");
  installNestedHooks(hooks, "C:/x/presence-hook.mjs");
  const before = readFileSync(hooks, "utf8");
  assert.equal(uninstallNestedHooks(hooks).modified, true);
  assert.equal(readFileSync(hooks + ".bak", "utf8"), before);
  assert.equal(uninstallNestedHooks(hooks).modified, false);
  // json mcp entry
  const mcp = join(d, ".mcp.json");
  writeFileSync(mcp, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  installJsonMcp(mcp, "mcpServers", { command: "node", args: ["a"] });
  const withMesh = readFileSync(mcp, "utf8");
  assert.equal(uninstallJsonMcp(mcp, "mcpServers").modified, true);
  assert.equal(readFileSync(mcp + ".bak", "utf8"), withMesh);
  // toml goes through the same writer
  const toml = join(d, "config.toml");
  writeFileSync(toml, 'a = 1\n');
  installTomlMcp(toml, { command: "node", args: ["a"] });
  assert.equal(readFileSync(toml + ".bak", "utf8"), "a = 1\n");
  assert.deepEqual(readdirSync(d).filter((n) => n.endsWith(".tmp")), []);
});

// ---- F ---------------------------------------------------------------------------------------------------------

test("wait only peeks: mail is not claimed until the waiter is about to print (a killed waiter strands nothing)", async () => {
  const dir = tmp("mesh-waitpeek-");
  const broker = new AgentMeshBroker(dir, { version: "9.9.9-test", wake: { budget: 100 } });
  broker.notifyDesktop = () => {};
  await broker.start();
  try {
    const call = (payload) => sendIpcRequest(broker.ipcAddress, payload);
    const kid = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    await call({ action: "session_event", payload: { harness: "claude", sessionId: "wp-1", event: "start", pid: kid.pid, cwd: dir, origin: "interactive" } });
    await call({ action: "send", payload: { from: "tester", to: "claude@wp-1", body: "ping", kind: "ask" } });
    const res = await call({ action: "wait", payload: { agent: "claude", sessionId: "wp-1", pid: process.pid, oneshot: true, debounceMs: 0, timeoutMs: 2000 } });
    assert.equal(res.status, "ready");
    assert.equal(res.messages, undefined);
    const pending = (await call({ action: "inbox", payload: { agent: "claude" } })).messages;
    assert.equal(pending.length, 1, "still pending: a waiter dying here loses nothing");
    kid.kill();
  } finally {
    await broker.stop();
  }
});

// ---- G ---------------------------------------------------------------------------------------------------------

test("safeWrite never hangs on a closed or non-draining stream", async () => {
  const keepAlive = setInterval(() => {}, 100); // safeWrite's own timer is unref'd by design
  const closed = new PassThrough();
  closed.destroy();
  const t0 = Date.now();
  await safeWrite(closed, "x");
  assert.ok(Date.now() - t0 < 500);

  const stuck = new Writable({ highWaterMark: 1, write() {} }); // never calls back: never drains
  const t1 = Date.now();
  await safeWrite(stuck, "xxxxxxxx", 150);
  const elapsed = Date.now() - t1;
  assert.ok(elapsed >= 100 && elapsed < 1500, `resolved by the timeout (${elapsed}ms)`);
  clearInterval(keepAlive);
});

// ---- C + D -----------------------------------------------------------------------------------------------------

test("setup update/uninstall default selection includes harnesses with only MCP or only wake installed", () => {
  const home = tmp("mesh-sel-home-");
  const proj = tmp("mesh-sel-proj-");
  const env = { ...process.env, MESH_HOME: home, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), MESH_SILENT: "1", MESH_MUSE_BIN: join(home, "none.exe") };
  const mesh = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: proj, encoding: "utf8", env });
  assert.equal(mesh("mcp", "install", "pi", "--project").status, 0);
  const plan = mesh("setup", "--yes", "--project", "--action", "update", "--dry-run", "--no-broker");
  assert.match(plan.stdout, /- pi:/, plan.stdout);
  const un = mesh("setup", "--yes", "--project", "--action", "uninstall", "--dry-run", "--no-broker");
  assert.match(un.stdout, /- pi:/);
});

test("setup's purge goes through the home guard before deleting", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "setup", "setup.mjs"), "utf8");
  const i = src.indexOf("rmSync(dir");
  assert.ok(i > 0);
  assert.ok(src.lastIndexOf("guardWrite(dir)", i) > src.lastIndexOf("existsSync(dir)", i), "guardWrite(dir) precedes rmSync");
});

// ---- H -------------------------------------------------------------------------------------------------------

test("CLI tests run with HOME/USERPROFILE redirected, not just MESH_HOME", () => {
  for (const f of ["setup-test.mjs", "opt-in-cli-test.mjs"]) {
    const src = readFileSync(join(import.meta.dirname, f), "utf8");
    assert.match(src, /USERPROFILE: home/, f);
  }
});
