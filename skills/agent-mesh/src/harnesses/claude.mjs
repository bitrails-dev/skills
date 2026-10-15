import { join, dirname, basename } from "node:path";
import { execFileSync } from "node:child_process";
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
  mcpLaunch,
  isCommandAvailable,
  MCP_SERVER_NAME,
  hasJsonMcp,
} from "./shared/install.mjs";

const ID = "claude";

/**
 * User-scope MCP lives in ~/.claude.json, which running Claude sessions rewrite constantly. Prefer the
 * `claude mcp` CLI (it merges safely) when it is on PATH; HOME/USERPROFILE point at the file's directory so
 * the CLI edits exactly the file we were asked to manage. Project scope (.mcp.json) is edited directly.
 */
const useClaudeCli = (p) => basename(p.targetPath) === ".claude.json" && isCommandAvailable("claude");
const runClaudeCli = (p, args) => {
  const home = dirname(p.targetPath);
  execFileSync("claude", ["mcp", ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: "ignore",
    timeout: 20000,
    windowsHide: true,
  });
};

const mcpSource = jsonMcpSource({
  id: ID,
  // user scope lives in ~/.claude.json, project scope in .mcp.json (as written by `claude mcp add`)
  resolvePaths: ({ global, root }) => ({ targetPath: global ? join(homedir(), ".claude.json") : join(root, ".mcp.json") }),
  entryFor: (launch) => ({ type: "stdio", ...launch, env: {} }),
});
const fileInstall = mcpSource.install;
const fileUninstall = mcpSource.uninstall;
mcpSource.install = (p, script) => {
  if (useClaudeCli(p)) {
    try {
      const launch = mcpLaunch(script, ID);
      const read = readJsonSafe(p.targetPath);
      const current = read.ok ? read.data.mcpServers?.[MCP_SERVER_NAME] : null;
      if (current && current.command === launch.command && JSON.stringify(current.args) === JSON.stringify(launch.args)) {
        return { ok: true, modified: false };
      }
      try { runClaudeCli(p, ["remove", "--scope", "user", MCP_SERVER_NAME]); } catch {}
      runClaudeCli(p, ["add", "--scope", "user", MCP_SERVER_NAME, "--", launch.command, ...launch.args]);
      if (hasJsonMcp(p.targetPath, "mcpServers")) return { ok: true, modified: true };
    } catch {}
  }
  return fileInstall(p, script); // CLI missing or failed: direct edit with .bak
};
mcpSource.uninstall = (p) => {
  if (useClaudeCli(p) && hasJsonMcp(p.targetPath, "mcpServers")) {
    try {
      runClaudeCli(p, ["remove", "--scope", "user", MCP_SERVER_NAME]);
      if (!hasJsonMcp(p.targetPath, "mcpServers")) return { ok: true, modified: true };
    } catch {}
  }
  return fileUninstall(p);
};

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
    mcpSource,
  ],
  pid: "walk",
  // Mail reaches a running session at prompt,turn-end; an IDLE TUI cannot be woken (toast only).
  delivery: { via: "hook", inject: ["prompt", "turn-end"], idle: "toast-only" },
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
