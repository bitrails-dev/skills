import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { readSqliteRow, execSqlite } from "./shared/sqlite.mjs";
import { tailText } from "./shared/transcript.mjs";
import { DEFAULT_TTL_MS, classifyCmdline } from "./shared/process.mjs";
import {
  readJsonSafe,
  installNestedHooks,
  uninstallNestedHooks,
  hasNestedHooks,
  diagnoseResult,
  tomlMcpSource,
} from "./shared/install.mjs";

const ID = "codex";

/** Codex thread state DB (MESH_CODEX_DB overrides, used by tests). */
const dbPath = () => process.env.MESH_CODEX_DB || join(homedir(), ".codex", "state_5.sqlite");

/** Codex thread row from state_5.sqlite (name column, then title), or null. */
function readThread(threadId) {
  const r = readSqliteRow(
    dbPath(),
    "SELECT name, title, updated_at_ms, updated_at, archived FROM threads WHERE id = ?",
    threadId
  );
  return r ? { ...r, name: r.name || r.title || null } : null;
}

/** session_index.jsonl (last matching thread_name) first, then the threads table. */
function resolveName({ sessionId }) {
  const idx = join(homedir(), ".codex", "session_index.jsonl");
  if (existsSync(idx)) {
    let name = null;
    for (const line of tailText(idx, 256 * 1024).split("\n")) {
      if (line.includes(sessionId)) name = JSON.parse(line).thread_name || name;
    }
    if (name) return name;
  }
  return readThread(sessionId)?.name || null;
}

/** Read-only thread poll: archived threads end the session; thread activity keeps the TTL alive. */
function pollSession(row) {
  const t = readThread(row.session_id);
  if (!t) return null;
  return {
    archived: Boolean(t.archived),
    activityMs: Number(t.updated_at_ms) || (Number(t.updated_at) || 0) * 1000,
  };
}

// Global flags that consume the next token (`codex --help`); everything else starting with "-" is a switch.
const VALUE_FLAGS = new Set([
  "-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env", "-i", "--image", "-m", "--model",
  "--local-provider", "-p", "--profile", "-s", "--sandbox", "-C", "--cd", "--add-dir", "-a", "--ask-for-approval",
]);
// Subcommands that never host an interactive session (daemon, helpers, one-shot management commands).
const NON_SESSION_SUBCOMMANDS = new Set([
  "exec", "e", "review", "login", "logout", "mcp", "mcp-server", "plugin", "app-server", "remote-control", "app",
  "completion", "update", "doctor", "sandbox", "debug", "apply", "a", "queue", "archive", "delete", "unarchive",
  "migrate-rollouts", "features", "exec-server", "cloud", "help",
]);
// Non-interactive runs whose hooks still fire in-process: not a user terminal (like claude -p).
const HEADLESS_RUN_SUBCOMMANDS = new Set(["exec", "e", "review"]);

/**
 * First positional token of a codex command line (subcommand or prompt), or null. null also for
 * --help/--version, which exit immediately. Windows paths and quoted tokens are handled.
 */
function firstPositional(cmdline) {
  const toks = String(cmdline || "").match(/"[^"]*"|\S+/g)?.map((t) => t.replace(/^"|"$/g, "")) ?? [];
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    if (["-h", "--help", "-V", "--version"].includes(t)) return { exits: true };
    if (!t.startsWith("-")) return { token: t.toLowerCase() };
    if (VALUE_FLAGS.has(t)) i++;
  }
  return {};
}

/** Interactive TUI = a codex.exe with no non-session subcommand (bare, resume, fork, agents, or a prompt). */
function isInteractiveTui(cmdline) {
  if (!cmdline) return false;
  const p = firstPositional(cmdline);
  return !p.exits && !NON_SESSION_SUBCOMMANDS.has(p.token);
}

/** Default classification plus `codex exec`/`review` as background (they run hooks in their own process). */
function classifyProcess(cmdline) {
  const cls = classifyCmdline(cmdline);
  return { ...cls, background: cls.background || HEADLESS_RUN_SUBCOMMANDS.has(firstPositional(cmdline).token) };
}

/** @type {import("./index.mjs").Harness} */
export default {
  id: ID,
  aliases: ["openai-codex"],
  displayName: "OpenAI Codex",
  discovery: {
    binaries: ["codex"],
    markers: (root) => [join(homedir(), ".codex"), join(root, ".codex")],
    skillDir: () => join(homedir(), ".codex", "skills", "agent-mesh"),
    projectDir: ".codex",
  },
  presence: [
    {
      kind: "hook",
      script: "presence-hook.mjs",
      resolvePaths: ({ global, root }) => ({
        targetPath: global ? join(homedir(), ".codex", "hooks.json") : join(root, ".codex", "hooks.json"),
      }),
      install: (p, script) => installNestedHooks(p.targetPath, script, ["--harness", "codex"]),
      uninstall: (p) => uninstallNestedHooks(p.targetPath),
      diagnose(p) {
        if (!existsSync(p.targetPath)) return diagnoseResult(ID, p.targetPath, false, "File does not exist");
        const read = readJsonSafe(p.targetPath);
        if (!read.ok) return diagnoseResult(ID, p.targetPath, false, "Error reading JSON");
        return diagnoseResult(ID, p.targetPath, hasNestedHooks(read.data));
      },
    },
    // MCP servers are spawned per thread by the shared daemon (parent = daemon, not the TUI): tools only,
    // no presence announcement (hooks + scanner own presence).
    tomlMcpSource({
      id: ID,
      announce: false,
      resolvePaths: ({ global, root }) => ({
        targetPath: global ? join(homedir(), ".codex", "config.toml") : join(root, ".codex", "config.toml"),
      }),
    }),
  ],
  // Hooks run inside the shared `codex app-server` daemon: the default classifier reports that as
  // shared-host (no pid), and the scanner supplies the TUI pid instead.
  pid: "walk",
  classifyProcess,
  name: { resolve: resolveName, watch: { kind: "sqlite-poll" } },
  pollSession,
  end: { signals: ["event", "pid", "ttl"], ttlMs: DEFAULT_TTL_MS },
  process: { exe: ["codex"], isInteractiveTui },
  fixtures: {
    name: {
      setup(dir) {
        const path = join(dir, "codex-state.sqlite");
        execSqlite(
          path,
          "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', name TEXT, updated_at INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER, archived INTEGER NOT NULL DEFAULT 0);" +
            "INSERT INTO threads (id, title, name) VALUES ('codex-fixture','a title','a name');"
        );
        process.env.MESH_CODEX_DB = path;
        return { ctx: { sessionId: "codex-fixture" }, expected: "a name" };
      },
    },
    tui: {
      interactive: [
        '"C:/x/codex.exe"',
        "codex resume abc",
        'codex "fix the bug"',
        'codex -c model="o3" -p work resume --last',
        "codex --no-daemon",
        "codex agents",
      ],
      background: [
        '"codex.exe" app-server --listen unix:// --managed-daemon',
        "codex app-server daemon pid-update-loop",
        "codex app-server proxy",
        "codex exec do-work",
        "codex -c a=b exec do-work",
        "codex exec-server",
        "codex mcp-server",
        "codex queue 019 hello",
        "codex doctor",
        "codex --version",
      ],
    },
    cmdlines: [
      { cmd: '"codex.exe" app-server --managed-daemon', background: false, sharedHost: true },
      { cmd: '"C:/x/codex.exe"', background: false, sharedHost: false },
      { cmd: "codex exec --json do-work", background: true, sharedHost: false },
      { cmd: "codex review --uncommitted", background: true, sharedHost: false },
    ],
  },
};
