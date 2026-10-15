/**
 * @file index.mjs
 * @description Harness adapter registry. One descriptor module per harness (`./<id>.mjs`); broker,
 * installer and hooks look harnesses up here and never branch on a harness name. To add a harness,
 * see "How to add a harness" in docs/ADAPTERS.md.
 */

import claude from "./claude.mjs";
import antigravity from "./antigravity.mjs";
import codex from "./codex.mjs";
import opencode from "./opencode.mjs";
import pi from "./pi.mjs";
import { DEFAULT_TTL_MS } from "./shared/process.mjs";

/**
 * @typedef {"direct"|"walk"|"none"|"provided"} PidStrategy
 *   direct   = the sender runs inside the harness (plugin/extension): its own pid is the harness
 *   walk     = hook: climb past shell wrappers to the long-lived harness process
 *   none     = no usable pid; the broker relies on the inactivity TTL
 *   provided = the sender reports the pid itself (scanner, MCP shim)
 *
 * @typedef {{ targetPath: string, loaderPath?: string }} PresencePaths
 * @typedef {{ ok: boolean, error?: string, modified: boolean }} InstallResult
 * @typedef {{ harness: string, targetPath: string, status: string, installed: boolean }} DiagnoseResult
 *
 * @typedef {object} PresenceSource
 * @property {"hook"|"plugin"|"extension"|"process"|"mcp"} kind
 * @property {boolean} [optIn]  only installed on request (`installHarness(..., {mcp: true})`); always removed on uninstall
 * @property {boolean} [announce]  mcp only: false when the shim must not announce presence (shared-daemon host)
 * @property {string} [script]  entry script path relative to src/hooks/ (hook/plugin/extension/mcp)
 * @property {(opts: {global: boolean, root: string}) => PresencePaths} [resolvePaths]
 * @property {(paths: PresencePaths, scriptAbsPath: string) => InstallResult} [install]  idempotent
 * @property {(paths: PresencePaths) => InstallResult} [uninstall]
 * @property {(paths: PresencePaths) => DiagnoseResult} [diagnose]
 *
 * @typedef {object} Harness
 * @property {string} id            canonical id stored in the DB / broker (e.g. "antigravity")
 * @property {string[]} aliases     other accepted names (CLI, hook args); unique across the registry
 * @property {string} displayName
 * @property {{ binaries: string[], markers: (root: string) => string[], skillDir?: () => string, projectDir: string }} discovery
 *   binaries: PATH lookups; markers: dirs whose existence means "installed"; skillDir: harness-local skill
 *   copy that counts as "mesh available"; projectDir: per-project dir used by the last-resort fallback
 * @property {PresenceSource[]} presence
 * @property {{ via: "hook"|"plugin"|"extension", inject: ("prompt"|"invocation"|"turn-end"|"poll")[], idle: "inject"|"toast-only" }} delivery
 *   how queued mail reaches a running session. idle "inject": the harness-side component can wake an idle
 *   session (polls + injects); "toast-only": nothing can wake an idle TUI, the broker raises a desktop toast.
 * @property {PidStrategy} pid
 * @property {(cmdline: string) => {background: boolean, sharedHost: boolean}} [classifyProcess]
 *   background: hooks stay silent (forks, --agent, -p); sharedHost: hooks run in a daemon, report no pid.
 *   Defaults to `classifyCmdline` in shared/process.mjs.
 * @property {{ resolve?: (ctx: {sessionId: string, transcript?: string}) => string|null,
 *              watch?: {kind: "transcript-mtime"|"sqlite-poll"|"event"} }} [name]
 *   resolve never throws (null = unknown). transcript-mtime: broker re-resolves when the transcript the
 *   hook reported changes; sqlite-poll: broker re-resolves live sessions every ~5s; event: the harness
 *   announces renames itself (`session_event` event "rename").
 * @property {(row: object) => ({archived?: boolean, activityMs?: number}|null)} [pollSession]
 *   read-only per-live-session poll (archived closes the session; activityMs keeps the TTL alive)
 * @property {{ signals: ("event"|"pid"|"ttl")[], ttlMs?: {idle: number, busy: number} }} end
 *   ttlMs overrides the default inactivity TTL for pid-less sessions
 * @property {{ exe: string[], isInteractiveTui: (cmdline: string) => boolean }} [process]
 *   separate TUI process the broker scans for (exe names without ".exe")
 * @property {object} [fixtures]  test data for the contract suite (see tests/harness-contract-test.mjs)
 */

/** @type {Harness[]} */
const harnesses = [claude, antigravity, codex, opencode, pi];

const lookup = (name) => String(name || "").trim().toLowerCase();

/** Throws on a malformed descriptor (shape rules enforced by the contract suite and register()). */
export function validateDescriptor(h) {
  const fail = (msg) => {
    throw new Error(`harness ${h?.id ?? "?"}: ${msg}`);
  };
  if (!h || typeof h.id !== "string" || !h.id) fail("missing id");
  if (h.id !== h.id.toLowerCase()) fail("id must be lowercase");
  if (!Array.isArray(h.aliases) || h.aliases.some((a) => a !== a.toLowerCase())) fail("aliases must be lowercase strings");
  if (!h.displayName) fail("missing displayName");
  if (!["direct", "walk", "none", "provided"].includes(h.pid)) fail(`bad pid strategy ${h.pid}`);
  if (!Array.isArray(h.presence) || h.presence.length === 0) fail("needs at least one presence source");
  for (const s of h.presence) {
    if (!["hook", "plugin", "extension", "process", "mcp"].includes(s.kind)) fail(`bad presence kind ${s.kind}`);
    if (["hook", "plugin", "extension", "mcp"].includes(s.kind)) {
      for (const f of ["script", "resolvePaths", "install", "uninstall", "diagnose"]) if (!s[f]) fail(`${s.kind} source needs ${f}`);
    }
  }
  if (!h.delivery || !["hook", "plugin", "extension"].includes(h.delivery.via) || !Array.isArray(h.delivery.inject) || !["inject", "toast-only"].includes(h.delivery.idle)) fail("delivery {via, inject[], idle} required");
  if (!h.end || !Array.isArray(h.end.signals) || h.end.signals.length === 0) fail("end.signals required");
  if (h.pid === "none" && !h.end.signals.includes("ttl")) fail('pid "none" requires a "ttl" end signal');
  if (h.end.signals.includes("ttl") && h.end.ttlMs && !(h.end.ttlMs.idle > 0 && h.end.ttlMs.busy > 0)) fail("bad end.ttlMs");
  if (h.process && (!h.process.exe?.length || typeof h.process.isInteractiveTui !== "function")) fail("process needs exe[] and isInteractiveTui");
  if (h.name?.watch?.kind === "sqlite-poll" && !h.name.resolve && !h.pollSession) fail("sqlite-poll needs name.resolve or pollSession");
  return h;
}

/** @returns {Harness[]} every registered harness, in install/discovery order */
export const all = () => harnesses;

/** @returns {string[]} canonical ids */
export const ids = () => harnesses.map((h) => h.id);

/**
 * Resolves an id or alias (case-insensitive) to its descriptor.
 * @param {string} name
 * @returns {Harness|undefined}
 */
export const get = (name) => {
  const n = lookup(name);
  return harnesses.find((h) => h.id === n || h.aliases.includes(n));
};

/** Canonical id for an id/alias; unknown names pass through lowercased. */
export const canonicalId = (name) => get(name)?.id ?? lookup(name);

/** Descriptor whose scanned TUI process matches this executable name (".exe" optional). */
export const byExe = (exeName) => {
  const n = lookup(exeName).replace(/\.exe$/, "");
  return harnesses.find((h) => h.process?.exe.includes(n));
};

/** Inactivity TTLs for pid-less interactive sessions of a harness. */
export const endTtl = (name) => get(name)?.end.ttlMs ?? DEFAULT_TTL_MS;

/**
 * Registers an extra descriptor (tests, third-party harnesses). Ids and aliases must stay unique.
 * @param {Harness} h
 * @returns {() => void} dispose function removing it again
 */
export function register(h) {
  validateDescriptor(h);
  for (const n of [h.id, ...h.aliases]) {
    if (get(n)) throw new Error(`harness name already registered: ${n}`);
  }
  harnesses.push(h);
  return () => {
    const i = harnesses.indexOf(h);
    if (i !== -1) harnesses.splice(i, 1);
  };
}

for (const h of harnesses) validateDescriptor(h);
