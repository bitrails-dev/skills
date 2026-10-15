import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import {
  MESH_HOOK_MATCHER,
  readJsonSafe,
  backupOnce,
  atomicWriteJson,
  writeLoader,
  removeFile,
  diagnoseResult,
  jsonMcpSource,
} from "./shared/install.mjs";

const ID = "opencode";

const entryString = (p) => (typeof p === "string" ? p : Array.isArray(p) ? p[0] : "");
const isMeshEntry = (p) => MESH_HOOK_MATCHER.test(entryString(p));

/** Writes the plugin loader file and registers it in opencode.json `plugin` (idempotent). */
function install(p, script) {
  writeLoader(p.loaderPath, script, "Agent Mesh presence plugin for OpenCode", true);

  const read = readJsonSafe(p.targetPath);
  if (!read.ok) return { ok: false, error: read.error, modified: false };
  const data = read.data;
  data.plugin ??= [];
  if (!Array.isArray(data.plugin)) data.plugin = [data.plugin].filter(Boolean);

  const loader = p.loaderPath.replace(/\\/g, "/");
  const idx = data.plugin.findIndex(isMeshEntry);
  let modified = false;
  if (idx === -1) {
    data.plugin.push(loader);
    modified = true;
  } else if (data.plugin[idx] !== loader) {
    data.plugin[idx] = loader;
    modified = true;
  }
  if (modified) {
    backupOnce(p.targetPath);
    atomicWriteJson(p.targetPath, data);
  }
  return { ok: true, modified: true };
}

function uninstall(p) {
  let modified = false;
  const read = readJsonSafe(p.targetPath);
  if (read.exists && read.ok && Array.isArray(read.data.plugin)) {
    const before = read.data.plugin.length;
    read.data.plugin = read.data.plugin.filter((e) => !isMeshEntry(e));
    if (read.data.plugin.length !== before) {
      atomicWriteJson(p.targetPath, read.data);
      modified = true;
    }
  }
  if (removeFile(p.loaderPath)) modified = true;
  return { ok: true, modified };
}

function diagnose(p) {
  const loaderExists = existsSync(p.loaderPath);
  if (!existsSync(p.targetPath) && !loaderExists) return diagnoseResult(ID, p.targetPath, false, "File does not exist");
  const read = readJsonSafe(p.targetPath);
  if (!read.ok) return diagnoseResult(ID, p.targetPath, false, "Error reading JSON");
  const inConfig = Array.isArray(read.data.plugin) && read.data.plugin.some(isMeshEntry);
  return diagnoseResult(ID, p.targetPath, inConfig || loaderExists);
}

/** @type {import("./index.mjs").Harness} */
export default {
  id: ID,
  aliases: [],
  displayName: "OpenCode",
  discovery: {
    binaries: ["opencode"],
    markers: (root) => [join(homedir(), ".config", "opencode"), join(homedir(), ".opencode"), join(root, ".opencode")],
    projectDir: ".opencode",
  },
  presence: [
    {
      kind: "plugin",
      script: "opencode-presence-plugin.mjs",
      resolvePaths: ({ global, root }) => {
        // the OpenCode CLI/TUI reads ~/.config on every OS (incl. Windows)
        const base = global ? join(homedir(), ".config", "opencode") : join(root, ".opencode");
        return { targetPath: join(base, "opencode.json"), loaderPath: join(base, "plugins", "agent-mesh-presence.js") };
      },
      install,
      uninstall,
      diagnose,
    },
    jsonMcpSource({
      id: ID,
      key: "mcp",
      resolvePaths: ({ global, root }) => {
        const base = global ? join(homedir(), ".config", "opencode") : join(root, ".opencode");
        return { targetPath: join(base, "opencode.json") };
      },
      entryFor: ({ command, args }) => ({ type: "local", command: [command, ...args], enabled: true }),
    }),
  ],
  pid: "direct", // the plugin runs inside the harness: process.pid is the harness
  name: { watch: { kind: "event" } }, // session.updated -> rename event
  end: { signals: ["event", "pid"] }, // session.deleted / server.instance.disposed
  fixtures: {},
};
