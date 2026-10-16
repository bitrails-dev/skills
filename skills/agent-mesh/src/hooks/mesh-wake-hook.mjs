#!/usr/bin/env node
/**
 * @file mesh-wake-hook.mjs
 * @description Claude Code async re-waking hook (opt-in: `mesh --init claude --wake`).
 * Registered with `async: true, asyncRewake: true` on SessionStart and Stop. It blocks in `mesh wait` for the
 * session's wake-eligible mail and exits with code 2 when mail arrives; Claude then wakes the model with the
 * hook's output (stderr). Re-arming is automatic: the next Stop hook starts a new listener, and the broker's
 * single-listener lease makes duplicate starts exit immediately.
 *
 * Idle-session wake is UNVERIFIED on live sessions until `mesh probe-wake claude` has been run; the broker's
 * wake policy (ask/urgent only, budget, mute) bounds the cost either way.
 */

import { resolveIpcAddress } from "../ipc.mjs";
import { readStdinJson, resolveTrueHarnessPid, isBackgroundSession } from "./common.mjs";
import { runWait } from "../wait/mesh-wait.mjs";
import { safeWrite } from "../presence/safe-write.mjs";

async function main() {
  const input = await readStdinJson({ timeoutMs: 1500 });
  const sessionId = input.session_id || input.sessionId;
  const harnessIdx = process.argv.indexOf("--harness");
  const harness = harnessIdx !== -1 && process.argv[harnessIdx + 1] ? process.argv[harnessIdx + 1] : "claude";

  // Headless mesh turns and background/forked sessions are not user terminals: nothing to wake.
  if (!sessionId || process.env.MESH_AGENT || isBackgroundSession(sessionId)) return 0;

  const harnessPid = resolveTrueHarnessPid(sessionId, { harness });
  const result = await runWait({
    address: resolveIpcAddress(input.cwd || process.cwd()),
    sessionId,
    agent: harness,
    harnessPid: harnessPid || undefined,
    mailExitCode: 2,
    out: (text) => safeWrite(process.stderr, text),
  });
  return result.code === 3 ? 0 : result.code; // broker gone: stay silent, the next Stop re-arms
}

main().then((code) => process.exit(code)).catch(() => process.exit(0));
