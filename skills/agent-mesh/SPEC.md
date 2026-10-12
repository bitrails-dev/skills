# SPEC-001: Universal Inter-Harness Agent Mesh (`agent-mesh`)

## Status
**Approved** (Post-Consultation with Claude Opus Architectural Review)

## Context & Motivation
Modern developer coding agents operate as isolated silos:
- **Claude Code (`claude`)** supports internal agent teams and `sendMessage`, but cannot natively reach external harnesses.
- **Google Antigravity (`agy`)** supports autonomous workflows, timers, and background tasks, but has no direct link to Claude or Pi.
- **OpenCode (`opencode`)** operates an HTTP server, SSE stream, and CLI.
- **Pi (`pi`)**, **Codex**, **Aider**, and other coding CLIs operate as standalone processes.

Existing skills (`claude-delegate`, `agy-delegate`, `opencode-delegate`, `pi-delegate`) are rigid 1-to-1 RPC batch delegators (`node relay.mjs --brief brief.txt`) that run single-turn subtasks, wait for exit, and terminate.

The `agent-mesh` skill provides a **universal, elastic, multi-agent communication fabric** allowing any coding agent harness to communicate with any other coding agent harness asynchronously, peer-to-peer, or in coordinated swarms, with full session visibility for human inspection.

---

## Architecture Decision Records (ADRs)

### ADR-001: Central Broker with Local SQLite & Native Local IPC
- **Context**: Multiple agents running in different processes need a reliable, atomic, durable message bus. Raw `fs.watch` is prone to file-locking collisions (especially on Windows with antivirus and concurrent writes).
- **Decision**: A lightweight Node 22+ Broker daemon acts as the single writer to an embedded SQLite database (`node:sqlite`) operating in WAL mode. Agents and CLI tools interact with the broker via local IPC:
  - Windows: Named Pipe (`\\.\pipe\agent-mesh-<repoHash>`)
  - POSIX: Unix Domain Socket (`$XDG_RUNTIME_DIR/agent-mesh-<repoHash>.sock` or `/tmp/...`)
- **Consequences**: Zero external npm dependencies. Atomic message queues. No file locking contention. Events are mirrored to per-agent `.agent-mesh/logs/<agent>.jsonl` files for human observation.

### ADR-002: Four Delivery Modes in Harness Abstraction Layer (HAL)
- **Context**: Different harnesses have vastly different communication capabilities.
- **Decision**: Every harness driver implements `HarnessDriver` and declares one of four delivery modes in its capability manifest:
  1. `server`: HTTP/SSE connection to a persistent daemon (e.g. `opencode serve`).
  2. `stream-stdio`: Persistent JSON/RPC stream over stdio (e.g. `claude -p --input-format stream-json --output-format stream-json`, `pi --mode rpc`, `codex app-server`).
  3. `resume`: Headless invocation with turn resumption (e.g. `claude -p --resume <id>`, `agy --print --resume-last`, `aider --restore-chat-history`).
  4. `pty`: Pseudo-terminal keystroke injection as a fallback.

### ADR-003: Asynchronous Non-Blocking Actor Messaging (Deadlock Immunity)
- **Context**: If Agent A sends a synchronous request to Agent B and waits, and Agent B simultaneously queries Agent A, a reciprocal deadlock occurs. Long-polling tools in MCP also hit tool execution timeouts.
- **Decision**:
  - `mesh ask` is completely non-blocking: it queues the message and returns a tracking ticket immediately.
  - The recipient agent receives the request as an incoming turn.
  - When the recipient replies via `mesh reply <ticket>`, the response is routed back to the sender as a new turn.
  - **Single-Flight Turn Consolidation**: Each agent is an Actor. If messages from multiple senders arrive while an agent is executing a turn, the broker consolidates all waiting messages into a single prompt at the next turn boundary.
  - **Hop Count Limit**: Messages carry a `hops` counter (max 6) and conversation budget to prevent ping-pong loops.

### ADR-004: Three-Tier Viewing & Session Lease Architecture
- **Context**: A human developer must be able to inspect and interact with sessions in their native harness. However, if a human launches an interactive session while a background relay is writing to the same session file, the session history will corrupt (the Dual-Writer Problem).
- **Decision**:
  - **Tier 1 (Observe)**: Read-only live tailing of `.agent-mesh/logs/<agent>.jsonl` via `mesh watch <agent>`. Always safe and non-blocking.
  - **Tier 2 (Native View)**: Available for harnesses with native multi-client servers (`opencode serve`), allowing concurrent viewing in browser or TUI alongside broker.
  - **Tier 3 (Native Attach)**: Human interactive takeover requires acquiring a **Session Lease**:
    1. Broker pauses turns for the target agent and marks state `human-held`.
    2. Broker releases file handles and launches the native CLI in a new tab (Windows Terminal `wt.exe new-tab` or `tmux new-window`).
    3. Incoming mesh messages queue in SQLite while human has control.
    4. When human exits, broker re-acquires the lease and resumes automation.

### ADR-005: Git Worktree Isolation for Writing Agents
- **Context**: Multiple agents modifying the same working tree simultaneously causes untracked file conflicts, index locks, and dirty tree corruption.
- **Decision**:
  - Agents performing code edits run in dedicated git worktrees: `.agent-mesh/wt/<agent>/` on branches `mesh/<agent>/<task>`.
  - Question-answering and reviewing agents share the repository root in read-only mode.
  - Inter-agent code handoffs occur via committed Git refs (`{branch, commit}`), verified against base before merge.

### ADR-006: ACP (Agent Client Protocol) as Universal Elastic Foundation
- **Context**: Supporting dozens of future coding agents requires avoiding writing custom scrapers for every new tool.
- **Decision**: Implement a generic `AcpDriver` that implements the open Agent Client Protocol (JSON-RPC over stdio). Any tool implementing ACP (or an ACP adapter) works out of the box with zero custom code.
- **Status**: **Experimental.** The JSON-RPC method names used by `AcpDriver` (and the OpenCode server endpoint, Codex `--json` event shapes) are unverified against installed CLI versions and pending upstream standard stabilization. Treat these drivers as best-effort until validated; the Claude, Pi, and declarative `resumeDriver` paths are the stable core.

---

## Architectural Comparison Matrix

| Approach | Latency | Windows Compatibility | Reliability | State Integrity | Extensibility |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **A. PTY Multiplexer** | Low (instant) | Poor (`node-pty` native build issues) | Low (ANSI/timing bugs) | Vulnerable to buffer overflows | Low |
| **B. Long-Polling MCP** | Low | High | Medium (Tool timeouts kill turns) | High | High |
| **C. FS Watchers** | Medium | Low (AV locks, rename races) | Medium | High | High |
| **D. Stateless Resume** | High (process start) | High | Very High | High | High |
| **E. Hybrid Broker (ADR 1-6)**| **Very Low to Medium** (adapts to harness capability) | **Full (Native Pipes, `node:sqlite`, `wt.exe`)** | **Maximum (Isolated, resilient)** | **Maximum (Guaranteed by lease & WAL)** | **Universal (ACP + declarative adapters)** |

---

## Detailed Data Models & Contracts

### 1. Message Envelope
```typescript
interface MeshMessage {
  id: string;               // ULID / UUID
  conversationId: string;   // Thread ID
  parentMessageId?: string; // Causal antecedent
  from: string;             // Sender agent identifier
  to: string;               // Recipient agent identifier
  kind: 'ask' | 'reply' | 'handoff' | 'review' | 'notify' | 'cancel';
  priority: 0 | 1 | 2;      // 0: normal, 1: urgent, 2: human interrupt
  hops: number;             // Incremented on every hop; max 6
  deadline?: number;        // Epoch ms timestamp
  refs?: {
    branch?: string;
    commit?: string;
    paths?: string[];
  };
  body: string;             // Markdown/text prompt payload
  createdAt: number;
}
```

### 2. Harness Driver Interface (`HarnessDriver`)
```typescript
interface DriverCaps {
  delivery: 'server' | 'stream-stdio' | 'resume' | 'pty';
  midTurnInject: boolean;
  interrupt: boolean;
  concurrentViewers: boolean;
  mcp: boolean;
  preEditHook: boolean;
}

interface SessionRef {
  harness: string;
  id: string;
  cwd: string;
  meta?: Record<string, string>;
}

interface HarnessDriver {
  readonly name: string;
  readonly caps: DriverCaps;
  probe(): Promise<{ ok: boolean; version?: string; reason?: string }>;
  open(spec: { cwd: string; resume?: SessionRef; env: Record<string, string> }): Promise<SessionRef>;
  turn(session: SessionRef, prompt: string, signal: AbortSignal): AsyncIterable<MeshEvent>;
  inject?(session: SessionRef, prompt: string): Promise<void>;
  close(session: SessionRef): Promise<void>;
  viewArgv(session: SessionRef): string[] | null;
  attachArgv(session: SessionRef): string[];
}
```

---

## Four-Phase Implementation Plan

### Phase 1: Core Broker, SQLite Mailbox, & Resume Driver
1. Database schema in `node:sqlite`: tables for `conversations`, `messages`, `sessions`, `leases`.
2. Local IPC server (`net.createServer`) with Named Pipe on Windows and Unix Domain Socket on POSIX.
3. Declarative `resumeDriver` base class for CLI tools.
4. Claude Code Resume Driver (`drivers/claude.mjs`).
5. CLI tool `mesh.mjs` with subcommands: `send`, `ask`, `reply`, `inbox`, `watch`, `status`.
6. Turn consolidation and hop limit verification.

### Phase 2: Worktree Isolation, Session Leasing, & OpenCode Server Driver
1. Git worktree manager (`lib/worktree.mjs`): automated worktree creation, branching, cleanup.
2. Session Lease Manager: state machine for `idle` $\leftrightarrow$ `agent-busy` $\leftrightarrow$ `human-held`.
3. `mesh attach <agent>` command launching Windows Terminal (`wt.exe`) or `tmux`.
4. OpenCode Server Driver (`drivers/opencode.mjs`): HTTP/SSE client driving `opencode serve`.

### Phase 3: Persistent Stdio Streaming & Interactive Hooks
1. Continuous stdio stream driver for Claude Code (`claude -p --input-format stream-json --output-format stream-json`).
2. Pi RPC Driver (`drivers/pi.mjs`) via `pi --mode rpc`.
3. Claude Code `Stop` hook (`hooks/stop-hook.mjs`) for human-driven interactive sessions joining the mesh.
4. Permission routing: forward tool permissions to mesh broker.

### Phase 4: Universal ACP Foundation & Multi-Harness Swarm
1. Generic `AcpDriver` (`drivers/acp.mjs`) speaking JSON-RPC over stdio.
2. Antigravity Driver (`drivers/antigravity.mjs`).
3. Codex Driver (`drivers/codex.mjs`).
4. End-to-end multi-agent swarm integration test (Claude Code writes code in worktree $\rightarrow$ Antigravity reviews diff $\rightarrow$ Pi generates tests $\rightarrow$ orchestrator verifies and merges).
