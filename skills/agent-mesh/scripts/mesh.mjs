#!/usr/bin/env node
/**
 * @file mesh.mjs
 * @description Command-line interface for agent-mesh.
 * Provides controls for starting/stopping the daemon, checking status,
 * sending asynchronous messages, and watching live agent event streams.
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { getIpcAddress, sendIpcRequest, findRepoRoot, resolveIpcAddress } from "../src/ipc.mjs";
import { spawnChild } from "../src/drivers/base.mjs";

// C4: when invoked from inside an agent turn, inherit identity and hop budget
const meshAgent = process.env.MESH_AGENT || "human-cli";
const meshHops = Number(process.env.MESH_HOPS || 0);

const cwd = process.cwd();
const rootDir = findRepoRoot(cwd);
const meshDir = join(rootDir, ".agent-mesh");
const brokerPidPath = join(meshDir, "broker.json");
const ipcAddress = resolveIpcAddress(rootDir);

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getBrokerInfo() {
  if (!existsSync(brokerPidPath)) return null;
  try {
    const data = JSON.parse(readFileSync(brokerPidPath, "utf8"));
    if (isProcessAlive(data.pid)) {
      return data;
    }
    // Stale PID file
    unlinkSync(brokerPidPath);
    return null;
  } catch {
    return null;
  }
}

async function main() {
  const [,, cmd, ...args] = process.argv;

  switch (cmd) {
    case "start": {
      const existing = await getBrokerInfo();
      if (existing) {
        console.log(`agent-mesh broker is already running (PID: ${existing.pid}).`);
        process.exit(0);
      }

      const brokerScript = resolve(import.meta.dirname, "../src/broker.mjs");
      const child = spawn(process.execPath, [brokerScript], {
        cwd: rootDir,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });

      child.unref();

      // Poll briefly for broker.json to appear
      let started = false;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (await getBrokerInfo()) {
          started = true;
          break;
        }
      }

      if (started) {
        console.log(`agent-mesh broker successfully started in background.`);
        console.log(`IPC Address: ${ipcAddress}`);
      } else {
        console.error("Failed to confirm broker startup. Check system permissions.");
        process.exit(1);
      }
      break;
    }

    case "stop": {
      const broker = await getBrokerInfo();
      if (!broker) {
        console.log("No running agent-mesh broker found.");
        process.exit(0);
      }

      try {
        if (process.platform === "win32") {
          execFileSync("taskkill", ["/PID", String(broker.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          process.kill(broker.pid, "SIGTERM");
        }
        if (existsSync(brokerPidPath)) unlinkSync(brokerPidPath);
        console.log(`agent-mesh broker (PID: ${broker.pid}) stopped.`);
      } catch (err) {
        console.error(`Error stopping broker: ${err.message}`);
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
        if (res.sessions.length === 0) {
          console.log("  No active sessions recorded.");
        } else {
          for (const s of res.sessions) {
            console.log(`  - [${s.harness}] ID: ${s.session_id} | State: ${s.state}`);
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

    case "send":
    case "ask": {
      let to = null;
      let bodyArgs = [];

      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--to" && args[i + 1]) {
          to = args[i + 1];
          i++;
        } else {
          bodyArgs.push(args[i]);
        }
      }

      const body = bodyArgs.join(" ").trim();
      if (!to || !body) {
        console.error(`Usage: mesh ${cmd} --to <agent> "<message/prompt>"`);
        process.exit(1);
      }

      try {
        const res = await sendIpcRequest(ipcAddress, {
          action: cmd,
          payload: {
            from: meshAgent,
            to,
            body,
            kind: cmd === "ask" ? "ask" : "notify",
            hops: meshHops,
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

    default:
      console.log(`
Agent Mesh CLI (v0.1.0)
Commands:
  start               Start the local mesh broker daemon in the background
  stop                Stop the running broker daemon
  status              Display current agent sessions, busy status, and queue depth
  ask --to <agent>    Enqueue a non-blocking question for an agent (returns ticket)
  send --to <agent>   Send a one-way notification message
  reply --ticket <id> --to <agent>  Reply to a previous question ticket
  inbox <agent>       Inspect pending (or --delivered) messages for an agent
  watch <agent>       Live tail an agent's event stream
  attach <agent>      Acquire session lease and launch native interactive harness
      `);
      break;
  }
}

main().catch((err) => {
  console.error(`CLI error: ${err.message}`);
  process.exit(1);
});
