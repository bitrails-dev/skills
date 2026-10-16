/**
 * @file caller.mjs
 * @description Which mesh session is running this command? A CLI invoked from a harness's shell tool is a
 * descendant of that harness's process, so the ancestor pid chain identifies the live session. Used by
 * `mesh send/ask/reply` so messages sent through Bash carry the sender session (hop propagation).
 */

import { execFileSync } from "node:child_process";

/** Parent chain of `startPid` (including it), nearest first. Empty when disabled or unsupported. */
export function ancestorPids(startPid = process.pid, maxDepth = 12) {
  if (process.env.MESH_NO_PID_WALK === "1") return [];
  try {
    if (process.platform === "win32") {
      const script =
        "$p=" + startPid + ";$o=@();for($i=0;$i -lt " + maxDepth + ";$i++){$o+=$p;$q=(Get-CimInstance Win32_Process -Filter \"ProcessId=$p\").ParentProcessId;if(-not $q -or $q -eq $p){break};$p=$q};$o -join ','";
      const out = execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        timeout: 8000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.trim().split(",").map(Number).filter(Boolean);
    }
    const chain = [];
    let pid = startPid;
    for (let i = 0; i < maxDepth && pid > 1; i++) {
      chain.push(pid);
      pid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
    }
    return chain;
  } catch {
    return [];
  }
}
