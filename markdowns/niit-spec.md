# Spec 8 — Net Investment Income Tax (IRC §1411)

Status: **COMPLETE 2026-08-18**, steps 1-4, on `feat/niit` off the §63
deduction-overflow fix (#36). Written the same day, immediately after that fix
established the seam this spec builds on.

Outcome against the plan, recorded because two predictions were worth keeping
and one section was wrong:

- **§6.2 held exactly.** The two opposite-direction silence fixtures both did
  their job under mutation: `mfj-two-earners` caught dropping the NII argument,
  `gain-harvest-under-the-deduction` caught dropping the MAGI argument. Neither
  moved when NIIT shipped.
- **§6.3 was necessary.** Nothing in the corpus reached the asymmetry, and the
  new `niit-from-a-deferred-draw` is also the only fixture where the NII side of
  the `min` binds.
- **§5.1 was corrected during implementation** — see the note in that section.
- **Bonus:** `decumulation-oracle.mjs` already carried an independent §1411
  model, written from the statute, sitting unbanded behind finding F8. It agreed
  with the implementation and is now the banded model. F8 is closed.
- **§5.4 decided:** allocate by NII, not by total taxable income.
- **§9 added 2026-08-20** after the engine work shipped: NIIT was collected
  correctly and *reported* nowhere. The spec covered the engine and stopped
  there, which is why the gap existed.
- **§10 added 2026-08-20**, after the user read the actual screen and found the
  tax breakdown still did not mention NIIT. §9 fixed one presentation surface
  and assumed it was the only one. It was not.

---

## 1. Why

The engine charges ordinary income tax, preferential capital-gains tax, FICA and
a §121 exclusion. It does not charge the 3.8% Net Investment Income Tax, which
has applied since 2013 to exactly the households this simulator is pointed at:
anyone with meaningful investment income and a MAGI above a fixed threshold.

Two reasons it matters more than its rate suggests:

1. **The threshold is not inflation-indexed.** §1411 fixed it at $200,000
   single / $250,000 MFJ in 2013 and has never moved it. Over a 30-year plan at
   3.1% inflation, a household whose real income is flat still crosses it. A
   simulator that omits NIIT gets progressively more wrong over the projection,
   in the same direction, for the same structural reason as the §121 exclusion
   (see `taxes.js`, `inflateTaxes()`).

2. **It is the binding constraint on Roth-conversion and gain-harvesting
   sizing**, because of the asymmetry in §4 below. That is decision-relevant
   output, not a rounding correction.

---

## 2. The rule, stated once

    NIIT = 0.038 × min( netInvestmentIncome , MAGI − threshold )

Floored at zero. Both arguments must be computed; taking either one alone is
wrong in a direction the fixtures below already demonstrate.

| Filing status | Threshold |
| --- | --- |
| Single | 200,000 |
| MFJ | 250,000 |
| MFS | 125,000 — **not modelled**, no MFS support (spec 5) |

**Never indexed.** See §7.1.

---

## 3. What is in the base, mapped to `FINANCIAL_FIELDS`

### 3.1 Net investment income — IN

| Field | Note |
| --- | --- |
| `interestIncome` | |
| `nonQualifiedDividends` | |
| `qualifiedDividends` | in NII despite its preferential rate |
| `shortTermCapitalGains` | |
| `longTermCapitalGains` | |
| `excludedCapitalGains` | **subtracted** — §121 gain is out of NII too |

### 3.2 Net investment income — OUT

| Field | Why |
| --- | --- |
| `employedIncome`, `selfIncome` | wages are not investment income (they carry Additional Medicare Tax instead — out of scope, §8) |
| `socialSecurityIncome` | statutorily excluded |
| `pensionIncome` | qualified-plan money |
| `tradIRADistribution`, `four01KDistribution` | qualified-plan money — **but see §4** |
| `rothIRADistribution` | tax-free, in neither base |
| `assetAppreciation` | unrealised; NII is realisation-based |

### 3.3 Not supported — rental income

**Rents are net investment income under §1411(c)(1)(A) and this model has no
rental income at all.** There is no `rentalIncome` field in `FINANCIAL_FIELDS`,
and `realEstate` carries only `maintenance`, `insurance` and `propertyTaxes` —
it is a residence, not an income property.

This is a **distinct asset type that is not yet supported**, deferred to a later
release, and is recorded here so the omission is a known gap rather than a
silent under-statement of NII. Any household modelled with rental property will
be under-charged NIIT until that asset type exists. Do not paper over it by
routing rent through `interestIncome`.

### 3.4 Deductions allocable to NII — deliberately not modelled

§1411 permits NII to be reduced by properly allocable deductions (investment
interest, advisory fees, allocable state income tax). The model tracks none of
them. NII is therefore **gross**, which over-states NIIT slightly. Stated here
rather than discovered later; revisit only if an advisory-fee concept lands.

**The standard deduction is not among them.** It does not reduce NII and it does
not reduce MAGI. See §7.2 — this is the most likely wrong assumption.

---

## 4. The asymmetry, which is the whole planning value

**Qualified-plan distributions are excluded from NII but included in MAGI.**

An IRA or 401(k) withdrawal can therefore never be taxed by NIIT itself, yet it
raises MAGI, and by raising MAGI it can drag *other* investment income into the
tax. A Roth conversion does the same thing.

The consequence a user needs told: **converting to Roth or drawing a deferred
account can trigger a 3.8% surcharge on gains you were not otherwise going to be
taxed on.** That is a genuine planning constraint and the reason this spec is
worth more than its 3.8%.

Roth distributions raise neither base — which is the counterpart advice.

This asymmetry MUST have a dedicated fixture (§6.3). It is the part most likely
to be implemented as "add gains, done" and silently lost.

---

## 5. Design

### 5.1 Two new fields on `taxableBasis()`

`js/tax-basis.js` is the single definition of what a package owes tax on, and
its header already anticipates this: *"gives a future threshold rule (NIIT,
IRMAA) somewhere to live instead of creating the tenth disagreeing
definition."* Adding a tenth site is the failure this module exists to prevent.

    netInvestmentIncome   §3.1 less §3.2, floored at zero
    magi                  irsTaxableGrossIncome()
                          + longTermCapitalGains
                          + qualifiedDividends
                          − excludedCapitalGains
                          − the DEDUCTIBLE pre-tax contribution

`magi` is **AGI**, not taxable income: measured *before* the standard or
itemised deduction, *after* pre-tax contributions. It is a different quantity
from `ordinaryTaxable` and from `ltcgStackBase`, and must not be derived from
either.

**Corrected during step 1 (2026-08-18).** This section first said
`− preTaxContribution()`. That helper sums 401(k) *and* traditional IRA, while
`applyYearlyDeductions` has always taken one **or** the other. Real AGI does
subtract both, but MAGI and taxable income disagreeing about the same
contribution is exactly the tenth-definition failure `tax-basis.js` exists to
prevent, so `magi` uses `deductionComponents().preTax` — the amount this engine
actually treats as deductible. The either/or is a pre-existing simplification;
fixing it is its own change, not a side effect of adding NIIT.

`unusedDeduction` is **not** an input here. Both bases sit above the deduction
line. (An earlier comment in `tax-basis.js` claimed NIIT would consult it; that
was wrong and has been corrected in place.)

### 5.2 Charge it at the annual true-up only

`applyAnnualTaxTrueUp` in `js/engines/tax-engine.js`, which already owns the
authoritative yearly liability.

Three reasons, in order of weight:

1. **It is how NIIT actually works.** There is no NIIT withholding at source;
   it is settled on the return or via estimated payments.
2. **It sidesteps the ×12 gap entirely.** Every monthly site annualises one
   month by twelve. For a threshold rule that is not a rounding error but a
   step function — a single windfall month would annualise over the threshold
   and charge 3.8% on a household that never crosses it. This is the same class
   of failure that made the close path unfit for the §63 overflow on
   2026-08-18; do not repeat it.
3. One site, one base, nothing to keep in agreement.

### 5.3 The event must be declared before it is emitted

`EVENT_RECONCILIATION` in `js/portfolio.js` **throws** on an undeclared type.
Add:

    [EventType.NIIT_ASSESSED]: 'oneSided'

`oneSided`, matching `TAX_TRUE_UP`: it debits a funding account with no
counterparty leg.

### 5.4 Funding and allocation

Reuse the true-up's existing path — `#planTaxAllocation` / `#settleAllocatedLeg`
with `FundTransfer.resolveFunding` as backstop. **Decision required before
coding:** under spec 4a, is NIIT allocated by income share like the ordinary
residual, or billed specifically to the accounts that generated the NII? The
second is more defensible for this tax than for any other, since NIIT has an
identifiable base by construction. Do not default to whichever is less code.

---

## 6. Fixtures — measured against the committed set

The §63 fix shipped with **zero** of 26 fixtures exercising it; the rule had no
witness and could have been reverted with the suite green. That must not repeat.
Scanned 2026-08-18, plan-years derived from `months` and wage totals:

### 6.1 Existing fixtures that already reach it

| Fixture | Why it reaches | Which side of `min` binds |
| --- | --- | --- |
| `single-home-sale` | ~108k/yr wages + 238k post-§121 gain in 2029 | **MAGI excess** binds — the gain exceeds the amount over threshold |
| `mfj-high-earner-ltcg` | ~240k/yr wages + ~2.0M gain at the 2029 close | **NII / MAGI excess are close** — a genuine `min` test |
| `quickstart-earlyCareer`, `-youngCouple`, `-dualIncome`, `-midCareer` | high wages plus realised gains across long plans | multi-year, both sides in different years |

### 6.2 Existing fixtures that must stay at ZERO — the silence tests

| Fixture | Why zero |
| --- | --- |
| `mfj-two-earners` | ~432k/yr wages, **no investment income at all**. High MAGI, NII = 0. A NIIT charge here means the implementation used the MAGI side alone. |
| `gain-harvest-under-the-deduction` | ~57k/yr of pure gain, MAGI far below 200k. A charge here means the implementation used the NII side alone. |

These two are the most valuable fixtures in the set: **they fail in opposite
directions**, so an implementation that drops either argument of the `min` is
caught by one of them.

### 6.3 New fixture required — the §4 asymmetry

Nothing in the current set crosses the threshold *via a deferred distribution*.
Needed: a retiree with modest ordinary income, a large IRA draw or Roth
conversion pushing MAGI over $200,000, and a brokerage throwing off gains. The
assertion is that the **gains** get taxed, driven by a distribution that is
itself exempt.

Mutation-verify it: forcing `magi` to exclude `taxableDistribution()` must make
this fixture drift. If it does not, the fixture does not reach §4.

---

## 7. Traps, each one already survived once in this codebase

### 7.1 `inflateTaxes()` indexes everything by default

The threshold must be **explicitly excluded**, with a comment saying so — the
exact treatment `activeHomeSaleExclusion` already gets. An unexplained absence
reads as an oversight and invites a future "fix" that re-indexes it. Indexing
would under-charge every long plan, growing with the projection.

### 7.2 MAGI is above the deduction line

`ordinaryTaxable` is post-deduction; `magi` is not. Reusing `ordinaryTaxable`
as MAGI under-states it by the standard deduction and pushes households below
the threshold that are genuinely over it. A test must pin `magi` against a
package where the two differ by exactly the deduction.

### 7.3 Green tests are not evidence

Mutation matrix required before this is called done, at minimum:

- threshold → `Infinity` (never charges): the §6.1 fixtures must drift
- `min` → first argument only: `mfj-two-earners` must drift
- `min` → second argument only: `gain-harvest-under-the-deduction` must drift
- `magi` drops `taxableDistribution()`: the §6.3 fixture must drift
- NII includes `rothIRADistribution`: some fixture must drift, or NII coverage
  is vacuous

### 7.4 Predict before blessing

Record expected direction and rough magnitude for every drifting fixture
*before* running `--bless`, per `feedback_predict_before_engine_fix`.
`--print-actual` makes blessing a regression too easy.

---

## 8. Explicitly out of scope

(Section 9 below was added after implementation — see the status note at the top.)

- **Additional Medicare Tax** (0.9% on wages over the same thresholds, IRC
  §3101(b)(2)). Adjacent, same thresholds, *different base* — it is a payroll
  tax on earned income and belongs with FICA, not here. Folding it in would
  produce a function computing two unrelated taxes.
- **MFS** — no MFS support exists (spec 5).
- **Per-person NIIT** — household-level only, consistent with spec 5.
- **Rental income** — §3.3, a missing asset type, later release.
- **NII-allocable deductions** — §3.4.
- **IRMAA** — also MAGI-keyed and a natural follow-on, but it is a Medicare
  premium surcharge, not a tax, and it uses a two-year-lookback MAGI. Separate
  spec; the `magi` field built here is what it will consume.

---

## 9. Presentation — added 2026-08-20, after steps 1-4 shipped

Steps 1-4 made the engine charge NIIT correctly and left it invisible. The spec
had nothing to say about the presentation layer, so nothing checked it, and the
question "is this actually shown to the user?" was never asked until it was
asked out loud.

**Two defects, both silent, both the same shape: a write that goes nowhere and
reports success.**

### 9.1 `Metric.NIIT` was a no-op on every instrument

`addToMetric(Metric.NIIT, ...)` looked correct at both call sites and stored
nothing. No `relevantMetrics()` listed the metric, so `MetricSet.get()` fell
back to `NULL_METRIC`, whose `add()` does nothing. The charge still reached
`FEDERAL_TAXES` through the rollup DAG, so every total was right and no suite
complained — the tax was simply folded in anonymously, with no line of its own
anywhere.

`instrument-behavior.js` already documented this exact trap for retirement-income
withholding (*"the tax is deducted from the benefit and shown nowhere"*). It
caught the next feature anyway.

Fixed by adding `M.NIIT` to `CapitalBehavior`, `IncomeAccountBehavior` and
`RealEstateBehavior` — the three that hold investment assets or act as the
funding backstop.

### 9.2 `FinancialPackage` had no `niit` field at all

So `federalTaxes()` — the number the report view prints and `effectiveTaxRate()`
divides by — omitted it entirely. That left the per-asset ledger and the
household package **disagreeing about the same tax**: an account's
`FEDERAL_TAXES` metric included NIIT, the package meant to total those accounts
did not. Neither side complained, because `NIIT_ASSESSED` reconciles as
`'oneSided'` and is not matched against a package field.

Every household that owed NIIT saw a federal tax total and an effective rate
lower than what it actually paid.

Fixed by adding `niit` to `FINANCIAL_FIELDS`, booking it in `applyAnnualNIIT`
(what accounts **supplied**, including spillover — never what they were billed),
adding it to `federalTaxes()`, and giving it its own line in `report-view.js`.

### 9.3 The lesson, and the test that encodes it

Neither defect was reachable by a totals check: the money genuinely moved and
every balance was correct. Only the *link* between the charge and its record was
broken.

`tests/niit-visibility.mjs` asserts the links rather than the totals:

1. every `NIIT_ASSESSED` event left a stored `Metric.NIIT` on the asset it
   landed on — catches the `NULL_METRIC` no-op for **any** instrument, including
   one added later;
2. the package's `niit` is non-zero and never exceeds the events that produced
   it;
3. `federalTaxes()` actually moves by that amount when it is removed;
4. a household owing no NIIT reports none.

Plus a guard that the suite is reachable at all — it fails if no fixture charges
NIIT, the same trap §6 was written for.

All three original defects are mutation-confirmed to fail it. The snapshot drift
is **purely additive**: verified by stripping the new `niit` lines and comparing
literals, so no pre-existing simulated value moved.

**Generalisation worth carrying:** `addToMetric` is silent when a metric is not
in `relevantMetrics()`. Any new metric needs a fixture that reaches it AND an
assertion that the value was stored — "the engine charged it" and "the user can
see it" are different claims, and only the first one was ever in this spec.

---

## 10. The presentation surfaces, enumerated — added 2026-08-20

§9 fixed `report-view.js` and stopped, on the assumption it was *the* place tax
is shown to the user. It was one of five. The user opened Your Portfolio, looked
at the Taxes column, and NIIT was not there.

**Every surface that presents tax, and how each behaves:**

| Surface | Driven by | Picks up a new tax metric? |
| --- | --- | --- |
| `asset-view-modal.js` | `MetricRollups` DAG | **Yes, automatically** |
| Projections metric picker | `MetricLabel` | **Yes, automatically** |
| `report-view.js` | hardcoded rows | No — fixed in #38 |
| `asset-list.js` `TAX_TREE` | **hardcoded** | No — fixed here |
| `spreadsheet-view.js` | **hardcoded** columns | No — fixed here |
| `graph-mapper.js` sinks | hardcoded | No — Sankey toggle is hidden pending design; left alone deliberately |

The two DAG-driven surfaces were right the whole time, which is exactly why the
gap was easy to miss: two of the five screens showed NIIT correctly from the
moment the metric existed.

`tests/unit/tax-tree-coverage.test.js` closes the loop for the important one: it
derives the set of taxes from the rollup DAG — the engine's own definition — and
asserts the hardcoded `TAX_TREE` covers it. A new leaf metric reaching
`Metric.TAXES` now fails a test instead of quietly missing the UI.

### 10.1 A once-a-year charge cannot be annualised by multiplication

Found only by running the app, not by reading the code.

`_computeTaxTree()` reads the metric at **one month** and multiplies by twelve.
That is right for withholding and FICA, which accrue monthly. It is wrong twice
over for NIIT, which `applyAnnualNIIT` books in a single month each year:

- pruned to nothing in the eleven months the metric is zero;
- **12× the real charge** in the twelfth.

Measured on Early Career: $38,662 of NIIT lands in **16 single months of a
665-month plan** — the row would have been invisible 97% of the time and wrong
whenever visible.

Fixed with an `annualCadence` flag that sums the trailing twelve months instead.
Only metrics genuinely booked once a year carry it, so no existing figure moves.
Verified in the running app at the charge month and two months after it: the row
persists across the year at the correct $2,632.70, and disappears once the
trailing window clears.

**Generalisation:** a metric's *cadence* is part of its display contract. Any
new once-a-year charge needs `annualCadence`, or it will be both invisible and
overstated — a combination no totals check can detect.