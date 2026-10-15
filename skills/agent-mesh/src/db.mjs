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
      to_session TEXT,
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
      state TEXT NOT NULL DEFAULT 'idle', -- idle, busy, human-held, error, lost, closed
      origin TEXT NOT NULL DEFAULT 'mesh', -- mesh, interactive
      presence TEXT NOT NULL DEFAULT 'none', -- socket, pid, none
      pid INT,
      last_seen INT,
      lease_holder TEXT,
      last_cost_usd REAL DEFAULT 0,
      last_turns INT DEFAULT 0,
      created_at INT NOT NULL,
      updated_at INT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_harness ON sessions (harness, state);
  `);

  // Schema migrations for existing databases
  const sessionCols = db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
  if (!sessionCols.includes("name")) db.exec("ALTER TABLE sessions ADD COLUMN name TEXT;");
  if (!sessionCols.includes("origin")) db.exec("ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'mesh';");
  if (!sessionCols.includes("presence")) db.exec("ALTER TABLE sessions ADD COLUMN presence TEXT NOT NULL DEFAULT 'none';");
  if (!sessionCols.includes("pid")) db.exec("ALTER TABLE sessions ADD COLUMN pid INT;");
  if (!sessionCols.includes("last_seen")) db.exec("ALTER TABLE sessions ADD COLUMN last_seen INT;");

  const msgCols = db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name);
  if (!msgCols.includes("to_session")) db.exec("ALTER TABLE messages ADD COLUMN to_session TEXT;");

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
      INSERT INTO messages (id, conversation_id, parent_id, from_agent, to_agent, to_session, kind, priority, hops, status, body, refs_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `);

    this.stmtClaimMessages = db.prepare(`
      UPDATE messages
      SET status = 'claimed', delivered_at = ?
      WHERE to_agent = ? AND status = 'pending' AND (? IS NULL OR to_session IS NULL OR to_session = ?)
      RETURNING *
    `);

    this.stmtMarkDelivered = db.prepare(`
      UPDATE messages SET status = 'delivered' WHERE id = ?
    `);

    this.stmtMarkDead = db.prepare(`
      UPDATE messages SET status = 'dead' WHERE id = ?
    `);

    this.stmtRestorePending = db.prepare(`
      UPDATE messages SET status = 'pending' WHERE id = ? AND status = 'claimed'
    `);

    this.stmtRestorePendingForAgent = db.prepare(`
      UPDATE messages SET status = 'pending' WHERE to_agent = ? AND status = 'claimed'
    `);

    this.stmtUpsertSession = db.prepare(`
      INSERT INTO sessions (harness, session_id, cwd, state, origin, pid, lease_holder, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        cwd = excluded.cwd,
        state = excluded.state,
        origin = excluded.origin,
        pid = excluded.pid,
        lease_holder = excluded.lease_holder,
        updated_at = excluded.updated_at
    `);

    this.stmtUpsertSessionEvent = db.prepare(`
      INSERT INTO sessions (harness, session_id, cwd, state, origin, pid, last_seen, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        cwd = excluded.cwd,
        state = excluded.state,
        origin = excluded.origin,
        pid = COALESCE(excluded.pid, CASE WHEN sessions.state IN ('closed', 'lost') THEN NULL ELSE sessions.pid END),
        last_seen = excluded.last_seen,
        updated_at = excluded.updated_at
    `);

    this.stmtUpdateSessionState = db.prepare(`
      UPDATE sessions SET state = ?, lease_holder = ?, updated_at = ? WHERE session_id = ?
    `);

    this.stmtUpdateSessionStateIf = db.prepare(`
      UPDATE sessions SET state = ?, lease_holder = ?, updated_at = ? WHERE session_id = ? AND state = ?
    `);

    this.stmtGetActiveSession = db.prepare(`
      SELECT * FROM sessions
      WHERE harness = ? AND state NOT IN ('lost', 'closed') AND session_id NOT LIKE 'tui:%'
      ORDER BY (state = 'human-held' OR (state IN ('idle', 'busy') AND origin = 'interactive')) DESC, updated_at DESC
      LIMIT 1
    `);

    this.stmtListLiveSessions = db.prepare(`
      SELECT * FROM sessions WHERE state NOT IN ('lost', 'closed') ORDER BY updated_at DESC
    `);

    this.stmtGetPendingCount = db.prepare(`
      SELECT to_agent, COUNT(*) as count FROM messages WHERE status = 'pending' GROUP BY to_agent
    `);

    this.stmtGetPendingByAgent = db.prepare(`
      SELECT * FROM messages WHERE to_agent = ? AND status = 'pending' ORDER BY priority DESC, created_at ASC
    `);

    this.stmtGetDeliveredByAgent = db.prepare(`
      SELECT * FROM messages WHERE to_agent = ? AND status = 'delivered' ORDER BY delivered_at DESC LIMIT ?
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
      msg.toSession || null,
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
   * Optionally filtered to a specific target session ID.
   * @param {string} agentId
   * @param {string|null} [sessionId=null]
   * @returns {Array<object>} Claimed message rows.
   */
  /**
   * The single live interactive session of a harness that receives UNTARGETED mail: the most recently active
   * real session (provisional `tui:`/`mcp:` rows only count when nothing else is live).
   * @param {string} harness
   * @returns {string|null}
   */
  primaryInteractiveSession(harness) {
    const row = this.db
      .prepare(
        `SELECT session_id FROM sessions
         WHERE harness = ? AND origin = 'interactive' AND state NOT IN ('lost', 'closed')
         ORDER BY (session_id LIKE 'tui:%' OR session_id LIKE 'mcp:%') ASC, updated_at DESC LIMIT 1`
      )
      .get(harness);
    return row?.session_id ?? null;
  }

  /**
   * Strict inbox claim for one session: its own targeted mail, plus untargeted mail only when it is the
   * primary interactive session of the harness (or the harness has no other live session).
   * `wakeOnly` restricts to mail allowed to wake an idle session (ask/reply or urgent).
   * @param {string} agentId
   * @param {string|null} sessionId  null = headless/CLI claimer: untargeted mail only
   * @param {{ wakeOnly?: boolean }} [opts]
   */
  claimInboxForSession(agentId, sessionId, { wakeOnly = false } = {}) {
    const primary = this.primaryInteractiveSession(agentId);
    const untargeted = sessionId === null || primary === null || primary === sessionId ? 1 : 0;
    const eligible = wakeOnly ? " AND (kind IN ('ask', 'reply') OR priority >= 1)" : "";
    return this.db
      .prepare(
        `UPDATE messages SET status = 'claimed', delivered_at = ?
         WHERE to_agent = ? AND status = 'pending'
           AND ((? IS NOT NULL AND to_session = ?) OR (to_session IS NULL AND ? = 1))${eligible}
         RETURNING *`
      )
      .all(Date.now(), agentId, sessionId, sessionId, untargeted);
  }

  /** True when a session has pending mail that is allowed to wake it (strict claim rules, no side effects). */
  hasWakeMail(agentId, sessionId) {
    const primary = this.primaryInteractiveSession(agentId);
    const untargeted = primary === null || primary === sessionId ? 1 : 0;
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM messages WHERE to_agent = ? AND status = 'pending' AND (kind IN ('ask', 'reply') OR priority >= 1)
           AND (to_session = ? OR (to_session IS NULL AND ? = 1)) LIMIT 1`
        )
        .get(agentId, sessionId, untargeted)
    );
  }

  /**
   * Most recent ticket delivered (or being delivered) to an agent within the window: the parent of anything
   * that agent sends next, so interactive sessions cannot ping-pong without hitting the hop limit.
   * @returns {{ id: string, hops: number }|null}
   */
  latestDeliveredTo(agentId, sinceMs) {
    return (
      this.db
        .prepare(
          `SELECT id, hops FROM messages WHERE to_agent = ? AND status IN ('claimed', 'delivered') AND delivered_at >= ?
           ORDER BY delivered_at DESC LIMIT 1`
        )
        .get(agentId, sinceMs) ?? null
    );
  }

  claimMessagesForAgent(agentId, sessionId = null) {
    const now = Date.now();
    return this.stmtClaimMessages.all(now, agentId, sessionId, sessionId);
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
   * Restores a claimed/dead message to pending (retry or lease-takeover paths).
   * @param {string} messageId
   */
  restorePending(messageId) {
    this.stmtRestorePending.run(messageId);
  }

  /**
   * Re-addresses pending messages of `fromAgent` (an unroutable name) to a real agent/session.
   * @returns {number} Updated row count.
   */
  rerouteMessages(fromAgent, toAgent, toSession) {
    return this.db
      .prepare("UPDATE messages SET to_agent = ?, to_session = COALESCE(to_session, ?) WHERE to_agent = ? AND status = 'pending'")
      .run(toAgent, toSession, fromAgent).changes;
  }

  /**
   * Returns claimed-but-never-acked messages to pending (a hook died between claim and ack).
   * @param {number} cutoffMs claims older than this timestamp are restored
   * @param {string[]} [skipAgents] agents with an in-flight headless turn (their claims are legitimately long)
   * @returns {number} Restored row count.
   */
  restoreStaleClaims(cutoffMs, skipAgents = []) {
    const rows = this.db
      .prepare("SELECT id, to_agent FROM messages WHERE status = 'claimed' AND delivered_at IS NOT NULL AND delivered_at < ?")
      .all(cutoffMs);
    let restored = 0;
    for (const r of rows) {
      if (skipAgents.includes(r.to_agent)) continue;
      this.stmtRestorePending.run(r.id);
      restored++;
    }
    return restored;
  }

  /**
   * Restores all claimed messages of an agent to pending.
   * @param {string} agentId
   * @returns {number} Restored row count.
   */
  restorePendingForAgent(agentId) {
    return this.stmtRestorePendingForAgent.run(agentId).changes;
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
      session.origin || "mesh",
      session.pid || null,
      session.leaseHolder || null,
      now,
      now
    );
  }

  /**
   * Idempotently records a session lifecycle event.
   * @param {object} event
   * @returns {{ok: boolean, state: string}}
   */
  updateSessionEvent({ harness, sessionId, event, pid = null, cwd = null, origin = "interactive", name = null }) {
    const now = Date.now();
    let state = "idle";
    if (event === "busy") state = "busy";
    else if (event === "end" || event === "closed") state = "closed";
    else if (event === "start" || event === "idle") state = "idle";

    const prevRow = sessionId
      ? this.db.prepare("SELECT name, state FROM sessions WHERE session_id = ?").get(sessionId)
      : null;
    const prevName = prevRow?.name ?? null;
    // "rename" is a pure metadata event: keep the current state
    if (event === "rename") {
      if (!prevRow) return { ok: true, state: "unknown", renamed: null }; // never register a phantom session
      state = prevRow.state || "idle";
    }

    // Supersede older rows for this (harness, pid) if sessionId changed (e.g. /clear)
    if (pid && sessionId) {
      try {
        this.db.prepare(`
          UPDATE sessions SET state = 'closed', updated_at = ?
          WHERE harness = ? AND pid = ? AND session_id != ? AND state NOT IN ('closed', 'lost')
        `).run(now, harness, pid, sessionId);
      } catch {}
    }

    this.stmtUpsertSessionEvent.run(
      harness,
      sessionId,
      cwd || process.cwd(),
      state,
      origin,
      pid,
      now,
      now,
      now
    );
    let renamed = null;
    if (name && sessionId) {
      const next = String(name).slice(0, 120);
      const prev = prevName;
      if (prev !== next) {
        this.db.prepare("UPDATE sessions SET name = ? WHERE session_id = ?").run(next, sessionId);
        renamed = { from: prev, to: next };
      }
    }
    return { ok: true, state, renamed };
  }

  /** Records the OS pid of a live session (no state change). */
  setSessionPid(sessionId, pid) {
    this.db.prepare("UPDATE sessions SET pid = ? WHERE session_id = ?").run(pid, sessionId);
  }

  /**
   * Sets a session's display name without touching its state/pid.
   * @param {string} sessionId
   * @param {string} name
   * @returns {{from: string|null, to: string}|null} Change record, or null if unchanged/unknown session.
   */
  setSessionName(sessionId, name) {
    const row = this.db.prepare("SELECT name FROM sessions WHERE session_id = ?").get(sessionId);
    const next = String(name).slice(0, 120);
    if (!row || row.name === next) return null;
    this.db.prepare("UPDATE sessions SET name = ? WHERE session_id = ?").run(next, sessionId);
    return { from: row.name ?? null, to: next };
  }

  /**
   * Lists all live sessions (not closed or lost).
   * @returns {Array<object>}
   */
  listLiveSessions() {
    return this.stmtListLiveSessions.all();
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
   * Gets most recently delivered messages for an agent.
   * @param {string} agentId
   * @param {number} [limit=20]
   * @returns {Array<object>}
   */
  getDeliveredMessages(agentId, limit = 20) {
    return this.stmtGetDeliveredByAgent.all(agentId, limit);
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
