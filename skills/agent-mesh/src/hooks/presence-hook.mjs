#!/usr/bin/env node
/**
 * @file presence-hook.mjs
 * @description Universal Claude Code lifecycle presence and inbox injection hook for agent-mesh.
 * Handles SessionStart, UserPromptSubmit, Stop, and SessionEnd events:
 * - Announces authentic session UUID and PID to the broker for live discovery.
 * - Injects waiting messages from peer agents on Stop without printing extraneous output.
 */

import { existsSync, mkdirSync, writeFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveIpcAddress, sendIpcRequest } from "../ipc.mjs";
import {
  readStdinJson,
  emitJson,
  resolveTrueHarnessPid,
  isBackgroundSession,
  resolveSessionName,
  appendHookAuditLog,
  notifyHookPresence,
  getMeshHome,
} from "./common.mjs";

async function main() {
  const startTime = Date.now();

  // Hard execution timeout. Budget covers the once-per-session process-tree walk (1-5s) that
  // blocks the event loop; an overdue 1s timer would otherwise exit before the broker announce.
  const safetyTimer = setTimeout(() => process.exit(0), 8000);
  safetyTimer.unref?.();

  let input = {};

  try {
    input = await readStdinJson();
  } catch {}

  const eventArgIdx = process.argv.indexOf("--event");
  const eventName =
    (eventArgIdx !== -1 && process.argv[eventArgIdx + 1]) ||
    input.hook_event_name ||
    input.event ||
    (input.stop_hook_active !== undefined ? "Stop" : "SessionStart");

  const sessionId =
    input.session_id ||
    input.sessionId ||
    input.conversationId ||
    process.env.CLAUDE_CODE_SESSION_ID ||
    process.env.SESSION_ID ||
    null;

  // Headless guard: if invoked from within a mesh headless turn, exit cleanly
  if (process.env.MESH_AGENT) {
    process.exit(0);
  }

  if (!sessionId) {
    process.exit(0);
  }

  const harnessArgIdx = process.argv.indexOf("--harness");
  const harness = harnessArgIdx !== -1 && process.argv[harnessArgIdx + 1]
    ? process.argv[harnessArgIdx + 1]
    : "claude";

  // Deduplication guard: Claude Code can fire hooks from both plugin hooks.json and settings.json
  const cleanSessionId = String(sessionId).replace(/[^\w-]/g, "");
  const dedupeDir = join(getMeshHome(), ".agent-mesh", "locks");
  const lockFile = join(dedupeDir, `${cleanSessionId}-${eventName}.lock`);
  try {
    if (existsSync(lockFile)) {
      const age = Date.now() - statSync(lockFile).mtimeMs;
      if (age < 1500) {
        process.exit(0);
      }
    }
    mkdirSync(dedupeDir, { recursive: true });
    writeFileSync(lockFile, String(Date.now()), "utf8");
  } catch {}

  const cwd = input.cwd || process.cwd();
  const address = resolveIpcAddress(cwd);
  const pid = resolveTrueHarnessPid(sessionId, { harness, event: eventName });
  const name = resolveSessionName(harness, sessionId, input);
  const transcript = input.transcript_path || null; // lets the broker notice /rename without a hook event

  // Background/forked/daemon processes are not user terminals: stay silent (no session, no toast).
  if (isBackgroundSession(sessionId)) {
    process.exit(0);
  }

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
            name,
            transcript,
          },
        }, 0, { timeoutMs: 800 });
        ok = res?.ok ?? false;
      } catch (e) {
        err = e.message;
      }

      notifyHookPresence({
        harness,
        event: "SessionStart",
        state: "start",
        sessionId,
        pid,
      });

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
            name,
            transcript,
          },
        }, 0, { timeoutMs: 800 });
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
        }, 1, { timeoutMs: 800 });

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
          }, 0, { timeoutMs: 800 }).catch(() => {});

          notifyHookPresence({
            harness,
            event: "InboxMessage",
            state: "received",
            sessionId,
            pid,
          });

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
            payload: { harness, sessionId, event: "idle", pid, cwd, name, transcript },
          }, 0, { timeoutMs: 800 }).catch(() => {});

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
      // Toast first: harnesses may kill the hook right after exit, and it must not depend on the broker.
      notifyHookPresence({
        harness,
        event: "SessionEnd",
        state: "end",
        sessionId,
        pid,
      });

      // 150ms was too tight (session stayed live on a long-lived harness PID); 800ms stays well
      // inside harness SessionEnd cancellation windows.
      let endOk = true;
      let endErr = null;
      try {
        await sendIpcRequest(address, {
          action: "session_event",
          payload: { harness, sessionId, event: "end", pid, cwd },
        }, 0, { timeoutMs: 800 });
      } catch (e) {
        endOk = false;
        endErr = e.message;
      }

      // Clean up session pid cache and lock files
      try {
        unlinkSync(join(getMeshHome(), ".agent-mesh", "pids", `${cleanSessionId}.pid`));
      } catch {}
      try {
        unlinkSync(lockFile);
      } catch {}

      appendHookAuditLog({
        harness,
        event: "SessionEnd",
        state: "end",
        sessionId,
        pid,
        address,
        cwd,
        ok: endOk,
        error: endErr,
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
