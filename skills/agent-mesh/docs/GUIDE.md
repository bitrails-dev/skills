# Agent Mesh user guide

Task-oriented. Design details live in [ADAPTERS.md](ADAPTERS.md). Every command below was checked against
`scripts/mesh.mjs`.

Shorthand used here (the `mesh` binary is `scripts/mesh.mjs` of the installed skill):

```sh
alias mesh='node ~/.agents/skills/agent-mesh/scripts/mesh.mjs'      # bash
function mesh { node "$HOME\.agents\skills\agent-mesh\scripts\mesh.mjs" @args }   # PowerShell
```

## 1. What gets installed where

The skill lives in **one directory**: `~/.agents/skills/agent-mesh` (other harness skill folders such as
`~/.claude/skills/agent-mesh` are links to it). Everything the installer writes into harness configs points at
that directory by absolute path; nothing is copied.

| Harness | Presence (always with `--init`) | Opt-in MCP (`--mcp` / `mesh mcp`) | Opt-in wake (`--wake` / `mesh wake`) |
|---|---|---|---|
| claude | hooks SessionStart / UserPromptSubmit / Stop / SessionEnd in `~/.claude/settings.json` (project: `.claude/settings.json`) | `~/.claude.json` `mcpServers` (project: `.mcp.json`) | async re-waking hook entries in the same `settings.json` |
| codex | same four hooks in `~/.codex/hooks.json` (project: `.codex/hooks.json`) | managed block in `~/.codex/config.toml` | flag in `~/.agent-mesh/wake.json`; the broker runs the injector |
| antigravity (`agy`) | block `agent-mesh-presence` in `~/.gemini/config/hooks.json` (project: `.agents/hooks.json`) | `~/.gemini/config/mcp_config.json` | none (pull + toast) |
| opencode | loader `~/.config/opencode/plugins/agent-mesh-presence.js` + `plugin` entry in `~/.config/opencode/opencode.json` (project: `.opencode/`) | `mcp` key of `opencode.json` | none needed (plugin pushes) |
| pi | loader `~/.pi/agent/extensions/agent-mesh-presence.js` (project: `.pi/extensions/`) | `~/.pi/agent/mcp.json` (project: `.pi/mcp.json`) | none needed (extension pushes) |
| muse | plugin bundle `agent-mesh` (4 hook wrappers) installed with `muse plugins install --scope user` and approved; state under `<MESH_HOME>/.agent-mesh/muse-plugin/` | plugin bundle `agent-mesh-mcp` | none (pull + toast) |

Config files are edited idempotently with a `.bak` next to them; foreign entries are left alone. Muse is the exception: it
has no hand-edited hook file, so mesh drives its `muse plugins` CLI instead. Which harnesses read the shared
`~/.agents` / `.agents` skill folders is tabulated in [ADAPTERS.md section 12](ADAPTERS.md).

State, shared by everything, in `~/.agent-mesh/` (or `$MESH_HOME/.agent-mesh`):

| Path | What |
|---|---|
| `broker.json` | running broker: pid, IPC address, version |
| `mesh.db` | sessions + message queue (SQLite) |
| `logs/hooks.log` | audit line per hook call (`mesh doctor` tails it) |
| `logs/broker.log` | broker stdout/stderr |
| `pids/` | per-session pid cache (`<id>.pid`, `.bg` background, `.nopid` shared daemon) |
| `locks/` | hook de-duplication locks |
| `wake-muted` | exists while `mesh mute` is active |
| `wake.json` | opt-in broker-side wake injectors (`{"codex": true}`) |

There is **one broker per user** (a background node process). Hooks never start it.

## 2. First-time install (the one command)

```sh
mesh setup          # interactive: detects harnesses, pick install / update / uninstall + MCP / wake, confirm
```

`mesh setup` is the primary path for install, update and removal; it is idempotent and zero-dependency
(readline). Same thing without questions:

```sh
mesh setup --yes --harness claude,codex --action install --mcp --wake     # explicit
mesh setup --yes --all --action update                                    # refresh everything already installed
mesh setup --yes --all --action uninstall [--purge]                       # remove all (opt-ins too); --purge also deletes ~/.agent-mesh
mesh setup --dry-run --harness claude --action install --mcp              # print the plan only
```

| Flag | Meaning |
|---|---|
| `--action install|update|uninstall` | default: asked (interactive) / `install` with `--yes` |
| `--harness a,b` / `--all` | which harnesses (aliases ok); default = detected. With `--all`, update/uninstall only touch installed ones |
| `--mcp`, `--wake` | opt-in components (update keeps the ones already installed) |
| `--project` / `--global` | scope (default global) |
| `--yes`, `--dry-run`, `--purge`, `--restart`, `--no-broker`, `--interactive` | no questions / plan only / delete state dir / force broker restart / skip the broker / force prompts on a pipe |

Without a terminal and without flags it prints the exact flags above and exits 2. After an install/update it
starts the broker (an older broker is upgraded automatically; `--restart` forces it). If the package is
published, `npx agent-mesh` runs the same flow (`scripts/agent-mesh.mjs`).

### Manual path (what setup does under the hood)

Prerequisites: Node 22.5+ (built-in `node:sqlite`), the harnesses you want, and the skill installed globally.

```sh
pnpx skills add <source> --skill agent-mesh --global      # puts the skill in ~/.agents/skills/agent-mesh
mesh --init                                               # auto-detects harnesses that have the skill available
```

- Pick harnesses explicitly: `mesh --init claude,codex` or `mesh --init claude codex pi` (aliases `agy`,
  `gemini`, `claude-code` work). `--install`, `init`, `setup` are synonyms.
- Scope: global by default; `--project` writes the project-level files from the table instead (run it in the
  project directory).
- Opt-ins: `--mcp` also registers the MCP shim, `--wake` the idle-wake source. Both can be added later (section 4).
- `--init` ends by starting (or upgrading) the broker.

Then **restart the harness sessions** you want tracked (Claude/Codex/agy read their hook config at session
start; OpenCode/Pi load the plugin/extension at launch).

Verify:

```sh
mesh doctor      # per harness: hook status (+ MCP / wake if installed), broker pid + version, last hook log lines
mesh status      # live sessions, pending mail per agent
mesh hooks watch # live stream of hook events (bell with --sound, popup with --popup)
```

Open a harness session: you should get a start toast and a row in `mesh status`.

### How do I know this session is on the mesh?

Every session announces itself at start, and shows a badge where its harness allows (declared per descriptor as
`ui.identity`):

| Harness | Badge |
|---|---|
| claude, codex | SessionStart hook prints a user-visible line `agent-mesh: <name> (<id>) · <harness> · N peers · inbox M` plus one context line for the model |
| antigravity | model-visible context step only (no user-visible channel known) |
| muse | context line for the model (user-visible `systemMessage` unverified) |
| opencode | toast at start |
| pi | persistent footer status `agent-mesh` (refreshed after each turn) |

Ask explicitly any time:

```sh
mesh whoami                          # by $MESH_SESSION_ID, else the sessions whose cwd is the current directory
mesh whoami --session <name|id>      # also --harness h, --pid N, --line (one line)
```

From inside a session with the MCP shim, the model can call **`mesh_whoami`** (session id/name, harness, pid,
cwd, wake tier, installed components, peers, waiting mail, muted flag); `mesh_status` starts with the same line,
and the MCP `initialize` instructions tell the model it is on the mesh. `MESH_NO_BADGE=1` silences the
start-of-session badge (hooks, toast, status).

Optional status-line snippet (document only; mesh never edits your status line). Claude Code pipes JSON with
`session_id` to a `statusLine` command, so:

```json
{ "statusLine": { "type": "command", "command": "node ~/.agents/skills/agent-mesh/scripts/mesh.mjs whoami --line --stdin" } }
```

## 3. Updating

```sh
pnpx skills update agent-mesh --global
mesh stop && mesh start        # restart the broker
```

What the update does and does not touch:

| Piece | After the update |
|---|---|
| Hook commands (Claude, Codex, agy) | Point at the skill directory, so the **next hook call runs the new code**. Nothing to re-run. |
| OpenCode plugin / Pi extension | The loader file imports the skill's script, but the harness loaded it at launch: running sessions keep the **old code until restarted**. |
| MCP entries, wake hook entries | Same paths into the skill dir. A running MCP server process is the old code until its session restarts. |
| Broker | A running broker keeps the **old code in memory**. `mesh start` / `mesh --init` restart it automatically **only if its version is older** than the skill's `package.json` version (graceful drain, then relaunch; `src/version.mjs` + `ensureBroker`). Same version number = no restart, so do `mesh stop && mesh start` after every update to be safe. There is no `mesh restart`. |
| Config shape changes | If a release adds hook events or opt-in sources, run `mesh --init` again (idempotent). Release notes say when. |

Running `mesh --init` after an update is always safe; it re-writes the config entries (refreshing paths) and
upgrades the broker if needed.

## 4. One command for MCP and wake

```sh
mesh mcp  install|remove|status [harness...|all] [--project|--global]
mesh wake install|remove|status [harness...|all] [--project|--global]
```

- `mesh mcp install all` registers the shim in every harness that supports it (all five). Without a harness
  list it uses the auto-detected ones. Only the MCP entry is touched, not the presence hooks.
- `mesh --init <h> --mcp` is the same thing bundled with the hook install; `mesh --uninstall` removes MCP and
  wake entries too.
- After installing MCP: restart the harness session. No broker restart.
- After `mesh wake install claude`: restart the Claude session. `mesh wake install codex`: no restart; the
  broker notices within 30 s. Wake tiers and their evidence: [ADAPTERS.md section 10](ADAPTERS.md).

## 5. Command reference

| Task | Command |
|---|---|
| Status of sessions and queues | `mesh status` |
| Full diagnosis | `mesh doctor` (alias `mesh hooks doctor`) |
| Start / stop broker | `mesh start` / `mesh stop` (restart = both) |
| Live hook stream | `mesh hooks watch [--sound] [--popup]` |
| Install / remove hooks only | `mesh hooks install [h...]` / `mesh hooks uninstall [h...]` |
| Remove everything (hooks, MCP, wake) and stop the broker | `mesh --uninstall [h...] [--project|--global]` |
| Send / ask | `mesh send --to <agent>[@<session name, id or id prefix>] "text"` / `mesh ask --to ...` |
| Reply | `mesh reply --ticket <id> --to <agent> "text"` |
| Look at mail | `mesh inbox <agent> [--delivered] [--limit N]` |
| Wait for mail (listener) | `mesh wait --session <id> [--agent h] [--stream] [--harness-pid N]` |
| Stop waking idle sessions / resume | `mesh mute` / `mesh unmute` |
| Measure a harness's wake tier | `mesh probe-wake <harness> [--after 20] [--stream]` |
| Tail an agent | `mesh watch <agent>` |
| MCP / wake opt-ins | section 4 |

Logs: `~/.agent-mesh/logs/hooks.log`, `~/.agent-mesh/logs/broker.log`.

Stale sessions: rows close themselves when their pid is gone; rows without a pid (Codex) after 10 min idle /
60 min busy. A broker restart reaps dead ones immediately. Last resort (loses queued mail): `mesh stop`, delete
`~/.agent-mesh/mesh.db*`, `mesh start`. `broker.json.<pid>.tmp` files in `~/.agent-mesh` are crash leftovers
and can be deleted while the broker is stopped.

## 6. Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| Session not in `mesh status` | `mesh doctor`: hooks installed? broker active? `hooks.log` recent? | `mesh start`; `mesh --init <harness>`; restart the harness session |
| No toasts | broker running? | `mesh start` (toasts for hook events come from the hook, others from the broker) |
| **Message queued but the idle harness does not respond** | `mesh status` shows it pending. Is the target Claude/Codex/agy? Is it `notify` (never wakes) or `ask`? `mesh unmute` | Expected for pull-tier harnesses: delivered at the session's next prompt (toast "message waiting" is the floor). Pi/OpenCode push by themselves. For Codex/Claude opt in: `mesh wake install codex` / `claude`. Tier table: [ADAPTERS.md section 10](ADAPTERS.md) |
| Mail stays queued even at the next prompt | Addressed to a session name? is that session the harness's most recent one? | Address a specific session: `--to claude@<name or id prefix>`; `mesh inbox <agent>` |
| Wakes stop after a few messages | per-session budget (6 / 10 min) or muted | wait, `mesh unmute`, or raise `MESH_WAKE_BUDGET` for the broker |
| Two rows / two toasts for one session | MCP + hooks both installed | Expected to merge (same pid); if not, `mesh stop && mesh start` and re-open the session |
| Hooks "FAIL" in `mesh doctor` log | error text in the line | broker down -> `mesh start`; path gone -> section 7 |
| `Broker restart produced vX, but CLI requires vY` | two skill copies / an old broker holding the pipe | `mesh stop`; kill the pid in `~/.agent-mesh/broker.json` if it survives; `mesh start` |

## 7. "Something happened" runbook

**Broker is dead / `mesh status` fails**
1. `mesh doctor` (is a pid listed?).
2. `mesh start`. If it times out: look at `~/.agent-mesh/logs/broker.log`.
3. Still stuck: `mesh stop`, delete a stale `~/.agent-mesh/broker.json`, `mesh start`.
4. Open sessions re-announce on their next hook event; Codex/agy rows are picked up by the process scanner.

**Hooks disappeared after a harness update (or someone rewrote its config)**
1. `mesh doctor` shows "Not installed" / "File does not exist" for that harness.
2. `mesh --init <harness>` (add `--mcp` / `--wake` if you use them), or `mesh hooks install <harness>`.
3. Restart the harness session.

**Config file overwritten or corrupted**
1. The installer refuses to touch invalid JSON and reports it. Fix or restore the file (`<file>.bak` holds the
   state before the last mesh write).
2. `mesh --init <harness>`.

**Version mismatch (broker older than the skill, or CLI/broker disagree)**
1. `mesh doctor` shows the broker version; compare with `~/.agents/skills/agent-mesh/package.json`.
2. `mesh start` upgrades an older broker gracefully (drains turns, relaunches). If the versions are equal but the
   code is stale: `mesh stop && mesh start`.
3. Legacy (<1.1.0) brokers have no restart action; `mesh start` force-kills them.

**Skill directory moved / reinstalled elsewhere**
1. Hook commands still contain the old absolute path: run `mesh --init` from the new location (rewrites the
   entries), then restart sessions.

**Back out completely**
`mesh --uninstall` (all harnesses, global and project scope, MCP + wake included; stops the broker). State in
`~/.agent-mesh` is left; delete the directory to drop history and queues.
