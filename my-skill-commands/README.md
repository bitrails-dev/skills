# my-skill-commands

> **A plugin for quickly accessing and executing installation commands for favorite AI agent skills and plugins.**

`my-skill-commands` is a modular, extensible plugin for AI coding agents (Claude Code, Antigravity, etc.). Instead of performing opaque background package installations, it presents clean, syntax-highlighted commands for the developer to run themselves in their terminal—prioritizing standard Skills CLI (`npx skills add`), shorthand (`npx skill install`), and official custom installers.

---

## Included Favorite Skills

| Skill | Repository | Primary Command | Shorthand | Post-Install |
| :--- | :--- | :--- | :--- | :--- |
| **GSD Core** | [`open-gsd/gsd-core`](https://github.com/open-gsd/gsd-core) | `npx @opengsd/gsd-core@latest --claude --global` | `npx skill install gsd-core` | `/gsd-help`<br>`/gsd-new-project` |
| **Matt Pocock's Skills** | [`mattpocock/skills`](https://github.com/mattpocock/skills) | `npx skills@latest add mattpocock/skills -g` | `npx skill install mattpocock/skills` | `/setup-matt-pocock-skills` |
| **Context-Mode** | [`mksglu/context-mode`](https://github.com/mksglu/context-mode) | `/plugin marketplace add mksglu/context-mode`<br>`/plugin install context-mode@context-mode` | `npx skill install context-mode` | `/context-mode:ctx-doctor` |

---

## Directory Structure

```text
my-skill-commands/
├── .claude-plugin/
│   └── plugin.json                   # Manifest for Claude Code plugin discovery
├── plugin.json                       # Manifest for Antigravity plugin discovery
├── commands/                         # Slash commands for interactive agent sessions
│   ├── install-skills.md             # /install-skills [skill-name | all | list]
│   ├── install-gsd.md                # /install-gsd
│   ├── install-mattpocock.md         # /install-mattpocock
│   └── install-context-mode.md       # /install-context-mode
├── skills/
│   └── install-skills/
│       └── SKILL.md                  # Agent skill for interactive chat guidance
├── data/
│   ├── schema.json                   # JSON Schema validating the skills registry
│   └── skills-registry.json          # Single source of truth for all favorite skills
├── scripts/
│   └── Get-SkillCommands.ps1         # Standalone PowerShell CLI utility
└── README.md                         # Documentation & usage guide
```

---

## How to Use

### 1. In Claude Code / Agent Chat

You can trigger commands in chat either with slash commands or in natural language:

- **Slash Commands**:
  - `/install-skills` — Displays commands for all favorite skills.
  - `/install-skills gsd-core` — Displays commands for GSD Core.
  - `/install-skills mattpocock` — Displays commands for Matt Pocock skills.
  - `/install-skills context-mode` — Displays commands for Context-Mode.
  - `/install-gsd` — Shortcut for GSD Core.
  - `/install-mattpocock` — Shortcut for Matt Pocock skills.
  - `/install-context-mode` — Shortcut for Context-Mode.

- **Natural Language Prompts**:
  - *"Give me the commands to install gsd-core"*
  - *"How do I install mattpocock's skills?"*
  - *"Pass me the commands to install context-mode"*
  - *"Show me installation commands for my favorite skills"*

### 2. Standalone PowerShell Utility (`Get-SkillCommands.ps1`)

If you want to view or copy commands directly from your Windows terminal without opening an AI agent session:

```powershell
# List all registered skills
pwsh ./my-skill-commands/scripts/Get-SkillCommands.ps1 -List

# View commands for a specific skill
pwsh ./my-skill-commands/scripts/Get-SkillCommands.ps1 -Skill gsd-core

# View commands and copy the primary recommended command to your clipboard
pwsh ./my-skill-commands/scripts/Get-SkillCommands.ps1 -Skill mattpocock -Copy

# View commands for all skills
pwsh ./my-skill-commands/scripts/Get-SkillCommands.ps1 -All

# Filter by method (e.g. only NpxSkills or only Custom)
pwsh ./my-skill-commands/scripts/Get-SkillCommands.ps1 -Skill gsd-core -Method NpxSkills
```

---

## Adding New Skills Later

Adding a new skill is fully decoupled and requires only an entry in [`data/skills-registry.json`](file:///D:/WORKSPACE/resources/skill-bank/my-skill-commands/data/skills-registry.json):

1. Open [`data/skills-registry.json`](file:///D:/WORKSPACE/resources/skill-bank/my-skill-commands/data/skills-registry.json).
2. Insert a new object under `"skills"`:

```json
"new-skill-slug": {
  "id": "new-skill-slug",
  "displayName": "Display Name of Skill",
  "description": "What this skill does and why you use it.",
  "category": "workflow",
  "repository": "https://github.com/owner/repo",
  "npxSkills": {
    "supported": true,
    "global": "npx skills add owner/repo -g",
    "local": "npx skills add owner/repo",
    "notes": "Any notes on using npx skills"
  },
  "npxSkillInstall": {
    "supported": true,
    "command": "npx skill install new-skill-slug",
    "notes": "Optional notes"
  },
  "customCommands": [
    {
      "name": "Custom CLI / Marketplace Install",
      "command": "command to run",
      "recommended": true,
      "description": "Detailed explanation"
    }
  ],
  "postInstall": [
    "/verify-command (Explanation of next steps)"
  ],
  "troubleshooting": "Tips or known caveats"
}
```

3. (Optional) Create a shortcut command in `commands/install-new-skill-slug.md` if you want a dedicated slash command.

Both the agent skill (`SKILL.md`) and the PowerShell script (`Get-SkillCommands.ps1`) will immediately recognize and display the new skill without any code modifications.
