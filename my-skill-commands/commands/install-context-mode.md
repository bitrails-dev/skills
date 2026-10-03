---
description: Get ready-to-run installation commands for Context-Mode (token and context optimizer)
argument-hint: [--plugin | --mcp | --skill]
---

# Install Context-Mode Command

Present the user with ready-to-run commands to install **Context-Mode** (`mksglu/context-mode`).

## User Parameter
Argument: `$ARGUMENTS`

## Output Format to Present to the User

Provide the following formatted output with copy-paste blocks:

### 1. Claude Code Plugin Marketplace (Recommended for full auto-routing & hooks)
Run inside your Claude Code session:
```bash
/plugin marketplace add mksglu/context-mode
/plugin install context-mode@context-mode
```

### 2. Standalone MCP Server Direct Addition (Claude CLI)
Run in your terminal:
```bash
claude mcp add context-mode -- npx -y context-mode
```

### 3. Agent Skill via Skills CLI (`npx skills add`)
Run in your terminal:
```bash
# Global installation
npx skills add mksglu/context-mode -g

# Or project-local:
npx skills add mksglu/context-mode
```

### 4. Shorthand `npx skill install` (if supported)
```bash
npx skill install context-mode
```

### Next Steps / Verification
Run in your agent session:
- `/context-mode:ctx-doctor` — Confirms tool execution sandboxing and SQLite database health.
