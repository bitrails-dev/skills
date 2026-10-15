import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile, execFileSync } from "node:child_process";

/**
 * Safe process liveness check.
 * EPERM means the process is alive but belongs to another user / elevated context.
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

// ---- cmdline classification -------------------------------------------------------------------

/** Subcommands/flags that mean "not an interactive TUI" (daemon, helper, headless run). */
const NON_TUI_ARGS = /(?:^|\s)(?:app-server|daemon|proxy|exec|mcp-server|mcp|login|logout|sandbox|serve|language[-_]server|--headless|--print|-p)(?:\s|$)/;

/** Default TUI test: a non-empty command line without a helper/headless subcommand. */
export const looksInteractive = (cmdline) => Boolean(cmdline) && !NON_TUI_ARGS.test(cmdline);

const BACKGROUND_CMD = /daemon\s+run|--fork-session|--agent|(?:^|\s)(?:-p|--print)(?:\s|$)/;
const SHARED_HOST_CMD = /app-server/;

/**
 * Default hook-process classifier, used when a descriptor does not provide `classifyProcess`.
 * background  = forks/daemons/--agent/-p runs: not user terminals, hooks stay silent
 * sharedHost  = hooks run inside a long-lived daemon shared by every session: its pid is useless
 * @param {string} cmdline
 * @returns {{ background: boolean, sharedHost: boolean }}
 */
export function classifyCmdline(cmdline) {
  return { background: BACKGROUND_CMD.test(cmdline), sharedHost: SHARED_HOST_CMD.test(cmdline) };
}

// ---- process listing (broker-side scanner) -----------------------------------------------------

/** Default process source: [{pid, name}] via tasklist (win32) or ps. Name+pid only: cheap enough for a 3s tick. */
export function listProcesses() {
  return new Promise((res) => {
    const win = process.platform === "win32";
    execFile(win ? "tasklist" : "ps", win ? ["/FO", "CSV", "/NH"] : ["-eo", "pid=,comm="], { windowsHide: true, maxBuffer: 8 << 20 }, (err, out) => {
      if (err) return res([]);
      const rows = [];
      for (const line of String(out).split(/\r?\n/)) {
        const m = win ? line.match(/^"([^"]+)","(\d+)"/) : line.trim().match(/^(\d+)\s+(.+)$/);
        if (!m) continue;
        rows.push(win ? { name: m[1], pid: Number(m[2]) } : { pid: Number(m[1]), name: m[2].split("/").pop() });
      }
      res(rows);
    });
  });
}

/** Default one-shot detail lookup for a NEW pid: { ppid, cmd } or null. */
export function processInfo(pid) {
  return new Promise((res) => {
    const win = process.platform === "win32";
    const args = win
      ? ["-NoProfile", "-NonInteractive", "-Command", `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}";if($p){"$($p.ParentProcessId)|$($p.CommandLine)"}`]
      : ["-o", "ppid=,args=", "-p", String(pid)];
    execFile(win ? "pwsh.exe" : "ps", args, { windowsHide: true, timeout: 8000 }, (err, out) => {
      if (err) return res(null);
      const m = win ? String(out).trim().match(/^(\d+)\|(.*)$/s) : String(out).trim().match(/^(\d+)\s+(.*)$/s);
      res(m ? { ppid: Number(m[1]), cmd: m[2] } : null);
    });
  });
}

// ---- hook-side pid resolution -------------------------------------------------------------------

const SHELLS = ["cmd", "powershell", "pwsh", "conhost", "bash", "sh", "dash", "zsh", "fish", "wsl"];

const cleanId = (sessionId) => String(sessionId).replace(/[^\w-]/g, "");
const pidsDir = () => join(getMeshHome(), ".agent-mesh", "pids");

/**
 * True when the session's harness process was identified as a background (non-terminal) process.
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isBackgroundSession(sessionId) {
  if (!sessionId) return false;
  return existsSync(join(pidsDir(), `${cleanId(sessionId)}.bg`));
}

/** Climbs from `directPid` past shell wrappers. Returns { pid, cmdline }. Windows pays ~1-2s once per session. */
function walkPastShells(directPid) {
  let resolvedPid = directPid;
  let cmdline = "";
  try {
    if (process.env.MESH_NO_PID_WALK === "1") {
      // test/opt-out: trust the direct parent
    } else if (process.platform === "win32") {
      const script =
        `$s=@('${SHELLS.join("','")}');$p=Get-Process -Id ${directPid} -ErrorAction SilentlyContinue;` +
        `while($p -and $p.ProcessName.ToLower() -in $s -and $p.Parent){$p=$p.Parent};if($p){"$($p.Id)|$($p.CommandLine)"}`;
      const out = execFileSync(
        "pwsh.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
      const m = out.match(/^(\d+)\|(.*)$/s);
      if (m) {
        resolvedPid = Number(m[1]);
        cmdline = m[2];
      }
    } else {
      let curr = directPid;
      for (let i = 0; i < 8; i++) {
        const [ppid, comm] = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(curr)], { encoding: "utf8" })
          .trim().split(/\s+/);
        if (!SHELLS.includes(String(comm).split("/").pop().toLowerCase()) || !Number(ppid)) break;
        curr = Number(ppid);
      }
      resolvedPid = curr;
      cmdline = execFileSync("ps", ["-o", "args=", "-p", String(curr)], { encoding: "utf8" });
    }
  } catch {}
  return { pid: resolvedPid, cmdline };
}

/**
 * Resolves the authentic long-lived harness process ID for a hook-driven session, per the descriptor's
 * pid strategy. The result is cached in <meshHome>/.agent-mesh/pids/<sessionId>.pid (sub-ms lookups);
 * `.bg` marks background processes and `.nopid` marks sessions hosted by a shared daemon.
 *
 * @param {import("../index.mjs").Harness|null} harness descriptor; null/unknown walks (legacy behavior)
 * @param {string} [sessionId]
 * @param {{ event?: string, fastOnly?: boolean }} [options]
 * @returns {number|null}
 */
export function resolvePid(harness, sessionId, options = {}) {
  const directPid = process.ppid || process.pid;
  if (!sessionId) return directPid;

  const strategy = harness?.pid ?? "walk";
  if (strategy === "none") return null;
  if (strategy === "direct" || strategy === "provided") return directPid;

  const event = String(options.event || "");
  const dir = pidsDir();
  const id = cleanId(sessionId);
  const pidFile = join(dir, `${id}.pid`);
  const mark = (suffix) => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}.${suffix}`), "1", "utf8");
    } catch {}
  };
  const cachedPid = () => {
    try {
      return existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
    } catch {
      return 0;
    }
  };

  // 1. SessionEnd fast path: never crawl or spawn external processes when terminating
  if (event === "SessionEnd" || options.fastOnly) return cachedPid() || directPid;

  // 2. Cache first. Sessions hosted by a shared app-server have no PID of their own.
  if (existsSync(join(dir, `${id}.nopid`))) return null;
  const cached = cachedPid();
  if (cached && isProcessAlive(cached)) return cached;

  // 3. Walk up from the hook's parent past shell wrappers, once per session.
  const { pid: resolvedPid, cmdline } = walkPastShells(directPid);
  const cls = (harness?.classifyProcess ?? classifyCmdline)(cmdline);
  if (cls.background) mark("bg");
  if (cls.sharedHost) {
    mark("nopid");
    return null;
  }
  if (resolvedPid && isProcessAlive(resolvedPid)) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(pidFile, String(resolvedPid), "utf8");
    } catch {}
    return resolvedPid;
  }

  // 4. Cache fallback directPid
  if (directPid) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(pidFile, String(directPid), "utf8");
    } catch {}
  }
  return directPid;
}

/** Inactivity TTLs for interactive sessions without a verifiable pid (idle / busy). */
export const DEFAULT_TTL_MS = { idle: 10 * 60 * 1000, busy: 60 * 60 * 1000 };
