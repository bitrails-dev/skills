/**
 * @file announce.mjs
 * @description Broker IPC helpers shared by in-process presence senders (OpenCode plugin, Pi extension).
 * Plain ESM with relative imports only: these run inside the harness's own module loader.
 */

import { sendIpcRequest } from "../ipc.mjs";
import { formatMessages } from "./inbox-format.mjs";

/** Fire-and-forget broker request; resolves null when the broker is unreachable. */
export const send = (address, action, payload, options) =>
  sendIpcRequest(address, { action, payload }, 0, options).catch(() => null);

/**
 * Claims pending mail for a session, hands the formatted text to `inject`, then acks. If injection throws the
 * claim is released so the tickets stay deliverable (never silently consumed).
 * @param {string} address
 * @param {string} agent harness id
 * @param {string} sessionId
 * @param {(text: string, messages: object[]) => Promise<void>|void} inject
 * @param {object} [options] IPC options
 * @returns {Promise<number>} number of delivered messages
 */
export async function deliverInbox(address, agent, sessionId, inject, options) {
  const res = await send(address, "claim_inbox", { agent, sessionId }, options);
  const messages = res?.ok && Array.isArray(res.messages) ? res.messages : [];
  if (messages.length === 0) return 0;
  const ids = messages.map((m) => m.id);
  try {
    await inject(formatMessages(messages), messages);
  } catch {
    await send(address, "release_claim", { ids }, options);
    return 0;
  }
  await send(address, "ack", { ids }, options);
  return messages.length;
}
