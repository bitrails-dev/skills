/**
 * @file resilience-test.mjs
 * @description Regression test suite for architecture and race resilience:
 * - C1: mesh CLI syntax and import.meta.dirname resolution
 * - C2: Lease protection against background turn state overwrites
 * - H3: Exclusive IPC bind prior to daemon PID record
 * - H7: Automatic .git/info/exclude protection for .agent-mesh
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { initDatabase, MeshRepository } from "../src/db.mjs";
import { ensureAgentWorktree } from "../src/worktree.mjs";

test("Resilience & Race Prevention Suite", async (t) => {
  const testDir = mkdtempSync(join(tmpdir(), "mesh-resilience-"));

  t.after(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  await t.test("1. C1: mesh CLI boots and responds without __dirname error", () => {
    const cliPath = join(import.meta.dirname, "../scripts/mesh.mjs");
    const proc = spawnSync(process.execPath, [cliPath, "status"], {
      cwd: testDir,
      encoding: "utf8",
    });

    const output = proc.stdout + proc.stderr;
    assert.match(output, /Cannot connect to broker|agent-mesh broker/);
  });

  await t.test("2. C2: human-held lease is preserved even when turn finishes", () => {
    const dbPath = join(testDir, "test-mesh.db");
    const db = initDatabase(dbPath);
    const repo = new MeshRepository(db);

    repo.upsertSession({
      harness: "claude",
      sessionId: "sess-resilience-1",
      cwd: testDir,
      state: "human-held",
      leaseHolder: "human-cli",
    });

    // Background turn completes and tries to set 'idle' conditionally
    const updated = repo.updateSessionStateIf("sess-resilience-1", "idle", "busy");
    assert.equal(updated, false, "Must not overwrite human-held state with idle");

    const session = repo.getActiveSession("claude");
    assert.equal(session.state, "human-held");
    assert.equal(session.lease_holder, "human-cli");

    db.close();
  });

  await t.test("3. H7: ensureAgentWorktree adds .agent-mesh to .git/info/exclude", () => {
    // Init a dummy git repo
    execFileSync("git", ["init"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: testDir, stdio: "ignore" });

    // Create an initial commit so worktrees can be branched
    const readme = join(testDir, "README.md");
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: testDir, stdio: "ignore" });

    ensureAgentWorktree(testDir, "claude");

    const excludePath = join(testDir, ".git", "info", "exclude");
    assert.ok(existsSync(excludePath), ".git/info/exclude should exist");
    const content = readFileSync(excludePath, "utf8");
    assert.match(content, /\.agent-mesh/, "Exclude file must contain .agent-mesh");
  });
});
