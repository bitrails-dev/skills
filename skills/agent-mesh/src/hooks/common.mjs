import { existsSync, statSync, renameSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { toastArgs } from "../notify.mjs";
import { guardWrite } from "../harnesses/shared/home-guard.mjs";
import { safeWrite } from "../presence/safe-write.mjs";
import * as registry from "../harnesses/index.mjs";
import { resolvePid, isBackgroundSession, isProcessAlive, getMeshHome } from "../harnesses/shared/process.mjs";

export { buildHookCommand, MESH_HOOK_MATCHER } from "../harnesses/shared/install.mjs";
export { formatMessages } from "../presence/inbox-format.mjs";
export { readSqliteRow } from "../harnesses/shared/sqlite.mjs";
export { isBackgroundSession, isProcessAlive, getMeshHome };

/**
 * Reads and parses JSON payload from standard input with a timeout guard.
 * @param {{ timeoutMs?: number }} [options={}]
 * @returns {Promise<object>} Parsed object, or empty object on timeout / parse failure.
 */
export function readStdinJson(options = {}) {
  const timeoutMs = options.timeoutMs ?? 1000;

  return new Promise((resolve) => {
    let raw = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        resolve({});
      }
    }, timeoutMs);
    timer.unref?.();

    process.stdin.setEncoding("utf8");

    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });

    process.stdin.on("end", () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        const trimmed = raw.trim();
        resolve(trimmed ? JSON.parse(trimmed) : {});
      } catch {
        resolve({});
      }
    });

    process.stdin.on("error", () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({});
    });

    // If stdin is already paused or ended
    if (process.stdin.isTTY) {
      finished = true;
      clearTimeout(timer);
      resolve({});
    }
  });
}

/**
 * Emits a JSON payload to standard output and explicitly awaits stream flush before proceeding.
 * Prevents Windows stdout truncation where process.exit drops pending stdout buffers.
 * @param {object} obj - Object to emit as JSON.
 * @returns {Promise<void>}
 */
export function emitJson(obj) {
  return safeWrite(process.stdout, `${JSON.stringify(obj)}\n`);
}

/**
 * Best-effort human-readable session name via the harness descriptor (Claude transcript title,
 * Codex thread name, agy conversation title). Never throws; null when the session has no name yet.
 *
 * @param {string} harness id or alias
 * @param {string} sessionId
 * @param {{ transcript_path?: string }} [input]
 * @returns {string|null}
 */
export function resolveSessionName(harness, sessionId, input = {}) {
  try {
    return registry.get(harness)?.name?.resolve?.({ sessionId, transcript: input.transcript_path }) || null;
  } catch {
    return null;
  }
}

/**
 * Resolves the authentic long-lived harness process ID for a hook-driven session (see resolvePid).
 * @param {string} [sessionId]
 * @param {{ harness?: string, event?: string, fastOnly?: boolean }} [options]
 * @returns {number|null}
 */
export function resolveTrueHarnessPid(sessionId, options = {}) {
  return resolvePid(registry.get(options.harness) ?? null, sessionId, options);
}

/**
 * Direct, non-blocking notification for lifecycle hook events.
 * Provides immediate auditory and visual feedback on session lifecycle transitions:
 * - Windows: Plays audio chime ([System.Media.SystemSounds]::Asterisk.Play()) and shows
 *   an auto-dismissing (2-second) desktop popup via a detached unreferenced process (~18ms).
 * - POSIX / Headless VPS: Writes ASCII bell (\x07) to process.stderr (0ms, terminal audio alert).
 * - Appends to ~/.agent-mesh/logs/hooks.log for the live CLI watcher (`mesh hooks watch`).
 *
 * @param {object} params
 * @param {string} params.harness - Name of the harness (claude, antigravity, codex, etc.)
 * @param {string} params.event - Hook lifecycle event name (SessionStart, Stop, SessionEnd)
 * @param {string} [params.state] - State descriptor (start, busy, idle, continue, block, end)
 * @param {string} [params.sessionId] - Active session identifier
 * @param {number|null} [params.pid] - Harness process ID
 */
export function notifyHookPresence({ harness, event, state, sessionId, pid }) {
  if (process.env.MESH_SILENT === "1") return;

  const harnessUpper = String(harness || "unknown").toUpperCase();
  const sidShort = sessionId ? `${String(sessionId).slice(0, 8)}…` : "no-session";
  const stateStr = state ? ` (${state})` : "";
  const pidStr = pid ? ` [PID: ${pid}]` : "";

  // 1. Headless terminal bell on stderr (does not corrupt JSON stdout)
  try {
    process.stderr.write("\x07");
  } catch {}

  // 2. Windows system (toast) notification
  if (process.platform === "win32") {
    try {
      const body = `${harnessUpper}${stateStr}  Session: ${sidShort}${pidStr}`;
      // ponytail: detached:true makes powershell silently no-op and plain children die with the
      // parent; `cmd /c start` + spawnSync (returns in ms) is the combo that survives hook exit.
      spawnSync(
        "cmd.exe",
        ["/c", "start", "", "/min", "powershell.exe", ...toastArgs(`Agent Mesh: ${event}`, body)],
        { stdio: "ignore", windowsHide: true }
      );
    } catch {}
  }
}

/**
 * Synchronously appends an event record to the universal hook diagnostic log.
 * Handles automatic log rotation at 5 MB.
 *
 * @param {object} entry
 */
export function appendHookAuditLog(entry) {
  try {
    const logsDir = join(getMeshHome(), ".agent-mesh", "logs");
    guardWrite(logsDir);
    mkdirSync(logsDir, { recursive: true });
    const logPath = join(logsDir, "hooks.log");

    if (existsSync(logPath)) {
      try {
        const stats = statSync(logPath);
        if (stats.size > 5 * 1024 * 1024) {
          renameSync(logPath, `${logPath}.1`);
        }
      } catch {}
    }

    const payload = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry,
    }) + "\n";
    appendFileSync(logPath, payload, "utf8");
  } catch {}
}

