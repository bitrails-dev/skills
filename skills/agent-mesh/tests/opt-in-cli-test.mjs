/**
 * `mesh mcp|wake install|remove|status`: one command per opt-in source, project scope in a temp dir,
 * MESH_HOME isolated (no broker is started by these commands).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const CLI = join(import.meta.dirname, "..", "scripts", "mesh.mjs");
const home = mkdtempSync(join(tmpdir(), "mesh-optin-home-"));
const proj = mkdtempSync(join(tmpdir(), "mesh-optin-proj-"));
const mesh = (...args) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: proj,
    encoding: "utf8",
    env: { ...process.env, MESH_HOME: home, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), MESH_SILENT: "1" },
  });

test("mcp install/status/remove touches only the MCP entries of the named harnesses", () => {
  const install = mesh("mcp", "install", "claude", "pi", "--project");
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /\[claude:project\] mcp installed/);
  assert.match(install.stdout, /\[pi:project\] mcp installed/);
  assert.equal(JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf8")).mcpServers["agent-mesh"].args.at(-1), "claude");
  assert.ok(JSON.parse(readFileSync(join(proj, ".pi", "mcp.json"), "utf8")).mcpServers["agent-mesh"]);
  assert.equal(existsSync(join(proj, ".claude", "settings.json")), false, "presence hooks are not installed by `mcp install`");

  assert.match(mesh("mcp", "install", "claude", "--project").stdout, /already installed/);
  const status = mesh("mcp", "status", "all", "--project").stdout;
  assert.match(status, /\[claude:project\] mcp: installed/);
  assert.match(status, /\[codex:project\] mcp: not installed/);

  const remove = mesh("mcp", "remove", "all", "--project");
  assert.equal(remove.status, 0);
  assert.match(remove.stdout, /\[claude:project\] mcp removed/);
  assert.match(mesh("mcp", "status", "claude", "--project").stdout, /mcp: not installed/);
});

test("wake install/remove: Claude async hook in settings.json, Codex flag in <MESH_HOME>/.agent-mesh/wake.json", () => {
  const claude = mesh("wake", "install", "claude", "--project");
  assert.equal(claude.status, 0, claude.stderr);
  const settings = JSON.parse(readFileSync(join(proj, ".claude", "settings.json"), "utf8"));
  const hook = settings.hooks.SessionStart[0].hooks[0];
  assert.deepEqual([hook.async, hook.asyncRewake], [true, true]);
  assert.match(hook.command, /mesh-wake-hook\.mjs/);

  const codex = mesh("wake", "install", "codex");
  assert.equal(codex.status, 0, codex.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(home, ".agent-mesh", "wake.json"), "utf8")), { codex: true });
  assert.match(mesh("wake", "status", "codex").stdout, /wake: installed/);

  assert.equal(mesh("wake", "remove", "claude", "--project").status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(proj, ".claude", "settings.json"), "utf8")).hooks, {});
  assert.equal(mesh("wake", "remove", "codex").status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(home, ".agent-mesh", "wake.json"), "utf8")), {});
});

test("usage and error handling", () => {
  const bad = mesh("mcp", "frobnicate");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Usage: mesh mcp install\|remove\|status/);
  // unsupported harness names are ignored by the selector; `all` is always valid
  assert.equal(mesh("wake", "status", "all", "--project").status, 0);
});
