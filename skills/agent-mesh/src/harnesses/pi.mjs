import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { writeLoader, backupOnce, removeFile, diagnoseResult, jsonMcpSource } from "./shared/install.mjs";

const ID = "pi";

/** Pi auto-discovers extensions matching *.js from its extensions directory. */
function install(p, script) {
  backupOnce(p.targetPath);
  writeLoader(p.targetPath, script, "Agent Mesh presence extension for Pi Coding Agent");
  return { ok: true, modified: true };
}

/** @type {import("./index.mjs").Harness} */
export default {
  id: ID,
  aliases: ["pi-coding-agent"],
  displayName: "Pi",
  discovery: {
    binaries: ["pi"],
    markers: (root) => [join(homedir(), ".pi"), join(root, ".pi")],
    projectDir: ".pi",
  },
  presence: [
    {
      kind: "extension",
      script: "pi-presence-extension.mjs",
      resolvePaths: ({ global, root }) => ({
        targetPath: join(
          global ? join(homedir(), ".pi", "agent", "extensions") : join(root, ".pi", "extensions"),
          "agent-mesh-presence.js"
        ),
      }),
      install,
      uninstall: (p) => ({ ok: true, modified: removeFile(p.targetPath) }),
      diagnose: (p) => diagnoseResult(ID, p.targetPath, existsSync(p.targetPath)),
    },
    jsonMcpSource({
      id: ID,
      // as written by `pi mcp add` (global) / `pi mcp add -l` (project, trusted projects only)
      resolvePaths: ({ global, root }) => ({
        targetPath: global ? join(homedir(), ".pi", "agent", "mcp.json") : join(root, ".pi", "mcp.json"),
      }),
    }),
  ],
  pid: "direct", // the extension runs inside the harness: process.pid is the harness
  name: { watch: { kind: "event" } }, // session_info_changed -> rename event
  end: { signals: ["event", "pid"] }, // session_shutdown (reason "quit")
  fixtures: {},
};
