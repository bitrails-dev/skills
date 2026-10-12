---
name: agent-mesh
description: >-
  Universal inter-harness agent mesh orchestrator enabling asynchronous, peer-to-peer, and event-driven communication
  across Claude Code, Antigravity, OpenCode, Pi, Codex, and any ACP-compliant agent with live session visibility,
  git worktree isolation, and session leasing. Use whenever the user asks to coordinate multiple AI agent harnesses,
  have agents communicate across harnesses, run cross-agent workflows, or view/attach to agent sessions live.
license: MIT
compatibility: Requires Node 22+ (for built-in node:sqlite and native IPC) and Git. Works on Windows and POSIX.
metadata:
  version: 0.1.0
---

# Agent Mesh: Universal Inter-Harness Communication

`agent-mesh` connects heterogeneous coding agent harnesses into an asynchronous, observable agent mesh.

Instead of rigid 1-to-1 RPC relays, agents interact via an atomic local Broker daemon using asynchronous messaging, Git worktree isolation, and session leasing for live human inspection.

## Supported Harnesses & Tiers
- **Claude Code (`claude`)**: Continuous `stream-json` stdio or resume mode.
- **Google Antigravity (`agy`)**: Headless print mode with project session resumption.
- **OpenCode (`opencode`)**: Persistent server mode (`opencode serve`) with live web UI / attach.
- **Pi (`pi`)**: RPC stdio mode (`pi --mode rpc`) or session resumption.
- **Codex (`codex`)**: App-server JSON-RPC.
- **ACP Agents**: Any Agent Client Protocol-compliant agent via generic `AcpDriver`.
- **Declarative CLIs**: Aider, custom LLM CLIs via 30-line `resumeDriver`.

## Quick Start CLI

```powershell
# 1. Start the local mesh broker daemon
node scripts/mesh.mjs start

# 2. Check mesh status and active agent sessions
node scripts/mesh.mjs status

# 3. Send a non-blocking question to an agent
node scripts/mesh.mjs ask --to claude "Can you analyze the memory usage in src/broker.mjs?"

# 4. View an agent's live event stream
node scripts/mesh.mjs watch claude

# 5. Interactively attach to an agent session (acquires lease)
node scripts/mesh.mjs attach opencode
```

## Architecture & Specifications
See [SPEC.md](SPEC.md) for complete Architecture Decision Records (ADR 001–006), data models, and delivery contracts.
