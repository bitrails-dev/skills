/**
 * @file pi-presence-extension.mjs
 * @description Pi Coding Agent presence extension for agent-mesh.
 * Subscribes to Pi lifecycle events:
 * - session_start: Announces live session to the broker.
 * - agent_start: Announces busy turn execution.
 * - agent_end: Announces idle state and delivers queued mail.
 * - mail delivery: also polled every few seconds while idle; mail is injected with pi.sendUserMessage (always
 *   triggers a turn, so an idle session wakes). A failed injection releases the claim.
 * - session_info_changed: Announces a rename.
 * - session_shutdown: Announces end only for reason "quit" (reload/new/resume/fork keep the process).
 */

import { resolveIpcAddress } from "../ipc.mjs";
import { send, deliverInbox, fetchIdentity } from "../presence/announce.mjs";
import { formatIdentityLine } from "../presence/identity.mjs";

let currentId = null; // stable per start so a rename never forks the session identity
let agentBusy = false;
let delivering = false;
let pollTimer = null;
const POLL_MS = 3000;

const sessionName = (pi) => (typeof pi?.getSessionName === "function" ? pi.getSessionName() : null) || undefined;

function getAddress() {
  return resolveIpcAddress(process.cwd());
}

async function announce(event, pi, ev = {}, name = sessionName(pi)) {
  // Headless guard: if invoked inside a mesh headless turn, avoid duplicate presence cycles
  if (process.env.MESH_AGENT) return;

  const address = getAddress();
  if (event === "start" || !currentId) {
    currentId = sessionName(pi) || ev?.sessionId || `pi-${Date.now()}`;
  }
  const sessionId = currentId;
  const pid = process.pid;
  const cwd = process.cwd();

  await send(address, "session_event", {
    harness: "pi",
    sessionId,
    event,
    pid,
    cwd,
    origin: "interactive",
    name,
    notify: event === "start" || event === "end",
  });
}

/** Claims queued mail and starts a turn with it (only while the agent is idle). */
async function deliver(pi, ev = {}, wake = false) {
  if (process.env.MESH_AGENT || agentBusy || delivering || typeof pi?.sendUserMessage !== "function") return;
  const sessionId = currentId || sessionName(pi) || ev?.sessionId;
  if (!sessionId) return;
  delivering = true;
  try {
    await deliverInbox(getAddress(), "pi", sessionId, (text) => {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    }, undefined, wake);
  } catch {
    // never let delivery errors reach Pi
  } finally {
    delivering = false;
  }
}

async function onAgentEnd(pi, ev = {}) {
  if (process.env.MESH_AGENT) return;
  const sessionId = currentId || sessionName(pi) || ev?.sessionId || `pi-${Date.now()}`;
  await send(getAddress(), "session_event", { harness: "pi", sessionId, event: "idle", pid: process.pid, name: sessionName(pi) });
  await deliver(pi, ev);
}

/** Mesh badge: persistent footer status with the session's mesh identity (MESH_NO_BADGE=1 disables). */
async function badge(pi, ctx) {
  if (process.env.MESH_NO_BADGE === "1" || process.env.MESH_AGENT || typeof ctx?.ui?.setStatus !== "function") return;
  try {
    const info = await fetchIdentity(getAddress(), { harness: "pi", pid: process.pid, sessionId: currentId || undefined });
    ctx.ui.setStatus("agent-mesh", formatIdentityLine(info ?? { harness: "pi" }));
  } catch {
    // cosmetic only
  }
}

export default function piPresenceExtension(pi) {
  if (typeof pi?.on === "function") {
    pi.on("session_start", async (ev, ctx) => {
      await announce("start", pi, ev);
      void badge(pi, ctx);
      if (!pollTimer) {
        pollTimer = setInterval(() => { void deliver(pi, {}, true); }, POLL_MS);
        pollTimer.unref?.();
      }
    });

    pi.on("agent_start", async (ev) => {
      agentBusy = true;
      await announce("busy", pi, ev);
    });

    pi.on("agent_end", async (ev, ctx) => {
      agentBusy = false;
      await onAgentEnd(pi, ev);
      void badge(pi, ctx); // refresh peers / inbox counts
    });

    pi.on("session_info_changed", async (ev) => {
      await announce("rename", pi, ev, ev?.name || sessionName(pi));
    });

    pi.on("session_shutdown", async (ev) => {
      if (ev?.reason === "quit") {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        await announce("end", pi, ev);
      }
    });
  }
}
