#!/usr/bin/env node
/**
 * @file stop-hook.mjs
 * @description Claude Code Stop Hook for agent-mesh.
 * Automatically connects human-interactive Claude Code sessions to the mesh.
 * When Claude finishes a turn and attempts to stop, this hook queries the mesh inbox.
 * If incoming messages from other agents are pending, it blocks the stop and prompts Claude.
 */

import { getIpcAddress, sendIpcRequest } from "../ipc.mjs";

async function main() {
  // Prevent infinite loops if hook is already active
  if (process.env.STOP_HOOK_ACTIVE === "1") {
    process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
    process.exit(0);
  }

  const cwd = process.cwd();
  const address = getIpcAddress(cwd);

  try {
    // H2: Atomically claim messages so headless broker doesn't double-process them
    const res = await sendIpcRequest(address, {
      action: "claim_inbox",
      payload: { agent: "claude" },
    });

    if (res.ok && res.messages && res.messages.length > 0) {
      const formatted = res.messages
        .map((m) => `[From: ${m.from_agent} | Ticket: ${m.id}]:\n${m.body}`)
        .join("\n\n---\n\n");

      // Block stopping and feed waiting messages directly into Claude's turn
      const payload = {
        decision: "block",
        reason: `[AGENT-MESH INBOX NOTIFICATION]\nYou have ${res.messages.length} message(s) waiting from other agents in the mesh:\n\n${formatted}\n\nPlease review and respond as appropriate.`,
      };

      process.stdout.write(JSON.stringify(payload) + "\n");
      process.exit(0);
    }
  } catch {
    // If broker is offline, allow normal stop without interruption
  }

  process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
});
