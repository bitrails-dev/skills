/**
 * MCP shim: protocol subset, tools over broker IPC, presence start/end, and (harness, pid) dedupe
 * with hook-announced rows. Isolated broker + MESH_HOME; no notifications; no real configs touched.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

process.env.MESH_SILENT = "1";
process.env.MESH_HOME = mkdtempSync(join(tmpdir(), "mesh-test-home-"));

const { AgentMeshBroker } = await import("../src/broker.mjs");
const { sendIpcRequest } = await import("../src/ipc.mjs");

const SHIM = join(import.meta.dirname, "..", "src", "mcp", "mesh-mcp.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), "mesh-mcp-"));
const broker = new AgentMeshBroker(dir, { version: "9.9.9-test", mcpGraceMs: 150 });
const toasts = [];
broker.notifyDesktop = (p) => toasts.push(p);
await broker.start();
after(() => broker.stop());

const call = (payload) => sendIpcRequest(broker.ipcAddress, payload);
const live = async (harness) => (await call({ action: "status" })).liveSessions.filter((s) => !harness || s.harness === harness);
const hookEvent = (harness, sessionId, event, pid = process.pid) =>
  call({ action: "session_event", payload: { harness, sessionId, event, pid, cwd: dir, origin: "interactive" } });
const mcpEvent = (harness, pid, event) =>
  call({ action: "session_event", payload: { harness, sessionId: `mcp:${harness}:${pid}`, event, pid, cwd: dir, origin: "interactive", via: "mcp" } });

/** Spawns the shim as an MCP client would; returns a tiny JSON-RPC client. */
function startShim(harness, extraEnv = {}) {
  const child = spawn(process.execPath, harness ? [SHIM, "--harness", harness] : [SHIM], {
    env: { ...process.env, MESH_IPC_ADDRESS: broker.ipcAddress, MESH_NO_PID_WALK: "1", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = [];
  const waiters = new Map();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(line);
      const m = JSON.parse(line); // stdout must be protocol-only: a non-JSON line throws here
      if (m.id !== undefined) waiters.get(m.id)?.(m);
    }
  });
  let id = 0;
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  return {
    child,
    lines,
    exited,
    request(method, params) {
      const rid = ++id;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: rid, method, params })}\n`);
      return new Promise((res, rej) => {
        waiters.set(rid, res);
        setTimeout(() => rej(new Error(`timeout waiting for ${method}`)), 10000);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    async init(clientName = "test-client") {
      const r = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "0" } });
      this.notify("notifications/initialized", {});
      return r;
    },
  };
}
const toolText = (r) => r.result.content[0].text;

test("protocol: initialize, ping, tools/list, unknown method, stdout is protocol-only", async () => {
  const shim = startShim("pi", { MESH_AGENT: "1" }); // MESH_AGENT: no presence in this test
  try {
    const init = await shim.init();
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "agent-mesh");
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.deepEqual((await shim.request("ping")).result, {});
    const tools = (await shim.request("tools/list")).result.tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["mesh_ask", "mesh_inbox", "mesh_send", "mesh_status"]);
    assert.equal((await shim.request("nope/method")).error.code, -32601);
    const old = await shim.request("initialize", { protocolVersion: "1999-01-01", clientInfo: { name: "x" } });
    assert.equal(old.result.protocolVersion, "2025-06-18", "unsupported versions fall back to the latest");
    assert.ok(shim.lines.every((l) => JSON.parse(l).jsonrpc === "2.0"));
  } finally {
    shim.child.stdin.end();
    await shim.exited;
  }
});

test("presence: start after initialize, end on stdin EOF; MESH_AGENT suppresses presence", async () => {
  const shim = startShim("claude");
  await shim.init("claude-code");
  await shim.request("tools/list");
  await sleep(200);
  const rows = await live("claude");
  const row = rows.find((s) => s.session_id === `mcp:claude:${process.pid}`);
  assert.ok(row, "mcp row registered under harness+pid");
  assert.equal(row.pid, process.pid, "pid = the shim's parent (this test process)");
  shim.child.stdin.end();
  assert.equal(await shim.exited, 0);
  assert.equal((await live("claude")).find((s) => s.session_id === row.session_id), undefined, "EOF closes the row");

  const quiet = startShim("opencode", { MESH_AGENT: "1" });
  await quiet.init();
  await sleep(150);
  assert.equal((await live("opencode")).length, 0);
  quiet.child.stdin.end();
  await quiet.exited;
});

test("harness falls back to clientInfo.name when --harness is absent", async () => {
  const child = spawn(process.execPath, [SHIM], {
    env: { ...process.env, MESH_IPC_ADDRESS: broker.ipcAddress, MESH_NO_PID_WALK: "1" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "codex-mcp-client" } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  await sleep(500);
  // codex hosts MCP in the shared daemon: the descriptor opts out of presence, tools still work
  assert.equal((await live("codex")).length, 0);
  child.stdin.end();
  await new Promise((r) => child.on("exit", r));
});

test("tools: send -> inbox claim/ack round trip and status", async () => {
  // no --harness and unknown client names: no driver may react to these messages
  const sender = startShim(null, { MESH_AGENT: "1" });
  const receiver = startShim(null, { MESH_AGENT: "1" });
  try {
    await sender.init("alice");
    await receiver.init("bob");
    const sent = await sender.request("tools/call", { name: "mesh_send", arguments: { to: "bob", body: "hello over mcp" } });
    assert.match(toolText(sent), /Ticket: msg-/);
    const asked = await sender.request("tools/call", { name: "mesh_ask", arguments: { to: "bob", body: "question?" } });
    assert.ok(!asked.result.isError);

    const inbox = toolText(await receiver.request("tools/call", { name: "mesh_inbox", arguments: {} }));
    assert.match(inbox, /hello over mcp/);
    assert.match(inbox, /question\?/);
    assert.match(toolText(await receiver.request("tools/call", { name: "mesh_inbox", arguments: {} })), /No pending/);

    const bad = await sender.request("tools/call", { name: "mesh_send", arguments: { to: "bob" } });
    assert.equal(bad.result.isError, true);
    assert.equal((await sender.request("tools/call", { name: "nope", arguments: {} })).result.isError, true);
    assert.match(toolText(await sender.request("tools/call", { name: "mesh_status", arguments: {} })), /Live sessions/);
  } finally {
    sender.child.stdin.end();
    receiver.child.stdin.end();
    await Promise.all([sender.exited, receiver.exited]);
  }
});

test("dedupe: hook row first, MCP start merges into it (one row, no toast)", async () => {
  const before = toasts.length;
  await hookEvent("pi", "pi-hook-1", "start");
  const r = await mcpEvent("pi", process.pid, "start");
  assert.equal(r.state, "merged");
  await sleep(350);
  assert.deepEqual((await live("pi")).map((s) => s.session_id), ["pi-hook-1"]);
  assert.equal(toasts.slice(before).filter((t) => t.force && t.harness === "pi" && t.event === "start").length, 0);
  await mcpEvent("pi", process.pid, "end"); // the hook source stays authoritative for the end
  assert.equal((await live("pi")).length, 1);
  await hookEvent("pi", "pi-hook-1", "end");
});

test("dedupe: MCP row first, hook supersedes it silently (one row, hook toasts itself)", async () => {
  const before = toasts.length;
  await mcpEvent("opencode", process.pid, "start");
  assert.equal((await live("opencode")).length, 1);
  await hookEvent("opencode", "oc-hook-1", "start");
  await sleep(350); // beyond the grace window: the superseded MCP row must not toast
  assert.deepEqual((await live("opencode")).map((s) => s.session_id), ["oc-hook-1"]);
  assert.equal(toasts.slice(before).filter((t) => t.force && t.harness === "opencode" && t.event === "start").length, 0);
  await hookEvent("opencode", "oc-hook-1", "end");
});

test("dedupe: MCP-only presence raises exactly one start toast (after grace) and one end toast", async () => {
  const before = toasts.length;
  await mcpEvent("antigravity", process.pid, "start");
  await mcpEvent("antigravity", process.pid, "start"); // idempotent
  await sleep(400);
  assert.equal(toasts.slice(before).filter((t) => t.force && t.harness === "antigravity" && t.event === "start").length, 1);
  await mcpEvent("antigravity", process.pid, "end");
  assert.equal(toasts.slice(before).filter((t) => t.force && t.harness === "antigravity" && t.event === "end").length, 1);
  assert.equal((await live("antigravity")).length, 0);
});
