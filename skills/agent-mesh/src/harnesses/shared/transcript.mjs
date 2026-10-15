import { statSync, openSync, readSync, closeSync } from "node:fs";

/**
 * Reads the last `bytes` of a file as utf8 text (append-only logs/transcripts grow large).
 * @param {string} path
 * @param {number} bytes
 * @returns {string}
 */
export function tailText(path, bytes) {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
