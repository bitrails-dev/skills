/**
 * @file tui-scanner.mjs
 * @description Finds interactive harness TUI processes (descriptors with a `process` section) and keeps
 * one provisional session row per TUI, so presence appears at app open and the PID watcher reports exit.
 * The provisional row is later bound to the real session when the harness's first hook event arrives.
 */

import * as registry from "../harnesses/index.mjs";
import { listProcesses, processInfo, isProcessAlive } from "../harnesses/shared/process.mjs";

export class TuiScanner {
  /**
   * @param {object} deps
   * @param {import("../db.mjs").MeshRepository} deps.repo
   * @param {(payload: object) => void} deps.notify  desktop notification sink (late-bound by the broker)
   * @param {() => boolean} deps.isRunning
   * @param {string} deps.cwd  cwd recorded on provisional rows
   * @param {() => Promise<{pid:number,name:string}[]>} [deps.processSource]  injectable for tests
   * @param {(pid:number) => Promise<{ppid:number,cmd:string}|null>} [deps.processInfo]  injectable for tests
   */
  constructor({ repo, notify, isRunning, cwd, processSource, processInfo: info }) {
    this.repo = repo;
    this.notify = notify;
    this.isRunning = isRunning;
    this.cwd = cwd;
    this.processSource = processSource || listProcesses;
    this.processInfo = info || processInfo;
    this.lastScan = 0;
    this.scanning = false;
    this.scannedOnce = false;
    this.seen = new Map(); // pid -> true (interactive TUI) | false (helper/background)
    this.unbound = new Map(); // pid -> provisional sessionId, waiting for the first real hook event
  }

  /**
   * One scan tick. Only NEW pids trigger the (async) detail lookup.
   * The first scan after a broker restart adopts a live PID-less row instead of duplicating it.
   */
  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    this.lastScan = Date.now();
    try {
      const procs = await this.processSource();
      const first = !this.scannedOnce;
      const alive = new Set();
      const fresh = [];
      for (const { pid, name } of procs) {
        const desc = registry.byExe(name);
        if (!desc || !this.isRunning()) continue;
        alive.add(pid);
        if (this.seen.has(pid)) continue;
        this.seen.set(pid, false); // mark first: never re-query this pid
        fresh.push({ pid, desc });
      }
      // One detail lookup per NEW pid, in parallel (each is a ~1-2s pwsh spawn on Windows)
      const infos = await Promise.all(fresh.map((f) => this.processInfo(f.pid)));
      fresh.forEach((f, i) => {
        if (f.desc.process.isInteractiveTui(infos[i]?.cmd)) this.seen.set(f.pid, true);
      });
      for (const [i, { pid, desc }] of fresh.entries()) {
        if (!this.seen.get(pid)) continue;
        if (this.seen.get(infos[i].ppid) === true) { this.seen.set(pid, false); continue; } // helper child of a TUI
        const harness = desc.id;
        const live = this.repo.listLiveSessions().filter((s) => s.harness === harness && s.origin === "interactive");
        if (live.some((s) => s.pid === pid)) continue; // already tracked by a hook
        if (first) {
          const orphan = live.find((s) => !s.pid);
          if (orphan) { this.repo.setSessionPid(orphan.session_id, pid); continue; }
        }
        const sessionId = `tui:${harness}-${pid}`;
        this.repo.updateSessionEvent({ harness, sessionId, event: "start", pid, cwd: this.cwd, origin: "interactive" });
        this.unbound.set(pid, sessionId);
        if (!first) this.notify({ harness, event: "start", state: "idle", pid, force: true });
      }
      for (const pid of [...this.seen.keys()]) {
        if (!alive.has(pid)) { this.seen.delete(pid); this.unbound.delete(pid); }
      }
      this.scannedOnce = true;
    } catch {} finally {
      this.scanning = false;
    }
  }

  /**
   * Binds a hook's real session to a scanner-found TUI pid so the row carries a pid the PID watcher can use.
   * ponytail: Codex hook pids are null, so binding takes the most recent unbound TUI of that harness. With
   * 2+ TUIs opened before either sends a prompt that can swap them, and a Codex /new inside one TUI
   * (new thread, same process) stays unbound until the idle TTL.
   * @returns {{pid: number|null, bound: boolean, ignore?: boolean}}
   */
  bind(harness, sessionId, pid, event) {
    const out = { pid, bound: false };
    if (!sessionId || !registry.get(harness)?.process || String(sessionId).startsWith("tui:")) return out;
    const row = this.repo.db.prepare("SELECT state, pid FROM sessions WHERE session_id = ?").get(sessionId);
    const closed = !row || row.state === "closed" || row.state === "lost";
    // The TUI exited and closed this row; stray app-server task events must not resurrect it
    if (row && closed && event !== "start" && row.pid && !isProcessAlive(row.pid)) return { ...out, ignore: true };
    if (!closed || !["start", "busy", "idle"].includes(event)) return out;
    if (pid && this.seen.get(pid) === true) {
      out.bound = this.unbound.delete(pid);
      return out;
    }
    const candidates = [...this.unbound]
      .filter(([p, id]) => id.startsWith(`tui:${harness}-`) && isProcessAlive(p))
      .map(([p]) => p);
    const tuiPid = candidates[candidates.length - 1];
    if (!tuiPid) return out;
    this.unbound.delete(tuiPid);
    return { pid: tuiPid, bound: true };
  }
}
