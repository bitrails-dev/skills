# Task Decomposition Guide

## When to Decompose

Decompose when the task has:
- Multiple independent deliverables
- Sequential dependencies between steps
- Research + execution phases
- Output that needs separate verification stages

Do NOT decompose when:
- Single objective with clear steps
- One agent can complete it in one pass
- Decomposition adds overhead without clarity

## Sub-Task Template

Each sub-task must specify:

```
### Sub-Task: {name}
- Objective: {one sentence}
- Expected output: {format and content}
- Measurable outcomes:
  - {outcome 1}
  - {outcome 2}
- Dependencies: {list of sub-task names or "none"}
```

## Dependency Types

- **Sequential**: B cannot start until A completes.
- **Parallel**: A and B are independent, can run simultaneously.
- **Conditional**: B runs only if A produces a specific result.

## Agent Allocation Strategy

| Role | Count | Purpose |
|---|---|---|
| Refiner | 1 | Rewrite the prompt |
| Decomposer | 1 | Split into sub-tasks |
| Executor | 1 to N | Parallel task execution |
| Verifier | 1 per executor | Independent verification |
| Integrator | 1 | Final consolidation |

## Document Splitting

If the task document exceeds ~500 lines, split into a folder:

- `idea.md` — Problem statement, goals, constraints
- `plan.md` — Agent allocation, dependency graph, execution order
- `steps.md` — Sub-task definitions with all fields
- `outcomes.md` — Success criteria per sub-task, acceptance tests

Each file should be self-contained enough to hand to an agent as context.
