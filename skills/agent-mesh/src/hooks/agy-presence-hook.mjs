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

import { resolveIpcAddress, sendIpcRequest } from "../ipc.mjs";
import { readStdinJson, formatMessages, emitJson } from "./common.mjs";

async function main() {
  let phase = "Stop"; // Safe default
  let input = {};

  try {
    input = await readStdinJson({ timeoutMs: 1000 });
    const eventName = input.event || input.hook_event_name || input.hookName;

    if (eventName === "PreInvocation" || input.invocationNum !== undefined) {
      phase = "PreInvocation";
    } else {
      phase = "Stop";
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

    const address = resolveIpcAddress(process.cwd());
    const pid = process.ppid || process.pid;
    const cwd = Array.isArray(input.workspacePaths) && input.workspacePaths[0]
      ? input.workspacePaths[0]
      : process.cwd();

    if (phase === "PreInvocation") {
      // Announce busy turn to broker (maxRetries: 0 to respect timeout)
      await sendIpcRequest(
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
        0
      ).catch(() => {});

      // PreInvocation expects a JSON object on stdout (e.g. {})
      await emitJson({});
      process.exit(0);
    }

    // Phase: Stop
    try {
      const res = await sendIpcRequest(
        address,
        {
          action: "claim_inbox",
          payload: { agent: "antigravity", sessionId },
        },
        0
      ).catch(() => null);

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
          0
        ).catch(() => {});
      } else {
        // Announce idle
        await sendIpcRequest(
          address,
          {
            action: "session_event",
            payload: { harness: "antigravity", sessionId, event: "idle", pid },
          },
          0
        ).catch(() => {});

        // Allow agent execution loop to terminate
        await emitJson({ decision: "allow" });
      }
    } catch {
      await emitJson({ decision: "allow" });
    }
  } catch {
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
