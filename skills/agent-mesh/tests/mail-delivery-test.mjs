/**
 * Mail delivery: queued messages must reach a running session through each harness's delivery path, never
 * stay claimed, and raise a "message waiting" toast when nothing can wake an idle TUI.
 * Isolated broker + MESH_HOME, hooks run as child processes against it, no real notifications.
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
const registry = await import("../src/harnesses/index.mjs");

const SRC = join(import.meta.dirname, "..", "src");
const DRIVER = join(import.meta.dirname, "fixtures", "inprocess-driver.mjs");
const dir = mkdtempSync(join(tmpdir(), "mesh-mail-"));
const broker = new AgentMeshBroker(dir, { version: "9.9.9-test" });
const toasts = [];
broker.notifyDesktop = (p) => toasts.push(p);
await broker.start();
after(() => broker.stop());

const call = (payload) => sendIpcRequest(broker.ipcAddress, payload);
const childEnv = (extra = {}) => ({
  ...process.env,
  MESH_IPC_ADDRESS: broker.ipcAddress,
  MESH_NO_PID_WALK: "1",
  MESH_SILENT: "1",
  ...extra,
});
// each live session of a harness needs its own pid (a pid owns one row)
const session = (harness, sessionId, name, pid = process.pid) =>
  call({ action: "session_event", payload: { harness, sessionId, event: "start", pid, cwd: dir, origin: "interactive", name } });
const send = (to, body, from = "tester") => call({ action: "send", payload: { from, to, body, kind: "notify" } });
const pending = async (agent) => (await call({ action: "inbox", payload: { agent } })).messages;
const delivered = async (agent) => (await call({ action: "inbox", payload: { agent, delivered: true } })).messages;
const claimAndAck = async (agent, sessionId = null) => {
  const r = await call({ action: "claim_inbox", payload: { agent, sessionId } });
  await call({ action: "ack", payload: { ids: r.messages.map((m) => m.id) } });
  return r.messages;
};

/** Runs a child script, resolves { code, stdout } (stderr ignored). */
function run(script, args, { stdin, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: childEnv(env), stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("exit", (code) => resolve({ code, stdout }));
    child.stdin.end(stdin === undefined ? "" : JSON.stringify(stdin));
  });
}
const runHook = (script, args, payload, env) => run(join(SRC, "hooks", script), args, { stdin: payload, env });
const lastJson = (stdout) => JSON.parse(stdout.trim().split("\n").filter(Boolean).pop());

test("descriptors declare how mail reaches them (hook harnesses cannot wake an idle TUI)", () => {
  for (const h of registry.all()) {
    assert.ok(["inject", "toast-only"].includes(h.delivery.idle), h.id);
    assert.ok(h.delivery.inject.length > 0, h.id);
  }
  assert.equal(registry.get("claude").delivery.idle, "toast-only");
  assert.equal(registry.get("opencode").delivery.idle, "inject");
  assert.equal(registry.get("pi").delivery.idle, "inject");
});

test("idle interactive hook harness: message stays pending and a 'message waiting' toast is raised (floor)", async () => {
  await session("claude", "claude-idle-1", "my-claude");
  await send("claude", "wake up");
  assert.equal((await pending("claude")).length, 1, "nothing consumes it while the TUI is idle");
  const waiting = toasts.filter((t) => t.event === "waiting" && t.harness === "claude");
  assert.equal(waiting.length, 1);
  assert.match(waiting[0].state, /my-claude/);
  await send("claude", "second"); // throttled: one toast per target session within the window
  assert.equal(toasts.filter((t) => t.event === "waiting" && t.harness === "claude").length, 1);
  await claimAndAck("claude", "claude-idle-1");
});

test("session addressing: agent@<name> and agent@<id-prefix> resolve to the live session id", async () => {
  await session("codex", "019a-codex-thread-aaaa", "refactor-task");
  await session("codex", "019b-codex-thread-bbbb", "other-task", process.ppid);
  assert.ok((await send("codex@refactor-task", "by name")).ok);
  await send("codex@019b-codex", "by prefix");
  const msgs = await pending("codex");
  assert.deepEqual(
    msgs.map((m) => [m.body, m.to_session]).sort(),
    [["by name", "019a-codex-thread-aaaa"], ["by prefix", "019b-codex-thread-bbbb"]]
  );
  // each session only claims its own mail
  assert.deepEqual((await claimAndAck("codex", "019a-codex-thread-aaaa")).map((m) => m.body), ["by name"]);
  assert.deepEqual((await claimAndAck("codex", "019b-codex-thread-bbbb")).map((m) => m.body), ["by prefix"]);
});

test("claude/codex UserPromptSubmit hook injects additionalContext and acks", async () => {
  for (const [harness, args] of [["claude", []], ["codex", ["--harness", "codex"]]]) {
    const sid = `${harness}-ups-session`;
    await session(harness, sid, `${harness}-ups`);
    await send(harness, `hello ${harness} via prompt`);
    const { code, stdout } = await runHook("presence-hook.mjs", args, { hook_event_name: "UserPromptSubmit", session_id: sid, cwd: dir });
    assert.equal(code, 0);
    const out = lastJson(stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`hello ${harness} via prompt`));
    assert.equal((await pending(harness)).length, 0);
    assert.ok((await delivered(harness)).some((m) => m.body.includes(`hello ${harness} via prompt`)), "acked, not left claimed");
  }
});

test("antigravity PreInvocation hook injects a userMessage step", async () => {
  const sid = "agy-conv-1";
  await session("antigravity", sid, "agy-one");
  await send("agy", "hello agy mid-turn"); // alias resolves to antigravity
  const first = await runHook("agy-presence-hook.mjs", ["--event", "PreInvocation"], { conversationId: sid, invocationNum: 1, workspacePaths: [dir] });
  assert.match(lastJson(first.stdout).injectSteps[0].userMessage, /hello agy mid-turn/);
  assert.equal((await pending("antigravity")).length, 0);
  const second = await runHook("agy-presence-hook.mjs", ["--event", "PreInvocation"], { conversationId: sid, invocationNum: 2, workspacePaths: [dir] });
  assert.deepEqual(lastJson(second.stdout), {});
});

test("opencode plugin wakes the idle session with promptAsync and acks; a failed injection is released", async () => {
  const drive = async (extra) => JSON.parse((await run(DRIVER, ["opencode", "ses_test1"], { env: extra })).stdout.trim().split("\n").pop());
  // an interactive owner must exist, otherwise the broker would dispatch a real headless turn
  await session("opencode", "oc-owner", "oc-owner");
  await send("opencode", "hi opencode");
  const calls = await drive({});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "ses_test1");
  assert.match(calls[0].text, /hi opencode/);
  assert.equal((await pending("opencode")).length, 0);

  await send("opencode", "retry me");
  assert.deepEqual(await drive({ FAIL_FIRST: "1", WAIT_MS: "300" }), [], "first injection failed");
  assert.ok((await pending("opencode")).some((m) => m.body === "retry me"), "claim released, message still deliverable");
  assert.match((await drive({}))[0].text, /retry me/);
});

test("pi extension injects with sendUserMessage(followUp) and acks", async () => {
  await session("pi", "pi-owner", "pi-owner");
  await send("pi", "hi pi");
  const calls = JSON.parse((await run(DRIVER, ["pi", "pi-session-1"])).stdout.trim().split("\n").pop());
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /hi pi/);
  assert.deepEqual(calls[0].opts, { deliverAs: "followUp" });
  assert.equal((await pending("pi")).length, 0);
});

test("claims that are never acked go back to pending (no ticket stays claimed)", async () => {
  await send("claude", "orphan claim");
  const claim = await call({ action: "claim_inbox", payload: { agent: "claude", sessionId: null } });
  assert.ok(claim.messages.length >= 1);
  assert.equal((await pending("claude")).length, 0, "claimed rows are not pending");
  // age the claim past the TTL, as if the hook died before acking
  broker.repo.db.prepare("UPDATE messages SET delivered_at = ? WHERE status = 'claimed'").run(Date.now() - 10 * 60 * 1000);
  broker.reapStaleLeases();
  assert.ok((await pending("claude")).some((m) => m.body === "orphan claim"));
  // explicit release path
  const again = await call({ action: "claim_inbox", payload: { agent: "claude", sessionId: null } });
  await call({ action: "release_claim", payload: { ids: again.messages.map((m) => m.id) } });
  assert.ok((await pending("claude")).some((m) => m.body === "orphan claim"));
  await claimAndAck("claude");
});

test("MCP tool results carry a 'you have mail' hint while mail is waiting", async () => {
  await send("opencode", "mail for mcp user"); // opencode owner session registered above
  const child = spawn(process.execPath, [join(SRC, "mcp", "mesh-mcp.mjs"), "--harness", "opencode"], {
    env: childEnv({ MESH_AGENT: "1" }),
    stdio: ["pipe", "pipe", "ignore"],
  });
  let buf = "";
  const replies = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      replies.get(m.id)?.(m);
    }
  });
  const rpc = (id, method, params) =>
    new Promise((res) => {
      replies.set(id, res);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await rpc(1, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "opencode" } });
  const status = await rpc(2, "tools/call", { name: "mesh_status", arguments: {} });
  assert.ok(status.result.content.some((c) => /1 message\(s\) waiting.*mesh_inbox/.test(c.text)));
  const inbox = await rpc(3, "tools/call", { name: "mesh_inbox", arguments: {} });
  assert.match(inbox.result.content[0].text, /mail for mcp user/);
  assert.equal(inbox.result.content.length, 1, "no hint on mesh_inbox itself");
  child.stdin.end();
  await new Promise((r) => child.on("exit", r));
});

test("a session name used as the target routes to that session's harness (and orphaned mail is re-addressed)", async () => {
  await session("codex", "019c-codex-thread-cccc", "named-target", process.ppid);
  assert.ok((await send("named-target", "to a session name")).ok);
  assert.deepEqual((await pending("codex")).map((m) => [m.body, m.to_session]), [["to a session name", "019c-codex-thread-cccc"]]);
  await claimAndAck("codex", "019c-codex-thread-cccc");

  // mail queued earlier under the bare session name (before this routing existed)
  broker.repo.enqueueMessage({
    id: "msg-orphan-1", conversationId: "c", from: "tester", to: "named-target", kind: "notify", priority: 0, hops: 0, body: "orphan by name",
  });
  assert.equal((await pending("named-target")).length, 1);
  broker.reapStaleLeases();
  assert.equal((await pending("named-target")).length, 0);
  assert.deepEqual((await claimAndAck("codex", "019c-codex-thread-cccc")).map((m) => m.body), ["orphan by name"]);
});
