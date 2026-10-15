/**
 * Wake tiers on descriptors + the probe helper's pure logic (guided run needs a TTY and a model, so the
 * evaluation, snippet and evidence-row generation are unit-tested here with a fake harness).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";

const registry = await import("../src/harnesses/index.mjs");
const probe = await import("../src/wait/wake-probe.mjs");

const EMIT = join(import.meta.dirname, "..", "src", "wait", "probe-emit.mjs");
const fake = {
  id: "fakeharness",
  aliases: [],
  displayName: "Fake",
  discovery: { binaries: [], markers: () => [], projectDir: ".fake" },
  presence: [{ kind: "wake", optIn: true, script: "x", resolvePaths: () => ({ targetPath: "x" }), install() {}, uninstall() {}, diagnose() {} }],
  pid: "direct",
  end: { signals: ["pid"] },
  delivery: { via: "hook", inject: ["prompt"], idle: "toast-only", wake: { tier: "pull", launcher: "hook", survivesTurnEnd: false, needsPermission: false } },
};
const clone = (patch) => ({ ...fake, delivery: { ...fake.delivery, ...patch } });

test("every real descriptor declares a valid wake spec; tiers above pull carry evidence", () => {
  for (const h of registry.all()) {
    const w = h.delivery.wake;
    assert.ok(["pull", "push", "stream", "oneshot"].includes(w.tier), h.id);
    if (w.tier !== "pull") assert.ok(w.evidence.version && w.evidence.date && w.evidence.basis, `${h.id} evidence`);
    if (w.candidate) assert.ok(w.candidate.evidence.version && w.candidate.tier !== "pull", `${h.id} candidate`);
  }
  assert.equal(registry.get("pi").delivery.wake.tier, "push");
  assert.equal(registry.get("opencode").delivery.wake.tier, "push");
  assert.equal(registry.get("claude").delivery.wake.tier, "pull", "claude stays pull until a probe run proves more");
  assert.equal(registry.get("antigravity").delivery.wake.tier, "pull");
});

test("contract: a tier above pull without evidence, or idle/tier mismatch, is rejected", () => {
  assert.doesNotThrow(() => registry.validateDescriptor(fake));
  assert.throws(
    () => registry.validateDescriptor(clone({ idle: "inject", wake: { tier: "push", launcher: "plugin", survivesTurnEnd: true, needsPermission: false } })),
    /requires evidence/
  );
  assert.throws(
    () => registry.validateDescriptor(clone({ idle: "inject", wake: { tier: "pull", launcher: "hook", survivesTurnEnd: false, needsPermission: false } })),
    /must match a wake tier/
  );
  assert.throws(() => registry.validateDescriptor(clone({ wake: { tier: "magic" } })), /tier must be/);
  assert.throws(
    () => registry.validateDescriptor(clone({ wake: { ...fake.delivery.wake, candidate: { tier: "oneshot", launcher: "hook" } } })),
    /candidate needs/
  );
});

test("probe evaluation maps answers to a tier, snippet and evidence row", () => {
  const ctx = { launcher: "hook", version: "fake 9.9", date: "2026-10-15", stream: true };
  const stream = probe.evaluateProbe({ idleWake: true, secondSignal: true, survivesTurnEnd: true, diesOnExit: true, permissionPrompt: false, latencySec: 3 }, ctx);
  assert.deepEqual([stream.spec.tier, stream.spec.survivesTurnEnd, stream.spec.needsPermission], ["stream", true, false]);
  assert.equal(stream.spec.evidence.verified, true);

  const oneshot = probe.evaluateProbe({ idleWake: true, secondSignal: false, survivesTurnEnd: false, diesOnExit: null, permissionPrompt: true, latencySec: null }, ctx);
  assert.deepEqual([oneshot.spec.tier, oneshot.spec.needsPermission], ["oneshot", true]);

  const pull = probe.evaluateProbe({ idleWake: false, secondSignal: null, survivesTurnEnd: null, diesOnExit: null, permissionPrompt: false, latencySec: null }, ctx);
  assert.equal(pull.spec.tier, "pull");
  assert.equal(pull.spec.evidence, undefined, "pull needs no evidence");
  // a probe result can be pasted back into a descriptor and must validate
  registry.validateDescriptor({ ...fake, delivery: { ...fake.delivery, idle: "inject", wake: stream.spec } });

  const row = probe.formatEvidenceRow("fakeharness", stream, { version: "fake 9.9", date: "2026-10-15" });
  assert.match(row, /^\| fakeharness \| stream \| hook \| idle wake: yes; second signal: yes;/);
  assert.match(probe.formatDescriptorSnippet(stream), /^wake: \{/);
  assert.deepEqual([probe.parseYesNo("Y"), probe.parseYesNo("no"), probe.parseYesNo("")], [true, false, null]);
});

test("probe plan names the nonce and the emitter command", () => {
  const nonce = probe.newNonce();
  assert.match(nonce, /^MESH-PROBE-[0-9a-f]{8}$/);
  const plan = probe.buildProbePlan({ id: "fakeharness", displayName: "Fake" }, { nonce, afterSec: 20, stream: false, emitCommand: `node probe-emit.mjs --nonce ${nonce}` });
  assert.ok(plan.includes(nonce) && plan.includes("probe-emit.mjs") && plan.includes("background command"));
});

test("probe emitter prints the nonce once (oneshot) or repeatedly (--repeat)", async () => {
  const run = (args, killAfterMs) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [EMIT, ...args], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("exit", () => resolve(out));
      if (killAfterMs) setTimeout(() => child.kill(), killAfterMs);
    });
  const once = await run(["--nonce", "N1", "--after", "0.1"]);
  assert.equal(once.trim().split("\n").length, 1);
  assert.match(once, /^N1 signal=1/);
  const many = await run(["--nonce", "N2", "--after", "0.1", "--repeat"], 700);
  assert.ok(many.trim().split("\n").length >= 2);
});
