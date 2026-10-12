/**
 * @file ipc.mjs
 * @description Local IPC transport for agent-mesh.
 * Implements Windows Named Pipes and POSIX Unix Domain Sockets with strict NDJSON framing,
 * connection retries, and clean disconnect semantics.
 */

import { createServer, createConnection } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const MAX_FRAME_BYTES = 1024 * 1024; // 1 MB protection against buffer bloat

/**
 * Finds the canonical git repository root even if called from a subfolder or git worktree.
 * @param {string} [dir=process.cwd()] - Current working directory.
 * @returns {string} Canonical root path.
 */
export function findRepoRoot(dir = process.cwd()) {
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (commonDir) {
      const resolved = resolve(dir, commonDir);
      return dirname(resolved);
    }
  } catch {}
  return resolve(dir);
}

/**
 * Derives a deterministic socket/pipe path for a target repository directory.
 * Uses the canonical repository root to ensure all worktrees and subdirectories share the same pipe.
 * @param {string} cwd - Absolute path to working repository directory.
 * @returns {string} Pipe or socket path.
 */
export function getIpcAddress(cwd) {
  const root = findRepoRoot(cwd);
  const user = userInfo().username || "default";
  const hash = createHash("sha256").update(`${root.toLowerCase()}::${user}`).digest("hex").slice(0, 16);

  if (process.platform === "win32") {
    return `\\\\.\\pipe\\agent-mesh-${hash}`;
  }

  // POSIX: Keep socket in system temp to avoid 104-char path limit
  return join(tmpdir(), `agent-mesh-${hash}.sock`);
}

/**
 * Resolves the active IPC address authoritative for this workspace.
 * Prioritizes MESH_IPC_ADDRESS env var, then broker.json on disk, then deterministic hash.
 * @param {string} [dir=process.cwd()]
 * @returns {string} Authoritative pipe or socket address.
 */
export function resolveIpcAddress(dir = process.cwd()) {
  if (process.env.MESH_IPC_ADDRESS) return process.env.MESH_IPC_ADDRESS;
  const root = findRepoRoot(dir);
  const brokerPidPath = join(root, ".agent-mesh", "broker.json");
  if (existsSync(brokerPidPath)) {
    try {
      const data = JSON.parse(readFileSync(brokerPidPath, "utf8"));
      if (data?.ipcAddress) return data.ipcAddress;
    } catch {}
  }
  return getIpcAddress(root);
}

/**
 * Probes an IPC address by attempting a lightweight TCP/socket/pipe connection.
 * @param {string} address - Pipe or socket address.
 * @param {number} [timeoutMs=250] - Probe timeout in milliseconds.
 * @returns {Promise<boolean>} True if connection established, false if refused or timed out.
 */
export function probeAddress(address, timeoutMs = 250) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection(address);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {}
      resolve(result);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();

    socket.on("connect", () => {
      clearTimeout(timer);
      finish(true);
    });

    socket.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/**
 * Creates and starts an IPC server with EADDRINUSE retry resilience.
 * @param {string} address - Pipe or socket address.
 * @param {(req: object) => Promise<object>} requestHandler - Handler returning response payload.
 * @param {{ retryMs?: number }} [options={}] - Options for connection handling.
 * @returns {Promise<import("node:net").Server>}
 */
export function startIpcServer(address, requestHandler, options = {}) {
  const retryMs = options.retryMs ?? 3000;
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    let settled = false;
    let probed = false;
    let server = null;

    const cleanupStale = async () => {
      if (process.platform !== "win32" && existsSync(address)) {
        const isLive = await probeAddress(address, 300);
        if (!isLive) {
          try {
            unlinkSync(address);
          } catch {}
        }
      }
    };

    const tryListen = async () => {
      if (server) {
        try {
          server.close();
        } catch {}
      }

      await cleanupStale();

      server = createServer((socket) => {
        let buffer = "";

        socket.on("data", async (chunk) => {
          buffer += chunk.toString("utf8");

          if (buffer.length > MAX_FRAME_BYTES) {
            socket.destroy(new Error("IPC frame exceeded maximum size limit."));
            return;
          }

          let newlineIndex;
          while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIndex).trimEnd();
            buffer = buffer.slice(newlineIndex + 1);

            if (!line) continue;

            try {
              const req = JSON.parse(line);
              const res = await requestHandler(req);
              socket.end(`${JSON.stringify(res)}\n`);
            } catch (err) {
              socket.end(`${JSON.stringify({ ok: false, error: err.message })}\n`);
            }
          }
        });

        socket.on("end", () => {
          socket.destroy();
        });

        socket.on("error", () => {
          socket.destroy();
        });
      });

      server.on("error", async (err) => {
        if (settled) return;

        const elapsed = Date.now() - startTime;
        if (err.code === "EADDRINUSE" && elapsed < retryMs) {
          if (process.platform !== "win32" && !probed) {
            probed = true;
            await cleanupStale();
          }
          await new Promise((r) => setTimeout(r, 200));
          return tryListen();
        }

        reject(err);
      });

      server.listen(address, () => {
        settled = true;
        resolve(server);
      });
    };

    tryListen().catch(reject);
  });
}

/**
 * Sends a single RPC request to the running IPC server with retry backoff.
 * @param {string} address - Pipe or socket address.
 * @param {object} message - Request payload.
 * @param {number} maxRetries - Maximum retry attempts.
 * @returns {Promise<object>} Response payload.
 */
export async function sendIpcRequest(address, message, maxRetries = 3) {
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = createConnection(address);
        let buffer = "";

        socket.on("connect", () => {
          socket.write(`${JSON.stringify(message)}\n`);
        });

        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex).trimEnd();
            try {
              const parsed = JSON.parse(line);
              socket.end();
              resolve(parsed);
            } catch (err) {
              reject(err);
            }
          }
        });

        socket.on("error", (err) => {
          reject(err);
        });

        socket.setTimeout(15000, () => {
          socket.destroy(new Error("IPC connection timed out."));
        });
      });
    } catch (err) {
      attempt++;
      if (attempt > maxRetries) {
        throw new Error(`Failed to connect to agent-mesh broker at ${address} after ${maxRetries} retries: ${err.message}`);
      }
      // Exponential backoff with small jitter (50ms, 100ms, 150ms)
      await new Promise((r) => setTimeout(r, attempt * 50));
    }
  }
}
