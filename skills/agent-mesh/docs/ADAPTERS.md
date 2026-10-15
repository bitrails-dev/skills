# Harness adapters: plan

Status: Phase 1 (adapter refactor) IMPLEMENTED. Sections 5-6 are plans for Phases 2 and 3.

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

## 6. Tables to fill (Deliverables B and C)

### B. MCP behavior per harness (empirical)

| Harness | Config file/format | Spawn: eager/lazy | Per-session / shared | Parent PID = | Exits with TUI? | clientInfo.name | Notes |
|---|---|---|---|---|---|---|---|
| claude | | | | | | | |
| codex | | | | | | | |
| antigravity | | | | | | | |
| opencode | | | | | | | |
| pi | | | | | | | |

### C. Codex app-server verdict

| Question | Evidence (command / file) | Answer |
|---|---|---|
| MCP servers spawned by daemon or TUI; parent pid | | |
| Dies on soft-close? Spawn timing | | |
| Hooks always run in app-server? | | |
| `app-server proxy`/stdio/ws/unix: thread/name/updated, thread/closed | | |
| Auth, caveats, safe long-lived? | | |
| Daemon lifecycle (daemon.pid, daemon-updater.pid, pid-update-loop) | | |
| All codex.exe cmdline shapes; scanner misclassification risk | | |
| TUI pid <-> thread id binding (cwd, rollout_path, connection ids, threads cols, locks) | | |

| Signal | Verdict (adopt / keep poll / n/a) | Reason |
|---|---|---|
| Presence | | |
| Rename | | |
| Exit | | |

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
