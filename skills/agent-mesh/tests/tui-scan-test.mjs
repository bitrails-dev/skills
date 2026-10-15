import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

process.env.MESH_SILENT = "1"; // tests must never raise desktop notifications
process.env.MESH_HOME = mkdtempSync(join(tmpdir(), "mesh-test-home-"));

const { AgentMeshBroker } = await import("../src/broker.mjs");
const { sendIpcRequest } = await import("../src/ipc.mjs");

const alive = () => spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("TUI scanner: provisional session on app open, hook binds it, exit closes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-tui-"));
  const kids = [alive(), alive(), alive(), alive()];
  const [daemonPid, tuiPid, helperPid, agyPid] = kids.map((k) => k.pid);
  let procs = [];
  const info = {
    [daemonPid]: { ppid: 1, cmd: '"codex.exe" app-server --listen unix:// --managed-daemon' },
    [tuiPid]: { ppid: 2, cmd: '"C:/x/codex.exe"' },
    [helperPid]: { ppid: 2, cmd: '"C:/x/agy.exe" -p "do work"' },
    [agyPid]: { ppid: 2, cmd: '"C:/x/agy.exe"' },
  };
  const broker = new AgentMeshBroker(dir, {
    version: "9.9.9-test",
    processSource: async () => procs,
    processInfo: async (pid) => info[pid] ?? null,
  });
  const notified = [];
  broker.notifyDesktop = (p) => notified.push(p);
  await broker.start();
  const scan = async () => {
    while (broker.scanning) await sleep(5);
    await broker.scanTuiProcesses();
  };
  const live = (h) => broker.repo.listLiveSessions().filter((s) => s.harness === h);
  const send = (payload) => sendIpcRequest(broker.ipcAddress, { action: "session_event", payload: { cwd: dir, origin: "interactive", ...payload } });
  try {
    await scan(); // first scan (nothing running): from now on starts are announced
    procs = [
      { pid: daemonPid, name: "codex.exe" },
      { pid: tuiPid, name: "codex.exe" },
      { pid: helperPid, name: "agy.exe" },
      { pid: agyPid, name: "agy.exe" },
      { pid: 4, name: "node.exe" },
    ];
    await scan();
    assert.deepEqual(live("codex").map((s) => s.pid), [tuiPid], "only the TUI is registered, not app-server");
    assert.equal(live("antigravity").length, 1, "agy -p helper ignored");
    assert.equal(notified.filter((n) => n.event === "start" && n.force).length, 2, "one start toast per TUI");

    // Codex hook (no pid) binds to the TUI: one row, real id, TUI pid, no second start toast
    const r = await send({ harness: "codex", sessionId: "thread-1", event: "start", pid: null, name: "my task" });
    assert.equal(r.bound, true);
    assert.deepEqual(live("codex").map((s) => [s.session_id, s.pid]), [["thread-1", tuiPid]]);
    await send({ harness: "codex", sessionId: "thread-1", event: "idle", pid: null });
    assert.equal(live("codex")[0].pid, tuiPid, "null hook pid must not wipe the TUI pid");

    // agy hook resolving the TUI pid supersedes the provisional row
    const a = await send({ harness: "antigravity", sessionId: "conv-1", event: "start", pid: agyPid });
    assert.equal(a.bound, true);
    assert.deepEqual(live("antigravity").map((s) => [s.session_id, s.pid]), [["conv-1", agyPid]]);

    // TUI exits (Codex /exit): PID watcher closes the row and announces it
    kids[1].kill();
    await sleep(300);
    procs = procs.filter((p) => p.pid !== tuiPid);
    broker.reapStaleLeases();
    assert.equal(live("codex").length, 0);
    assert.ok(notified.some((n) => n.event === "killed" && n.pid === tuiPid));
    // a stray app-server task event must not resurrect the closed row
    await send({ harness: "codex", sessionId: "thread-1", event: "busy", pid: null });
    assert.equal(live("codex").length, 0);
    await scan();
    assert.equal(broker.tuiSeen.has(tuiPid), false);
  } finally {
    await broker.stop?.();
    kids.forEach((k) => k.kill());
  }
});
