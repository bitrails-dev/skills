/**
 * Harness adapter contract suite: the SAME assertions run against every registered descriptor
 * (and a fake harness registered inline), driven by each descriptor's `fixtures`.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";

process.env.MESH_SILENT = "1"; // tests must never raise desktop notifications
process.env.MESH_HOME = mkdtempSync(join(tmpdir(), "mesh-test-home-"));

const registry = await import("../src/harnesses/index.mjs");
const { classifyCmdline } = await import("../src/harnesses/shared/process.mjs");
const { installHarness, uninstallHarness, diagnoseHarness, diagnoseMcp } = await import("../src/hooks/installer.mjs");
const { AgentMeshBroker } = await import("../src/broker.mjs");
const { sendIpcRequest } = await import("../src/ipc.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = () => spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });

const dir = mkdtempSync(join(tmpdir(), "mesh-contract-"));
const broker = new AgentMeshBroker(dir, { version: "9.9.9-test" });
const notified = [];
broker.notifyDesktop = (p) => notified.push(p);
await broker.start();
after(() => broker.stop());

const send = (payload) =>
  sendIpcRequest(broker.ipcAddress, { action: "session_event", payload: { cwd: dir, origin: "interactive", ...payload } });
const live = async () => (await sendIpcRequest(broker.ipcAddress, { action: "status" })).liveSessions;

/** Runs every contract assertion against one descriptor. */
async function runContract(t, h) {
  await t.test("shape", () => {
    registry.validateDescriptor(h);
    for (const n of [h.id, ...h.aliases]) assert.equal(registry.get(n), h, `${n} resolves to ${h.id}`);
  });

  await t.test("install -> diagnose -> idempotent reinstall -> uninstall (foreign config survives)", () => {
    const root = mkdtempSync(join(tmpdir(), `mesh-contract-${h.id}-`));
    const opts = { global: false };
    const first = installHarness(h.id, opts, root);
    assert.equal(first.ok, true, first.error);
    assert.equal(first.harness, h.id);
    assert.equal(diagnoseHarness(h.id, opts, root).installed, true);
    assert.equal(installHarness(h.id, opts, root).ok, true);
    assert.equal(diagnoseHarness(h.id, opts, root).installed, true);
    if (first.targetPath.endsWith(".json")) {
      const cfg = JSON.parse(readFileSync(first.targetPath, "utf8"));
      cfg.foreignKey = { keep: true };
      writeFileSync(first.targetPath, JSON.stringify(cfg));
    }
    assert.equal(uninstallHarness(h.id, opts, root).ok, true);
    assert.equal(diagnoseHarness(h.id, opts, root).installed, false);
    if (first.targetPath.endsWith(".json") && existsSync(first.targetPath)) {
      assert.deepEqual(JSON.parse(readFileSync(first.targetPath, "utf8")).foreignKey, { keep: true });
    }
  });

  await t.test("mcp entry is opt-in, round-trips, keeps foreign config, and is always removed on uninstall", () => {
    if (!h.presence.some((s) => s.kind === "mcp")) return;
    const root = mkdtempSync(join(tmpdir(), `mesh-contract-mcp-${h.id}-`));
    const opts = { global: false };
    assert.equal(diagnoseMcp(h.id, opts, root).supported, true);

    const plain = installHarness(h.id, opts, root);
    assert.equal(plain.ok, true, plain.error);
    assert.equal(diagnoseMcp(h.id, opts, root).installed, false, "default install must not add the MCP entry");

    const mcp = diagnoseMcp(h.id, opts, root);
    mkdirSync(dirname(mcp.targetPath), { recursive: true });
    const foreign = mcp.targetPath.endsWith(".toml") ? '[other]\nkey = "keep"\n' : JSON.stringify({ foreignKey: { keep: true } });
    writeFileSync(mcp.targetPath, foreign);

    const withMcp = installHarness(h.id, { ...opts, mcp: true }, root);
    assert.equal(withMcp.ok, true, withMcp.error);
    assert.equal(diagnoseMcp(h.id, opts, root).installed, true);
    const text = readFileSync(mcp.targetPath, "utf8");
    assert.ok(text.includes("mesh-mcp.mjs") && text.includes("--harness") && text.includes(h.id), "launch line names script and harness");
    assert.ok(text.includes("keep"), "foreign config preserved");
    assert.equal(installHarness(h.id, { ...opts, mcp: true }, root).ok, true, "idempotent");
    assert.equal(text.split("agent-mesh").length, readFileSync(mcp.targetPath, "utf8").split("agent-mesh").length, "no duplicate entries");

    assert.equal(uninstallHarness(h.id, opts, root).ok, true);
    assert.equal(diagnoseMcp(h.id, opts, root).installed, false);
    assert.ok(readFileSync(mcp.targetPath, "utf8").includes("keep"), "foreign config survives uninstall");
  });

  await t.test("name resolution from fixture (and null for an unknown session)", () => {
    if (!h.name?.resolve) return;
    const saved = { agy: process.env.MESH_AGY_DB, codex: process.env.MESH_CODEX_DB };
    try {
      const { ctx, expected } = h.fixtures.name.setup(mkdtempSync(join(tmpdir(), `mesh-contract-name-${h.id}-`)));
      assert.equal(h.name.resolve(ctx), expected);
      assert.equal(h.name.resolve({ sessionId: "no-such-session-xyz" }), null);
    } finally {
      for (const [k, v] of [["MESH_AGY_DB", saved.agy], ["MESH_CODEX_DB", saved.codex]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  await t.test("rename payload updates the name and announces exactly once", async () => {
    const sid = `${h.id}-rename`;
    await send({ harness: h.id, sessionId: sid, event: "start", pid: process.pid });
    await send({ harness: h.id, sessionId: sid, event: "rename", pid: process.pid, name: "renamed by contract" });
    const row = (await live()).find((s) => s.session_id === sid);
    assert.equal(row?.name, "renamed by contract");
    assert.equal(notified.filter((n) => n.sessionId === sid && n.event === "renamed").length, 1);
  });

  await t.test("end signals close the session", async () => {
    if (h.end.signals.includes("event")) {
      const sid = `${h.id}-end-event`;
      await send({ harness: h.id, sessionId: sid, event: "start", pid: process.pid });
      await send({ harness: h.id, sessionId: sid, event: "end", pid: process.pid });
      assert.equal((await live()).find((s) => s.session_id === sid), undefined);
    }
    if (h.end.signals.includes("pid")) {
      const sid = `${h.id}-end-pid`;
      const kid = alive();
      try {
        await send({ harness: h.id, sessionId: sid, event: "start", pid: kid.pid });
        assert.ok((await live()).some((s) => s.session_id === sid));
        kid.kill();
        await sleep(300);
        broker.reapStaleLeases();
        assert.equal((await live()).find((s) => s.session_id === sid), undefined);
        assert.ok(notified.some((n) => n.sessionId === sid && n.event === "killed"));
      } finally {
        kid.kill();
      }
    }
  });

  await t.test("TUI classification", () => {
    if (!h.process) return;
    const { interactive, background } = h.fixtures.tui;
    for (const c of interactive) assert.equal(h.process.isInteractiveTui(c), true, c);
    for (const c of background) assert.equal(h.process.isInteractiveTui(c), false, c);
  });

  await t.test("hook process classification", () => {
    for (const { cmd, background, sharedHost } of h.fixtures?.cmdlines ?? []) {
      assert.deepEqual((h.classifyProcess ?? classifyCmdline)(cmd), { background, sharedHost }, cmd);
    }
  });
}

for (const h of registry.all()) {
  test(`contract: ${h.id}`, (t) => runContract(t, h));
}

test("a fake harness registers in a few lines and passes the same contract", async (t) => {
  const names = new Map([["fake-fixture", "fake name"]]);
  const fake = {
    id: "fakeharness",
    aliases: ["fk"],
    displayName: "Fake",
    discovery: { binaries: [], markers: () => [], projectDir: ".fake" },
    presence: [{
      kind: "plugin",
      script: "pi-presence-extension.mjs",
      resolvePaths: ({ root }) => ({ targetPath: join(root, "fake.cfg") }),
      install: (p) => (writeFileSync(p.targetPath, "x"), { ok: true, modified: true }),
      uninstall: (p) => (writeFileSync(p.targetPath, ""), { ok: true, modified: true }),
      diagnose: (p) => ({ harness: "fakeharness", targetPath: p.targetPath, status: "", installed: readFileSync(p.targetPath, "utf8") === "x" }),
    }],
    pid: "direct",
    name: { resolve: ({ sessionId }) => names.get(sessionId) ?? null },
    end: { signals: ["event", "pid"] },
    fixtures: { name: { setup: () => ({ ctx: { sessionId: "fake-fixture" }, expected: "fake name" }) } },
  };
  const dispose = registry.register(fake);
  try {
    assert.equal(registry.get("fk"), fake);
    assert.throws(() => registry.register({ ...fake }), /already registered/);
    await runContract(t, fake);
  } finally {
    dispose();
  }
  assert.equal(registry.get("fakeharness"), undefined);
});

test("registry ids and aliases are unique across all descriptors", () => {
  const names = registry.all().flatMap((h) => [h.id, ...h.aliases]);
  assert.equal(new Set(names).size, names.length);
});
