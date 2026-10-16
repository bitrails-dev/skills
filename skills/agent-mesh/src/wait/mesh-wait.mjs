/**
 * @file mesh-wait.mjs
 * @description `mesh wait`: a long-poll listener for ONE session's wake-eligible mail. Used as
 * - oneshot: block until mail arrives, print it, exit (a background command whose exit wakes a model), or
 * - stream:  keep running and print one block per delivery (a watcher whose output lines wake a model).
 * One listener per session (broker lease bound to this process's pid). Exits quietly when the harness pid
 * dies, the session is closed, the lease is revoked or the broker goes away. Mail is acked only after it was
 * flushed to stdout.
 */

import { isProcessAlive } from "../harnesses/shared/process.mjs";
import { sendIpcRequest } from "../ipc.mjs";
import { safeWrite } from "../presence/safe-write.mjs";
import { formatBatch } from "../presence/inbox-format.mjs";
import { settleClaim } from "../presence/announce.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Writes to stdout and resolves once flushed (Windows truncates output of fast-exiting processes). */
const write = (text) => safeWrite(process.stdout, text);

/**
 * @param {object} opts
 * @param {string} opts.address broker IPC address
 * @param {string} opts.sessionId
 * @param {string} [opts.agent] harness id (derived from the live session when omitted)
 * @param {boolean} [opts.stream]
 * @param {number} [opts.harnessPid] exit when this process dies
 * @param {number} [opts.debounceMs]
 * @param {number} [opts.pollMs] per-request long-poll length (default 25000, broker caps at 55000)
 * @param {number} [opts.throttleSleepMs] back-off after a refused wake (default 10000)
 * @param {number} [opts.maxWaitMs] give up after this long without mail (0 = no limit)
 * @param {number} [opts.mailExitCode] exit code when mail was delivered in oneshot mode (Claude asyncRewake: 2)
 * @param {string} [opts.rearmCommand] shown to the model after a oneshot delivery
 * @param {(text: string) => Promise<void>} [opts.out]
 * @returns {Promise<{ code: number, reason: string, delivered: number }>}
 */
export async function runWait(opts) {
  const { address, sessionId, agent, stream = false, harnessPid, debounceMs, maxWaitMs = 0, mailExitCode = 0, pollMs = 25000, throttleSleepMs = 10000 } = opts;
  const out = opts.out ?? write;
  const started = Date.now();
  let delivered = 0;
  let brokerFailures = 0;

  for (;;) {
    if (harnessPid && !isProcessAlive(Number(harnessPid))) return { code: 0, reason: "harness-gone", delivered };
    if (maxWaitMs && Date.now() - started > maxWaitMs) return { code: 0, reason: "max-wait", delivered };

    let res;
    try {
      res = await sendIpcRequest(
        address,
        { action: "wait", payload: { agent, sessionId, pid: process.pid, harnessPid, debounceMs, oneshot: !stream, timeoutMs: pollMs } },
        0,
        { timeoutMs: 70000 }
      );
      brokerFailures = 0;
    } catch {
      if (++brokerFailures >= 3) return { code: 3, reason: "broker-gone", delivered };
      await sleep(2000);
      continue;
    }
    if (!res.ok) return { code: 1, reason: res.error || "error", delivered };

    switch (res.status) {
      case "ready": {
        // claim only now, right before flushing: a waiter that dies earlier strands nothing
        const claim = await sendIpcRequest(address, { action: "claim_inbox", payload: { agent, sessionId, wake: true } }, 1).catch(() => null);
        if (!claim?.ok || !Array.isArray(claim.messages) || claim.messages.length === 0) {
          if (claim?.throttled) await sleep(throttleSleepMs);
          break; // someone else (a hook) took it, or the budget refused: keep listening
        }
        const batch = formatBatch(claim.messages);
        await out(`${batch.text}\n`);
        await settleClaim(address, batch);
        delivered += batch.includedIds.length;
        if (!stream) {
          const rearm = opts.rearmCommand ? `\n[mesh] Listener finished. To receive further messages re-arm it: ${opts.rearmCommand}\n` : "";
          if (rearm) await out(rearm);
          return { code: mailExitCode, reason: "mail", delivered };
        }
        break;
      }
      case "timeout":
        break;
      case "throttled":
        await sleep(throttleSleepMs); // wake budget used up / muted: mail waits for the next turn (pull)
        break;
      case "already-listening":
        await out("[mesh] another listener is already armed for this session.\n");
        return { code: 0, reason: res.status, delivered };
      default: // session-closed | harness-gone | revoked | broker-stopping
        return { code: 0, reason: res.status, delivered };
    }
  }
}
