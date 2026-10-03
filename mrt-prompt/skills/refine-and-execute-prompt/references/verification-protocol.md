# Verification Protocol

## Two-Pass Verification

Every produced artifact is verified twice:

1. **Self-verification** — The producing agent checks its own work.
2. **Independent verification** — A separate agent reviews the work.

## Self-Verification Checklist

Each agent includes this in its output:

```
## Self-Verification
- [ ] Output answers the assigned sub-task completely
- [ ] All constraints were followed
- [ ] Success criteria are measurable and satisfied
- [ ] Assumptions labeled as [ASSUMPTION]
- [ ] No gaps, contradictions, or unsupported speculation
- Issues found: {none or list with fixes applied}
```

## Independent Verification Checklist

The verifier agent checks:

1. **Correctness**: Output is factually and logically sound.
2. **Completeness**: Nothing from the expected output is missing.
3. **Alignment**: Output matches the original prompt intent, not just the sub-task.
4. **Outcomes**: Measurable outcomes are actually met, not just claimed.
5. **Quality**: No weak assumptions, no speculation presented as fact.

## Verifier Report Format

```
## Verification Report
- Sub-task: {name}
- Status: PASS | FAIL
- Issues: {list or "none"}
- Fixes applied: {list or "none"}
- Remaining gaps: {list or "none"}
```

## Handling Failures

- If verifier returns FAIL with specific issues, fix the issues and re-verify.
- If a gap cannot be resolved, surface it explicitly in the final output.
- Never silently accept a failed verification.
