/**
 * @file ipc.mjs
 * @description Local IPC transport for agent-mesh.
 * Implements Windows Named Pipes and POSIX Unix Domain Sockets with strict NDJSON framing,
 * connection retries, and clean disconnect semantics.
 */

import { createServer, createConnection } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
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
 * Creates and starts an IPC server.
 * @param {string} address - Pipe or socket address.
 * @param {(req: object) => Promise<object>} requestHandler - Handler returning response payload.
 * @returns {Promise<import("node:net").Server>}
 */
export function startIpcServer(address, requestHandler) {
  return new Promise((resolve, reject) => {
    // POSIX clean-up of stale socket files
    if (process.platform !== "win32" && existsSync(address)) {
      try {
        unlinkSync(address);
      } catch (err) {
        return reject(new Error(`Failed to unlink stale socket ${address}: ${err.message}`));
      }
    }

    const server = createServer((socket) => {
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
            socket.write(`${JSON.stringify(res)}\n`);
          } catch (err) {
            socket.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
          }
        }
      });

      socket.on("error", () => {
        // Suppress client-side abort errors on the server
      });
    });

    server.listen(address, () => {
      resolve(server);
    });

    server.on("error", (err) => {
      reject(err);
    });
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
