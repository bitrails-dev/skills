/**
 * @file installer.mjs
 * @description Idempotent lifecycle hook installer and uninstaller for Claude Code and Antigravity (agy).
 * Safely merges presence hook definitions with backup (.bak) creation, atomic writes,
 * and clean isolation from foreign user hooks.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { buildHookCommand, MESH_HOOK_MATCHER } from "./common.mjs";

/**
 * Safely reads and parses a JSON file.
 * Returns { ok: false } if the file exists but has invalid JSON, preventing accidental overwrites.
 * @param {string} filePath
 * @returns {{ ok: boolean, data?: object, exists: boolean, error?: string }}
 */
export function readJsonSafe(filePath) {
  if (!existsSync(filePath)) {
    return { ok: true, data: {}, exists: false };
  }
  try {
    const raw = readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    return { ok: true, data, exists: true };
  } catch (err) {
    return { ok: false, exists: true, error: `Invalid JSON in ${filePath}: ${err.message}` };
  }
}

/**
 * Creates a .bak backup of the file before any modifying write.
 * Overwrites previous .bak to preserve the freshest pre-install state.
 * @param {string} filePath
 */
export function backupOnce(filePath) {
  if (existsSync(filePath)) {
    try {
      copyFileSync(filePath, `${filePath}.bak`);
    } catch {}
  }
}

/**
 * Atomically writes a JSON object to disk via a temporary file and rename.
 * @param {string} filePath
 * @param {object} data
 */
export function atomicWriteJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
}

/**
 * Installs Claude Code lifecycle presence hooks idempotently into settings.json.
 * @param {string} settingsPath - Path to settings.json.
 * @param {string} scriptAbsPath - Absolute path to presence-hook.mjs.
 * @returns {{ ok: boolean, error?: string, modified: boolean }}
 */
export function installClaudeHooks(settingsPath, scriptAbsPath) {
  const read = readJsonSafe(settingsPath);
  if (!read.ok) {
    return { ok: false, error: read.error, modified: false };
  }

  const settings = read.data;
  settings.hooks ??= {};

  const command = buildHookCommand(scriptAbsPath);
  const events = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"];
  let modified = false;

  for (const event of events) {
    settings.hooks[event] ??= [];
    const groups = settings.hooks[event];

    let found = false;
    for (const group of groups) {
      if (Array.isArray(group.hooks)) {
        for (const h of group.hooks) {
          if (typeof h.command === "string" && MESH_HOOK_MATCHER.test(h.command)) {
            if (h.command !== command) {
              h.command = command;
              modified = true;
            }
            found = true;
          }
        }
      }
    }

    if (!found) {
      groups.push({
        hooks: [{ type: "command", command }],
      });
      modified = true;
    }
  }

  if (modified) {
    backupOnce(settingsPath);
    atomicWriteJson(settingsPath, settings);
  }

  return { ok: true, modified };
}

/**
 * Removes agent-mesh hooks from Claude Code settings.json.
 * @param {string} settingsPath
 * @returns {{ ok: boolean, error?: string, modified: boolean }}
 */
export function uninstallClaudeHooks(settingsPath) {
  const read = readJsonSafe(settingsPath);
  if (!read.ok) {
    return { ok: false, error: read.error, modified: false };
  }
  if (!read.exists) {
    return { ok: true, modified: false };
  }

  const settings = read.data;
  if (!settings.hooks || typeof settings.hooks !== "object") {
    return { ok: true, modified: false };
  }

  let modified = false;

  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;

    for (const group of groups) {
      if (Array.isArray(group.hooks)) {
        const initialCount = group.hooks.length;
        group.hooks = group.hooks.filter((h) => !MESH_HOOK_MATCHER.test(h.command || ""));
        if (group.hooks.length !== initialCount) {
          modified = true;
        }
      }
    }

    // Filter out groups left with zero hooks
    const initialGroupsCount = groups.length;
    settings.hooks[event] = groups.filter((g) => Array.isArray(g.hooks) && g.hooks.length > 0);
    if (settings.hooks[event].length !== initialGroupsCount) {
      modified = true;
    }

    // If event is completely empty, remove event key
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
      modified = true;
    }
  }

  if (modified) {
    atomicWriteJson(settingsPath, settings);
  }

  return { ok: true, modified };
}

/**
 * Installs Antigravity (agy) presence hooks into hooks.json using its named-block schema.
 * @param {string} hooksJsonPath - Path to Antigravity hooks.json.
 * @param {string} scriptAbsPath - Absolute path to agy-presence-hook.mjs.
 * @returns {{ ok: boolean, error?: string, modified: boolean }}
 */
export function installAgyHooks(hooksJsonPath, scriptAbsPath) {
  const read = readJsonSafe(hooksJsonPath);
  if (!read.ok) {
    return { ok: false, error: read.error, modified: false };
  }

  const data = read.data;
  const command = buildHookCommand(scriptAbsPath);

  backupOnce(hooksJsonPath);

  data["agent-mesh-presence"] = {
    PreInvocation: [
      {
        type: "command",
        command,
        timeout: 10,
      },
    ],
    Stop: [
      {
        type: "command",
        command,
        timeout: 10,
      },
    ],
  };

  atomicWriteJson(hooksJsonPath, data);
  return { ok: true, modified: true };
}

/**
 * Removes agent-mesh named block from Antigravity hooks.json.
 * @param {string} hooksJsonPath
 * @returns {{ ok: boolean, error?: string, modified: boolean }}
 */
export function uninstallAgyHooks(hooksJsonPath) {
  const read = readJsonSafe(hooksJsonPath);
  if (!read.ok) {
    return { ok: false, error: read.error, modified: false };
  }
  if (!read.exists) {
    return { ok: true, modified: false };
  }

  const data = read.data;
  if (!data["agent-mesh-presence"]) {
    return { ok: true, modified: false };
  }

  delete data["agent-mesh-presence"];
  atomicWriteJson(hooksJsonPath, data);
  return { ok: true, modified: true };
}

/**
 * Resolves default target configuration paths for Claude and Antigravity.
 * @param {{ global?: boolean, project?: boolean, harness?: string }} options
 * @param {string} [rootDir=process.cwd()]
 * @returns {{ claudePath: string, agyPath: string, scope: string }}
 */
export function resolveHookTargets(options = {}, rootDir = process.cwd()) {
  const isGlobal = Boolean(options.global);
  const scope = isGlobal ? "global" : "project";

  const claudePath = isGlobal
    ? join(homedir(), ".claude", "settings.json")
    : join(rootDir, ".claude", "settings.json");

  const agyPath = isGlobal
    ? join(homedir(), ".gemini", "config", "hooks.json")
    : join(rootDir, ".agents", "hooks.json");

  return { claudePath, agyPath, scope };
}
