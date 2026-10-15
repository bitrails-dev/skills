/**
 * @file install.mjs
 * @description Config-file helpers shared by every harness descriptor's install/uninstall/diagnose:
 * safe JSON IO, backups, hook command quoting, and the standard `hooks.<Event>[].hooks[]` merge.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

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
  if (existsSync(filePath)) {
    try {
      copyFileSync(filePath, `${filePath}.bak`);
    } catch {}
  }
}

/** Atomically writes a JSON object to disk via a temporary file and rename. */
export function atomicWriteJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
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
  mkdirSync(dirname(loaderPath), { recursive: true });
  const url = pathToFileURL(scriptAbsPath).href;
  const body = exportsPlugin
    ? `import plugin from "${url}";\nexport default plugin;\nexport { plugin };\n`
    : `import extension from "${url}";\nexport default extension;\n`;
  writeFileSync(loaderPath, `// ${comment}\n${body}`, "utf8");
}

/** Deletes a file if present. Returns true when something was removed. */
export function removeFile(filePath) {
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
