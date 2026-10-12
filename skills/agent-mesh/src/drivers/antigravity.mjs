/**
 * @file antigravity.mjs
 * @description Google Antigravity CLI Driver for agent-mesh.
 * Implements headless execution (`agy --print`) with session resumption and worktree awareness.
 */

import { execFileSync } from "node:child_process";
import { createResumeDriver } from "./base.mjs";

export function createAntigravityDriver() {
  return createResumeDriver({
    name: "antigravity",
    bin: "agy",
    getArgv(session) {
      const args = ["--print"];
      if (session?.id && session.id !== "default") {
        args.push("--resume-last");
      }
      return args;
    },

    parseLine(line) {
      // Parse Antigravity console and JSON markers
      if (line.includes("REPORT:")) {
        return { t: "text", text: line.replace(/^.*?REPORT:\s*/, "") };
      }
      return { t: "text", text: line };
    },

    attach(session) {
      return ["agy"];
    },
  });
}

export default createAntigravityDriver;
