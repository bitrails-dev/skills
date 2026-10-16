/**
 * @file install.mjs
 * @description Config-file helpers shared by every harness descriptor's install/uninstall/diagnose:
 * safe JSON IO, backups, hook command quoting, and the standard `hooks.<Event>[].hooks[]` merge.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { guardWrite } from "./home-guard.mjs";
import { atomicWriteText } from "./fs-atomic.mjs";

/** Directory holding the hook/plugin entry scripts descriptors reference by file name. */
export const HOOKS_DIR = resolve(import.meta.dirname, "..", "..", "hooks");

/** Regex matching any agent-mesh hook script invocation (including legacy names). */
export const MESH_HOOK_MATCHER = /(?:agy-)?presence-hook\.mjs|stop-hook\.mjs|opencode-presence-plugin|pi-presence-extension|agent-mesh-presence/;

/** Checks if a command-line binary is discoverable in PATH. */
export function isCommandAvailable(bin) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Safely reads and parses a JSON file.
 * Returns { ok: false } if the file exists but has invalid JSON, preventing accidental overwrites.
 * @param {string} filePath
 * @returns {{ ok: boolean, data?: object, exists: boolean, error?: string }}
 */
export function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return { ok: true, data: {}, exists: false };
  try {
    return { ok: true, data: JSON.parse(readFileSync(filePath, "utf8")), exists: true };
  } catch (err) {
    return { ok: false, exists: true, error: `Invalid JSON in ${filePath}: ${err.message}` };
  }
}

/** Creates a .bak backup of the file before any modifying write (overwrites the previous .bak). */
export function backupOnce(filePath) {
  guardWrite(filePath);
  if (existsSync(filePath)) {
    try {
      copyFileSync(filePath, `${filePath}.bak`);
    } catch {}
  }
}

/** Atomically writes a JSON object to disk via a temporary file and rename. */
export function atomicWriteJson(filePath, data) {
  atomicWriteText(filePath, `${JSON.stringify(data, null, 2)}\n`); // backs up the pre-change file when it differs
}

/**
 * Builds a cross-platform executable hook command with forward slashes.
 * Forward slashes survive cmd.exe, PowerShell, and bash without escaping errors.
 * @param {string} scriptAbsPath
 * @param {string[]} [extraArgs=[]] e.g. ['--harness', 'codex']
 * @returns {string}
 */
export function buildHookCommand(scriptAbsPath, extraArgs = []) {
  const normalized = scriptAbsPath.replace(/\\/g, "/");
  const argsStr = extraArgs.length > 0 ? " " + extraArgs.join(" ") : "";
  // agy's hook runner mangles double-quoted paths (joins them onto its config dir), so only quote
  // when the path actually contains whitespace.
  const script = /\s/.test(normalized) ? `"${normalized}"` : normalized;
  return `node ${script}${argsStr}`;
}

const MESH_HOOKS_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"];

/**
 * Idempotently merges mesh presence hooks into a `{ hooks: { <Event>: [{ hooks: [{type,command}] }] } }`
 * JSON file (Claude settings.json, Codex hooks.json).
 * @param {string} filePath
 * @param {string} scriptAbsPath
 * @param {string[]} [extraArgs]
 * @returns {{ ok: boolean, error?: string, modified: boolean }}
 */
export function installNestedHooks(filePath, scriptAbsPath, extraArgs = []) {
  const read = readJsonSafe(filePath);
  if (!read.ok) return { ok: false, error: read.error, modified: false };

  const data = read.data;
  data.hooks ??= {};
  const command = buildHookCommand(scriptAbsPath, extraArgs);
  let modified = false;

  for (const event of MESH_HOOKS_EVENTS) {
    data.hooks[event] ??= [];
    const groups = data.hooks[event];
    let found = false;
    for (const group of groups) {
      for (const h of Array.isArray(group.hooks) ? group.hooks : []) {
        if (typeof h.command === "string" && MESH_HOOK_MATCHER.test(h.command)) {
          if (h.command !== command) {
            h.command = command;
            modified = true;
          }
          found = true;
        }
      }
    }
    if (!found) {
      groups.push({ hooks: [{ type: "command", command }] });
      modified = true;
    }
  }

  if (modified) {
    backupOnce(filePath);
    atomicWriteJson(filePath, data);
  }
  return { ok: true, modified };
}

/** Removes mesh hooks from a nested-hooks JSON file, pruning emptied groups and events. */
export function uninstallNestedHooks(filePath) {
  const read = readJsonSafe(filePath);
  if (!read.ok) return { ok: false, error: read.error, modified: false };
  if (!read.exists) return { ok: true, modified: false };

  const data = read.data;
  if (!data.hooks || typeof data.hooks !== "object") return { ok: true, modified: false };

  let modified = false;
  for (const [event, groups] of Object.entries(data.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group.hooks)) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((h) => !MESH_HOOK_MATCHER.test(h.command || ""));
      if (group.hooks.length !== before) modified = true;
    }
    const before = groups.length;
    data.hooks[event] = groups.filter((g) => Array.isArray(g.hooks) && g.hooks.length > 0);
    if (data.hooks[event].length !== before) modified = true;
    if (data.hooks[event].length === 0) {
      delete data.hooks[event];
      modified = true;
    }
  }

  if (modified) atomicWriteJson(filePath, data);
  return { ok: true, modified };
}

/** True when a nested-hooks JSON file contains a mesh hook command. */
export function hasNestedHooks(data) {
  return Object.values(data.hooks || {}).some((groups) =>
    groups.some((g) => (g.hooks || []).some((h) => MESH_HOOK_MATCHER.test(h.command || "")))
  );
}

/** Writes a tiny ESM loader file that re-exports a plugin/extension script by file URL. */
export function writeLoader(loaderPath, scriptAbsPath, comment, exportsPlugin = false) {
  guardWrite(loaderPath);
  const url = pathToFileURL(scriptAbsPath).href;
  const body = exportsPlugin
    ? `import plugin from "${url}";\nexport default plugin;\nexport { plugin };\n`
    : `import extension from "${url}";\nexport default extension;\n`;
  atomicWriteText(loaderPath, `// ${comment}\n${body}`, { backup: false });
}

/** Deletes a file if present. Returns true when something was removed. */
export function removeFile(filePath) {
  guardWrite(filePath);
  if (!existsSync(filePath)) return false;
  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Standard diagnose result for descriptors. */
export function diagnoseResult(harness, targetPath, installed, status) {
  return { harness, targetPath, status: status ?? (installed ? "Installed (ACTIVE)" : "Not installed"), installed };
}

// ---- MCP server entries (opt-in presence source "mcp") ---------------------------------------------

/** Server name every harness config uses for the agent-mesh shim. */
export const MCP_SERVER_NAME = "agent-mesh";

/** Command + args that launch the shim for a harness. Forward slashes survive every shell. */
export function mcpLaunch(scriptAbsPath, harnessId) {
  return { command: "node", args: [scriptAbsPath.replace(/\\/g, "/"), "--harness", harnessId] };
}

const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);

/**
 * Adds/updates `<key>.agent-mesh` in a JSON config (Claude `.mcp.json`/`~/.claude.json`, Pi `mcp.json`,
 * agy `mcp_config.json`: key `mcpServers`; OpenCode `opencode.json`: key `mcp`). Other entries are kept.
 */
export function installJsonMcp(filePath, key, entry) {
  const read = readJsonSafe(filePath);
  if (!read.ok) return { ok: false, error: read.error, modified: false };
  const data = read.data;
  if (data[key] !== undefined && !isPlainObject(data[key])) {
    return { ok: false, error: `${filePath}: "${key}" is not an object`, modified: false };
  }
  data[key] ??= {};
  if (JSON.stringify(data[key][MCP_SERVER_NAME]) === JSON.stringify(entry)) return { ok: true, modified: false };
  data[key][MCP_SERVER_NAME] = entry;
  backupOnce(filePath);
  atomicWriteJson(filePath, data);
  return { ok: true, modified: true };
}

export function uninstallJsonMcp(filePath, key) {
  const read = readJsonSafe(filePath);
  if (!read.ok) return { ok: false, error: read.error, modified: false };
  if (!read.exists || !isPlainObject(read.data[key]) || !(MCP_SERVER_NAME in read.data[key])) return { ok: true, modified: false };
  delete read.data[key][MCP_SERVER_NAME];
  atomicWriteJson(filePath, read.data);
  return { ok: true, modified: true };
}

export function hasJsonMcp(filePath, key) {
  const read = readJsonSafe(filePath);
  return Boolean(read.ok && isPlainObject(read.data[key]) && MCP_SERVER_NAME in read.data[key]);
}

const TOML_BEGIN = "# agent-mesh:begin";
const TOML_END = "# agent-mesh:end";
// `[mcp_servers.agent-mesh]` and sub-tables such as `[mcp_servers.agent-mesh.env]`
const tomlHeader = /^\[mcp_servers\.(?:"agent-mesh"|agent-mesh)(?:\.[^\]]+)?\]$/;
const tomlMainHeader = /^\[mcp_servers\.(?:"agent-mesh"|agent-mesh)\]$/;

/** Splits text into lines keeping each line's own terminator, so untouched lines are written back byte for byte. */
const toLines = (text) => text.match(/[^\r\n]*(?:\r\n|\n|$)/g).filter((l) => l !== "");
const bare = (line) => line.replace(/\r?\n$/, "").trim();

/**
 * Line ranges [start, end) owned by mesh: the marker block, and any `[mcp_servers.agent-mesh*]` tables
 * (e.g. added by `codex mcp add`) up to the next table header.
 */
function managedRanges(lines) {
  const ranges = [];
  for (let i = 0; i < lines.length; ) {
    const t = bare(lines[i]);
    if (t === TOML_BEGIN) {
      let j = i + 1;
      while (j < lines.length && bare(lines[j]) !== TOML_END) j++;
      ranges.push([i, Math.min(j + 1, lines.length)]);
      i = j + 1;
    } else if (tomlHeader.test(t)) {
      let j = i + 1;
      while (j < lines.length && !/^\s*\[/.test(lines[j]) && bare(lines[j]) !== TOML_BEGIN) j++;
      ranges.push([i, j]);
      i = j;
    } else {
      i++;
    }
  }
  return ranges;
}

const tomlStr = (v) => JSON.stringify(v);
const detectEol = (text) => (/\r\n/.test(text) ? "\r\n" : "\n");

/** Codex config.toml: managed `[mcp_servers.agent-mesh]` block between marker comments (no TOML parser). */
export function installTomlMcp(filePath, { command, args }) {
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const eol = detectEol(existing);
  const block = [
    TOML_BEGIN,
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${tomlStr(command)}`,
    `args = [${args.map(tomlStr).join(", ")}]`,
    TOML_END,
  ].map((l) => l + eol);
  const lines = existing ? toLines(existing) : [];
  const ranges = managedRanges(lines);
  let out;
  if (ranges.length) {
    // replace the first managed range in place, drop any further ones
    out = [];
    let placed = false;
    for (let i = 0; i < lines.length; i++) {
      const r = ranges.find(([s0, e0]) => i >= s0 && i < e0);
      if (!r) out.push(lines[i]);
      else if (!placed) {
        out.push(...block);
        placed = true;
        i = r[1] - 1;
      } else i = r[1] - 1;
    }
  } else {
    out = [...lines];
    if (out.length && !/\n$/.test(out[out.length - 1])) out[out.length - 1] += eol;
    if (out.length && bare(out[out.length - 1]) !== "") out.push(eol);
    out.push(...block);
  }
  const next = out.join("");
  if (next === existing) return { ok: true, modified: false };
  atomicWriteText(filePath, next);
  return { ok: true, modified: true };
}

/** Removes only the managed lines. No managed entry: no write, no backup. Other bytes (EOLs, blanks) untouched. */
export function uninstallTomlMcp(filePath) {
  if (!existsSync(filePath)) return { ok: true, modified: false };
  const existing = readFileSync(filePath, "utf8");
  const lines = toLines(existing);
  const ranges = managedRanges(lines);
  if (ranges.length === 0) return { ok: true, modified: false };
  const kept = lines.filter((_, i) => !ranges.some(([s0, e0]) => i >= s0 && i < e0));
  atomicWriteText(filePath, kept.join(""));
  return { ok: true, modified: true };
}

export function hasTomlMcp(filePath) {
  if (!existsSync(filePath)) return false;
  return toLines(readFileSync(filePath, "utf8")).some((l) => tomlMainHeader.test(bare(l)));
}

const MCP_SCRIPT = "../mcp/mesh-mcp.mjs"; // relative to src/hooks (see HOOKS_DIR)

/** Opt-in `mcp` presence source for harnesses configured through a JSON file. */
export function jsonMcpSource({ id, resolvePaths, key = "mcpServers", entryFor = (launch) => launch, announce = true }) {
  return {
    kind: "mcp",
    optIn: true,
    announce,
    script: MCP_SCRIPT,
    resolvePaths,
    install: (p, script) => installJsonMcp(p.targetPath, key, entryFor(mcpLaunch(script, id))),
    uninstall: (p) => uninstallJsonMcp(p.targetPath, key),
    diagnose: (p) => diagnoseResult(id, p.targetPath, hasJsonMcp(p.targetPath, key)),
  };
}

/** Opt-in `mcp` presence source for Codex (`config.toml` managed block). */
export function tomlMcpSource({ id, resolvePaths, announce = true }) {
  return {
    kind: "mcp",
    optIn: true,
    announce,
    script: MCP_SCRIPT,
    resolvePaths,
    install: (p, script) => installTomlMcp(p.targetPath, mcpLaunch(script, id)),
    uninstall: (p) => uninstallTomlMcp(p.targetPath),
    diagnose: (p) => diagnoseResult(id, p.targetPath, hasTomlMcp(p.targetPath)),
  };
}

// ---- opt-in wake hooks (presence source "wake") ---------------------------------------------------------

const WAKE_HOOK_MARK = "mesh-wake-hook.mjs";

const isWakeHook = (h) => typeof h?.command === "string" && h.command.includes(WAKE_HOOK_MARK);

/**
 * Adds async re-waking command hooks (Claude `asyncRewake`: exit code 2 wakes the model) that run
 * `mesh-wake-hook.mjs`. Distinct from the presence hooks: they are only installed on request and removed by
 * uninstall; `MESH_HOOK_MATCHER` deliberately does not match them.
 */
export function installNestedWakeHooks(filePath, scriptAbsPath, { events = ["SessionStart", "Stop"], timeoutSec = 86400 } = {}) {
  const read = readJsonSafe(filePath);
  if (!read.ok) return { ok: false, error: read.error, modified: false };
  const data = read.data;
  data.hooks ??= {};
  const entry = {
    type: "command",
    command: buildHookCommand(scriptAbsPath),
    async: true,
    asyncRewake: true,
    timeout: timeoutSec,
    rewakeSummary: "Agent mesh message waiting",
  };
  let modified = false;
  for (const event of events) {
    data.hooks[event] ??= [];
    const existing = data.hooks[event].flatMap((g) => (Array.isArray(g.hooks) ? g.hooks : [])).find(isWakeHook);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(entry)) {
        Object.assign(existing, entry);
        modified = true;
      }
    } else {
      data.hooks[event].push({ hooks: [{ ...entry }] });
      modified = true;
    }
  }
  if (modified) {
    backupOnce(filePath);
    atomicWriteJson(filePath, data);
  }
  return { ok: true, modified };
}

export function uninstallNestedWakeHooks(filePath) {
  const read = readJsonSafe(filePath);
  if (!read.ok) return { ok: false, error: read.error, modified: false };
  if (!read.exists || !read.data.hooks || typeof read.data.hooks !== "object") return { ok: true, modified: false };
  let modified = false;
  for (const [event, groups] of Object.entries(read.data.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!Array.isArray(g.hooks)) continue;
      const before = g.hooks.length;
      g.hooks = g.hooks.filter((h) => !isWakeHook(h));
      if (g.hooks.length !== before) modified = true;
    }
    read.data.hooks[event] = groups.filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
    if (read.data.hooks[event].length === 0) delete read.data.hooks[event];
  }
  if (modified) atomicWriteJson(filePath, read.data);
  return { ok: true, modified };
}

export function hasNestedWakeHooks(filePath) {
  const read = readJsonSafe(filePath);
  return Boolean(
    read.ok && Object.values(read.data.hooks || {}).some((gs) => Array.isArray(gs) && gs.some((g) => (g.hooks || []).some(isWakeHook)))
  );
}

/** Opt-in `wake` presence source for harnesses whose hooks can run an async re-waking command. */
export function wakeHookSource({ id, resolvePaths, events, timeoutSec }) {
  return {
    kind: "wake",
    optIn: true,
    script: WAKE_HOOK_MARK,
    resolvePaths,
    install: (p, script) => installNestedWakeHooks(p.targetPath, script, { events, timeoutSec }),
    uninstall: (p) => uninstallNestedWakeHooks(p.targetPath),
    diagnose: (p) => diagnoseResult(id, p.targetPath, hasNestedWakeHooks(p.targetPath)),
  };
}
