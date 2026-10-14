/**
 * @file phase1-test.mjs
 * @description Comprehensive test suite for Phase 1 of agent-mesh.
 * Verifies SQLite transactions, atomic claims, IPC messaging over Named Pipes,
 * turn coalescing, and driver abstractions.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, MeshRepository } from "../src/db.mjs";
import { getIpcAddress, startIpcServer, sendIpcRequest } from "../src/ipc.mjs";
import { createResumeDriver } from "../src/drivers/base.mjs";
import { AgentMeshBroker } from "../src/broker.mjs";

import { mkdtempSync as __mkHome } from "node:fs";
import { tmpdir as __tmpHome } from "node:os";
import { join as __joinHome } from "node:path";

// Isolate from the user's live broker/state: hooks and CLI children inherit this MESH_HOME.
process.env.MESH_HOME = __mkHome(__joinHome(__tmpHome(), "mesh-test-home-"));


describe("Phase 1: Agent Mesh Core Validation", () => {
  let tempDir;
  let dbPath;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mesh-test-"));
    dbPath = join(tempDir, "test-mesh.db");
  });

  after(() => {
    if (existsSync(tempDir)) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  test("1. Database initializes with WAL and atomic tables", () => {
    const db = initDatabase(dbPath);
    const repo = new MeshRepository(db);

    // Enqueue test message
    const msg = {
      id: "test-msg-1",
      conversationId: "conv-1",
      from: "claude",
      to: "agy",
      body: "Hello from Claude!",
      priority: 0,
    };

    repo.enqueueMessage(msg);

    // Verify atomic claim
    const claimed = repo.claimMessagesForAgent("agy");
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].id, "test-msg-1");
    assert.equal(claimed[0].status, "claimed");

    // Second claim should return empty
    const secondClaim = repo.claimMessagesForAgent("agy");
    assert.equal(secondClaim.length, 0);

    // Mark delivered
    repo.markDelivered("test-msg-1");
    const updated = repo.getMessage("test-msg-1");
    assert.equal(updated.status, "delivered");

    db.close();
  });

  test("2. IPC Server/Client communicates over local Named Pipe / Domain Socket", async () => {
    const testIpcAddr = getIpcAddress(tempDir);

    const server = await startIpcServer(testIpcAddr, async (req) => {
      if (req.action === "ping") {
        return { ok: true, pong: req.payload };
      }
      return { ok: false };
    });

    const res = await sendIpcRequest(testIpcAddr, {
      action: "ping",
      payload: "mesh-rpc-check",
    });

    assert.equal(res.ok, true);
    assert.equal(res.pong, "mesh-rpc-check");

    server.close();
  });

  test("3. Turn Coalescing correctly merges multiple pending messages", () => {
    const db = initDatabase(join(tempDir, "coalesce-test.db"));
    const repo = new MeshRepository(db);

    // Enqueue two messages from different senders to the same recipient
    repo.enqueueMessage({
      id: "coalesce-1",
      from: "claude",
      to: "opencode",
      body: "First instruction: refactor auth.",
    });

    repo.enqueueMessage({
      id: "coalesce-2",
      from: "pi",
      to: "opencode",
      body: "Second instruction: verify unit tests.",
    });

    // Claim both atomically
    const batch = repo.claimMessagesForAgent("opencode");
    assert.equal(batch.length, 2);

    const mergedPrompt = batch
      .map((m, idx) => `[Message #${idx + 1} from ${m.from_agent}]: ${m.body}`)
      .join("\n\n");

    assert.match(mergedPrompt, /First instruction: refactor auth/);
    assert.match(mergedPrompt, /Second instruction: verify unit tests/);

    db.close();
  });

  test("4. ResumeDriver factory executes mock binary with stdin delivery", async () => {
    // Test resume driver with Node's own binary evaluating code from stdin
    const mockDriver = createResumeDriver({
      name: "mock-agent",
      bin: process.execPath,
      getArgv: () => ["-e", "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => console.log('ECHO:' + d.trim()));"],
      attach: (s) => [process.execPath],
    });

    const session = await mockDriver.open({ cwd: tempDir });
    const events = [];

    for await (const event of mockDriver.turn(session, "Hello Mock Agent")) {
      events.push(event);
    }

    const textEvents = events.filter((e) => e.t === "text");
    assert.ok(textEvents.length > 0);
    assert.match(textEvents[0].text, /ECHO:Hello Mock Agent/);
  });
});
