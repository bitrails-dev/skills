/**
 * @file name-watch.mjs
 * @description Broker-side session-name watchers driven by harness descriptors:
 * - transcript-mtime: re-resolve a name when a transcript the hook reported has changed (Claude /rename)
 * - sqlite-poll: re-resolve live sessions of harnesses whose state lives in a database (Codex, agy)
 */

import { statSync } from "node:fs";
import * as registry from "../harnesses/index.mjs";

/** Stores a resolved name and announces it when it changed after the session was registered. */
function applyName({ repo, notify }, harness, sessionId, name) {
  if (!name) return;
  const renamed = repo.setSessionName(sessionId, name);
  if (renamed) {
    notify({
      harness,
      event: "renamed",
      state: `${renamed.from ? `"${renamed.from}" -> ` : ""}"${renamed.to}"`,
      sessionId,
      pid: null,
    });
  }
}

/**
 * @param {Map<string, {harness: string, path: string, mtime: number}>} transcripts sessionId -> transcript
 * @param {{ repo: object, notify: (p: object) => void }} deps
 */
export function watchTranscripts(transcripts, deps) {
  for (const [sessionId, t] of transcripts) {
    try {
      const mtime = statSync(t.path).mtimeMs;
      if (mtime === t.mtime) continue;
      t.mtime = mtime;
      const name = registry.get(t.harness)?.name?.resolve?.({ sessionId, transcript: t.path });
      applyName(deps, t.harness, sessionId, name);
    } catch {}
  }
}

/**
 * Polls harness-owned state (read-only) for live sessions: names, archived threads, thread activity.
 * @param {{ repo: object, notify: (p: object) => void }} deps
 */
export function pollExternalSessions(deps) {
  const { repo, notify } = deps;
  try {
    for (const sess of repo.listLiveSessions()) {
      const desc = registry.get(sess.harness);
      if (desc?.name?.watch?.kind !== "sqlite-poll") continue;
      const polled = desc.pollSession?.(sess);
      if (polled?.archived) {
        repo.updateSessionState(sess.session_id, "closed", null);
        notify({ harness: sess.harness, event: "killed", state: "thread archived", sessionId: sess.session_id, pid: null });
        continue;
      }
      // Thread activity the hooks did not see: keep the no-PID inactivity TTL from closing a live session
      const ts = polled?.activityMs || 0;
      if (ts > (sess.updated_at || 0) && ts <= Date.now() + 60000) {
        repo.updateSessionState(sess.session_id, sess.state, sess.lease_holder ?? null);
      }
      applyName(deps, sess.harness, sess.session_id, desc.name.resolve?.({ sessionId: sess.session_id }));
    }
  } catch {}
}
