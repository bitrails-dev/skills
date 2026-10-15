/**
 * @file opencode-presence-plugin.mjs
 * @description OpenCode lifecycle presence and inbox delivery plugin for agent-mesh.
 * OpenCode calls a plugin as `async (ctx) => hooks` and delivers bus events to `hooks.event({ event })`:
 * - plugin load:      announces the live interactive session (start) so presence never depends on session.created
 * - session.created:  announces the real session id (supersedes the load-time placeholder)
 * - session.status busy / message.updated: announces busy
 * - session.idle:     announces idle and delivers queued mail
 * - session.updated:  announces a rename when the title changes
 * - session.deleted / server.instance.disposed: announces end (the latter is the shutdown signal)
 * Mail delivery: every few seconds while the session is idle (and on session.idle) the plugin claims queued mail
 * and injects it with `client.session.promptAsync`, which starts a turn in an idle session. A failed injection
 * releases the claim. Process exit is covered by the broker's PID watcher.
 */

import { resolveIpcAddress } from "../ipc.mjs";
import { send as sendIpc, deliverInbox } from "../presence/announce.mjs";

let loaded = false; // OpenCode invokes every exported function; register once per process
const placeholder = `opencode-${process.pid}`;
let currentSession = placeholder;
let currentName = null;
let rootSession = null; // real (non-placeholder, non-child) session id used for mail injection
let sessionBusy = false;
let delivering = false;

const IPC = { timeoutMs: 800 };
const POLL_MS = 3000;
const send = (address, action, payload) => sendIpc(address, action, payload, IPC);

async function announce(event, sessionId, cwd, name) {
  // Headless guard: if invoked inside a mesh headless turn, avoid duplicate presence cycles
  if (process.env.MESH_AGENT) return;
  const id = sessionId || currentSession;
  currentSession = id;
  if (name) currentName = name;
  await send(resolveIpcAddress(process.cwd()), "session_event", {
    harness: "opencode",
    sessionId: id,
    event,
    pid: process.pid,
    cwd: cwd || process.cwd(),
    origin: "interactive",
    name: name || currentName || undefined,
    notify: event === "start" || event === "end", // plugins have no hook-side toast
  });
}

/** Claims queued mail and starts a turn with it in the (idle) real session. */
async function deliver(client) {
  if (process.env.MESH_AGENT || delivering || sessionBusy || !rootSession || !client?.session?.promptAsync) return;
  delivering = true;
  try {
    const target = rootSession;
    await deliverInbox(resolveIpcAddress(process.cwd()), "opencode", target, async (text) => {
      await client.session.promptAsync({ path: { id: target }, body: { parts: [{ type: "text", text }] } });
    }, IPC);
  } catch {
    // never let delivery errors reach OpenCode
  } finally {
    delivering = false;
  }
}

/** Tracks the root session id from bus events (child/sub-agent sessions carry a parentID). */
function trackSession(info, sessionID) {
  if (info?.id && !info.parentID) rootSession = info.id;
  else if (!rootSession && sessionID) rootSession = sessionID;
}

export default async function opencodePresencePlugin(ctx = {}) {
  if (loaded) return {};
  loaded = true;

  await announce("start", currentSession, ctx.directory);

  const timer = setInterval(() => { void deliver(ctx.client); }, POLL_MS);
  timer.unref?.();

  return {
    event: async ({ event }) => {
      const p = event?.properties || {};
      switch (event?.type) {
        case "session.created":
          trackSession(p.info);
          return announce("start", p.info?.id, p.info?.directory, p.info?.title);
        case "session.updated":
          trackSession(p.info);
          if (p.info?.title) return announce("rename", p.info.id, p.info.directory, p.info.title);
          return;
        case "session.status":
          trackSession(null, p.sessionID);
          if (p.status?.type === "busy") {
            if (p.sessionID === rootSession) sessionBusy = true;
            return announce("busy", p.sessionID);
          }
          return;
        case "session.idle":
          trackSession(null, p.sessionID);
          if (p.sessionID === rootSession) sessionBusy = false;
          await announce("idle", p.sessionID || currentSession);
          return deliver(ctx.client);
        case "session.deleted":
          clearInterval(timer);
          return announce("end", p.info?.id);
        case "server.instance.disposed":
          clearInterval(timer);
          return announce("end", currentSession);
      }
    },
  };
}

export const plugin = opencodePresencePlugin;
