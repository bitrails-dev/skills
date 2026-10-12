#!/usr/bin/env node
/**
 * @file stop-hook.mjs
 * @description Claude Code Stop Hook for agent-mesh.
 * When Claude finishes a turn and attempts to stop, this hook claims pending mesh
 * messages, blocks the stop to inject them into the next turn, and acknowledges
 * delivery so tickets do not stay in 'claimed' limbo (H5).
 */

import { getIpcAddress, sendIpcRequest, resolveIpcAddress } from "../ipc.mjs";

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
  process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
};

async function main() {
  const input = await readHookInput();

  // Loop guard: authoritative stop_hook_active from stdin JSON, env as fallback
  if (input.stop_hook_active === true || process.env.STOP_HOOK_ACTIVE === "1") {
    return allow();
  }

  const address = resolveIpcAddress(process.cwd());

  try {
    // Atomically claim messages so the headless broker doesn't double-process them
    const res = await sendIpcRequest(address, {
      action: "claim_inbox",
      payload: { agent: "claude" },
    });

    if (res.ok && res.messages && res.messages.length > 0) {
      const formatted = res.messages
        .map((m) => `[From: ${m.from_agent} | Ticket: ${m.id}]:\n${m.body}`)
        .join("\n\n---\n\n");

      const payload = {
        decision: "block",
        reason: `[AGENT-MESH INBOX NOTIFICATION]\nYou have ${res.messages.length} message(s) waiting from other agents in the mesh:\n\n${formatted}\n\nPlease review and respond as appropriate.`,
      };
      process.stdout.write(JSON.stringify(payload) + "\n");

      // Acknowledge: the block reason injects these messages into the next turn,
      // which is delivery for interactive sessions (H5)
      await sendIpcRequest(address, {
        action: "ack",
        payload: { ids: res.messages.map((m) => m.id) },
      }).catch(() => {});
    } else {
      allow();
    }
  } catch {
    // If broker is offline, allow normal stop without interruption
    allow();
  }
}

main().catch(allow);
