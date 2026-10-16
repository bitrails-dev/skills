#!/usr/bin/env node
/**
 * @file stop-hook.mjs
 * @description Claude Code Stop Hook for agent-mesh.
 * When Claude finishes a turn and attempts to stop, this hook claims pending mesh
 * messages, blocks the stop to inject them into the next turn, and acknowledges
 * delivery so tickets do not stay in 'claimed' limbo (H5).
 */

import { sendIpcRequest, resolveIpcAddress } from "../ipc.mjs";
import { formatBatch } from "../presence/inbox-format.mjs";
import { settleClaim } from "../presence/announce.mjs";

/**
 * Reads Claude Code hook input from stdin.
 * @returns {Promise<object>} Parsed hook payload ({} on missing/invalid input).
 */
function readHookInput() {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    };

    if (process.stdin.isTTY) return finish();

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", finish);
    // Guard against harnesses that never close stdin
    setTimeout(finish, 2000).unref();
  });
}

const allow = () => {
  process.exit(0);
};

async function main() {
  const input = await readHookInput();

  // Loop guard: authoritative stop_hook_active from stdin JSON, env as fallback
  if (input.stop_hook_active === true || process.env.STOP_HOOK_ACTIVE === "1") {
    return allow();
  }

  // Headless guard: if running as a background mesh turn, never block interactive stops
  if (process.env.MESH_AGENT) {
    return allow();
  }

  const address = resolveIpcAddress(process.cwd());
  const agentName = "claude";
  const sessionId = input.session_id || null;

  try {
    // Atomically claim messages for this agent and session
    const res = await sendIpcRequest(address, {
      action: "claim_inbox",
      payload: { agent: agentName, sessionId },
    });

    if (res.ok && res.messages && res.messages.length > 0) {
      const batch = formatBatch(res.messages);
      process.stdout.write(JSON.stringify({ decision: "block", reason: batch.text }) + "\n");

      // The block reason injects the batch into the next turn, which is delivery (H5); the rest is released
      await settleClaim(address, batch);
    } else {
      allow();
    }
  } catch {
    // If broker is offline, allow normal stop without interruption
    allow();
  }
}

main().catch(allow);
