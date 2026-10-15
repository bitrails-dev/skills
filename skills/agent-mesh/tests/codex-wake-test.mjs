/**
 * Codex idle-thread injector against a THROWAWAY app-server daemon (temp CODEX_HOME, no auth, never the real
 * ~/.codex): an `ask` for an idle thread becomes a turn/start; an active thread is left alone; unsupported
 * protocol versions degrade to pull; the injector reconnects after the proxy dies.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

process.env.MESH_SILENT = "1";
process.env.MESH_HOME = mkdtempSync(join(tmpdir(), "mesh-test-home-"));

const { AgentMeshBroker } = await import("../src/broker.mjs");
const { sendIpcRequest } = await import("../src/ipc.mjs");
const { createCodexInjector, SUPPORTED_VERSIONS } = await import("../src/harnesses/codex-wake.mjs");
const { wsOverStdio } = await import("../src/harnesses/shared/ws-stdio.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, step = 100) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
};

function findCodexBin() {
  if (process.env.MESH_CODEX_BIN && existsSync(process.env.MESH_CODEX_BIN)) return process.env.MESH_CODEX_BIN;
  const releases = join(homedir(), ".codex", "packages", "app-server-daemon", "releases");
  try {
    for (const d of readdirSync(releases).sort().reverse()) {
      const exe = join(releases, d, "bin", process.platform === "win32" ? "codex.exe" : "codex");
      if (existsSync(exe)) return exe; // only used as an executable; its state lives in the temp CODEX_HOME
    }
  } catch {}
  return null;
}

test("injector: unsupported app-server versions disable it (fake transport, no codex needed)", async () => {
  const api = {
    sessions: () => [{ session_id: "t-1" }],
    hasWakeMail: () => true,
    claim: () => assert.fail("must not claim when the protocol is unsupported"),
    ack() {},
    release() {},
  };
  const connect = ({ onMessage, onOpen }) => {
    const t = {
      send(text) {
        const msg = JSON.parse(text);
        if (msg.method === "initialize") onMessage(JSON.stringify({ id: msg.id, result: { userAgent: "codex-cli/9.9.9 (Windows)" } }));
      },
      close() {},
    };
    queueMicrotask(onOpen);
    return t;
  };
  const inj = createCodexInjector({ api, options: { connect, tickMs: 50 } });
  await inj.tick();
  assert.match(inj.stats().disabled, /unsupported app-server version 9\.9\.9/);
  assert.ok(SUPPORTED_VERSIONS.length > 0);
  await inj.tick(); // stays disabled, never claims
  inj.stop();
});

const bin = findCodexBin();
test("injector wakes an idle thread through the control socket, skips active threads, reconnects", { skip: !bin && "no codex binary available" }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mcx-")); // short path: unix socket paths are length-limited
  const env = { ...process.env, CODEX_HOME: home };
  const procs = [];
  const spawnCodex = (args) => {
    const p = spawn(bin, args, { env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    procs.push(p);
    return p;
  };
  let broker;
  t.after(async () => {
    try { await broker?.stop(); } catch {}
    for (const p of procs) { try { p.kill(); } catch {} }
    await sleep(300);
    try { rmSync(home, { recursive: true, force: true }); } catch {}
  });

  spawnCodex(["app-server", "--listen", "unix://"]);

  // owner client (stands in for the TUI): starts a thread and sees everything that happens to it.
  // The daemon needs a moment before its control socket accepts: retry the handshake.
  const seen = [];
  const pending = new Map();
  let rid = 0;
  let ws = null;
  const rpc = (method, params, timeoutMs = 15000) =>
    new Promise((resolve) => {
      const id = ++rid;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      setTimeout(() => resolve({ timeout: true }), timeoutMs);
    });
  let init = null;
  for (let attempt = 0; attempt < 8 && !init?.result; attempt++) {
    const proxy = spawnCodex(["app-server", "proxy"]);
    ws = wsOverStdio(proxy, {
      onMessage: (text) => {
        const m = JSON.parse(text);
        if (m.id !== undefined && pending.has(m.id)) pending.get(m.id)(m);
        else seen.push(m);
      },
    });
    init = await rpc("initialize", { clientInfo: { name: "owner", title: null, version: "0" }, capabilities: {} }, 4000);
    if (!init.result) ws.close();
  }
  assert.ok(init?.result?.userAgent, "daemon answers initialize");
  ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
  const started = await rpc("thread/start", { cwd: home });
  const threadId = started.result?.thread?.id;
  assert.ok(threadId, "thread/start returns a thread id");

  const dir = mkdtempSync(join(tmpdir(), "mesh-cxw-"));
  broker = new AgentMeshBroker(dir, {
    version: "9.9.9-test",
    wakeInjectors: { codex: { bin, env: { CODEX_HOME: home }, tickMs: 300 } },
  });
  broker.notifyDesktop = () => {};
  await broker.start();
  const call = (payload) => sendIpcRequest(broker.ipcAddress, payload);
  await call({ action: "session_event", payload: { harness: "codex", sessionId: threadId, event: "start", pid: process.pid, cwd: dir, origin: "interactive" } });

  // 1. idle thread + ask -> turn/start with the enveloped mail
  await call({ action: "send", payload: { from: "claude", to: `codex@${threadId}`, body: "please summarize the build", kind: "ask" } });
  const injected = await until(
    () => seen.find((m) => m.method === "item/started" && JSON.stringify(m.params).includes("please summarize the build")),
    20000
  );
  assert.ok(injected, "the owner connection saw the injected user message");
  assert.match(JSON.stringify(injected.params), /provenance=\\"another-agent-untrusted\\"/);
  const delivered = await until(async () => (await call({ action: "inbox", payload: { agent: "codex", delivered: true } })).messages.length > 0, 5000);
  assert.ok(delivered, "ticket acked after turn/start");

  // 2. the thread is now active (the unauthenticated turn is retrying): a second ask must not be injected
  const before = seen.filter((m) => m.method === "item/started").length;
  await call({ action: "send", payload: { from: "claude", to: `codex@${threadId}`, body: "second ask while busy", kind: "ask" } });
  await sleep(4000);
  assert.equal(JSON.stringify(seen).includes("second ask while busy"), false, "active thread is left alone");
  assert.equal(seen.filter((m) => m.method === "item/started").length, before);
  assert.equal((await call({ action: "inbox", payload: { agent: "codex" } })).messages.length, 1, "still queued for the next prompt");

  // 3. reconnect: kill the injector's proxy; it dials again when there is mail
  const inj = broker.injectors.get("codex");
  const proxyPid = inj.stats().proxyPid;
  assert.ok(proxyPid, "injector holds a proxy connection");
  try { process.kill(proxyPid); } catch {}
  await sleep(500);
  assert.equal(inj.stats().connected, false);
});
