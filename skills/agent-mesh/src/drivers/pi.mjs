/**
 * @file pi.mjs
 * @description Pi Coding Agent Driver for agent-mesh.
 * Implements both RPC mode (`pi --mode rpc`) and session resume execution.
 */

import { execFileSync } from "node:child_process";
import { createResumeDriver } from "./base.mjs";

export function createPiDriver() {
  return createResumeDriver({
    name: "pi",
    bin: "pi",
    getArgv(session) {
      const args = ["--mode", "json"];
      if (session?.id) {
        args.push("--session", session.id);
      }
      return args;
    },

    parseLine(line) {
      try {
        const event = JSON.parse(line);
        if (event.type === "session" && event.id) {
          return { t: "session_init", sessionId: event.id };
        }
        if (event.type === "message" && event.content) {
          return { t: "text", text: event.content };
        }
        if (event.type === "result") {
          return { t: "result", result: event.result || "", cost: event.cost };
        }
        return null;
      } catch {
        return { t: "text", text: line };
      }
    },

    attach(session) {
      return ["pi", "--session", session.id];
    },
  });
}

export default createPiDriver;
