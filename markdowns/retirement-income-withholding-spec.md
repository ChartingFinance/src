# Spec 4c — Withholding on arrival for retirement income

Status: **proposed, not applied.** Written 2026-08-05.
Third and last of the tax-attribution set, after
[4b](tax-withholding-spec.md) (source withholding on deferred balances, PR #23)
and [4a](tax-allocation-spec.md) (proportional allocation across balances,
PR #24). Predictions in §6 are recorded before implementation.

---

## 1. The gap, measured

Social Security and pension are the only taxable income with **no attribution
mechanism at all**. 4b withholds at the source of a *balance*; 4a allocates
across *balances*; a flow has neither. Their tax lands wherever
`resolveFunding()` points.

Measured on `main` @ 15dfbaf:

| Scenario | SS income | Pension | Flows as % of household taxable income |
|---|---:|---:|---:|
| Early Career | $854,015 | — | 7.3% |
| Mid Career | $970,471 | — | 13.6% |
| Pre-Retirement | $1,209,993 | — | 19.0% |
| **Retired** | $1,278,421 | $875,712 | **50.8%** |
| Reference | $950,909 | — | 12.8% |

In the Retired profile over half of taxable income is unattributed, and the
brokerage — which generates **$0** of taxable income there — pays $318,760 of tax
on it. That is the original complaint in its purest form and neither prior spec
can reach it.

Only one fixture carries a pension. SS is in all five.

## 2. Why this needs a different mechanism

`RetirementIncomeBehavior` and `PensionBehavior`
([instrument-behavior.js:126](../js/instruments/instrument-behavior.js),
[:152](../js/instruments/instrument-behavior.js)) are **flows, not balances**:

```js
const income = asset.finishCurrency.copy();
asset.addToMetric(M.SOCIAL_SECURITY_INCOME, income);
asset.netIncomeCurrency.add(income);
```

`finishCurrency` on these instruments is a monthly RATE, not a stock. Three
consequences, each of which has already bitten something:

1. **They cannot be debited.** `#transact` short-circuits for flow instruments
   ([model-asset.js:751](../js/model-asset.js)): it records the event, changes no
   balance, and returns `spillover: zero` — so a caller believes the money was
   collected. 4b's withhold-**after** shape (an extra debit of `X·r/(1−r)`) books
   the obligation and moves nothing.
2. **They must never enter `FUNDING_BACKSTOP_PRIORITY`.** `resolveFunding`
   selects on `finishCurrency.amount > 0`, so a $3,000/mo benefit looks like a
   $3,000 account that never depletes and would be drafted every month forever.
3. **They are correctly ineligible for 4a**, whose gate requires a balance.

The mechanism that fits is **withhold on arrival**: reduce what lands, exactly as
payroll already does for a salary. No balance to clamp, no spillover possible, no
short-circuit. It is also structurally the highest-priority funding there is —
the tax comes out before the cash reaches any account.

## 3. The seam

`PayrollEngine.#applyNetIncomeInScope` opens with:

```js
if (!InstrumentType.isWorkingIncome(modelAsset.instrument)) return;
```

**That early return is the gap.** Everything after it — FICA, the proportional
share of household tax, `modelAsset.netIncomeCurrency = netIncome` — is the
withhold-on-arrival machinery, applied only to salary.

Ordering already works. `applyNetIncome` runs at
[portfolio.js:723](../js/portfolio.js); the unallocated sweep to the backstop is
`applyPostTaxTransfers` at [:738](../js/portfolio.js), reading
`modelAsset.netIncomeCurrency` at
[payroll-engine.js:503](../js/engines/payroll-engine.js). Reducing
`netIncomeCurrency` before the sweep means less lands, which is the whole change.

**One site, not six.** 4b's "monthly sweep, not per-draw hooks" lesson does not
transfer: there is exactly one place retirement income becomes net and one place
it sweeps. A branch here is total by construction.

## 4. Policy — decided 2026-08-05

The two instruments have genuinely different real-world defaults and must not be
treated alike.

**Pension withholds by default.** Form W-4P's default for periodic payments is to
withhold. A pension that withholds by default mirrors the form.

**Social Security withholds only at an elected rate, defaulting to NONE.** Form
W-4V is elective at 7/10/12/22% with no default; the real-world default is no
withholding, and most recipients never file one. A non-optional SS withholding
would be inventing policy rather than modelling it — the same objection that kept
SS out of 4b.

```js
/** Federal withholding on a periodic pension payment (Form W-4P default). */
export const global_pension_withholding_rate = 0.10;

/**
 * Federal withholding on Social Security. Form W-4V is ELECTIVE — 7/10/12/22%,
 * no default — and not filing one is the common case, so 0 is the faithful
 * default. Non-zero only when the user elects it.
 */
export let global_social_security_withholding_rate = 0.0;
```

Consequence to state plainly rather than paper over: **SS stays unattributed by
default**, which is 50.8% of taxable income in the Retired profile. That is the
honest answer, not a shortfall of the mechanism — the mechanism is there the
moment a rate is elected.

## 5. What this does not fix

**The flat 85% inclusion ratio stays.**
`FinancialPackage.irsTaxableGrossIncome` includes SS at a flat 85%
([financial-package.js:62–63](../js/financial-package.js)) instead of the
provisional-income formula. That makes the tax TOTAL wrong.

It is **orthogonal to this spec** and deliberately deferred to its own PR. An
earlier draft claimed withholding against a wrong base "compounds two errors";
that reasoning was wrong. Withholding governs ATTRIBUTION and the true-ups
reconcile the total either way — the same argument 4b makes for its flat rate. A
wrong base misstates what is owed whether or not anything withholds.

**The comment at [metric.js:167–170](../js/metric.js) — "Retirement income
(pension, Social Security) has no per-asset tax leaf... adding one means adding a
writer too" — IS falsified by this PR** and must be updated in it. That is
exactly what §3 adds. 4b's spec listed this comment as surviving *because* SS and
pension were out of scope; they are now in scope.

**`PensionBehavior.relevantMetrics()` has no tax metrics at all**
([instrument-behavior.js:144](../js/instruments/instrument-behavior.js)) — no
`WITHHELD_INCOME_TAX`, no `INCOME_TAX`, none of the `FEDERAL_TAXES → TAXES`
chain that `CapitalBehavior` carries. Withholding booked without adding them
lands in `NULL_METRIC` and vanishes silently. Same for
`RetirementIncomeBehavior`. **This is the most likely way for this PR to ship
looking correct and doing nothing.**

## 6. Predictions — recorded before implementation

| # | Prediction | Why it discriminates |
|---|---|---|
| 6.1 | At rate 0 the run is **event-for-event identical** to one without the feature | Proves no ungated side effects. Also the shipping default for SS |
| 6.2 | Lifetime tax **does NOT rise**, and should fall slightly | The opposite of 4a. Withholding a flow creates no new taxable income — it only redirects cash. Less lands in the brokerage, so less compounds into future dividends and gains. **A RISE means income is being double-counted** |
| 6.3 | The tax identity holds — collected == liability, recomputed per year from income through the public tax API | Separates a redirect from a leak |
| 6.4 | Household taxable income is **unchanged** at every rate | Withholding must reduce what LANDS, not what is EARNED. `SOCIAL_SECURITY_INCOME` / `PENSION_INCOME` are already gross and must stay gross — the 4b §4.1 table's "no gross-up" column |
| 6.5 | Reconciliation stays at **0 findings** | 4a's spill-bucketing fix is fresh; this must not reopen it |
| 6.6 | The Retired profile's brokerage receives **less** cash and pays **less** tax | The headline behaviour change, and the only fixture with a pension |

6.2 and 6.4 together are the pair that catch the plausible failure: booking the
withheld amount as a second distribution, the way 4b legitimately does for a
balance. A flow's income is already gross; adding to it inflates taxable income
and raises the bill.

## 7. Tests

1. **Neutrality at rate 0** — both rates zeroed, event-for-event identical.
   Mutation-verify by defaulting the SS rate non-zero.
2. **Pension withholds, SS does not, at defaults** — the policy in §4, asserted as
   behaviour. The Retired profile is the only fixture that reaches the pension
   path; assert it carries pension income first, or the test is vacuous. (Three
   tests in the 4a suite were vacuous for exactly this reason.)
3. **Metrics are actually registered** — assert the withheld amount appears on the
   asset's own ledger, not just in the household package. Mutation-verify by
   removing the tax metrics from `PensionBehavior.relevantMetrics()`; §5 predicts
   that mutation is otherwise silent.
4. **Gross income unchanged** — §6.4, across several rates.
5. **Tax identity** — §6.3, independent recomputation.
6. **A flow is never a funding source** — assert no retirement-income instrument
   appears in `FUNDING_BACKSTOP_PRIORITY` and that `resolveFunding` never returns
   one. Cheap, and it guards §2's trap, which is a one-line change that looks
   obviously correct.

## 8. Sequencing

1. Rates in `globals.js` + `relevantMetrics()` additions. No behaviour change.
2. The `#applyNetIncomeInScope` branch, both rates defaulting to 0. §7.1.
3. Flip the pension default to 0.10; re-bless against §6. §7.2–7.6.
4. `metric.js:167–170` comment (§5) and a rule note saying the rule fired —
   [[feedback-runtime-rule-confirmation]]: a non-optional withholding the user
   did not choose must be visible.

Related: [[project-tax-funding-routing]], [[project-tax-allocation-4a]],
[[project-tax-attribution-gaps]], [[feedback-predict-before-engine-fix]].
