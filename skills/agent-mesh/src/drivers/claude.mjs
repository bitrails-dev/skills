/**
 * @file claude.mjs
 * @description Claude Code Driver for agent-mesh.
 * Implements headless stream-json invocation, session ID tracking, and native attach support.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createResumeDriver } from "./base.mjs";

/**
 * Resolves the native claude.exe binary on Windows or claude on POSIX.
 * Explicitly rejects .cmd / .bat shims to avoid CVE-2024-27980 quoting pitfalls.
 * @returns {string} Absolute path to claude executable.
 */
export function resolveClaudeBinary() {
  if (process.env.MESH_CLAUDE_PATH && existsSync(process.env.MESH_CLAUDE_PATH)) {
    return process.env.MESH_CLAUDE_PATH;
  }

  if (process.platform === "win32") {
    const candidatePaths = [
      join(homedir(), ".local", "bin", "claude.exe"),
      join(homedir(), "AppData", "Local", "Microsoft", "WinGet", "Links", "claude.exe"),
    ];

    for (const p of candidatePaths) {
      if (existsSync(p)) return p;
    }

    try {
      const output = execFileSync("where.exe", ["claude.exe"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const first = output.split(/\r?\n/)[0]?.trim();
      if (first && existsSync(first)) return first;
    } catch {
      // Fall through
    }
  } else {
    try {
      const output = execFileSync("which", ["claude"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const first = output.split("\n")[0]?.trim();
      if (first && existsSync(first)) return first;
    } catch {
      // Fall through
    }
  }

  return "claude"; // Fallback to PATH
}

export function createClaudeDriver() {
  const bin = resolveClaudeBinary();

  return createResumeDriver({
    name: "claude",
    bin,
    getArgv(session) {
      const argv = [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "acceptEdits",
      ];

      if (process.platform === "win32") {
        argv.push("--allowedTools", "PowerShell");
      }

      if (session?.id && !session.id.startsWith("sess-") && session.id !== "default") {
        argv.push("--resume", session.id);
      }

      return argv;
    },

    parseLine(line) {
      try {
        const event = JSON.parse(line);

        if (event.type === "system" && (event.session_id || event.sessionId)) {
          return {
            t: "session_init",
            sessionId: event.session_id || event.sessionId,
          };
        }

        if (event.type === "assistant" && event.message?.content) {
          const textChunks = event.message.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("");
          if (textChunks) return { t: "text", text: textChunks };
        }

        if (event.type === "result") {
          return {
            t: "result",
            result: event.result || "",
            cost: event.total_cost_usd || event.cost_usd,
            numTurns: event.num_turns,
          };
        }

        return null;
      } catch {
        return { t: "text", text: line };
      }
    },

    attach(session) {
      if (session?.id && !session.id.startsWith("sess-") && session.id !== "default") {
        return [bin, "--resume", session.id];
      }
      return [bin];
    },
  });
}

export default createClaudeDriver;
