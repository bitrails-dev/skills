/**
 * @file opencode.mjs
 * @description OpenCode Driver for agent-mesh.
 * Implements both Server/SSE delivery (concurrent viewers) and CLI fallback.
 */

import { execFileSync, spawn } from "node:child_process";
import { createResumeDriver } from "./base.mjs";

export function createOpenCodeDriver(options = {}) {
  const port = options.port || 4096;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    name: "opencode",
    caps: {
      delivery: "server",
      midTurnInject: true,
      interrupt: true,
      concurrentViewers: true, // Native live view supported out-of-the-box
      mcp: true,
      preEditHook: false,
    },

    async probe() {
      try {
        execFileSync("opencode", ["--version"], { stdio: "ignore", timeout: 5000 });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err.message };
      }
    },

    async open(spec) {
      return {
        harness: "opencode",
        id: spec.resume?.id || `sess-${Date.now()}`,
        cwd: spec.cwd,
        meta: { url: baseUrl, port: String(port) },
      };
    },

    async *turn(session, prompt, signal, opts = {}) {
      // In server mode, attempts HTTP RPC to `opencode serve`.
      // Falls back to CLI execution if server endpoint is offline.
      let usedServer = false;

      try {
        const response = await fetch(`${baseUrl}/api/turns`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: session.id,
            prompt,
          }),
          signal,
        });

        if (response.ok) {
          usedServer = true;
          const reader = response.body.getReader();
          const decoder = new TextDecoder("utf-8");

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value);
            yield { t: "text", text };
          }
          yield { t: "done", session };
        }
      } catch {
        usedServer = false;
      }

      // Fallback to CLI execution if local server is not running
      if (!usedServer) {
        const fallbackDriver = createResumeDriver({
          name: "opencode",
          bin: "opencode",
          getArgv(s) {
            const args = ["run"];
            if (s?.id && !s.id.startsWith("sess-")) args.push("--session", s.id);
            return args;
          },
          attach(s) {
            return ["opencode", "attach", baseUrl];
          },
        });

        for await (const event of fallbackDriver.turn(session, prompt, signal, opts)) {
          yield event;
        }
      }
    },

    async close(session) {
      // Teardown if required
    },

    viewArgv(session) {
      // Return command to open live web UI or terminal attach
      return ["opencode", "attach", baseUrl];
    },

    attachArgv(session) {
      return ["opencode", "attach", baseUrl];
    },
  };
}

export default createOpenCodeDriver;
