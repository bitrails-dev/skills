/**
 * @file announce.mjs
 * @description Broker IPC helpers shared by in-process presence senders (OpenCode plugin, Pi extension).
 * Plain ESM with relative imports only: these run inside the harness's own module loader.
 */

import { sendIpcRequest } from "../ipc.mjs";
import { formatBatch } from "./inbox-format.mjs";

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
 * @param {boolean} [wake=false] true for timer-driven claims: the broker's wake policy (ask/urgent only, budget,
 *   mute) applies; event-driven claims at a turn boundary deliver everything
 * @returns {Promise<number>} number of delivered messages
 */
export async function deliverInbox(address, agent, sessionId, inject, options, wake = false) {
  const res = await send(address, "claim_inbox", { agent, sessionId, wake, budget: !wake }, options);
  const messages = res?.ok && Array.isArray(res.messages) ? res.messages : [];
  if (messages.length === 0) return 0;
  const ids = messages.map((m) => m.id);
  const batch = formatBatch(messages);
  try {
    await inject(batch.text, messages.filter((m) => batch.includedIds.includes(m.id)));
  } catch {
    await send(address, "release_claim", { ids }, options);
    return 0;
  }
  await settleClaim(address, batch, options);
  return batch.includedIds.length;
}

/**
 * Identity record of this session from the broker (`whoami`), or null when the broker is unreachable.
 * @param {string} address
 * @param {{ harness?: string, sessionId?: string, pid?: number, cwd?: string }} query
 */
export async function fetchIdentity(address, query, options = { timeoutMs: 800 }) {
  const res = await send(address, "whoami", query, options);
  return res?.ok ? res : null;
}

/**
 * Settles a claim after delivery: ack what was actually delivered, give the rest back to the queue.
 * @param {string} address
 * @param {{ includedIds: string[], deferredIds: string[] }} batch result of formatBatch
 */
export async function settleClaim(address, batch, options) {
  if (batch.includedIds.length) await send(address, "ack", { ids: batch.includedIds }, options);
  if (batch.deferredIds.length) await send(address, "release_claim", { ids: batch.deferredIds }, options);
}
