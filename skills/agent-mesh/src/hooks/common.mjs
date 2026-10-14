import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  statSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { toastArgs } from "../notify.mjs";

/**
 * Regex matching any agent-mesh hook script invocation (including legacy names).
 */
export const MESH_HOOK_MATCHER = /(?:agy-)?presence-hook\.mjs|stop-hook\.mjs|opencode-presence-plugin|pi-presence-extension|agent-mesh-presence/;

/**
 * Builds a cross-platform executable hook command with forward slashes.
 * Forward slashes survive cmd.exe, PowerShell, and bash without escaping errors.
 * @param {string} scriptAbsPath - Absolute path to target hook script.
 * @param {string[]} [extraArgs=[]] - Additional CLI arguments (e.g. ['--harness', 'codex']).
 * @returns {string} Formatted shell command.
 */
export function buildHookCommand(scriptAbsPath, extraArgs = []) {
  const normalized = scriptAbsPath.replace(/\\/g, "/");
  const argsStr = extraArgs.length > 0 ? " " + extraArgs.join(" ") : "";
  // agy's hook runner mangles double-quoted paths (joins them onto its config dir), so only quote
  // when the path actually contains whitespace.
  const script = /\s/.test(normalized) ? `"${normalized}"` : normalized;
  return `node ${script}${argsStr}`;
}

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
 * Formats claimed inbox messages into human- and model-readable text block.
 * @param {Array<object>} messages
 * @returns {string}
 */
export function formatMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const header = `[AGENT-MESH INBOX NOTIFICATION: ${messages.length} pending message(s)]`;
  const body = messages
    .map((m) => {
      const fromStr = m.from_agent || "unknown";
      const ticketStr = m.id || "none";
      const hopsStr = m.hops !== undefined ? ` | Hops: ${m.hops}` : "";
      return `--- Message from [${fromStr}] (Ticket: ${ticketStr}${hopsStr}) ---\n${m.body}`;
    })
    .join("\n\n");
  const replyInstr = `\n\nTo reply, run: mesh reply --ticket <id> --to <agent> "<your response>"`;
  return `${header}\n\n${body}${replyInstr}`;
}

/**
 * Emits a JSON payload to standard output and explicitly awaits stream flush before proceeding.
 * Prevents Windows stdout truncation where process.exit drops pending stdout buffers.
 * @param {object} obj - Object to emit as JSON.
 * @returns {Promise<void>}
 */
export function emitJson(obj) {
  return new Promise((resolve) => {
    const payload = `${JSON.stringify(obj)}\n`;
    if (!process.stdout.write(payload)) {
      process.stdout.once("drain", resolve);
    } else {
      process.nextTick(resolve);
    }
  });
}

/**
 * Safe process liveness check.
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

export function getMeshHome() {
  return process.env.MESH_HOME || homedir();
}

/**
 * Resolves the authentic long-lived harness process ID for an interactive session.
 * On Windows, hook scripts are executed through intermediate wrapper shells (cmd.exe/pwsh.exe)
 * whose PPID dies as soon as the hook finishes. This function ascends the process tree once
 * per session to identify the true parent harness (Claude Code, Antigravity, etc.) and
 * caches the result in ~/.agent-mesh/pids/<sessionId>.pid for sub-millisecond future lookups.
 *
 * @param {string} [sessionId]
 * @param {object} [options={}]
 * @param {string} [options.harness]
 * @param {string} [options.event]
 * @param {boolean} [options.fastOnly]
 * @returns {number}
 */
export function resolveTrueHarnessPid(sessionId, options = {}) {
  const directPid = process.ppid || process.pid;
  if (!sessionId) return directPid;

  const harness = String(options.harness || "").toLowerCase();
  const event = String(options.event || "");
  const cleanSessionId = String(sessionId).replace(/[^\w-]/g, "");
  const pidsDir = join(getMeshHome(), ".agent-mesh", "pids");
  const pidFile = join(pidsDir, `${cleanSessionId}.pid`);

  // 1. SessionEnd fast path: never crawl or spawn external processes when terminating
  if (event === "SessionEnd" || options.fastOnly) {
    try {
      if (existsSync(pidFile)) {
        const cached = Number(readFileSync(pidFile, "utf8").trim());
        if (cached) return cached;
      }
    } catch {}
    return directPid;
  }

  // 2. Check cache first (< 0.2ms)
  try {
    if (existsSync(pidFile)) {
      const cached = Number(readFileSync(pidFile, "utf8").trim());
      if (cached && isProcessAlive(cached)) {
        return cached;
      }
    }
  } catch {}

  // 3. Walk up from the hook's parent past shell wrappers to the long-lived harness process.
  // Windows: one pwsh/powershell invocation (Get-Process .Parent, ~1-2s) paid once per session, then cached.
  const shells = ["cmd", "powershell", "pwsh", "conhost", "bash", "sh", "dash", "zsh", "fish", "wsl"];
  let resolvedPid = directPid;
  try {
    if (process.env.MESH_NO_PID_WALK === "1") {
      // test/opt-out: trust the direct parent
    } else if (process.platform === "win32") {
      const script =
        `$s=@('${shells.join("','")}');$p=Get-Process -Id ${directPid} -ErrorAction SilentlyContinue;` +
        `while($p -and $p.ProcessName.ToLower() -in $s -and $p.Parent){$p=$p.Parent};if($p){$p.Id}`;
      const out = execFileSync(
        "pwsh.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
      if (/^\d+$/.test(out)) resolvedPid = Number(out);
    } else {
      let curr = directPid;
      for (let i = 0; i < 8; i++) {
        const [ppid, comm] = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(curr)], { encoding: "utf8" })
          .trim().split(/\s+/);
        if (!shells.includes(String(comm).split("/").pop().toLowerCase()) || !Number(ppid)) break;
        curr = Number(ppid);
      }
      resolvedPid = curr;
    }
  } catch {}
  if (resolvedPid && isProcessAlive(resolvedPid)) {
    try {
      mkdirSync(pidsDir, { recursive: true });
      writeFileSync(pidFile, String(resolvedPid), "utf8");
    } catch {}
    return resolvedPid;
  }

  // 5. Cache fallback directPid
  if (directPid) {
    try {
      mkdirSync(pidsDir, { recursive: true });
      writeFileSync(pidFile, String(directPid), "utf8");
    } catch {}
  }

  return directPid;
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

