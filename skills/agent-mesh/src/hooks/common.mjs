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
import { execFileSync, spawn } from "node:child_process";

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
  return `node "${normalized}"${argsStr}`;
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

  // 3. Harness fast path: Claude Code, Codex, OpenCode, and Pi spawn hook node processes directly.
  // In those harnesses, directPid (process.ppid) IS the authentic harness PID.
  if (harness === "claude" || harness === "codex" || harness === "opencode" || harness === "pi") {
    try {
      mkdirSync(pidsDir, { recursive: true });
      writeFileSync(pidFile, String(directPid), "utf8");
    } catch {}
    return directPid;
  }

  let resolvedPid = directPid;

  // 4. Windows wrapper shell handling (primarily for Antigravity where cmd.exe wraps the invocation)
  if (process.platform === "win32") {
    if (harness === "antigravity") {
      // NEVER block hook on synchronous PowerShell/WMI crawling (which takes 6.5s on Windows).
      // Return null synchronously so the hook finishes in < 15ms and the session is NOT prematurely reaped.
      // Launch an unreferenced detached background worker to asynchronously resolve agy.exe and populate the PID cache.
      try {
        const resolveScript = `
          try {
            $shells = @('cmd.exe', 'powershell.exe', 'pwsh.exe', 'conhost.exe');
            $p = Get-CimInstance Win32_Process -Filter "ProcessId = ${directPid}";
            while ($p -and ($p.Name.ToLower() -in $shells) -and $p.ParentProcessId) {
              $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.ParentProcessId)";
              if (-not $parent) { break }
              $p = $parent;
            }
            if ($p -and $p.ProcessId) {
              Set-Content -Path '${pidFile.replace(/\\/g, "/")}' -Value $p.ProcessId -Encoding ASCII;
            }
          } catch {}
        `;
        const worker = spawn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", resolveScript],
          {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          }
        );
        worker.unref?.();
      } catch {}
      return null;
    }
  } else {
    // POSIX / Linux: Walk up /proc/<pid>/stat field 4, skipping shells (< 2ms)
    try {
      const shells = new Set(["sh", "bash", "dash", "zsh", "fish"]);
      let curr = directPid;
      for (let i = 0; i < 6; i++) {
        const statPath = `/proc/${curr}/stat`;
        if (!existsSync(statPath)) break;
        const statStr = readFileSync(statPath, "utf8");
        const parts = statStr.split(" ");
        const comm = parts[1]?.replace(/[()]/g, "").toLowerCase();
        const ppid = Number(parts[3]);
        if (!ppid || !isProcessAlive(ppid)) break;
        curr = ppid;
        if (!shells.has(comm)) break;
      }
      if (curr && isProcessAlive(curr)) {
        try {
          mkdirSync(pidsDir, { recursive: true });
          writeFileSync(pidFile, String(curr), "utf8");
        } catch {}
        return curr;
      }
    } catch {}
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

  // 2. Windows audio chime and auto-dismissing popup using quote-safe -EncodedCommand
  if (process.platform === "win32") {
    try {
      const popupText = `[Agent Mesh] ${harnessUpper} ${event}${stateStr}\nSession: ${sidShort}${pidStr}`;
      const psScript = `
        try {
          $sound = 'C:\\Windows\\Media\\Windows Notify System Generic.wav';
          if (Test-Path $sound) {
            (New-Object System.Media.SoundPlayer $sound).Play();
          } else {
            [System.Media.SystemSounds]::Asterisk.Play();
          }
          (New-Object -ComObject Wscript.Shell).Popup(@"
${popupText}
"@, 2, 'Agent Mesh Presence', 64);
        } catch {}
      `;
      const encoded = Buffer.from(psScript, "utf16le").toString("base64");
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        }
      );
      child.unref?.();
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

