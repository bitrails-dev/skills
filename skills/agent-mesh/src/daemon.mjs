/**
 * @file daemon.mjs
 * @description Broker daemon lifecycle manager: cold-start, lazy upgrade on contact,
 * drain-and-rebind coordination, and graceful/forced termination.
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { probeAddress, sendIpcRequest, resolveIpcAddress, findRepoRoot } from "./ipc.mjs";
import { VERSION, semverLt } from "./version.mjs";

/**
 * Checks if an OS process is alive.
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

/**
 * Reads and validates broker.json metadata from disk.
 * @param {string} rootDir
 * @returns {object | null}
 */
export function getBrokerInfo(rootDir) {
  const brokerPidPath = join(rootDir, ".agent-mesh", "broker.json");
  if (!existsSync(brokerPidPath)) return null;
  try {
    const data = JSON.parse(readFileSync(brokerPidPath, "utf8"));
    if (isProcessAlive(data.pid)) {
      return data;
    }
    // Stale PID file
    try {
      unlinkSync(brokerPidPath);
    } catch {}
    return null;
  } catch {
    return null;
  }
}

/**
 * Default OS process termination helper.
 * @param {number} pid
 */
export function defaultForceKill(pid) {
  if (!pid || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {}
}

/**
 * Spawns a new broker daemon detached in the background.
 * @param {string} rootDir - Canonical repository root.
 * @returns {Promise<object>} Broker info.
 */
export async function startBroker(rootDir) {
  const brokerScript = resolve(import.meta.dirname, "./broker.mjs");
  const child = spawn(process.execPath, [brokerScript], {
    cwd: rootDir,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });

  child.unref();

  // Poll for broker.json to appear and report alive process
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const info = getBrokerInfo(rootDir);
    if (info) {
      return info;
    }
  }

  throw new Error("Failed to confirm broker daemon startup after 2.5 seconds.");
}

/**
 * Polls until the IPC address is released (no server listening).
 * @param {string} address - Pipe or socket address.
 * @param {number} [budgetMs=8000] - Total wait budget in milliseconds.
 * @returns {Promise<boolean>} True if released, false if timed out.
 */
export async function awaitPipeRelease(address, budgetMs = 8000) {
  const startTime = Date.now();
  while (Date.now() - startTime < budgetMs) {
    const isLive = await probeAddress(address, 200);
    if (!isLive) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Ensures a healthy, up-to-date broker daemon is active.
 * If no broker is running, performs cold start.
 * If an outdated broker is running, coordinates drain-and-rebind or forced upgrade.
 * @param {object} [options={}]
 * @param {string} [options.rootDir]
 * @param {string} [options.address]
 * @param {(pid: number) => void} [options.forceKill]
 * @returns {Promise<object>}
 */
export async function ensureBroker(options = {}) {
  const rootDir = options.rootDir || findRepoRoot(process.cwd());
  const address = options.address || resolveIpcAddress(rootDir);
  const forceKill = options.forceKill || defaultForceKill;

  const ping = await sendIpcRequest(address, { action: "ping" }, 0).catch(() => null);

  if (!ping || !ping.ok) {
    // Daemon not answering on IPC; clean any stale files and launch fresh
    const staleInfo = getBrokerInfo(rootDir);
    if (staleInfo?.pid && !isProcessAlive(staleInfo.pid)) {
      try {
        unlinkSync(join(rootDir, ".agent-mesh", "broker.json"));
      } catch {}
    }
    return startBroker(rootDir);
  }

  // Broker is answering; check version
  const brokerVersion = ping.version;
  if (!brokerVersion || semverLt(brokerVersion, VERSION)) {
    const existing = getBrokerInfo(rootDir);
    const oldPid = existing?.pid || ping.pid;

    if (brokerVersion) {
      // Graceful drain signal (≥ v1.1.0)
      await sendIpcRequest(address, { action: "restart" }, 0).catch(() => {});
    } else if (oldPid) {
      // Legacy v1.0.0 daemon: hard terminate
      forceKill(oldPid);
    }

    const released = await awaitPipeRelease(address, 8000);
    if (!released && oldPid) {
      forceKill(oldPid);
      await awaitPipeRelease(address, 2000);
    }

    const newInfo = await startBroker(rootDir);
    const newPing = await sendIpcRequest(address, { action: "ping" }, 2).catch(() => null);
    if (newPing?.ok && semverLt(newPing.version, VERSION)) {
      throw new Error(`Broker restart produced v${newPing.version}, but CLI requires v${VERSION}.`);
    }

    return newInfo;
  }

  return { ok: true, pid: ping.pid, version: brokerVersion, address };
}

/**
 * Stops the broker daemon gracefully, falling back to force-kill if unresponsive.
 * @param {object} [options={}]
 * @param {string} [options.rootDir]
 * @param {string} [options.address]
 * @param {(pid: number) => void} [options.forceKill]
 * @returns {Promise<{ ok: boolean, pid?: number }>}
 */
export async function stopBroker(options = {}) {
  const rootDir = options.rootDir || findRepoRoot(process.cwd());
  const address = options.address || resolveIpcAddress(rootDir);
  const forceKill = options.forceKill || defaultForceKill;
  const broker = getBrokerInfo(rootDir);

  if (!broker) {
    return { ok: true, message: "No running broker found." };
  }

  // 2. Poll until process has completely terminated
  const startTime = Date.now();
  while (Date.now() - startTime < 6000) {
    await new Promise((r) => setTimeout(r, 100));
    if (!isProcessAlive(broker.pid)) {
      const brokerPidPath = join(rootDir, ".agent-mesh", "broker.json");
      if (existsSync(brokerPidPath)) {
        try { unlinkSync(brokerPidPath); } catch {}
      }
      return { ok: true, pid: broker.pid };
    }
  }

  // 3. Fallback to OS force-kill
  forceKill(broker.pid);
  const killWait = Date.now();
  while (isProcessAlive(broker.pid) && Date.now() - killWait < 2000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const brokerPidPath = join(rootDir, ".agent-mesh", "broker.json");
  if (existsSync(brokerPidPath)) {
    try {
      unlinkSync(brokerPidPath);
    } catch {}
  }

  return { ok: true, pid: broker.pid, forced: true };
}
