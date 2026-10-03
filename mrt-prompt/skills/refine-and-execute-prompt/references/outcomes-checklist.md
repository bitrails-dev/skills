# Outcomes Checklist

## Refined Prompt

- [ ] Clear objective stated in one sentence
- [ ] Scope defined (included and excluded)
- [ ] Explicit inputs and outputs
- [ ] Success criteria included and measurable
- [ ] No unnecessary assumptions
- [ ] Vague language converted to actionable instructions

## Each Agent Output

- [ ] Assigned sub-task completed
- [ ] All constraints followed
- [ ] Outcomes are measurable and verified
- [ ] Self-verification report included
- [ ] Independent verifier report completed
- [ ] Issues from verification resolved

## Parallel Execution

- [ ] No more than `max parallel agents` running at once
- [ ] Only independent sub-tasks ran in parallel
- [ ] Dependent sub-tasks ran sequentially after dependencies completed

## Final Output

- [ ] All verified sub-results merged
- [ ] No unresolved contradictions
- [ ] Key assumptions documented
- [ ] Verification summary included (passes, failures, fixes)
- [ ] Ready for direct use or downstream execution
- [ ] Concise enough for practical use

## Overall Run Success

A skill run is successful when ALL of the following are true:

1. Original user intent is preserved
2. Ambiguity is measurably reduced
3. Refined prompt is more actionable than the input
4. Every sub-task has explicit success criteria
5. Parallel limit was never exceeded
6. Every agent output includes self-verification
7. Every agent output received independent verification
8. Final answer is internally consistent
9. Final answer is ready for direct execution
