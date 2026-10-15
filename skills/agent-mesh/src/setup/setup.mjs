/**
 * @file setup.mjs
 * @description `mesh setup`: one entry point to install, update or uninstall agent-mesh for any set of
 * harnesses in a single round, interactively (readline, zero deps) or with flags.
 *
 *   mesh setup                                   interactive checklist (TTY)
 *   mesh setup --yes --harness claude,codex --action install --mcp --wake
 *   mesh setup --all --action update --yes       update every harness that is already installed
 *   mesh setup --action uninstall --yes [--purge]
 *   mesh setup --dry-run ...                     print the plan, change nothing
 *
 * All harness knowledge comes from descriptors through src/hooks/installer.mjs.
 */

import { createInterface } from "node:readline";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as registry from "../harnesses/index.mjs";

export const ACTIONS = ["install", "update", "uninstall"];

const BOOL_FLAGS = new Set(["--yes", "-y", "--all", "--dry-run", "--mcp", "--wake", "--project", "--global", "--purge", "--no-broker", "--restart", "--interactive"]);
const VALUE_FLAGS = new Set(["--harness", "--action"]);

/** Parses `mesh setup` arguments (`--flag value` and `--flag=value`). Unknown flags are reported, not ignored. */
export function parseSetupArgs(argv) {
  const out = { flags: new Set(), harness: [], action: null, unknown: [], positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = argv[i].split(/=(.*)/s);
    if (BOOL_FLAGS.has(name)) out.flags.add(name === "-y" ? "--yes" : name);
    else if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++i];
      if (name === "--harness") out.harness.push(...String(value ?? "").split(",").map((s) => s.trim()).filter(Boolean));
      else out.action = String(value ?? "").toLowerCase();
    } else if (name.startsWith("-")) out.unknown.push(argv[i]);
    else out.positional.push(argv[i]);
  }
  return out;
}

export const USAGE = `Usage: mesh setup [options]
  --action install|update|uninstall   what to do (default: asked interactively, 'install' with --yes)
  --harness claude,codex,...          harnesses (aliases ok); default: detected ones (--all: every supported)
  --all                               every supported harness (update/uninstall: only those installed)
  --mcp                               also (un)register the opt-in MCP shim
  --wake                              also (un)register the opt-in idle-wake source
  --project | --global                scope (default: global)
  --yes, -y                           no questions; use the flags as given
  --dry-run                           print the plan, change nothing
  --purge                             uninstall only: also delete the state directory (~/.agent-mesh)
  --restart                           update only: always restart the broker (default: only if it is older)
  --no-broker                         do not touch the broker daemon
  --interactive                       force prompts even when stdin is not a terminal`;

/** Current component status of one harness. */
export function statusOf(deps, id, opts, root) {
  const hooks = deps.diagnoseHarness(id, opts, root);
  const mcp = deps.diagnoseMcp(id, opts, root);
  const wake = deps.diagnoseWake(id, opts, root);
  return {
    hooks: Boolean(hooks.installed),
    mcp: mcp.supported ? mcp.installed : null,
    wake: wake.supported ? wake.installed : null,
  };
}

const fmtStatus = (s) =>
  `hooks:${s.hooks ? "yes" : "no"} mcp:${s.mcp === null ? "-" : s.mcp ? "yes" : "no"} wake:${s.wake === null ? "-" : s.wake ? "yes" : "no"}`;

/**
 * @param {object} io { stdin, stdout, isTTY }
 * @param {object} deps installer + broker functions (injected for tests)
 * @param {{ argv: string[], rootDir: string, meshHome: string, brokerRoot: string, ipcAddress: string }} ctx
 * @returns {Promise<number>} exit code
 */
export async function runSetup({ argv, rootDir, meshHome, brokerRoot, ipcAddress }, io, deps) {
  const out = (text = "") => io.stdout.write(`${text}\n`);
  const args = parseSetupArgs(argv);
  const has = (f) => args.flags.has(f);

  if (args.unknown.length) {
    out(`Unknown option(s): ${args.unknown.join(", ")}\n\n${USAGE}`);
    return 2;
  }
  if (args.action && !ACTIONS.includes(args.action)) {
    out(`Unknown action '${args.action}' (use ${ACTIONS.join("|")}).\n\n${USAGE}`);
    return 2;
  }
  const interactive = has("--interactive") || (io.isTTY && !has("--yes"));
  if (!interactive && !has("--yes") && !has("--dry-run") && !args.action) {
    out(`Not a terminal: nothing to ask. Pass the choices as flags, e.g.\n  mesh setup --yes --harness claude,codex --action install [--mcp] [--wake]\n\n${USAGE}`);
    return 2;
  }

  // ---- input helper (line queue works for TTY and piped stdin alike) ----
  const rl = createInterface({ input: io.stdin, terminal: false });
  const lines = [];
  const waiters = [];
  let closed = false;
  rl.on("line", (l) => (waiters.length ? waiters.shift()(l) : lines.push(l)));
  rl.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()("");
  });
  const ask = async (prompt, fallback = "") => {
    io.stdout.write(prompt);
    const line = lines.length ? lines.shift() : closed ? "" : await new Promise((r) => waiters.push(r));
    io.stdout.write("\n");
    return (line.trim() || fallback).trim();
  };
  const finish = (code) => {
    rl.close();
    return code;
  };

  const scopeGlobal = !has("--project");
  const opts = { global: scopeGlobal };
  const scopeName = scopeGlobal ? "global" : "project";
  const supported = registry.ids();
  const detected = deps.autoDiscoverHarnesses(opts, rootDir);

  // ---- 1. which action ----
  let action = args.action;
  if (!action && interactive) {
    out(`\nAgent Mesh setup (${scopeName} scope)\n`);
    const a = (await ask("Action: [i]nstall, [u]pdate, [r]emove (uninstall) [i]: ", "i")).toLowerCase();
    action = a.startsWith("u") ? "update" : a.startsWith("r") || a.startsWith("un") ? "uninstall" : "install";
  }
  action ||= "install";

  // ---- 2. which harnesses ----
  const rows = supported.map((id) => ({ id, name: registry.get(id).displayName, detected: detected.includes(id), status: statusOf(deps, id, opts, rootDir) }));
  let chosen = args.harness.map((h) => registry.canonicalId(h));
  const unknown = chosen.filter((h) => !supported.includes(h));
  if (unknown.length) {
    out(`Unknown harness(es): ${unknown.join(", ")}. Supported: ${supported.join(", ")}`);
    return finish(2);
  }
  if (has("--all")) {
    chosen = action === "install" ? [...supported] : rows.filter((r) => r.status.hooks || r.status.mcp || r.status.wake).map((r) => r.id);
  }
  if (chosen.length === 0 && interactive) {
    out("\nHarnesses:");
    rows.forEach((r, i) => out(`  ${i + 1}. ${r.name.padEnd(14)} ${r.detected ? "detected    " : "not detected"}  ${fmtStatus(r.status)}`));
    const defaults = rows.filter((r) => (action === "install" ? r.detected : r.status.hooks)).map((r) => r.id);
    const answer = await ask(`Select (numbers/names, comma separated, 'all', Enter = ${defaults.join(",") || "none"}): `);
    if (answer.toLowerCase() === "all") chosen = [...supported];
    else if (answer) {
      chosen = answer.split(/[,\s]+/).filter(Boolean).map((tok) => (/^\d+$/.test(tok) ? rows[Number(tok) - 1]?.id : registry.canonicalId(tok))).filter(Boolean);
    } else chosen = defaults;
  } else if (chosen.length === 0) {
    chosen = action === "install" ? detected : rows.filter((r) => r.status.hooks).map((r) => r.id);
  }
  chosen = [...new Set(chosen)].filter((id) => supported.includes(id));
  if (chosen.length === 0) {
    out("Nothing selected (no harness detected). Use --harness <names> or --all.");
    return finish(1);
  }

  // ---- 3. optional components ----
  let mcp = has("--mcp");
  let wake = has("--wake");
  if (interactive && action !== "uninstall") {
    if (!has("--mcp")) mcp = /^y/i.test(await ask("Also register the MCP shim (mesh_send/mesh_ask/mesh_inbox/mesh_status)? [y/N]: ", "n"));
    if (!has("--wake")) wake = /^y/i.test(await ask("Also enable idle-session wake (Claude hook / Codex injector; see docs)? [y/N]: ", "n"));
  }

  // ---- 4. plan + confirm ----
  const plan = chosen.map((id) => {
    const status = rows.find((r) => r.id === id).status;
    return {
      id,
      status,
      // update keeps components that are already installed; flags add more
      mcp: action === "uninstall" ? false : mcp || (action === "update" && status.mcp === true),
      wake: action === "uninstall" ? false : wake || (action === "update" && status.wake === true),
    };
  });
  out(`\nPlan: ${action} (${scopeName} scope)${has("--dry-run") ? "  [dry run]" : ""}`);
  for (const p of plan) {
    const comps = action === "uninstall" ? "everything incl. opt-ins" : `hooks${p.mcp ? " + mcp" : ""}${p.wake ? " + wake" : ""}`;
    out(`  - ${p.id}: ${comps}   (now: ${fmtStatus(p.status)})`);
  }
  if (action === "uninstall" && has("--purge")) out(`  - delete state directory ${join(meshHome, ".agent-mesh")}`);
  if (has("--dry-run")) return finish(0);
  if (interactive && !has("--yes")) {
    const ok = await ask("Proceed? [Y/n]: ", "y");
    if (!/^y/i.test(ok)) {
      out("Cancelled.");
      return finish(0);
    }
  }

  // ---- 5. apply ----
  let failed = false;
  for (const p of plan) {
    const res =
      action === "uninstall"
        ? deps.uninstallHarness(p.id, opts, rootDir)
        : deps.installHarness(p.id, { ...opts, mcp: p.mcp, wake: p.wake }, rootDir);
    if (res.ok) {
      const verb = action === "uninstall" ? (res.modified ? "removed" : "nothing to remove") : res.modified ? "installed/updated" : "already current";
      out(`[${p.id}:${scopeName}] ${verb} -> ${res.targetPath}`);
    } else {
      failed = true;
      out(`[${p.id}:${scopeName}] FAILED: ${res.error}`);
    }
  }

  // ---- 6. broker ----
  if (!has("--no-broker")) {
    try {
      if (action === "uninstall") {
        const left = supported.some((id) => statusOf(deps, id, opts, rootDir).hooks);
        if (!left) {
          await deps.stopBroker({ rootDir: brokerRoot, address: ipcAddress });
          out("[broker] stopped (no harness uses it anymore)");
        }
      } else {
        if (has("--restart")) await deps.stopBroker({ rootDir: brokerRoot, address: ipcAddress });
        const b = await deps.ensureBroker({ rootDir: brokerRoot, address: ipcAddress });
        out(`[broker] active (pid ${b.pid}, v${b.version ?? "?"})`);
      }
    } catch (err) {
      failed = true;
      out(`[broker] ${err.message}`);
    }
  }
  if (action === "uninstall" && has("--purge")) {
    const dir = join(meshHome, ".agent-mesh");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      out(`[purge] deleted ${dir}`);
    }
  }

  out(action === "uninstall" ? "\nDone. Restart harness sessions to drop the old hooks." : "\nDone. Restart running harness sessions so they load the hooks/plugins.");
  if (action !== "uninstall") out("Verify with: mesh doctor   and   mesh status");
  return finish(failed ? 1 : 0);
}
