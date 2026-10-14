import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MESH_SILENT = "1"; // tests must never raise desktop notifications
process.env.MESH_HOME = mkdtempSync(join(tmpdir(), "mesh-test-home-"));

const { AgentMeshBroker } = await import("../src/broker.mjs");
const { sendIpcRequest } = await import("../src/ipc.mjs");
const { resolveSessionName } = await import("../src/hooks/common.mjs");

test("resolveSessionName prefers custom-title over ai-title in Claude transcripts", () => {
  const p = join(process.env.MESH_HOME, "t.jsonl");
  writeFileSync(
    p,
    [
      JSON.stringify({ type: "ai-title", aiTitle: "Auto title" }),
      JSON.stringify({ type: "custom-title", customTitle: "My name" }),
    ].join("\n")
  );
  assert.equal(resolveSessionName("claude", "s1", { transcript_path: p }), "My name");
});

test("broker stores session name and announces renames (not initial naming)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-name-"));
  const broker = new AgentMeshBroker(dir, { version: "9.9.9-test" });
  const notified = [];
  broker.notifyDesktop = (p) => notified.push(p);
  await broker.start();
  try {
    const send = (event, name) =>
      sendIpcRequest(broker.ipcAddress, {
        action: "session_event",
        payload: { harness: "claude", sessionId: "named-1", event, pid: process.pid, cwd: dir, origin: "interactive", name },
      });
    await send("start", "first");
    assert.equal(notified.filter((n) => n.event === "renamed").length, 0, "initial naming is silent");
    await send("busy", "second");
    const r = notified.find((n) => n.event === "renamed");
    assert.ok(r && r.state.includes("second"), "rename must notify");
    const st = await sendIpcRequest(broker.ipcAddress, { action: "status" });
    assert.equal(st.liveSessions.find((s) => s.session_id === "named-1").name, "second");
  } finally {
    await broker.stop();
  }
});
