# Spec 6 — One definition of the tax base

Status: **scope only, no code written.** Written 2026-08-06 on
`feat/married-filing-jointly`, out of two bugs found that day which have the same
root cause.

---

## 1. Why

Two defects surfaced in a single session, and neither was a mistake in a formula:

- **§121 applied at close and undone in April** (spec 5, step 2b). The close path
  taxed the post-exclusion gain; the annual true-up recomputed the year from the
  gross gain. Two sites, two bases, one liability.
- **The LTCG bracket base disagrees with itself** (spec 5, §7.0.3). The annual
  true-up stacks gains on ordinary taxable income after deductions. The close
  path stacks them on `monthly.totalIncome() × 12` — a gross rollup that includes
  the gains themselves, tax-free Roth distributions and qualified dividends, with
  no deduction subtracted.

Both are instances of the same thing: **the engine computes "what is taxed" in
more than one place, and the places do not agree.** Adding a settlement point
multiplies that surface; adding a tax rule multiplies it again. §121 had to be
threaded through two sites by hand, and the second one was missed for as long as
the feature existed.

The fix is not another settlement point and not fewer of them. It is one function
that answers "what does this package owe tax on", used by every site.

---

## 2. Inventory — every site that computes a base, measured

### 2.1 Ordinary income base

Four production sites. All four have the **same shape**: copy the package, apply
`limitDeductions`, call `calculateYearlyTaxableIncome`.

| Site | Package | Annualised |
| --- | --- | --- |
| `payroll-engine.js:115` `computeHouseholdIncomeTax` | `this.monthly` | ×12 |
| `tax-engine.js:443` `applyMonthlyTaxTrueUp` | `this.monthly` | ×12 |
| `expense-engine.js:389` gross-up | `this.monthly` | ×12 |
| `tax-engine.js:620` `applyAnnualTaxTrueUp` | `this.yearly` | already annual |

These are consistent, and the extraction should leave them **byte-identical**.
The ×12 annualisation of a one-time month is a known separate gap (see §7).

### 2.2 Long-term capital gains base — the divergence

| Site | Base gains stack on | Gains |
| --- | --- | --- |
| `tax-engine.js:646` annual true-up | `calculateYearlyTaxableIncome(yearlySnapshot)` — **ordinary taxable income after deductions** | `longTermCapitalGains + qualifiedDividends − excludedCapitalGains` |
| `taxes.js:479` via `calculateCapitalGainsTax`, called from `tax-engine.js:290` and `:386` | `annualizedIncome` = **`monthly.totalIncome() × 12`** | `taxableGains` (post-§121) |

`totalIncome()` is `ordinaryIncome + capitalGain + taxFreeDistribution +
qualifiedDividends`. So the close path's base is gross, contains the gains being
taxed, contains tax-free money, and has no deduction removed.

### 2.3 Ordinary marginal withholding — a third disagreement

`tax-engine.js:415-417` (`applyDeferredCloseDistribution`) computes
`tax(income + distribution) − tax(income)` — the right *shape* — but feeds
`annualizedIncome`, again `monthly.totalIncome() × 12`, into
`calculateYearlyIncomeTax`, which applies **ordinary** brackets. So ordinary tax
is computed on a base containing long-term gains, Roth distributions and
qualified dividends, undeducted.

### 2.4 Log-only sites

`taxes.js:611` (`reconcileYearlyTax`) and `taxes.js:658` (`applyYear`) compute
bases and only `logger.log` the result. They must be migrated for consistency and
are expected to produce **no** behavioural diff — which makes them a free
correctness check on the extraction.

---

## 3. THE BLOCKING PRECONDITION: one of these sites is unreachable

**`applyDeferredCloseDistribution` is not exercised by anything.** Proven by
mutation on 2026-08-06 — multiplying its withholding by 7.77:

```
  18 fixture(s) unchanged. No simulated number moved.
  all 34 integration suites PASS
```

No fixture closes a deferred account. An asset only closes when its
`finishDateInt` precedes the plan end (`housing-carrying-costs`'s Home finishes
*at* the end and reports `isClosed = no`), and every IRA/401K in the corpus runs
to the end:

| Fixture | deferred close | taxable close |
| --- | --- | --- |
| mfj-high-earner-ltcg | — | Brokerage |
| mfj-home-sale | — | Home |
| single-home-sale | — | Home |
| quickstart-earlyCareer | — | Home |
| quickstart-midCareer | — | Home |

So §2.3's defect cannot currently be seen, fixed, or regression-tested, and a
`taxableBasis` refactor touching that site would be **unverifiable**. This gates
the work.

---

## 4. Design

One module, `js/tax-basis.js`, one exported function.

```js
/**
 * The single definition of what a package owes tax on.
 *
 * @param {FinancialPackage} pkg        NOT mutated — copied internally
 * @param {User} activeUser             for the deduction limits
 * @param {{annualise?: boolean}} opts  true for a monthly package (×12)
 * @returns {{
 *   ordinaryTaxable: Currency,   // after deductions and pretax contributions, floored at 0
 *   capitalGains:    Currency,   // LTCG + qualified dividends − §121 exclusion, floored at 0
 *   ltcgStackBase:   Currency,   // what gains stack on: ordinaryTaxable
 * }}
 */
export function taxableBasis(pkg, activeUser, { annualise = false } = {})
```

**`ltcgStackBase === ordinaryTaxable` is the whole point.** It is a named field
rather than an alias so the intent is legible at the call site and so a future
rule (NIIT thresholds, IRMAA) has somewhere to live without another divergence.

**Copy internally, always.** `limitDeductions` mutates. Every current site
happens to copy first; a helper that relied on callers continuing to do so would
be one refactor away from corrupting the live package.

**Unify onto the annual true-up's semantics.** It is the site that already
matches the statute: gains stack on ordinary taxable income after deductions.
The close paths move to it. This is a deliberate choice, not an average.

---

## 5. Preconditions — all must hold before any production code changes

**P1 — every site is reached, and each is mutation-verified.**
For each of the seven sites in §2, a fixture must exist whose baseline moves when
that site is mutated. Record the mutation and the fixture that caught it. §3
already shows one site failing this; do not assume the others pass — **verify all
seven**, because "it looks reachable" is what made the deferred path invisible.

Known to be required:
- `deferred-close-distribution` — an IRA and a 401(k) with `finishDateInt`
  **before** the plan end, alongside enough other ordinary income that the
  marginal calculation is not walking brackets from $0.

**P2 — the intended semantics of each of the three outputs is written down,
with a citation, before the function exists.** Otherwise the extraction quietly
canonises whichever site was copied first. §4 fixes `ltcgStackBase` = ordinary
taxable income after deductions; `capitalGains` and `ordinaryTaxable` need the
same treatment, including the treatment of qualified dividends and of a negative
result.

**P3 — the corpus is green and committed**, so every subsequent diff is
attributable. `node tests/tools/snapshot.mjs` reports no drift.

**P4 — a per-site prediction is recorded before that site is migrated**, in the
form "this fixture moves by roughly X, these do not". Per the house rule, written
first.

**P5 — the four ordinary-base sites are confirmed byte-identical under the
extraction before any LTCG site is touched.** They are already consistent, so
their diff must be empty. A non-empty one means the helper changed a semantic
nobody intended, and everything after it is untrustworthy.

**P6 — `--set global_filingAs` A/B still discriminates.** `single-home-sale` and
`mfj-home-sale` must keep showing different tax on the same gain. The basis
extraction must not accidentally make filing status inert.

---

## 6. Sequencing

Each step is one commit with its own predicted, then verified, baseline diff.

| # | Step | Expected baseline effect |
| --- | --- | --- |
| 0 | `deferred-close-distribution` fixture; mutation-verify all seven sites (P1) | new baseline only; all others empty |
| 1 | Add `js/tax-basis.js` + pure unit tests. **No call site changes.** | **empty — the whole corpus** |
| 2 | Migrate the four ordinary-base sites (§2.1) | **empty** (P5) |
| 3 | Migrate the two log-only sites (§2.4) | **empty** |
| 4 | Migrate the LTCG close path (§2.2) to `ltcgStackBase` | every fixture with a taxable close: 5 known |
| 5 | Migrate the deferred marginal withholding (§2.3) | the new fixture, and only it |
| 6 | Delete `totalIncome()`-as-tax-base, or comment why it survives for reporting | empty |

Steps 1, 2, 3 and 6 have an **empty diff as the deliverable** — the property this
harness can assert and the previous suite could not. Steps 4 and 5 are the
behavioural change, isolated to one commit each so the diff is readable.

---

## 7. Post-testing

**T1 — pure unit tests for `taxableBasis`** (`tests/unit/tax-basis.test.js`),
hand-computed, no engine. Must cover: standard vs itemised deduction; the
deduction exceeding income (floor at 0); pretax contributions; SS at 85%;
qualified dividends in `capitalGains` and not in `ordinaryTaxable`; §121
exclusion exceeding gains; `annualise` on and off. Hand-computed values, not
values printed by the implementation — a test written from the output cannot
falsify the output.

**T2 — empty-diff proof at steps 1, 2, 3, 6.** `git diff tests/baselines/`
returning nothing is the evidence that the extraction was behaviour-preserving.

**T3 — the mutation matrix.** For each of the seven sites, after migration:
mutate the site, record which fixtures drift. A site with no fixture that catches
it is not migrated, it is merely edited. Publish the matrix in the spec.

**T4 — reconciliation stays at 0 findings** on every fixture, and the
conservation law `TRANSFER + SPILLOVER(paired) + UNFUNDED(paired) === 0` holds.
Tax base changes must not move cash without an event.

**T5 — an independent hand calculation.** Take `single-home-sale`'s 2029 —
salary, a $488,452 gain, $250,000 excluded — and compute the year's federal
liability by hand from the published 2026 tables inflated to 2029. Compare with
the engine. This is the only check in the list that can catch the whole engine
being consistently wrong, which is precisely the failure mode a unification
introduces: every site agreeing on the same wrong number is indistinguishable
from every site agreeing on the right one, by any test that only compares sites
to each other.

**T6 — filing-status discrimination** (P6), re-run after step 4.

**T7 — golden files.** `tests/quickstart-golden.mjs` and
`tests/accumulation-oracle.mjs` will move at steps 4 and 5. Annotate each moved
value with which step moved it and why, as step 2b did. Never regenerate with
`--print-actual` before the prediction is recorded.

**T8 — full suite**: 158 unit tests, 34 integration suites, 18 snapshot fixtures.

---

## 8. Explicitly out of scope

- **The ×12 annualisation of a one-time month.** Present at three of the four
  ordinary-base sites. Real, already recorded as a tax-attribution gap, and
  orthogonal: unifying the base makes it easier to fix later, at one site.
- **Collapsing the three settlement points into one annual true-up.** Evaluated
  2026-08-06 and rejected for now: it would overstate balances for up to eleven
  months, and compounding on that is exactly the effect that moved
  `quickstart-midCareer` 10% in step 2b. Revisit only after the basis is unified,
  when the question is about timing alone.
- **Flat-85% Social Security taxability**, NIIT, Additional Medicare. `taxableBasis`
  is where they would eventually live, which is an argument for the extraction,
  not for doing them here.
