/**
 * @file opencode-presence-plugin.mjs
 * @description OpenCode lifecycle presence and inbox claim plugin for agent-mesh.
 * Subscribes to OpenCode plugin events:
 * - session.created: Announces live interactive session to the broker.
 * - turn.started: Announces busy state.
 * - turn.completed: Claims pending inbox messages and marks session idle.
 * - session.ended: Announces session termination.
 */

import { resolveIpcAddress, sendIpcRequest } from "../ipc.mjs";

function getAddress() {
  return resolveIpcAddress(process.cwd());
}

async function announce(event, data = {}) {
  // Headless guard: if invoked inside a mesh headless turn, avoid duplicate presence cycles
  if (process.env.MESH_AGENT) return;

  const address = getAddress();
  const sessionId = data.session?.id || data.sessionId || data.id || `opencode-${Date.now()}`;
  const cwd = data.session?.directory || data.cwd || process.cwd();
  const pid = process.pid;

  await sendIpcRequest(address, {
    action: "session_event",
    payload: {
      harness: "opencode",
      sessionId,
      event,
      pid,
      cwd,
      origin: "interactive",
    },
  }, 0).catch(() => {});
}

async function onTurnCompleted(data = {}) {
  if (process.env.MESH_AGENT) return;

  const address = getAddress();
  const sessionId = data.session?.id || data.sessionId || data.id || `opencode-${Date.now()}`;
  const pid = process.pid;

  try {
    const res = await sendIpcRequest(address, {
      action: "claim_inbox",
      payload: { agent: "opencode", sessionId },
    }, 0).catch(() => null);

    if (res?.ok && Array.isArray(res.messages) && res.messages.length > 0) {
      // Acknowledge received messages
      await sendIpcRequest(address, {
        action: "ack",
        payload: { ids: res.messages.map((m) => m.id) },
      }, 0).catch(() => {});
    }
  } catch {}

  // Announce idle
  await sendIpcRequest(address, {
    action: "session_event",
    payload: { harness: "opencode", sessionId, event: "idle", pid },
  }, 0).catch(() => {});
}

export default function opencodePresencePlugin(api) {
  if (typeof api?.on === "function") {
    api.on("session.created", (ev) => announce("start", ev));
    api.on("turn.started", (ev) => announce("busy", ev));
    api.on("turn.completed", (ev) => onTurnCompleted(ev));
    api.on("session.ended", (ev) => announce("end", ev));
  }

  return {
    "session.created": async (ev) => announce("start", ev),
    "turn.started": async (ev) => announce("busy", ev),
    "turn.completed": async (ev) => onTurnCompleted(ev),
    "session.ended": async (ev) => announce("end", ev),
  };
}

export const plugin = opencodePresencePlugin;
