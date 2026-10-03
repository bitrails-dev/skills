---
description: Get ready-to-run installation commands for favorite agent skills (gsd-core, mattpocock, context-mode, or all).
argument-hint: [skill-name | all | list]
---

# Install Skills Command

You are assisting the user by presenting terminal commands for them to run themselves to install their favorite agent skills.

## User Request Context
Argument passed: `$ARGUMENTS`

## Instructions

1. **Check the Argument**:
   - If `$ARGUMENTS` specifies a skill (e.g., `gsd-core`, `mattpocock`, `context-mode`, or a custom name):
     Present the exact installation commands for that skill.
   - If `$ARGUMENTS` is empty, `all`, or `list`:
     Present the complete list of favorite skills and their respective commands.

2. **Command Presentation Rules**:
   - Provide clean, copy-pasteable terminal code blocks (marked with `bash` or `pwsh`).
   - Prioritize:
     - **Skills CLI Standard**: `npx skills add <repo>` (and highlight global `-g` vs local).
     - **Shorthand Installer**: `npx skill install <name>` (if supported by user's toolchain).
     - **Official / Custom CLI**: (e.g., `npx @opengsd/gsd-core@latest --claude --global` for GSD Core, or Claude Code `/plugin marketplace add` for Context-Mode).
   - Show the post-install setup command for each skill (e.g., `/setup-matt-pocock-skills`, `/context-mode:ctx-doctor`, `/gsd-help`).
   - Clearly state that the user should run these commands directly in their terminal.

3. **Data Source**:
   - Refer to `${CLAUDE_PLUGIN_ROOT}/data/skills-registry.json` (or `my-skill-commands/data/skills-registry.json`) for the source of truth on all commands and metadata.

4. **Extensibility Notice**:
   - Inform the user that they can easily register new favorite skills by adding an entry to `my-skill-commands/data/skills-registry.json`.
