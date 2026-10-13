# Spec 11 — A MAGI ceiling, and whether the ACA subsidy is worth it

Status: **PROPOSED 2026-10-13. Nothing built.** The decisions in §13 are John's.

The question this spec answers: *if I keep my income low enough from retirement
to 65, do I come out ahead?* The cost of keeping MAGI low is real: money left in
the IRA is taxed later, often at a higher rate. The benefit is the ACA premium
tax credit. The plan can only say which is larger if it models both the premium
and the credit, so this spec has three parts:

- **A. A health-insurance card** for the marketplace premium, with its own
  inflation rate and the premium tax credit computed on it.
- **B. A MAGI ceiling rule**: keep a chosen MAGI under a ceiling over an age
  span, by changing which accounts pay the bills, not by editing the user's
  transfer rules.
- **C. "Worth it?"**: run the plan with and without the ceiling and show the
  difference: credit received, tax paid over the plan, and net worth at the end.

Each part is useful on its own and they ship in that order (§12).

---

## 1. What exists

- Every settled year records its AGI and each MAGI in `Portfolio.taxYears`
  (spec 6 / PR #98), including `magi.aca` = AGI plus the Social Security that
  §86 leaves untaxed. It also records what the year owed and how January
  settled it (PR #104).
- Month & Year Details shows the tax year (AGI, MAGI, effective rates), and
  Reports show a yearly AGI/MAGI block.
- **Nothing acts on MAGI.** No rule reads it except NIIT and the senior
  deduction, and no part of the engine knows what an ACA premium is.
- Any expense card can already carry its own inflation rate: an expense's
  `annualReturnRate` of 0 means "use plan inflation"
  (`ModelAsset.effectiveAnnualReturnRate`), and any other value is its own rate.
  So a health-insurance premium inflating faster than CPI works today. What
  does not exist is the subsidy, which is why the card in §5 is a new
  instrument and not just an expense with a higher rate.

## 2. The law, as of October 2026

To be checked against the IRS sources at build time. This area has changed
three times since 2021.

- **The credit** (IRC §36B, Form 8962). For each month of marketplace coverage:
  `credit = max(0, benchmark premium − expected contribution)`, never more than
  the premium of the plan actually bought. The benchmark is the second-lowest-cost
  silver plan (SLCSP) for the household. The expected contribution is the
  *applicable percentage* times household income.
- **Household income is ACA MAGI**: AGI plus untaxed Social Security, tax-exempt
  interest and excluded foreign income. The model has neither of the last two,
  so ACA MAGI = AGI + untaxed Social Security, which is exactly `magi.aca`.
- **Poverty line (FPL).** The credit for year *Y* uses the HHS guidelines
  published in year *Y − 1*. For 2026 that is the 2025 guideline: $15,650 for
  one person and $21,150 for two, in the 48 contiguous states.
- **The 2026 applicable percentages** run from 2.10% below 133% of FPL to 9.96%
  from 300% to 400% (Rev. Proc. 2025-25), interpolated within each band.
- **The cliff is back.** The enhanced credits (ARPA 2021, extended by the IRA
  2022) removed the 400% limit and capped the contribution at 8.5%. They expired
  after 2025. From 2026, a household one dollar over 400% of FPL gets **no
  credit at all**: $62,600 for one person and $84,600 for two in 2026.
- **Advance and reconciliation.** Most enrollees take the credit in advance
  (APTC), paid monthly to the insurer from an *estimate* of the year's income,
  and reconcile on the return. **From tax year 2026 there is no cap on repaying
  excess APTC** (P.L. 119-21 §71305). An estimate that turns out low now costs
  the full difference.
- **Coverage ends at Medicare**, normally at 65.
- **Premiums jump.** KFF puts the average 2026 benchmark increase at about 26%
  (17% in state-run marketplaces, about 30% on HealthCare.gov). That is one
  year, not a trend, but it is why the card needs its own rate.

## 3. What moves ACA MAGI

| Source | Adds to ACA MAGI, per dollar | Controllable |
|---|---|---|
| IRA / 401(k) distribution | $1.00 | yes: how much to draw |
| Roth conversion | $1.00 | yes |
| Brokerage withdrawal | the gain fraction only | yes: how much, versus other accounts |
| Cash, Roth contributions | $0 | yes |
| Social Security | $1.00 (ACA counts all of it) | no: the claim age is the lever |
| Pension, wages, interest, dividends | $1.00 | no |

So the lever is the **source of each withdrawal**. The amount spent is the user's
plan and this spec never changes it.

## 4. Why a rule, not an optimizer

The obvious route is to let the Maximizer search transfer percentages with a
MAGI penalty. It does not fit:

- **Transfer rules are percentages of each bill, per life-event phase.** The
  IRA draw that keeps MAGI under a ceiling changes every year: spending
  inflates, Social Security starts, the premium itself grows. One fixed
  percentage per phase cannot track a dollar target from year to year.
- **It is slow and inexact.** 50 × 200 generations at about 35 ms per run is
  roughly 6 minutes, and it would still only land near the target.
- **It would rewrite the user's rules.** The app's line is that the system
  advises and the user decides.

A **rule** leaves the transfer rules as the default split and overrides them at
the margin, during the run. It holds the target every year, explains itself in
the causal chain ("IRA leg capped by your MAGI ceiling"), and works in Monte
Carlo, where each path's markets differ, because it reacts to the path rather
than replaying a precomputed schedule. Guardrails is the precedent: a rule the
user configures and the engine applies.

The Maximizer comes back in §7, choosing *the ceiling*, a one-number search that
is cheap.

---

## 5. Part A — the health-insurance card

### 5.1 The instrument

A new instrument, `healthInsurance`, in the `MONTHLY_EXPENSE` family, so it
inherits everything an expense does: funding transfers, its own inflation rate,
`Metric.EXPENSE`, the Expenses list, Withdrawn.

| Field | Meaning | Default |
|---|---|---|
| Monthly premium | the plan actually bought, before any credit | — (required) |
| Benchmark premium | the SLCSP for the household, monthly | the monthly premium |
| Annual rate | the premium's own inflation | decision §13.4 |
| Start / finish | months of marketplace coverage | the Retire phase → age 65 |
| Credit | on / off | on |

Household size for the FPL comes from filing status: 1 for Single, 2 for MFJ.
The model has no dependents (§11).

**Why its own card and not an expense with a higher rate:** the engine needs to
know which expense *is* the marketplace premium, what the benchmark is, and when
coverage ends, to compute the credit. A separate card also lets the 65 boundary
close it, and lets "Worth it?" (§7) point at one thing.

### 5.2 The credit: advance, then reconciliation

Modelled as people actually receive it:

1. **Advance (monthly).** On each premium payment the engine computes the
   month's credit from an *estimate* of the year's ACA MAGI and pays only the
   net premium. The estimate is the ceiling when a ceiling rule covers the year
   (that is the income the household tells the marketplace). Otherwise it is
   last year's recorded `magi.aca`, or an estimate field on the card for the
   first year (decision §13.5).
2. **Reconciliation (annual).** In the annual pass, after the true-up and NIIT
   and as its own pass for the same reasons NIIT is, the credit is recomputed
   from the year's actual `magi.aca`. Excess advance is repaid in full (no cap
   from 2026), and a shortfall is credited. It is booked in January of the next
   year, like the true-up, and the TaxYear record carries it.

Booking:

- `FinancialPackage` gains `premiumTaxCredit` (the advance, positive, offsetting
  the premium) and `ptcReconciliation` (+ credit, − repayment).
  `federalTaxes()` includes the reconciliation. Excess APTC is a tax (Schedule 2)
  and net PTC is a refundable credit (Schedule 3).
- `TaxYear` gains `ptc` (allowed), `aptc` (advanced), `fplPercent` and
  `ptcReconciliation`, so "what did the credit come to in 2031" is read from the
  record and never recomputed.
- New EventTypes `PREMIUM_TAX_CREDIT` and `PTC_RECONCILIATION`, declared in
  `EVENT_RECONCILIATION` before anything emits them (an undeclared type throws
  mid-run), and named in `EXPENDITURE_TREATMENT`.
- New metric leaves for the advance credit and the reconciliation, and they
  **must be in the new instrument's `relevantMetrics()`**: a metric that is not
  is a silent no-op (§9).

## 6. Part B — the MAGI ceiling rule

### 6.1 The setting

Proposed home: the Retire phase (decision §13.1), next to that phase's transfer
rules:

| Field | Meaning | Default |
|---|---|---|
| MAGI | which `MagiPurpose` to hold down | ACA |
| Ceiling | a dollar amount, or a percentage of FPL | 400% of FPL when a health-insurance card exists |
| Until age | when the rule stops | 65 |
| Margin | headroom kept back for income the rule cannot predict | decision §13.3 |
| Fall back to | the accounts that pay what a capped source cannot, in order | brokerage, then cash, then Roth (decision §13.2) |

A percentage of FPL stays a percentage. The dollar ceiling follows the FPL
table, indexed at plan inflation past the last published year, the way the tax
tables are.

### 6.2 How the engine holds it

MAGI is annual and bills are monthly, so the rule works from the year so far
plus what is still scheduled. Before each draw that would raise MAGI:

```
room = ceiling − margin − (ACA MAGI so far this year) − (income still scheduled this year)
```

- **ACA MAGI so far** = AGI excluding Social Security, plus all Social Security
  received, from the year's package to date. ACA counts all of Social Security,
  so no §86 calculation is needed in-year. It is a running sum, never one month
  times twelve.
- **Income still scheduled** = the remaining months of wages, pension and Social
  Security at their current monthly amounts, plus dividends and interest at the
  year-to-date average.
- **Capping:** an IRA or 401(k) leg is capped at `room` (gross, before
  withholding). A brokerage leg uses room at its gain fraction, known when the
  draw is planned (`ModelAsset.planWithdrawal()`). A Roth conversion (day-1
  transfers) is capped by the same room. Cash and Roth draws are not capped.
- **Redirecting:** what a capped leg cannot pay goes to the fall-back accounts
  in order, through the existing settlement path, so clamping, spillover and
  shortfall reporting all still apply.
- **When the fall-backs run dry, the bill is paid**: the capped source pays
  past the ceiling, and the year is reported (§6.3). A rule about income never
  leaves an expense unpaid (decision §13.3).
- **Trace:** each redirect is recorded (a new informational EventType, or data
  on the TRANSFER event: decision for implementation), so `explain_month`
  answers "why did the brokerage pay in March?"

The user's transfer rules are never edited. They remain the default split, and
the rule changes only what they would have drawn past the ceiling.

### 6.3 Checking each year

After each year settles, compare `taxYears[y].magi[purpose]` with the ceiling:

- **Under:** the tax strip shows "ACA MAGI $58,900 of a $62,600 ceiling (376%
  of FPL)".
- **Over:** "What needs attention" says by how much and why: "2031: $1,600 over
  your ceiling. The brokerage ran out in October, so the IRA paid." It names
  the cost when a card exists: "the credit for 2031 is $0 and $9,412 of advance
  credit is repaid."

## 7. Part C — "Worth it?"

The comparison the user actually wants. Runs take about 26–39 ms each, measured
on the quick-start profiles, so this is cheap:

1. Run the plan as configured, with its ceiling.
2. Run it again with the ceiling off. Optionally sweep: off, 400%, 350%, 300%
   and 250% of FPL.
3. Show, for each:

| | No ceiling | 400% of FPL |
|---|---:|---:|
| Premium tax credit received | | |
| Federal tax over the plan | | |
| Net worth at the end (today's $) | | |
| Years over the cliff | | |
| **Difference** | | |

The difference is the answer: the credit gained against the tax moved to later
years. Larger IRAs mean larger RMDs at 73, possibly IRMAA, and a widow's single
brackets. Where it shows: the health-insurance card's 👓 view and its ⚡ summary.
The MCP already has `diff_plans`, which can carry the same comparison.

Picking the best ceiling from the sweep is the Maximizer's natural job (§4):
one number, about 30 runs. It is offered as a recommendation the user applies,
never applied automatically.

---

## 8. Presentation surfaces, enumerated

Spec 8 (NIIT) shipped a tax that was collected correctly and shown nowhere, then
found a sixth surface after the fix. All of these change:

- Month & Year Details:
  - the Expenses list (premium and advance-credit lines on the card's group);
  - the Taxes list (the reconciliation);
  - the tax strip (ACA MAGI against the ceiling and as % of FPL);
  - the ⚡ summary.
- Reports: yearly rows for the advance credit, the reconciliation and % of FPL.
- The Taxes column (`TAX_TREE` in `asset-list.js`, guarded by
  `tax-tree-coverage.test.js`).
- Spreadsheet columns.
- "What needs attention" (§6.3).
- Rules: a new ACA section, and the "Does Not Model" list (§11).
- Help.
- The MCP `run_plan` annual table and `explain_month`.

## 9. Traps this codebase has already hit

- **Month × 12.** Never derive MAGI or the credit from an annualised month. The
  credit is annual and the ceiling is in-year *actual* plus *scheduled*.
- **A metric not in `relevantMetrics()` is a silent no-op.** Every new metric
  needs a fixture that reaches it and an assertion that it was stored.
- **An undeclared EventType throws mid-run.** Declare before emitting.
- **Packages are cash-basis.** The reconciliation for year *Y* lands in January
  of *Y + 1*. Read it from the TaxYear record, not from year *Y*'s package.
- **Annual-pass events are dated December** of the settled year, while the
  booking lands in January.
- **The funding backstop is everyday accounts only.** The rule redirects only
  to accounts the user lists, and never draws a 401(k) on its own.
- **Predict before blessing** the snapshot, and **mutation-test** anything
  load-bearing. Green suites have hidden real bugs here more than once.
- **Plugin version** must be bumped in any PR that changes the bundle, and
  **static pages** updated in the same PR.

## 10. Fixtures

- `aca-early-retiree-single`: retires at 60 with an IRA, a brokerage and cash;
  health-insurance card to 65; a 400% ceiling. Under the ceiling every year.
- `aca-early-retiree-mfj`: the same, filing jointly (household of 2).
- `aca-ceiling-breached`: the fall-backs run dry in one year. Over the ceiling,
  the credit is repaid in full, and it is reported.
- `aca-low-basis-brokerage`: brokerage gains alone approach the ceiling, so the
  gain fraction matters.
- `aca-early-social-security`: claims at 62, so the untaxed Social Security in
  ACA MAGI is reached.
- **Silence:** every existing fixture must stay unchanged until it opts in.
- An independent §36B model, written from the statute and Form 8962, in the
  style of `decumulation-oracle.mjs`, so the credit is checked against something
  that did not come from the engine.

## 11. Not in scope

Recorded here so they read as known gaps, not oversights; Rules lists the ones
that affect results:

- Cost-sharing reductions (below 250% of FPL): they lower deductibles, not
  premiums.
- Medicaid and the gap below 100% / 138% of FPL.
- State subsidies.
- Dependents and households larger than 2.
- Age rating of premiums: the card's inflation rate stands in. A later option
  could apply the federal default age curve.
- Employer-coverage affordability and the family glitch.
- Each spouse reaching Medicare separately (one household age).
- **"Fill to the ceiling"** Roth conversions. The same room calculation run in
  reverse; worth its own spec.
- An IRMAA ceiling. The rule takes any `MagiPurpose`, but IRMAA reads year − 2
  and is a set of cliffs, so it needs its own presentation.

## 12. Phases and cost

| Phase | Delivers | PRs | Effort |
|---|---|---|---|
| **1. The card and the credit** | §5. The subsidy appears in the plan under the user's existing transfers, and so does what MAGI the plan actually produces | 2 | about 4–6 engineering days, most of it the law and the oracle |
| **2. The ceiling rule** | §6, with the yearly check and warning | 2 | about 5–8 days |
| **3. Worth it?** | §7, and the ceiling sweep | 1–2 | about 2–4 days |

In this repo's terms, 5–6 PRs about the size of #104 or #107. Phase 1 first:
it answers "how much is the subsidy?" before anything changes how the plan
draws money, and Phase 3 needs both.

## 13. Decisions for John

1. **Where the ceiling lives.** On the Retire phase (proposed), or as a
   plan-wide rule beside guardrails.
2. **Fall-back order default.** Brokerage, then cash, then Roth, which keeps
   Roth for last. Editable per plan.
3. **Margin, and what happens when the fall-backs run dry.** Proposed: a margin
   of 2% of the ceiling, and pay the bill and report the overshoot. The
   alternative, leaving a bill unpaid to protect the ceiling, is not proposed.
4. **The card's default inflation rate.** Plan inflation plus a fixed premium
   (for example + 2 points), a fixed rate, or no default so the user must enter
   one. The 2026 jump argues against a quiet default.
5. **The first year's advance estimate** with no prior record and no ceiling:
   an estimate field on the card, or no advance in that year.
6. **Scope of this spec's first PR.** Phase 1 alone, or Phases 1 and 2 planned
   together.

## Sources

- [IRS: premium tax credit FAQs, updated for 2026](https://www.irs.gov/node/15902) and
  [NATP: IRS updates premium tax credit for 2026](https://www.natptax.com/news-insights/blog/irs-updates-premium-tax-credit-for-2026/):
  repayment caps removed for tax years after 2025.
- [Wikipedia: Premium tax credit](https://en.wikipedia.org/wiki/Premium_tax_credit):
  expiry of the enhanced credits, return of the cliff.
- [Deorbit Plan: 2026 ACA numbers](https://deorbitplan.com/learn/2026-aca-numbers/):
  2026 applicable percentages and 400% thresholds (to confirm against Rev. Proc. 2025-25).
- [HHS ASPE: poverty guidelines](https://aspe.hhs.gov/poverty-guidelines): 2025 and 2026 guidelines.
- [KFF: ACA insurers raising premiums by an estimated 26%](https://www.kff.org/quick-take/aca-insurers-are-raising-premiums-by-an-estimated-26-but-most-enrollees-could-see-sharper-increases-in-what-they-pay/)
  and [Becker's: where benchmark premiums are rising most](https://www.beckerspayer.com/?p=20290).
