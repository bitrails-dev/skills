/**
 * @file codex.mjs
 * @description OpenAI Codex CLI Driver for agent-mesh.
 * Implements headless execution (`codex exec --json`) with session resumption.
 */

import { createResumeDriver } from "./base.mjs";

export function createCodexDriver() {
  return createResumeDriver({
    name: "codex",
    bin: "codex",
    getArgv(session) {
      const args = ["exec", "--json"];
      if (session?.id) {
        args.push("resume", session.id);
      }
      return args;
    },

    parseLine(line) {
      try {
        const event = JSON.parse(line);
        if (event.type === "item" && event.text) {
          return { t: "text", text: event.text };
        }
        if (event.type === "session" && event.id) {
          return { t: "session_init", sessionId: event.id };
        }
        return null;
      } catch {
        return { t: "text", text: line };
      }
    },

    attach(session) {
      return ["codex", "resume", session.id];
    },
  });
}

export default createCodexDriver;
