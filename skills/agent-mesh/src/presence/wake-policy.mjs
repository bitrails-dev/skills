/**
 * @file wake-policy.mjs
 * @description Broker-side guardrails for waking IDLE sessions (anything that starts a turn without a human):
 * - global mute switch (`mesh mute` / `mesh unmute`), persisted so it survives broker restarts
 * - per-session wake budget (default 6 wakes per 10 minutes, MESH_WAKE_BUDGET / MESH_WAKE_WINDOW_MS)
 * A refused wake is not a loss: the mail stays pending and is delivered at the session's next prompt (pull),
 * with a "message waiting" toast as the floor.
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { guardWrite } from "../harnesses/shared/home-guard.mjs";

export class WakePolicy {
  /**
   * @param {object} opts
   * @param {string} opts.meshHome directory holding `.agent-mesh/`
   * @param {number} [opts.budget]
   * @param {number} [opts.windowMs]
   * @param {() => number} [opts.now]
   */
  constructor({ meshHome, budget, windowMs, now = Date.now }) {
    this.budget = budget ?? Number(process.env.MESH_WAKE_BUDGET || 6);
    this.windowMs = windowMs ?? Number(process.env.MESH_WAKE_WINDOW_MS || 10 * 60 * 1000);
    this.now = now;
    this.muteFile = join(meshHome, ".agent-mesh", "wake-muted");
    this.log = new Map(); // key (session id or agent) -> wake timestamps inside the window
  }

  isMuted() {
    return existsSync(this.muteFile);
  }

  setMuted(muted) {
    guardWrite(this.muteFile);
    if (muted) {
      mkdirSync(dirname(this.muteFile), { recursive: true });
      writeFileSync(this.muteFile, String(this.now()), "utf8");
    } else if (existsSync(this.muteFile)) {
      unlinkSync(this.muteFile);
    }
  }

  #recent(key) {
    const cutoff = this.now() - this.windowMs;
    const list = (this.log.get(key) || []).filter((t) => t > cutoff);
    this.log.set(key, list);
    return list;
  }

  /** @returns {{ ok: boolean, reason?: "muted"|"budget" }} */
  check(key) {
    if (this.isMuted()) return { ok: false, reason: "muted" };
    if (this.#recent(key).length >= this.budget) return { ok: false, reason: "budget" };
    return { ok: true };
  }

  record(key) {
    this.#recent(key).push(this.now());
  }

  snapshot() {
    return { muted: this.isMuted(), budget: this.budget, windowMs: this.windowMs };
  }
}

/** Broker-side opt-in config for harness injectors (`mesh --init <harness> --wake`): { "<harness>": true }. */
export const wakeConfigPath = (meshHome) => join(meshHome, ".agent-mesh", "wake.json");

export function readWakeConfig(meshHome) {
  try {
    const parsed = JSON.parse(readFileSync(wakeConfigPath(meshHome), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeWakeConfig(meshHome, config) {
  const path = wakeConfigPath(meshHome);
  guardWrite(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}
