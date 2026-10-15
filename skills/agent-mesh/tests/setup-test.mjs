/**
 * `mesh setup`: interactive checklist (scripted stdin), flag mode, dry run, update keeps opt-ins, uninstall
 * removes everything, purge, TTY-less fallback. Project scope in temp dirs, isolated MESH_HOME, --no-broker.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const CLI = join(import.meta.dirname, "..", "scripts", "mesh.mjs");
const { parseSetupArgs } = await import("../src/setup/setup.mjs");

const home = mkdtempSync(join(tmpdir(), "mesh-setup-home-"));
const proj = mkdtempSync(join(tmpdir(), "mesh-setup-proj-"));
const run = (args, input = "") =>
  spawnSync(process.execPath, [CLI, "setup", ...args], {
    cwd: proj,
    encoding: "utf8",
    input,
    env: { ...process.env, MESH_HOME: home, MESH_SILENT: "1", MESH_MUSE_BIN: join(home, "no-such-muse.exe") },
  });
const readJson = (p) => JSON.parse(readFileSync(join(proj, p), "utf8"));

test("argument parsing: flags, values, aliases, unknown options", () => {
  const a = parseSetupArgs(["--yes", "--harness=claude,agy", "--action", "update", "--mcp", "-y", "--bogus", "--harness", "pi"]);
  assert.deepEqual([...a.flags].sort(), ["--mcp", "--yes"]);
  assert.deepEqual(a.harness, ["claude", "agy", "pi"]);
  assert.equal(a.action, "update");
  assert.deepEqual(a.unknown, ["--bogus"]);
});

test("no terminal and no flags: prints the exact flags and exits 2", () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /mesh setup --yes --harness claude,codex --action install/);
  assert.equal(existsSync(join(proj, ".claude")), false);
});

test("dry run prints the plan and changes nothing", () => {
  const r = run(["--yes", "--project", "--harness", "claude,pi", "--action", "install", "--mcp", "--dry-run", "--no-broker"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Plan: install \(project scope\)\s+\[dry run\]/);
  assert.match(r.stdout, /- claude: hooks \+ mcp/);
  assert.equal(existsSync(join(proj, ".claude")), false);
  assert.equal(existsSync(join(proj, ".mcp.json")), false);
});

test("interactive checklist with scripted answers: action, harnesses, components, confirm", () => {
  const r = run(["--interactive", "--project", "--no-broker"], "i\nclaude,pi\ny\nn\ny\n");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Harnesses:/);
  assert.match(r.stdout, /Plan: install \(project scope\)/);
  assert.ok(readJson(".claude/settings.json").hooks.SessionStart, "claude hooks");
  assert.ok(readJson(".mcp.json").mcpServers["agent-mesh"], "claude MCP (answered y)");
  assert.ok(existsSync(join(proj, ".pi", "extensions", "agent-mesh-presence.js")), "pi extension");
  assert.ok(readJson(".pi/mcp.json").mcpServers["agent-mesh"], "pi MCP");
  // wake was answered n: no async hook
  assert.ok(!JSON.stringify(readJson(".claude/settings.json")).includes("mesh-wake-hook"));
});

test("answering 'n' at the confirmation changes nothing", () => {
  const other = mkdtempSync(join(tmpdir(), "mesh-setup-proj2-"));
  const r = spawnSync(process.execPath, [CLI, "setup", "--interactive", "--project", "--no-broker"], {
    cwd: other,
    encoding: "utf8",
    input: "i\nclaude\nn\nn\nn\n",
    env: { ...process.env, MESH_HOME: home, MESH_SILENT: "1", MESH_MUSE_BIN: join(home, "no-such-muse.exe") },
  });
  assert.match(r.stdout, /Cancelled/);
  assert.equal(existsSync(join(other, ".claude")), false);
});

test("update is idempotent and keeps the opt-ins that are installed; --wake adds one", () => {
  const r = run(["--yes", "--project", "--harness", "claude", "--action", "update", "--no-broker"]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /claude: hooks \+ mcp\s+\(now: hooks:yes mcp:yes/);
  assert.ok(readJson(".mcp.json").mcpServers["agent-mesh"], "MCP kept");

  const add = run(["--yes", "--project", "--harness", "claude", "--action", "update", "--wake", "--no-broker"]);
  assert.equal(add.status, 0);
  assert.match(JSON.stringify(readJson(".claude/settings.json")), /mesh-wake-hook/);
  // the one-round flow leaves a single set of hook entries
  assert.equal(readJson(".claude/settings.json").hooks.SessionStart.filter((g) => JSON.stringify(g).includes("presence-hook")).length, 1);
});

test("uninstall removes hooks and every opt-in; --purge deletes the state directory", () => {
  mkdirSync(join(home, ".agent-mesh"), { recursive: true });
  writeFileSync(join(home, ".agent-mesh", "mesh.db"), "x");
  const r = run(["--yes", "--project", "--all", "--action", "uninstall", "--purge", "--no-broker"]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /\[claude:project\] removed/);
  assert.match(r.stdout, /\[purge\] deleted/);
  assert.deepEqual(readJson(".claude/settings.json").hooks, {});
  assert.equal(readJson(".mcp.json").mcpServers["agent-mesh"], undefined);
  assert.equal(existsSync(join(proj, ".pi", "extensions", "agent-mesh-presence.js")), false);
  assert.equal(readJson(".pi/mcp.json").mcpServers["agent-mesh"], undefined);
  assert.equal(existsSync(join(home, ".agent-mesh")), false);
});

test("bad input: unknown harness and unknown action exit 2", () => {
  assert.equal(run(["--yes", "--harness", "nope", "--no-broker"]).status, 2);
  assert.equal(run(["--yes", "--action", "explode", "--no-broker"]).status, 2);
});
