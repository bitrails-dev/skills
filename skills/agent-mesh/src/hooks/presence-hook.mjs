#!/usr/bin/env node
/**
 * @file presence-hook.mjs
 * @description Universal Claude Code lifecycle presence and inbox injection hook for agent-mesh.
 * Handles SessionStart, UserPromptSubmit, Stop, and SessionEnd events:
 * - Announces authentic session UUID and PID to the broker for live discovery.
 * - Injects waiting messages from peer agents on Stop without printing extraneous output.
 */

import { resolveIpcAddress, sendIpcRequest } from "../ipc.mjs";
import {
  readStdinJson,
  emitJson,
  resolveTrueHarnessPid,
  appendHookAuditLog,
} from "./common.mjs";

async function main() {
  const startTime = Date.now();
  let input = {};

  try {
    input = await readStdinJson();
  } catch {}

  const eventName = input.hook_event_name || (input.stop_hook_active !== undefined ? "Stop" : "SessionStart");
  const sessionId = input.session_id;

  // Headless guard: if invoked from within a mesh headless turn, exit cleanly
  if (process.env.MESH_AGENT) {
    process.exit(0);
  }

  if (!sessionId) {
    process.exit(0);
  }

  const cwd = input.cwd || process.cwd();
  const address = resolveIpcAddress(cwd);
  const pid = resolveTrueHarnessPid(sessionId);

  const harnessArgIdx = process.argv.indexOf("--harness");
  const harness = harnessArgIdx !== -1 && process.argv[harnessArgIdx + 1]
    ? process.argv[harnessArgIdx + 1]
    : "claude";

  switch (eventName) {
    case "SessionStart": {
      let ok = false;
      let err = null;
      try {
        const res = await sendIpcRequest(address, {
          action: "session_event",
          payload: {
            harness,
            sessionId,
            event: "start",
            pid,
            cwd,
            origin: "interactive",
          },
        }, 0);
        ok = res?.ok ?? false;
      } catch (e) {
        err = e.message;
      }

      appendHookAuditLog({
        harness,
        event: "SessionStart",
        state: "start",
        sessionId,
        pid,
        address,
        cwd,
        ok,
        error: err,
        durationMs: Date.now() - startTime,
      });

      // Print nothing to avoid polluting model context
      process.exit(0);
      break;
    }

    case "UserPromptSubmit": {
      let ok = false;
      let err = null;
      try {
        const res = await sendIpcRequest(address, {
          action: "session_event",
          payload: {
            harness,
            sessionId,
            event: "busy",
            pid,
            cwd,
            origin: "interactive",
          },
        }, 0);
        ok = res?.ok ?? false;
      } catch (e) {
        err = e.message;
      }

      appendHookAuditLog({
        harness,
        event: "UserPromptSubmit",
        state: "busy",
        sessionId,
        pid,
        address,
        cwd,
        ok,
        error: err,
        durationMs: Date.now() - startTime,
      });

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
          payload: { agent: harness, sessionId },
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

          appendHookAuditLog({
            harness,
            event: "Stop",
            state: "block",
            inboxCount: res.messages.length,
            sessionId,
            pid,
            address,
            cwd,
            ok: true,
            durationMs: Date.now() - startTime,
          });
        } else {
          // Announce idle
          await sendIpcRequest(address, {
            action: "session_event",
            payload: { harness, sessionId, event: "idle", pid, cwd },
          }, 0).catch(() => {});

          appendHookAuditLog({
            harness,
            event: "Stop",
            state: "idle",
            inboxCount: 0,
            sessionId,
            pid,
            address,
            cwd,
            ok: true,
            durationMs: Date.now() - startTime,
          });

          process.exit(0);
        }
      } catch (err) {
        appendHookAuditLog({
          harness,
          event: "Stop",
          sessionId,
          pid,
          address,
          cwd,
          ok: false,
          error: err.message,
          durationMs: Date.now() - startTime,
        });
        process.exit(0);
      }
      break;
    }

    case "SessionEnd": {
      await sendIpcRequest(address, {
        action: "session_event",
        payload: { harness, sessionId, event: "end", pid, cwd },
      }, 0).catch(() => {});

      appendHookAuditLog({
        harness,
        event: "SessionEnd",
        state: "end",
        sessionId,
        pid,
        address,
        cwd,
        ok: true,
        durationMs: Date.now() - startTime,
      });

      process.exit(0);
      break;
    }

    default:
      process.exit(0);
  }
}

main().catch(() => process.exit(0));
