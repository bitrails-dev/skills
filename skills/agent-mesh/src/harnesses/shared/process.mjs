import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { guardWrite } from "./home-guard.mjs";

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

/**
 * The PowerShell to use on Windows: pwsh.exe (7+) when it is on PATH, else the always-present Windows
 * PowerShell 5.1. Resolved from PATH (no process spawn), cached per process.
 * @param {{ PATH?: string, Path?: string }} [env]
 * @param {(p: string) => boolean} [exists]
 */
export function resolvePowershell(env = process.env, exists = existsSync) {
  const dirs = String(env.PATH || env.Path || "").split(";").filter(Boolean);
  for (const exe of ["pwsh.exe", "powershell.exe"]) {
    if (dirs.some((d) => exists(join(d, exe)))) return exe;
  }
  return "powershell.exe"; // System32\WindowsPowerShell is always on the default PATH
}
let powershellCache = null;
export const powershellExe = () => (powershellCache ??= resolvePowershell());

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
    execFile(win ? powershellExe() : "ps", args, { windowsHide: true, timeout: 8000 }, (err, out) => {
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
export function walkPastShells(directPid) {
  let resolvedPid = directPid;
  let cmdline = "";
  try {
    if (process.env.MESH_NO_PID_WALK === "1") {
      // test/opt-out: trust the direct parent
    } else if (process.platform === "win32") {
      // Get-CimInstance works on Windows PowerShell 5.1 and 7 (Process.Parent exists only on 7)
      const script =
        `$s=@('${SHELLS.join("','")}');$id=${directPid};$cl='';` +
        `for($i=0;$i -lt 8;$i++){$p=Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue;` +
        `if(-not $p){break};$cl=$p.CommandLine;$n=($p.Name.ToLower() -replace '\.exe$','');` +
        `if(($s -contains $n) -and $p.ParentProcessId){$id=$p.ParentProcessId}else{break}};"$id|$cl"`;
      const out = execFileSync(
        powershellExe(),
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
      guardWrite(dir);
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
      guardWrite(dir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(pidFile, String(resolvedPid), "utf8");
    } catch {}
    return resolvedPid;
  }

  // 4. Cache fallback directPid
  if (directPid) {
    try {
      guardWrite(dir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(pidFile, String(directPid), "utf8");
    } catch {}
  }
  return directPid;
}

/** Inactivity TTLs for interactive sessions without a verifiable pid (idle / busy). */
export const DEFAULT_TTL_MS = { idle: 10 * 60 * 1000, busy: 60 * 60 * 1000 };

/**
 * First positional token (subcommand or prompt) of a CLI command line, skipping flags and the values of
 * `valueFlags`. Descriptors supply the flag/subcommand knowledge; the tokenizer is shared.
 * @param {string} cmdline
 * @param {{ valueFlags?: Set<string>, exitFlags?: string[] }} [opts] exitFlags: flags meaning "prints and exits"
 * @returns {{ token?: string, exits?: boolean }}
 */
export function firstPositional(cmdline, { valueFlags = new Set(), exitFlags = ["-h", "--help", "-V", "--version"] } = {}) {
  const toks = String(cmdline || "").match(/"[^"]*"|\S+/g)?.map((t) => t.replace(/^"|"$/g, "")) ?? [];
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    if (exitFlags.includes(t)) return { exits: true };
    if (!t.startsWith("-")) return { token: t.toLowerCase() };
    if (valueFlags.has(t) && !t.includes("=")) i++;
  }
  return {};
}
