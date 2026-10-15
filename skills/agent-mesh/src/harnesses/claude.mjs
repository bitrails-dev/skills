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
  wakeHookSource,
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
  agents: { skills: "user-import", config: false, evidence: "binary", note: "own ~/.claude/skills (a link to ~/.agents/skills here); ~/.agents/skills is only an import source" },
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
    // Opt-in (`mesh --init claude --wake`): async re-waking hooks that run `mesh wait` and exit 2 on mail.
    wakeHookSource({
      id: ID,
      resolvePaths: ({ global, root }) => ({
        targetPath: global ? join(homedir(), ".claude", "settings.json") : join(root, ".claude", "settings.json"),
      }),
    }),
  ],
  pid: "walk",
  // How the session shows that it is on the mesh (badge at session start; see presence/identity.mjs).
  ui: { identity: { channel: "hook-output", sessionStart: "system-message+context" } },
  // Mail reaches a running session at prompt,turn-end; an IDLE TUI cannot be woken (toast only).
  delivery: {
    via: "hook",
    inject: ["prompt", "turn-end"],
    idle: "toast-only",
    // Active tier is pull. Candidate (opt-in, `mesh --init claude --wake`): an asyncRewake hook running
    // `mesh wait`, which wakes the model when it exits with code 2. Found in the 2.1.300 hook schema; not yet
    // observed waking an idle session (run `mesh probe-wake claude`).
    wake: {
      tier: "pull",
      launcher: "hook",
      survivesTurnEnd: false,
      needsPermission: false,
      candidate: {
        tier: "oneshot",
        launcher: "hook",
        survivesTurnEnd: false,
        needsPermission: false,
        evidence: { version: "claude 2.1.300", date: "2026-10-15", verified: false, basis: "hook schema: asyncRewake (exit code 2 wakes the model)" },
      },
    },
  },
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
