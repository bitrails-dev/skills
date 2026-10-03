---
description: Get ready-to-run installation commands for GSD Core (Git. Ship. Done.)
argument-hint: [--global | --local]
---

# Install GSD Core Command

Present the user with ready-to-run terminal commands to install **GSD Core** (`open-gsd/gsd-core`).

## User Parameter
Argument: `$ARGUMENTS`

## Output Format to Present to the User

Provide the following formatted output with copy-paste blocks:

### 1. Recommended Official CLI Installer (Claude Code)
```bash
# Global installation (recommended for Claude Code across all projects)
npx @opengsd/gsd-core@latest --claude --global

# Or project-local installation:
npx @opengsd/gsd-core@latest --claude
```

### 2. Standard Skills CLI (`npx skills add`)
```bash
# Install globally via skills.sh ecosystem
npx skills add open-gsd/gsd-core -g

# Or install for current project:
npx skills add open-gsd/gsd-core
```

### 3. Shorthand `npx skill install` (if supported)
```bash
npx skill install gsd-core
```

### Next Steps / Verification
Once installed, run in your agent session:
- `/gsd-help` — View available commands
- `/gsd-new-project` — Initialize a new structured project milestone
