/**
 * @file codex-wake.mjs
 * @description Broker-side injector that wakes IDLE Codex threads (opt-in: `mesh --init codex --wake`).
 * Codex hosts every TUI thread in the shared app-server daemon, whose control socket accepts extra clients
 * (see docs/ADAPTERS.md section 6). This module connects through `codex app-server proxy`, tracks thread status
 * from broadcast notifications, and when a live session has wake-eligible mail and its thread is `idle` it sends
 * `turn/start` with the formatted mail. Active threads are never touched (their hooks deliver at the next prompt).
 *
 * Guardrails: protocol line pinned (unsupported versions disable the injector and mail falls back to pull),
 * reconnect with backoff, claim only after the status check, release on any failure, broker wake policy
 * (ask/urgent only, budget, mute) applies to every injection.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { wsOverStdio } from "./shared/ws-stdio.mjs";
import { formatMessages } from "../presence/inbox-format.mjs";

/**
 * The codex executable: MESH_CODEX_BIN, else the managed daemon's release binary (a real .exe, so no shell is
 * needed on Windows), else `codex` from PATH (shell-resolved on Windows for the npm .cmd shim).
 */
export function resolveCodexBin(env = process.env) {
  if (env.MESH_CODEX_BIN) return { bin: env.MESH_CODEX_BIN, shell: false };
  const releases = join(env.CODEX_HOME || join(homedir(), ".codex"), "packages", "app-server-daemon", "releases");
  try {
    for (const dir of readdirSync(releases).sort().reverse()) {
      const exe = join(releases, dir, "bin", process.platform === "win32" ? "codex.exe" : "codex");
      if (existsSync(exe)) return { bin: exe, shell: false };
    }
  } catch {}
  return { bin: "codex", shell: process.platform === "win32" };
}

/** app-server protocol lines this injector was written and tested against (userAgent version prefix). */
export const SUPPORTED_VERSIONS = ["0.162."];

// Streaming/delta notifications this client never needs: opt out so it is not flooded.
const OPT_OUT = [
  "item/agentMessage/delta", "item/plan/delta", "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta", "item/commandExecution/outputDelta", "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated", "command/exec/outputDelta", "process/outputDelta", "turn/diff/updated",
  "turn/plan/updated", "thread/tokenUsage/updated", "item/started", "item/completed", "item/mcpToolCall/progress",
  "mcpServer/startupStatus/updated", "account/rateLimits/updated", "skills/changed",
];

/**
 * @param {object} deps
 * @param {{ sessions: () => {session_id: string}[], hasWakeMail: (id: string) => boolean,
 *           claim: (id: string) => object[], ack: (ids: string[]) => void, release: (ids: string[]) => void }} deps.api
 * @param {{ bin?: string, env?: object, tickMs?: number, connect?: Function, log?: (msg: string) => void }} [deps.options]
 */
export function createCodexInjector({ api, options = {} }) {
  const log = options.log ?? (() => {});
  const tickMs = options.tickMs ?? 2000;
  const stats = { connected: false, version: null, disabled: null, injected: 0, lastError: null, reconnects: 0 };
  const threadStatus = new Map(); // thread id -> "idle" | "active" | "notLoaded" | "systemError"
  const pending = new Map(); // rpc id -> resolve
  const injecting = new Set();
  let transport = null;
  let nextId = 0;
  let timer = null;
  let retryAt = 0;
  let backoffMs = 5000;
  let connecting = false;

  const spawnTransport = (handlers) => {
    const env = { ...process.env, ...(options.env || {}) };
    const { bin, shell } = options.bin ? { bin: options.bin, shell: false } : resolveCodexBin(env);
    const proc = spawn(bin, ["app-server", "proxy"], { env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell });
    proc.on("error", (err) => handlers.onClose(`spawn-error: ${err.message}`));
    return { ...wsOverStdio(proc, handlers), pid: proc.pid };
  };

  const request = (method, params, timeoutMs = 8000) =>
    new Promise((resolve, reject) => {
      if (!transport) return reject(new Error("not connected"));
      const id = ++nextId;
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(t);
        if (msg.error) reject(new Error(msg.error.message || `${method} failed`));
        else resolve(msg.result);
      });
      transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });

  const onMessage = (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    const p = msg.params || {};
    switch (msg.method) {
      case "thread/status/changed":
        if (p.threadId) threadStatus.set(p.threadId, p.status?.type);
        break;
      case "thread/closed":
        if (p.threadId) threadStatus.set(p.threadId, "notLoaded");
        break;
      case "thread/started":
        if (p.thread?.id) threadStatus.set(p.thread.id, p.thread.status?.type ?? "idle");
        break;
    }
  };

  const drop = (reason) => {
    if (!transport) return;
    transport = null;
    stats.connected = false;
    stats.lastError = reason;
    for (const resolve of pending.values()) resolve({ error: { message: `connection lost: ${reason}` } });
    pending.clear();
    retryAt = Date.now() + backoffMs;
    backoffMs = Math.min(backoffMs * 2, 60000);
    log(`codex wake: disconnected (${reason}); retry in ${Math.round((retryAt - Date.now()) / 1000)}s`);
  };

  async function connect() {
    if (connecting) return;
    connecting = true;
    try {
      const make = options.connect ?? spawnTransport;
      let opened;
      const openPromise = new Promise((r) => (opened = r));
      const t = make({ onMessage, onOpen: () => opened(true), onClose: (reason) => { opened(false); drop(reason); } });
      transport = t;
      const ok = await Promise.race([openPromise, new Promise((r) => setTimeout(() => r(false), 6000))]);
      if (!ok) throw new Error("control socket handshake failed");
      const init = await request("initialize", {
        clientInfo: { name: "agent-mesh", title: null, version: "1" },
        capabilities: { experimentalApi: false, optOutNotificationMethods: OPT_OUT },
      });
      const version = /\/(\d+\.\d+\.\d+)/.exec(init?.userAgent || "")?.[1] ?? null;
      stats.version = version;
      if (!version || !SUPPORTED_VERSIONS.some((v) => version.startsWith(v))) {
        stats.disabled = `unsupported app-server version ${version ?? "unknown"} (supported: ${SUPPORTED_VERSIONS.join(", ")}x)`;
        log(`codex wake: ${stats.disabled}; falling back to pull`);
        transport.close();
        transport = null;
        return;
      }
      transport.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
      stats.connected = true;
      stats.lastError = null;
      stats.reconnects++;
      backoffMs = 5000;
      log(`codex wake: connected (app-server ${version})`);
    } catch (err) {
      stats.lastError = err.message;
      try { transport?.close(); } catch {}
      transport = null;
      stats.connected = false;
      retryAt = Date.now() + backoffMs;
      backoffMs = Math.min(backoffMs * 2, 60000);
    } finally {
      connecting = false;
    }
  }

  /** Fresh status for one thread: thread/read, falling back to the cached notification state. */
  async function statusOf(threadId) {
    try {
      const res = await request("thread/read", { threadId, includeTurns: false });
      const type = res?.thread?.status?.type;
      if (type) {
        threadStatus.set(threadId, type);
        return type;
      }
    } catch {}
    return threadStatus.get(threadId);
  }

  async function inject(threadId) {
    if (injecting.has(threadId)) return;
    injecting.add(threadId);
    try {
      if ((await statusOf(threadId)) !== "idle") return; // active/notLoaded: next-prompt hook or TUI close handles it
      const messages = api.claim(threadId);
      if (messages.length === 0) return;
      const ids = messages.map((m) => m.id);
      try {
        await request("turn/start", { threadId, input: [{ type: "text", text: formatMessages(messages) }] });
        threadStatus.set(threadId, "active");
        api.ack(ids);
        stats.injected += messages.length;
      } catch (err) {
        api.release(ids);
        stats.lastError = err.message;
        log(`codex wake: turn/start failed for ${threadId}: ${err.message}`);
      }
    } finally {
      injecting.delete(threadId);
    }
  }

  async function tick() {
    if (stats.disabled) return;
    const targets = api.sessions().map((s) => s.session_id).filter((id) => !id.startsWith("tui:") && api.hasWakeMail(id));
    if (targets.length === 0) return; // stay connected lazily: only dial when there is mail to deliver
    if (!transport) {
      if (Date.now() < retryAt) return;
      await connect();
    }
    if (!transport || !stats.connected) return;
    for (const id of targets) await inject(id);
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick().catch(() => {}), tickMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      try { transport?.close(); } catch {}
      transport = null;
      stats.connected = false;
    },
    tick,
    stats: () => ({ ...stats, proxyPid: transport?.pid ?? null }),
  };
}
