/**
 * @file base.mjs
 * @description Driver abstractions and declarative `resumeDriver` factory for agent-mesh.
 * Provides safe child process execution, dual timeouts (idle + total), stdin delivery,
 * and Windows process tree killing (`taskkill /T /F`).
 */

import { spawn, execFileSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/**
 * Gracefully or forcibly terminates an entire process tree.
 * @param {import("node:child_process").ChildProcess} child
 */
export function killProcessTree(child) {
  if (!child || !child.pid) return;

  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } catch {
      // Process tree already exited
    }
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
    setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, 2000);
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

/**
 * Creates a declarative resume-based harness driver.
 * @param {object} config
 * @param {string} config.name - Name of harness (e.g. 'claude', 'aider', 'agy').
 * @param {string} config.bin - Binary path or executable name.
 * @param {(session: object|null, prompt: string) => string[]} config.getArgv - Returns argv for turn.
 * @param {(line: string) => object|null} [config.parseLine] - Maps stdout line to MeshEvent.
 * @param {(session: object) => string[]} config.attach - Returns native attach command argv.
 * @param {Record<string, string>} [config.defaultEnv] - Extra environment variables.
 * @param {number} [config.idleTimeoutMs=90000] - Idle timeout reset on each chunk (90s).
 * @param {number} [config.totalTimeoutMs=600000] - Total hard turn timeout (10m).
 * @returns {object} Concrete HarnessDriver.
 */
export function createResumeDriver(config) {
  return {
    name: config.name,
    caps: {
      delivery: "resume",
      midTurnInject: false,
      interrupt: true,
      concurrentViewers: false,
      mcp: false,
      preEditHook: false,
    },

    async probe() {
      try {
        execFileSync(config.bin, ["--version"], { stdio: "ignore", timeout: 5000 });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err.message };
      }
    },

    async open(spec) {
      if (spec.resume) {
        return spec.resume;
      }
      return {
        harness: config.name,
        id: `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        cwd: spec.cwd,
      };
    },

    async *turn(session, prompt, signal) {
      const argv = config.getArgv(session, prompt);
      const env = { ...process.env, ...(config.defaultEnv || {}) };

      const child = spawn(config.bin, argv, {
        cwd: session.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });

      // Avoid unhandled EPIPE if child exits before draining stdin (B3)
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);

      // Drain stderr to prevent 64 KB OS pipe buffer deadlock (H4)
      child.stderr.on("data", () => {});
      child.stderr.on("error", () => {});

      let idleTimer = null;
      let totalTimer = null;
      let timedOut = false;
      let idleTimedOut = false;

      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleTimedOut = true;
          killProcessTree(child);
        }, config.idleTimeoutMs || 90_000);
      };

      totalTimer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, config.totalTimeoutMs || 600_000);

      resetIdleTimer();

      if (signal) {
        signal.addEventListener("abort", () => {
          killProcessTree(child);
        });
      }

      const eventsQueue = [];
      let notify = null;
      let isDone = false;

      const decoder = new StringDecoder("utf8");
      let buffer = "";

      child.stdout.on("data", (chunk) => {
        resetIdleTimer();
        buffer += decoder.write(chunk);

        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trimEnd();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;

          if (config.parseLine) {
            const parsed = config.parseLine(line);
            if (parsed) eventsQueue.push(parsed);
          } else {
            eventsQueue.push({ t: "text", text: line });
          }
        }
        if (notify) {
          notify();
          notify = null;
        }
      });

      child.on("close", (code) => {
        if (idleTimer) clearTimeout(idleTimer);
        if (totalTimer) clearTimeout(totalTimer);

        if (idleTimedOut) {
          eventsQueue.push({ t: "error", message: `Turn aborted: idle timeout (${config.idleTimeoutMs || 90000}ms of silence)`, retryable: false });
        } else if (timedOut) {
          eventsQueue.push({ t: "error", message: `Turn aborted: total timeout (${config.totalTimeoutMs || 600000}ms elapsed)`, retryable: false });
        } else if (code !== 0) {
          eventsQueue.push({ t: "error", message: `Process exited with code ${code}`, retryable: false });
        } else {
          eventsQueue.push({ t: "done", session });
        }

        isDone = true;
        if (notify) {
          notify();
          notify = null;
        }
      });

      child.on("error", (err) => {
        eventsQueue.push({ t: "error", message: err.message, retryable: false });
        isDone = true;
        if (notify) {
          notify();
          notify = null;
        }
      });

      while (!isDone || eventsQueue.length > 0) {
        if (eventsQueue.length > 0) {
          yield eventsQueue.shift();
        } else {
          await new Promise((r) => {
            notify = r;
          });
        }
      }
    },

    async close(session) {
      // Stateless resume drivers require no teardown
    },

    viewArgv(session) {
      return null; // Defaults to mesh watch log tailing
    },

    attachArgv(session) {
      return config.attach(session);
    },
  };
}
