// Drives the OpenCode plugin / Pi extension in a child process with a fake harness API and prints the
// injections as JSON. argv: opencode|pi <sessionId>. Env: MESH_IPC_ADDRESS, MESH_HOME, MESH_SILENT.
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const [kind, sessionId] = process.argv.slice(2);
const root = join(import.meta.dirname, "..", "..", "src", "hooks");
const calls = [];
const badges = []; // BADGES=1: printed instead of the injection list
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (kind === "opencode") {
  const mod = await import(pathToFileURL(join(root, "opencode-presence-plugin.mjs")).href);
  const failFirst = process.env.FAIL_FIRST === "1";
  let n = 0;
  const client = {
    tui: { showToast: async (arg) => void badges.push({ kind: "toast", text: arg.body.message }) },
    session: {
      async promptAsync(arg) {
        n++;
        if (failFirst && n === 1) throw new Error("injection failed");
        calls.push({ id: arg.path.id, text: arg.body.parts[0].text });
      },
    },
  };
  const hooks = await mod.default({ directory: process.cwd(), client });
  await hooks.event({ event: { type: "session.created", properties: { info: { id: sessionId, directory: process.cwd(), title: "oc" } } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } });
  await sleep(Number(process.env.WAIT_MS || 600));
  await hooks.event({ event: { type: "server.instance.disposed", properties: {} } });
} else {
  const mod = await import(pathToFileURL(join(root, "pi-presence-extension.mjs")).href);
  const handlers = {};
  const pi = {
    on: (name, fn) => { handlers[name] = fn; },
    getSessionName: () => sessionId,
    sendUserMessage: (text, opts) => calls.push({ text, opts }),
  };
  const ctx = { ui: { setStatus: (key, text) => badges.push({ kind: "status", key, text }) } };
  mod.default(pi);
  await handlers.session_start({ sessionId }, ctx);
  await handlers.agent_end({ sessionId }, ctx);
  await sleep(Number(process.env.WAIT_MS || 600));
  await handlers.session_shutdown({ reason: "quit" });
}
console.log(JSON.stringify(process.env.BADGES === "1" ? badges : calls));
process.exit(0);
