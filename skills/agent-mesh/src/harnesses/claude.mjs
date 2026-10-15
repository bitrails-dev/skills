import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, writeFileSync } from "node:fs";
import { tailText } from "./shared/transcript.mjs";
import {
  readJsonSafe,
  installNestedHooks,
  uninstallNestedHooks,
  hasNestedHooks,
  diagnoseResult,
  jsonMcpSource,
} from "./shared/install.mjs";

const ID = "claude";

/** Newest custom (/rename) title wins over the AI title; both come from the transcript tail. */
function resolveName({ transcript }) {
  if (!transcript || !existsSync(transcript)) return null;
  let custom = null;
  let ai = null;
  for (const line of tailText(transcript, 512 * 1024).split("\n")) {
    if (line.includes('"custom-title"')) custom = JSON.parse(line).customTitle || custom;
    else if (line.includes('"ai-title"')) ai = JSON.parse(line).aiTitle || ai;
  }
  return custom || ai || null;
}

/** @type {import("./index.mjs").Harness} */
export default {
  id: ID,
  aliases: ["claude-code"],
  displayName: "Claude Code",
  discovery: {
    binaries: ["claude"],
    markers: (root) => [join(homedir(), ".claude"), join(root, ".claude")],
    skillDir: () => join(homedir(), ".claude", "skills", "agent-mesh"),
    projectDir: ".claude",
  },
  presence: [
    {
      kind: "hook",
      script: "presence-hook.mjs",
      resolvePaths: ({ global, root }) => ({
        targetPath: global ? join(homedir(), ".claude", "settings.json") : join(root, ".claude", "settings.json"),
      }),
      install: (p, script) => installNestedHooks(p.targetPath, script),
      uninstall: (p) => uninstallNestedHooks(p.targetPath),
      diagnose(p) {
        if (!existsSync(p.targetPath)) return diagnoseResult(ID, p.targetPath, false, "File does not exist");
        const read = readJsonSafe(p.targetPath);
        if (!read.ok) return diagnoseResult(ID, p.targetPath, false, "Error reading JSON");
        return diagnoseResult(ID, p.targetPath, hasNestedHooks(read.data));
      },
    },
    jsonMcpSource({
      id: ID,
      // user scope lives in ~/.claude.json, project scope in .mcp.json (as written by `claude mcp add`)
      resolvePaths: ({ global, root }) => ({ targetPath: global ? join(homedir(), ".claude.json") : join(root, ".mcp.json") }),
      entryFor: (launch) => ({ type: "stdio", ...launch, env: {} }),
    }),
  ],
  pid: "walk",
  name: { resolve: resolveName, watch: { kind: "transcript-mtime" } },
  end: { signals: ["event", "pid"] },
  fixtures: {
    name: {
      setup(dir) {
        const transcript = join(dir, "claude-transcript.jsonl");
        writeFileSync(
          transcript,
          [
            JSON.stringify({ type: "ai-title", aiTitle: "Auto title" }),
            JSON.stringify({ type: "custom-title", customTitle: "My name" }),
          ].join("\n")
        );
        return { ctx: { sessionId: "claude-fixture", transcript }, expected: "My name" };
      },
    },
    cmdlines: [
      { cmd: "claude.exe --resume", background: false, sharedHost: false },
      { cmd: "claude.exe --fork-session x", background: true, sharedHost: false },
      { cmd: "claude -p do-work", background: true, sharedHost: false },
    ],
  },
};
