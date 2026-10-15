/**
 * @file mcp-dedupe.mjs
 * @description Keeps MCP-announced presence and hook/scanner presence for the same (harness, pid) in ONE
 * session row with ONE start toast.
 *
 * - MCP event, another live row already owns (harness, pid)  -> ignored (the other source is authoritative).
 * - MCP event, nothing else owns it                          -> own `mcp:<harness>:<pid>` row. The start toast
 *   is deferred by `graceMs`: if a hook claims the pid meanwhile, the hook toasts and the MCP row never does.
 * - Non-MCP event for a pid that has an `mcp:` row            -> the `mcp:` row is closed silently, the real
 *   row takes over.
 */

const MCP_PREFIX = "mcp:";

export class McpDedupe {
  /**
   * @param {object} deps
   * @param {import("../db.mjs").MeshRepository} deps.repo
   * @param {(payload: object) => void} deps.notify
   * @param {number} [deps.graceMs]
   */
  constructor({ repo, notify, graceMs = 6000 }) {
    this.repo = repo;
    this.notify = notify;
    this.graceMs = graceMs;
    this.timers = new Map(); // sessionId -> deferred start toast
    this.toastOwned = new Set(); // mcp rows that raised (or will raise) the start toast
  }

  #liveRows(harness, pid) {
    return this.repo.listLiveSessions().filter((s) => s.harness === harness && s.pid === pid && s.origin === "interactive");
  }

  #drop(sessionId) {
    clearTimeout(this.timers.get(sessionId));
    this.timers.delete(sessionId);
    this.toastOwned.delete(sessionId);
  }

  /**
   * Decides what to do with a `session_event`.
   * @returns {{ ignore: boolean }} ignore = do not record this event
   */
  route({ harness, sessionId, pid, via, event }) {
    const isMcp = via === "mcp";
    if (!pid) return { ignore: false };
    const rows = this.#liveRows(harness, pid);

    if (isMcp) {
      if (rows.some((r) => r.session_id !== sessionId)) return { ignore: true };
      if (event === "start" && !this.toastOwned.has(sessionId)) {
        this.toastOwned.add(sessionId);
        const timer = setTimeout(() => {
          this.timers.delete(sessionId);
          const still = this.#liveRows(harness, pid).some((r) => r.session_id === sessionId);
          if (still) this.notify({ harness, event: "start", state: "idle", sessionId, pid, force: true });
        }, this.graceMs);
        timer.unref?.();
        this.timers.set(sessionId, timer);
      }
      if (event === "end" && this.toastOwned.has(sessionId)) {
        this.#drop(sessionId);
        this.notify({ harness, event: "end", state: "closed", sessionId, pid, force: true });
      }
      return { ignore: false };
    }

    // Hook/plugin/extension event: supersede any MCP row for this pid
    for (const r of rows) {
      if (r.session_id.startsWith(MCP_PREFIX) && r.session_id !== sessionId) {
        this.#drop(r.session_id);
        this.repo.updateSessionState(r.session_id, "closed", null);
      }
    }
    return { ignore: false };
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
