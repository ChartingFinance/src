# Snapshot baselines

**Generated files. Do not hand-edit them.** They are written by
`node tests/tools/snapshot.mjs --bless` and are meant to be read as diffs, not
as documents.

Each `.snap` is the complete recorded state of one simulated portfolio: every
asset's end state, every event with its causal chain, a digest of every metric
history, every monthly package, the deflator, guardrail snapshots and the
engine's own reconciliation verdict.

## Why they are committed

So that a pull request shows its behavioural change as reviewable text.

This project's expensive bugs have not been caught by assertions, because the
assertions were passing — a one-letter memo rename corrupted reconciliation
while 162 of them stayed green. A snapshot cannot be vacuous the same way: it
has no code path it forgot to look at.

A PR that claims "no behaviour change" and touches no baseline has proved it. A
PR that moves 4,000 lines of baseline has a conversation to have.

## The loop

```bash
node tests/tools/snapshot.mjs            # check — exits 1 on drift
git diff tests/baselines/                # what actually moved
node tests/tools/snapshot.mjs --bless    # accept it into the PR
```

Write the prediction down *before* the change, then check the diff against it.
That is the house rule, and this tool exists to make the second half cheap.

## Two files worth knowing

- `_coverage.snap` — which `EventType`s the corpus reaches. Anything under
  **never emitted** is a branch no fixture touches, so every assertion about it
  is currently vacuous. That list growing is a regression in the tests even when
  every suite is green.
- `tests/tools/fixtures.mjs` — the corpus, with a `reaches:` note on each entry
  saying which branch it exists to hit. Read it before deleting one.

## Drift is not automatically failure

It is the diff of your change. Either it is what you predicted, or you have
learned something. Both are fine; blessing without reading is not.
