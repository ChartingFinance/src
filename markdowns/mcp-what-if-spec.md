# Spec 7 — What-if over MCP: `adjust_plan` and `compare_plans`

**Status: specification only. No code.**

PRs #33 and #34 gave the MCP surface *what happened* and *why*. It still cannot
answer *what if*. This is the design for that, and for why it is being designed
here rather than in the app.

---

## 1. Why here, and why now

The what-if library has been parked since 2026-07-13 under one guardrail:

> Must be a designed *family* of possibilities with a real comparison UX — a
> single hardcoded alternative is a one-shot feature and off the table.

That guardrail is the reason to do this over MCP **first**, not a reason to
avoid it. The parked risk was a one-off bolted on without a comparison story.
An MCP surface has no pixels, so it cannot smuggle in a one-off: it forces the
*adjustment vocabulary* and the *comparison semantics* to be named explicitly
and independently of any UI.

If the vocabulary is right, the app's intended ghost-overlay compare (the T3
"mission control" mockup) is built on top of it later. If it is wrong, we find
out for the cost of a JSON schema rather than a design pass.

**This spec builds the machinery, not the curated library.** The library — claim
Social Security at 62/67/70, retire ± N years, rent vs. buy — is still a separate
design pass, and still needs the app's compare UX. Nothing here pre-empts it.

---

## 2. THE BLOCKING PRECONDITION: `retire_at` is incoherent today

`retire_at` is the flagship adjustment and the reason the whole feature is
interesting. It does not currently work on an arbitrary plan, and no amount of
tooling fixes that.

**Life events are age-relative.** `ModelLifeEvent` stores `triggerAge`, and
`triggerDateInt` derives the date at read time from `global_user_startAge`
(`life-event.js:99`). Changing a retirement age moves the phase boundary
immediately and correctly.

**Assets carry absolute dates.** A salary has `finishDateInt: 2048-01`. It does
not move when the retire event's `triggerAge` changes.

Quick Start only *appears* to work because `dateAnchors()` computes both from the
same ages at build time. Feed in a portfolio the user built by hand — which is
the whole point of `run_plan` — and `retire_at(62)` produces:

- the Retire phase beginning at 62, activating drawdown transfers, and
- a salary still paying income until 2048,

simultaneously. That is not a pessimistic plan or an optimistic plan. It is an
incoherent one, and it would be reported with the same confidence as any other.

### P0 — resolve the date-anchoring asymmetry before any adjustment code

Three candidate answers, in preference order:

1. **Adjustment-scoped retargeting.** `retire_at` moves the trigger age *and*
   retargets assets whose finish date coincides with the old boundary. Requires
   defining "coincides" — exact match on the old trigger date is the honest
   version, and it must be conservative: an asset that does not match is left
   alone and **reported as unmoved**, never silently dragged.
2. **Age-relative asset dates.** Assets grow an optional `finishAtAge`. Correct,
   and a schema migration across every stored portfolio and share URL.
3. **Refuse.** `retire_at` is rejected on plans whose assets do not line up with
   the current boundary, with a message naming them.

(3) is not a cop-out and may be the right first shipment: it is honest, it is
cheap, and it converts a silent incoherence into a clear refusal. (1) is the
target. **P0 must be settled before Step 1.**

---

## 3. The two nouns

### 3.1 An Adjustment is typed, never a JSON patch

A free-form patch over the plan spec is the obvious design and the wrong one.
It is unreviewable, it cannot be named in a comparison, and it can express
states the app itself cannot produce — which breaks the round-trip that makes
the share format worth reusing.

Every adjustment must satisfy three tests:

- **Expressible**: a user could make this change in the app's UI.
- **Nameable**: it renders as one phrase, because a comparison is meaningless
  without its cause (§5.1).
- **Reversible**: applying it to a plan and back is identity.

Proposed vocabulary:

| Adjustment | Shape | Notes |
| :--- | :--- | :--- |
| `retire_at` | `{ age }` | Blocked on P0. |
| `set_return_rate` | `{ asset, rate }` | Per-asset ARR. |
| `set_inflation` | `{ rate }` | Global. |
| `set_expense` | `{ asset, monthlyAmount }` | Existing expense assets only. |
| `set_transfer` | `{ from, to, phase, percent }` | The contribution/drawdown lever. |
| `set_filing_status` | `{ status }` | Selects the whole tax table set. |
| `set_finish_age` | `{ age }` | Longevity. Extends the run. |
| `set_guardrails` | `{ withdrawalRate, preservation, prosperity, adjustment }` | |

Deliberately absent: anything touching Monte Carlo, backtest year, or the
Maximizer. See §7.

### 3.2 A Comparison is a decision, not a diff

Two 30-year runs differ across ~666 months × N assets × 30 metrics. Emitting
that is not a comparison, it is a data dump that an LLM will summarise by
picking whichever number it happened to read first.

---

## 4. HARD CONSTRAINT: adjustments never create or delete assets

This is inherited, not invented. Only the user creates or removes assets; the
system advises and the user decides. Automatic asset mutation previously caused
duplicate assets on recalculation, phantom assets that could not be deleted, and
state leaking into localStorage.

**What this rules out.** "What if I bought a rental property?" cannot be an
adjustment. Neither can "what if I dropped this account?"

**What MCP does instead.** It answers advisorily: *"That comparison needs a Real
Estate asset and a Mortgage this plan does not have. Add them in the app and run
`compare_plans` again."* The advisory path is the established pattern for a
missing instrument, and it applies here unchanged.

**What remains permitted** is every adjustment in §3.1 — each mutates an object
that already exists, which is exactly the line life events already observe: they
may close assets, rewire transfers and change behaviour, but never add or remove.

---

## 5. Derivation, never mutation

`adjust_plan(handle, adjustments[])` runs a **new** plan and returns a **new**
handle. The base run is never modified.

That gives every derived plan a lineage:

```
plan_1  Mid Career, as built
  └─ plan_2  retire_at(62)
       └─ plan_3  retire_at(62) + set_return_rate(Brokerage, 6%)
```

The lineage is not decoration — it is the provenance that §5.1 requires.

### 5.0 Consequence: the run cache is now too small

`MAX_CACHED_RUNS` is 4 (`run-plan.js`), chosen when runs were independent. A
three-deep lineage plus the base is already at the limit, and evicting a base
plan silently breaks the comparison that depends on it.

**Required change**: eviction must not drop a run that is an ancestor of a live
run, or the cap must be raised with the memory cost measured. A 666-month plan
holds tens of thousands of events and scopes; this is a real budget, not a
formality. Measure before choosing.

### 5.1 What `compare_plans` returns

In priority order, because the order is the message:

1. **Did the failure mode change?** The single most decision-relevant fact
   available. `detectIssues()` already produces findings in user language;
   diffing them by `id` + `assetName` yields *resolved*, *introduced*, and
   *unchanged*. "Plan B does not run out of money" is the answer to the
   question actually being asked, and it is a *categorical* change, not a delta.
2. **The provenance.** The adjustment list, in words. A comparison without its
   cause is a pair of numbers.
3. **Headline deltas.** Ending net worth, nominal **and** real. Real matters
   more here than anywhere else in the tool: a longer plan ends with a bigger
   nominal number almost by construction.
4. **Divergence point.** The first month the two runs differ by more than a
   stated threshold. Answers "when does this decision start to matter?"
5. **Lifetime totals.** Tax paid, contributions made, distributions taken.
6. **What was NOT compared.** Explicitly. See §6.

---

## 6. A delta smaller than a known bias is noise

`compare_plans` inherits every modelling gap the engine has, and a comparison
amplifies the ones that are *asymmetric* between the two plans. This section is
the reason this spec exists rather than a pull request.

| Known gap | What it does to a comparison |
| :--- | :--- |
| **No early-withdrawal penalty** (no 10%, no concept of 59½) | Biases **`retire_at` specifically** — the flagship adjustment. Every "retire earlier" comparison is systematically optimistic by an amount that grows with how early. |
| **`asMonthly()` is rate/12** | A stated 8.5% realizes 8.839%. Comparing 8.5% against 8.6% is comparing two numbers that are both wrong by more than the gap between them. |
| **Social Security flat 85%** | Biases any comparison that shifts the ratio of benefit income to other income — which `retire_at` does. |
| **Shared SS wage base (MFJ)** | Biases `set_filing_status` for two high earners. |
| **Tax Year is inert** | No comparison can be run "under 2025 rules vs 2026 rules". Rejecting that request is required. |

**The rule this implies**: `compare_plans` must not present a delta without
naming the gaps that bias *that specific comparison*. A `retire_at` comparison
carries the early-withdrawal caveat inline, not in a footnote — an agent will
summarise the number and drop the footnote, and the omission becomes advice.

Mechanically: each adjustment type declares the caveats it triggers, and the
comparison output unions them. This is the same shape as `EVENT_RECONCILIATION`
keying on event type and throwing on an undeclared one — a new adjustment
without a declared caveat set should fail loudly, not default to silence.

---

## 7. Preconditions

Ordered; each must hold before the step that depends on it.

- **P0 — the date-anchoring asymmetry is resolved (§2).** Blocks everything.
- **P1 — determinism.** The same spec run twice must produce byte-identical
  results. If it does not, `compare_plans` reports noise as signal. Assert it
  directly: run one spec twice, compare total state. The snapshot harness
  already knows how to do this.
- **P2 — round-trip.** Every adjustment output must be a valid share-format
  plan the app can import. Otherwise MCP grows a dialect and the reuse argument
  in §3.1 collapses.
- **P3 — mutation-verified application.** Each adjustment must be proven to
  change the answer: apply it, assert the outcome moved, and mutate the
  application to a no-op to confirm the assertion bites. A `set_return_rate`
  that silently fails to apply produces a comparison showing "no difference",
  which reads as a finding.
- **P4 — Monte Carlo is out of scope.** It is stochastic; comparing two fans is
  a different problem (percentiles of differences are not differences of
  percentiles — the same trap already documented in `mc-compute.js`). Reject
  the request rather than compare one sampled run against another.

---

## 8. Sequencing

| Step | Deliverable | Gate |
| :--- | :--- | :--- |
| 0 | Resolve P0; assert P1 determinism | Blocking |
| 1 | Adjustment vocabulary + `applyAdjustments()`, no MCP tool | P0, P1 |
| 2 | Lineage-aware run cache (§5.0) | P3 |
| 3 | `adjust_plan` tool | P2 |
| 4 | `comparePlans()` core — issue diff first (§5.1) | — |
| 5 | Caveat declaration + union (§6) | — |
| 6 | `compare_plans` tool + markdown | — |

Steps 1 and 4 are independently useful and independently testable. Step 4 needs
no MCP surface at all, which is the cheapest place to find out whether the
comparison shape is right.

---

## 9. Explicitly out of scope

- **Optimization.** No "you should retire at 64". The Maximizer explores that
  in-app under a human eye; handing an LLM a ranked list of life decisions is a
  different product with a different duty of care.
- **The curated what-if library.** This is the machinery. The family of
  scenarios and its compare UX remain a separate design pass.
- **Creating or deleting assets** (§4).
- **Monte Carlo and backtest comparisons** (P4).

---

## 10. Open questions

1. **P0's answer.** Refuse-first (cheap, honest) or retarget (correct, more
   design)? This is the one decision that shapes everything after it.
2. **Divergence threshold.** Absolute dollars, percent of net worth, or percent
   of the *difference at plan end*? The third is scale-free but harder to explain.
3. **Does `compare_plans` take two handles, or a handle plus adjustments?** Two
   handles is more general; handle-plus-adjustments is the question people
   actually ask and makes provenance automatic. Possibly both, with the second
   as sugar.
4. **How many plans can be compared at once?** Three-way ("62 vs 67 vs 70") is
   the natural shape for the eventual library, and it is materially harder to
   render than a pair. Deciding now avoids a rewrite.
