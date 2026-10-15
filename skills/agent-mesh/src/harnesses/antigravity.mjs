import { join } from "node:path";
import { agentsPath } from "./shared/agents-dir.mjs";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { readSqliteRow, execSqlite } from "./shared/sqlite.mjs";
import { DEFAULT_TTL_MS, looksInteractive } from "./shared/process.mjs";
import { readJsonSafe, backupOnce, atomicWriteJson, buildHookCommand, diagnoseResult, jsonMcpSource } from "./shared/install.mjs";

const ID = "antigravity";
const BLOCK = "agent-mesh-presence";
const HOOK_EVENTS = ["SessionStart", "PreInvocation", "Stop"];

/** Antigravity conversation summaries DB (MESH_AGY_DB overrides, used by tests). */
const dbPath = () =>
  process.env.MESH_AGY_DB || join(homedir(), ".gemini", "antigravity-cli", "conversation_summaries.db");

/** Conversation title, falling back to the preview. */
function resolveName({ sessionId }) {
  const r = readSqliteRow(
    dbPath(),
    "SELECT title, preview FROM conversation_summaries WHERE conversation_id = ?",
    sessionId
  );
  return r?.title || r?.preview || null;
}

/** agy hooks.json uses one named block with an entry per event; hook commands must not be quoted. */
function install(p, script) {
  const read = readJsonSafe(p.targetPath);
  if (!read.ok) return { ok: false, error: read.error, modified: false };
  const data = read.data;
  backupOnce(p.targetPath);
  data[BLOCK] = Object.fromEntries(
    HOOK_EVENTS.map((event) => [
      event,
      [{ type: "command", command: buildHookCommand(script, ["--event", event]), timeout: 10 }],
    ])
  );
  atomicWriteJson(p.targetPath, data);
  return { ok: true, modified: true };
}

function uninstall(p) {
  const read = readJsonSafe(p.targetPath);
  if (!read.ok) return { ok: false, error: read.error, modified: false };
  if (!read.exists || !read.data[BLOCK]) return { ok: true, modified: false };
  delete read.data[BLOCK];
  atomicWriteJson(p.targetPath, read.data);
  return { ok: true, modified: true };
}

function diagnose(p) {
  if (!existsSync(p.targetPath)) return diagnoseResult(ID, p.targetPath, false, "File does not exist");
  const read = readJsonSafe(p.targetPath);
  if (!read.ok) return diagnoseResult(ID, p.targetPath, false, "Error reading JSON");
  return diagnoseResult(ID, p.targetPath, Boolean(read.data[BLOCK]));
}

/** @type {import("./index.mjs").Harness} */
export default {
  id: ID,
  aliases: ["agy", "gemini"],
  displayName: "Antigravity",
  discovery: {
    binaries: ["agy"],
    markers: (root) => [join(homedir(), ".gemini"), join(homedir(), ".antigravity"), join(root, ".agents")],
    skillDir: () => join(homedir(), ".gemini", "config", "skills", "agent-mesh"),
    projectDir: ".agents",
  },
  agents: { skills: "project", config: true, evidence: "binary", note: "{workspace}/.agents/skills and .agents/hooks.json" },
  presence: [
    {
      kind: "hook",
      script: "agy-presence-hook.mjs",
      resolvePaths: ({ global, root }) => ({
        targetPath: global ? join(homedir(), ".gemini", "config", "hooks.json") : agentsPath("project", root, "hooks.json"),
      }),
      install,
      uninstall,
      diagnose,
    },
    jsonMcpSource({
      id: ID,
      // global path as written by `agy mcp add`; the project path is unverified
      resolvePaths: ({ global, root }) => ({
        targetPath: global ? join(homedir(), ".gemini", "config", "mcp_config.json") : agentsPath("project", root, "mcp_config.json"),
      }),
      entryFor: (launch) => ({ ...launch, disabled: false }),
    }),
  ],
  pid: "walk",
  // How the session shows that it is on the mesh (badge at session start; see presence/identity.mjs).
  ui: { identity: { channel: "hook-output", sessionStart: "inject-steps" } /* model-visible only: SessionStart injectSteps */ },
  // Mail reaches a running session at invocation,turn-end; an IDLE TUI cannot be woken (toast only).
  delivery: {
    via: "hook",
    inject: ["invocation", "turn-end"],
    idle: "toast-only",
    // agy hooks only run inside a turn (PreInvocation/Stop); no push channel or background-command wake was found
    // (hook contract in the binary: command hooks are synchronous and block the loop). Stays at pull + toast.
    wake: { tier: "pull", launcher: "hook", survivesTurnEnd: false, needsPermission: false },
  },
  name: { resolve: resolveName, watch: { kind: "sqlite-poll" } },
  // agy has no SessionEnd hook: the exit is noticed by the pid watcher (or the TTL when no pid resolved).
  end: { signals: ["pid", "ttl"], ttlMs: DEFAULT_TTL_MS },
  process: { exe: ["agy"], isInteractiveTui: looksInteractive },
  fixtures: {
    name: {
      setup(dir) {
        const path = join(dir, "agy-summaries.db");
        execSqlite(
          path,
          "CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '', preview text NOT NULL DEFAULT '', status text NOT NULL DEFAULT '', last_modified_time text);" +
            "INSERT INTO conversation_summaries (conversation_id, title, preview) VALUES ('agy-fixture','','Only preview');"
        );
        process.env.MESH_AGY_DB = path;
        return { ctx: { sessionId: "agy-fixture" }, expected: "Only preview" };
      },
    },
    tui: {
      interactive: ['"C:/x/agy.exe"'],
      background: ['"C:/x/agy.exe" -p "do work"', "agy.exe --headless"],
    },
  },
};
