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

## 2. THE BLOCKING PRECONDITION: a portfolio does not reproduce across time

> **Scope note.** This section is *not* what-if work. It is a correctness defect
> in the engine that the what-if design happened to surface, and it is
> independently necessary — a portfolio that cannot reproduce itself cannot be
> compared against a variant of itself. If it is easier to land as its own spec,
> it should be. It is written here because this is where it was found.

### 2.1 The stated goal

> A portfolio is the minimum data necessary to communicate a constant timeline
> and its events — start values, finish values, and everything emitted between.
> Share it with someone and they see the same generation. Same for MCP.

That goal is achievable and the data format already supports it. Every premise
holds: start dates, finish dates, starting values and return rates are all
constant in a stored plan. The engine simply does not treat that data as its
only source of truth.

### 2.2 Measured, not argued

One frozen Mid Career spec, replayed under different wall clocks. Hashed over
the **full event stream** — the generation itself, not a summary figure:

| | clock 2026 | clock 2027 | clock 2029 |
| :--- | :--- | :--- | :--- |
| As saved | 12,282 events · `e3d775f4` | 12,508 · `655480cf` | 12,921 · `9f416bcb` |
| Life events stripped | 7,359 · `39e7fa6f` | 7,456 · `a7cb8421` | 7,650 · `2501e314` |

Ending net worth moved $4,659,211 → $5,299,247 across those three clocks:
**13.7%, from nothing but the calendar.**

### 2.3 Two leaks, one expression

**Leak 1 — phase boundaries.** `ModelLifeEvent` stores `triggerAge`;
`ageToDateInt` (`life-event.js:100`) resolves it at read time. The retirement
boundary slides one year per calendar year while assets stay put. Observed: the
salary ends 2048 under every clock, while the Retire phase starts 2048 → 2049 →
2051. By the 2029 clock there are three years in which the salary has ended but
the Retire phase has not begun — accumulation transfers still active with no
income, drawdown not yet started.

**Leak 2 — run length.** Six of the nine assets in a saved Mid Career spec carry
no `finishDateInt`, so `effectiveFinishDateInt` falls through to
`global_getFinishDateInt()`. The simulation ran to 2071-12 under a 2026 clock
and 2074-12 under a 2029 clock.

Both are the same expression, in three leaking sites — `globals.js:598`,
`globals.js:605`, `life-event.js:100`:

```js
birthYear = new Date().getFullYear() - global_user_startAge
```

One concept — *resolve an age to a date* — reaching for the wall clock instead
of for the plan. (`quick-start.js:20` uses the clock too, but legitimately: it
builds a NEW portfolio, where "today" is the right answer. `user.js:5` carries
the same expression as a fallback default, but see below — it is already
bypassed in practice.)

### 2.4 The anchor already exists, and one site already uses it

`portfolio.firstDateInt` is the earliest asset start date (`portfolio.js:1062`).
It is derived entirely from stored absolute dates and was **2026-08 under every
clock tested**.

The decisive detail: `Portfolio` **already anchors this way**, at
`portfolio.js:195`:

```js
const birthYear = this.firstDateInt ? this.firstDateInt.year - global_user_startAge : undefined;
this.activeUser = new User(global_user_startAge, birthYear);
```

So the User's age — and therefore RMD timing — is already resolved against the
plan rather than the clock, which is why `user.js:5`'s wall-clock default almost
never fires. **This is not a new idea to introduce; it is an existing pattern
three other sites failed to follow.**

That requires **no new field, no schema change, and no migration of existing
share URLs.**

The anchor is therefore **part of the portfolio's identity**. Adding an asset
that starts earlier than any existing one moves it and re-dates every phase —
which is the right answer, because a plan that now begins earlier is a different
plan. Decided 2026-08-08; see §10.1.

It also supersedes the three-option analysis this section previously carried:
"give assets an optional `finishAtAge`" was proposed to buy an anchor the data
already has. The remaining work is plumbing — `ageToDateInt` and
`ModelAsset.effectiveFinishDateInt` are module- and instance-level and do not
know their portfolio. That is the actual engineering, and it is the reason the
three sites diverged from `Portfolio` in the first place.

### P0 — re-anchor age resolution to the plan, not the clock

1. **Re-anchor (preferred).** The three leaking sites resolve against the plan's
   own first date, matching what `Portfolio` already does for the User. No
   migration. Fixes both leaks and makes `retire_at` coherent as a side effect,
   because the boundary and the assets finally share an origin.
2. **Refuse.** Reject `retire_at` where asset dates do not line up with the
   current boundary. Still worth having as a guard, but it addresses only the
   user-triggered symptom and leaves the calendar-triggered one running.

(1) is now clearly right; (2) is a useful diagnostic to keep alongside it. The
earlier preference for a refuse-first shipment was based on believing the
correct fix needed a migration. It does not.

**A consequence worth stating plainly:** until this lands, two people opening
the same shared portfolio in different calendar years see different plans, with
nothing signalling the divergence.

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

- **P0 — age resolution is re-anchored to the plan (§2).** Blocks everything.
- **P1 — determinism ACROSS CLOCKS.** The same spec must produce an identical
  **event stream** when replayed at different wall-clock times.

  The earlier wording — "run the same spec twice" — was inadequate and is worth
  keeping on the record as a lesson. It passes today, against every defect in
  §2, because two runs a second apart share a clock. A determinism assertion
  that does not vary the thing that actually varies asserts nothing.

  The assertion: replay one spec under several distinct fake clocks spanning a
  year boundary, hash the full event stream (asset, date, type, amount), and
  require the hashes to match. Totals are not sufficient — two different
  generations can land on similar end values, and the goal in §2.1 is about the
  events, not the endpoint.

  Note why the existing suites never caught this: `snapshot.mjs` **pins the
  clock**, and `fixtures.mjs` mandates no wall-clock reads. The test harness is
  deliberately immune to the exact thing production is exposed to. That was the
  right call for baseline stability and it is precisely why this needs its own
  assertion rather than a baseline.
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
| 0a | **Multi-clock determinism assertion, written FIRST and failing** (P1) | Blocking |
| 0b | Re-anchor age resolution to `firstDateInt` at all four sites (P0) | 0a red |
| 1 | Adjustment vocabulary + `applyAdjustments()`, no MCP tool | P0, P1 |
| 2 | Lineage-aware run cache (§5.0) | P3 |
| 3 | `adjust_plan` tool | P2 |
| 4 | `comparePlans()` core — issue diff first (§5.1) | — |
| 5 | Caveat declaration + union (§6) | — |
| 6 | `compare_plans` tool + markdown | — |

Steps 1 and 4 are independently useful and independently testable. Step 4 needs
no MCP surface at all, which is the cheapest place to find out whether the
comparison shape is right.

**0a before 0b, deliberately.** The assertion must be seen failing against
today's engine before the fix goes in — this codebase has repeatedly shipped
green suites that were asserting nothing, and a determinism test written after
its fix is indistinguishable from one that never worked. Predict the hashes
diverge, watch them diverge, then re-anchor and watch them converge.

**Step 0b changes simulation output**, so the 26 committed baselines must be
re-blessed. They are clock-pinned, so the diff should be *empty* — the fix
re-anchors to a date the pinned clock already agrees with. **An empty baseline
diff is the prediction.** If any baseline moves, the re-anchoring changed
something it should not have, and that is a finding, not a re-bless.

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

1. **Does P0 ship as its own spec?** It is now a reproducibility fix for stored
   and shared portfolios that what-if merely depends on — see the scope note in
   §2. Landing it separately would let it go in without waiting on any of the
   design questions below. *(The original form of this question — refuse-first
   or retarget? — is answered: re-anchor, per §2.4. It needs no migration, so
   the reason to prefer a cheaper shipment is gone.)*
   - *Follow-on — **RESOLVED 2026-08-08**: derive it, no explicit field.*
     `firstDateInt` is the earliest asset start date (`portfolio.js:1062`), so
     adding an asset that starts *earlier* than any existing one shifts the
     anchor and re-dates every phase. That is **correct behaviour, not drift**:
     a plan that now begins earlier is a different plan, and it should re-date.
     The anchor is part of the portfolio's identity, so an explicit
     `anchorDateInt` would only serve to preserve an origin the portfolio no
     longer has. Derived it stays — which is also what keeps §2.4's "no schema
     change" true.
2. **Divergence threshold.** Absolute dollars, percent of net worth, or percent
   of the *difference at plan end*? The third is scale-free but harder to explain.
3. **Does `compare_plans` take two handles, or a handle plus adjustments?** Two
   handles is more general; handle-plus-adjustments is the question people
   actually ask and makes provenance automatic. Possibly both, with the second
   as sugar.
4. **How many plans can be compared at once?** Three-way ("62 vs 67 vs 70") is
   the natural shape for the eventual library, and it is materially harder to
   render than a pair. Deciding now avoids a rewrite.
