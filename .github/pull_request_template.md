<!-- Thanks for the PR! Keep it focused — one concern per PR reviews faster. -->

## What & why

<!-- What does this change, and why is it better? For anything beyond a small
     fix, link the issue where the approach was agreed (see CONTRIBUTING.md). -->

## Checklist

- [ ] `npm test` passes
- [ ] `npx tsc --noEmit -p packages/bridge` is clean
- [ ] Added/updated a test for any behavior change
- [ ] Diff is focused (no unrelated churn)
- [ ] If this touches the permission path (`decisions.ts`, hooks, delivery),
      I've called that out below and preserved the invariants in `SECURITY.md`

## Notes for the reviewer

<!-- Anything surprising, any invariant touched, anything you're unsure about. -->
