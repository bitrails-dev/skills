#!/usr/bin/env node
/**
 * `npx agent-mesh [options]` / `node scripts/agent-mesh.mjs`: the single-command install flow.
 * Equivalent to `mesh setup [options]`.
 */
process.argv.splice(2, 0, "setup");
await import("./mesh.mjs");
