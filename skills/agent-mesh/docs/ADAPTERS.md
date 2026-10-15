# Harness adapters: plan

Status: Phase 1 (adapter refactor) and Phase 2 (Codex host study, section 6) done. Section 5 (MCP shim) is a plan.

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
src/presence/        tui-scanner.mjs  name-watch.mjs  announce.mjs
tests/harness-contract-test.mjs
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

## 5. MCP shim design (`src/mcp/mesh-mcp.mjs`, zero deps)

- Transport: stdio, newline-delimited JSON-RPC 2.0. Methods: `initialize` (reply
  `protocolVersion` echoing client's if supported else latest we know, `capabilities:{tools:{}}`,
  `serverInfo`), `notifications/initialized`, `ping`, `tools/list`, `tools/call`; unknown request ->
  `-32601`; unknown notification ignored.
- Identity: harness from `initialize.params.clientInfo.name` mapped through registry aliases/`mcpClientNames`
  (new optional descriptor field), fallback env `MESH_HARNESS`/argv `--harness`. Session id
  `mcp:<harness>:<ppid>`. pid = `process.ppid` (walked past shells via `shared/process.mjs` when the
  descriptor says `walk`). cwd = `process.cwd()`.
- Presence: after `initialize` -> `session_event start (origin:"interactive", via:"mcp", pid:"provided")`;
  `tools/call` -> `busy`/`idle`; stdin EOF/SIGTERM -> `end`. Broker PID watcher is the backstop.
- Tools: `mesh_send {to, body}`, `mesh_ask {to, body, timeoutMs?}`, `mesh_inbox {}` (claim+ack),
  `mesh_status {}`; each is one `sendIpcRequest` (existing actions send/ask/claim_inbox/ack/status).
- Dedupe key: `(harness, pid)`. Broker `session_event` with `via:"mcp"` and a live row for same
  harness+pid reuses that row (merge name/cwd), never creates a second row or second start toast;
  reverse order (hook after MCP) also rebinds like `bindTui`. Implemented once in `updateSessionEvent`
  callers (`presence/dedupe.mjs`), not per harness.
- Install: new `PresenceSource{kind:"mcp"}` per descriptor, same install/uninstall/diagnose contract.

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
| claude | | | | | | | Phase 2b |
| antigravity | | | | | | | Phase 2b |
| opencode | | | | | | | Phase 2b |
| pi | | | | | | | Phase 2b |

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
11. Add driver in `src/drivers/` only if the harness should receive headless turns (separate concern).

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
- R4: MCP-announced sessions racing hook-announced ones could double-toast before dedupe lands;
  mitigated by landing dedupe in the broker before the shim ships.
