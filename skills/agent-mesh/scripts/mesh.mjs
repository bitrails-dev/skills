#!/usr/bin/env node
/**
 * @file mesh.mjs
 * @description Command-line interface for agent-mesh.
 * Provides controls for starting/stopping the daemon, checking status,
 * sending asynchronous messages, and watching live agent event streams.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { getIpcAddress, sendIpcRequest, findRepoRoot, resolveIpcAddress } from "../src/ipc.mjs";
import { spawnChild } from "../src/drivers/base.mjs";
import { ensureBroker, stopBroker, isProcessAlive, getBrokerInfo } from "../src/daemon.mjs";
import {
  installHarness,
  uninstallHarness,
  diagnoseHarness,
  autoDiscoverHarnesses,
  normalizeHarnessName,
  SUPPORTED_HARNESSES,
  installClaudeHooks,
  uninstallClaudeHooks,
  installAgyHooks,
  uninstallAgyHooks,
  resolveHookTargets,
} from "../src/hooks/installer.mjs";

/**
 * Parses harness targets and scope flags from command arguments.
 * Supports:
 * - Direct params: mesh --init agy,claude
 * - Space separated: mesh --init agy claude opencode
 * - Flag assignments: mesh --init=pi
 * - Scope flags: --project, --global (defaults to global)
 * @param {string} cmd
 * @param {string[]} rawArgs
 * @returns {{ harnesses: string[], isProject: boolean, isGlobal: boolean }}
 */
function parseHarnessSelection(cmd, rawArgs) {
  const isProject = rawArgs.includes("--project");
  const isGlobal = rawArgs.includes("--global") || !isProject;
  const filteredArgs = rawArgs.filter((a) => a !== "--project" && a !== "--global");

  const candidates = [];

  // Check inline value like --init=agy,claude or --install=pi
  if (cmd && cmd.includes("=")) {
    const inline = cmd.split("=")[1];
    if (inline) candidates.push(...inline.split(","));
  }

  // Check --harness flag
  const hIdx = filteredArgs.indexOf("--harness");
  if (hIdx !== -1 && filteredArgs[hIdx + 1]) {
    candidates.push(...filteredArgs[hIdx + 1].split(","));
    filteredArgs.splice(hIdx, 2);
  }

  // Check positional args after subcommand (e.g. mesh --init agy claude or mesh hooks doctor pi)
  for (const arg of filteredArgs) {
    if (!arg.startsWith("-")) {
      candidates.push(...arg.split(","));
    }
  }

  const normalized = candidates
    .map((c) => normalizeHarnessName(c))
    .filter((c) => SUPPORTED_HARNESSES.includes(c));

  return {
    harnesses: Array.from(new Set(normalized)),
    isProject,
    isGlobal,
  };
}

// C4: when invoked from inside an agent turn, inherit identity and hop budget
const meshAgent = process.env.MESH_AGENT || "human-cli";
const meshHops = Number(process.env.MESH_HOPS || 0);

const cwd = process.cwd();
const rootDir = findRepoRoot(cwd);
const meshDir = join(rootDir, ".agent-mesh");
const ipcAddress = resolveIpcAddress(rootDir);

async function main() {
  const [,, cmd, ...args] = process.argv;

  switch (cmd) {
    case "--init":
    case "--install":
    case "init":
    case "setup":
    case "install": {
      const { harnesses, isProject, isGlobal } = parseHarnessSelection(cmd, args);
      const scope = isGlobal ? "global" : "project";

      console.log(`\n==================================================`);
      console.log(`   AGENT MESH INITIALIZATION & REQUIREMENT SETUP  `);
      console.log(`==================================================\n`);

      let targets = harnesses;
      if (targets.length === 0) {
        targets = autoDiscoverHarnesses({ global: isGlobal }, rootDir);
        console.log(`[Auto-Discovery] Detected harnesses with skill: ${targets.join(", ") || "none"}`);
      } else {
        console.log(`[Targeted Harnesses] Configuring: ${targets.join(", ")}`);
      }

      if (targets.length === 0) {
        console.log(`(No active harnesses detected. Specify harness name after param, e.g. 'mesh --init claude,agy')`);
      }

      for (const h of targets) {
        const res = installHarness(h, { global: isGlobal }, rootDir);
        if (res.ok) {
          console.log(`[${res.harness.toUpperCase()}:${scope}] Presence hooks registered -> ${res.targetPath}`);
          if (existsSync(`${res.targetPath}.bak`)) console.log(`  (Backup created: ${res.targetPath}.bak)`);
        } else {
          console.error(`[${h.toUpperCase()}:${scope}] Failed to install hooks: ${res.error}`);
        }
      }

      // Ensure broker daemon is running with latest code
      try {
        console.log(`\n[Broker Daemon] Verifying background daemon...`);
        const broker = await ensureBroker({ rootDir, address: ipcAddress });
        console.log(`[Broker Daemon] Active and healthy (PID: ${broker.pid}, v${broker.version || "1.1.0"}).`);
        console.log(`[Broker Daemon] IPC Address: ${ipcAddress}`);
      } catch (err) {
        console.error(`[Broker Daemon] Error starting broker: ${err.message}`);
      }

      console.log(`\nAgent Mesh is fully initialized (${scope.toUpperCase()} scope)!`);
      console.log(`Interactive terminals in ${targets.join(", ") || "supported harnesses"} will now automatically self-announce.`);
      console.log(`Run 'mesh status' anytime to inspect live sessions.\n`);
      break;
    }

    case "--uninstall":
    case "uninstall": {
      const { harnesses, isProject } = parseHarnessSelection(cmd, args);
      const isExplicitGlobal = args.includes("--global");
      const scopes = [];
      if (isProject) scopes.push(false);
      else if (isExplicitGlobal) scopes.push(true);
      else scopes.push(true, false);

      console.log(`\n--- UNINSTALLING AGENT MESH REQUIREMENTS ---`);
      for (const globalScope of scopes) {
        const scope = globalScope ? "global" : "project";
        let targets = harnesses;
        if (targets.length === 0) {
          targets = autoDiscoverHarnesses({ global: globalScope }, rootDir);
          if (targets.length === 0) targets = [...SUPPORTED_HARNESSES];
        }

        for (const h of targets) {
          const res = uninstallHarness(h, { global: globalScope }, rootDir);
          if (res.ok && res.modified) {
            console.log(`[${res.harness.toUpperCase()}:${scope}] Removed agent-mesh hooks from ${res.targetPath}`);
          }
        }
      }

      try {
        await stopBroker({ rootDir, address: ipcAddress });
        console.log(`[Broker Daemon] Daemon stopped.`);
      } catch {}

      console.log(`\nAgent Mesh uninstallation complete.\n`);
      break;
    }

    case "start": {
      try {
        const broker = await ensureBroker({ rootDir, address: ipcAddress });
        console.log(`agent-mesh broker is active (PID: ${broker.pid}, v${broker.version || "1.1.0"}).`);
        console.log(`IPC Address: ${ipcAddress}`);
      } catch (err) {
        console.error(`Failed to start broker: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "stop": {
      try {
        const res = await stopBroker({ rootDir, address: ipcAddress });
        if (res.message) {
          console.log(res.message);
        } else {
          console.log(`agent-mesh broker (PID: ${res.pid}) stopped.`);
        }
      } catch (err) {
        console.error(`Error stopping broker: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "status": {
      try {
        const res = await sendIpcRequest(ipcAddress, { action: "status" });
        if (!res.ok) {
          console.error(`Broker error: ${res.error}`);
          process.exit(1);
        }

        console.log("\n--- AGENT MESH STATUS ---");
        console.log(`Daemon PID: ${res.pid}`);
        console.log(`Busy Agents: ${res.busyAgents.length ? res.busyAgents.join(", ") : "None (all idle)"}`);

        console.log("\nPending Message Counts:");
        if (res.pendingCounts.length === 0) {
          console.log("  No pending messages in any inbox.");
        } else {
          for (const item of res.pendingCounts) {
            console.log(`  - ${item.to_agent}: ${item.count} pending`);
          }
        }

        console.log("\nActive Sessions:");
        const live = res.liveSessions || res.sessions || [];
        if (live.length === 0) {
          console.log("  No active sessions recorded.");
        } else {
          for (const s of live) {
            const originTag = s.origin === "interactive" ? "[Interactive]" : "[Mesh-Headless]";
            const pidTag = s.pid ? `PID: ${s.pid}` : "No PID";
            console.log(`  - [${s.harness}] ID: ${s.session_id} | State: ${s.state} | ${originTag} | ${pidTag}`);
          }
        }
        console.log("");
      } catch (err) {
        console.error(`Cannot connect to broker: ${err.message}`);
        console.log("Run 'node scripts/mesh.mjs start' to launch the daemon.");
        process.exit(1);
      }
      break;
    }

    case "register":
    case "announce": {
      let harness = null;
      let sessionId = null;
      let pid = process.pid;
      let event = "start";
      let sessionCwd = rootDir;

      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--harness" && args[i + 1]) { harness = args[++i]; }
        else if (args[i] === "--session" && args[i + 1]) { sessionId = args[++i]; }
        else if (args[i] === "--pid" && args[i + 1]) { pid = Number(args[++i]); }
        else if (args[i] === "--event" && args[i + 1]) { event = args[++i]; }
        else if (args[i] === "--cwd" && args[i + 1]) { sessionCwd = args[++i]; }
      }

      if (!harness || !sessionId) {
        console.error("Usage: mesh announce --harness <name> --session <id> [--pid <pid>] [--event <event>]");
        process.exit(1);
      }

      try {
        const res = await sendIpcRequest(ipcAddress, {
          action: "session_event",
          payload: { harness, sessionId, event, pid, cwd: sessionCwd, origin: "interactive" },
        });
        if (res.ok) {
          console.log(`[Success] Registered session '${sessionId}' (${harness}) as ${res.state}.`);
        } else {
          console.error(`Error: ${res.error}`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`Failed to announce session: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "send":
    case "ask": {
      let to = null;
      let toSession = null;
      let bodyArgs = [];

      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--to" && args[i + 1]) {
          const target = args[i + 1];
          if (target.includes("@")) {
            const parts = target.split("@");
            to = parts[0];
            toSession = parts[1];
          } else {
            to = target;
          }
          i++;
        } else {
          bodyArgs.push(args[i]);
        }
      }

      const body = bodyArgs.join(" ").trim();
      if (!to || !body) {
        console.error(`Usage: mesh ${cmd} --to <agent>[@<session>] "<message/prompt>"`);
        process.exit(1);
      }

      // H3: Increment hops on agent-sent ask chains; human-sent asks start at 0
      const effectiveHops = (meshAgent && meshAgent !== "human-cli") ? meshHops + 1 : 0;

      try {
        const res = await sendIpcRequest(ipcAddress, {
          action: cmd,
          payload: {
            from: meshAgent,
            to,
            toSession,
            body,
            kind: cmd === "ask" ? "ask" : "notify",
            hops: effectiveHops,
          },
        });

        if (res.ok) {
          console.log(`[Success] Message queued for agent '${to}'.`);
          console.log(`Ticket ID: ${res.ticket}`);
        } else {
          console.error(`Error: ${res.error}`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`Failed to send message: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "reply": {
      let ticket = null;
      let to = null;
      let bodyArgs = [];

      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--ticket" && args[i + 1]) {
          ticket = args[i + 1];
          i++;
        } else if (args[i] === "--to" && args[i + 1]) {
          to = args[i + 1];
          i++;
        } else {
          bodyArgs.push(args[i]);
        }
      }

      const body = bodyArgs.join(" ").trim();
      if (!ticket || !to || !body) {
        console.error("Usage: mesh reply --ticket <id> --to <agent> \"<response>\"");
        process.exit(1);
      }

      try {
        const res = await sendIpcRequest(ipcAddress, {
          action: "reply",
          payload: {
            ticket,
            from: meshAgent,
            to,
            body,
          },
        });

        if (res.ok) {
          console.log(`[Success] Reply sent for ticket ${ticket}.`);
          console.log(`Reply ID: ${res.ticket}`);
        } else {
          console.error(`Error: ${res.error}`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`Failed to send reply: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "inbox": {
      const delivered = args.includes("--delivered");
      const agent = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--limit");
      const limitIdx = args.indexOf("--limit");
      const limit = limitIdx !== -1 && args[limitIdx + 1] ? Number(args[limitIdx + 1]) : 20;

      if (!agent) {
        console.error("Usage: mesh inbox <agent> [--delivered] [--limit N]");
        process.exit(1);
      }

      try {
        const res = await sendIpcRequest(ipcAddress, {
          action: "inbox",
          payload: { agent, delivered, limit },
        });

        if (!res.ok) {
          console.error(`Error: ${res.error}`);
          process.exit(1);
        }

        const label = delivered ? "delivered" : "pending";
        if (res.messages.length === 0) {
          console.log(`No ${label} messages for '${agent}'.`);
        } else {
          console.log(`\n--- INBOX [${agent}] (${label}, ${res.messages.length}) ---`);
          for (const m of res.messages) {
            const body = m.body.length > 160 ? `${m.body.slice(0, 160)}...` : m.body;
            console.log(`  [${m.kind}] ${m.id}\n    from: ${m.from_agent} | hops: ${m.hops} | ${new Date(m.created_at).toISOString()}\n    ${body.replace(/\n/g, "\n    ")}\n`);
          }
        }
      } catch (err) {
        console.error(`Cannot connect to broker: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "watch": {
      const agent = args[0];
      if (!agent) {
        console.error("Usage: mesh watch <agent>");
        process.exit(1);
      }

      const logPath = join(meshDir, "logs", `${agent}.jsonl`);
      console.log(`--- Tailing live events for [${agent}] (${logPath}) ---`);
      console.log("Press Ctrl+C to exit.\n");

      if (!existsSync(logPath)) {
        console.log(`(Log file not created yet; waiting for agent turns...)`);
      }

      let readOffset = 0;
      if (existsSync(logPath)) {
        const content = readFileSync(logPath, "utf8");
        process.stdout.write(content);
        readOffset = content.length;
      }

      const interval = setInterval(() => {
        if (!existsSync(logPath)) return;
        const current = readFileSync(logPath, "utf8");
        if (current.length > readOffset) {
          const delta = current.slice(readOffset);
          process.stdout.write(delta);
          readOffset = current.length;
        }
      }, 300);

      process.on("SIGINT", () => {
        clearInterval(interval);
        process.exit(0);
      });
      break;
    }

    case "attach": {
      const agent = args[0];
      if (!agent) {
        console.error("Usage: mesh attach <agent>");
        process.exit(1);
      }

      try {
        const leaseRes = await sendIpcRequest(ipcAddress, {
          action: "lease_acquire",
          payload: { agent, pid: process.pid },
        });

        if (!leaseRes.ok) {
          console.error(`Failed to acquire session lease: ${leaseRes.error}`);
          process.exit(1);
        }

        console.log(`\n[SESSION LEASE ACQUIRED]`);
        console.log(`Agent: ${agent} | Session ID: ${leaseRes.sessionId}`);
        console.log(`Command: ${leaseRes.attachArgv.join(" ")}`);
        console.log(`Broker automation for '${agent}' is paused while you are attached.`);
        console.log(`Exit the attached CLI session to return the lease to the mesh broker.\n`);

        const [bin, ...cmdArgs] = leaseRes.attachArgv;
        const child = spawnChild(bin, cmdArgs, {
          cwd,
          stdio: "inherit",
          windowsHide: false,
        });

        await new Promise((resolve) => {
          child.on("close", resolve);
        });

        // Release lease back to broker
        await sendIpcRequest(ipcAddress, {
          action: "lease_release",
          payload: { agent },
        });

        console.log(`\n[SESSION LEASE RELEASED] Returned control of '${agent}' to the mesh broker.`);
      } catch (err) {
        console.error(`Attach error: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "hooks": {
      const sub = args[0] || "install";
      const remainingArgs = args.slice(1);
      const { harnesses, isProject, isGlobal } = parseHarnessSelection(sub, remainingArgs);
      const scope = isGlobal ? "global" : "project";

      let targets = harnesses;
      if (targets.length === 0) {
        targets = autoDiscoverHarnesses({ global: isGlobal }, rootDir);
        if (targets.length === 0) targets = [...SUPPORTED_HARNESSES];
      }

      if (sub === "install") {
        console.log(`\n--- INSTALLING AGENT MESH LIFECYCLE HOOKS (${scope.toUpperCase()}) ---`);
        for (const h of targets) {
          const res = installHarness(h, { global: isGlobal }, rootDir);
          if (res.ok) {
            console.log(`[${res.harness}:${scope}] Registered presence hooks -> ${res.targetPath}`);
            if (existsSync(`${res.targetPath}.bak`)) console.log(`  (Backup created: ${res.targetPath}.bak)`);
          } else {
            console.error(`[${h}:${scope}] Failed to install hooks: ${res.error}`);
          }
        }
        console.log(`\nHooks successfully installed. Interactive sessions will now self-announce to agent-mesh.\n`);
      } else if (sub === "uninstall") {
        console.log(`\n--- UNINSTALLING AGENT MESH LIFECYCLE HOOKS (${scope.toUpperCase()}) ---`);
        for (const h of targets) {
          const res = uninstallHarness(h, { global: isGlobal }, rootDir);
          if (res.ok && res.modified) {
            console.log(`[${res.harness}:${scope}] Removed agent-mesh hooks from ${res.targetPath}`);
          } else {
            console.log(`[${res.harness}:${scope}] No agent-mesh hooks found in ${res.targetPath}`);
          }
        }
        console.log(`\nUninstall complete.\n`);
      } else if (sub === "doctor") {
        console.log(`\n--- AGENT MESH HOOKS DIAGNOSTICS (${scope.toUpperCase()}) ---`);
        for (const h of targets) {
          const diag = diagnoseHarness(h, { global: isGlobal }, rootDir);
          console.log(`${diag.harness.toUpperCase()} [${diag.targetPath}]:`);
          console.log(`  Status: ${diag.status}`);
        }
        console.log("");
      }
      break;
    }

    default:
      console.log(`
Agent Mesh CLI (v1.1.0)
Commands:
  --init, --install [harnesses...]   Install requirements, configure hooks, and start broker (auto-discovers or assigns harnesses)
  --uninstall [harnesses...]         Cleanly remove hooks and stop the broker daemon
  start                              Start the local mesh broker daemon in the background
  stop                               Stop the running broker daemon
  status                             Display current agent sessions, busy status, and queue depth
  hooks install [harnesses...]       Install lifecycle hooks for specified (or detected) harnesses
  hooks uninstall [harnesses...]     Remove agent-mesh hooks cleanly
  hooks doctor [harnesses...]        Inspect configuration and verify hook registration across harnesses
  ask --to <agent>                   Enqueue a non-blocking question for an agent (returns ticket)
  send --to <agent>                  Send a one-way notification message
  reply --ticket <id> --to <agent>   Reply to a previous question ticket
  inbox <agent>                      Inspect pending (or --delivered) messages for an agent
  watch <agent>                      Live tail an agent's event stream
  attach <agent>                     Acquire session lease and launch native interactive harness
      `);
      break;
  }
}

main().catch((err) => {
  console.error(`CLI error: ${err.message}`);
  process.exit(1);
});
