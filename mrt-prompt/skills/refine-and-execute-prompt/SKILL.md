---
name: prompt-refiner
description: "Refines a prompt into a precise execution brief, decomposes into sub-tasks, executes with parallel agents, and verifies all outputs through self-check and independent verification. WHEN: 'refine and execute', 'run with agents', 'parallel task execution', 'refine prompt', 'execute with verification'"
disable-model-invocation: true
---

# Prompt Refiner

Take an incoming prompt, improve it for clarity and execution quality, then run the work using a controlled parallel-agent workflow with double verification.

## Parameters

- `prompt` (required): The original task or prompt to refine and execute.
- `max parallel agents` (optional, default: 4): Maximum concurrent agents.

## Workflow

### Phase 1: Refine the Prompt

Rewrite the original prompt into a precise execution brief applying [Refinement Rules](references/refinement-rules.md):

1. Clarify the objective
2. Define scope and exclusions
3. Identify required inputs and outputs
4. Add measurable success criteria
5. Label all assumptions explicitly
6. Convert vague requests into actionable instructions

Output the refined prompt before proceeding.

### Phase 2: Create Task Document

Create a task document named after the skill. If the document is large, split into a folder with these files:

- `idea.md` — What and why
- `plan.md` — Execution strategy and agent allocation
- `steps.md` — Ordered sub-tasks with dependencies
- `outcomes.md` — Measurable success criteria for each sub-task

Each sub-task must include: objective, expected output, measurable outcomes, dependencies.

See [Decomposition Guide](references/decomposition.md) for splitting strategies.

### Phase 3: Execute with Parallel Agents

Launch agents following these rules:

- Never exceed `max parallel agents` concurrent agents
- Only parallelize independent sub-tasks
- Give each agent full context to complete without follow-up
- Each agent must produce: result + self-verification report

Use this agent prompt template:

```
You are executing sub-task: {sub-task name}

Objective: {objective}
Context: {relevant context from refined prompt}
Constraints: {constraints}
Expected output: {output format}
Measurable outcomes: {criteria}

After completing the task, verify your own output:
1. Did the output answer the assigned sub-task?
2. Were all constraints followed?
3. Are assumptions clearly labeled?
4. Are acceptance criteria satisfied?
5. Is anything missing, contradictory, or speculative?

Include a self-verification section in your response.
```

### Phase 4: Agent Self-Verification

Each agent MUST verify its own output before completing. Minimum self-checks:

- Output answers the assigned sub-task completely
- All constraints were followed
- Outcomes are measurable and met
- Assumptions are clearly labeled
- No gaps, contradictions, or speculation

The self-verification report is included in the agent's output.

### Phase 5: Independent Verification

After each agent completes AND self-verifies, launch a separate verifier agent for that output.

Verifier prompt template:

```
You are independently verifying a completed sub-task.

Original sub-task: {sub-task description}
Agent output: {agent's full output}
Original prompt intent: {refined prompt}

Check:
1. Correctness — Is the output factually and logically correct?
2. Completeness — Is anything missing from the expected output?
3. Alignment — Does it match the original prompt intent?
4. Outcomes — Are measurable outcomes actually met?
5. Gaps — Any contradictions, weak assumptions, or speculation?

Report: PASS or FAIL with specific issues and fixes.
```

See [Verification Protocol](references/verification-protocol.md) for details.

### Phase 6: Consolidation

After all agents and verifiers complete:

1. Merge verified sub-results
2. Resolve contradictions raised by verifiers
3. Run a final consistency pass
4. Deliver the final result

Final output format:

- Refined prompt
- Key assumptions
- Completed sub-results
- Verification summary (passes, failures, fixes applied)
- Final deliverable ready for downstream use

## Simple vs Complex Tasks

**Simple tasks** (single objective, clear scope):

- Refine the prompt
- Return the improved version compactly
- Skip decomposition unless useful

**Complex tasks** (multi-step, ambiguous, large scope):

- Full workflow: refine → document → execute → self-verify → independently verify → consolidate

## Success Criteria

A run is successful when all [Outcomes Checklist](references/outcomes-checklist.md) items pass:

- Original intent preserved
- Ambiguity reduced
- Refined prompt is more actionable than input
- Every sub-task has clear success criteria
- Parallel limit respected
- Every agent output includes self-verification
- Every agent output receives independent verification
- Final answer is internally consistent
