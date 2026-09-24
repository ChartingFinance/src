/**
 * tax-allocation.js
 *
 * Who pays the residual household tax (markdowns/tax-allocation-spec.md).
 * Off by default (`allocateHouseholdTax`).
 *
 * Without it, the true-ups bill the whole tax to the funding backstop, whatever
 * account earned the income. This module answers "whose income was it?" so the
 * tax engine can bill each account its share.
 *
 * Pure: every answer is a function of already-booked metrics, so
 * tests/tax-allocation.mjs can check the arithmetic without a simulation.
 *
 * It does not widen FUNDING_BACKSTOP_PRIORITY: the engine still never draws a
 * retirement account implicitly to pay an expense, mortgage or property tax.
 * Allocation only decides who is billed for tax on income it generated.
 */

import { Metric } from './metric.js';
import { InstrumentType } from './instruments/instrument.js';
import { global_deferred_allocation_age } from './policy-constants.js';

/**
 * The metrics that make up an asset's contribution to federal taxable income.
 *
 * Not Metric.INCOME, which also rolls up TAX_FREE_DISTRIBUTION and would give
 * a Roth a share. The three are disjoint in the rollup DAG, so summing them
 * double-counts nothing.
 */
export const BASIS_METRICS = Object.freeze([
  Metric.ORDINARY_INCOME,
  Metric.CAPITAL_GAIN,
  Metric.QUALIFIED_DIVIDEND,
]);

/**
 * An asset's contribution to NET INVESTMENT INCOME — the §1411 base.
 *
 * Not BASIS_METRICS: that includes wages, pensions, Social Security and
 * retirement distributions, which are not investment income and cannot trigger
 * NIIT. The five are disjoint in the rollup DAG, and named individually because
 * no rollup node means "investment income".
 */
export const NII_BASIS_METRICS = Object.freeze([
  Metric.INTEREST_INCOME,
  Metric.NON_QUALIFIED_DIVIDEND,
  Metric.QUALIFIED_DIVIDEND,
  Metric.SHORT_TERM_CAPITAL_GAIN,
  Metric.LONG_TERM_CAPITAL_GAIN,
]);

/**
 * This month's taxable income for one asset.
 *
 * Reads the live accumulators, valid only before the month's snapshot zeroes
 * them — right for the monthly true-up. The annual site uses basisOverMonths.
 */
export function basisThisMonth(modelAsset) {
  let total = 0;
  for (const metric of BASIS_METRICS) {
    total += modelAsset.getMetricAmount(metric);
  }
  return total;
}

/**
 * Taxable income for one asset across a closed range of history indices.
 *
 * For the annual true-up, which runs on January 1 of the following year, when
 * the live accumulators are already zeroed and would read zero for every
 * asset.
 *
 * @param {number} loIndex inclusive
 * @param {number} hiIndex inclusive
 */
export function basisOverMonths(modelAsset, loIndex, hiIndex, metrics = BASIS_METRICS) {
  let total = 0;
  for (const metric of metrics) {
    const history = modelAsset.getHistory(metric);
    if (!history) continue;
    const hi = Math.min(hiIndex, history.length - 1);
    for (let i = Math.max(0, loIndex); i <= hi; i++) total += (history[i] ?? 0);
  }
  return total;
}

/**
 * May this asset be billed for tax on income it generated?
 *
 * Everyday accounts always. Tax-deferred accounts once the holder is past the
 * early-withdrawal age, when drawing on them costs only the ordinary-income tax
 * the draw is paying anyway.
 *
 * A Roth is excluded here, and again by its basis (its distributions are
 * TAX_FREE_DISTRIBUTION, outside BASIS_METRICS): the gate states the intent,
 * the basis enforces it.
 *
 * Income and pension assets are flows with no balance to debit; they withhold
 * on arrival instead.
 *
 * @param {number} userAge whole years; the engine has no finer resolution
 */
export function isAllocationEligible(modelAsset, userAge) {
  if (modelAsset.isClosed) return false;
  if (modelAsset.finishCurrency.amount <= 0) return false;

  if (InstrumentType.isFundingBackstop(modelAsset.instrument)) return true;
  if (InstrumentType.isTaxDeferred(modelAsset.instrument)) {
    return userAge >= global_deferred_allocation_age;
  }
  return false;
}

/**
 * Split `billAmount` across candidates in proportion to their basis, exactly.
 *
 * Largest-remainder in whole cents, so the legs sum to the bill exactly:
 * reconciliation compares against the FinancialPackage to the cent.
 *
 * Candidates with a non-positive basis are dropped rather than given $0 legs,
 * so callers never book a zero-amount settlement.
 *
 * @param {number} billAmount positive dollars
 * @param {{modelAsset: object, basis: number}[]} candidates
 * @returns {{modelAsset: object, amount: number, share: number}[]} sums to billAmount
 */
export function planAllocation(billAmount, candidates) {
  const eligible = candidates.filter(c => c.basis > 0);
  if (billAmount <= 0 || eligible.length === 0) return [];

  const totalBasis = eligible.reduce((sum, c) => sum + c.basis, 0);
  if (totalBasis <= 0) return [];

  const billCents = Math.round(billAmount * 100);
  if (billCents <= 0) return [];

  const rows = eligible.map((c) => {
    const exact = billCents * c.basis / totalBasis;
    const whole = Math.floor(exact);
    return { modelAsset: c.modelAsset, cents: whole, fraction: exact - whole, share: c.basis / totalBasis };
  });

  // Hand out the cents that flooring dropped, largest fractional part first.
  let leftover = billCents - rows.reduce((sum, r) => sum + r.cents, 0);
  const byFraction = [...rows].sort((a, b) => b.fraction - a.fraction);
  for (let i = 0; leftover > 0; i = (i + 1) % byFraction.length) {
    byFraction[i].cents += 1;
    leftover -= 1;
  }

  return rows
    .filter(r => r.cents > 0)
    .map(r => ({ modelAsset: r.modelAsset, amount: r.cents / 100, share: r.share }));
}
