# Spec 4b — Federal withholding at the source of a retirement distribution

Status: **proposed, not applied.** Written 2026-08-01.
Predictions in §6 are recorded *before* implementation so the run can be checked
against them rather than blessed after the fact.

---

## 1. The problem

Income tax is the only obligation in the engine with no routing layer. Every
other money movement consults the asset's own `fundTransfers` first and falls
back to `resolveFunding()`; income tax goes straight to the backstop at
[tax-engine.js:315](../js/engines/tax-engine.js) and
[tax-engine.js:380](../js/engines/tax-engine.js).

The consequence, measured on a real shared portfolio (single filer, retires at
57, $959k IRA / $660k brokerage / $13,250 savings):

| 2026 taxable income | Amount | Share | Backstop-eligible? |
|---|---:|---:|---|
| IRA distributions | $53,796 | 77.5% | **No** |
| Brokerage (dividends + gains) | $14,449 | 20.8% | Yes |
| Treasuries interest | $943 | 1.4% | Yes |
| Savings interest | $270 | 0.4% | Yes |
| **Total** | **$69,458** | | |

Savings generated 0.4% of the household's taxable income and paid **100%** of
the tax on it — $13,753.01 across 2026-05 → 2027-12 — and was emptied in
December 2027. Nobody chose that; it is the default falling out of
`resolveFunding()` returning the first liquid account.

Reallocating the tax proportionally across *eligible* income generators
(spec 4a) fixes only 22.3% of it, because the dominant 77% comes from IRA
distributions and `FUNDING_BACKSTOP_PRIORITY` deliberately excludes retirement
accounts from implicit drafting.

**The missing mechanism is withholding at the source.** When a custodian pays an
IRA distribution they ask how much to withhold for federal tax and remit it. The
engine distributes exactly the obligation and lets the tax land elsewhere.

## 2. The machinery already exists

`ExpenseEngine.calculateGrossWithdrawal`
([expense-engine.js:381](../js/engines/expense-engine.js)) already implements the
gross-up:

```js
// 3. Apply the Gross-Up Formula: W = X / (1 - (t * g))
const denominator = 1.0 - (ltcgRate * gainRatio);
```

Two limits keep it from covering this case:

1. **It returns early for non-taxable accounts.** `if
   (!InstrumentType.isTaxableAccount(...)) return netShortfall.copy();` — a
   tax-deferred account falls into that branch and is never grossed up.
2. **It is only called on the backstop path** (INSERTION POINTs 1 and 2,
   [expense-engine.js:90](../js/engines/expense-engine.js) and
   [:115](../js/engines/expense-engine.js)) — not on the explicit fund-transfer
   loop at [:54–78](../js/engines/expense-engine.js), which is where the IRA's
   $53,796/yr actually leaves.

For a tax-deferred account the same formula applies with different parameters:
the entire distribution is ordinary income, so the gain ratio **g = 1.0**, and
`t` is the withholding rate. `W = X / (1 − 0.10 × 1.0) = X / 0.9`. No new
arithmetic — an existing formula reaching a case it currently skips.

This also **breaks the death-spiral the surrounding comments guard against**: a
flat rate is not a function of the resulting liability, so there is no feedback
loop inside the withholding itself. The extra taxable income is picked up by the
next monthly true-up, which recomputes on actuals.

## 3. The change

### 3.1 Rate

A single constant, tax-deferred instruments only:

```js
/**
 * Federal withholding on a traditional IRA / 401(K) distribution.
 *
 * 10% mirrors the default a custodian applies when the account holder makes no
 * election (Form W-4R). The rate governs ATTRIBUTION, not correctness: the
 * monthly and annual true-ups reconcile any over- or under-withholding in
 * either direction, so a wrong rate misplaces cash between accounts but never
 * changes the household's total tax.
 *
 * Flat by design — a rate derived from the resulting liability would reintroduce
 * the gross-up feedback loop that calculateGrossWithdrawal comments warn about.
 */
export const RETIREMENT_WITHHOLDING_RATE = 0.10;
```

**Roth must withhold nothing.** `recordDistribution` routes Roth on the same
path ([model-asset.js:835](../js/model-asset.js)), so the guard must be
`InstrumentType.isTaxDeferred(...)`, never "is a retirement account." Getting
this wrong taxes tax-free money and no current test would notice.

`TAX_DEFERRED` is exactly `{IRA, FOUR_01K}`
([instrument.js:76](../js/instruments/instrument.js)) — precisely this spec's
scope, so the predicate needs no widening and no parallel set.

The 401(K) treatment is worth confirming before it is encoded: the mandatory-20%
rule applies to *eligible rollover distributions*, which this engine does not
model. 10% is probably correct for periodic withdrawals, but that should be
checked rather than assumed.

### 3.2 Shape: withhold-after, not gross-up-in-place

Rewriting each draw to `X/(1−r)` would change how obligation amounts are
computed at six sites. The arithmetically identical, far less invasive form:

1. Fund the obligation in full — **existing behaviour, untouched**.
2. Debit the same account `W = X × r/(1−r)` as withholding.
3. Record `W` as a distribution too, so taxable income equals the gross.

`X + W = X/(1−r)`. Same money, same taxable income, but no obligation math
moves, and step 2's debit inherits the existing clamp/spillover machinery — if
the IRA is empty, the withholding spills like anything else.

### 3.3 Event type and reconciliation

Emit `EventType.INCOME_TAX_WITHHOLDING`. It already exists and is already
declared `'incomeTax'` in `EVENT_RECONCILIATION`
([portfolio.js:53](../js/portfolio.js)), so this adds **no new event type and no
new reconciliation declaration** — the surface that throws on an undeclared type
is untouched.

Do not reuse `GROSS_UP` (bucket `'oneSided'`). It means "expense grossed up for
capital-gains tax on a backstop draw"; overloading it would make the two
indistinguishable in the ledger.

The withheld amount must also be added to `this.monthly.incomeTax` so the
monthly true-up counts it as already collected. Without that, the true-up
collects the same tax twice.

### 3.4 Call sites

Six places draw from deferred accounts:

| Site | Path |
|---|---|
| [expense-engine.js:72](../js/engines/expense-engine.js) | **the big one** — living expenses, $53,796/yr |
| [expense-engine.js:308](../js/engines/expense-engine.js) | direct metric write |
| [rebalance-engine.js:138](../js/engines/rebalance-engine.js) | rebalancing |
| [tax-engine.js:228](../js/engines/tax-engine.js) / [:253](../js/engines/tax-engine.js) | close distributions |
| [fund-transfer.js:240](../js/fund-transfer.js) / [:260](../js/fund-transfer.js) | `settleOneSided` + spillover |

`recordDistribution` is the chokepoint for four of them but is a pure metric
writer on `ModelAsset` with no access to `this.monthly`; putting a debit and a
tax booking there is a layering violation. The honest shape is
`TaxEngine.withholdOnDistribution(asset, net)` called after each
`recordDistribution`.

**Six call sites means one can be missed silently** — the failure mode that let
two of four provenance tags stay inverted with a green suite. See §7.

## 4. What this does not fix

**Scope is IRA and 401(K) only.** Pension was briefly added and removed on
2026-08-02 — see §4.1 for what that surfaced, which is worth keeping even though
the scope is not.

**Social Security and Pension both stay out.** Three reasons, in order:

1. **Different mechanism.** `RetirementIncomeBehavior` and `PensionBehavior`
   ([instrument-behavior.js:116](../js/instruments/instrument-behavior.js),
   [:148](../js/instruments/instrument-behavior.js)) are *flows*, not balances:
   they book income from `finishCurrency` and add to `netIncomeCurrency`, with no
   account to debit, no `recordDistribution`, and nothing to gross up. §3.2's
   withhold-after shape does not apply — these need withhold-*on-arrival*, a
   second mechanism this spec does not build.
2. **Social Security's rate is elective**, 7/10/12/22% via Form W-4V, with no
   default. There is no equivalent of "what your custodian does when you say
   nothing," so a non-optional rate would be inventing policy rather than
   mirroring it. Pension does have a default (W-4P), so this reason applies to
   SS alone.
3. **Social Security's taxable base is already wrong.** The engine applies a flat
   85% (open finding, 2026-07-25 code review). Withholding against a base known
   to be wrong compounds two errors.

At 21% of taxable income by 2035 ($31,836 in this portfolio) Social Security is
worth revisiting — **after** the inclusion ratio is settled.

### 4.1 If pension is added later

Kept because it was established and would otherwise be re-derived:

| | IRA / 401(K) — this spec | Pension — if added |
|---|---|---|
| Shape | balance debited to fund an obligation | income credited on arrival |
| Withholding | withhold-**after**: extra debit of `X × r/(1−r)` | withhold-**on-arrival**: reduce what lands by `X × r` |
| Gross-up | required, so the obligation still nets `X` | none — the pension pays what it pays |
| Taxable income | gross = `X + W` | unchanged; `PENSION_INCOME` is already gross |

The two differ by ~11% of the withheld amount — small enough to read as
rounding, large enough to be wrong. Three specifics that cost real time to find:

- **`isTaxDeferred` would silently drop it.** `TAX_DEFERRED` is `{IRA, FOUR_01K}`;
  pension is an income instrument, so the predicate returns false and the whole
  path vanishes without error.
- **`PensionBehavior.relevantMetrics()` has no tax metrics at all** — not
  `WITHHELD_INCOME_TAX`, and not the `INCOME_TAX → FEDERAL_TAXES → TAXES` chain
  that `CapitalBehavior` carries. Without adding them the withholding is booked
  and invisible.
- **Where pension income sweeps to was never traced.** `netIncomeCurrency` is
  consumed downstream, likely the `resolveFunding` sweep at
  [payroll-engine.js:505](../js/engines/payroll-engine.js). Withholding must
  happen on the way, not after.
- The comment at [metric.js:167–170](../js/metric.js) — "Retirement income
  (pension, Social Security) has no per-asset tax leaf" — **stays true** under
  this spec's scope, and would be falsified by adding pension.

## 5. Interaction with spec 4a

4b shrinks the residual that 4a allocates. Sequence 4b first: after withholding
covers 55% of the lifetime bill, the remaining backstop draw is small enough
that 4a's proportional split is a refinement rather than a rescue.

One consequence worth recording: **4a would change the premise of rule #2 in
[rule-notes.js](../js/rule-notes.js)** — "DON'T INVENT ALLOCATIONS. The household
tax true-up is deliberately not split across the incomes that caused it — that
number does not exist in the engine." After 4a the engine books that split, so
the number does exist and the prohibition no longer applies to it. That comment
must be updated in the same PR or it becomes a false statement about the code.

4b raises no such conflict: the withheld amount is booked per asset, so a note
describing it satisfies rule #1 (derive, never recompute).

**Comments to check against this PR** — neither is falsified at the current
scope, and both are listed so the next reader does not "fix" them:

| File | What it says today | Status under this spec |
|---|---|---|
| [metric.js:167–170](../js/metric.js) | "Retirement income (pension, Social Security) has no per-asset tax leaf... adding one means adding a writer too" | **Stays true.** It is scoped to the *retirement income* instruments, not to IRA/401(K), which are capital accounts. An earlier draft listed this as falsified — that was wrong, and only became visible when pension left scope. It *would* be falsified by §4.1. |
| [sim-event.js:184–191](../js/sim-event.js) | the memo vocabulary is byte-identical to the pre-module engine | **Stays true** — §8.1 changes no string. |

The one comment this PR *does* falsify belongs to spec 4a, not 4b: rule #2 in
[rule-notes.js](../js/rule-notes.js), above.

## 6. Predicted diff — recorded before implementation

Baseline: the shared portfolio above, 2026-05 → 2063-12, finish net worth
**$17,235,720.93**.

> **Scope note:** this portfolio holds no 401(K) — the deferred balance is a
> traditional IRA. The 401(K) path shares `CapitalBehavior` and
> `recordDistribution` with the IRA, so it is covered by construction rather than
> by this run; §7.1's structural test is what actually holds it.

### 6.1 Withholding coverage (first-order, computed)

| Year | Distribution (net) | Withheld @10% | Total tax bill | Covered |
|---|---:|---:|---:|---:|
| 2026 | $53,796 | $5,977 | $3,969 | **151%** |
| 2027 | $83,134 | $9,237 | $9,784 | 94% |
| 2028 | $84,693 | $9,410 | $18,626 | 51% |
| 2035 | $96,937 | $10,771 | $19,018 | 57% |
| **Lifetime** | | **$253,980** | **$459,531** | **55%** |

### 6.2 Expected outcomes

| | Today | Predicted |
|---|---:|---:|
| Savings tax burden, 2026-05 → 2027-12 | −$13,753.01 | **+$2,008 refund, then ~$547** |
| Savings depletion | Dec 2027 | **survives** |
| `incomeTaxWithholding` event count | 452 | **~900+** |
| IRA depletion | 2048-09 | **~2045–2046** |
| First spillover year | 2048 ($36,747) | **~2045** |
| Finish net worth | $17,235,720.93 | **direction unknown — see below** |

2026 over-withholds, so `applyMonthlyTaxTrueUp` returns early at
[tax-engine.js:303](../js/engines/tax-engine.js) (`additionalTax >= 0`) and there
is **no backstop draw at all** that year; the annual true-up refunds ~$2,008 to
Savings.

### 6.3 The number I cannot predict

Finish net worth. Drawing ~11% more from the IRA each month pulls IRA depletion
forward 2–3 years, which pulls the entire spillover era forward with it. Whether
the terminal figure rises or falls depends on the interaction between earlier
brokerage drawdown and lower cumulative tax drag, and I will not guess a
direction.

**This is the number most likely to be blessed rather than checked.** It should
be recorded post-run and reconciled against a hand-built expectation, not
accepted because the suite is green.

### 6.4 Expected to be unchanged

- ~~Household **total** lifetime tax.~~ **This was the wrong invariant — retracted
  2026-08-03.** Total lifetime tax is *not* conservable, because withholding
  changes the withdrawal schedule and therefore how long the deferred account
  compounds. Measured: **−$39,277 (−6.9%)**.

  The conservable invariant is the **tax identity**: in every year, cash
  collected equals the liability the tax table computes from that year's income.
  That holds in both runs (§6.5), which is what distinguishes a smaller tax base
  from a collection leak. Asserting "total unchanged" would have failed a correct
  implementation and invited someone to "fix" it by breaking the gross-up.
- `TRANSFER + SPILLOVER(origin=paired) + UNFUNDED(origin=paired) === 0`.
- Roth distributions: zero withholding, zero tax.

### 6.5 Proving the −6.9% is a consequence, not a leak

Run 2026-08-03. Three experiments, because "my reasoning is sound" is not
evidence and the golden masters cannot be re-blessed on it.

**1. Neutrality — the change is inert at rate 0.**
Set `global_retirement_withholding_rate = 0.0` and re-run: **all 14,053 events
byte-identical to baseline**, finish net worth identical to the cent
($17,235,720.94). Nothing reaches the model except through the withholding path,
so no side effect can be hiding elsewhere.

**2. Tax identity — collected still equals liability.**
For each year, snapshot the yearly package *before* the true-up settles it and
recompute the liability independently through the public tax API
(`calculateYearlyTaxableIncome` → `calculateYearlyIncomeTax` +
`calculateYearlyLongTermCapitalGainsTax`). Compare against cash actually
collected (withholding + true-up + capital-gains events):

| | Baseline | With withholding |
|---|---:|---:|
| liability, recomputed | $569,610 | $533,395 |
| tax collected | $569,205 | $529,928 |
| residual | −$405 | −$3,467 |

Both runs collect what they owe. **The liability itself fell** — this is not a
collection failure.

**3. Attribution — the whole drop is a smaller base.**

| | Baseline | With withholding | Δ |
|---|---:|---:|---:|
| lifetime IRA distributions | $2,205,391 | $1,914,588 | **−$290,803** |
| lifetime taxable income | $2,090,667 | $1,800,604 | **−$290,063** |
| liability | $569,610 | $533,395 | −$36,215 |

The taxable-income decline is matched 1:1 by lower IRA distributions, and
−$36,215 on −$290,063 of base is a 12.5% effective rate — ordinary for this
income. The IRA starts at $959,000 and ends at $0 in *both* runs; it simply
compounds for 3.75 fewer years, so it never generates that last $290,803 of
ordinary income. Paying an account's tax from itself exhausts it sooner. That is
the intended effect, and the lower lifetime tax is its arithmetic shadow.

### 6.6 The residual, investigated and closed

The −$3,467 above was not spread across years; per-year measurement put all of it
in exactly two. **Residual is now $0.00 — lifetime liability $556,462 equals
lifetime collected $556,462, with no year off by more than $2.**

**2043: −$796 was a measurement artifact.** When the IRA depletes, the
withholding sweep's shortfall is re-sourced from the backstop and booked as a
`SPILLOVER` event, not an `incomeTaxWithholding` one — so the verification script
did not count cash that had genuinely moved. Real fix, in the ledger rather than
the script: `SPILLOVER` now carries `cause`, naming the obligation it settled.
Without it every one-sided spill reads alike and a paid tax bill is
indistinguishable from an unpaid one.

**2029: −$2,671 was a real, pre-existing bug in `applyAnnualTaxTrueUp`.**
The underpayment branch used a raw `debit()` and **discarded the returned
spillover**, then booked `ESTIMATED_INCOME_TAX` for the full bill. Probed: the
April 2029 bill asked Savings for $3,462.57 against a $791.98 balance and
silently "collected" the missing $2,670.59 — tax booked as paid that never left
any account.

This is precisely the failure the *monthly* true-up documents and solves at
[tax-engine.js:324](../js/engines/tax-engine.js) — "a raw debit books the tax as
paid no matter what the account actually held." The monthly path was fixed; the
annual path was missed. Now routed through `settleOneSided` the same way: Savings
pays its $791.98, Brokerage covers the $2,670.59, each leg booked against the
account that supplied it.

**Present in the baseline too** (−$405 in 2027), so it is not caused by
withholding — withholding only moved *when* an account depletes, which changed
which year the bug bit and made it 6.6× larger.

### 6.7 Consequence for the neutrality proof

§6.5's test no longer holds for the PR as a whole, and that is expected: the
branch now contains **two** changes, only one of which is rate-gated.

Re-run at rate 0 against the original baseline: **698 events byte-identical up to
2027-12**, then a single root divergence —
`Brokerage | spillover | 2027-12 | −$405.21`, the tax the old annual true-up
failed to collect. Every one of the 4,853 downstream differences compounds from
that one $405.21.

So: the **withholding feature is still provably inert at rate 0**; the branch is
not, because it also fixes a real bug. **These should be two commits** so each is
independently reviewable and the neutrality argument stays clean.

## 7. Tests

The load-bearing test is structural, not a value check:

1. **Every distribution withholds.** For every month in which an asset's
   `TRAD_IRA_DISTRIBUTION` or `FOUR_01K_DISTRIBUTION` increases, that same asset
   has an `INCOME_TAX_WITHHOLDING` event in that month equal to 1/9 of the
   distribution. *Mutation: delete any one of the six call sites → must fail.*
   "Withholding happened somewhere" cannot catch a missed site.
2. **Roth withholds nothing.** A Roth-funded expense produces zero
   `INCOME_TAX_WITHHOLDING`. *Mutation: relax the guard to `isRothIRA ||
   isTaxDeferred` → must fail.*
3. **Total tax is conserved.** Lifetime household tax with and without
   withholding differs by less than rounding. *Mutation: drop the
   `monthly.incomeTax.add(withheld)` line → the true-up double-collects → must
   fail.*
4. **Over-withholding refunds.** A year where withholding exceeds liability
   produces a `TAX_TRUE_UP` with `direction: 'refund'` and no monthly backstop
   draw.
5. **Withholding on a depleted account spills.** An IRA with less than `W`
   remaining routes the shortfall to the backstop and conservation still holds.
6. **Rate is one constant.** *Mutation: change `RETIREMENT_WITHHOLDING_RATE` to
   0.15 → at least one test must fail.* If none does, the rate is unobserved.
7. **The tax identity holds** — per §6.4, this replaces the retracted
   "total tax unchanged" check. For every year, cash collected (withholding +
   true-up + capital-gains events) equals the liability recomputed independently
   from that year's income package. *Mutation: book the withholding without
   adding it to `monthly.incomeTax` → the true-up double-collects → collected
   exceeds liability → must fail.* This is the check that catches a
   double-collection both legs would otherwise report happily.
7b. **Neutrality at rate 0.** With `global_retirement_withholding_rate = 0`, a
   run is event-for-event identical to one with the feature absent. *Mutation:
   any unguarded side effect — a metric written before the rate check, a
   distribution booked regardless — breaks it.* This is the cheapest possible
   proof that the feature cannot affect a plan that does not use it, and it is
   what licenses re-blessing the golden masters.
8. **The memo text did NOT change.** Every `INCOME_TAX_WITHHOLDING` memo still
   reads exactly `'Income tax withholding'`, and `tests/memo-vocabulary.mjs`
   passes **unmodified**. *Mutation: alter the `renderNote` case → must fail.*
   This test guards a deliberate non-change, which is otherwise the easiest
   thing in the spec for a later PR to undo by accident.
8b. **Provenance rides in `data`, not the text.** A distribution withholding
   event carries `data.rate` and `data.source === 'distribution'`; a household
   true-up draw carries neither. *Mutation: drop the `data` payload → the rule
   note in §8.3 loses its input → must fail.* Assert on the SimEvent, never by
   parsing the note.
9. **The asset view shows the tax.** For an IRA with distributions in the
   window, `CapitalBehavior.relevantMetrics()` includes `WITHHELD_INCOME_TAX`
   *and* the asset's history for it is non-zero — both halves, since either
   alone renders no row. *Mutation: remove the metric from
   `relevantMetrics()` → must fail.* Asserting the metric merely exists on the
   ModelAsset does not test that it is reachable in the UI; that gap is what let
   the `property-groups.js` mistake in §8.2 look correct.
10. **The Sankey still sees the withholding.** Distribution withholding reaches
    `Sink_IncomeTax` in `graph-mapper` — which it does for free, since §8.1 keeps
    the string identical. *Mutation: change the memo text → the memo falls
    through every branch and vanishes from the graph → must fail.* Nothing
    throws when this breaks, so only an assertion catches it. This is the
    concrete reason the no-change decision is load-bearing rather than merely
    conservative.
11. **A 401(K) behaves like the IRA.** A fixture with a `FOUR_01K` funding an
    expense withholds identically and books `FOUR_01K_DISTRIBUTION`. *Mutation:
    narrow the guard to `isIRA` → must fail.* The reference portfolio has no
    401(K), so nothing else covers this.
12. **Pension and Social Security withhold nothing.** A plan with a pension or SS
    asset produces zero `INCOME_TAX_WITHHOLDING` on it. *Mutation: widen the
    guard to include either → must fail.* This pins the §4 scope decision so a
    later reader cannot quietly widen it without the on-arrival mechanism §4.1
    describes.

## 8. Announcing the rule — three surfaces

The rule is non-optional and has no UI, which by this project's own standard
makes it indistinguishable from a bug unless it announces itself. One rule note
is not enough: a user looking at a shrinking IRA will look at the **IRA**, not at
a notes panel. The withholding must be visible where the money left.

Three surfaces, each answering a different question.

### 8.1 Credit memo — DECIDED: no text change

**Decision (2026-08-02): the memo string does not change.** Every
`INCOME_TAX_WITHHOLDING` event keeps rendering `'Income tax withholding'`
([sim-event.js:214](../js/sim-event.js)).

Rationale: the matchers below are brittle by construction, and a wording change
is a separate deliberate PR — not something to ride along with an engine change.

| Consumer | Match | Effect of a new string |
|---|---|---|
| [graph-mapper.js:186](../js/graph-mapper.js) | `memo.note === 'Income tax withholding'` | falls through every branch, **silently vanishes** from the Sankey |
| [portfolio.js:102](../js/portfolio.js) | `MEMO_RECONCILIATION[...]` | dead except for the test below |
| [tests/memo-vocabulary.mjs](../tests/memo-vocabulary.mjs) | asserts both directions | fails until the string is registered |
| [tests/tax-sign-conservation.mjs:295](../tests/tax-sign-conservation.mjs) | `find(m => m.note === ...)` | may match the wrong memo |

Holding the string still means **none of these change**, which is the point.

#### Carry the provenance in `data`, not in the text

Keeping the wording identical does not require throwing the distinction away.
Emit the event with the rate in its data:

```js
modelAsset.recordEvent(EventType.INCOME_TAX_WITHHOLDING, withheld,
    { metric: Metric.WITHHELD_INCOME_TAX,
      data: { rate: RETIREMENT_WITHHOLDING_RATE, source: 'distribution' } });
```

`renderNote` ignores those fields, so the memo text is byte-identical and every
matcher above is untouched. But the **SimEvent** now distinguishes a
distribution withholding from a household true-up draw structurally rather than
lexically — which is what §8.3's rule note reads, and what any future consumer
should read.

This is the direction the CreditMemo → SimEvent work was already going: notes are
generated, never parsed. A cosmetic string stays frozen; the machine-readable
fact does not have to be.

**Accepted cost:** in the credit-memo *view*, a distribution withholding and a
household true-up draw look identical. Surfaces §8.2 and §8.3 carry the
explanation instead.

### 8.2 Asset view — "where did my IRA go?"

> ⚠️ **An earlier draft of this spec named the wrong file.** It proposed adding
> the metric to `PropertyGroup.RETIREMENT` in `property-groups.js`. That file is
> **dead code** — verified 2026-08-02, nothing imports it and the identifier
> `PropertyGroup` appears nowhere outside it, not even in tests. The change
> would have been one line, followed the file's own conventions, passed review,
> and altered nothing a user sees. Recorded here because it is the project's
> recurring failure mode in a new costume: not a test that passes wrongly, but a
> plausible edit to a module nobody loads.

The asset view is [asset-view-modal.js](../js/components/asset-view-modal.js),
and its row set comes from **`behavior.relevantMetrics()`**
([asset-view-modal.js:124](../js/components/asset-view-modal.js)), filtered to
metrics with a non-zero history somewhere in the plan.

IRA, 401(K), Roth and taxable equity all use `CapitalBehavior`
([instrument-behavior.js:436–438](../js/instruments/instrument-behavior.js)). Its
list already carries the full tax chain **and** the distributions:

```js
M.SHORT_TERM_CAPITAL_GAIN_TAX, M.LONG_TERM_CAPITAL_GAIN_TAX, M.ESTIMATED_INCOME_TAX,
M.INCOME_TAX, M.FEDERAL_TAXES, M.TAXES,
...
M.TRAD_IRA_DISTRIBUTION, M.ROTH_IRA_DISTRIBUTION, M.FOUR_01K_DISTRIBUTION,
```

`M.WITHHELD_INCOME_TAX` is the one link missing from that chain.
`WorkingIncomeBehavior` lists it ([:82](../js/instruments/instrument-behavior.js));
`CapitalBehavior` does not — which is correct today, since no capital account
ever books it, and becomes wrong the moment 4b does.

**The change: add `M.WITHHELD_INCOME_TAX` to `CapitalBehavior.relevantMetrics()`,
beside `M.ESTIMATED_INCOME_TAX`.**

Three properties fall out of the existing machinery rather than needing new code:

- **Nesting is automatic.** `_tree` ([asset-view-modal.js:149](../js/components/asset-view-modal.js))
  arranges rows by `MetricRollups`, and `WITHHELD_INCOME_TAX → INCOME_TAX`
  ([metric.js:172](../js/metric.js)) with `INCOME_TAX` already on screen. The row
  nests under Income Tax instead of floating as a root.
- **Roth and brokerage stay clean for free.** `_rows` drops any metric whose
  history is all zeros, so the line appears only on accounts that actually
  withheld. This is a display convenience, **not** the Roth guard — §3.1 still
  owns that, in the engine.
- **`aggregateMetric` sums it correctly.** `WITHHELD_INCOME_TAX` is a flow, so no
  `MetricKind` question arises (contrast: never sum a balance).

**No comment change is needed here.** An earlier draft claimed
[metric.js:167–170](../js/metric.js) would be falsified:

> Retirement income (pension, Social Security) has no per-asset tax leaf: its
> liability is settled by the monthly/annual true-up against the funding
> account, which books `ESTIMATED_INCOME_TAX` there. Adding one means adding a
> writer too — see `tax-engine.applyMonthlyTaxTrueUp`.

That was wrong. The comment is scoped to the *retirement income* instruments —
pension and Social Security — not to IRA/401(K), which are capital accounts on
`CapitalBehavior`. This spec adds a tax leaf to the capital accounts and leaves
the retirement-income ones untouched, so the sentence stays true.

Retained as a note because the mis-reading survived two passes and only became
visible when pension left scope. The comment *would* be falsified by §4.1.

### 8.3 Rule note — "why is this happening at all?"

The memo says what the line is; the asset view shows the amount. Neither can say
*this is a policy the engine applied on your behalf and you did not choose it* —
which is the only part a user might reasonably call a bug.

New descriptor in [rule-notes.js](../js/rule-notes.js):

> 📤 **Federal withholding** — 10% of each traditional IRA/401(K) distribution is
> withheld at the source, the same default a custodian applies when you make no
> election. In 2026 this withheld $5,977; your annual true-up refunded $2,008.

Obligations from that file's own rules:

- **Rule #1 (derive, never recompute).** Read the booked
  `WITHHELD_INCOME_TAX` total and the `TAX_TRUE_UP` amount. Do not recompute
  `rate × distribution` — that reconstructs the engine's arithmetic and would
  keep reporting a number even if the writer were deleted.
- **Rule #3 (resolve from history).** Take the rate from the recorded events,
  not from the current constant, or every historical month re-renders at
  whatever rate is configured today.
- **Rule #4 (silence is part of the contract).** Emit nothing when the asset had
  no deferred distribution in the window. Test the silence, not just the speech.

### 8.4 Why all three

Each surface fails alone. The memo is invisible unless you open the ledger. The
asset-view line shows a number with no cause. The rule note explains a policy but
sits away from the money. Together they answer "what," "how much," and "why" at
the three places a user actually looks — and the redundancy is the point: this is
a rule nobody opted into.

## 9. Not verified

- Whether all six distribution sites are reachable in this portfolio. Only
  `expense-engine.js:72` is confirmed exercised; the others are identified by
  reading, so §7.1 needs fixtures that actually reach each one.
- The 401(K) periodic-withdrawal rate (§3.1).
- Second-order effects on finish net worth (§6.3).
- Whether `settleOneSided`'s spillover path double-books a distribution when the
  withholding debit itself spills — worth tracing before implementation.
- ~~Whether adding the metric to `PropertyGroup.RETIREMENT` changes a header
  total.~~ **Resolved 2026-08-02:** moot — that file is dead code. The live seam
  is `CapitalBehavior.relevantMetrics()`; see §8.2.
- ~~Whether anything outside the engine parses `'Income tax withholding'`.~~
  **Resolved 2026-08-02:** three consumers, one of which (`graph-mapper.js`)
  fails silently. See §8.1.
- Whether the new asset-view row renders correctly in the modal — the reasoning
  in §8.2 is from `_rows`/`_tree` and `MetricRollups`, **not** from rendering it.
  This is the same class of claim that produced the `property-groups.js` error,
  so it should be confirmed in the browser, not argued from source.
- The 401(K) periodic-withdrawal rate (§3.1) — the mandatory-20% rule applies to
  eligible rollover distributions, which this engine does not model, so 10% is
  probably right but was not confirmed.
