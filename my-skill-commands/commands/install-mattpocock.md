---
description: Get ready-to-run installation commands for Matt Pocock's engineering & productivity skills
argument-hint: [--global | --local | skill-name]
---

# Install Matt Pocock Skills Command

Present the user with ready-to-run terminal commands to install **Matt Pocock's Skills** (`mattpocock/skills`).

## User Parameter
Argument: `$ARGUMENTS`

## Output Format to Present to the User

Provide the following formatted output with copy-paste blocks:

### 1. Full Collection via Skills CLI (`npx skills add`)
```bash
# Install all Matt Pocock skills globally
npx skills@latest add mattpocock/skills -g

# Or install for the current project:
npx skills@latest add mattpocock/skills
```

### 2. Shorthand `npx skill install` (if supported)
```bash
npx skill install mattpocock/skills
```

### 3. Install Individual Specific Skills
```bash
# Socratic Code Review (grill-me)
npx skills@latest add mattpocock/skills/grill-me -g

# Test-Driven Development enforcement (tdd)
npx skills@latest add mattpocock/skills/tdd -g

# Architecture diagnosis (diagnose)
npx skills@latest add mattpocock/skills/diagnose -g
```

### Next Steps / Verification
Run in your agent session after installation:
- `/setup-matt-pocock-skills` — Configures issue tracker, triage labels, and domain doc layout for your repository.
