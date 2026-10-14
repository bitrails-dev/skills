#!/usr/bin/env node
/**
 * @file agy-presence-hook.mjs
 * @description Antigravity (agy) lifecycle presence adapter for agent-mesh.
 * Implements PreInvocation and Stop event contracts with strict JSON I/O formatting:
 * - PreInvocation: Announces live interactive session to broker and outputs `{}`.
 * - Stop: Claims pending peer inbox messages and outputs `{"decision":"continue","reason":"..."}`
 *   or idle `{"decision":"allow"}` when the inbox is empty.
 * - Always emits valid JSON on stdout to adhere to Antigravity's protojson hook contract.
 */

import { fileURLToPath } from "node:url";
import { resolveIpcAddress, sendIpcRequest } from "../ipc.mjs";
import {
  readStdinJson,
  formatMessages,
  emitJson,
  resolveTrueHarnessPid,
  appendHookAuditLog,
} from "./common.mjs";

async function main() {
  const startTime = Date.now();

  // Hard execution timeout: guarantee hook exits cleanly before any harness timeout
  const safetyTimer = setTimeout(() => process.exit(0), 3000);
  safetyTimer.unref?.();

  let phase = "Stop"; // Safe default
  let input = {};

  try {
    input = await readStdinJson({ timeoutMs: 1000 });

    // Determine event phase: prefer explicit CLI argument over heuristic payload inspection
    const eventArgIdx = process.argv.indexOf("--event");
    if (eventArgIdx !== -1 && process.argv[eventArgIdx + 1]) {
      const explicit = process.argv[eventArgIdx + 1].toLowerCase();
      phase = explicit.includes("pre") ? "PreInvocation" : "Stop";
    } else if (process.argv.includes("pre") || process.argv.includes("PreInvocation")) {
      phase = "PreInvocation";
    } else if (process.argv.includes("stop") || process.argv.includes("Stop")) {
      phase = "Stop";
    } else {
      const eventName = input.event || input.hook_event_name || input.hookName;
      if (eventName === "PreInvocation" || (input.invocationNum !== undefined && input.decision === undefined)) {
        phase = "PreInvocation";
      } else {
        phase = "Stop";
      }
    }

    // Headless guard: if invoked inside a mesh-driven headless turn, exit with allow
    if (process.env.MESH_AGENT) {
      await emitJson(phase === "PreInvocation" ? {} : { decision: "allow" });
      process.exit(0);
    }

    const sessionId = input.conversationId;
    if (!sessionId) {
      await emitJson(phase === "PreInvocation" ? {} : { decision: "allow" });
      process.exit(0);
    }

    // Extract workspace directory, normalizing file:/// URIs if provided
    let cwd = process.cwd();
    if (Array.isArray(input.workspacePaths) && input.workspacePaths[0]) {
      let raw = input.workspacePaths[0];
      if (typeof raw === "string" && raw.startsWith("file:///")) {
        try {
          raw = fileURLToPath(raw);
        } catch {}
      }
      cwd = raw;
    }

    const address = resolveIpcAddress(cwd);
    const pid = resolveTrueHarnessPid(sessionId, { harness: "antigravity", event: phase });

    if (phase === "PreInvocation") {
      let reqOk = false;
      let reqErr = null;
      try {
        const res = await sendIpcRequest(
          address,
          {
            action: "session_event",
            payload: {
              harness: "antigravity",
              sessionId,
              event: "busy",
              pid,
              cwd,
              origin: "interactive",
            },
          },
          0,
          { timeoutMs: 800 }
        );
        reqOk = res?.ok ?? false;
      } catch (err) {
        reqErr = err.message;
      }

      appendHookAuditLog({
        harness: "antigravity",
        event: "PreInvocation",
        state: "busy",
        sessionId,
        pid,
        address,
        cwd,
        ok: reqOk,
        error: reqErr,
        durationMs: Date.now() - startTime,
      });

      // PreInvocation expects a JSON object on stdout (e.g. {})
      await emitJson({});
      process.exit(0);
    }

    // Phase: Stop
    let claimOk = false;
    let claimErr = null;
    let res = null;

    try {
      res = await sendIpcRequest(
        address,
        {
          action: "claim_inbox",
          payload: { agent: "antigravity", sessionId },
        },
        0,
        { timeoutMs: 800 }
      );
      claimOk = res?.ok ?? false;
    } catch (err) {
      claimErr = err.message;
    }

    if (res?.ok && Array.isArray(res.messages) && res.messages.length > 0) {
      const reason = formatMessages(res.messages);

      // Emit continue decision with prompt reason to re-enter agent execution loop
      await emitJson({
        decision: "continue",
        reason,
      });

      // Acknowledge delivery
      await sendIpcRequest(
        address,
        {
          action: "ack",
          payload: { ids: res.messages.map((m) => m.id) },
        },
        0,
        { timeoutMs: 800 }
      ).catch(() => {});

      appendHookAuditLog({
        harness: "antigravity",
        event: "Stop",
        state: "continue",
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
      let idleOk = false;
      try {
        const idleRes = await sendIpcRequest(
          address,
          {
            action: "session_event",
            payload: { harness: "antigravity", sessionId, event: "idle", pid, cwd },
          },
          0,
          { timeoutMs: 800 }
        );
        idleOk = idleRes?.ok ?? false;
      } catch {}

      appendHookAuditLog({
        harness: "antigravity",
        event: "Stop",
        state: "idle",
        inboxCount: 0,
        sessionId,
        pid,
        address,
        cwd,
        ok: claimOk || idleOk,
        error: claimErr,
        durationMs: Date.now() - startTime,
      });

      // Allow agent execution loop to terminate
      await emitJson({ decision: "allow" });
    }
  } catch (err) {
    appendHookAuditLog({
      harness: "antigravity",
      event: phase,
      sessionId: input?.conversationId || "unknown",
      ok: false,
      error: err.message,
      durationMs: Date.now() - startTime,
    });
    // Top-level catch-all: guarantees valid JSON is ALWAYS emitted on stdout
    await emitJson(phase === "PreInvocation" ? {} : { decision: "allow" });
  }

  process.exit(0);
}

main().catch(async () => {
  try {
    await emitJson({ decision: "allow" });
  } catch {}
  process.exit(0);
});
