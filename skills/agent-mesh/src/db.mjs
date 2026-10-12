/**
 * @file db.mjs
 * @description Durable SQLite message and session repository for agent-mesh.
 * Implements WAL mode, atomic claim batches via RETURNING, and single-writer concurrency.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

if (!process.versions.sqlite) {
  throw new Error("agent-mesh requires Node.js >= 22.5 with built-in node:sqlite support.");
}

/**
 * Initializes the SQLite database with optimized pragmas and strict schemas.
 * @param {string} dbPath - Absolute path to the sqlite database file.
 * @returns {DatabaseSync} The initialized database instance.
 */
export function initDatabase(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  // Configure high-concurrency pragmas
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
  `);

  // Create core tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', -- active, input-required, completed, failed
      budget_turns INT NOT NULL DEFAULT 50,
      budget_tokens INT NOT NULL DEFAULT 1000000,
      used_turns INT NOT NULL DEFAULT 0,
      used_tokens INT NOT NULL DEFAULT 0,
      created_at INT NOT NULL,
      updated_at INT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      parent_id TEXT,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'ask', -- ask, reply, handoff, review, notify, cancel
      priority INT NOT NULL DEFAULT 0, -- 0: normal, 1: urgent, 2: human interrupt
      hops INT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', -- pending, claimed, delivered, dead
      body TEXT NOT NULL,
      refs_json TEXT,
      created_at INT NOT NULL,
      delivered_at INT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages (to_agent, status, priority DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id);

    CREATE TABLE IF NOT EXISTS sessions (
      harness TEXT NOT NULL,
      session_id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'idle', -- idle, busy, human-held, error, lost
      lease_holder TEXT,
      last_cost_usd REAL DEFAULT 0,
      last_turns INT DEFAULT 0,
      created_at INT NOT NULL,
      updated_at INT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_harness ON sessions (harness, state);
  `);

  return db;
}

/**
 * Repository helper wrapping pre-compiled prepared statements.
 */
export class MeshRepository {
  /**
   * @param {DatabaseSync} db
   */
  constructor(db) {
    this.db = db;

    // Precompile statements for optimal performance
    this.stmtInsertMessage = db.prepare(`
      INSERT INTO messages (id, conversation_id, parent_id, from_agent, to_agent, kind, priority, hops, status, body, refs_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `);

    this.stmtClaimMessages = db.prepare(`
      UPDATE messages
      SET status = 'claimed', delivered_at = ?
      WHERE to_agent = ? AND status = 'pending'
      RETURNING *
    `);

    this.stmtMarkDelivered = db.prepare(`
      UPDATE messages SET status = 'delivered' WHERE id = ?
    `);

    this.stmtMarkDead = db.prepare(`
      UPDATE messages SET status = 'dead' WHERE id = ?
    `);

    this.stmtUpsertSession = db.prepare(`
      INSERT INTO sessions (harness, session_id, cwd, state, lease_holder, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        cwd = excluded.cwd,
        state = excluded.state,
        lease_holder = excluded.lease_holder,
        updated_at = excluded.updated_at
    `);

    this.stmtUpdateSessionState = db.prepare(`
      UPDATE sessions SET state = ?, lease_holder = ?, updated_at = ? WHERE session_id = ?
    `);

    this.stmtUpdateSessionStateIf = db.prepare(`
      UPDATE sessions SET state = ?, lease_holder = ?, updated_at = ? WHERE session_id = ? AND state = ?
    `);

    this.stmtGetActiveSession = db.prepare(`
      SELECT * FROM sessions WHERE harness = ? AND state != 'lost' ORDER BY updated_at DESC LIMIT 1
    `);

    this.stmtGetPendingCount = db.prepare(`
      SELECT to_agent, COUNT(*) as count FROM messages WHERE status = 'pending' GROUP BY to_agent
    `);

    this.stmtGetPendingByAgent = db.prepare(`
      SELECT * FROM messages WHERE to_agent = ? AND status = 'pending' ORDER BY priority DESC, created_at ASC
    `);

    this.stmtGetMessageById = db.prepare(`
      SELECT * FROM messages WHERE id = ?
    `);
  }

  /**
   * Enqueues a message into SQLite.
   * @param {object} msg
   */
  enqueueMessage(msg) {
    const now = Date.now();
    this.stmtInsertMessage.run(
      msg.id,
      msg.conversationId || "conv-default",
      msg.parentId || null,
      msg.from,
      msg.to,
      msg.kind || "ask",
      msg.priority ?? 0,
      msg.hops ?? 0,
      msg.body,
      msg.refs ? JSON.stringify(msg.refs) : null,
      now
    );
    return { id: msg.id, createdAt: now };
  }

  /**
   * Atomically claims all pending messages for an agent using UPDATE ... RETURNING.
   * @param {string} agentId
   * @returns {Array<object>} Claimed message rows.
   */
  claimMessagesForAgent(agentId) {
    const now = Date.now();
    return this.stmtClaimMessages.all(now, agentId);
  }

  /**
   * Marks a message as delivered.
   * @param {string} messageId
   */
  markDelivered(messageId) {
    this.stmtMarkDelivered.run(messageId);
  }

  /**
   * Marks a message as dead (e.g. exceeded hop limit).
   * @param {string} messageId
   */
  markDead(messageId) {
    this.stmtMarkDead.run(messageId);
  }

  /**
   * Upserts a session record.
   * @param {object} session
   */
  upsertSession(session) {
    const now = Date.now();
    this.stmtUpsertSession.run(
      session.harness,
      session.sessionId,
      session.cwd,
      session.state || "idle",
      session.leaseHolder || null,
      now,
      now
    );
  }

  /**
   * Updates state and lease holder of a session.
   * @param {string} sessionId
   * @param {string} state
   * @param {string|null} leaseHolder
   */
  updateSessionState(sessionId, state, leaseHolder = null) {
    this.stmtUpdateSessionState.run(state, leaseHolder, Date.now(), sessionId);
  }

  /**
   * Updates state conditionally if the current state matches expectedState.
   * Prevents background turns from overwriting human-held leases.
   * @param {string} sessionId
   * @param {string} state
   * @param {string} expectedState
   * @param {string|null} [leaseHolder=null]
   * @returns {boolean} True if row was updated.
   */
  updateSessionStateIf(sessionId, state, expectedState, leaseHolder = null) {
    const info = this.stmtUpdateSessionStateIf.run(state, leaseHolder, Date.now(), sessionId, expectedState);
    return info.changes > 0;
  }

  /**
   * Retrieves active session for a harness.
   * @param {string} harness
   * @returns {object|null}
   */
  getActiveSession(harness) {
    return this.stmtGetActiveSession.get(harness) || null;
  }

  /**
   * Returns count of pending messages grouped by agent.
   * @returns {Array<{to_agent: string, count: number}>}
   */
  getPendingCounts() {
    return this.stmtGetPendingCount.all();
  }

  /**
   * Gets pending messages for an agent.
   * @param {string} agentId
   * @returns {Array<object>}
   */
  getPendingMessages(agentId) {
    return this.stmtGetPendingByAgent.all(agentId);
  }

  /**
   * Gets a message by its ID.
   * @param {string} id
   * @returns {object|null}
   */
  getMessage(id) {
    return this.stmtGetMessageById.get(id) || null;
  }
}
