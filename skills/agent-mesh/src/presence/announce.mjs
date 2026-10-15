/**
 * @file announce.mjs
 * @description Broker IPC helpers shared by in-process presence senders (OpenCode plugin, Pi extension).
 * Plain ESM with relative imports only: these run inside the harness's own module loader.
 */

import { sendIpcRequest } from "../ipc.mjs";

/** Fire-and-forget broker request; resolves null when the broker is unreachable. */
export const send = (address, action, payload, options) =>
  sendIpcRequest(address, { action, payload }, 0, options).catch(() => null);

/** Claims pending inbox messages for a session and acks them (they are surfaced by the harness hooks). */
export async function claimAndAck(address, agent, sessionId, options) {
  const res = await send(address, "claim_inbox", { agent, sessionId }, options);
  if (res?.ok && Array.isArray(res.messages) && res.messages.length > 0) {
    await send(address, "ack", { ids: res.messages.map((m) => m.id) }, options);
  }
}
