# Spec 11 — A MAGI ceiling, and whether the ACA subsidy is worth it

Status: **PROPOSED 2026-10-13. Decisions recorded 2026-10-26 (§13). Phase 1 is
built in PR #117, and §5 describes what it does. Phases 2 and 3 wait for a
fallback-order spec (§6.4).**

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
- **Before #117 nothing acted on MAGI.** No rule read it except NIIT and the
  senior deduction, and no part of the engine knew what an ACA premium was.
- Any expense card can already carry its own inflation rate: an expense's
  `annualReturnRate` of 0 means "use plan inflation"
  (`ModelAsset.effectiveAnnualReturnRate`), and any other value is its own rate.
  So a health-insurance premium inflating faster than CPI works today. What
  does not exist is the subsidy, which is why the card in §5 is a new
  instrument and not just an expense with a higher rate.
- Expenses compound monthly at their rate (`ExpenseBehavior`). A backtest
  replaces every expense's rate with that year's CPI (`applyBacktestRates`), and
  Monte Carlo's historical mode does the same (`applyRandomRates`).
- The tax tables start from the 2026 figures and are indexed each January by the
  run's inflation: plan inflation, or the year's CPI in a backtest
  (`TaxTable.inflateTaxes`).
- A plan starts in the current month, so its first year is usually partial: that
  year's TaxYear covers only the months inside the plan (`months`).
- The only account the engine reaches for on its own when a payer runs dry is
  the funding backstop, `FundTransfer.resolveFunding`: cash, savings, brokerage,
  then bonds. Retirement accounts are left out on purpose. There is no
  user-ordered fallback list (§6.4). Since #114 a dry backstop is reported as
  unfunded rather than disappearing.

## 2. The law, as of October 2026

To be checked against the IRS sources at build time. This area has changed
three times since 2021.

- **The credit** (IRC §36B, Form 8962). For each month of marketplace coverage:
  `credit = max(0, benchmark premium − expected contribution)`, never more than
  the premium of the plan actually bought. The benchmark is the second-lowest-cost
  silver plan (SLCSP) for the household. The expected contribution is the
  *applicable percentage* times household income, divided over twelve months.
- **Household income is ACA MAGI**: AGI plus untaxed Social Security, tax-exempt
  interest and excluded foreign income. The model has neither of the last two,
  so ACA MAGI = AGI + untaxed Social Security, which is exactly `magi.aca`.
- **Poverty line (FPL).** The credit for coverage year *Y* uses the HHS
  guidelines published in *Y − 1*, for the 48 contiguous states and D.C.:

  | Coverage year | Guidelines | One person | Each additional person |
  |---|---|---:|---:|
  | 2026 | 2025 | $15,650 | $5,500 |
  | 2027 | 2026 | $15,960 | $5,680 |

- **Applicable percentages.** Within each band the percentage rises in a
  straight line from the first figure to the second (Treas. Reg. §1.36B-3(g)):

  | Household income, % of FPL | 2026 (Rev. Proc. 2025-25) | 2027 (Rev. Proc. 2026-26) |
  |---|---|---|
  | below 133% | 2.10% | 2.15% |
  | 133% to 150% | 3.14% to 4.19% | 3.23% to 4.30% |
  | 150% to 200% | 4.19% to 6.60% | 4.30% to 6.78% |
  | 200% to 250% | 6.60% to 8.44% | 6.78% to 8.66% |
  | 250% to 300% | 8.44% to 9.96% | 8.66% to 10.22% |
  | 300% to 400% | 9.96% | 10.22% |
  | above 400% | no credit | no credit |

  Each year's table is indexed for premium growth in excess of income growth
  (IRC §36B(b)(3)(A)(ii)). From 2026 the premium measure also counts
  individual-market premiums (90 Fed. Reg. 27074).
- **Form 8962's arithmetic.** Household income as a percentage of the poverty
  line is rounded to a whole number (line 5), the applicable figure is the line's
  value there to four decimals (Table 2, line 7), and the annual and monthly
  contributions are whole dollars (lines 8a and 8b). The engine follows the form,
  working Table 2 in whole hundredths of a percent, with a point that falls
  exactly half way (5.395% at 175% for two people in 2026) rounded up. That tie
  rule is to be checked against the IRS's 2026 Table 2 when it is published; the
  other way costs about $12 a year at those points. The 100% and 400% limits are
  tested in dollars, as the statute states them, not on the rounded percentage.
- **The cliff is back.** The enhanced credits (ARPA 2021, extended by the IRA
  2022) removed the 400% limit and capped the contribution at 8.5%. They expired
  after 2025. As of late October 2026 no extension is law: the House passed a
  three-year extension (H.R. 1834) 230–196 on January 8, 2026, and the Senate
  has not passed one. So for 2026 and 2027 a household one dollar over 400% of
  FPL gets **no credit at all**:

  | Coverage year | One person | Two people |
  |---|---:|---:|
  | 2026 | $62,600 | $84,600 |
  | 2027 | $63,840 | $86,560 |

- **Keep the law as data.** The band tables, the cliff and the poverty lines are
  per-year parameters, so a revived enhanced schedule (0% up to 150%, an 8.5%
  cap and no cliff) is a table edit, not new code.
- **Below 100% of FPL** there is no credit (§36B(c)(1)(A)), unless the household
  enrolled with an advance credit paid on an estimate of 100% to 400%
  (Treas. Reg. §1.36B-2(b)(6)). It then keeps the credit, at the lowest band.
  Medicaid, which covers adults below 138% in expansion states, is not modeled
  (§11).
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
inherits everything an expense does: funding transfers, `Metric.EXPENSE`, the
Expenses list, Withdrawn.

| Field | Meaning | Default |
|---|---|---|
| Monthly premium | this plan year's premium for the plan actually bought, before any credit | — (required) |
| Benchmark premium | this plan year's SLCSP for the household, monthly | the monthly premium |
| Annual rate | how fast the premium and the benchmark grow | plan inflation (§13.4) |
| Household size | people in the tax household, for the poverty line only | 1 for Single, 2 for Married Filing Jointly |
| Advance credit | the share of the estimated credit paid to the insurer each month | 100% (§13.5) |
| Estimated income | the ACA MAGI reported to the marketplace for a year the household was not on it all of the year before | none (§5.2) |
| Start / finish | months of marketplace coverage | the start as entered → the December before the household turns 65 |
| Credit | on / off | on |

- **Premiums change once a year, in January.** Marketplace plans and the
  benchmark are priced by calendar year, so the card holds a year's premium
  flat and steps it each January at its rate, where other expenses compound
  monthly. The figures entered are for the plan year the card starts in.
- **The rate** defaults to plan inflation and is never below it by default. It
  is stored as the 0 that means "plan inflation", so it follows a change to the
  plan's inflation. The form labels it Premium Growth, says it defaults to
  inflation, and lets it be set, because marketplace premiums usually rise much
  faster. One rate serves every year; a
  known one-year renewal increase is entered by starting the card in the
  renewal year with that year's premiums (a "next year's premium" field is in
  §11).
- **Backtests and historical Monte Carlo** replace each expense's rate with the
  year's CPI. The card keeps its excess over plan inflation: the year's CPI plus
  (the card's rate − plan inflation). At the default rate that is the CPI
  itself, so the premium never falls behind the inflation the rest of the plan
  sees. Calibrated Monte Carlo already adds its deviation to the card's own
  rate.
- **Household size** comes from filing status unless the card overrides it. It
  changes only the poverty line; the model still has no dependents for anything
  else (§11).
- **The finish.** Ages advance each January in this model, so a household is
  65, and on Medicare, from the January of the year it turns 65. A card with no
  finish date of its own ends the December before, or at the plan's end if that
  is sooner. A later finish date the user enters is honored: with one household
  age, a younger spouse's coverage can only be modeled that way.
- **Several cards** count as one household, as Form 8962 sums a household's
  1095-A statements: each month's premiums and benchmarks are added, the credit
  is worked on the totals, and each card is advanced its share in proportion to
  its premium. The household size is the largest any card names.
- **Guardrails leave the card alone.** A spending cut or raise scales every
  other expense, but a premium is set by the plan year, not by spending, and the
  benchmark (and so the credit) is read from it.

**Why its own card and not an expense with a higher rate:** the engine needs to
know which expense *is* the marketplace premium, what the benchmark is, and when
coverage ends, to compute the credit. A separate card also lets the 65 boundary
close it, and lets "Worth it?" (§7) point at one thing.

### 5.2 The credit: advance, then reconciliation

Modelled as people actually receive it:

1. **Advance (monthly).** Before the month's bills are paid, the engine computes
   the month's credit from an *estimate* of the year's ACA MAGI, multiplies it by
   the card's advance share, and the accounts pay only the net premium. The
   estimate is the first of:
   - the ceiling, when a ceiling rule covers the year (Part B): the income the
     household tells the marketplace;
   - the previous year's recorded `magi.aca`, when a card covered all twelve
     months of it, as a household renewing reports its income;
   - the card's estimated income, as a household joining the marketplace
     states it;
   - none: nothing is advanced, and the whole credit arrives at reconciliation.

   Renewing needs a full year *on the marketplace*, not just a full year inside
   the plan. A household that retires in July has wages in that year, so
   renewing on it would understate the next year's credit and advance nothing.
   An estimate from 100% to 400% of FPL is advanced; any other is not, as the
   marketplace would not.
2. **Reconciliation (annual).** In the annual pass, after the true-up and NIIT
   and as its own pass for the same reasons NIIT is, the credit is recomputed
   from the year's actual `magi.aca`, over the months the card covered. Excess
   advance is repaid in full (no cap from 2026), and credit still owed is paid
   to the household. It is booked in January of the next year, like the
   true-up, and the TaxYear record carries it. Under the same $1 gate as NIIT,
   nothing is booked.
   - **The plan's first year, when partial, is settled against the estimate.**
     Its TaxYear covers only the months inside the plan, so its ACA MAGI is too
     low to test, and the plan cannot see the months before it began. The
     estimate stands in for the year's income, so an advance share under 100%
     still has the rest paid on the return. With no estimate that year gets no
     credit.

Booking:

- `FinancialPackage` gains `premiumTaxCredit` (the advance, positive) and
  `ptcReconciliation` (+ credit, − repayment). The package's `expense` is
  already net of the advance, so `premiumTaxCredit` is an "of which" figure,
  like `rothConversion`, and is never added to expenses again.
  `ptcReconciliation` is a federal tax field that may be positive, like
  `taxTrueUp`, and `federalTaxes()` includes it. Excess APTC is a tax
  (Schedule 2) and net PTC is a refundable credit (Schedule 3).
- The advance offsets the premium on the card itself: `HEALTH_PREMIUM` (gross)
  and `PREMIUM_TAX_CREDIT` (the advance) both roll up to `Metric.EXPENSE`, so it
  and cash flow carry the net premium the household paid, and the Expenses list
  shows both lines.
- A repayment is drawn through `settleOneSided` from the funding backstop, and
  what it books is what the accounts paid (`settled.paid`); the rest is reported
  unfunded. Credit owed is deposited where a refund would be.
- `TaxYear` gains `ptc` (allowed), `aptc` (advanced), `fplPercent` (null in a
  year no card covered), `ptcReconciliation` (what January booked) and
  `ptcOnEstimate` (a partial first year settled against the estimate), so "what
  did the credit come to in 2031" is read from the record and never recomputed.
- New EventTypes `PREMIUM_TAX_CREDIT` and `PTC_RECONCILIATION`, declared in
  `EVENT_RECONCILIATION` before anything emits them (an undeclared type throws
  mid-run), and named in `EXPENDITURE_TREATMENT`.
- New metric leaves `HEALTH_PREMIUM` and `PREMIUM_TAX_CREDIT` on the card, and
  `PTC_RECONCILIATION` (rolling straight to `FEDERAL_TAXES`, like NIIT) on the
  account that pays or receives the settlement. Each **must be in its
  instrument's `relevantMetrics()`**, the reconciliation in the backstop
  accounts' (`CapitalBehavior`, `IncomeAccountBehavior`): a metric that is not
  is a silent no-op (§9).

### 5.3 Past the published tables

- **Poverty line.** After the last published year it grows at the rate the run
  indexes the tax tables (plan inflation, or the year's CPI in a backtest), as
  HHS indexes it to the CPI. `TaxTable.priceLevels` records that index, one
  entry per January.
- **Applicable percentages.** After the last published year each figure moves
  by (1 + the card's rate) / (1 + plan inflation) a year (decision §13). That is
  the statute's adjustment for premium growth over income growth, measured with
  the card's own rate. At the default rate the factor is 1 and the percentages
  hold. Above it, the household's share of the benchmark stays roughly where it
  started, instead of the credit absorbing all of the premium's growth.
- **The cliff** stays at 400% of FPL.

## 6. Part B — the MAGI ceiling rule

### 6.1 The setting

A plan-wide rule beside guardrails, over an age span (decision §13.1):

| Field | Meaning | Default |
|---|---|---|
| MAGI | which `MagiPurpose` to hold down | ACA |
| Ceiling | a dollar amount, or a percentage of FPL | 400% of FPL when a health-insurance card exists |
| From age / until age | the years the rule applies | the retirement age / 65 |
| Margin | headroom kept back for income the rule cannot predict | 2% of the ceiling (decision §13.3) |
| Fall back to | the accounts that pay what a capped source cannot, in order | the fallback order (§6.4) |

A percentage of FPL stays a percentage. The dollar ceiling follows the FPL
table, indexed past the last published year as §5.3 says.

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
- **Redirecting:** what a capped leg cannot pay goes to the fallback order
  (§6.4), through the existing settlement path, so clamping, spillover and
  shortfall reporting all still apply.
- **When the fallbacks run dry, the bill is paid**: the capped source pays past
  the ceiling, and the year is reported (§6.3). A rule about income never leaves
  an expense unpaid (decision §13.3).
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

### 6.4 The fallback order

Part B needs an ordered list of accounts to pay what a capped source cannot.
The engine has none. Its only fallback is the funding backstop, a fixed list
that leaves out retirement accounts on purpose, so it cannot express "brokerage,
then cash, then Roth". A user-ordered fallback is a feature of its own with
uses beyond this rule (it is also the withdrawal order that other planners
offer), so it gets its own spec (decision §13.2) and Part B waits for it. Until
then a plan shows the credit (Part A) under whatever transfers the user sets.

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

**Two costs the engine does not charge yet**, so Phase 3 either charges them or
says so beside the result:

- **IRMAA.** A year's MAGI sets Medicare premiums two years later, and the
  larger RMDs a ceiling leaves behind raise it after 73. `magi.irmaa` is
  recorded, but nothing is charged.
- **The 10% early-withdrawal penalty** before 59½. The engine charges none, so
  an early retiree's IRA draws look cheaper than they are.

Without them the comparison favours keeping money in the IRA.

Picking the best ceiling from the sweep is the Maximizer's natural job (§4):
one number, about 30 runs. It is offered as a recommendation the user applies,
never applied automatically.

---

## 8. Presentation surfaces, enumerated

Spec 8 (NIIT) shipped a tax that was collected correctly and shown nowhere, then
found a sixth surface after the fix. All of these change. Phase 1 (#117) covers
every one except the parts that need the ceiling:

- The asset form: the card's fields (§5.1), the rate defaulting to plan
  inflation when left empty.
- Month & Year Details:
  - the Expenses list: Premium and Advance premium tax credit lines in the
    card's group;
  - the Taxes list: the reconciliation, as Premium tax credit;
  - the tax-year strip: the credit allowed and advanced, and ACA MAGI as % of
    FPL; ACA MAGI against the ceiling waits for Part B;
  - the January settlement note, which names a credit owed or repaid;
  - the ⚡ summary's tax-year table.
- Reports: a yearly block from the TaxYear record (allowed, advanced, settled,
  % of FPL), the reconciliation under Prior-Year Settlement, and the advance as
  a row of its own.
- The Taxes column (`TAX_TREE` in `asset-list.js`, guarded by
  `tax-tree-coverage.test.js`): a Premium Tax Credit row, summed over the
  trailing year like NIIT's.
- Spreadsheet columns: the premium, the advance and the settlement.
- The Flows view: a repayment is tax; the advance is left out, since the
  Treasury paid it.
- "What needs attention": a repayment nothing can pay, through the usual
  unfunded report; over the ceiling (§6.3) waits for Part B.
- Rules: an ACA section, and three items in the "Does Not Model" list (§11).
- Help.
- The MCP: `run_plan`'s report and `explain_month`. `build_plan` cannot create a
  card yet.

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
- **A backtest overwrites every expense's rate** with the year's CPI, and so
  does historical Monte Carlo. A rate the card needs must survive both (§5.1).
- **The first year is partial.** A TaxYear with fewer than 12 months is not a
  year's income (§5.2).
- **Guardrails scale every expense.** A rule that adjusts "expenses" must say
  whether the card is one (§5.1).
- **Table 2's half-way points** land either side in floating point. Work them in
  whole hundredths of a percent (§2).
- **The reconciliation shares the true-up's trace scope.** A reader that counts
  unpaid tax in that scope must tell a credit repayment apart from income tax
  (`tests/tax-years.mjs` does).
- **Predict before blessing** the snapshot, and **mutation-test** anything
  load-bearing. Green suites have hidden real bugs here more than once.
- **Plugin version** must be bumped in any PR that changes the bundle, and
  **static pages** updated in the same PR.

## 10. Fixtures

Built with Phase 1 (#117), each with a `reaches:` note in
`tests/tools/fixtures.mjs`:

- `aca-early-retiree-single`: an early retiree on IRA draws with no estimate, so
  the first year's whole credit comes on the return (the positive
  `ptcReconciliation` case); renewals after it.
- `aca-early-retiree-mfj`: a couple on a low-basis brokerage, so only the gain
  fraction reaches ACA MAGI, with Social Security from 2030, whose untaxed part
  is in ACA MAGI.
- `aca-partial-first-year`: the plan and the card start in October; the three
  months are settled on the estimate, 80% is advanced, and the renewal rule is
  reached.
- `aca-over-the-cliff`: a 401(k) closes in an advanced year, so that year is
  over the cliff and the whole advance is repaid; the card has no finish date
  and ends before 65.
- `aca-below-the-floor`: the under-100% exception, and the coverage gap where
  nothing was advanced.
- `aca-household-of-three`: the household-size override.
- `aca-repayment-unpayable`: a repayment the accounts can pay only in part; the
  rest is reported unfunded.
- **Silence:** every fixture without a card is unchanged. The snapshot prints
  the credit's TaxYear fields only for years a card covered.
- **The oracle**, `tests/aca-oracle.mjs`: an independent Form 8962, written from
  the form's lines. It holds the engine to the form on a grid of incomes,
  household sizes and premiums, and on every covered year and every advance of
  every `aca-*` fixture, the indexed years included. It also checks the backtest
  and historical-draw excess, the default finish, a card with the credit off,
  and the JSON round trip. It settled the rounding question: the engine follows
  the form (§2).

For Part B: an early retiree held under a 400% ceiling every year;
`aca-ceiling-breached`, where the fallbacks run dry, the year goes over the
ceiling, and the credit is repaid in full and reported; and
`aca-low-basis-brokerage`, where brokerage gains alone approach the ceiling.

## 11. Not in scope

Recorded here so they read as known gaps, not oversights; Rules lists the ones
that affect results:

- Cost-sharing reductions (below 250% of FPL): they lower deductibles, not
  premiums.
- Medicaid and the gap below 100% / 138% of FPL.
- State subsidies.
- Dependents, beyond the household-size override for the poverty line.
- Age rating of premiums: the card's inflation rate stands in. A later option
  could apply the federal default age curve.
- Employer-coverage affordability and the family glitch.
- Each spouse reaching Medicare separately (one household age).
- The self-employed health insurance deduction (IRC §162(l)), and its
  circularity with the credit (Rev. Proc. 2014-41).
- The Alaska and Hawaii poverty lines.
- A "next year's premium" field, for a renewal notice already in hand.
- **"Fill to the ceiling"** Roth conversions. The same room calculation run in
  reverse; worth its own spec.
- An IRMAA ceiling. The rule takes any `MagiPurpose`, but IRMAA reads year − 2
  and is a set of cliffs, so it needs its own presentation.

## 12. Phases and cost

| Phase | Delivers | PRs | Effort |
|---|---|---|---|
| **1. The card and the credit** | §5. The subsidy appears in the plan under the user's existing transfers, and so does what MAGI the plan actually produces. **Built in #117** | 1 | as estimated, most of it the law and the oracle |
| **2. The ceiling rule** | §6, with the yearly check and warning. Needs the fallback-order spec (§6.4) first | 2 | about 5–8 days |
| **3. Worth it?** | §7, and the ceiling sweep. Needs Phase 2, and IRMAA and the penalty charged or labelled | 1–2 | about 2–4 days |

In this repo's terms, 5–6 PRs about the size of #104 or #107. Phase 1 first:
it answers "how much is the subsidy?" before anything changes how the plan
draws money, and Phase 3 needs both.

## 13. Decisions

Recorded 2026-10-26.

1. **Where the ceiling lives:** plan-wide, over an age span. Early retirees will
   put a premium on this question, so it should not hide inside one phase.
2. **Fall-back order:** a feature of its own, specced separately. Part B waits
   for it (§6.4).
3. **Margin, and what happens when the fall-backs run dry:** as proposed. A
   margin of 2% of the ceiling; pay the bill and report the overshoot.
4. **The card's default inflation rate:** at least plan inflation, and editable,
   because healthcare premiums will usually rise far faster than plan inflation.
5. **The first year's advance estimate:** add an advance-credit share (default
   100%), with the estimate order in §5.2.
6. **Scope of the first PR:** Phase 1 alone. It answers the question without
   changing how the plan draws money.

Also decided:

- A household-size override, used only for the poverty line.
- Future applicable percentages are indexed with the card's own inflation input
  (§5.3).

Built in #117 and still open for review:

- §5.1: the January step, the backtest excess, guardrails leaving the card alone,
  and the default finish before 65;
- §5.2: the estimate order, renewing only after a full year on the marketplace,
  and the partial first year settled against the estimate;
- §2: the below-100% rule, and Table 2's half-way points rounded up.

One reading to confirm: decision 4's "at least plan inflation" is taken as the
default, not a floor, so a lower rate is accepted.

## 14. Prior art: ProjectionLab

ProjectionLab 4.6.0 (April 2026) ships all three parts:

- An "ACA Marketplace" type on a healthcare expense: the full premium, the SLCSP
  benchmark, household size (default 1 or 2), and an Advance Credit percentage
  (default 100%), with the reconciliation in the next year's tax balance.
  Healthcare expenses default to inflation + 2%.
- One plan-wide tax strategy with one target (a bracket, an IRMAA cliff, an FPL
  multiple or an income threshold). It converts to Roth and harvests gains up to
  the target, and past it draws from tax-free accounts ("withdrawal shielding")
  over a drawdown order the user sets.
- An Optimize search, and a heatmap comparing strategies.

This spec took the advance share and the household-size override from it. The
main difference is that their target also fills up to the ceiling with Roth
conversions, which §11 leaves to its own spec.

## Sources

- [IRS: premium tax credit FAQs, updated for 2026](https://www.irs.gov/node/15902) and
  [NATP: IRS updates premium tax credit for 2026](https://www.natptax.com/news-insights/blog/irs-updates-premium-tax-credit-for-2026/):
  repayment caps removed for tax years after 2025.
- [Wikipedia: Premium tax credit](https://en.wikipedia.org/wiki/Premium_tax_credit):
  expiry of the enhanced credits, return of the cliff.
- [The Finance Buff: 2026 and 2027 premium tax credit percentages](https://thefinancebuff.com/aca-premium-tax-credit-percentages.html)
  and [Current Federal Tax Developments: Rev. Proc. 2026-26](https://www.currentfederaltaxdevelopments.com/blog/2026/7/21/revenue-procedure-2026-26-technical-overview-of-2027-indexing-adjustments-for-premium-tax-credits-and-affordability-standards):
  the 2026 and 2027 applicable percentages and the indexing method (to confirm
  against Rev. Procs. 2025-25 and 2026-26).
- [HHS ASPE: 2026 poverty guidelines](https://aspe.hhs.gov/sites/default/files/documents/b1bfa16b20ae9b89d525bc35de7c1643/detailed-guidelines-2026.pdf)
  and [HHS ASPE: poverty guidelines](https://aspe.hhs.gov/poverty-guidelines): 2025 and 2026 guidelines.
- [NACo: House passes three-year extension](https://www.naco.org/news/house-passes-three-year-extension-aca-enhanced-premium-tax-credits)
  and [Taxpayers.net: 2027 ACA subsidy status](https://taxpayers.net/guides/aca-subsidy-status-2027):
  no extension enacted as of October 2026.
- [KFF: ACA insurers raising premiums by an estimated 26%](https://www.kff.org/quick-take/aca-insurers-are-raising-premiums-by-an-estimated-26-but-most-enrollees-could-see-sharper-increases-in-what-they-pay/)
  and [Becker's: where benchmark premiums are rising most](https://www.beckerspayer.com/?p=20290).
- [ProjectionLab: How to Navigate ACA Premiums](https://projectionlab.com/blog/navigating-aca-premiums)
  and [ProjectionLab changelog](https://projectionlab.com/changelog): their ACA and tax-strategy design.
