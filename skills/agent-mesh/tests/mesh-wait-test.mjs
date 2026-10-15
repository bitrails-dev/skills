/**
 * `mesh wait` / `wait` IPC action: strict wake-eligible claims, debounce batching, single listener per
 * session, exits on harness death / session close, ack on flush. Isolated broker, silent.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

process.env.MESH_SILENT = "1";
process.env.MESH_HOME = mkdtempSync(join(tmpdir(), "mesh-test-home-"));

const { AgentMeshBroker } = await import("../src/broker.mjs");
const { sendIpcRequest } = await import("../src/ipc.mjs");
const { runWait } = await import("../src/wait/mesh-wait.mjs");

const MESH = join(import.meta.dirname, "..", "scripts", "mesh.mjs");
const dir = mkdtempSync(join(tmpdir(), "mesh-wait-"));
const broker = new AgentMeshBroker(dir, { version: "9.9.9-test", wake: { budget: 100 } });
broker.notifyDesktop = () => {};
await broker.start();
after(() => broker.stop());

const call = (payload) => sendIpcRequest(broker.ipcAddress, payload);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const session = (harness, sessionId, pid = process.pid) =>
  call({ action: "session_event", payload: { harness, sessionId, event: "start", pid, cwd: dir, origin: "interactive" } });
const send = (to, body, kind = "ask") => call({ action: "send", payload: { from: "tester", to, body, kind } });
const pending = async (agent) => (await call({ action: "inbox", payload: { agent } })).messages;
const wait = (opts) => {
  const out = [];
  const promise = runWait({ address: broker.ipcAddress, pollMs: 300, debounceMs: 100, throttleSleepMs: 50, out: async (t) => void out.push(t), ...opts });
  return { out, promise };
};

test("oneshot: blocks until an ask arrives, prints the enveloped mail, acks, exits with the mail exit code", async () => {
  await session("claude", "w-claude-1");
  const w = wait({ sessionId: "w-claude-1", agent: "claude", mailExitCode: 2, rearmCommand: "mesh wait --session w-claude-1" });
  await sleep(500); // listener is armed and idle
  await send("claude@w-claude-1", "please look at X");
  const res = await w.promise;
  assert.deepEqual([res.code, res.reason, res.delivered], [2, "mail", 1]);
  const text = w.out.join("");
  assert.match(text, /provenance="another-agent-untrusted"/);
  assert.match(text, /please look at X/);
  assert.match(text, /re-arm it: mesh wait --session w-claude-1/);
  assert.equal((await pending("claude")).length, 0);
  const delivered = (await call({ action: "inbox", payload: { agent: "claude", delivered: true } })).messages;
  assert.ok(delivered.some((m) => m.body === "please look at X"), "acked after flush");
});

test("notify mail does not wake a listener (waits for the next prompt)", async () => {
  await session("codex", "w-codex-1");
  await send("codex@w-codex-1", "fyi only", "notify");
  const w = wait({ sessionId: "w-codex-1", agent: "codex", maxWaitMs: 1000 });
  const res = await w.promise;
  assert.equal(res.reason, "max-wait");
  assert.equal(res.delivered, 0);
  assert.equal((await pending("codex")).length, 1, "still queued for the pull path");
});

test("debounce batches a burst into one delivery", async () => {
  await session("opencode", "w-oc-1");
  const w = wait({ sessionId: "w-oc-1", agent: "opencode", debounceMs: 800 });
  await sleep(400);
  await send("opencode@w-oc-1", "first");
  await sleep(100);
  await send("opencode@w-oc-1", "second");
  const res = await w.promise;
  assert.equal(res.delivered, 2);
  assert.equal(w.out.filter((t) => t.includes("AGENT-MESH INBOX")).length, 1, "one block for the burst");
});

test("single listener per session: a second waiter exits immediately", async () => {
  await session("pi", "w-pi-1");
  const first = wait({ sessionId: "w-pi-1", agent: "pi", maxWaitMs: 3000 });
  await sleep(500);
  const second = await new Promise((resolve) => {
    const child = spawn(process.execPath, [MESH, "wait", "--session", "w-pi-1", "--agent", "pi"], {
      env: { ...process.env, MESH_IPC_ADDRESS: broker.ipcAddress, MESH_SILENT: "1" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("exit", (code) => resolve({ code, stdout }));
  });
  assert.equal(second.code, 0);
  assert.match(second.stdout, /already armed/);
  await send("pi@w-pi-1", "release the first waiter");
  assert.equal((await first.promise).delivered, 1);
});

test("exits when the harness pid dies or the session closes", async () => {
  const kid = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  await session("antigravity", "w-agy-1", process.pid);
  const dies = wait({ sessionId: "w-agy-1", agent: "antigravity", harnessPid: kid.pid });
  await sleep(500);
  kid.kill();
  assert.equal((await dies.promise).reason, "harness-gone");

  await session("claude", "w-claude-closing");
  const closing = wait({ sessionId: "w-claude-closing", agent: "claude" });
  await sleep(400);
  await call({ action: "session_event", payload: { harness: "claude", sessionId: "w-claude-closing", event: "end", pid: process.pid } });
  assert.equal((await closing.promise).reason, "session-closed");
});

test("stream mode delivers one block per message burst until the session ends", async () => {
  await session("codex", "w-codex-stream");
  const w = wait({ sessionId: "w-codex-stream", agent: "codex", stream: true, debounceMs: 50 });
  await sleep(400);
  await send("codex@w-codex-stream", "one");
  await sleep(1200);
  await send("codex@w-codex-stream", "two");
  await sleep(1200);
  await call({ action: "session_event", payload: { harness: "codex", sessionId: "w-codex-stream", event: "end", pid: process.pid } });
  const res = await w.promise;
  assert.deepEqual([res.reason, res.delivered], ["session-closed", 2]);
  assert.equal(w.out.filter((t) => t.includes("AGENT-MESH INBOX")).length, 2);
});

test("a spent wake budget makes the waiter back off instead of consuming mail", async () => {
  await session("pi", "w-pi-budget");
  broker.wake.budget = 0;
  try {
    await send("pi@w-pi-budget", "over budget");
    const w = wait({ sessionId: "w-pi-budget", agent: "pi", maxWaitMs: 800 });
    assert.equal((await w.promise).delivered, 0);
    assert.equal((await pending("pi")).length, 1);
  } finally {
    broker.wake.budget = 100;
  }
});
