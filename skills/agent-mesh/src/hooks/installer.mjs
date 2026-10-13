/**
 * @file installer.mjs
 * @description Multi-harness lifecycle hook and extension installer/uninstaller for agent-mesh.
 * Supports:
 * - Claude Code (settings.json lifecycle hooks)
 * - Antigravity / agy (~/.gemini/config/hooks.json named-block hooks)
 * - OpenAI Codex (~/.codex/hooks.json lifecycle hooks)
 * - OpenCode (opencode.json plugin array + plugin loader)
 * - Pi Coding Agent (~/.pi/agent/extensions/ presence extension loader)
 *
 * Implements:
 * - Auto-discovery mode: automatically detects installed harnesses with agent-mesh available
 * - Assigned harness mode: accepts targeted harness names (e.g. agy, claude, codex, opencode, pi)
 * - Idempotent merges, automatic backup (.bak) creation, and atomic writes.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildHookCommand, MESH_HOOK_MATCHER } from "./common.mjs";

export const SUPPORTED_HARNESSES = ["claude", "agy", "codex", "opencode", "pi"];

/**
 * Normalizes user-supplied harness aliases into canonical harness keys.
 * @param {string} name
 * @returns {string}
 */
export function normalizeHarnessName(name) {
  const lower = String(name || "").trim().toLowerCase();
  switch (lower) {
    case "agy":
    case "antigravity":
    case "gemini":
      return "agy";
    case "claude":
    case "claude-code":
      return "claude";
    case "codex":
    case "openai-codex":
      return "codex";
    case "opencode":
      return "opencode";
    case "pi":
    case "pi-coding-agent":
      return "pi";
    default:
      return lower;
  }
}

/**
 * Checks if a command-line binary is discoverable in PATH.
 * @param {string} bin
 * @returns {boolean}
 */
export function isCommandAvailable(bin) {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    execFileSync(cmd, [bin], { stdio: "ignore" });
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
  const preCommand = buildHookCommand(scriptAbsPath, ["--event", "PreInvocation"]);
  const stopCommand = buildHookCommand(scriptAbsPath, ["--event", "Stop"]);

  backupOnce(hooksJsonPath);

  data["agent-mesh-presence"] = {
    PreInvocation: [
      {
        type: "command",
        command: preCommand,
        timeout: 10,
      },
    ],
    Stop: [
      {
        type: "command",
        command: stopCommand,
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
 * Installs OpenAI Codex presence hooks into hooks.json.
 * Codex adheres to the standard SessionStart / UserPromptSubmit / Stop / SessionEnd hook format.
 * @param {string} hooksPath
 * @param {string} scriptAbsPath
 * @returns {{ ok: boolean, error?: string, modified: boolean }}
 */
export function installCodexHooks(hooksPath, scriptAbsPath) {
  const read = readJsonSafe(hooksPath);
  if (!read.ok) {
    return { ok: false, error: read.error, modified: false };
  }

  const data = read.data;
  data.hooks ??= {};

  const command = buildHookCommand(scriptAbsPath, ["--harness", "codex"]);
  const events = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"];
  let modified = false;

  for (const event of events) {
    data.hooks[event] ??= [];
    const groups = data.hooks[event];

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
    backupOnce(hooksPath);
    atomicWriteJson(hooksPath, data);
  }

  return { ok: true, modified };
}

/**
 * Removes agent-mesh presence hooks from OpenAI Codex hooks.json.
 * @param {string} hooksPath
 * @returns {{ ok: boolean, error?: string, modified: boolean }}
 */
export function uninstallCodexHooks(hooksPath) {
  return uninstallClaudeHooks(hooksPath);
}

/**
 * Installs OpenCode presence plugin and registers in opencode.json.
 * @param {string} configPath - Path to opencode.json.
 * @param {string} pluginLoaderPath - Path to agent-mesh-presence.js plugin loader.
 * @param {string} pluginScriptAbsPath - Path to opencode-presence-plugin.mjs.
 * @returns {{ ok: boolean, error?: string, modified: boolean }}
 */
export function installOpenCodePlugin(configPath, pluginLoaderPath, pluginScriptAbsPath) {
  // 1. Write the plugin loader adapter
  mkdirSync(dirname(pluginLoaderPath), { recursive: true });
  const fileUrl = pathToFileURL(pluginScriptAbsPath).href;
  const loaderContent = `// Agent Mesh presence plugin for OpenCode\nimport plugin from "${fileUrl}";\nexport default plugin;\nexport { plugin };\n`;
  writeFileSync(pluginLoaderPath, loaderContent, "utf8");

  // 2. Register plugin in opencode.json
  const read = readJsonSafe(configPath);
  if (!read.ok) {
    return { ok: false, error: read.error, modified: false };
  }

  const data = read.data;
  data.plugin ??= [];
  if (!Array.isArray(data.plugin)) {
    data.plugin = [data.plugin].filter(Boolean);
  }

  const normalizedLoader = pluginLoaderPath.replace(/\\/g, "/");
  let modified = false;

  const existingIdx = data.plugin.findIndex((p) => {
    const str = typeof p === "string" ? p : Array.isArray(p) ? p[0] : "";
    return MESH_HOOK_MATCHER.test(str);
  });

  if (existingIdx !== -1) {
    if (data.plugin[existingIdx] !== normalizedLoader) {
      data.plugin[existingIdx] = normalizedLoader;
      modified = true;
    }
  } else {
    data.plugin.push(normalizedLoader);
    modified = true;
  }

  if (modified) {
    backupOnce(configPath);
    atomicWriteJson(configPath, data);
  }

  return { ok: true, modified: true };
}

/**
 * Removes OpenCode presence plugin and unregisters from opencode.json.
 * @param {string} configPath
 * @param {string} pluginLoaderPath
 * @returns {{ ok: boolean, error?: string, modified: boolean }}
 */
export function uninstallOpenCodePlugin(configPath, pluginLoaderPath) {
  let modified = false;

  if (existsSync(configPath)) {
    const read = readJsonSafe(configPath);
    if (read.ok && Array.isArray(read.data.plugin)) {
      const origLen = read.data.plugin.length;
      read.data.plugin = read.data.plugin.filter((p) => {
        const str = typeof p === "string" ? p : Array.isArray(p) ? p[0] : "";
        return !MESH_HOOK_MATCHER.test(str);
      });
      if (read.data.plugin.length !== origLen) {
        atomicWriteJson(configPath, read.data);
        modified = true;
      }
    }
  }

  if (existsSync(pluginLoaderPath)) {
    try {
      unlinkSync(pluginLoaderPath);
      modified = true;
    } catch {}
  }

  return { ok: true, modified };
}

/**
 * Installs Pi Coding Agent presence extension into its extensions directory.
 * Pi auto-discovers extensions matching *.js from ~/.pi/agent/extensions/.
 * @param {string} extensionLoaderPath
 * @param {string} extensionScriptAbsPath
 * @returns {{ ok: boolean, error?: string, modified: boolean }}
 */
export function installPiExtension(extensionLoaderPath, extensionScriptAbsPath) {
  mkdirSync(dirname(extensionLoaderPath), { recursive: true });
  const fileUrl = pathToFileURL(extensionScriptAbsPath).href;
  const loaderContent = `// Agent Mesh presence extension for Pi Coding Agent\nimport extension from "${fileUrl}";\nexport default extension;\n`;
  backupOnce(extensionLoaderPath);
  writeFileSync(extensionLoaderPath, loaderContent, "utf8");
  return { ok: true, modified: true };
}

/**
 * Removes Pi Coding Agent presence extension.
 * @param {string} extensionLoaderPath
 * @returns {{ ok: boolean, error?: string, modified: boolean }}
 */
export function uninstallPiExtension(extensionLoaderPath) {
  let modified = false;
  if (existsSync(extensionLoaderPath)) {
    try {
      unlinkSync(extensionLoaderPath);
      modified = true;
    } catch {}
  }
  return { ok: true, modified };
}

/**
 * Resolves paths and target files for a specific harness.
 * @param {string} harness
 * @param {{ global?: boolean, project?: boolean }} options
 * @param {string} [rootDir=process.cwd()]
 * @returns {object}
 */
export function resolveHarnessPaths(harness, options = {}, rootDir = process.cwd()) {
  const isGlobal = Boolean(options.global);
  const scope = isGlobal ? "global" : "project";
  const canonical = normalizeHarnessName(harness);

  switch (canonical) {
    case "claude": {
      const configPath = isGlobal
        ? join(homedir(), ".claude", "settings.json")
        : join(rootDir, ".claude", "settings.json");
      return { harness: "claude", configPath, scope };
    }
    case "agy": {
      const configPath = isGlobal
        ? join(homedir(), ".gemini", "config", "hooks.json")
        : join(rootDir, ".agents", "hooks.json");
      return { harness: "agy", configPath, scope };
    }
    case "codex": {
      const configPath = isGlobal
        ? join(homedir(), ".codex", "hooks.json")
        : join(rootDir, ".codex", "hooks.json");
      return { harness: "codex", configPath, scope };
    }
    case "opencode": {
      const openCodeBase = isGlobal
        ? (process.platform === "win32"
            ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "OpenCode")
            : join(homedir(), ".config", "opencode"))
        : join(rootDir, ".opencode");
      const configPath = join(openCodeBase, "opencode.json");
      const pluginLoaderPath = join(openCodeBase, "plugins", "agent-mesh-presence.js");
      return { harness: "opencode", configPath, pluginLoaderPath, scope };
    }
    case "pi": {
      const piExtBase = isGlobal
        ? join(homedir(), ".pi", "agent", "extensions")
        : join(rootDir, ".pi", "extensions");
      const extensionLoaderPath = join(piExtBase, "agent-mesh-presence.js");
      return { harness: "pi", extensionLoaderPath, scope };
    }
    default:
      throw new Error(`Unsupported harness: ${harness}`);
  }
}

/**
 * Legacy path resolver preserved for backward compatibility.
 * @param {{ global?: boolean, project?: boolean }} options
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

/**
 * Auto-discovers which harnesses are present on the system and have access to the agent-mesh skill.
 * Checks binary availability in PATH, harness configuration folders, and skill installations.
 * @param {{ global?: boolean, project?: boolean }} options
 * @param {string} [rootDir=process.cwd()]
 * @returns {string[]} List of detected canonical harness names
 */
export function autoDiscoverHarnesses(options = {}, rootDir = process.cwd()) {
  const discovered = [];
  const universalSkill = existsSync(join(homedir(), ".agents", "skills", "agent-mesh", "SKILL.md"));
  const repoSkill = existsSync(join(rootDir, "SKILL.md")) || existsSync(join(rootDir, "skills", "agent-mesh", "SKILL.md"));
  const skillAvailable = universalSkill || repoSkill;

  // 1. Claude Code
  const hasClaude = isCommandAvailable("claude")
    || existsSync(join(homedir(), ".claude"))
    || existsSync(join(rootDir, ".claude"))
    || existsSync(join(homedir(), ".claude", "skills", "agent-mesh"));
  if (hasClaude && (skillAvailable || existsSync(join(homedir(), ".claude", "skills", "agent-mesh")))) {
    discovered.push("claude");
  }

  // 2. Antigravity (agy)
  const hasAgy = isCommandAvailable("agy")
    || existsSync(join(homedir(), ".gemini"))
    || existsSync(join(homedir(), ".antigravity"))
    || existsSync(join(rootDir, ".agents"));
  if (hasAgy && (skillAvailable || existsSync(join(homedir(), ".gemini", "config", "skills", "agent-mesh")))) {
    discovered.push("agy");
  }

  // 3. OpenAI Codex
  const hasCodex = isCommandAvailable("codex")
    || existsSync(join(homedir(), ".codex"))
    || existsSync(join(rootDir, ".codex"))
    || existsSync(join(homedir(), ".codex", "skills", "agent-mesh"));
  if (hasCodex && (skillAvailable || existsSync(join(homedir(), ".codex", "skills", "agent-mesh")))) {
    discovered.push("codex");
  }

  // 4. OpenCode
  const openCodeDir = process.platform === "win32"
    ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "OpenCode")
    : join(homedir(), ".config", "opencode");
  const hasOpenCode = isCommandAvailable("opencode")
    || existsSync(openCodeDir)
    || existsSync(join(homedir(), ".opencode"))
    || existsSync(join(rootDir, ".opencode"));
  if (hasOpenCode && skillAvailable) {
    discovered.push("opencode");
  }

  // 5. Pi Coding Agent
  const hasPi = isCommandAvailable("pi")
    || existsSync(join(homedir(), ".pi"))
    || existsSync(join(rootDir, ".pi"));
  if (hasPi && skillAvailable) {
    discovered.push("pi");
  }

  // Fallback: If nothing was detected by strict checks, include harnesses whose directories exist locally
  if (discovered.length === 0) {
    if (existsSync(join(rootDir, ".claude"))) discovered.push("claude");
    if (existsSync(join(rootDir, ".agents"))) discovered.push("agy");
    if (existsSync(join(rootDir, ".codex"))) discovered.push("codex");
    if (existsSync(join(rootDir, ".opencode"))) discovered.push("opencode");
    if (existsSync(join(rootDir, ".pi"))) discovered.push("pi");
  }

  return discovered;
}

/**
 * Installs hooks or extensions for a specific harness.
 * @param {string} harnessName
 * @param {{ global?: boolean, project?: boolean }} options
 * @param {string} [rootDir=process.cwd()]
 * @returns {{ ok: boolean, harness: string, targetPath: string, modified: boolean, error?: string }}
 */
export function installHarness(harnessName, options = {}, rootDir = process.cwd()) {
  const harness = normalizeHarnessName(harnessName);
  const paths = resolveHarnessPaths(harness, options, rootDir);

  const scriptsDir = resolve(import.meta.dirname);
  const claudeScript = resolve(scriptsDir, "presence-hook.mjs");
  const agyScript = resolve(scriptsDir, "agy-presence-hook.mjs");
  const openCodeScript = resolve(scriptsDir, "opencode-presence-plugin.mjs");
  const piScript = resolve(scriptsDir, "pi-presence-extension.mjs");

  switch (harness) {
    case "claude": {
      const res = installClaudeHooks(paths.configPath, claudeScript);
      return { ...res, harness: "claude", targetPath: paths.configPath };
    }
    case "agy": {
      const res = installAgyHooks(paths.configPath, agyScript);
      return { ...res, harness: "antigravity", targetPath: paths.configPath };
    }
    case "codex": {
      const res = installCodexHooks(paths.configPath, claudeScript);
      return { ...res, harness: "codex", targetPath: paths.configPath };
    }
    case "opencode": {
      const res = installOpenCodePlugin(paths.configPath, paths.pluginLoaderPath, openCodeScript);
      return { ...res, harness: "opencode", targetPath: paths.configPath };
    }
    case "pi": {
      const res = installPiExtension(paths.extensionLoaderPath, piScript);
      return { ...res, harness: "pi", targetPath: paths.extensionLoaderPath };
    }
    default:
      return { ok: false, harness, targetPath: "", modified: false, error: `Unknown harness: ${harness}` };
  }
}

/**
 * Uninstalls hooks or extensions for a specific harness.
 * @param {string} harnessName
 * @param {{ global?: boolean, project?: boolean }} options
 * @param {string} [rootDir=process.cwd()]
 * @returns {{ ok: boolean, harness: string, targetPath: string, modified: boolean, error?: string }}
 */
export function uninstallHarness(harnessName, options = {}, rootDir = process.cwd()) {
  const harness = normalizeHarnessName(harnessName);
  const paths = resolveHarnessPaths(harness, options, rootDir);

  switch (harness) {
    case "claude": {
      const res = uninstallClaudeHooks(paths.configPath);
      return { ...res, harness: "claude", targetPath: paths.configPath };
    }
    case "agy": {
      const res = uninstallAgyHooks(paths.configPath);
      return { ...res, harness: "antigravity", targetPath: paths.configPath };
    }
    case "codex": {
      const res = uninstallCodexHooks(paths.configPath);
      return { ...res, harness: "codex", targetPath: paths.configPath };
    }
    case "opencode": {
      const res = uninstallOpenCodePlugin(paths.configPath, paths.pluginLoaderPath);
      return { ...res, harness: "opencode", targetPath: paths.configPath };
    }
    case "pi": {
      const res = uninstallPiExtension(paths.extensionLoaderPath);
      return { ...res, harness: "pi", targetPath: paths.extensionLoaderPath };
    }
    default:
      return { ok: false, harness, targetPath: "", modified: false, error: `Unknown harness: ${harness}` };
  }
}

/**
 * Diagnoses whether a harness currently has agent-mesh hooks/extensions installed.
 * @param {string} harnessName
 * @param {{ global?: boolean, project?: boolean }} options
 * @param {string} [rootDir=process.cwd()]
 * @returns {{ harness: string, targetPath: string, status: string, installed: boolean }}
 */
export function diagnoseHarness(harnessName, options = {}, rootDir = process.cwd()) {
  const harness = normalizeHarnessName(harnessName);
  const paths = resolveHarnessPaths(harness, options, rootDir);

  switch (harness) {
    case "claude": {
      const p = paths.configPath;
      if (!existsSync(p)) return { harness: "claude", targetPath: p, status: "File does not exist", installed: false };
      try {
        const data = JSON.parse(readFileSync(p, "utf8"));
        const installed = Object.values(data.hooks || {}).some((groups) =>
          groups.some((g) => (g.hooks || []).some((h) => MESH_HOOK_MATCHER.test(h.command || "")))
        );
        return { harness: "claude", targetPath: p, status: installed ? "Installed (ACTIVE)" : "Not installed", installed };
      } catch {
        return { harness: "claude", targetPath: p, status: "Error reading JSON", installed: false };
      }
    }
    case "agy": {
      const p = paths.configPath;
      if (!existsSync(p)) return { harness: "antigravity", targetPath: p, status: "File does not exist", installed: false };
      try {
        const data = JSON.parse(readFileSync(p, "utf8"));
        const installed = Boolean(data["agent-mesh-presence"]);
        return { harness: "antigravity", targetPath: p, status: installed ? "Installed (ACTIVE)" : "Not installed", installed };
      } catch {
        return { harness: "antigravity", targetPath: p, status: "Error reading JSON", installed: false };
      }
    }
    case "codex": {
      const p = paths.configPath;
      if (!existsSync(p)) return { harness: "codex", targetPath: p, status: "File does not exist", installed: false };
      try {
        const data = JSON.parse(readFileSync(p, "utf8"));
        const installed = Object.values(data.hooks || {}).some((groups) =>
          groups.some((g) => (g.hooks || []).some((h) => MESH_HOOK_MATCHER.test(h.command || "")))
        );
        return { harness: "codex", targetPath: p, status: installed ? "Installed (ACTIVE)" : "Not installed", installed };
      } catch {
        return { harness: "codex", targetPath: p, status: "Error reading JSON", installed: false };
      }
    }
    case "opencode": {
      const p = paths.configPath;
      const loaderExists = existsSync(paths.pluginLoaderPath);
      if (!existsSync(p) && !loaderExists) {
        return { harness: "opencode", targetPath: p, status: "File does not exist", installed: false };
      }
      try {
        const data = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
        const inConfig = Array.isArray(data.plugin) && data.plugin.some((entry) => {
          const str = typeof entry === "string" ? entry : Array.isArray(entry) ? entry[0] : "";
          return MESH_HOOK_MATCHER.test(str);
        });
        const installed = inConfig || loaderExists;
        return { harness: "opencode", targetPath: p, status: installed ? "Installed (ACTIVE)" : "Not installed", installed };
      } catch {
        return { harness: "opencode", targetPath: p, status: "Error reading JSON", installed: false };
      }
    }
    case "pi": {
      const p = paths.extensionLoaderPath;
      const installed = existsSync(p);
      return { harness: "pi", targetPath: p, status: installed ? "Installed (ACTIVE)" : "Not installed", installed };
    }
    default:
      return { harness, targetPath: "", status: "Unknown harness", installed: false };
  }
}
