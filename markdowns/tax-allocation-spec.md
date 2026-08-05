# Spec 4a — Proportional allocation of the residual household tax

Status: **proposed, not applied.** Written 2026-08-05.
Companion to [tax-withholding-spec.md](tax-withholding-spec.md) (spec 4b, shipped
2026-08-04, PR #23). Predictions in §7 are recorded *before* implementation so
the run can be checked against them rather than blessed after the fact.

---

## 1. What is left after 4b

4b withholds 10% at the source of an IRA/401(K) distribution, covering ~55% of
the lifetime federal bill on the reference portfolio. The remaining ~45% is
still settled by the monthly and annual true-ups, and both go **straight to the
funding backstop**:

| Site | Line | What it does today |
|---|---|---|
| `applyMonthlyTaxTrueUp` | [tax-engine.js:454](../js/engines/tax-engine.js) | `resolveFunding()` → one `settleOneSided` |
| `applyAnnualTaxTrueUp` (underpayment) | [tax-engine.js:519](../js/engines/tax-engine.js) | `resolveFunding()` → one `settleOneSided` |
| `applyAnnualTaxTrueUp` (spillover leg) | [tax-engine.js:554](../js/engines/tax-engine.js) | `resolveFunding()` again for the remainder |
| `applyAnnualTaxTrueUp` (refund) | [tax-engine.js:561](../js/engines/tax-engine.js) | `credit()` to the same first liquid account |

`resolveFunding` returns *the first open account with a positive balance* in
`cash → bank → brokerage → treasuries → corporate bonds` order
([fund-transfer.js:165](../js/fund-transfer.js)). On the reference portfolio
that is a $13,250 savings account, which generated **0.4%** of taxable income
and paid **100%** of the residual tax until it was emptied in December 2027.

Income tax remains the only obligation in the engine with no routing layer.
Property tax, 240 lines away in the same file
([tax-engine.js:212](../js/engines/tax-engine.js)), walks
`modelAsset.fundTransfers` first and hands only `remaining` to the backstop.
This spec gives income tax the middle tier that property tax gets for free.

## 2. The invariant this must not break

**An explicit fund transfer naming an IRA or 401(K) as its source stays
authoritative, unchanged, and is never second-guessed by this spec.**

That is already how the code behaves, and the mechanism is worth stating so the
implementation does not accidentally acquire a filter:

- The instrument restriction lives **only inside `resolveFunding()`**, which
  walks `InstrumentType.fundingBackstopPriority`
  ([fund-transfer.js:166](../js/fund-transfer.js)). The explicit-transfer loops
  apply no instrument test at all.
- `FUNDING_BACKSTOP` as a *set* is read in exactly three places outside that
  function, none of them routing: the $0 clamp
  ([model-asset.js:807](../js/model-asset.js)), a "does a backstop exist at all"
  check ([portfolio-issues.js:171](../js/portfolio-issues.js)), and a rule-note
  gate ([rule-notes.js:192](../js/rule-notes.js)).
- The clamp at [model-asset.js:804–807](../js/model-asset.js) deliberately
  includes tax-deferred and tax-free instruments, so an explicitly-named IRA is
  a first-class funding source that clamps and spills like any other account.

The comment at [instrument.js:129](../js/instruments/instrument.js) — "a plan
that means to spend retirement money says so with an explicit fund transfer" —
is therefore enforced by construction, not convention. The engine has no
inherited-IRA concept and does not need one: the explicit transfer *is* the
user's statement that they know what the distribution costs.

**What this spec deliberately DOES allow, decided 2026-08-05.** A retirement
account may receive an allocated share of the *tax on income it generated*, once
the holder is past the early-withdrawal age. That is not a weakening of the rule
above; it is the same principle 4b already applies non-optionally at the source
of every distribution. Three boundaries keep it honest:

1. **`FUNDING_BACKSTOP_PRIORITY` is NOT changed.** The engine still never
   implicitly draws an IRA for an expense, a mortgage, property tax, escrow or
   a spillover. Only the tax allocation in §3.2 widens. `resolveFunding`'s list
   and its comment at [instrument.js:129](../js/instruments/instrument.js) stay
   exactly as they are.
2. **Age-gated.** Ineligible before the threshold in §3.2, so the engine never
   implicitly reaches money that would carry a penalty.
3. **Roth can never be allocated to** — see §3.2.

Without this, 4a is a measured no-op: §7 shows it reallocating $0 on all four
Quick Start profiles and 3.9% on the reference portfolio. With it, the same
measurement gives 8.2% to 100%.

## 3. The change

### 3.1 The allocation basis

Per-asset taxable income already exists as metrics; nothing new is computed.

```js
/**
 * An asset's own contribution to the household's federal taxable income.
 *
 * NOT Metric.INCOME — that parent also rolls up TAX_FREE_DISTRIBUTION
 * (metric.js:158-159), so a Roth would earn a share of the tax bill.
 *
 * The three terms are disjoint under MetricRollups: QUALIFIED_DIVIDEND rolls to
 * INCOME only, LONG_TERM_CAPITAL_GAIN rolls to CAPITAL_GAIN, and interest,
 * non-qualified dividends and short-term gains all roll to ORDINARY_INCOME.
 * Summing them double-counts nothing.
 */
function taxableIncomeBasis(asset) { … }   // ORDINARY_INCOME + CAPITAL_GAIN + QUALIFIED_DIVIDEND
```

This is a **share basis, not a liability calculation.** It does not attempt to
compute what each asset would owe standing alone — brackets are not additive and
that number does not exist. It answers "what fraction of the household's taxable
income did this account produce," and applies that fraction to a bill the
household already computed. §6 requires the note to say exactly that.

### 3.2 Eligibility

An asset receives an allocation only if **all** hold:

```
(  InstrumentType.isFundingBackstop(asset.instrument)
|| (InstrumentType.isTaxDeferred(asset.instrument) && userAge >= DEFERRED_ALLOCATION_AGE) )
&& !asset.isClosed
&& asset.finishCurrency.amount > 0
&& taxableIncomeBasis(asset) > 0
```

**`DEFERRED_ALLOCATION_AGE = 60`.** The statutory threshold is 59½, which this
engine cannot express: `activeUser.month` is pinned to 0
([portfolio.js:277](../js/portfolio.js)) and only `addYears(1)` is ever called
([portfolio.js:449](../js/portfolio.js)), so user age advances in whole years on
New Year's Day. 60 is the conservative reading — it never allocates to a
deferred account in a month that might still carry a penalty, at the cost of at
most a few months of attribution in the year the holder turns 59½. Decided
2026-08-05; the alternative (`>= 59`) would allocate for up to six penalty-
bearing months, and making months exact is its own PR.

**No API change is required.** `TaxEngine` already receives `activeUser` in its
constructor ([tax-engine.js:24](../js/engines/tax-engine.js)), and allocation
happens inside `TaxEngine`. Because §2 leaves `FUNDING_BACKSTOP_PRIORITY` alone,
`FundTransfer.resolveFunding` stays static and unthreaded — the ~20 call sites
that would have needed an age parameter are untouched.

**Roth is doubly excluded, and the second exclusion is the load-bearing one.**
`isTaxDeferred` is exactly `{IRA, FOUR_01K}`, so the gate above omits Roth. But
even if the gate were wrong, a Roth's `taxableIncomeBasis` is **structurally
zero**: Roth distributions book to `ROTH_IRA_DISTRIBUTION` →
`TAX_FREE_DISTRIBUTION`, which §3.1 excludes. Probed 2026-08-05 across all five
scenarios — adding Roth to the eligible set changed the allocation by **$0 in
every one**. The "Roth ordering rules" hazard named at
[instrument.js:129](../js/instruments/instrument.js) is therefore handled by the
basis definition and not only by the gate. §8.6 locks this.

Income and pension instruments stay ineligible: they are flows with no balance
to debit ([tax-withholding-spec.md §4.1](tax-withholding-spec.md)). Their tax is
spec 4c's problem.

### 3.2.1 The feedback loop, and why a flat gross-up is required

Withdrawing from a tax-deferred account to pay tax **is itself a taxable
distribution**. Allocating a liability-derived bill to an IRA therefore feeds
back: this month's payment raises next month's taxable income, which raises the
next allocation. 4b avoided this entirely by using a rate that is not a function
of the liability; 4a cannot, because the bill *is* the liability.

The series converges (each pass is ~22–24% of the previous at these brackets),
but it must be modelled deliberately rather than left to iterate across months:

- **Gross up the deferred leg at the point of allocation.** For a fully-ordinary
  distribution the existing formula applies with `g = 1.0`:
  `W = X / (1 − t)`, the same shape `calculateGrossWithdrawal` already
  implements ([expense-engine.js:381](../js/engines/expense-engine.js)).
- `t` must be a **flat** rate — reuse `global_retirement_withholding_rate` —
  never the marginal rate implied by the bill, which reintroduces the loop the
  `calculateGrossWithdrawal` comments warn about.
- The grossed-up increment is a distribution: book it to the distribution
  metric and to `this.monthly`, exactly as
  `TaxEngine.#withholdInScope` does ([tax-engine.js:146–155](../js/engines/tax-engine.js)).

**§7's measured reallocation figures are first-order** — computed against the
existing residual, before any feedback. The converged numbers will be higher.
Predicting the direction (up, never down) is part of §7's gate.

### 3.3 Shape: allocate the residual, then fall through

The waterfall, with only tier 2 new:

1. **Explicit `fundTransfers`** — honored verbatim, any instrument. *Does not
   exist for income tax and this spec does not create it — see §5.*
2. **Proportional allocation** across eligible assets, by §3.1 share. ← new
3. **Residual** to `resolveFunding()` — existing behaviour, unchanged.

Each allocated share is paid through `settleOneSided`, exactly as the single
backstop draw is today. That inherits the $0 clamp, the spillover re-sourcing
and the `reportUnfunded` path for free; an asset whose share exceeds its balance
pays what it has and the remainder falls to tier 3 like any other spill.

**Rounding.** Allocate in whole cents by largest-remainder, and give the
remainder to the tier-3 leg rather than to the largest payer. The legs must sum
to the bill exactly. A penny of drift per month is invisible against the annual
true-up's `Math.abs(taxDifference) < 1` materiality threshold
([tax-engine.js:517](../js/engines/tax-engine.js)) but is not invisible to
reconciliation, which compares the `incomeTax` bucket against the
FinancialPackage with a tolerance far tighter than a dollar.

### 3.4 The two sites read the basis differently — the main implementation trap

Per-asset metrics are **monthly accumulators that are zeroed on snapshot**
(`TrackedMetric.snapshot()`, [metric.js:362](../js/metric.js)), driven by
`ModelAsset.monthlyChron` → `#metrics.snapshotAll(KEEP_ON_SNAPSHOT)`
([model-asset.js:585](../js/model-asset.js)).

The chronometer's order ([chronometer.js:120–157](../js/chronometer.js)):

```
applyMonth(d)                       ← withholdOnDeferredDistributions, then
                                       applyMonthlyTaxTrueUp   (portfolio.js:753,755)
  d.next()
  monthlyChron(d)                   ← per-asset snapshot + ZERO  (portfolio.js:431)
  if New Year's Day:
     applyYear(d)                   ← applyAnnualTaxTrueUp      (portfolio.js:881)
```

Consequences the implementation must respect:

- **Monthly site** — `asset.ordinaryIncomeCurrency` and friends still hold *this
  month's* income. Read `.current` directly. Cheap and exact.
- **Annual site** — every month of the settled year has already been snapshotted
  and zeroed, *including December*, because `applyYear` fires on **January 1 of
  the following year**. The basis must be summed from `asset.getHistory(metric)`
  over the settled year's months.
- The settled year is `currentDateInt.year - 1`, and its month count is
  `portfolio.monthsInPlanYear(year)`
  ([portfolio.js:499](../js/portfolio.js)) — the first and last plan years are
  short. That helper already exists; do not re-derive it.

Reading `.current` at the annual site returns **zero for every asset**, which
degrades silently to "no asset is eligible" and falls entirely through to tier 3
— i.e. it looks exactly like today's behaviour and every existing test passes.
§8.3 is the test that catches it.

### 3.5 Events and reconciliation

**No new `EventType` and no new `EVENT_RECONCILIATION` entry.** The monthly site
keeps `INCOME_TAX_WITHHOLDING` (bucket `'incomeTax'`) and the annual site keeps
`TAX_TRUE_UP` (bucket `'oneSided'`), both already declared at
[portfolio.js:53](../js/portfolio.js) and [:82](../js/portfolio.js). The surface
that throws on an undeclared type is untouched, and since buckets key on `type`
alone and the legs sum to the same total, every reconciliation bucket is
byte-identical to today.

Add `data: { basis: 'proportional', share }` so the ledger can distinguish an
allocated leg from a backstop draw. `data` is free-form and reaches no
classifier.

Each payer books its own share to `Metric.ESTIMATED_INCOME_TAX`, the per-asset
leaf the single payer already writes ([tax-engine.js:461](../js/engines/tax-engine.js),
[:546](../js/engines/tax-engine.js)).

### 3.6 Refunds

Allocate overpayment refunds on the **same basis**, for symmetry. Leaving them
at the backstop while allocating collections ratchets cash out of the income
generators and into the first liquid account over repeated over/under cycles —
a slow version of the bug this spec exists to fix.

Basis is safe: `#transact` adds a deposit to `finishBasisCurrency` for taxable
accounts ([model-asset.js:766](../js/model-asset.js)), so crediting a brokerage
its share of a refund does not manufacture an untaxed future gain.

## 4. What changes on screen, and the note that must move

### 4.1 Rule #2 in rule-notes.js is falsified by this PR

[rule-notes.js:19–22](../js/rule-notes.js) currently reads:

> **DON'T INVENT ALLOCATIONS.** The household tax true-up is deliberately not
> split across the incomes that caused it — that number does not exist in the
> engine, and on screen people would treat it as real. Name the counterparty and
> stop.

After this PR the engine books that split, so the number does exist and is
derived from booked metrics rather than reconstructed for display. Rule #1
(DERIVE, NEVER RECOMPUTE) then governs it, and is satisfied: the note reports
`ESTIMATED_INCOME_TAX` as actually booked on the asset.

**The prohibition must be rewritten, not deleted** — the reasoning behind it
survives the change. Proposed replacement:

> **2. DON'T INVENT ALLOCATIONS.** A split may only be shown if the engine
> booked it. The household true-up is allocated across the accounts that
> generated the income (spec 4a) and each payer's share is a real booked amount
> — say that. What is still not sayable is what any one asset "owes": brackets
> are not additive, and a per-asset liability is not a number the engine has.

Updating this comment is **in scope for the same PR.** Leaving it makes a
load-bearing comment a false statement about the code.

### 4.2 The `funding-backstop` note will start firing on the wrong assets

[rule-notes.js:189–198](../js/rule-notes.js) gates on
`isFundingBackstop(asset.instrument) && ctx.total(Metric.ESTIMATED_INCOME_TAX) !== 0`
and then says:

> "This is the household's funding account: taxes, bills and mortgage payments
> draw from here automatically when no transfer covers them."

Under 4a a brokerage that pays only its proportional share satisfies that gate
and gets told it is the household's automatic funding account. That is wrong,
and it is wrong in the specific way the issues surface was built to avoid —
confidently explaining a mechanism that did not fire.

The note must split in this PR: the backstop wording stays for the account
`resolveFunding` actually selected, and allocated payers get their own note
naming the share and the basis. Both are derivable — the tier-3 leg is the one
whose event lacks `data.basis === 'proportional'`.

## 5. What this does not fix

**No explicit routing for income tax.** Tier 1 does not exist for this
obligation and this spec does not build it. There is no asset that "owes"
household tax — `fromModel` is deliberately null with that reasoning recorded at
[tax-engine.js:470](../js/engines/tax-engine.js). Creating tier 1 means a
synthetic household-tax obligation carrying a `fundTransfers` list plus the UI
to edit it, which is a larger change with its own design questions. **A user who
wants their inherited IRA to pay the income tax still cannot express that.**
That is a real gap and it stays open.

**Social Security and pension are still unattributed.** Both are flows with no
balance ([tax-withholding-spec.md §4](tax-withholding-spec.md)), and SS's
taxable base is still a flat 85% (open finding, 2026-07-25 review). They
contribute to the household bill and receive no allocation, so their tax lands
on tier 3 exactly as today.

**The comment at [metric.js:167–170](../js/metric.js)** — "retirement income has
no per-asset tax leaf" — **stays true.** 4a adds no writer for pension or SS. Do
not "fix" it.

**Total lifetime tax is not conserved and must not be asserted.** Same reason as
4b: moving which account pays changes which balance compounds. The conservable
invariant is the tax identity — collected equals liability, year by year.

## 6. The residual is smaller than the original 22% estimate

The "4a is only a 22.3% fix" figure in
[tax-withholding-spec.md §1](tax-withholding-spec.md) is a **pre-4b measurement**
and should not be carried into this PR's justification. 4b now covers ~55% of
the lifetime bill at the source, so 4a is redistributing a materially smaller
residual than that table describes.

**§7's baseline must be re-measured against `main` at f4c6b94 before any code is
written.** Quoting the old number as this PR's benefit would be blessing a
justification rather than establishing one.

## 7. Baseline — MEASURED 2026-08-05, and it falsifies the premise

Measured on `main` @ f4c6b94 before any implementation, per
[[feedback-predict-before-engine-fix]]. **The gate did not pass.** The numbers
below are the reason this spec should not be implemented as written.

### 7.1 Reference portfolio — `tests/data/portfolio-2026-05-mouk0ygz.json`

2026-05 → 2056-12, single, retires 57. Finish net worth **$17,027,770.83**.

| | Lifetime | Share |
|---|---:|---:|
| Withheld at source (4b) | $309,609 | 46.9% |
| Residual settled by true-up | $351,037 | 53.1% |
| **Total collected** | **$660,646** | |

**Brokerage pays 100% of the residual in all 31 plan years.** Savings does not
pay it — savings is depleted in **2026-09**, four months into the plan, not
December 2027. The original diagnosis was taken before 4b and before `258b447`
made the April bill actually collect; both moved the depletion earlier and
handed the payer role to the brokerage permanently.

Brokerage is also **94–96% of the eligible basis** in every normal year:

| Year | Eligible basis | Brokerage | Treasuries | Savings |
|---|---:|---:|---:|---:|
| 2026 | $17,798 | 94.3% | 5.3% | 0.4% |
| 2027 | $39,549 | 96.3% | 3.7% | — |
| 2028 | $483,809 | 6.9% | 0.3% | — |
| 2029 | $40,835 | 96.2% | 3.8% | — |
| 2030 | $41,479 | 96.1% | 3.9% | — |

2028 is the CompanyStock close ($448,713 of gain, 92.7% of eligible basis) — but
that asset is closed with a $0 balance in 2028-01, so §3.2's `!isClosed &&
balance > 0` gate makes it ineligible and the tax lands on the brokerage anyway.

**So 4a would move roughly 4–6% of the residual from Brokerage to Treasuries.**
The account it was designed to protect is already not paying.

### 7.2 All four Quick Start profiles — 4a reallocates exactly $0

| Profile | At source | Residual | Payer today | Eligible basis | Reallocated by 4a |
|---|---:|---:|---|---|---:|
| Early Career | $437,341 | $202,188 | Brokerage 100% | Brokerage 100% | **$0** |
| Mid Career | $207,321 | $37,613 | Brokerage 100% | Brokerage 100% | **$0** |
| Pre-Retirement | $341,609 | $222,624 | Brokerage 100% | Brokerage 100% | **$0** |
| Retired | $189,812 | $318,760 | Brokerage 100% | **$0** | **$0** |

Every profile has exactly one backstop-eligible account with a balance, so the
backstop's pick and the proportional answer are the same account. The priority
order `cash → bank → brokerage → bonds` converges on the right answer by
accident: once the small cash and savings buffers drain, the brokerage is the
only large eligible account left standing.

**Two measurement traps, both hit and both corrected** — recorded so the next
probe does not repeat them:

- Flow instruments book **payroll** withholding under
  `EventType.INCOME_TAX_WITHHOLDING`, the same type the monthly true-up uses.
  Counting those as residual overstated it by the entire payroll bill and
  invented a "Salary pays 56.6% of the tax" divergence that does not exist.
- A brokerage that receives income and pays expenses in the same month realizes
  **no** capital gain — `#transact` draws from `monthlyCreditBalance` first
  ([model-asset.js:775](../js/model-asset.js)). In the Retired profile that
  makes the brokerage a pure pass-through with a genuinely zero basis, which
  looks identical to an untracked metric. It is not: `CapitalBehavior`
  tracks all three basis metrics.

### 7.3 What the Retired profile actually shows

| Source | Lifetime ordinary income | Backstop-eligible? |
|---|---:|---|
| Social Security | $1,278,421 | No — flow |
| FERS Pension | $875,712 | No — flow |
| 401K | $1,314,153 | No — retirement |
| IRA | $583,969 | No — retirement |
| Brokerage | **$0** | Yes |

The brokerage pays $318,760 of tax on income it did not earn, and **4a cannot
fix it** — every earner is ineligible by design. This is the original complaint
in its purest form, and proportional allocation across balances is the wrong
instrument for it. Withholding on arrival (the SS/pension mechanism, spec 4c) is
the one that reaches it.

### 7.4 The eligibility rule was the whole problem — measured 2026-08-05

Under the ORIGINAL eligibility rule (backstop instruments only), 4a is a no-op
on all five scenarios. Widening it per §3.2 — deferred accounts allocatable from
age 60 — changes that completely:

| Scenario | Residual | Backstop-only | §3.2 eligibility | Moves to |
|---|---:|---:|---:|---|
| Early Career | $202,188 | $0 (0%) | **$120,896 (59.8%)** | 401K |
| Mid Career | $37,613 | $0 (0%) | $3,067 (8.2%) | 401K |
| Pre-Retirement | $222,624 | $0 (0%) | **$218,851 (98.3%)** | 401K $164,045, IRA $54,806 |
| Retired | $318,760 | $0 (0%) | **$318,760 (100%)** | 401K $225,709, IRA $93,051 |
| Reference | $351,037 | $13,835 (3.9%) | **$214,408 (61.1%)** | IRA $208,831, Treasuries $5,577 |

In every case the relieved account is the Brokerage. The Retired profile is the
cleanest statement of the original complaint: the brokerage stops paying
$318,760 of tax on income it never earned, and the two accounts that produced
$1.9M of ordinary income pay it instead.

**Adding Roth to the eligible set changes the result by $0 in all five** — the
basis property in §3.2, confirmed rather than assumed.

**These are first-order figures.** They allocate the *existing* residual and do
not model §3.2.1's feedback. Converged values will be higher.

### 7.5 What the age gate does not fix

Only Early Career ever exhausts the backstop: **158 UNFUNDED events, $51,066**,
first at 2029-11 with $82,126 tax-deferred and $28,488 Roth available. The
holder is **38** at that point, so §3.2's gate correctly declines — this is the
case the exclusion exists for, and it stays unfixed by design. No scenario runs
dry while past 60 with retirement money available.

A plan that reports an unpayable bill at 70 while holding a funded IRA would be
fixed only by changing `FUNDING_BACKSTOP_PRIORITY` itself, which §2 explicitly
does not do. Deferred to a later decision.

### 7.6 Still required before implementation

The table above is a *measurement of the current engine*, not a prediction of
the new one. Per [[feedback-predict-before-engine-fix]] the following must be
written down before code and checked after:

| # | Prediction | Expected direction |
|---|---|---|
| 7.6a | Converged reallocation per scenario | **Higher** than 7.4's first-order figures (§3.2.1) |
| 7.6b | Lifetime tax collected | **Up** — paying tax from an IRA is itself taxable. NOT a leak; the tax identity must still hold year by year |
| 7.6c | Finish net worth, per scenario | Direction argued per scenario before the run. It is NOT conserved and "unchanged" is the wrong invariant |
| 7.6d | Reconciliation findings | **0**, unchanged — §3.5 predicts every bucket is byte-identical |

The old "4a fixes 22.3%" figure is dead: it was measured before 4b, before the
April-collection fix, and against a payer that no longer pays.

## 8. Tests

### 8.1 Neutrality (the PR #23 pattern)

With allocation disabled — feature flag off, or every asset's basis forced to
zero — the run must be **event-for-event identical** to a run without the code.
Proves no ungated side effects. This is the cheapest high-value test and it goes
in first.

### 8.2 Explicit IRA transfers are untouched — §2's guard

A portfolio with an explicit `IRA → Living Expenses` fund transfer must produce
an **event-for-event identical** run before and after 4a: same payer, same
amounts, same order, same trace chains. Mutation-verify by deliberately adding
IRA to the eligible set and confirming the test fails. Without that mutation
step this test proves nothing — a passing suite has repeatedly failed to
distinguish "the rule holds" from "the rule never ran" in this codebase.

### 8.3 The annual site reads history, not `.current` — §3.4's trap

Assert that in a year where a brokerage generated taxable income, the annual
true-up allocates a **non-zero** share to it. Reading `.current` at that site
returns zero for every asset and degrades silently into today's behaviour, which
every other test would pass. Mutation-verify by switching the annual site to
`.current` and confirming this test — and only this test — fails.

### 8.4 Conservation

- **Legs sum to the bill.** Σ(allocated legs) + tier-3 leg == the true-up amount,
  to the cent, every month. Catches §3.3's rounding.
- **Tax identity holds.** Recompute each year's liability from a snapshot of the
  income package taken *before* the true-up settles, through the public tax API,
  and compare to cash actually collected. Reading the true-up's own number is
  circular — this is PR #23's pattern 2.
- **Existing reconciliation stays at zero findings** on all profiles.
  §3.5 predicts every bucket is byte-identical; a non-zero finding falsifies it.

### 8.5 Roth is never allocated to, and the age gate holds

Two assertions, both mutation-verified:

- **Roth gets $0** in every scenario, and still gets $0 when the eligibility
  gate is deliberately widened to include tax-free instruments. That second half
  is the point — it proves the basis, not the gate, is what protects Roth. Mutate
  by adding `ROTH_IRA_DISTRIBUTION` to §3.1's basis and confirm the test fails.
- **No allocation to a deferred account in any month before age 60.** Mutate the
  threshold to 0 and confirm failure. Early Career is the fixture that reaches
  this — it is the only profile whose backstop runs dry while under age, and it
  must still report its 158 UNFUNDED events unchanged (§7.5).

### 8.6 The feedback loop converges and is booked

Assert that the grossed-up increment on a deferred allocation is itself recorded
as a distribution — on the asset metric and in `this.monthly` — and that lifetime
tax rises rather than falls (§7.6b). A run where allocating tax to an IRA leaves
taxable income unchanged has silently skipped the gross-up.

### 8.7 Attribution

Show that any change in an account's terminal value is a **different payer, not
a leak**: Δ(savings balance) matched 1:1 against Δ(tax paid from savings) plus
growth. PR #23's pattern 3.

## 9. Sequencing and rollback

Recommended order, each independently revertable:

1. `taxableIncomeBasis()` + §3.2 eligibility predicate (age gate included) +
   unit tests. No engine behaviour change; §8.1 neutrality holds trivially.
2. Monthly true-up allocation, behind a flag defaulting to **off**. §8.1, §8.2,
   §8.5.
3. The deferred gross-up (§3.2.1). Must land with step 2 or immediately after —
   allocating to an IRA without it understates taxable income by the whole
   allocation. §8.6.
4. Annual true-up allocation (collections). §8.3, §8.4.
5. Refunds (§3.6).
6. Flip the flag on; re-bless golden masters against §7.6's recorded
   predictions.
7. Rule-note changes (§4.1, §4.2) — must land with or before step 6, never
   after.

Rule #2's replacement wording in §4.1 needs one more clause now that deferred
accounts are allocatable: the note on an IRA must distinguish *withheld at
source* (4b) from *allocated residual* (4a), because both now book
`WITHHELD_INCOME_TAX`/`ESTIMATED_INCOME_TAX` on the same asset and a reader
cannot otherwise tell which rule fired. See
[[feedback-runtime-rule-confirmation]].

Rollback is the flag. Keep it until the golden masters are re-blessed and the
reference portfolio has been re-examined.

---

Related: [[project-tax-funding-routing]], [[funding-backstop-policy]],
[[project-tax-attribution-gaps]], [[study-credit-memo-events]],
[[feedback-predict-before-engine-fix]], [[feedback-runtime-rule-confirmation]].
