/**
 * @file wake-probe.mjs
 * @description `mesh probe-wake <harness>`: turns "does this harness wake an idle session?" into recorded
 * evidence. The probe arms a nonce emitter (what a model would run as a background command / watcher), the
 * human answers what the harness did, and the pure functions below turn the answers into a descriptor snippet
 * and an evidence row for docs/ADAPTERS.md. Full automation needs a TTY and a model, so the interactive part
 * is a guided script; everything that can be unit-tested lives in pure functions.
 */

import { randomBytes } from "node:crypto";

export const PROBE_QUESTIONS = [
  { key: "idleWake", text: "The harness was IDLE (no turn running). Did the emitted nonce start a turn / appear to the model without you typing?" },
  { key: "secondSignal", text: "Stream mode only: did a SECOND nonce line also wake it (without re-arming)? (answer 'n' for oneshot)" },
  { key: "survivesTurnEnd", text: "After a normal turn ended (you typed something, it answered), was the listener still armed and still able to wake?" },
  { key: "diesOnExit", text: "After you closed the harness session, did the listener process exit by itself?" },
  { key: "permissionPrompt", text: "Did arming the listener (or its first wake) show a permission/approval prompt?" },
  { key: "latencySec", text: "Seconds between the nonce being emitted and the model reacting (number; blank = unknown):", numeric: true },
];

/** Cleans a boolean-ish answer. */
export function parseYesNo(text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (["y", "yes", "true", "1"].includes(t)) return true;
  if (["n", "no", "false", "0"].includes(t)) return false;
  return null;
}

/** Fresh nonce so a wake can be attributed to this probe run. */
export const newNonce = () => `MESH-PROBE-${randomBytes(4).toString("hex")}`;

/**
 * Instructions for the human/model for one candidate arm method.
 * @param {{ id: string, displayName: string }} harness descriptor (only id/displayName used)
 * @param {{ nonce: string, afterSec: number, stream: boolean, emitCommand: string }} opts
 */
export function buildProbePlan(harness, { nonce, afterSec, stream, emitCommand }) {
  const lines = [
    `Wake probe for ${harness.displayName} (${harness.id})`,
    `Nonce: ${nonce}`,
    "",
    "1. Open a fresh interactive session and let it become IDLE (say hello, wait for the answer).",
    `2. Ask it to run this as a ${stream ? "background watcher (each output line must reach the model)" : "background command (its exit must reach the model)"}:`,
    `     ${emitCommand}`,
    `   It prints "${nonce}" after ${afterSec}s${stream ? " and again every " + afterSec + "s" : ""}.`,
    "3. Do NOT type anything. Watch whether the model reacts to the nonce on its own.",
    stream ? "4. Let at least two signals pass, then answer the questions below." : "4. Answer the questions below.",
  ];
  return lines.join("\n");
}

/**
 * Turns the answers into the wake spec the evidence supports.
 * @param {Record<string, boolean|number|null>} answers keys from PROBE_QUESTIONS
 * @param {{ launcher: string, version: string, date: string, stream: boolean }} ctx
 * @returns {{ spec: object, summary: string }}
 */
export function evaluateProbe(answers, { launcher, version, date, stream }) {
  let tier = "pull";
  if (answers.idleWake === true) tier = stream && answers.secondSignal === true ? "stream" : "oneshot";
  const spec = {
    tier,
    launcher,
    survivesTurnEnd: answers.survivesTurnEnd === true,
    needsPermission: answers.permissionPrompt === true,
    ...(tier === "pull" ? {} : { evidence: { version, date, verified: true, basis: `mesh probe-wake (${launcher})` } }),
  };
  const summary = [
    `idle wake: ${fmt(answers.idleWake)}`,
    `second signal: ${fmt(answers.secondSignal)}`,
    `survives turn end: ${fmt(answers.survivesTurnEnd)}`,
    `dies on session exit: ${fmt(answers.diesOnExit)}`,
    `permission prompt: ${fmt(answers.permissionPrompt)}`,
    `latency: ${answers.latencySec == null ? "unknown" : `${answers.latencySec}s`}`,
  ].join("; ");
  return { spec, summary };
}

const fmt = (v) => (v === true ? "yes" : v === false ? "no" : "unknown");

/** Markdown evidence row for docs/ADAPTERS.md "Wake tiers". */
export function formatEvidenceRow(harnessId, result, { version, date }) {
  return `| ${harnessId} | ${result.spec.tier} | ${result.spec.launcher} | ${result.summary} | ${version}, ${date} |`;
}

/** JS snippet to paste into the descriptor's `delivery.wake`. */
export function formatDescriptorSnippet(result) {
  return `wake: ${JSON.stringify(result.spec, null, 2).replace(/\n/g, "\n    ")},`;
}
