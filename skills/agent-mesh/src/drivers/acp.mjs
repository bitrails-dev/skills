/**
 * @file acp.mjs
 * @description Universal Agent Client Protocol (ACP) Driver for agent-mesh.
 * Implements the open JSON-RPC-over-stdio standard, allowing any ACP-compliant agent
 * to seamlessly participate in the mesh with zero custom wrapper code.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { killProcessTree } from "./base.mjs";

export function createAcpDriver(options = {}) {
  const binary = options.bin || "acp-agent";

  return {
    name: options.name || "acp",
    caps: {
      delivery: "stream-stdio",
      midTurnInject: true,
      interrupt: true,
      concurrentViewers: false,
      mcp: true,
      preEditHook: true,
    },

    async probe() {
      return { ok: true };
    },

    async open(spec) {
      return {
        harness: options.name || "acp",
        id: spec.resume?.id || `acp-${Date.now()}`,
        cwd: spec.cwd,
      };
    },

    async *turn(session, prompt, signal) {
      const child = spawn(binary, options.args || [], {
        cwd: session.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });

      const rpcInit = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "agent-mesh", version: "0.1.0" } },
      };

      const rpcPrompt = {
        jsonrpc: "2.0",
        id: 2,
        method: "agent/turn",
        params: { sessionId: session.id, prompt },
      };

      // Avoid unhandled EPIPE crash if acp child closes early (B3)
      child.stdin.on("error", () => {});

      child.stdin.write(JSON.stringify(rpcInit) + "\n");
      child.stdin.write(JSON.stringify(rpcPrompt) + "\n");

      let isDone = false;
      const queue = [];
      let notify = null;

      // Add timeouts to prevent hanging on silent ACP agents
      const timer = setTimeout(() => {
        killProcessTree(child);
        queue.push({ t: "error", message: "ACP agent timed out after 10m", retryable: false });
        isDone = true;
        if (notify) notify();
      }, options.timeoutMs || 600_000);
      const decoder = new StringDecoder("utf8");
      let buffer = "";

      child.stdout.on("data", (chunk) => {
        buffer += decoder.write(chunk);
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trimEnd();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;

          try {
            const parsed = JSON.parse(line);
            if (parsed.method === "agent/event") {
              queue.push({ t: "text", text: parsed.params?.text || "" });
            } else if (parsed.id === 2 && parsed.result) {
              queue.push({ t: "done", session });
              isDone = true;
            }
          } catch {
            queue.push({ t: "text", text: line });
          }
        }
        if (notify) {
          notify();
          notify = null;
        }
      });

      child.on("close", () => {
        isDone = true;
        if (notify) {
          notify();
          notify = null;
        }
      });

      if (signal) {
        signal.addEventListener("abort", () => {
          killProcessTree(child);
        });
      }

      while (!isDone || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift();
        } else {
          await new Promise((r) => {
            notify = r;
          });
        }
      }
    },

    async close(session) {
      // Teardown
    },

    viewArgv(session) {
      return null;
    },

    attachArgv(session) {
      return [binary, "--attach", session.id];
    },
  };
}

export default createAcpDriver;
