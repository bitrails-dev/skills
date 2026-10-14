/**
 * @file opencode-presence-plugin.mjs
 * @description OpenCode lifecycle presence and inbox claim plugin for agent-mesh.
 * OpenCode calls a plugin as `async (ctx) => hooks` and delivers bus events to `hooks.event({ event })`:
 * - plugin load:      announces the live interactive session (start) so presence never depends on session.created
 * - session.created:  announces the real session id (supersedes the load-time placeholder)
 * - session.status busy / message.updated: announces busy
 * - session.idle:     claims pending inbox messages and marks the session idle
 * - session.deleted:  announces end
 * Process exit is covered by the broker's PID watcher.
 */

import { resolveIpcAddress, sendIpcRequest } from "../ipc.mjs";

let loaded = false; // OpenCode invokes every exported function; register once per process
let currentSession = `opencode-${process.pid}`;

const send = (address, action, payload) =>
  sendIpcRequest(address, { action, payload }, 0).catch(() => null);

async function announce(event, sessionId, cwd, name) {
  // Headless guard: if invoked inside a mesh headless turn, avoid duplicate presence cycles
  if (process.env.MESH_AGENT) return;
  const id = sessionId || currentSession;
  currentSession = id;
  await send(resolveIpcAddress(process.cwd()), "session_event", {
    harness: "opencode",
    sessionId: id,
    event,
    pid: process.pid,
    cwd: cwd || process.cwd(),
    origin: "interactive",
    name: name || undefined,
    notify: event === "start" || event === "end", // plugins have no hook-side toast
  });
}

async function onIdle(sessionId) {
  if (process.env.MESH_AGENT) return;
  const address = resolveIpcAddress(process.cwd());
  const id = sessionId || currentSession;
  const res = await send(address, "claim_inbox", { agent: "opencode", sessionId: id });
  if (res?.ok && Array.isArray(res.messages) && res.messages.length > 0) {
    await send(address, "ack", { ids: res.messages.map((m) => m.id) });
  }
  await announce("idle", id);
}

export default async function opencodePresencePlugin(ctx = {}) {
  if (loaded) return {};
  loaded = true;

  await announce("start", currentSession, ctx.directory);

  return {
    event: async ({ event }) => {
      const p = event?.properties || {};
      switch (event?.type) {
        case "session.created":
          return announce("start", p.info?.id, p.info?.directory, p.info?.title);
        case "session.updated":
          if (p.info?.title) return announce("rename", p.info.id, p.info.directory, p.info.title);
          return;
        case "session.status":
          if (p.status?.type === "busy") return announce("busy", p.sessionID);
          return;
        case "session.idle":
          return onIdle(p.sessionID);
        case "session.deleted":
          return announce("end", p.info?.id);
      }
    },
  };
}

export const plugin = opencodePresencePlugin;
