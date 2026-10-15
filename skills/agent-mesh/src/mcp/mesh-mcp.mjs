#!/usr/bin/env node
/**
 * @file mesh-mcp.mjs
 * @description Agent Mesh MCP stdio shim: presence + messaging for any MCP-capable harness, zero deps.
 *
 * Protocol subset (newline-delimited JSON-RPC 2.0 on stdio; stdout carries protocol messages only):
 *   initialize, notifications/initialized, ping, tools/list, tools/call.
 * Tools (thin wrappers over the existing broker IPC): mesh_send, mesh_ask, mesh_inbox, mesh_status.
 * Presence: announces `start` after initialize and `end` on stdin EOF / SIGTERM. The session id is
 * `mcp:<harness>:<pid>`; the broker merges it with hook/scanner rows for the same (harness, pid).
 *
 * Usage (written by the installer): node mesh-mcp.mjs --harness <id>
 */

import { pathToFileURL } from "node:url";
import { resolveIpcAddress, sendIpcRequest } from "../ipc.mjs";
import * as registry from "../harnesses/index.mjs";
import { walkPastShells } from "../harnesses/shared/process.mjs";
import { formatMessages } from "../hooks/common.mjs";

const LATEST_PROTOCOL = "2025-06-18";
const SUPPORTED_PROTOCOLS = [LATEST_PROTOCOL, "2025-03-26", "2024-11-05"];
const IPC = { timeoutMs: 3000 };

const TOOLS = [
  {
    name: "mesh_send",
    description: "Send a fire-and-forget message to another agent on the mesh (e.g. claude, codex, opencode, pi, antigravity). Optionally target a session with to=<agent>@<session>.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target agent id, optionally <agent>@<session>" },
        body: { type: "string", description: "Message text" },
      },
      required: ["to", "body"],
    },
  },
  {
    name: "mesh_ask",
    description: "Ask another agent a question or to do work. NON-BLOCKING: this only enqueues the request and returns a ticket; the answer arrives later as a message in your mesh inbox, so call mesh_inbox to read it.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target agent id, optionally <agent>@<session>" },
        body: { type: "string", description: "Question or task" },
      },
      required: ["to", "body"],
    },
  },
  {
    name: "mesh_inbox",
    description: "Claim and return pending mesh messages addressed to this agent.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mesh_status",
    description: "Show live agent sessions and pending message counts on the mesh.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** Maps an MCP clientInfo.name (e.g. "codex-mcp-client", "claude-code") to a registered harness id. */
export function harnessFromClientName(name) {
  const n = String(name || "").toLowerCase();
  const candidates = [n, n.replace(/[-_ ]?(mcp[-_ ]?)?client$/, ""), n.replace(/-code$/, "")];
  for (const c of candidates) {
    const h = registry.get(c);
    if (h) return h.id;
  }
  return null;
}

export class MeshMcpServer {
  /**
   * @param {object} opts
   * @param {(line: string) => void} opts.write  protocol output sink (one JSON line per call)
   * @param {string} [opts.harness]  harness id/alias from --harness
   * @param {string} [opts.cwd]
   * @param {() => string} [opts.address]
   */
  constructor({ write, harness, cwd = process.cwd(), address = () => resolveIpcAddress(cwd) }) {
    this.write = write;
    this.cwd = cwd;
    this.address = address;
    this.harness = registry.get(harness)?.id ?? null;
    this.clientInfo = null;
    this.sessionId = null;
    this.pid = null;
    this.started = false;
    this.ended = false;
  }

  reply(id, result) { this.write(JSON.stringify({ jsonrpc: "2.0", id, result })); }
  fail(id, code, message) { this.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })); }

  /** Handles one parsed JSON-RPC message. Returns a promise that settles when the reply was written. */
  async handle(msg) {
    if (!msg || typeof msg !== "object" || typeof msg.method !== "string") return;
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    switch (method) {
      case "initialize": {
        this.clientInfo = params?.clientInfo ?? null;
        this.harness ??= harnessFromClientName(this.clientInfo?.name);
        const wanted = params?.protocolVersion;
        this.reply(id, {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(wanted) ? wanted : LATEST_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "agent-mesh", version: "1" },
        });
        return;
      }
      case "notifications/initialized":
        return this.announceStart();
      case "ping":
        if (isRequest) this.reply(id, {});
        return;
      case "tools/list":
        if (isRequest) this.reply(id, { tools: TOOLS });
        return this.announceStart(); // clients that skip notifications/initialized
      case "tools/call":
        if (isRequest) this.reply(id, await this.callTool(params?.name, params?.arguments ?? {}));
        return;
      default:
        if (isRequest) this.fail(id, -32601, `Method not found: ${method}`);
    }
  }

  // ---- presence ---------------------------------------------------------------------------------

  /** Descriptor's mcp source decides whether this shim announces presence (Codex hosts MCP in a shared daemon). */
  canAnnounce() {
    if (process.env.MESH_AGENT || !this.harness) return false; // headless mesh turn / unknown harness
    const source = registry.get(this.harness).presence.find((s) => s.kind === "mcp");
    return source?.announce !== false;
  }

  resolvePid() {
    const desc = registry.get(this.harness);
    const direct = process.ppid;
    return desc.pid === "walk" ? walkPastShells(direct).pid || direct : direct;
  }

  event(event) {
    return sendIpcRequest(
      this.address(),
      {
        action: "session_event",
        payload: {
          harness: this.harness,
          sessionId: this.sessionId,
          event,
          pid: this.pid,
          cwd: this.cwd,
          origin: "interactive",
          via: "mcp",
        },
      },
      0,
      IPC
    ).catch(() => null);
  }

  async announceStart() {
    if (this.started || !this.canAnnounce()) return;
    this.started = true;
    this.pid = this.resolvePid();
    this.sessionId = `mcp:${this.harness}:${this.pid}`;
    await this.event("start");
  }

  /** Idempotent: announces `end` once (stdin EOF, SIGTERM). */
  async announceEnd() {
    if (this.ended) return;
    this.ended = true;
    if (this.started) await this.event("end");
  }

  // ---- tools --------------------------------------------------------------------------------------

  textResult(text, isError = false) {
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  }

  async callTool(name, args) {
    try {
      switch (name) {
        case "mesh_send":
        case "mesh_ask":
          return await this.sendMessage(name === "mesh_ask" ? "ask" : "send", args);
        case "mesh_inbox":
          return await this.inbox();
        case "mesh_status":
          return await this.status();
        default:
          return this.textResult(`Unknown tool: ${name}`, true);
      }
    } catch (err) {
      return this.textResult(`Agent mesh broker unreachable: ${err.message}`, true);
    }
  }

  async sendMessage(action, { to, body }) {
    if (typeof to !== "string" || !to.trim() || typeof body !== "string" || !body.trim()) {
      return this.textResult("`to` and `body` must be non-empty strings.", true);
    }
    const from = this.harness || String(this.clientInfo?.name || "mcp");
    // H3: agent-sent chains increment hops (same rule as the CLI)
    const hops = process.env.MESH_AGENT ? Number(process.env.MESH_HOPS || 0) + 1 : 0;
    const res = await sendIpcRequest(
      this.address(),
      { action, payload: { from, to: to.trim(), body, kind: action === "ask" ? "ask" : "notify", hops } },
      0,
      IPC
    );
    if (!res.ok) return this.textResult(`Error: ${res.error}`, true);
    return this.textResult(`Message queued for '${to}'. Ticket: ${res.ticket}`);
  }

  async inbox() {
    const agent = this.harness || String(this.clientInfo?.name || "mcp");
    const res = await sendIpcRequest(this.address(), { action: "claim_inbox", payload: { agent, sessionId: this.sessionId } }, 0, IPC);
    const messages = res.ok && Array.isArray(res.messages) ? res.messages : [];
    if (messages.length === 0) return this.textResult("No pending mesh messages.");
    await sendIpcRequest(this.address(), { action: "ack", payload: { ids: messages.map((m) => m.id) } }, 0, IPC).catch(() => null);
    return this.textResult(formatMessages(messages));
  }

  async status() {
    const res = await sendIpcRequest(this.address(), { action: "status" }, 0, IPC);
    if (!res.ok) return this.textResult(`Error: ${res.error}`, true);
    const lines = (res.liveSessions || []).map(
      (s) => `${s.harness}  ${s.name || s.session_id}  [${s.state}]${s.pid ? `  pid ${s.pid}` : ""}`
    );
    const pending = JSON.stringify(res.pendingCounts || {});
    return this.textResult(`Live sessions (${lines.length}):\n${lines.join("\n") || "(none)"}\nPending: ${pending}`);
  }
}

// ---- stdio entry point -----------------------------------------------------------------------------

function main() {
  const argIdx = process.argv.indexOf("--harness");
  const server = new MeshMcpServer({
    write: (line) => process.stdout.write(`${line}\n`),
    harness: argIdx !== -1 ? process.argv[argIdx + 1] : undefined,
  });

  let buf = "";
  let pending = 0;
  let stdinClosed = false;
  const finish = async () => {
    await server.announceEnd();
    process.exit(0);
  };
  const settle = () => {
    if (stdinClosed && pending === 0) finish();
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      pending++;
      server.handle(msg).catch(() => {}).finally(() => { pending--; settle(); });
    }
  });
  process.stdin.on("end", () => { stdinClosed = true; settle(); });
  process.stdin.on("error", () => { stdinClosed = true; settle(); });
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, finish);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
