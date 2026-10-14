import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.MESH_SILENT = "1"; // tests must never raise desktop notifications
process.env.MESH_HOME = mkdtempSync(join(tmpdir(), "mesh-test-home-"));
const agyDb = join(process.env.MESH_HOME, "agy.db");
const codexDb = join(process.env.MESH_HOME, "codex.db");
process.env.MESH_AGY_DB = agyDb;
process.env.MESH_CODEX_DB = codexDb;

const { AgentMeshBroker } = await import("../src/broker.mjs");
const { sendIpcRequest } = await import("../src/ipc.mjs");
const { resolveSessionName } = await import("../src/hooks/common.mjs");

function mkdb(path, sql) {
  const db = new DatabaseSync(path);
  db.exec(sql);
  return db;
}
const agy = mkdb(
  agyDb,
  "CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '', preview text NOT NULL DEFAULT '', status text NOT NULL DEFAULT '', last_modified_time text);" +
    "INSERT INTO conversation_summaries (conversation_id, title, preview) VALUES ('a1','Titled','Prev'),('a2','','Only preview');"
);
const codex = mkdb(
  codexDb,
  "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', name TEXT, updated_at INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER, archived INTEGER NOT NULL DEFAULT 0);" +
    "INSERT INTO threads (id, title) VALUES ('zz-test-codex-thread-0001','first title');"
);

test("agy title resolution prefers title, falls back to preview, null when unknown", () => {
  assert.equal(resolveSessionName("antigravity", "a1"), "Titled");
  assert.equal(resolveSessionName("antigravity", "a2"), "Only preview");
  assert.equal(resolveSessionName("antigravity", "nope"), null);
});

test("broker handles pi/opencode rename payloads and ignores unknown-session renames", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-hn-"));
  const broker = new AgentMeshBroker(dir, { version: "9.9.9-test" });
  const notified = [];
  broker.notifyDesktop = (p) => notified.push(p);
  await broker.start();
  try {
    const send = (harness, sessionId, event, name) =>
      sendIpcRequest(broker.ipcAddress, {
        action: "session_event",
        payload: { harness, sessionId, event, pid: process.pid, cwd: dir, origin: "interactive", name },
      });
    const st = async () => (await sendIpcRequest(broker.ipcAddress, { action: "status" })).liveSessions;

    await send("pi", "ghost", "rename", "x");
    assert.equal((await st()).find((s) => s.session_id === "ghost"), undefined, "no phantom session");

    await send("pi", "pi-1", "start");
    await send("pi", "pi-1", "rename", "pi renamed");
    assert.equal((await st()).find((s) => s.session_id === "pi-1").name, "pi renamed");
    assert.ok(notified.some((n) => n.event === "renamed" && n.state.includes("pi renamed")));

    await send("opencode", "oc-1", "start", "oc first");
    await send("opencode", "oc-1", "rename", "oc second");
    assert.equal((await st()).find((s) => s.session_id === "oc-1").name, "oc second");
    await send("opencode", "oc-1", "end");
    assert.equal((await st()).find((s) => s.session_id === "oc-1"), undefined, "end closes the session");
  } finally {
    await broker.stop();
  }
});

test("broker polls agy titles and codex threads for live sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-hp-"));
  const broker = new AgentMeshBroker(dir, { version: "9.9.9-test" });
  const notified = [];
  broker.notifyDesktop = (p) => notified.push(p);
  await broker.start();
  try {
    const send = (harness, sessionId, event, pid) =>
      sendIpcRequest(broker.ipcAddress, {
        action: "session_event",
        payload: { harness, sessionId, event, pid, cwd: dir, origin: "interactive" },
      });
    const live = async () => (await sendIpcRequest(broker.ipcAddress, { action: "status" })).liveSessions;
    await send("antigravity", "a1", "start", process.pid);
    await send("codex", "zz-test-codex-thread-0001", "start", null);
    broker.watchExternalSessions();
    let l = await live();
    assert.equal(l.find((s) => s.session_id === "a1").name, "Titled");
    assert.equal(l.find((s) => s.session_id === "zz-test-codex-thread-0001").name, "first title");

    agy.exec("UPDATE conversation_summaries SET title='Retitled' WHERE conversation_id='a1'");
    codex.exec("UPDATE threads SET name='codex renamed' WHERE id='zz-test-codex-thread-0001'");
    broker.watchExternalSessions();
    l = await live();
    assert.equal(l.find((s) => s.session_id === "a1").name, "Retitled");
    assert.equal(l.find((s) => s.session_id === "zz-test-codex-thread-0001").name, "codex renamed");
    assert.equal(notified.filter((n) => n.event === "renamed" && n.state.includes("Retitled")).length, 1);

    codex.exec("UPDATE threads SET archived=1 WHERE id='zz-test-codex-thread-0001'");
    broker.watchExternalSessions();
    assert.equal((await live()).find((s) => s.session_id === "zz-test-codex-thread-0001"), undefined, "archived thread closes session");
  } finally {
    await broker.stop();
  }
});
