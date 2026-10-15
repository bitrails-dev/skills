/**
 * The home guard: under `node --test` (or MESH_PROTECT_HOME=1) installers refuse to write into the real home.
 * Nothing here writes anywhere: the guard throws before touching the file system.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { userInfo, tmpdir } from "node:os";
import { join } from "node:path";

const { guardWrite, homeGuardActive } = await import("../src/harnesses/shared/home-guard.mjs");
const { atomicWriteJson, backupOnce, installTomlMcp, writeLoader, removeFile } = await import("../src/harnesses/shared/install.mjs");
const { writeWakeConfig } = await import("../src/presence/wake-policy.mjs");

const realHome = userInfo().homedir;
const realPaths = [
  join(realHome, ".claude", "settings.json"),
  join(realHome, ".codex", "config.toml"),
  join(realHome, ".agent-mesh", "wake.json"),
];

test("guard is active under node --test", () => {
  assert.equal(homeGuardActive(), true);
});

test("real-home paths are refused, temp paths are fine", () => {
  for (const p of realPaths) assert.throws(() => guardWrite(p), /home guard/);
  assert.doesNotThrow(() => guardWrite(join(tmpdir(), "mesh-guard-ok", ".claude", "settings.json")));
});

test("every installer write path is guarded (even with HOME/USERPROFILE pointing at a temp dir)", () => {
  const target = realPaths[0];
  assert.throws(() => atomicWriteJson(target, { x: 1 }), /home guard/);
  assert.throws(() => backupOnce(target), /home guard/);
  assert.throws(() => installTomlMcp(realPaths[1], { command: "node", args: ["x"] }), /home guard/);
  assert.throws(() => writeLoader(join(realHome, ".pi", "agent", "extensions", "x.js"), "C:/x.mjs", "c"), /home guard/);
  assert.throws(() => removeFile(join(realHome, ".claude", "nope")), /home guard/);
  assert.throws(() => writeWakeConfig(realHome, { codex: true }), /home guard/);
});
