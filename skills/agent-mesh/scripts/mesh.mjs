#!/usr/bin/env node
/**
 * @file mesh.mjs
 * @description Command-line interface for agent-mesh.
 * Provides controls for starting/stopping the daemon, checking status,
 * sending asynchronous messages, and watching live agent event streams.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { VERSION } from "../src/version.mjs";
import { sendIpcRequest, findRepoRoot, resolveIpcAddress } from "../src/ipc.mjs";
import { spawnChild } from "../src/drivers/base.mjs";
import { ensureBroker, stopBroker, getBrokerInfo } from "../src/daemon.mjs";
import {
  installHarness,
  uninstallHarness,
  diagnoseHarness,
  diagnoseMcp,
  diagnoseWake,
  setOptIn,
  autoDiscoverHarnesses,
  normalizeHarnessName,
  SUPPORTED_HARNESSES,
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
// Single global broker per user: its state root is MESH_HOME (default ~), not the repo.
const brokerRoot = process.env.MESH_HOME || homedir();
const meshDir = join(brokerRoot, ".agent-mesh");
const ipcAddress = resolveIpcAddress(rootDir);

/**
 * Real-time watcher for agent-mesh lifecycle presence hook invocations.
 * Tails ~/.agent-mesh/logs/hooks.log with colorized terminal formatting,
 * ASCII terminal bell (\x07) for headless VPS/SSH, and optional Windows audio chime/popup.
 *
 * @param {string[]} watcherArgs
 */
function runHooksWatcher(watcherArgs) {
  const logPath = join(homedir(), ".agent-mesh", "logs", "hooks.log");
  const noBell = watcherArgs.includes("--no-bell");
  const enableSound =
    !watcherArgs.includes("--no-sound") &&
    (watcherArgs.includes("--sound") || watcherArgs.includes("--notify") || process.env.MESH_NOTIFY === "1" || process.env.MESH_NOTIFY_SOUND === "1" || process.platform === "win32");
  const enablePopup =
    !watcherArgs.includes("--no-popup") &&
    (watcherArgs.includes("--popup") || watcherArgs.includes("--notify") || process.env.MESH_NOTIFY === "1" || process.env.MESH_NOTIFY_POPUP === "1" || process.platform === "win32");

  console.log(`\n======================================================`);
  console.log(`       AGENT MESH HOOKS REAL-TIME EVENT WATCHER       `);
  console.log(`======================================================`);
  console.log(`Log File:      ${logPath}`);
  console.log(`Terminal Bell: ${noBell ? "Disabled (--no-bell)" : "Enabled (\\x07 for VPS/terminal)"}`);
  console.log(`Audio Chime:   ${enableSound ? "Enabled (Windows chime)" : "Disabled (use --no-sound to disable)"}`);
  console.log(`Desktop Popup: ${enablePopup ? "Enabled (Windows popup)" : "Disabled (use --no-popup to disable)"}`);
  console.log(`Status:        Listening for live hook triggers... (Ctrl+C to quit)\n`);

  function formatHookLine(rawLine, shouldNotify = true) {
    if (!rawLine.trim()) return;
    try {
      const data = JSON.parse(rawLine);
      const time = data.timestamp ? data.timestamp.slice(11, 19) : new Date().toLocaleTimeString();
      const harness = (data.harness || "unknown").toUpperCase();
      const event = data.event || "Event";
      const state = data.state ? ` (${data.state})` : "";
      const sid = data.sessionId ? data.sessionId.slice(0, 8) + "…" : "no-session";
      const pid = data.pid ? `PID: ${data.pid}` : "no-pid";
      const dur = data.durationMs !== undefined ? `${data.durationMs}ms` : "";
      const statusTag = data.ok ? "\x1b[32m[OK]\x1b[0m" : `\x1b[31m[ERR: ${data.error || "failed"}]\x1b[0m`;
      const harnessTag = `\x1b[1m\x1b[36m[${harness}]\x1b[0m`;

      console.log(`[${time}] ${harnessTag} ${event}${state} | Sid: ${sid} | ${pid} | ${dur} ${statusTag}`);

      // Notifications (suppressed during backlog replay)
      if (shouldNotify) {
        if (!noBell) {
          process.stdout.write("\x07");
        }

        if (enableSound && process.platform === "win32") {
          const psSound = `
            try {
              $sound = 'C:\\Windows\\Media\\Windows Notify System Generic.wav';
              if (Test-Path $sound) {
                (New-Object System.Media.SoundPlayer $sound).Play();
              } else {
                [System.Media.SystemSounds]::Asterisk.Play();
              }
            } catch {}
          `;
          const encodedSound = Buffer.from(psSound, "utf16le").toString("base64");
          spawnChild("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedSound], {
            stdio: "ignore",
            windowsHide: false,
          });
        }

        if (enablePopup && process.platform === "win32") {
          const popupMsg = `[Agent Mesh] ${harness} ${event}${state}\nSession: ${sid}\n${pid}`;
          const psPopup = `
            try {
              (New-Object -ComObject Wscript.Shell).Popup(@"
${popupMsg}
"@, 2, 'Agent Mesh Hook Triggered', 4160);
            } catch {}
          `;
          const encodedPopup = Buffer.from(psPopup, "utf16le").toString("base64");
          spawnChild("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPopup], {
            stdio: "ignore",
            windowsHide: false,
          });
        }
      }
    } catch {
      console.log(`[RAW] ${rawLine}`);
    }
  }

  let readOffset = 0;
  if (existsSync(logPath)) {
    try {
      const existing = readFileSync(logPath, "utf8");
      readOffset = existing.length;
      const lines = existing.trim().split("\n").filter(Boolean);
      const recent = lines.slice(-5);
      if (recent.length > 0) {
        console.log(`--- Recent Hook Activity (last ${recent.length} events) ---`);
        for (const line of recent) {
          formatHookLine(line, false);
        }
        console.log(`--- Streaming new events ---`);
      }
    } catch {}
  } else {
    console.log(`(Waiting for first hook execution to create log file...)`);
  }

  const timer = setInterval(() => {
    if (!existsSync(logPath)) return;
    try {
      const current = readFileSync(logPath, "utf8");
      if (current.length > readOffset) {
        const delta = current.slice(readOffset);
        readOffset = current.length;
        const newLines = delta.split("\n").filter((l) => l.trim().length > 0);
        for (const line of newLines) {
          formatHookLine(line);
        }
      } else if (current.length < readOffset) {
        // File rotated
        readOffset = 0;
      }
    } catch {}
  }, 200);

  process.on("SIGINT", () => {
    clearInterval(timer);
    console.log("\nHooks watcher stopped.\n");
    process.exit(0);
  });
}

async function main() {
  const [,, cmd, ...args] = process.argv;

  switch (cmd) {
    case "--init":
    case "--install":
    case "init":
    case "install": {
      const { harnesses, isGlobal } = parseHarnessSelection(cmd, args);
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
        const res = installHarness(h, { global: isGlobal, mcp: process.argv.includes("--mcp"), wake: process.argv.includes("--wake") }, rootDir);
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
        const broker = await ensureBroker({ rootDir: brokerRoot, address: ipcAddress });
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
        await stopBroker({ rootDir: brokerRoot, address: ipcAddress });
        console.log(`[Broker Daemon] Daemon stopped.`);
      } catch {}

      console.log(`\nAgent Mesh uninstallation complete.\n`);
      break;
    }

    case "start": {
      try {
        const broker = await ensureBroker({ rootDir: brokerRoot, address: ipcAddress });
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
        const res = await stopBroker({ rootDir: brokerRoot, address: ipcAddress });
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
            const nameTag = s.name ? ` "${s.name}"` : "";
            console.log(`  - [${s.harness}]${nameTag} ID: ${s.session_id} | State: ${s.state} | ${originTag} | ${pidTag}`);
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
      // Sent through a harness's shell tool? Then this CLI is a descendant of a live session: attribute the
      // message to it so the broker's hop propagation applies (a bare "human-cli" would bypass the loop guard).
      let sender = { from: meshAgent, fromSession: process.env.MESH_SESSION_ID || undefined };
      if (meshAgent === "human-cli") {
        try {
          // $MESH_SESSION_ID names the session explicitly; otherwise the process ancestry identifies it
          let query = process.env.MESH_SESSION_ID ? { sessionId: process.env.MESH_SESSION_ID } : null;
          if (!query) {
            const { ancestorPids } = await import("../src/presence/caller.mjs");
            const chain = ancestorPids(process.pid);
            if (chain.length) query = { pids: chain };
          }
          if (query) {
            const who = await sendIpcRequest(ipcAddress, { action: "whoami", payload: query });
            if (who?.ok && who.session) sender = { from: who.session.harness, fromSession: who.session.id };
          }
        } catch {}
      }
      const effectiveHops = sender.from !== "human-cli" ? meshHops + 1 : 0;

      try {
        const res = await sendIpcRequest(ipcAddress, {
          action: cmd,
          payload: {
            from: sender.from,
            fromSession: sender.fromSession,
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

    case "wait": {
      // mesh wait --session <id> [--agent <harness>] [--stream] [--harness-pid N] [--debounce ms] [--exit-code-on-mail N]
      const opt = (name) => {
        const i = args.indexOf(name);
        return i !== -1 ? args[i + 1] : undefined;
      };
      const sessionId = opt("--session") || process.env.MESH_SESSION_ID;
      if (!sessionId) {
        console.error("Usage: mesh wait --session <id> [--agent <harness>] [--stream] [--harness-pid N] [--debounce ms]");
        process.exit(1);
      }
      const { runWait } = await import("../src/wait/mesh-wait.mjs");
      const stream = args.includes("--stream");
      const result = await runWait({
        address: ipcAddress,
        sessionId,
        agent: opt("--agent"),
        stream,
        harnessPid: opt("--harness-pid") ? Number(opt("--harness-pid")) : undefined,
        debounceMs: opt("--debounce") !== undefined ? Number(opt("--debounce")) : undefined,
        mailExitCode: opt("--exit-code-on-mail") ? Number(opt("--exit-code-on-mail")) : 0,
        rearmCommand: stream ? undefined : `mesh wait --session ${sessionId}${opt("--agent") ? ` --agent ${opt("--agent")}` : ""}`,
      });
      process.exit(result.code);
    }

    case "probe-wake": {
      // mesh probe-wake <harness> [--after 20] [--stream]: guided evidence run for a harness's wake tier
      const registry = await import("../src/harnesses/index.mjs");
      const probe = await import("../src/wait/wake-probe.mjs");
      const { createInterface } = await import("node:readline/promises");
      const { fileURLToPath } = await import("node:url");
      const desc = registry.get(args.find((a) => !a.startsWith("--")));
      if (!desc) {
        console.error(`Usage: mesh probe-wake <${registry.ids().join("|")}> [--after 20] [--stream]`);
        process.exit(1);
      }
      const afterIdx = args.indexOf("--after");
      const afterSec = afterIdx !== -1 ? Number(args[afterIdx + 1]) || 20 : 20;
      const stream = args.includes("--stream");
      const nonce = probe.newNonce();
      const emitScript = fileURLToPath(new URL("../src/wait/probe-emit.mjs", import.meta.url)).split("\\").join("/");
      const emitCommand = `node ${emitScript} --nonce ${nonce} --after ${afterSec}${stream ? " --repeat" : ""}`;
      console.log(probe.buildProbePlan(desc, { nonce, afterSec, stream, emitCommand }));
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answers = {};
      for (const q of probe.PROBE_QUESTIONS) {
        const raw = await rl.question(`\n${q.text} ${q.numeric ? "" : "[y/n/blank=unknown] "}`);
        answers[q.key] = q.numeric ? (raw.trim() === "" ? null : Number(raw)) : probe.parseYesNo(raw);
      }
      rl.close();
      const version = process.env.MESH_PROBE_VERSION || "unknown version (set MESH_PROBE_VERSION)";
      const date = new Date().toISOString().slice(0, 10);
      const launcher = desc.delivery.wake.candidate?.launcher || desc.delivery.wake.launcher;
      const result = probe.evaluateProbe(answers, { launcher, version, date, stream });
      console.log("\n--- descriptor snippet (delivery.wake) ---\n" + probe.formatDescriptorSnippet(result));
      console.log("\n--- evidence row for docs/ADAPTERS.md (Wake tiers) ---\n" + probe.formatEvidenceRow(desc.id, result, { version, date }));
      process.exit(0);
    }

    case "setup": {
      // single-command flow: detect -> choose harnesses/action/components -> apply (see src/setup/setup.mjs)
      const { runSetup } = await import("../src/setup/setup.mjs");
      const code = await runSetup(
        { argv: args, rootDir, meshHome: brokerRoot, brokerRoot, ipcAddress },
        { stdin: process.stdin, stdout: process.stdout, isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY) },
        { installHarness, uninstallHarness, diagnoseHarness, diagnoseMcp, diagnoseWake, autoDiscoverHarnesses, ensureBroker, stopBroker }
      );
      process.exit(code);
    }

    case "whoami": {
      // mesh whoami [--session <id|name>] [--harness h] [--pid N] [--line] [--stdin]
      // Without selectors: $MESH_SESSION_ID, else the live sessions whose cwd is the current directory.
      const opt = (name) => {
        const i = args.indexOf(name);
        return i !== -1 ? args[i + 1] : undefined;
      };
      let sessionId = opt("--session") || process.env.MESH_SESSION_ID;
      if (args.includes("--stdin")) {
        // status-line friendly: the harness pipes JSON with the session id on stdin
        let raw = "";
        for await (const chunk of process.stdin) raw += chunk;
        try {
          const j = JSON.parse(raw);
          sessionId = j.session_id || j.sessionId || sessionId;
        } catch {}
      }
      const { formatIdentityBlock, formatIdentityLine } = await import("../src/presence/identity.mjs");
      try {
        const info = await sendIpcRequest(ipcAddress, {
          action: "whoami",
          payload: { harness: opt("--harness"), sessionId, pid: opt("--pid") ? Number(opt("--pid")) : undefined, cwd: sessionId || opt("--pid") ? undefined : process.cwd() },
        });
        if (!info.ok) throw new Error(info.error || "whoami failed");
        if (!args.includes("--line")) {
          const { componentsOf } = await import("../src/hooks/installer.mjs");
          info.components = componentsOf(info.harness);
        }
        console.log(args.includes("--line") ? formatIdentityLine(info) : formatIdentityBlock(info));
        if (!info.session) process.exitCode = 1;
      } catch (err) {
        console.log(args.includes("--line") ? "agent-mesh: broker not running" : "Broker unreachable: " + err.message);
        process.exitCode = 1;
      }
      process.exit(process.exitCode || 0);
    }

    case "mcp":
    case "wake": {
      // mesh mcp|wake install|remove|status [harness...|all] [--project|--global]
      const [action = "status", ...rest] = args;
      if (!["install", "remove", "uninstall", "status"].includes(action)) {
        console.error(`Usage: mesh ${cmd} install|remove|status [harness...|all] [--project|--global]`);
        process.exit(1);
      }
      const registry = await import("../src/harnesses/index.mjs");
      const selection = parseHarnessSelection(action, rest.filter((a) => a !== "all"));
      let targets = rest.includes("all") ? registry.ids() : selection.harnesses;
      if (targets.length === 0) targets = autoDiscoverHarnesses({ global: selection.isGlobal }, rootDir);
      if (targets.length === 0) targets = registry.ids();
      const scope = selection.isGlobal ? "global" : "project";
      let failed = false;
      for (const h of targets) {
        const opts = { global: selection.isGlobal };
        if (action === "status") {
          const d = cmd === "mcp" ? diagnoseMcp(h, opts, rootDir) : diagnoseWake(h, opts, rootDir);
          console.log(`[${d.harness}:${scope}] ${cmd}: ${!d.supported ? "not supported" : d.installed ? "installed" : "not installed"}${d.targetPath ? ` [${d.targetPath}]` : ""}`);
          continue;
        }
        const res = setOptIn(cmd, action === "install", h, opts, rootDir);
        if (res.ok) {
          console.log(`[${res.harness}:${scope}] ${cmd} ${action === "install" ? (res.modified ? "installed" : "already installed") : (res.modified ? "removed" : "was not installed")} [${res.targetPath}]`);
        } else {
          failed = true;
          console.error(`[${res.harness}:${scope}] ${cmd} ${action} failed: ${res.error}`);
        }
      }
      if (action === "install" && !failed) {
        console.log(cmd === "mcp"
          ? "Restart the harness sessions to load the MCP server (no broker restart needed)."
          : "Claude: restart the session to register the hook. Codex: the broker picks the setting up within 30s.");
      }
      process.exit(failed ? 1 : 0);
    }

    case "mute":
    case "unmute": {
      try {
        const res = await sendIpcRequest(ipcAddress, { action: cmd });
        console.log(res.ok ? `Idle-session wake delivery is now ${res.wake.muted ? "MUTED (mail waits for the next prompt)" : "enabled"}.` : `Error: ${res.error}`);
      } catch (err) {
        console.error(`Failed: ${err.message}`);
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
      if (!agent || agent === "hooks" || agent === "--hooks") {
        runHooksWatcher(args);
        break;
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

    case "doctor":
    case "hooks": {
      const sub = cmd === "doctor" ? "doctor" : (args[0] || "install");
      const remainingArgs = cmd === "doctor" ? args : args.slice(1);

      if (sub === "watch") {
        runHooksWatcher(remainingArgs);
        break;
      }

      const { harnesses, isGlobal } = parseHarnessSelection(sub, remainingArgs);
      const scope = isGlobal ? "global" : "project";

      let targets = harnesses;
      if (targets.length === 0) {
        targets = autoDiscoverHarnesses({ global: isGlobal }, rootDir);
        if (targets.length === 0) targets = [...SUPPORTED_HARNESSES];
      }

      if (sub === "install") {
        console.log(`\n--- INSTALLING AGENT MESH LIFECYCLE HOOKS (${scope.toUpperCase()}) ---`);
        for (const h of targets) {
          const res = installHarness(h, { global: isGlobal, mcp: process.argv.includes("--mcp"), wake: process.argv.includes("--wake") }, rootDir);
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
          const mcp = diagnoseMcp(h, { global: isGlobal }, rootDir);
          if (mcp.installed) console.log(`  MCP shim: installed [${mcp.targetPath}]`);
          const wk = diagnoseWake(h, { global: isGlobal }, rootDir);
          if (wk.installed) console.log(`  Idle wake (opt-in): installed [${wk.targetPath}]`);
        }

        // Active Broker Diagnostics
        console.log(`\n--- BROKER DAEMON STATUS ---`);
        const brokerInfo = getBrokerInfo(brokerRoot);
        if (brokerInfo) {
          console.log(`  Daemon PID:    ${brokerInfo.pid} (active)`);
          console.log(`  Version:       ${brokerInfo.version || "1.1.0"}`);
          console.log(`  IPC Address:   ${brokerInfo.ipcAddress}`);
        } else {
          console.log(`  Daemon:        No active broker found on local or global registry.`);
        }

        // Recent Hook Audit Log Tail
        const hookLogPath = join(homedir(), ".agent-mesh", "logs", "hooks.log");
        console.log(`\n--- RECENT HOOK AUDIT LOG (${hookLogPath}) ---`);
        if (existsSync(hookLogPath)) {
          const lines = readFileSync(hookLogPath, "utf8").trim().split("\n").filter(Boolean);
          const recent = lines.slice(-8);
          for (const line of recent) {
            try {
              const d = JSON.parse(line);
              const time = d.timestamp ? d.timestamp.slice(11, 19) : "";
              const status = d.ok ? "\x1b[32mOK\x1b[0m" : `\x1b[31mFAIL (${d.error})\x1b[0m`;
              console.log(`  [${time}] [${d.harness?.toUpperCase()}] ${d.event} (${d.state || ""}) | PID: ${d.pid} | ${status} (${d.durationMs}ms)`);
            } catch {
              console.log(`  ${line}`);
            }
          }
        } else {
          console.log(`  No hook audit log file found yet.`);
        }
        console.log("");
      }
      break;
    }

    default:
      console.log(`
Agent Mesh CLI (v${VERSION})
Commands:
  setup [--yes --harness h,.. --action install|update|uninstall --mcp --wake --all --dry-run --purge]
                                     Interactive checklist (or flags): install/update/uninstall in one round
  --init, --install [harnesses...]   Install requirements, configure hooks, and start broker (auto-discovers or assigns harnesses)
                                     Add --mcp to also register the opt-in MCP shim (mesh_send/mesh_ask/mesh_inbox/mesh_status)
  --uninstall [harnesses...]         Cleanly remove hooks and stop the broker daemon
  start                              Start the local mesh broker daemon in the background
  stop                               Stop the running broker daemon
  status                             Display current agent sessions, busy status, and queue depth
  wait --session <id> [--stream]     Block until wake-eligible mail arrives for a session (see docs/ADAPTERS.md)
  mcp install|remove|status [h|all]  Manage the opt-in MCP shim entries (mesh_send/mesh_ask/mesh_inbox/mesh_status)
  wake install|remove|status [h|all] Manage the opt-in idle-wake source (Claude hook, Codex injector)
  whoami [--session id] [--line]     Show a session's mesh identity (by session, pid, or current directory)
  mute | unmute                      Disable/enable waking idle sessions (mail then waits for the next prompt)
  probe-wake <harness>               Guided run that records whether a harness wakes an idle session (evidence row)
  hooks install [harnesses...]       Install lifecycle hooks for specified (or detected) harnesses
  hooks uninstall [harnesses...]     Remove agent-mesh hooks cleanly
  hooks doctor, doctor               Inspect configuration, verify broker, and view recent hook logs
  hooks watch [--sound] [--popup]    Watch real-time presence hook events with terminal bell & chime
  ask --to <agent>                   Enqueue a non-blocking question for an agent (returns ticket)
  send --to <agent>                  Send a one-way notification message
  reply --ticket <id> --to <agent>   Reply to a previous question ticket
  inbox <agent>                      Inspect pending (or --delivered) messages for an agent
  watch <agent> | watch hooks        Live tail an agent's event stream or universal presence hooks
  attach <agent>                     Acquire session lease and launch native interactive harness
      `);
      break;
  }
}

main().catch((err) => {
  console.error(`CLI error: ${err.message}`);
  process.exit(1);
});
