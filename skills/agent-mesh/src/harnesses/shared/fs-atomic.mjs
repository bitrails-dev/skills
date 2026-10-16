/**
 * @file fs-atomic.mjs
 * @description The one way mesh writes user-owned config: guarded (home guard), atomic (tmp + rename) and
 * backed up (`<file>.bak` holds the pre-change state) whenever the content actually changes.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { guardWrite } from "./home-guard.mjs";

/**
 * @param {string} filePath
 * @param {string} text
 * @param {{ backup?: boolean }} [opts]
 * @returns {boolean} true when the file changed
 */
export function atomicWriteText(filePath, text, { backup = true } = {}) {
  guardWrite(filePath);
  if (existsSync(filePath)) {
    let current = null;
    try {
      current = readFileSync(filePath, "utf8");
    } catch {}
    if (current === text) return false;
    if (backup) {
      try {
        copyFileSync(filePath, `${filePath}.bak`);
      } catch {}
    }
  }
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, filePath);
  return true;
}
