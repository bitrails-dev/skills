import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { readSqliteRow, execSqlite } from "./shared/sqlite.mjs";
import { tailText } from "./shared/transcript.mjs";
import { DEFAULT_TTL_MS, looksInteractive } from "./shared/process.mjs";
import {
  readJsonSafe,
  installNestedHooks,
  uninstallNestedHooks,
  hasNestedHooks,
  diagnoseResult,
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
  ],
  // Hooks run inside the shared `codex app-server` daemon: the default classifier reports that as
  // shared-host (no pid), and the scanner supplies the TUI pid instead.
  pid: "walk",
  name: { resolve: resolveName, watch: { kind: "sqlite-poll" } },
  pollSession,
  end: { signals: ["event", "pid", "ttl"], ttlMs: DEFAULT_TTL_MS },
  process: { exe: ["codex"], isInteractiveTui: looksInteractive },
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
      interactive: ['"C:/x/codex.exe"', "codex resume abc"],
      background: ['"codex.exe" app-server --listen unix:// --managed-daemon', "codex exec do-work", "codex mcp-server"],
    },
    cmdlines: [
      { cmd: '"codex.exe" app-server --managed-daemon', background: false, sharedHost: true },
      { cmd: '"C:/x/codex.exe"', background: false, sharedHost: false },
    ],
  },
};
