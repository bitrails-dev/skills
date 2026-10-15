# Harness adapters: plan

Status: Phase 1 (adapter refactor), Phase 2 (Codex host study, section 6) and Phase 3 (MCP shim, section 5) done.

Goal: adding a harness = one file `src/harnesses/<id>.mjs` + one line in `src/harnesses/index.mjs`
+ fixtures in the contract test. Broker and installer contain zero `if (harness === "...")`.

## 1. Descriptor interface (as implemented)

Authoritative typedefs: JSDoc at the top of `src/harnesses/index.mjs` (`Harness`, `PresenceSource`,
`PidStrategy`). Summary:

| Field | Meaning |
|---|---|
| `id`, `aliases`, `displayName` | canonical broker/DB id; extra accepted names (unique registry-wide); label |
| `discovery` | `binaries` (PATH), `markers(root)` (dirs meaning "installed"), `skillDir()` (harness-local skill copy), `projectDir` (last-resort fallback) |
| `presence[]` | `{kind: hook\|plugin\|extension\|process\|mcp, script, resolvePaths({global, root}), install(paths, script), uninstall(paths), diagnose(paths)}` |
| `pid` | `direct` (runs inside harness), `walk` (hook: climb past shells), `none`, `provided` |
| `classifyProcess(cmdline)` | optional; `{background, sharedHost}`; default `classifyCmdline` in `shared/process.mjs` |
| `name` | `{resolve({sessionId, transcript}) -> string\|null, watch: {kind: transcript-mtime\|sqlite-poll\|event}}` |
| `pollSession(row)` | optional read-only poll: `{archived, activityMs}` (Codex threads) |
| `end` | `{signals: ("event"\|"pid"\|"ttl")[], ttlMs?: {idle, busy}}` (default TTL 10 min idle / 60 min busy) |
| `process` | `{exe: [...], isInteractiveTui(cmdline)}`: separate TUI process the broker scans for |
| `fixtures` | test data for the contract suite: `name.setup(dir)`, `tui`, `cmdlines` |

Differences from the first draft: `binaries`/`homeMarkers` became the `discovery` block (the installer's
"has skill" rules differ per harness); `end.hook/event/pid` became `end.signals`; `classifyProcess`
returns two flags because a command line can be both (existing behavior); Codex stays `pid: "walk"`
because its hooks only sometimes run in app-server (the default classifier reports `sharedHost`).

## 2. Inventory: where the harness-specific code went

| Former location (HEAD 93de607) | Now |
|---|---|
| broker.mjs `TUI_PROCS`, `NON_TUI_ARGS` | `descriptor.process` + `looksInteractive` (`shared/process.mjs`) |
| broker.mjs `listProcesses`, `processInfo` | `shared/process.mjs` |
| broker.mjs `scanTuiProcesses`, `bindTui` | `src/presence/tui-scanner.mjs` (`TuiScanner`); broker keeps a 1-line delegate |
| broker.mjs `watchSessionNames`, `watchExternalSessions` | `src/presence/name-watch.mjs`; Codex/agy specifics in descriptors (`name.resolve`, `pollSession`) |
| broker.mjs alias map | registry aliases (`resolveAgent` -> `registry.get(name)?.id`) |
| broker.mjs reap TTL constants | `registry.endTtl(harness)` / `DEFAULT_TTL_MS` |
| common.mjs sqlite readers + db paths | `shared/sqlite.mjs`; `harnesses/antigravity.mjs`, `harnesses/codex.mjs` |
| common.mjs `resolveSessionName` | `descriptor.name.resolve` (common keeps a null-safe wrapper) |
| common.mjs `resolveTrueHarnessPid`, `BACKGROUND_CMD`, `.bg/.nopid` markers | `shared/process.mjs` `resolvePid` (+ wrapper in common) |
| common.mjs `buildHookCommand`, `MESH_HOOK_MATCHER` | `shared/install.mjs` (re-exported by common) |
| installer.mjs per-harness install/uninstall/diagnose/paths/discovery | descriptors (`presence[]`, `discovery`); installer is a loop + deprecated wrappers |
| opencode/pi plugin IPC + claim/ack duplication | `src/presence/announce.mjs` (`send`, `claimAndAck`) |

Not moved (transport-specific, by design): hook event mapping in `presence-hook.mjs` /
`agy-presence-hook.mjs`, OpenCode plugin / Pi extension event handlers, drivers in `src/drivers/`.

## 3. Module layout (as built)

```
src/harnesses/
  index.mjs          registry: all, ids, get, canonicalId, byExe, endTtl, register, validateDescriptor
  claude.mjs  codex.mjs  antigravity.mjs  opencode.mjs  pi.mjs
  shared/  sqlite.mjs  transcript.mjs  process.mjs  install.mjs
src/presence/        tui-scanner.mjs  name-watch.mjs  announce.mjs  mcp-dedupe.mjs
src/mcp/             mesh-mcp.mjs
tests/harness-contract-test.mjs  tests/mcp-shim-test.mjs
```

Behavior preserved: IPC payloads, marker file names, poll cadences (3s scan, 5s external, 2s pid
watch), TTLs, toasts. Intentional deltas: `resolveSessionName("agy"|alias, ...)` now resolves through
aliases; Codex name resolution falls back to the threads table when `session_index.jsonl` is absent;
`autoDiscoverHarnesses` returns the canonical id `antigravity` (CLI still accepts `agy`);
`resolveHookTargets` (unused) was removed; unknown harness names return `{ok:false}` instead of throwing.

## 4. Contract tests (`tests/harness-contract-test.mjs`)

Per descriptor (and a fake harness registered inline): shape + alias resolution; install -> diagnose ->
reinstall -> uninstall with foreign config preserved (temp project root); name resolution from
`fixtures.name` and null for unknown session; rename payload through a real broker (isolated
`MESH_HOME`, `MESH_SILENT=1`, notifier stubbed) with exactly one `renamed` notice; end via event and via
pid exit; TUI classification from `fixtures.tui`; hook command-line classification from
`fixtures.cmdlines`. Plus a registry-wide id/alias uniqueness check.

## 5. MCP shim (`src/mcp/mesh-mcp.mjs`, zero deps) - as built

- Transport: stdio, newline-delimited JSON-RPC 2.0, stdout carries protocol messages only. Methods:
  `initialize` (echoes the client's `protocolVersion` when supported, else `2025-06-18`;
  `capabilities: {tools: {}}`), `notifications/initialized`, `ping`, `tools/list`, `tools/call`;
  unknown requests get `-32601`, unknown notifications are ignored.
- Tools (one broker IPC call each): `mesh_send {to, body}`, `mesh_ask {to, body}` (reply arrives in the
  inbox), `mesh_inbox {}` (claim + ack, formatted like the hook injection), `mesh_status {}`.
  Errors (bad args, broker down) come back as `isError` tool results, never as crashes.
- Identity: harness from `--harness <id>` (written by the installer), fallback `clientInfo.name`
  (`harnessFromClientName`: `pi`, `opencode`, `codex-mcp-client`, `claude-code` resolve). Session id
  `mcp:<harness>:<pid>`; pid = parent process, walked past shell wrappers when the descriptor's `pid`
  strategy is `walk` (Claude, agy), plain parent when `direct`. `MESH_AGENT` (headless mesh turn) or an
  unknown harness: tools only, no presence.
- Presence: `start` after `initialized` (or first `tools/list`), `end` on stdin EOF / SIGTERM, both with
  `via: "mcp"`. The descriptor's `mcp` source can set `announce: false` (Codex: servers are spawned by the
  shared daemon, parent = daemon, so the shim only serves tools; hooks + scanner own presence).
- Dedupe (`src/presence/mcp-dedupe.mjs`, key `(harness, pid)`): MCP events are ignored while another live
  row owns the pid; otherwise the `mcp:` row is used and its start toast is deferred by a grace window
  (6s) so a hook that claims the pid first takes over (the `mcp:` row is closed silently, the hook
  toasts itself). MCP-only presence toasts once at start and once at end.
- Install (opt-in, `mesh --init --mcp` / `installHarness(..., {mcp: true})`; uninstall always removes it):

| Harness | File (global / project) | Entry |
|---|---|---|
| claude | `~/.claude.json` / `<root>/.mcp.json`, key `mcpServers` | `{type:"stdio", command, args, env:{}}` |
| codex | `~/.codex/config.toml` / `<root>/.codex/config.toml` | managed `[mcp_servers.agent-mesh]` block between `# agent-mesh:begin/end` markers |
| antigravity | `~/.gemini/config/mcp_config.json` / `<root>/.agents/mcp_config.json` (project path unverified) | `{command, args, disabled:false}` |
| opencode | `opencode.json`, key `mcp` | `{type:"local", command:[node, script, --harness, opencode], enabled:true}` |
| pi | `~/.pi/agent/mcp.json` / `<root>/.pi/mcp.json` | `{command, args}` |
| muse | plugin bundle `agent-mesh-mcp` (capability `mcpServers`, stdio) installed via `muse plugins install` + `approve`; also `mcpServers` in `~/.config/muse/settings.json` for HTTP servers | not observed (needs a live session) | unverified | unverified | unverified | unverified | validated and installed with `muse plugins` in an isolated HOME |

  The Stop-hook / plugin inbox injection stays installed and is the fallback where MCP is absent.

## 6. Evidence tables (Deliverables B and C)

Codex CLI 0.162.1 on Windows 11, 2026-10-15. Method: read-only inspection of the live daemon
(`Get-CimInstance Win32_Process`, `~/.codex/app-server-daemon/*`, `logs_2.sqlite`, `state_5.sqlite`,
mesh `hooks.log`), `codex ... --help`, `codex app-server generate-json-schema`, binary strings, and a
throwaway daemon/stdio server under a temp `CODEX_HOME` with a logging MCP probe (the user's real
`~/.codex` and daemon were never written to or connected to). Experiment scripts live outside the repo.

### B. MCP behavior per harness (empirical)

| Harness | Config | Spawn | Scope | Parent PID | Exits with TUI? | clientInfo.name | Notes |
|---|---|---|---|---|---|---|---|
| codex | `[mcp_servers.<name>]` in `config.toml` (command/args/env, or url) | at `thread/start`, before any turn (`mcpServer/startupStatus/updated` starting -> ready within ~0.2s); not at `initialize` | per thread (status events carry `threadId`); cwd = thread cwd | the app-server host: the shared daemon pid (37772 class) for TUI/daemon threads; stdio-embedded host in `--listen stdio://` | No. Survives `thread/unsubscribe` and client disconnect; dies at thread unload (`thread/closed`, default 60s after last subscriber and idle) or when the host dies (hard kill: no EOF/SIGTERM handler ran) | `codex-mcp-client` v0.162.1 | MCP shim therefore sees the daemon as parent, never the TUI: shim must key presence on thread, not parent pid. Embedded host for `codex --no-daemon` / `codex exec` not measured (needs a TTY / auth) |
| claude | `~/.claude.json` `mcpServers` (user) or `.mcp.json` (project, written by `claude mcp add`; first use of a project server needs the user's approval, per Claude docs, not observed) | eager: children of live sessions appeared ~3s after launch (03:27:19 -> 03:27:22); also re-spawned later on plugin reload | per session (two live claude.exe each had their own context-mode child) | the main `claude.exe` itself; `cmd.exe /c` only in between for `.cmd` shims (npx) | not tested (would need killing a user session); stdin-EOF semantics assumed | `claude-code` (documented, not observed) | observed on live user sessions, read-only |
| antigravity | `~/.gemini/config/mcp_config.json` (`agy mcp add` in an isolated HOME), entry `{command, args, disabled}` | eager: child 1s after agy.exe start (10:49:25 -> 10:49:26) | per session (two live agy.exe each had their own canva child) | `agy.exe` directly (`cmd /c npx` wrapper for npx servers) | not tested | not observed (`agy mcp list` does not spawn) | project-scope config path unverified; scanner pid == shim pid, so rows merge |
| opencode | `opencode.json` key `mcp` (`type: local`, `command: [..]`) | `opencode mcp list` spawns and connects; session-time spawn not observed | unverified | unverified (plugins run in-process, so the parent is expected to be the opencode process) | server got stdin EOF right after the list command finished | `opencode` 1.19.0 | isolated HOME probe |
| pi | `~/.pi/agent/mcp.json` / `.pi/mcp.json` in trusted projects, key `mcpServers` (`pi mcp add` in an isolated HOME) | `pi mcp list` spawns and connects; session-time spawn not observed (exposure modes `codemode` default, `deferred`, `direct`, `hidden`) | unverified | unverified | stdin EOF when the client exits | `pi` 1.1.0 | isolated HOME probe; Pi supports MCP natively |

### C. Codex app-server host verdict

| Question | Evidence | Answer |
|---|---|---|
| 1. Who spawns MCP servers, parent PID, lifetime, timing? | Isolated daemon + probe: probe `ppid` = app-server pid, started 0.1s after `thread/start`; still alive after `thread/unsubscribe` and after the only client disconnected; gone after `thread/closed`. Real daemon `daemon.stderr.log` shows `rmcp::transport` MCP client errors from the daemon process | Daemon (host process) spawns them, per thread, at thread start. TUI is not the parent. Lives until thread unload |
| 2. Do hooks always run in the app-server? | Real `hooks.log`: all TUI threads report hook pid 37772 (= `daemon.pid`). Exec thread `01a13bb4` (source `exec`, originator `codex_exec`) reports pid 80076, a different process. `codex exec` runs the agent in-process | No. TUI threads on the shared daemon: yes. `codex exec`/`review`: in their own process. `--no-daemon` TUI: embedded host, presumed in-TUI (unverified, needs a TTY) |
| 3. Is `app-server proxy` / ws / unix a stable way to receive `thread/name/updated`, `thread/closed`? | Control socket `~/.codex/app-server-control/app-server-control.sock` speaks WebSocket (HTTP Upgrade -> 101) over a Unix socket; `codex app-server proxy` is a stdio<->socket byte relay (no framing of its own). Isolated daemon with two clients: client B (never subscribed) received `thread/started`, `thread/name/updated`, `thread/status/changed`, `thread/closed`, `thread/status notLoaded` for client A's thread. Schema from `generate-json-schema` (317 files, versioned with the binary) | Technically yes, passive broadcast observer works with no subscription. Not "stable": help marks `app-server` experimental, schema is version-bound, `experimentalApi` capability gates fields. Caveats: reconnect on daemon restart/update (`daemon update` "may interrupt running work"), daemon may be absent (`--no-daemon`), item/delta notifications flood unless `optOutNotificationMethods` is set, socket dir must be private to the user (the server enforces it). Auth: none for the local socket |
| 4. Daemon lifecycle | `daemon.pid` = `{pid, processStartTime, executableIdentity}`; `daemon-updater.pid`; process `app-server daemon pid-update-loop` (updater, hourly `installer_fetch`/`package_selected` entries in `daemon-updater.stderr.log`); `packages/app-server-daemon/releases/<ver>` + `current`; locks `daemon.lock`, `app-server-startup.lock`. Parent of both processes was a short-lived bootstrap CLI (already gone) | Daemon is detached, survives all TUIs, restarts on update (new pid, `executableIdentity` changes). `daemon.pid` is a cheap, reliable "who is the host" source |
| 5. Every `codex.exe` command-line shape | See list below | Scanner must classify by subcommand, not substring: fixed in `harnesses/codex.mjs` |
| 6. Deterministic TUI pid <-> thread id binding | State DB `threads` has `id, cwd, source, originator, rollout_path, created_at_ms` but no client pid; daemon logs carry `app_server.connection_id` only; `tui-thread-reference-capabilities/<threadId>` empty files are created when a TUI opens a thread (mtime = open time); `thread-writer-locks` holds only `.coordination.lock` while idle; Unix-socket peer pid is not exposed on Windows | Not deterministically derivable without process-handle inspection. Best available heuristic: bind to the TUI process whose start time most recently precedes the thread's `created_at_ms`, restricted to `originator = codex-tui`. Current "most recent unbound TUI" rule kept |

`codex.exe` command-line shapes seen or documented (`--help`, live process list):

| Shape | Role | Seen live |
|---|---|---|
| `"\\?\...\app-server-daemon\releases\<ver>\bin\codex.exe" app-server --listen unix:// --analytics-default-enabled --managed-daemon` | shared daemon (hooks + MCP host) | yes |
| `... codex.exe app-server daemon pid-update-loop` | daemon updater loop | yes |
| `codex app-server proxy [--sock P]` | stdio relay to the control socket (SSH/remote clients) | no |
| `codex` / `codex "<prompt>"` / `codex resume\|fork [id\|--last]` / `codex agents` / `codex --remote unix://` | interactive TUI (connects to daemon; `--no-daemon` embeds a host) | no TUI running during the study |
| `codex exec ...`, `codex review ...` | headless, in-process hooks | no |
| `codex exec-server`, `codex mcp-server`, `codex queue\|archive\|delete\|unarchive`, `login`, `logout`, `mcp`, `plugin`, `doctor`, `update`, `features`, `completion`, `sandbox`, `debug`, `apply`, `cloud`, `app`, `--help`, `--version` | helpers / one-shot management, not sessions | no |
| `codex-windows-sandbox-service.exe` | sandbox helper, different exe name (not matched by exe `codex`) | yes |

Scanner risk found: the old shared regex matched `exec` only as a whole word, so `codex exec-server`,
`codex queue ...`, `codex doctor`, `codex -c k=v exec ...` and `-p <profile>` (a profile flag, not
headless) were misclassified. Replaced with first-positional-token classification (value flags skipped).

#### Verdict per signal

| Signal | Verdict | Failure modes |
|---|---|---|
| Presence | Keep hooks + process scanner. Observer would add nothing the scanner/hooks lack for TUI sessions | Hooks fire at first prompt only (scanner covers app open); subagent threads run hooks in the daemon too (not filtered); `codex exec` now classified background |
| Rename | Keep sqlite/session_index poll (<= 5s). Observer's `thread/name/updated` is instant and verified, optional later | Poll lag 5s; observer needs daemon present + reconnect + experimental protocol |
| Exit | Keep TUI pid watcher (immediate) + hook `SessionEnd`/TTL. `SessionEnd` hook == thread unload == `thread/closed`, 60s after the last TUI leaves (real log: "no subscribers and is idle; shutting down" 2s before the SessionEnd hook) | Rows without a bound pid (thread/new inside a TUI, multiple unbound TUIs) rely on that 60s + TTL; `thread_unload_delay_secs` is user-configurable; observer gives same latency as hooks, not better |

Unverified: embedded-host behavior for `--no-daemon` TUI and `codex exec` (MCP parent, hook pid); real TUI
command-line shape (none running); `thread/archived`/`thread/deleted` delivery to a passive observer;
unload timing under a live observer in the real daemon (only isolated daemon tested); the
`thread_unload_delay_secs` default is 60s in 0.162.1 only.

## 7. How to add a harness

1. Create `src/harnesses/<id>.mjs` exporting a default descriptor that includes `fixtures`; copy the closest existing one.
2. Fill identity: `id`, `aliases`, `displayName`, and the `discovery` block.
3. Pick `presence` sources; implement install/uninstall/diagnose using `shared/install.mjs` helpers
   (idempotent, `.bak`, atomic). Quote hook commands per the harness's runner rules.
4. Choose `pid` strategy; add `classifyProcess` if hooks can be forked/background/shared-host.
5. Provide `name.resolve` (+ `name.watch`, and `pollSession` if state lives in a db).
6. Declare `end.signals`; set `ttlMs` if sessions can lack a pid.
7. If the TUI is a separate process: `process.exe` + `isInteractiveTui`.
8. Register in `src/harnesses/index.mjs` (one import, one entry in the `harnesses` array).
9. Fill `fixtures` (`name.setup`, `tui`, `cmdlines`); the contract suite picks the harness up automatically.
10. Run `npm test` twice; check `mesh hooks doctor <id>`; add a row to SKILL.md harness table.
11. Decide the wake tier: run `mesh probe-wake <id>`, paste the descriptor snippet into `delivery.wake` and the
    evidence row into section 10 (tiers above pull are rejected without evidence).
11b. If the harness has an MCP client, add an opt-in `mcp` presence source with `jsonMcpSource`/`tomlMcpSource`
    (set `announce: false` when its servers are hosted by a shared daemon); otherwise document it as unsupported.
12. Add driver in `src/drivers/` only if the harness should receive headless turns (separate concern).

## 9. Mail delivery (queued message -> running session)

Root causes found (reproduced in `tests/mail-delivery-test.mjs` against an isolated broker):

| Harness | What claimed mail before | Why a message stayed queued / vanished |
|---|---|---|
| claude | Stop hook only (`presence-hook` Stop, plugin `stop-hook`) | An idle TUI never runs a hook; mail waited for the end of the next turn |
| codex | Stop hook only (inside the shared app-server) | Same; plus `agent@<thread name>` never matched (see addressing) |
| antigravity | Stop hook only | Same; PreInvocation (fires before every model call) ignored mail |
| opencode | plugin `session.idle` called claim+ack with **no injection** | Mail was marked delivered and silently dropped (worse than queued) |
| pi | extension `agent_end` called claim+ack with **no injection** | Same: consumed, never shown |
| all | `agent@<name>` stored the raw string as `to_session`; claims use the session id | Never matched, stayed pending forever |
| all | A claim whose hook died before `ack` stayed `claimed` forever | No reaper |

Fixes (descriptor field `delivery: {via, inject[], idle}`):

| Harness | Delivery path | Idle interactive session |
|---|---|---|
| claude, codex | `UserPromptSubmit` hook injects `hookSpecificOutput.additionalContext`; Stop hook (existing) keeps blocking with the mail | cannot be woken: "message waiting" toast |
| antigravity | `PreInvocation` hook injects `{"injectSteps":[{"userMessage": ...}]}` (agy hook contract, from the binary's embedded docs); Stop hook (existing) | cannot be woken: toast |
| opencode | plugin polls every 3s + on `session.idle`, injects with `client.session.promptAsync` | **woken** (starts a turn) |
| pi | extension polls every 3s + on `agent_end`, injects with `pi.sendUserMessage(..., {deliverAs: "followUp"})` (always triggers a turn) | **woken** |
| any with MCP | every `mesh_*` tool result carries "[mesh] N message(s) waiting: call mesh_inbox" | n/a (agent must call a tool) |

Common rules: `agent@<ref>` resolves `<ref>` against live sessions (exact id, name, or unique id prefix);
a failed injection `release_claim`s the tickets; claims not acked within 90s are returned to pending
(skipped for agents with an in-flight headless turn); the broker raises a "message waiting" toast (once per
30s per session) when the target is an interactive session of a `toast-only` harness.

Honest limits: nothing can inject into an idle Claude Code, Codex or Antigravity TUI (no API; headless
`-p --resume` would be a second writer on the same session, which the dual-writer rule forbids). A Codex wake
would be possible through the app-server control socket (`turn/start` on the loaded thread, see section 6)
but needs the observer client that was deliberately not built.

## 10. Wake tiers (reaching an IDLE session)

Delivery is a ladder on top of a universal floor. The floor (**pull**) is always there: queued mail is
injected at the session's next prompt/turn end and a "message waiting" toast tells the human. Tiers above it
are opt-in per harness and recorded in the descriptor as `delivery.wake` (contract: a tier above `pull`
REQUIRES evidence `{version, date, verified, basis}`; `verified:false` = derived from schemas/types/fakes,
never observed waking a live session).

| Tier | Meaning | Launcher |
|---|---|---|
| pull | mail waits for the next prompt/turn end; toast floor | hook |
| push | the harness-side component injects mail itself | plugin / extension / broker |
| stream | a long-lived watcher; every output line wakes the model | model / hook |
| oneshot | a background command; its exit wakes the model; must be re-armed | hook / model |

### Per harness (as of 2026-10-15)

| Harness | Active tier | Mechanism | Evidence | Opt-in candidate |
|---|---|---|---|---|
| pi | push | extension polls, `pi.sendUserMessage(..., {deliverAs: "followUp"})` always triggers a turn | pi-coding-agent types + fake-API tests, not observed live (verified: false) | - |
| opencode | push | plugin polls, `client.session.promptAsync` | @opencode-ai/sdk types (1.19.0) + fake-client tests, not observed live (verified: false) | - |
| codex | pull | - | - | **push** via broker injector: observer connection sends `turn/start` to an IDLE thread (`mesh --init codex --wake`). Verified against a throwaway app-server 0.162.1 daemon in `tests/codex-wake-test.mjs` (idle thread injected, active thread skipped, version pin, reconnect); not run against the live TUI |
| claude | pull | Stop-hook block + UserPromptSubmit additionalContext | - | **oneshot** via `asyncRewake` hook running `mesh wait` (`mesh --init claude --wake`): present in the 2.1.300 hook schema ("runs in background and wakes the model on exit code 2"), hook behavior covered by `tests/mesh-wait-test.mjs`; idle wake NOT yet observed (verified: false). Also present in 2.1.300: Channels (MCP `notifications/claude/channel`), but they need a session started with `--channels` (and an allowlist / org policy), so it cannot reach already-running sessions and is not shipped |
| antigravity | pull | PreInvocation injectSteps + Stop continue | agy hook contract (embedded docs): hooks are synchronous command hooks that only run inside a turn; no background wake found | none known |
| muse | pull | UserPromptSubmit additionalContext (verified with `muse plugins hook test`) + Stop hook | `muse session-message` is unsupported on Windows; no background wake found | none known |

Nothing is promoted to the active tier without a probe run: use `mesh probe-wake <harness>` (guided: arms a
nonce emitter, asks what the harness did, prints the descriptor snippet and the evidence row to paste above).

### Building blocks

- `mesh wait --session <id> [--stream] [--harness-pid N]`: broker `wait` long-poll. Strict claim, 2s debounce
  batching, one listener per session (lease bound to the waiter pid; a second waiter prints "already armed" and
  exits), exits when the harness pid dies / session closes / lease revoked / broker gone, acks only after the
  mail was flushed to stdout, prints how to re-arm (oneshot).
- Claude wake hook (`src/hooks/mesh-wake-hook.mjs`): registered with `async: true, asyncRewake: true` on
  SessionStart and Stop; Stop re-arms after every turn (lease makes duplicates exit at once). Exit code 2 plus
  the enveloped mail on stderr is the wake. No permission prompt is involved (hooks are not tool calls); the
  model replying with `mesh reply` through Bash may prompt: add `Bash(mesh reply:*)` to its allow list.
- Codex injector (`src/harnesses/codex-wake.mjs`): started by the broker when `<meshHome>/.agent-mesh/wake.json`
  has `{"codex": true}` (written by `mesh --init codex --wake`; picked up within 30s or on restart).

### Guardrails (loops, cost, trust)

1. **Strict claims**: a session claims only mail addressed to it, plus untargeted mail only when it is the
   harness's primary live interactive session (most recently active real session).
2. **Hop propagation**: a harness replying to mail it was just delivered inherits that ticket as parent with
   hops+1 (10 min window), so the existing 6-hop limit also stops interactive ping-pong.
3. **Wake policy**: only `ask`/`reply`/urgent mail may wake an idle session (`notify` waits for the next
   prompt); per-session wake budget (default 6 per 10 min, `MESH_WAKE_BUDGET`/`MESH_WAKE_WINDOW_MS`); global
   `mesh mute` / `mesh unmute`. A refused wake falls back to pull + toast, never to dropping mail.
4. **Untrusted input**: one shared formatter (hooks, plugins, extension, MCP, `mesh wait`, Codex injector)
   strips ANSI/control characters, caps size, and wraps each message in a provenance envelope that tells the
   model it is data from another agent, not an instruction from its user.
5. **Idle only**: the Codex injector checks thread status first (never interrupts a running turn); plugins skip
   busy sessions.

### Known limitations

- Claude/Antigravity idle TUIs stay at pull until a probe proves the Claude candidate; Codex wake needs the
  daemon to be running and the thread to be loaded (a closed TUI's thread is not wakeable, mail waits).
- The Codex injector is pinned to app-server 0.162.x; other versions disable it (mail falls back to pull).
- An `asyncRewake` hook is subject to Claude's own loop protection ("exited 2 again" is not re-woken).
- Wake delivery cannot tell which of several untargeted-eligible sessions the human is looking at; it uses the
  most recently active one.

## 11. Muse Code (`muse`)

Identified on this machine: **Muse Code 1.4.8**, Meta's interactive terminal coding agent
(`C:Users<user>AppDataLocalProgramsmusemuse.cmd` -> PowerShell launcher -> `muse-bin-<ver>.exe`).
Found read-only via PATH, `--help` of the real binary under an isolated HOME, and strings of the binary.

| Aspect | Finding |
|---|---|
| Config / state | `~/.config/muse` (settings.json, auth.json, trust.json); data `~/.local/share/muse` (plugins, skills, sessions, `session-index.db`) |
| Hooks / MCP | **Plugin bundles** (`.muse-plugin/plugin.json`, capabilities skills/commands/hooks/mcpServers/reminders) installed with `muse plugins install <dir> --scope user|project` and trusted with `muse plugins approve`. No hand-edited hook file. Hook events are Claude-compatible (SessionStart, UserPromptSubmit, Stop, SessionEnd, PreToolUse, ...); `hookSpecificOutput.additionalContext` is honored (observed with `muse plugins hook test`); each hook needs its own source file |
| Mesh install | descriptor generates `<meshHome>/.agent-mesh/muse-plugin/agent-mesh` (4 wrapper hooks that run the shared presence hook with `--harness muse`) and `.../agent-mesh-mcp` (opt-in stdio MCP server), then shells out to the real `muse` CLI; diagnose reads `muse plugins list --json` |
| Session names | `session-index.db` table `sessions` (`session_name`, then `title`); polled like Codex/agy |
| Process | `muse-bin-<version>.exe`; the launcher's cmd/powershell parents live as long as the TUI. `muse exec` is headless (classified background); `resume` and a bare prompt are the TUI |
| Wake | pull + toast. `muse session-message` (native cross-session messaging) answers "unsupported on this platform" on Windows |
| `.agents` | project `.agents/skills`, workflows, plans are native; `~/.agents/skills` is an import-only source |

Unverified: the live hook stdin payload (field names for session id; fixture-based test only, `muse exec`
with the echo provider does not fire plugin hooks), whether the Stop hook's `decision: block` continues the
turn, the project-scope plugin location, and the native `session-message` path on non-Windows.

## 12. `.agents` convention per harness

One shared helper (`src/harnesses/shared/agents-dir.mjs`: `agentsDir`, `agentsPath`, `skillDir`,
`skillInstalled`) resolves `~/.agents` (override `MESH_AGENTS_HOME`) and `<project>/.agents`; each descriptor
declares `agents: {skills, config, evidence}`. `mesh doctor`/discovery use the helper; nothing is moved.

| Harness | `.agents/skills` | Mesh config under `.agents` | Evidence |
|---|---|---|---|
| claude | no (own `~/.claude/skills`; `~/.agents/skills` only an import source) | no | binary strings |
| codex | yes (capability discovery lists `.agents/skills`) | no | binary strings |
| antigravity | project (`{workspace}/.agents/skills`) | yes: project `.agents/hooks.json`, `.agents/mcp_config.json` | binary strings |
| opencode | not found in the 1.19.0 binary | no | unverified |
| pi | yes, global and project | no | pi docs (skills.md) |
| muse | project only; `~/.agents/skills` import-only | no (plugin bundles via CLI) | binary strings |

## 8. Open decisions and risks

- D1 (decided): id `antigravity`, `agy` is an alias, no DB migration.
- D2 (decided): old installer exports remain as deprecated thin wrappers for one release.
- D3 (done): in-process plugins (OpenCode, Pi) do not import the registry; they share only
  `presence/announce.mjs` (plain ESM, relative import, same as `ipc.mjs`). Risk: loader path breakage; covered by existing install tests.
- D4 (decided, deferred to Phase C): `bindTui` ambiguity with 2+ unbound Codex TUIs remains (known ponytail). Phase C may fix via
  thread cwd/rollout_path; out of scope for the refactor, behavior must not regress.
- D5: descriptor surface may grow; guardrail: any new field needs a contract assertion.
- R1: pid-walk code spawns pwsh on Windows (1-2s); moving it must keep the `.pid` cache and
  SessionEnd fast path byte-for-byte.
- R2: `MESH_HOOK_MATCHER` must keep matching legacy hook names or uninstall leaves orphans.
- R3: circular imports (broker -> registry -> shared -> common); keep `shared/` free of broker imports.
- R4 (mitigated): MCP- and hook-announced sessions are deduped in the broker (`mcp-dedupe.mjs`), covered by
  `tests/mcp-shim-test.mjs`.
- R5 (mitigated): Claude user-scope MCP lives in `~/.claude.json`, which running sessions rewrite constantly.
  The installer uses `claude mcp add/remove --scope user` (HOME/USERPROFILE pointed at the managed file's
  directory) when the CLI is on PATH and falls back to a direct edit with `.bak` otherwise. Project scope
  (`.mcp.json`) is edited directly.
- R6: The shim adds a long-lived node process per session per harness (cheap: idle stdio, one pwsh walk at
  start on Windows for `walk` harnesses).
- D6 (decided): MCP stays opt-in (`--mcp`).
- D7 (decided): `mesh_ask` is enqueue + reply via `mesh_inbox` (documented in the tool description); no blocking wait.

### Known limitations

- Codex subagent threads (`thread_spawn`) run hooks inside the shared daemon and are not filtered: they can
  appear as extra rows until their TTL. Left as is on purpose.
- `bindTui` can swap two unbound Codex TUIs opened before either sends a prompt (Phase C evidence: no
  deterministic TUI pid <-> thread binding exists).
- Claude may normalize/migrate unrelated keys of `~/.claude.json` when the CLI rewrites it; that is Claude's own
  behavior, not the installer's.
