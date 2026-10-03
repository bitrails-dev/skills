---
name: install-skills
description: Passes copy-pasteable terminal commands for the user to self-install their favorite AI agent skills (gsd-core, mattpocock, context-mode, and extensible favorites). Handles npx skills add, npx skill install, and custom installers/plugins. Trigger when the user wants to install, set up, or view commands for skills.
---

# Install Skills

This skill provides ready-to-execute terminal commands and instructions for users to self-install their favorite AI agent skills and plugins. It acts as an interactive command provider rather than silently executing installations, giving the user full visibility and control over what gets installed into their environment.

## When to Use This Skill

Activate this skill when:
- The user asks how to install, setup, or add `gsd-core`, `mattpocock`, `context-mode`, or other agent skills.
- The user asks for terminal commands to run themselves to install skills.
- The user runs `/install-skills`, `/install-gsd`, `/install-mattpocock`, or `/install-context-mode`.
- The user asks how to add more skills to their favorites catalog.

## Core Installation Philosophy

1. **Self-Execution**: Do not execute npm/npx/git installation commands blindly in the background unless the user explicitly requests you to run it. Instead, format clean, syntax-highlighted commands in markdown code blocks with clear explanations so the user can copy and run them in their terminal.
2. **Multi-Method Support**: For each skill, provide:
   - **`npx skills add`** (The open ecosystem standard via [skills.sh](https://skills.sh/)) with both `--global` (`-g`) and local repo variants.
   - **`npx skill install`** (The shorthand syntax where supported by the user's CLI).
   - **Custom / Official Commands** (e.g. dedicated `@opengsd/gsd-core` CLI installer, Claude Code marketplace plugins, or MCP server additions).
3. **Post-Install Step**: Always remind the user of any post-install setup or verification command (e.g., `/setup-matt-pocock-skills`, `/context-mode:ctx-doctor`, `/gsd-help`).

## Supported Skills Registry

All skill metadata, repositories, and command variants are maintained in:
`my-skill-commands/data/skills-registry.json`

### 1. GSD Core (`gsd-core`)
- **Repository**: [open-gsd/gsd-core](https://github.com/open-gsd/gsd-core)
- **Purpose**: Spec-driven development framework preventing context rot via structured discuss -> plan -> execute -> verify cycles.
- **Commands**:
  ```bash
  # Recommended: Official GSD CLI installer for Claude Code (Global)
  npx @opengsd/gsd-core@latest --claude --global

  # Alternative: Project-local Claude Code setup
  npx @opengsd/gsd-core@latest --claude

  # Standard Skills CLI (Global)
  npx skills add open-gsd/gsd-core -g

  # Shorthand (if supported)
  npx skill install gsd-core
  ```
- **Post-Install**:
  - `/gsd-help` — View available commands
  - `/gsd-new-project` — Initialize a new structured project

### 2. Matt Pocock's Skills (`mattpocock`)
- **Repository**: [mattpocock/skills](https://github.com/mattpocock/skills)
- **Purpose**: Modular collection of engineering habits (Socratic review `grill-me`, `tdd`, `improve-codebase-architecture`, `to-prd`).
- **Commands**:
  ```bash
  # Standard Skills CLI: Install all skills globally
  npx skills@latest add mattpocock/skills -g

  # Standard Skills CLI: Install for current project only
  npx skills@latest add mattpocock/skills

  # Install specific skill only (e.g. Socratic code review)
  npx skills@latest add mattpocock/skills/grill-me -g

  # Shorthand (if supported)
  npx skill install mattpocock/skills
  ```
- **Post-Install**:
  - `/setup-matt-pocock-skills` — Configures issue tracker, triage labels, and domain doc layout.

### 3. Context-Mode (`context-mode`)
- **Repository**: [mksglu/context-mode](https://github.com/mksglu/context-mode)
- **Purpose**: Context window optimizer saving up to 98% of tokens through isolated tool execution and local SQLite search history.
- **Commands**:
  ```bash
  # Recommended for Claude Code: Plugin Marketplace Install
  /plugin marketplace add mksglu/context-mode
  /plugin install context-mode@context-mode

  # Direct Claude MCP Add (Tool-only)
  claude mcp add context-mode -- npx -y context-mode

  # Skills CLI (Global)
  npx skills add mksglu/context-mode -g

  # Shorthand (if supported)
  npx skill install context-mode
  ```
- **Post-Install**:
  - `/context-mode:ctx-doctor` — Confirms tool execution sandboxing and SQLite database health.

---

## How to Add New Skills Later

To add a new favorite skill to this plugin:
1. Open [data/skills-registry.json](file:///D:/WORKSPACE/resources/skill-bank/my-skill-commands/data/skills-registry.json).
2. Add a new entry under the `"skills"` object following this template:
   ```json
   "your-skill-id": {
     "id": "your-skill-id",
     "displayName": "Your Skill Name",
     "description": "What this skill does",
     "category": "workflow",
     "repository": "https://github.com/owner/repo",
     "npxSkills": {
       "supported": true,
       "global": "npx skills add owner/repo -g",
       "local": "npx skills add owner/repo"
     },
     "npxSkillInstall": {
       "supported": true,
       "command": "npx skill install your-skill-id"
     },
     "customCommands": [
       {
         "name": "Custom Command Name",
         "command": "custom install command here",
         "recommended": true,
         "description": "Why and when to use this command"
       }
     ],
     "postInstall": [
       "/your-skill-command to verify or configure"
     ]
   }
   ```
3. Optionally add a dedicated slash command in `commands/install-<skill-id>.md`.
