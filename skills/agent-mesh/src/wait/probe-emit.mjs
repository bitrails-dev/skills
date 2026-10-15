#!/usr/bin/env node
/**
 * Nonce emitter used by `mesh probe-wake`: prints a nonce after N seconds (oneshot: then exits; --repeat: keeps
 * printing every N seconds, one line per signal). Usage: probe-emit.mjs --nonce X --after 20 [--repeat]
 */
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : fallback;
};
const nonce = arg("--nonce", "MESH-PROBE");
const afterMs = Number(arg("--after", "20")) * 1000;
const repeat = process.argv.includes("--repeat");
let n = 0;
const timer = setInterval(() => {
  n++;
  process.stdout.write(`${nonce} signal=${n} t=${new Date().toISOString()}\n`);
  if (!repeat) {
    clearInterval(timer);
    process.exit(0);
  }
}, afterMs);
