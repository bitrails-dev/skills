/**
 * @file pi-presence-extension.mjs
 * @description Pi Coding Agent presence extension for agent-mesh.
 * Subscribes to Pi lifecycle events:
 * - session_start: Announces live session to the broker.
 * - agent_start: Announces busy turn execution.
 * - agent_end: Claims pending messages and announces idle state.
 */

import { resolveIpcAddress, sendIpcRequest } from "../ipc.mjs";

function getAddress() {
  return resolveIpcAddress(process.cwd());
}

async function announce(event, pi, ev = {}) {
  // Headless guard: if invoked inside a mesh headless turn, avoid duplicate presence cycles
  if (process.env.MESH_AGENT) return;

  const address = getAddress();
  const sessionId = (typeof pi?.getSessionName === "function" ? pi.getSessionName() : null)
    || ev?.sessionId
    || `pi-${Date.now()}`;
  const pid = process.pid;
  const cwd = process.cwd();

  await sendIpcRequest(address, {
    action: "session_event",
    payload: {
      harness: "pi",
      sessionId,
      event,
      pid,
      cwd,
      origin: "interactive",
      notify: event === "start" || event === "end",
    },
  }, 0).catch(() => {});
}

async function onAgentEnd(pi, ev = {}) {
  if (process.env.MESH_AGENT) return;

  const address = getAddress();
  const sessionId = (typeof pi?.getSessionName === "function" ? pi.getSessionName() : null)
    || ev?.sessionId
    || `pi-${Date.now()}`;
  const pid = process.pid;

  try {
    const res = await sendIpcRequest(address, {
      action: "claim_inbox",
      payload: { agent: "pi", sessionId },
    }, 0).catch(() => null);

    if (res?.ok && Array.isArray(res.messages) && res.messages.length > 0) {
      await sendIpcRequest(address, {
        action: "ack",
        payload: { ids: res.messages.map((m) => m.id) },
      }, 0).catch(() => {});
    }
  } catch {}

  await sendIpcRequest(address, {
    action: "session_event",
    payload: { harness: "pi", sessionId, event: "idle", pid },
  }, 0).catch(() => {});
}

export default function piPresenceExtension(pi) {
  if (typeof pi?.on === "function") {
    pi.on("session_start", async (ev) => {
      await announce("start", pi, ev);
    });

    pi.on("agent_start", async (ev) => {
      await announce("busy", pi, ev);
    });

    pi.on("agent_end", async (ev) => {
      await onAgentEnd(pi, ev);
    });
  }
}
