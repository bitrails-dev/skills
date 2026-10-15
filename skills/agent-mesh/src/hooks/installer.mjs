/**
 * @file installer.mjs
 * @description Harness-agnostic install/uninstall/diagnose/discovery front end. All per-harness
 * knowledge (config paths, formats, quoting rules) lives in the descriptors under src/harnesses/;
 * this module only loops over them. The `install*`/`uninstall*` per-harness exports below are
 * deprecated thin wrappers kept for one release.
 *
 * Implements:
 * - Auto-discovery mode: detects installed harnesses with agent-mesh available
 * - Assigned harness mode: accepts harness ids or aliases (e.g. agy, claude, codex, opencode, pi)
 * - Idempotent merges, automatic backup (.bak) creation, and atomic writes.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import * as registry from "../harnesses/index.mjs";
import { HOOKS_DIR, isCommandAvailable } from "../harnesses/shared/install.mjs";

export {
  isCommandAvailable,
  readJsonSafe,
  backupOnce,
  atomicWriteJson,
} from "../harnesses/shared/install.mjs";

/** Canonical harness ids, in discovery/install order. */
export const SUPPORTED_HARNESSES = registry.ids();

/**
 * Normalizes user-supplied harness names/aliases into canonical harness ids (unknown names pass through).
 * @param {string} name
 * @returns {string}
 */
export function normalizeHarnessName(name) {
  return registry.canonicalId(name);
}

const scriptPath = (source) => resolve(HOOKS_DIR, source.script);
const installable = (h) => h.presence.filter((s) => s.install);

// ---- deprecated per-harness wrappers (use installHarness/uninstallHarness) ----------------------

const sourceOf = (id) => registry.get(id).presence[0];
const legacyInstall = (id) => (targetPath, ...rest) => {
  // opencode: (configPath, loaderPath, script); everything else: (path, script)
  const [loaderPath, script] = rest.length === 2 ? rest : [undefined, rest[0]];
  return sourceOf(id).install({ targetPath, loaderPath }, script);
};
const legacyUninstall = (id) => (targetPath, loaderPath) => sourceOf(id).uninstall({ targetPath, loaderPath });

/** @deprecated use installHarness("claude") */
export const installClaudeHooks = legacyInstall("claude");
/** @deprecated use uninstallHarness("claude") */
export const uninstallClaudeHooks = legacyUninstall("claude");
/** @deprecated use installHarness("antigravity") */
export const installAgyHooks = legacyInstall("antigravity");
/** @deprecated use uninstallHarness("antigravity") */
export const uninstallAgyHooks = legacyUninstall("antigravity");
/** @deprecated use installHarness("codex") */
export const installCodexHooks = legacyInstall("codex");
/** @deprecated use uninstallHarness("codex") */
export const uninstallCodexHooks = legacyUninstall("codex");
/** @deprecated use installHarness("opencode") */
export const installOpenCodePlugin = legacyInstall("opencode");
/** @deprecated use uninstallHarness("opencode") */
export const uninstallOpenCodePlugin = legacyUninstall("opencode");
/** @deprecated use installHarness("pi") */
export const installPiExtension = legacyInstall("pi");
/** @deprecated use uninstallHarness("pi") */
export const uninstallPiExtension = legacyUninstall("pi");

// ---- generic front end ---------------------------------------------------------------------------

/**
 * Resolves paths and target files for a specific harness (first installable presence source).
 * @param {string} harness id or alias
 * @param {{ global?: boolean }} options
 * @param {string} [rootDir=process.cwd()]
 * @returns {{ harness: string, scope: string, configPath: string, loaderPath?: string }}
 */
export function resolveHarnessPaths(harness, options = {}, rootDir = process.cwd()) {
  const desc = registry.get(harness);
  if (!desc) throw new Error(`Unsupported harness: ${harness}`);
  const isGlobal = Boolean(options.global);
  const source = installable(desc)[0];
  const paths = source.resolvePaths({ global: isGlobal, root: rootDir });
  return { harness: desc.id, scope: isGlobal ? "global" : "project", configPath: paths.targetPath, loaderPath: paths.loaderPath };
}

/**
 * Auto-discovers which harnesses are present on the system and have access to the agent-mesh skill.
 * Checks binary availability in PATH, harness configuration folders, and skill installations.
 * @param {{ global?: boolean, project?: boolean }} options
 * @param {string} [rootDir=process.cwd()]
 * @returns {string[]} List of detected canonical harness ids
 */
export function autoDiscoverHarnesses(options = {}, rootDir = process.cwd()) {
  const universalSkill = existsSync(join(homedir(), ".agents", "skills", "agent-mesh", "SKILL.md"));
  const repoSkill = existsSync(join(rootDir, "SKILL.md")) || existsSync(join(rootDir, "skills", "agent-mesh", "SKILL.md"));
  const skillAvailable = universalSkill || repoSkill;

  const discovered = [];
  for (const h of registry.all()) {
    const { binaries, markers, skillDir } = h.discovery;
    const localSkill = skillDir ? existsSync(skillDir()) : false;
    const present = binaries.some(isCommandAvailable) || markers(rootDir).some(existsSync) || localSkill;
    if (present && (skillAvailable || localSkill)) discovered.push(h.id);
  }

  // Fallback: If nothing was detected by strict checks, include harnesses whose project dirs exist locally
  if (discovered.length === 0) {
    for (const h of registry.all()) {
      if (existsSync(join(rootDir, h.discovery.projectDir))) discovered.push(h.id);
    }
  }
  return discovered;
}

/** Runs `op` over a harness's installable presence sources; first failure wins, `modified` is OR-ed. */
function runSources(harnessName, options, rootDir, op) {
  const desc = registry.get(harnessName);
  if (!desc) {
    const harness = normalizeHarnessName(harnessName);
    return { ok: false, harness, targetPath: "", modified: false, error: `Unknown harness: ${harness}` };
  }
  let result = { ok: true, modified: false };
  let targetPath = "";
  for (const source of installable(desc)) {
    const paths = source.resolvePaths({ global: Boolean(options.global), root: rootDir });
    targetPath ||= paths.targetPath;
    const res = op(source, paths);
    if (!res.ok) return { ...res, harness: desc.id, targetPath };
    result = { ...result, modified: result.modified || res.modified };
  }
  return { ...result, harness: desc.id, targetPath };
}

/**
 * Installs hooks, plugins or extensions for a specific harness.
 * @param {string} harnessName id or alias
 * @param {{ global?: boolean, project?: boolean }} options
 * @param {string} [rootDir=process.cwd()]
 * @returns {{ ok: boolean, harness: string, targetPath: string, modified: boolean, error?: string }}
 */
export function installHarness(harnessName, options = {}, rootDir = process.cwd()) {
  return runSources(harnessName, options, rootDir, (source, paths) => source.install(paths, scriptPath(source)));
}

/**
 * Uninstalls hooks, plugins or extensions for a specific harness.
 * @param {string} harnessName id or alias
 * @param {{ global?: boolean, project?: boolean }} options
 * @param {string} [rootDir=process.cwd()]
 * @returns {{ ok: boolean, harness: string, targetPath: string, modified: boolean, error?: string }}
 */
export function uninstallHarness(harnessName, options = {}, rootDir = process.cwd()) {
  return runSources(harnessName, options, rootDir, (source, paths) => source.uninstall(paths));
}

/**
 * Diagnoses whether a harness currently has agent-mesh hooks/extensions installed.
 * @param {string} harnessName id or alias
 * @param {{ global?: boolean, project?: boolean }} options
 * @param {string} [rootDir=process.cwd()]
 * @returns {{ harness: string, targetPath: string, status: string, installed: boolean }}
 */
export function diagnoseHarness(harnessName, options = {}, rootDir = process.cwd()) {
  const desc = registry.get(harnessName);
  if (!desc) return { harness: normalizeHarnessName(harnessName), targetPath: "", status: "Unknown harness", installed: false };
  const source = installable(desc)[0];
  return source.diagnose(source.resolvePaths({ global: Boolean(options.global), root: rootDir }));
}
