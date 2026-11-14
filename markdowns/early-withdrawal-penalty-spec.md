# Spec 13 — The early-withdrawal penalty: 10% before 59½

Status: **PROPOSED 2026-10-29. Spec only, no code.** John decides §15. Spec 12's
Phase 2 waits for this spec's Phase 1 (spec 12 decision §11.5), and spec 11's
Part C needs the penalty charged or labelled (spec 11 §7).

Before 59½ the law adds a 10% tax to most distributions from an IRA or a 401(k),
on top of the income tax, and then excuses a list of cases (IRC §72(t)). The
engine charges none of it and has no concept of 59½. On 2026-10-29 John answered
spec 12's §11.5: "Better to model reality, which allows early withdrawal with
penalty." This spec charges it on every early distribution, whatever moved it,
with the exceptions the plan can show.

Five rules hold throughout:

- **Charged, never prevented.** Early withdrawal stays allowed. The engine
  charges what the law charges and never refuses, caps or redirects a draw
  because of the user's age.
- **Every early distribution, counted in one place.** A transfer rule's draw,
  spec 12's order, a close and the withholding itself are all counted by one
  month-end sweep over the account's distribution ledger, never by a hook on
  each path.
- **Only money that left the shelter.** A Roth conversion, or a move into
  another IRA or 401(k), is not charged. Withholding at source already uses that
  test.
- **Exceptions the plan can show, and the user's word for the rest.** The
  separation-from-service exception is read from the plan where it can be and
  stated on the account where it cannot. 72(t) payments are a schedule the user
  sets up. Every other exception is a listed gap.
- **Said, not silent.** A year that pays the penalty says so, and so does an
  exception that spares it.

---

## 1. What exists

### 1.1 Nothing charges it

Re-checked on main 21603db (the engine is unchanged since 68d34bd):

- No code mentions 59½ outside one comment (`policy-constants.js:23`), and
  nothing mentions §72(t). Every `penalt*` match is a Maximizer fitness term
  (`volatilityPenalty` and `debtPenalty` in `js/simulator.js`) or prose: the
  backstop comment (`instrument.js:131-134`), the allocation gate's comment
  (`policy-constants.js:23-26`) and an RMD-shortfall note
  (`portfolio-issues.js:353`).
- Rules lists the gap: "No early-withdrawal penalty" (`rules.html:697`). So does
  the plugin, in its skill (`plugin/skills/charting-finance/SKILL.md:332`, whose
  link to `policy-constants.js:39` is stale: the constant is at line 28) and its
  README (`plugin/README.md:18`).
- A probe on 2026-07-25 found `rmdAge()` (`js/user.js:48`) the only age gate.
  The engine now reads the user's age in six places, and none is a penalty:

| Rule | Where | Age |
|---|---|---|
| RMDs begin | `User.rmdRequired()` and `rmdAge()`, `user.js:44` | 72, 73 or 75, by birth year |
| Catch-up contributions | `TaxTable.limitFor`, `taxes.js:933` | 50 |
| The senior deductions | `TaxTable.ageDeductions`, `taxes.js:781` | 65 |
| Social Security's earliest claim (#121) | `SOCIAL_SECURITY_EARLIEST_AGE`, `plan-dates.js:63` | 62 |
| Marketplace coverage ends (#117) | `MEDICARE_AGE`, `plan-dates.js:40` | 65 |
| Tax allocation may reach an IRA or 401(k) (spec 4a) | `global_deferred_allocation_age`, `policy-constants.js:28`, read by `isAllocationEligible`, `tax-allocation.js:103` | 60 |

The last is the only one about 59½. It decides who pays a share of the
household's tax, not what a draw costs, and its comment says why it is 60: it
"never reaches money that could still carry the early-withdrawal penalty."

### 1.2 Where a distribution is booked

Two halves, both required (the docstring on `ModelAsset.recordDistribution`):

- **The household's package.** `FinancialPackage.recordTransfer`
  (`financial-package.js:349`) classifies a movement by its source instrument
  into `tradIRADistribution`, `four01KDistribution` or `rothIRADistribution`.
  `recordConversion` (`:379`) records `rothConversion`, the part of the first two
  that went into a Roth: an "of which" figure, never income in its own right.
- **The account's ledger.** `ModelAsset.recordDistribution`
  (`model-asset.js:958`) adds to `TRAD_IRA_DISTRIBUTION`, `FOUR_01K_DISTRIBUTION`
  or `ROTH_IRA_DISTRIBUTION`. The RMD check reads this one.

The paths that book a tax-deferred distribution:

| Path | Code | Can it be before 59½? |
|---|---|---|
| A bill's transfer rule naming the account | `ExpenseEngine`, `expense-engine.js:57-67` | yes; the only path the probe found (§1.6) |
| A one-sided rule: mortgage, carrying cost, escrow, a tax | `FundTransfer.settleOneSided`, `fund-transfer.js:248`, booked by each caller | yes |
| A rebalance or conversion rule | `RebalanceEngine`, `rebalance-engine.js:71-83` | yes; a move into a Roth, IRA or 401(k) is marked sheltered (`_trackDistribution`, `:136`) |
| The withholding at source on any of these | `TaxEngine.#withholdInScope`, `tax-engine.js:140-149` | yes |
| A close, by the account's own finish date or a life event | `applyDeferredCloseDistribution`, `tax-engine.js:378` | yes |
| An RMD top-up | `ensureRMDs`, `expense-engine.js:253-301`, which writes the package directly | no: RMDs begin at 72 or later |
| A tax allocation leg (spec 4a, off by default) | `#settleAllocatedLeg`, through `settleOneSided` | no: from 60 only |
| Spec 12's walk, once built | a leg of its `drawFromFallbacks` | yes, once a user switches a tax-deferred account on |

Every path writes the account's distribution metric. That is why the
withholding sweep reads the metric instead of hooking the paths
(`tax-engine.js:71-89`). An account that runs to the plan's end never closes
(`tests/tools/fixtures.mjs`, `deferred-close-distribution`), so a plan's last
month distributes nothing.

### 1.3 The 10% withheld at source is not the penalty

- `global_retirement_withholding_rate` (`policy-constants.js:17`) withholds 10%
  of every IRA and 401(k) distribution: the custodian's default when the holder
  files no Form W-4R election (PR #23). It prepays income tax. The annual
  true-up counts it as paid (`#settleAnnualDifference` sums `yearly.incomeTax`,
  `tax-engine.js:796`) and refunds any excess.
- On a real return, withholding is credited against the whole tax, the
  additional tax included. So the 10% withheld often pays part of a penalty in
  cash, but it is not the penalty. In a year when it is more than the income
  tax, the engine refunds the excess, where the law would keep it toward the
  penalty and still ask for the rest.
- **The withheld dollars are themselves a distribution**
  (`tax-engine.js:140-149`). A $5,000 draw costs the account $5,555.56. The
  penalty is charged on that gross, which is why July's $27,000 is $30,000
  today (§1.6).
- Conversions and moves into another IRA or 401(k) are not withheld:
  `monthlyShelteredDistribution` holds them, and the sweep subtracts it
  (`tax-engine.js:99-116`).

### 1.4 Where a yearly additional tax lands

The January 1 pass settles the year before (`portfolio.js:1009-1062`), in this
order: the true-up (`applyAnnualTaxTrueUp`, `tax-engine.js:736`), NIIT
(`applyAnnualNIIT`, `:625`), the premium tax credit's reconciliation, and then
the year's record (`#recordTaxYear`, `portfolio.js:1113`).

NIIT is the precedent for a second federal tax computed once a year:

- **its own pass after the true-up.** The call site gives two reasons
  (`portfolio.js:1038-1045`): the true-up reads what was withheld from the yearly
  package, so a charge booked first would shrink the April bill by its own
  amount; and the true-up has six early returns;
- **its own EventType**, `NIIT_ASSESSED`, declared in all three tables that
  throw mid-run on an undeclared type;
- **its own package field**, `niit`, in `FEDERAL_TAX_FIELDS`
  (`financial-package.js:30`) and summed by `federalTaxes()` (`:243`);
  `tests/tax-sign-convention.mjs` holds the sum to the list;
- **its own metric**, `NIIT`, rolling straight to `FEDERAL_TAXES`, on the account
  that paid;
- **two TaxYear fields**, `niit` (owed) and `settledNIIT` (booked);
- **the funding backstop pays it** (`resolveFunding`, then `settleOneSided`).
  When nothing can, `reportUnfunded` records it on `#unfundedTaxAnchor`, the
  largest account.

The pass runs before `yearlyChron` ages the user (`chronometer.js:147-150`), so
`activeUser.age` in it is still the settled year's. Its events are dated
December of that year (the 2026 NIIT in `niit-from-a-deferred-draw.snap` is
dated 2026-12), and its bookings land in January's package.

### 1.5 Ages

- **Current Age** is "your age in the plan's first month" (`globals.html:50`).
  The birth year is that month's year less the age (`portfolio.js:189-200`), and
  the user ages a year every January (`addYears(1)`, `portfolio.js:581`).
  `User.addMonths` has no caller, so `User.month` stays 0.
- **Every age-dated rule reads January.** A life event fires in January of the
  year of its age (`ageToDateIntFor`, `plan-dates.js:55`), Social Security pays
  from January of the year the user turns 62, and marketplace coverage ends in
  December of the year before 65.

### 1.6 What a probe measured

A read-only probe (method in Sources) recorded every IRA, 401(k) and Roth
distribution the engine booked, with its account, month and path, and what
moved into another shelter. It priced 10% under the three readings of §4.

**The corpus: nothing.** None of the 47 fixtures on main 21603db draws an IRA,
401(k) or Roth before 59½, under any reading. The snapshot check stayed
unchanged with the probe loaded. The earliest any fixture draws one is the year
its user turns 60 (`aca-early-retiree-single`). So no fixture reaches anything
this spec adds (§11).

**The quick-start profiles, retired early**, as the Retirement Age move and
`quick_start_report` allow, with the clock pinned to 2026-01-15 as the snapshot
pins it. Draws are counted before July of the year the user turns 59 (§4):

| Plan (start / retire / finish) | IRA or 401(k) draws before 59½ | 10% of them | Spared by the separation exception | Income tax owed, same years | Roth draws before 59½ |
|---|---:|---:|---:|---:|---:|
| Mid Career 45/55/90 | $123,873 | $12,387 | all | $2,249 | $52,030 |
| Mid Career 57/58/95 | $25,287 | $2,529 | all | $0 | $0 |
| Pre-Retirement 55/55/90 | $77,082 | $7,708 | all | $67 | $46,249 |
| Pre-Retirement 55/57/90 | $44,127 | $4,413 | all | $41 | $26,476 |
| Dual Income 45/55/90 | $156,903 | $15,690 | all | $678 | $0 |
| Couple Nearing Retirement 55/55/90 | $123,652 | $12,365 | all | $598 | $47,695 |
| Couple Nearing Retirement 55/57/90 | $70,787 | $7,079 | all | $608 | $27,304 |
| Early Career 35/50/90 | $232,001 | $23,200 | none | $0 | $0 |
| Young Couple 35/50/90 | $296,961 | $29,696 | none | $0 | $0 |

- **Every early draw comes from a bill's transfer rule naming a 401(k)** (Living
  Expenses, and Mid Career's Rent), plus the 10% withheld on it. No profile draws
  an IRA early, converts early or closes a deferred account early.
- **The separation exception decides almost everything.** Each profile retired
  at 55 or later leaves the job that pays into its 401(k) in or after the year it
  turns 55, so the exception (§6.1) spares every dollar. Retired at 50, it
  spares nothing.
- **The penalty dwarfs the income tax.** The profiles' early 401(k) draws mostly
  fit under the standard deduction, so the income tax is near zero while the 10%
  starts from the first dollar. Without the exception, Pre-Retirement 55/55
  would pay $7,708 of penalty against $67 of income tax.
- **The Roth draws never exceed the Roth's opening balance plus what the plan
  put in.** They are tax-free if that balance is all contributions and taxable
  if it is all earnings, and the engine cannot say which (§7).

**July's scenario, rebuilt.** The probe of 2026-07-25 that spec 12 §4.4 cites
found $27,000 owed and none charged on this plan: single, retired at 55, $5,000
a month of living expenses paid from one $1.2 million account, with no growth,
no inflation, no salary and no other account. On today's engine:

- the account pays $5,555.56 a month with the withholding, so the 54 months
  before July of 59 come to $300,000, and 10% to **$30,000** ($33,333 if every
  month of the year turning 59 counts);
- the income tax owed in 2026 to 2030 is $29,183 (about $5,837 a year), so the
  uncharged penalty is 103% of it. July measured 134%, before PR #23 made the
  withheld dollars part of the draw;
- **as an IRA it is owed in full. As a 401(k) from a job left in or after the
  year the user turned 55, it is $0.** The scenario that motivated this spec is
  the textbook case of the exception. Its plan has no salary, so the engine
  cannot see the separation, and the account has to say so (§6.1);
- the plan has no everyday account, so every year's $830 true-up refund is
  dropped today (a SANITY line, "could not be credited"), and the penalty would
  be reported unfunded (§5.4).

## 2. The law, as of October 2026

To be checked against the IRS sources at build time.

- **The tax.** 10% of the part of a distribution from a qualified plan or an IRA
  that is includible in gross income (IRC §72(t)(1)). With no after-tax money in
  either account, as in this engine, that is the whole distribution. It is
  figured on Form 5329, Part I: line 1 the early distributions, line 2 the part
  an exception covers (with the exception's number), line 4 10% of the rest. It
  goes to Schedule 2, line 8, as part of the year's total tax, against which all
  withholding is credited.
- **The age.** A distribution on or after the date the owner attains 59½ is not
  early (§72(t)(2)(A)(i)).
- **Not early distributions.** A rollover into another IRA or plan (§402(c),
  §408(d)(3)). A Roth conversion is taxable but exempt from the 10%
  (§408A(d)(3)(A)(ii)), unless the converted money is withdrawn within five years
  and before 59½ (§408A(d)(3)(F)).
- **Roth.** A qualified distribution, five years after the first Roth
  contribution and at 59½ or later (or on death, disability or a first home), is
  free of tax (§408A(d)(2)). Otherwise the ordering rules apply
  (§408A(d)(4)(B)): contributions come out first, free of tax and penalty; then
  conversions, oldest first, charged the 10% within five years of each but not
  taxed again; then earnings, taxed and charged the 10%.
- **The exceptions**, from the IRS's table (reviewed 2025-12-11):

| Exception | Code | 401(k) | IRA | Limit |
|---|---|:---:|:---:|---|
| Separation from service in or after the year of turning 55 | §72(t)(2)(A)(v) | ✓ | | the plan of the employer left |
| Qualified public safety employees, from 50 | §72(t)(10) | ✓ | | governmental plans |
| Substantially equal periodic payments ("72(t) payments") | §72(t)(2)(A)(iv) | ✓ | ✓ | |
| Death, paid to a beneficiary | §72(t)(2)(A)(ii) | ✓ | ✓ | |
| Disability | §72(t)(2)(A)(iii) | ✓ | ✓ | |
| Unreimbursed medical expenses above 7.5% of AGI | §72(t)(2)(B) | ✓ | ✓ | the excess |
| Health premiums while unemployed | §72(t)(2)(D) | | ✓ | |
| Higher education | §72(t)(2)(E) | | ✓ | |
| First home | §72(t)(2)(F) | | ✓ | $10,000 lifetime |
| Birth or adoption | §72(t)(2)(H) | ✓ | ✓ | $5,000 a child |
| Emergency personal expense | §72(t)(2)(I) | ✓ | ✓ | $1,000 a year |
| Domestic abuse victim | §72(t)(2)(K) | ✓ | ✓ | the lesser of $10,000 or 50% |
| Qualified disaster | §72(t)(2)(M), §72(t)(11) | ✓ | ✓ | $22,000 |
| Terminal illness, a divorce order (QDRO), an IRS levy, military reservists, corrective distributions, returned IRA contributions, ESOP dividends, automatic-enrollment refunds, emergency savings accounts | various | | | see the table |

- **72(t) payments** (Notice 2022-6): an annual amount by one of three methods
  (required minimum distribution, fixed amortization, fixed annuitization), with
  an interest rate no higher than the greater of 5% or 120% of the federal
  mid-term rate and the IRS's life-expectancy tables. The payments must continue
  until the later of five years after the first or 59½. A one-time switch to the
  RMD method is allowed. Any other change before then, an extra withdrawal
  included, brings back the 10% on every earlier payment, with interest, in the
  year of the change (§72(t)(4)).
- **Separation from service.** The IRS's wording is "separates from service
  during or after the year the employee reaches age 55". It covers only the plan
  of the employer left, never an IRA, and money rolled into an IRA loses it.
  Qualified public safety employees qualify from 50 (§72(t)(10)), and SECURE 2.0
  widened that group.

## 3. Prior art

**Boldin.** Its release notes say that as of October 15, 2026 its projections
include "the 10% additional tax on retirement account withdrawals taken before
age 59½". The note names no exception. Boldin's guides explain the separation
exception and 72(t) payments, and nothing public says the planner applies
either.

**ProjectionLab** (changelog):

- 2.5.0, February 2022: an account that carries early-withdrawal penalties can be
  set to permit no early withdrawals, and early-withdrawal ages refer to the age
  at the start of each simulated year.
- 2.6.0, February 2022: a warning for years in which early-withdrawal penalties
  are incurred. Its help page shows the warning listing the ages (for example 52
  to 55) and sends the user to the account's liquidity settings and the drawdown
  order.
- 3.4.0, October 2022: 72(t) payments for US retirement accounts, by the RMD
  method, fixed amortization at an entered rate, or a custom amount, starting at
  the retirement milestone by default; and liquidity settings that block
  withdrawals until an age or a milestone.
- 4.2.2 and 4.2.3, early 2025: the tax on non-qualified 72(t) distributions from
  Roth accounts, and 72(t) payments with withholding settings.
- No public page names the separation exception as a setting.

This spec's brief said mainstream planners model at least the Rule of 55 and
72(t). That is half right: ProjectionLab has modelled 72(t) payments since 2022,
and neither product documents the separation exception.

What this spec takes: the penalty charged (Boldin); 72(t) payments as a schedule
on an account (ProjectionLab); the years that pay the penalty named in a warning
(ProjectionLab). What it adds: the separation exception read from the plan
itself, since the engine knows which salary pays into which 401(k) and when that
salary ends.

## 4. The age

### 4.1 Three readings

The engine knows a birth year, not a birthday (§1.5). Three ways to read 59½:

| Reading | A month is early when it is | Used today by |
|---|---|---|
| **Under 60** | in or before the year the user turns 59 | spec 12's default "from age" for a tax-deferred account; `global_deferred_allocation_age` |
| **Before July of 59** | before July of the year the user turns 59 | nothing yet: the January birthday every age rule here assumes, plus the half year |
| **Under 59** | before the year the user turns 59 | nothing |

### 4.2 What each gets wrong

Two errors stack. The month of the birthday is unknown. And Current Age is the
age in the plan's first month, so for a user whose birthday is still to come
that year, the engine's birth year is a year late. By December they are a year
older than the engine thinks.

The second error is not this spec's. It moves every age rule a year late for
those users (catch-up contributions, the senior deductions, the RMD year,
Social Security at 62), and Rules does not list it (§12).

Worked out (not measured) over every birth month and every plan-start month as
equally likely, with a birthday taken as mid-month, the months each reading
charges against the months the law charges:

| Reading | One user, at worst | On average |
|---|---|---|
| Under 60 | 5½ months too few to 16½ too many | 5½ too many |
| Before July of 59 | 11½ months too few to 10½ too many | ½ too few |
| Under 59 | 17½ months too few to 4½ too many | 6½ too few |

In dollars the readings differ by about a tenth. July's scenario owes $33,333,
$30,000 or $26,667; Mid Career 45/55 owes $13,872, $12,387 or $10,925 before the
exception spares it.

### 4.3 Proposal: before July of the year the user turns 59

- **It is the engine's own birthday plus the law's half year.** Every age-dated
  rule here already treats a birthday as January. Read that way, 59½ falls in
  July of the year the user turns 59. On average it is right, and Rules says what
  it cannot know.
- **The gates stay at 60.** Spec 12's default "from age" and
  `global_deferred_allocation_age` keep 60. Under this reading neither can ever
  draw or allocate a charged month; each holds back six months it could use (July
  to December of the year the user turns 59). A gate says when an account may be
  drawn. This spec says what a draw costs.
- **Month by month.** A distribution is classified in the month it is booked, by
  the month-end sweep, where the month and the age agree. Never from
  `activeUser.age` in the January pass, which still holds the settled year's age
  (§1.4).
- **The exact fix is a birth month** beside Current Age. It would make this
  reading exact to the month, and correct the year-late birth year for every age
  rule. That is its own spec (decision §15.1).

## 5. What is charged

### 5.1 The base

- **10% of the year's early distributions from IRAs and 401(k)s, less what an
  exception covers.**
- **Gross:** what left the account, the withholding at source included.
- **Only what left the shelter.** A move into a Roth (a conversion) or into
  another IRA or 401(k) is not charged.
  - On the rebalance path it is already marked, by `monthlyShelteredDistribution`.
  - On the close path it is not. A closing account's close transfer into a Roth
    is recorded only as `rothConversion` (`portfolio.js:949`), and one into an
    IRA is recorded nowhere. Phase 1 marks both, so a close is charged on its
    balance less what its close transfers move into a shelter. When the whole
    balance goes to a Roth, that leaves exactly the tax withheld at the close,
    which the law charges too: the part of a conversion kept back for tax is a
    distribution.
  - A 401(k) moved into an IRA is a rollover, and the engine taxes it as income
    today: a $400,000 rollover added $400,000 to MAGI in the MAGI evaluation.
    This spec does not fix that, but it never charges the 10% on a rollover, so
    it does not double the error (decision §15.7).
- **Never charged:** a Roth draw (§7), an RMD, a tax allocation leg. The last
  two cannot be early today (§1.2), and Phase 1 asserts it: a lower gate would
  make an allocation leg early.

### 5.2 Counted by the withholding sweep

- **One step added to the withholding sweep's loop**
  (`withholdOnDeferredDistributions`, `tax-engine.js:90`). For each IRA and
  401(k), at month end and after its withholding, the month's distribution that
  left the shelter (`eligible`, plus the withheld dollars the account supplied)
  is early if the month is before July of the year the user turns 59.
- **What is early is booked twice.** On the account, as a new leaf metric,
  `EARLY_DISTRIBUTION`. In the package, as a new field, `earlyDistributions`:
  like `rothConversion`, an "of which" figure of `tradIRADistribution` and
  `four01KDistribution`, never income in its own right. What an exception covers
  is booked the same way (`earlyDistributionsExcepted`), with the exception
  named.
- **One loop, not a second sweep.** The withholding sweep consumes and zeroes
  `monthlyShelteredDistribution` for every IRA and 401(k), and only then skips
  the closed ones (`tax-engine.js:96-102`). A sweep after it would see no
  shelter, and one that skipped closed accounts would miss every close. The
  account that closed this month is classified in the same loop, before the
  skip.
- **The metric, not the paths.** Every path writes the metric (§1.2), so a path
  added later, spec 12's walk included, is charged with no work.

### 5.3 The January charge

- **A pass of its own after NIIT**, built like NIIT's (§1.4):
  `TaxEngine.applyAnnualEarlyDistributionTax` reads the settled year's
  `earlyDistributions` less `earlyDistributionsExcepted` and charges 10%, with
  the same $1 gate, opening its trace scope only when something is due.
- **A new EventType**, for example `EARLY_DISTRIBUTION_TAX`, with
  `data: { base, excepted, rate, accounts }`. It is declared in
  `EVENT_RECONCILIATION` (`portfolio.js:41`, one-sided), `EXPENDITURE_TREATMENT`
  (`annual-expenditure.js:62`, tax) and `FLOW_TREATMENT` (`money-flows.js:127`,
  tax), and rendered by `renderNote` under `tests/memo-vocabulary.mjs`, all
  before anything emits it.
- **A new tax field**, `earlyDistributionTax`, in `FINANCIAL_FIELDS` and
  `FEDERAL_TAX_FIELDS`, stored negative and summed by `federalTaxes()`; and a
  metric, `EARLY_DISTRIBUTION_TAX`, rolling straight to `FEDERAL_TAXES` as `NIIT`
  does, on the account that paid.
- **TaxYear** gains `earlyDistributions`, `earlyDistributionsExcepted`,
  `earlyDistributionTax` (owed) and `settledEarlyDistributionTax` (booked), and
  `federalTax` includes the tax owed. The snapshot prints them only for a year
  with an early distribution, as it prints the premium tax credit only for a
  year a card covered.
- **Who pays:** the funding backstop, through `settleOneSided`. When nothing
  can, `reportUnfunded` records it on `#unfundedTaxAnchor`. Never the IRA or
  401(k) whose draws caused it (decision §15.9): paying from that account before
  59½ would itself be an early distribution, charged the next year. Once spec
  12's order exists, the order in force pays, as for any tax.

### 5.4 Why a pass of its own

Inside the true-up's liability would match the return better: one balance due,
with withholding credited against both taxes. Against it:

- the true-up's event would carry two taxes, and splitting its settlement back
  into income tax and penalty is an allocation the engine would be making up
  (rule notes, rule 2);
- the penalty would vanish into "Estimated and true-up" in the Taxes list and
  into the true-up in Reports, the way NIIT was once collected and shown nowhere
  (spec 8);
- the true-up has six early returns.

The cost of a separate pass: a refund the true-up cannot credit is not netted
against the penalty. That happens only in a plan with no everyday account at
all. July's plan drops its $830 refund every year today, and would report $6,667
a year unfunded where the return would net $5,837. Decision §15.2.

## 6. Exceptions

### 6.1 Separation from service at 55: Phase 1

- **Why first:** in the probe it spares the whole early base of every profile
  retired at 55 to 58 (§1.6). It is the standard bridge for an early retirement
  from a job with a 401(k).
- **Which 401(k).** One that a working income in the plan pays into, by a payroll
  transfer in any phase or by the income's own transfers. That income's last
  month is the separation. The exception applies when that month falls in the
  year the user turns 55 or later, and covers the 401(k)'s draws from that month
  on. A salary a life event closes and one that reaches its finish date both
  count.
- **A 401(k) that no income in the plan pays into** is from a job that ended
  before the plan began, or the plan starts in retirement, as July's does. The
  engine cannot see when that job ended, so the account carries the user's
  statement: one field on a 401(k), "Left this employer in the year I turned
  __", read in whole years as §4 reads every age. Left empty, its early draws are
  charged, and a notice points at the field (§9). Decision §15.3.
- **Never an IRA.** An IRA's early draws are charged in the same years a
  401(k)'s are spared, and a 401(k) closed into an IRA leaves its money charged
  from then on. That is the law's own trap, and the notice says so when it bites.
- **Several 401(k)s.** Each follows its own employer's income. An old employer's
  401(k) that the plan also draws is charged unless its field says it was left
  at 55 or later.
- **A married household** has one age (Rules). 401K A follows Salary A and 401K B
  follows Salary B, both read against that one age.
- **Public safety employees at 50** are a gap; the same field could carry them
  later.
- **Where it lives.** The derived separation is computed on each run, never
  stored. The stated field travels with the account: `ModelAsset.toJSON` and
  `fromJSON` (which copies fields by name, so a field missing there is dropped on
  every load), the share link (inside `modelAssets`), Monte Carlo workers (which
  see only their payload, and get it the same way), `build_plan` and
  `plan_defaults`. The form shows the field only on a 401(k) that no income in
  the plan pays into; on the others it shows the derived separation, read-only.

### 6.2 72(t) payments: Phase 2

- **Why:** they are the bridge for a retirement before 55, or from an IRA, the
  two cases §6.1 cannot cover. Early Career and Young Couple retired at 50 owe
  $23,200 and $29,696 without them.
- **The schedule**, on an IRA or 401(k): the method (fixed amortization or the
  RMD method), the first month, the interest rate (no higher than Notice 2022-6
  allows), the life-expectancy table, and the account the payments go to.
- **The amount** is figured in the first month from the balance at the end of
  the month before, and paid in twelve monthly parts. Fixed amortization holds
  it; the RMD method figures it again each January. The one-time switch from
  amortization to the RMD method is allowed.
- **Spared** while the schedule runs unchanged, until the later of five years
  after the first payment or 59½, read as §4 reads it.
- **Broken** by any other distribution from that account before then: a rule's
  draw, the order's, a close or a conversion. The engine allows it, charges the
  10% on every earlier payment with interest in that year (§72(t)(4); the
  interest rule to be checked at build), and says so.
- **New pieces:** a scheduled distribution, which no transfer rule can express
  (rules are percentages of a balance or a bill); the single-life table (the
  engine has only the RMD table); the schedule in the asset form, the JSON, the
  share link and the MCP.

### 6.3 The rest: gaps, listed in Rules

| Exception | What the engine would need | Here |
|---|---|---|
| Death | nothing: a plan ends at its finish age without distributing (§1.2), and there are no inherited accounts | does not arise |
| Disability | an event the plan does not have | gap |
| Medical expenses above 7.5% of AGI | medical spending. The ACA card's premium is one, but the part that counts depends on the premium tax credit, the circularity spec 11 §11 left out for the self-employed deduction | gap |
| Health premiums while unemployed (IRA) | unemployment benefits | gap |
| First home (IRA, $10,000) | a first-time-buyer flag on a home whose down payment an IRA pays | gap; a cheap follow-up |
| Higher education (IRA) | an education expense | gap |
| Birth or adoption, an emergency expense, domestic abuse, terminal illness, a disaster | an event, each with its own cap | gap |
| A divorce order, an IRS levy, military reservists, corrective distributions, returned contributions, ESOP dividends, automatic-enrollment refunds, emergency savings accounts | instruments or events the engine does not have | gap |

Every gap is pessimistic: the engine charges what the exception would spare.
Rules says so in one line. There is no switch that turns the penalty off
(decision §15.6).

## 7. Roth

- **Today every Roth withdrawal is free of tax and penalty, at any age.** A Roth
  has no contribution basis: `BASISABLE` is the taxable account and real estate
  (`instrument.js:150`), and a deposit adds basis only to the taxable account
  (`model-asset.js:887-898`). The plan records Roth contributions
  (`ROTH_IRA_CONTRIBUTION`) and conversions (`rothConversion`), but neither the
  contributions made before it nor any five-year clock. The `roth-tax-free` note
  (`rule-notes.js:129`) says "Qualified Roth withdrawals are tax-free" on every
  Roth that paid anything, at any age.
- **Measured.** The probed profiles draw $26,476 to $52,030 from a Roth before
  59½ (§1.6), never more than its opening balance plus what the plan put in. If
  that balance is all contributions, nothing taxable came out; if it is all
  earnings, nearly all of it did. No input says which, so the gap cannot be
  measured from a plan.
- **Proposal (decision §15.5): a disclosed gap in Phase 1, and Roth basis here
  as Phase 3.**
  - Phase 1 corrects the note. Before 59½ it says the plan treats every Roth
    dollar as a contribution, which comes out free at any age, and that earnings
    withdrawn early would be taxed and charged 10%. Rules gains the line spec 12
    §4.4 asked for.
  - Phase 3: a contribution basis on the Roth (the taxable account's basis field,
    so `BASISABLE` gains the Roth), defaulting to the whole opening balance so
    that no plan moves until its user enters less. Contributions made in the plan
    add to it. Each conversion is a layer with its own five-year clock. A draw
    takes contributions first, then layers, oldest first, then earnings
    (§408A(d)(4)(B)). Earnings before 59½ are taxed and charged; a layer within
    its five years is charged but not taxed again. The first-contribution clock
    defaults to satisfied, with a field to say otherwise.
  - Why not in Phase 1: spec 12's Phase 2 waits only for the IRA and 401(k)
    charge, and the default that keeps today's numbers (all contributions) is the
    same either way.
- **The Roth ladder** (convert, wait five years, withdraw) and spec 11 Part B's
  "Roth last" are exact only from Phase 3. Until then a ladder pays out at once in
  the engine, and Rules says so.

## 8. The optimizer

- **The fitness** (`Simulator.calculateFitness`, `simulator.js:167-209`) is
  lifetime spending (`yearlySnapshots[].annualExpense`) and the ending value
  (`finishValue()`), less a share for guardrail preservation cuts and for
  negative balances. Its genes are every phase's transfer percentages. Nothing in
  it prices an early draw, so a retire phase that starts at 55 can raise its
  401(k) share for free.
- **Paid, the penalty needs no new term.** It leaves an account, so the ending
  value falls; investable assets fall, so the guardrails' withdrawal rate rises
  and preservation cuts come sooner. The Maximizer will move early spending
  toward the brokerage, cash or a Roth where the plan has them.
- **Unpaid, it costs nothing.** An unfunded report moves no money, so the
  fitness never sees it, and the money left in the 401(k) raises the ending
  value. That is already true of every unfunded bill, but the penalty makes it
  likelier: July's plan, spending only from a 401(k), has no everyday account to
  pay it with. Proposal: a fitness term for unfunded obligations, shaped like
  `debtPenalty` (decision §15.8).
- **The lever it lacks.** One percentage per phase cannot stop drawing the 401(k)
  until 59½ inside a retire phase that runs from 55 to 90. That takes a phase at
  60 (spec 14) or spec 12's "from age", and the Maximizer does not add phases.
- **Its recommendations** (`simulator.js:257-428`) name the penalty where a
  recommended transfer draws an IRA or 401(k) in a phase that begins before 60:
  counted where the plan paid it, not counted where it went unfunded.

## 9. Presentation surfaces, enumerated

Spec 8 (NIIT) collected a tax correctly and showed it nowhere, then found a sixth
surface after the fix. Phase 1 changes all of these:

- **The 401(k) form:** the separation field (§6.1), or the derived separation,
  read-only, with its source ("Salary ends January 2036, the year you turn 55").
- **The account's 👓 view and its rule notes** (`rule-notes.js`), affirmative
  and read from booked metrics, never recomputed (rule 1):
  - `early-distribution-tax`, on an IRA or 401(k): "$X drawn before 59½ paid the
    10% additional tax: $Y, charged each January for the year before."
  - `early-distribution-excepted`, on a 401(k): "No additional tax on $X drawn
    before 59½. Salary ended in 2036, the year you turned 55, so the
    separation-from-service exception applies."
  - `retirement-withholding` adds, on an account that drew early, that the 10%
    withheld is income tax, not the penalty.
  - `roth-tax-free` changes before 59½ (§7).
  - The specific note suppresses the general one, and `relevantMetrics()` lists
    the new metrics on the behaviors that carry them, or they are silent no-ops
    (spec 8's trap): `EARLY_DISTRIBUTION` on IRAs and 401(k)s, and
    `EARLY_DISTRIBUTION_TAX` wherever `NIIT` is listed.
- **What needs attention** (`portfolio-issues.js`):
  - a notice, `early-distribution-tax`: the plan pays the penalty (the total, the
    years, the accounts), and what could spare it: the separation field on a
    401(k) that no income pays into, spec 12's "from age" once it exists, a
    72(t) schedule once it exists. A notice, not ⚠️, which is kept for a bill
    nothing could pay;
  - an unpaid penalty: the existing `unfunded-obligation` alert, with the cause
    "additional tax on early distributions";
  - the IRA trap: a notice when a 401(k) the exception covered closes into an IRA
    that is then drawn early.
- **Month & Year Details** (`month-summary.js`): a group in the Taxes list
  (`TAX_LINE`), "Early-withdrawal tax"; its part in the January note
  (`settlementParts`); and early distributions, the part excepted and the tax in
  the tax-year strip and in the ⚡ summary's table.
- **Reports** (`report-view.js`): `federalTaxRows` adds the tax to Prior-Year
  Settlement, with a sub-row; a yearly block from the TaxYear record, as
  `creditRows` does for the premium tax credit; `tests/report-labels.mjs`.
- **The Taxes column** (`TAX_TREE`, `asset-list.js:44`, held by
  `tests/unit/tax-tree-coverage.test.js`) and the spreadsheet's columns.
- **Flows** (`money-flows.js`): a tax, like NIIT, with its own `via`.
- **MCP:**
  - `run_plan`: a row in the report's Lifetime Tax Summary (`finplan-ai.js:522`;
    `tests/niit-visibility.mjs` checks that the rows sum to the total), and the
    notice in the issues list;
  - `explain_month` and `explain_issue`: the January event's chain names the
    base, the months, the accounts, and the exception that spared any part;
  - `build_plan`: the 401(k)'s separation field; and where a plan's drawdown
    starts before 59½, its note on where spending is drawn from names the
    penalty;
  - `plan_defaults`: the reading of 59½ and the field's default. `share_link` and
    `diff_plans` need nothing new: the field rides in `modelAssets`, and lifetime
    tax already sums `totalTaxes()`;
  - the plugin's skill (`SKILL.md:332`) and README (`:18`): "No early-withdrawal
    penalty" becomes the gaps that remain (Roth earnings, 72(t) payments until
    Phase 2, the other exceptions, the half-year reading), with the stale link
    fixed; the plugin version bumped and the bundle rebuilt.
- **The Maximizer's recommendations** (§8).
- **Rules** (`rules.html`):
  - "What This Engine Does Not Model" loses "No early-withdrawal penalty" and
    gains "59½ is read as July of the year you turn 59" (no birth month is
    asked), "Roth withdrawals are free at any age" (until Phase 3), "No 72(t)
    payments" (until Phase 2) and "Most exceptions are not modelled";
  - a rule card beside the withholding cards (`rules.html:189-193`): the 10%, the
    separation exception, and the withholding that is not the penalty;
  - "A married household has one age" lists the penalty and the separation
    exception among its age rules.
- **Help** (`help.html`): where the tax shows, and what the separation field is
  for. The Funding Backstop card's "tax and penalty consequences" becomes plainly
  true.
- **Globals** (`globals.html:50`): Current Age fixes the birth year that
  "Social Security timing, the RMD start age ... and catch-up contribution
  eligibility are measured against"; 59½ joins the list.
- **Spec 12's editor** (spec 12 §6): the penalty on a tax-deferred entry whose
  "from age" is under 60, worded from the function the engine uses (§14).

## 10. Traps this codebase has already hit

- **A hook on each path misses one** (`tax-engine.js:71-89`). Count from the
  metric, in the sweep.
- **The sweep consumes the shelter, then skips closed accounts** (§5.2). Classify
  in the same loop, before the skip.
- **`activeUser.age` in the January pass is the settled year's** (§1.4).
  Classify in the month-end sweep.
- **An undeclared EventType throws mid-run**, in `monthlySanityCheck`,
  `annual-expenditure.js` and Flows. Declare before emitting.
- **A metric not in `relevantMetrics()` is a silent no-op** (spec 8).
- **A tax left out of `FEDERAL_TAX_FIELDS`** is collected and missing from every
  total. `tests/tax-sign-convention.mjs` holds `federalTaxes()` to the list, so
  the field goes in both.
- **Memo strings have live matchers.** `graph-mapper.js` matches notes exactly,
  and a new note vanishes from the Sankey with no error.
- **Lifetime tax is not conserved** (PR #23): the penalty changes how long
  accounts compound. The identity to test is that each year, what was charged
  plus what was reported unfunded equals 10% of the base.
- **Derive, never recompute** (rule notes, rule 1). A note quotes what was booked.
- **Present state is not history** (rule 3). The separation is read from the
  run's own record, not from the assets as they stand.
- **`fromJSON` copies fields by name.** The separation field must be in `toJSON`
  and `fromJSON`, or every load drops it; `globalOverrides` is the reminder of
  how a stored field can do nothing (code-issue #24).
- **A fixture that does not reach a branch reads the same as a correct engine**,
  and the corpus reaches none of these (§1.6).
- **Predict before blessing.** Write the drift, run
  `node tests/tools/snapshot.mjs`, read `git diff tests/baselines/`, and only
  then `--bless`. `--bless --only` leaves `_coverage.snap` stale; finish with an
  unfiltered bless.
- **Static pages drift silently** (PR #97). Rules, Help and Globals change in
  the same PR as the behavior.
- **The plugin version** is bumped in every PR that changes the bundle.

## 11. Fixtures, tests and mutation targets

New fixtures, each with a `reaches:` note:

- `early-ira-draw`: July's scenario as an IRA, with a Checking account that pays
  the tax. 10% of $300,000 over 2026 to 2030, and nothing from July 2030.
- `early-401k-separated-at-55`: a salary paying into a 401(k) ends in the year
  the user turns 55, the boundary. The 401(k)'s draws are spared, and an IRA
  drawn in the same years is charged.
- `early-401k-separated-at-54`: the same, retired at 54. Charged until July of
  the year the user turns 59.
- `early-401k-stated`: July's 401(k), its field saying it was left at 55: $0. Its
  twin with the field empty is charged, and the notice fires.
- `early-conversion-and-rollover`: at 50, an IRA converts to a Roth and a 401(k)
  moves into an IRA by a rebalance rule. Neither is charged; the rollover's income
  tax stays as it is today.
- `early-close`: at 52, one 401(k) closes into Cash (the whole balance charged),
  one closes entirely into a Roth (only the tax withheld at the close charged),
  and one closes into an IRA (nothing charged).
- `early-penalty-unpayable`: early IRA draws and no everyday account. The tax is
  reported unfunded on the largest account.
- `early-half-year`: draws through the years the user turns 59 and 60. January
  to June of 59 are charged; July onward are not.
- `early-penalty-mfj`: a couple with two salaries and two 401(k)s, one job left
  at 55 and one at 54.
- Phase 2: `sepp-amortization`; `sepp-broken`, where an extra draw brings back
  the tax with interest; `sepp-ends`.
- Phase 3: `roth-earnings-early`, `roth-ladder-five-years`.
- **Silence:** every existing fixture byte-identical.

Tests:

- **An oracle**, `tests/early-distribution-oracle.mjs`: an independent Form 5329,
  Part I, built from the run's recorded events. Line 1 from the distribution and
  withholding events by date, line 2 from the plan's separations, line 4 as 10%.
  It holds the engine's TaxYear and January event to the form on every fixture
  and on the probe's profile grid.
- **The identity**, every year: what was charged plus what was reported unfunded
  equals 10% of the base, and the base equals the accounts' `EARLY_DISTRIBUTION`
  summed.
- **Neutrality**, PR #23's pattern: with the rate at 0, the run is event for
  event identical to one without the feature.
- **The gates:** an allocation leg or an RMD is never early. A change to either
  gate trips the assertion.

Mutations it must catch:

- reading 59½ as 60, or as 59;
- leaving the withheld dollars out of the base;
- charging a conversion, a rollover or the sheltered part of a close;
- skipping the account that closed this month;
- applying the exception to an IRA, to a 401(k) whose income ended at 54, or
  before the separation month;
- reading `activeUser.age` in the January pass;
- dropping the separation field in `fromJSON`;
- folding the tax into the true-up, or leaving it out of `FEDERAL_TAX_FIELDS`;
- letting the IRA that caused the tax pay it;
- skipping an unpayable tax without reporting it.

## 12. Not in scope

- **The rollover's income tax.** A 401(k) moved into an IRA is taxed as income
  today (§5.1). Its own PR.
- **A birth month** (§4.3). Its own spec.
- **The RMD excise tax.** Rules lists it: "No RMD penalty".
- **Nondeductible IRA basis (Form 8606)** and after-tax 401(k) money. Every IRA
  and 401(k) dollar is pre-tax here, and the penalty follows the income tax.
- **Instruments the engine does not have:** 403(b)s (treated like a 401(k) by
  the law), governmental 457(b)s (no 10% at all), SIMPLE IRAs (25% in the first
  two years), HSAs (20% on non-medical use), inherited IRAs and annuities.
- **Each spouse's own age.** One household age (Rules).
- **State penalties.** California adds 2.5%; the engine has no state tax.
- **The estimated-tax underpayment penalty** (§6654).

Seen, not fixed:

- Rules' withholding card says a refund "is credited back rather than dropped"
  (`rules.html:193`). With no everyday account the true-up drops it, with only a
  SANITY line (§1.6).
- Current Age makes the birth year a year late for a user whose birthday is still
  to come that year (§4.2), which moves every age rule. Rules does not list it.
- The skill's link to `policy-constants.js:39` is stale (§1.1).
- The Maximizer's fitness ignores every unfunded obligation (§8).

## 13. Phases and cost

| Phase | Delivers | PRs | Effort |
|---|---|---|---|
| **1. The penalty** | §4 and §5: the charge on IRAs and 401(k)s, conversions and rollovers spared, the separation exception derived and stated (§6.1), the January pass and the TaxYear fields, §9's surfaces, §11's Phase 1 fixtures and the oracle | 2: the engine and its data (the field, JSON, share link, MCP), then the surfaces and pages | about 4–6 days |
| **2. 72(t) payments** | §6.2 | 1–2 | about 4–6 days |
| **3. Roth basis** | §7: the contribution basis, conversion layers, the two five-year rules | 2 | about 5–8 days |

Spec 12's Phase 2 waits for Phase 1 only. Spec 11's Part C needs Phase 1, and
Phase 3 to make "Roth last" exact.

Phase 1's prediction, written before any code (the probe, on main 21603db):

- **The corpus is byte-identical.** No fixture draws an IRA, 401(k) or Roth
  before 59½ (§1.6), so no month binds. The new metrics and fields stay zero; the
  snapshot prints no all-zero metric history and no package field at zero, and
  it prints the new TaxYear fields only for a year with an early draw.
- **`_coverage.snap` is unchanged** once the new fixtures reach the new
  EventType; until they do, it lists it.
- **The new fixtures move as stated.** Starting in January 2026 at 55, as July's
  plan does, `early-ira-draw` owes $6,666.67 for each of 2026 to 2029 and
  $3,333.33 for 2030, $30,000.00 in all. `early-401k-stated` owes $0, and its twin
  with the field empty $30,000.00.
- **The early profiles**, which are not fixtures, match §1.6: Mid Career 45/55
  owes $0, its separation derived from its salary, and Early Career 35/50 owes
  $23,200.

## 14. The hand-off to spec 12

- **What spec 12's Phase 2 needs:** the penalty charged on every early
  distribution, the walk's legs included. Phase 1's sweep sees a leg like any
  other distribution (§5.2), so the walk needs no change of its own.
- **The gate and the penalty are separate.** Spec 12's "from age" (default 60)
  says when the order may draw an account; this spec says what a draw costs.
  Under §4's reading the default never draws a charged month. A user who lowers
  it is charged, and sees it.
- **One function for both.** The editor's note on an entry whose "from age" is
  under 60 and the engine's classification read one answer: for example
  `earlyDistributionRule(account, plan)`, returning when the 10% stops applying to
  that account and why (59½, or a separation at 55). The two cannot then
  disagree. For a 401(k) the exception covers, the editor could default its "from
  age" to the separation year instead of 60; that is spec 12's call.
- **Paying the tax:** another row for spec 12 §1.3's table of accounts paying:
  "TaxEngine, the early-withdrawal tax | the year's 10% | `resolveFunding`, then
  `settleOneSided` | yes". If this spec's Phase 1 lands first, its pass must not
  ask `resolveFunding` again after the draw to attribute a spill; otherwise it is
  a fifth site for spec 12 §5.2 to convert.
- **Spec 12's own text:** §4.4's "The penalty therefore gets its own spec" can
  point here; its Roth line stays until Phase 3; §6's "the penalty line goes when
  the penalty spec lands" is done by Phase 1; §9's entries for the penalty and
  for Roth basis can point here.
- **The withholding spill** (spec 12 §4.4) still passes over tax-deferred
  entries. Nothing here changes that.
- **Where the two meet in a fixture:** spec 12's `fallback-ira-at-62` and its twin
  at 55 with the gate lowered (spec 12 §8). After Phase 1 that twin is charged
  10% on every leg before July of the year its user turns 59.

## 15. Decisions

For John. Each states the proposal first.

1. **The reading of 59½** (§4): before July of the year the user turns 59. Or
   under 60, spec 12's number, which charges about 5½ months too many on average.
   Or a birth month first, in its own spec, which makes every age rule exact.
2. **Where the charge lands** (§5.4): a January pass of its own, like NIIT's. Or
   inside the true-up's liability: one net balance due, with the penalty inside
   the true-up's figure.
3. **The separation exception** (§6.1): in Phase 1, derived from the plan's
   salary and 401(k). A 401(k) that no income in the plan pays into is charged
   until its field says the job was left at 55 or later, and a notice says so. Or
   such a 401(k) is spared unless its field says otherwise.
4. **72(t) payments** (§6.2): Phase 2. Or a listed gap.
5. **Roth** (§7): a disclosed gap in Phase 1, with Roth basis built here as Phase
   3, defaulting to the whole opening balance. Or its own spec. Or in Phase 1.
6. **The other exceptions** (§6.3): listed gaps, with no switch that turns the
   penalty off. The first-home exception could follow Phase 1 cheaply.
7. **Rollovers** (§5.1): never charged the 10%, with their income tax left to its
   own PR.
8. **The Maximizer** (§8): a fitness term for unfunded obligations, in its own PR
   beside Phase 1. Or leave the fitness as it is.
9. **Who pays** (§5.3): the funding backstop, and spec 12's order once it exists;
   never the account whose draws caused the tax.

One reading to confirm: "model reality" is taken to mean charge, never prevent.
No setting stops an early draw, and none waives the charge.

## Sources

- [IRS: Retirement topics, exceptions to tax on early distributions](https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-exceptions-to-tax-on-early-distributions)
  (reviewed 2025-12-11): the exceptions, their Code sections, the accounts each
  covers, the limits, and the separation exception's wording. The statute
  (IRC §72(t), §408A(d)) and Notice 2022-6 are cited from the Code and the notice
  and are to be checked at build.
- [Boldin: release notes](https://www.boldin.com/retirement/release-notes/): the
  October 2026 entry, the 10% additional tax before 59½.
- [Boldin: early retirement withdrawals](https://www.boldin.com/retirement/early-retirement-income-penalty-free-withdrawals-from-retirement-accounts-before-59-5/):
  its guide to the separation exception and 72(t) payments.
- [ProjectionLab changelog](https://projectionlab.com/changelog): 2.5.0 and 2.6.0
  (2022, early-withdrawal settings and the warning), 3.4.0 (2022-10-10, 72(t)
  payments and liquidity settings), 4.2.2 and 4.2.3 (2025).
- [ProjectionLab: Can I model 72t (SEPP) distributions?](https://projectionlab.com/help/72t-sepp-distributions),
  [ProjectionLab: early withdrawal warnings](https://projectionlab.com/help/early-withdrawal-warnings)
  and [ProjectionLab: what is the Rule of 55?](https://projectionlab.com/financial-terms/rule-of-55).
- Measurements in §1.6, §4.2 and §13: a read-only probe that wraps
  `ModelAsset.addToMetric`, `RebalanceEngine._trackDistribution`,
  `FundTransfer.execute` and the engines' public methods, preloaded with
  `node --import` into `node tests/tools/snapshot.mjs` (which runs the corpus
  in-process) and run on its own over the profiles, on main 68d34bd and again on
  21603db, 2026-10-29, with identical results. The snapshot stayed unchanged. The probes are outside the repo, in
  `%APPDATA%/Claude/side-session-notes/local_cf715002-ae14-4048-9944-5f1803dc33ff/early-withdrawal-probes/`;
  each imports the engine by an absolute `file:///` path, to be pointed at the
  checkout under test.
