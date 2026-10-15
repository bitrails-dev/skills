import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

/**
 * One-shot read-only sqlite query. Returns the first row, or null when the file/row/schema is missing.
 * node:sqlite is required lazily so hooks that never need it skip the experimental-feature warning.
 * @param {string} path
 * @param {string} sql
 * @param {...any} args
 * @returns {object|null}
 */
export function readSqliteRow(path, sql, ...args) {
  let db;
  try {
    if (!existsSync(path)) return null;
    const { DatabaseSync } = nodeRequire("node:sqlite");
    db = new DatabaseSync(path, { readOnly: true });
    return db.prepare(sql).get(...args) || null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

/** Creates/opens a database and runs `sql` (fixtures and tests only; descriptors read read-only). */
export function execSqlite(path, sql) {
  const { DatabaseSync } = nodeRequire("node:sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
