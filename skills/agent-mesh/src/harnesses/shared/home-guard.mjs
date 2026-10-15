/**
 * @file home-guard.mjs
 * @description Hard guard against tests (or probes) writing into the REAL user home. Active when running under
 * `node --test` (NODE_TEST_CONTEXT is inherited by every child process) or when MESH_PROTECT_HOME=1. A write
 * target inside the OS account's home directory but outside the temp directory throws; temp HOMEs are fine.
 */

import { userInfo, tmpdir } from "node:os";
import { resolve, sep } from "node:path";

const under = (child, parent) => {
  const c = resolve(child).toLowerCase();
  const p = resolve(parent).toLowerCase();
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
};

export const homeGuardActive = () => Boolean(process.env.NODE_TEST_CONTEXT || process.env.MESH_PROTECT_HOME === "1");

/**
 * @param {string} path file or directory about to be written/removed
 * @throws when the guard is active and the path is in the real home (not under the temp directory)
 */
export function guardWrite(path) {
  if (!homeGuardActive() || !path) return;
  let realHome;
  try {
    realHome = userInfo().homedir; // from the OS account, ignores HOME/USERPROFILE overrides
  } catch {
    return;
  }
  if (under(path, realHome) && !under(path, tmpdir())) {
    throw new Error(`home guard: refusing to write ${path} (inside the real home while running under tests)`);
  }
}
