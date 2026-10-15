/**
 * Mesh identity: broker `whoami`, formatters, SessionStart badges (per descriptor channel), the MCP
 * mesh_whoami tool + initialize instructions, in-process badges (Pi status / OpenCode toast), `mesh whoami`.
 * Isolated broker, silent.
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
const identity = await import("../src/presence/identity.mjs");

const SRC = join(import.meta.dirname, "..", "src");
const CLI = join(import.meta.dirname, "..", "scripts", "mesh.mjs");
const DRIVER = join(import.meta.dirname, "fixtures", "inprocess-driver.mjs");
const dir = mkdtempSync(join(tmpdir(), "mesh-id-"));
const broker = new AgentMeshBroker(dir, { version: "9.9.9-test" });
broker.notifyDesktop = () => {};
await broker.start();
after(() => broker.stop());

const call = (payload) => sendIpcRequest(broker.ipcAddress, payload);
const env = (extra = {}) => ({ ...process.env, MESH_IPC_ADDRESS: broker.ipcAddress, MESH_NO_PID_WALK: "1", MESH_SILENT: "1", ...extra });
const session = (harness, sessionId, name, pid = process.pid, cwd = dir) =>
  call({ action: "session_event", payload: { harness, sessionId, event: "start", pid, cwd, origin: "interactive", name } });
const run = (script, args, { stdin, e } = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: env(e), stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("exit", (code) => resolve({ code, stdout }));
    child.stdin.end(stdin === undefined ? "" : JSON.stringify(stdin));
  });
const lastJson = (stdout) => JSON.parse(stdout.trim().split("\n").filter(Boolean).pop());

test("descriptors declare an identity channel; hook-output ones declare the SessionStart shape", () => {
  for (const h of registry.all()) {
    const idn = h.ui.identity;
    assert.ok(["hook-output", "toast", "status", "none"].includes(idn.channel), h.id);
    if (idn.channel === "hook-output") assert.ok(["system-message+context", "context", "inject-steps"].includes(idn.sessionStart), h.id);
  }
  assert.equal(registry.get("pi").ui.identity.channel, "status");
  assert.equal(registry.get("opencode").ui.identity.channel, "toast");
});

test("broker whoami resolves by session id, name, id prefix, pid and cwd; counts peers and inbox", async () => {
  await session("claude", "claude-id-aaaa1111", "refactor-auth", process.pid);
  await session("claude", "claude-id-bbbb2222", "other-work", process.ppid, join(dir, "other"));
  await session("codex", "codex-id-cccc3333", "codex-one", process.pid);
  await call({ action: "send", payload: { from: "tester", to: "claude@refactor-auth", body: "hi", kind: "notify" } });

  const byId = await call({ action: "whoami", payload: { harness: "claude", sessionId: "claude-id-aaaa1111" } });
  assert.equal(byId.session.name, "refactor-auth");
  assert.equal(byId.session.harness, "claude");
  assert.equal(byId.peers, 2);
  assert.equal(byId.inbox, 1);
  assert.equal(byId.version, "9.9.9-test");
  assert.equal(byId.wake.tier, "pull");
  assert.equal(byId.muted, false);
  assert.ok("hooks" in byId.components && "mcp" in byId.components);

  assert.equal((await call({ action: "whoami", payload: { harness: "claude", sessionId: "refactor-auth" } })).session.id, "claude-id-aaaa1111");
  assert.equal((await call({ action: "whoami", payload: { harness: "claude", sessionId: "claude-id-bbbb" } })).session.name, "other-work");
  assert.equal((await call({ action: "whoami", payload: { harness: "claude", pid: process.ppid } })).session.name, "other-work");
  assert.equal((await call({ action: "whoami", payload: { cwd: join(dir, "other") } })).session.id, "claude-id-bbbb2222");
  const none = await call({ action: "whoami", payload: { harness: "claude", sessionId: "nope" } });
  assert.equal(none.session, null);

  await call({ action: "mute" });
  assert.equal((await call({ action: "whoami", payload: { harness: "claude", sessionId: "claude-id-aaaa1111" } })).muted, true);
  await call({ action: "unmute" });
});

test("formatters: line, block, and SessionStart output per descriptor mode", () => {
  const info = {
    harness: "claude",
    session: { id: "claude-id-aaaa1111", name: "refactor-auth", harness: "claude", pid: 42, cwd: "/p", origin: "interactive", state: "idle" },
    peers: 2,
    inbox: 1,
    muted: true,
    version: "1.3.0",
    wake: { tier: "pull", candidate: "oneshot" },
    components: { hooks: true, mcp: false, wake: null },
  };
  const line = identity.formatIdentityLine(info);
  assert.match(line, /^agent-mesh: refactor-auth \(claude-i…\) · claude · 2 peers · inbox 1 · wake muted$/);
  const block = identity.formatIdentityBlock(info);
  assert.match(block, /Wake tier: pull \(opt-in available: oneshot\)/);
  assert.match(block, /hooks\/plugin yes, mcp no, wake n\/a/);
  const sm = identity.sessionStartOutput("system-message+context", info);
  assert.equal(sm.systemMessage, line);
  assert.match(sm.hookSpecificOutput.additionalContext, /untrusted data/);
  assert.equal(identity.sessionStartOutput("context", info).systemMessage, undefined);
  assert.ok(identity.sessionStartOutput("inject-steps", info).injectSteps[0].systemMessage.systemMessage.includes("refactor-auth"));
  assert.equal(identity.sessionStartOutput("none", info), null);
  assert.match(identity.formatIdentityLine({ harness: "pi" }), /not registered yet/);
});

test("SessionStart hooks print the badge in the shape the descriptor declares; MESH_NO_BADGE silences it", async () => {
  const hook = join(SRC, "hooks", "presence-hook.mjs");
  const claude = await run(hook, [], { stdin: { hook_event_name: "SessionStart", session_id: "badge-claude-1", cwd: dir } });
  const out = lastJson(claude.stdout);
  assert.match(out.systemMessage, /^agent-mesh: /);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /session '/);

  const codex = lastJson((await run(hook, ["--harness", "codex"], { stdin: { hook_event_name: "SessionStart", session_id: "badge-codex-1", cwd: dir } })).stdout);
  assert.ok(codex.systemMessage && codex.hookSpecificOutput.additionalContext);

  const muse = lastJson((await run(hook, ["--harness", "muse"], { stdin: { hook_event_name: "SessionStart", session_id: "badge-muse-1", cwd: dir } })).stdout);
  assert.equal(muse.systemMessage, undefined, "muse: context only");
  assert.ok(muse.hookSpecificOutput.additionalContext);

  const quiet = await run(hook, [], { stdin: { hook_event_name: "SessionStart", session_id: "badge-claude-2", cwd: dir }, e: { MESH_NO_BADGE: "1" } });
  assert.equal(quiet.stdout.trim(), "");

  const agy = lastJson((await run(join(SRC, "hooks", "agy-presence-hook.mjs"), ["--event", "SessionStart"], { stdin: { conversationId: "badge-agy-1", workspacePaths: [dir] } })).stdout);
  assert.match(agy.injectSteps[0].systemMessage.systemMessage, /agent-mesh/);
});

async function mcp(harness, extraEnv, fn) {
  const child = spawn(process.execPath, [join(SRC, "mcp", "mesh-mcp.mjs"), "--harness", harness], { env: env(extraEnv), stdio: ["pipe", "pipe", "ignore"] });
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
  let id = 0;
  const rpc = (method, params) =>
    new Promise((res) => {
      const rid = ++id;
      replies.set(rid, res);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: rid, method, params })}\n`);
    });
  try {
    return await fn(rpc);
  } finally {
    child.stdin.end();
    await new Promise((r) => child.on("exit", r));
  }
}

test("MCP: initialize carries short static instructions; mesh_whoami and mesh_status show the identity", async () => {
  await session("pi", "pi-id-dddd4444", "pi-named", process.pid);
  await mcp("pi", { MESH_AGENT: "1" }, async (rpc) => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "pi" } });
    const text = init.result.instructions;
    assert.ok(text.split("\n").length <= 10, "short");
    assert.match(text, /mesh_whoami/);
    assert.match(text, /untrusted data/);
    assert.ok((await rpc("tools/list")).result.tools.some((t) => t.name === "mesh_whoami"));
    const who = (await rpc("tools/call", { name: "mesh_whoami", arguments: {} })).result.content[0].text;
    assert.match(who, /Mesh:\s+broker v9\.9\.9-test/);
  });
  // a shim that announces itself resolves to its own row (or the hook row with the same pid)
  await mcp("opencode", {}, async (rpc) => {
    await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "opencode" } });
    await rpc("tools/list"); // triggers the announce
    await new Promise((r) => setTimeout(r, 300));
    const who = (await rpc("tools/call", { name: "mesh_whoami", arguments: {} })).result.content[0].text;
    assert.match(who, /Harness:\s+opencode/);
    const status = (await rpc("tools/call", { name: "mesh_status", arguments: {} })).result.content[0].text;
    assert.match(status, /^agent-mesh: /);
  });
});

test("in-process badges: Pi footer status and OpenCode toast carry the identity line", async () => {
  await session("pi", "pi-badge-1", "pi-badge", process.pid);
  const pi = JSON.parse((await run(DRIVER, ["pi", "pi-badge-1"], { e: { BADGES: "1", WAIT_MS: "100" } })).stdout.trim().split("\n").pop());
  assert.ok(pi.some((b) => b.kind === "status" && b.key === "agent-mesh" && /^agent-mesh: /.test(b.text)));
  const oc = JSON.parse((await run(DRIVER, ["opencode", "ses_badge1"], { e: { BADGES: "1", WAIT_MS: "100" } })).stdout.trim().split("\n").pop());
  assert.ok(oc.some((b) => b.kind === "toast" && /^agent-mesh: /.test(b.text)));
  const off = JSON.parse((await run(DRIVER, ["pi", "pi-badge-1"], { e: { BADGES: "1", WAIT_MS: "100", MESH_NO_BADGE: "1" } })).stdout.trim().split("\n").pop());
  assert.deepEqual(off, []);
});

test("`mesh whoami` by session name, by --stdin JSON, and --line", async () => {
  // async spawn: the broker runs inside this process, so the event loop must stay free
  // a pid owns exactly one row per harness: give this session its own live pid
  const kid = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  await session("claude", "claude-cli-eeee5555", "refactor-auth", kid.pid);
  await session("claude", "claude-cli-ffff6666", "other-work", process.pid, dir);
  const named = await run(CLI, ["whoami", "--session", "refactor-auth", "--harness", "claude"]);
  assert.equal(named.code, 0, named.stdout);
  assert.match(named.stdout, /Session:\s+refactor-auth/);
  assert.match((await run(CLI, ["whoami", "--line", "--session", "refactor-auth"])).stdout, /^agent-mesh: refactor-auth/);
  const viaStdin = await run(CLI, ["whoami", "--line", "--stdin"], { stdin: { session_id: "claude-cli-ffff6666" } });
  assert.match(viaStdin.stdout, /^agent-mesh: other-work/);
  kid.kill();
  assert.equal((await run(CLI, ["whoami", "--session", "no-such"])).code, 1);
});
