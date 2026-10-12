#!/usr/bin/env node
/**
 * @file presence-hook.mjs
 * @description Universal Claude Code lifecycle presence and inbox injection hook for agent-mesh.
 * Handles SessionStart, UserPromptSubmit, Stop, and SessionEnd events:
 * - Announces authentic session UUID and PID to the broker for live discovery.
 * - Injects waiting messages from peer agents on Stop without printing extraneous output.
 */

import { resolveIpcAddress, sendIpcRequest } from "../ipc.mjs";
import { readStdinJson, emitJson } from "./common.mjs";

/**
 * Resolves the parent Claude Code process ID.
 * On Windows/POSIX, process.ppid is the shell or direct caller.
 * @returns {number}
 */
function resolveHarnessPid() {
  return process.ppid || process.pid;
}

async function main() {
  const input = await readStdinJson();
  const eventName = input.hook_event_name || (input.stop_hook_active !== undefined ? "Stop" : "SessionStart");
  const sessionId = input.session_id;

  // Headless guard: if invoked from within a mesh headless turn, exit cleanly
  if (process.env.MESH_AGENT) {
    process.exit(0);
  }

  const address = resolveIpcAddress(process.cwd());
  const pid = resolveHarnessPid();

  if (!sessionId) {
    process.exit(0);
  }

  switch (eventName) {
    case "SessionStart": {
      // Announce live session to broker with authentic UUID
      await sendIpcRequest(address, {
        action: "session_event",
        payload: {
          harness: "claude",
          sessionId,
          event: "start",
          pid,
          cwd: input.cwd || process.cwd(),
          origin: "interactive",
        },
      }, 0).catch(() => {});
      // Print nothing to avoid polluting model context
      process.exit(0);
      break;
    }

    case "UserPromptSubmit": {
      await sendIpcRequest(address, {
        action: "session_event",
        payload: {
          harness: "claude",
          sessionId,
          event: "busy",
          pid,
          origin: "interactive",
        },
      }, 0).catch(() => {});
      process.exit(0);
      break;
    }

    case "Stop": {
      // Loop guard
      if (input.stop_hook_active === true || process.env.STOP_HOOK_ACTIVE === "1") {
        process.exit(0);
      }

      try {
        const res = await sendIpcRequest(address, {
          action: "claim_inbox",
          payload: { agent: "claude", sessionId },
        }, 1);

        if (res.ok && res.messages && res.messages.length > 0) {
          const formatted = res.messages
            .map((m) => `[From: ${m.from_agent} | Ticket: ${m.id}]:\n${m.body}`)
            .join("\n\n---\n\n");

          const payload = {
            decision: "block",
            reason: `[AGENT-MESH INBOX NOTIFICATION]\nYou have ${res.messages.length} message(s) waiting from other agents in the mesh:\n\n${formatted}\n\nPlease review and respond as appropriate.`,
          };
          await emitJson(payload);

          // Acknowledge delivery
          await sendIpcRequest(address, {
            action: "ack",
            payload: { ids: res.messages.map((m) => m.id) },
          }, 0).catch(() => {});
        } else {
          // Announce idle
          await sendIpcRequest(address, {
            action: "session_event",
            payload: { harness: "claude", sessionId, event: "idle", pid },
          }, 0).catch(() => {});
          process.exit(0);
        }
      } catch {
        process.exit(0);
      }
      break;
    }

    case "SessionEnd": {
      await sendIpcRequest(address, {
        action: "session_event",
        payload: { harness: "claude", sessionId, event: "end", pid },
      }, 0).catch(() => {});
      process.exit(0);
      break;
    }

    default:
      process.exit(0);
  }
}

main().catch(() => process.exit(0));
