# Prompt Refinement Rules

## Objective Clarity

- State the goal in one sentence first, then expand.
- Use active voice: "Build X that does Y" not "X should be built."
- Distinguish between the end goal and the method.

## Scope Definition

- List what is in scope explicitly.
- List what is out of scope explicitly.
- Define boundaries: time, size, complexity, platform.

## Inputs and Outputs

- Name every required input and its format.
- Name every expected output and its format.
- Identify optional vs required parameters.

## Success Criteria

- Every deliverable needs a pass/fail test.
- Prefer binary checks: "output contains X" not "output is good."
- Include edge cases that must be handled.

## Assumptions

- Label every assumption as `[ASSUMPTION]`.
- Only add assumptions when the prompt is genuinely ambiguous.
- Never silently assume away ambiguity — expose it.

## Vague-to-Actionable Conversion

| Vague | Actionable |
|---|---|
| "Make it better" | "Reduce latency from 2s to under 500ms" |
| "Handle errors" | "Return structured JSON with error code and message for all HTTP 4xx/5xx" |
| "Clean up the code" | "Extract repeated logic into shared functions, remove dead code, pass existing tests" |
| "Support users" | "Handle up to 10K concurrent users with p99 latency under 1s" |

## Compactness

- If the task is simple, the refined prompt should stay compact.
- Only expand when precision materially affects execution quality.
- Remove filler words, hedging, and repeated constraints.
