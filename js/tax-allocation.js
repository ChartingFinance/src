/**
 * tax-allocation.js
 *
 * Spec 4a — who pays the residual household tax.
 *
 * Income tax is the only obligation in the engine with no routing layer. Every
 * other money movement consults the asset's own fundTransfers and falls back to
 * resolveFunding(); the monthly and annual true-ups go straight to the backstop,
 * so the first liquid account pays the household's whole bill no matter which
 * account earned the income. This module answers "whose income was it?" so the
 * tax engine can bill accordingly.
 *
 * It is deliberately pure: no Currency mutation, no engine state, no logging.
 * Everything here is a function of an asset's already-booked metrics, which is
 * what lets tests/tax-allocation.mjs check the arithmetic without running a
 * simulation.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * It does not widen FUNDING_BACKSTOP_PRIORITY. The engine still never implicitly
 * draws a retirement account to pay an expense, a mortgage, property tax or a
 * spillover, at any age. Allocation decides who is billed for tax on income they
 * already generated — a strictly narrower claim than "this account is available
 * to spend." See markdowns/tax-allocation-spec.md §2.
 */

import { Metric } from './metric.js';
import { InstrumentType } from './instruments/instrument.js';
import { global_deferred_allocation_age } from './globals.js';

/**
 * The metrics that make up an asset's contribution to federal taxable income.
 *
 * NOT Metric.INCOME. That parent also rolls up TAX_FREE_DISTRIBUTION
 * (metric.js MetricRollups), so using it would hand a Roth a share of the tax
 * bill on money that is not taxed.
 *
 * The three are disjoint under the rollup DAG: QUALIFIED_DIVIDEND rolls only to
 * INCOME, LONG_TERM_CAPITAL_GAIN rolls to CAPITAL_GAIN, and interest,
 * non-qualified dividends and short-term gains all roll to ORDINARY_INCOME.
 * Summing them double-counts nothing.
 */
export const BASIS_METRICS = Object.freeze([
  Metric.ORDINARY_INCOME,
  Metric.CAPITAL_GAIN,
  Metric.QUALIFIED_DIVIDEND,
]);

/**
 * This month's taxable income for one asset.
 *
 * Reads the LIVE accumulators, which are valid only before the month's
 * snapshot. Portfolio.applyMonth runs the monthly true-up; monthlyChron
 * snapshots and zeroes afterwards. Correct for the monthly site, and returns
 * zero everywhere else — see basisOverMonths for the annual site.
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
 * The annual true-up needs this rather than basisThisMonth: applyYear fires on
 * January 1 of the FOLLOWING year, by which point every month of the settled
 * year — December included — has been snapshotted and zeroed. Reading the live
 * accumulators there returns zero for every asset, which degrades silently into
 * "nothing is eligible" and looks exactly like the old behaviour.
 *
 * @param {number} loIndex inclusive
 * @param {number} hiIndex inclusive
 */
export function basisOverMonths(modelAsset, loIndex, hiIndex) {
  let total = 0;
  for (const metric of BASIS_METRICS) {
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
 * Everyday accounts always. Tax-DEFERRED accounts once the holder is past the
 * early-withdrawal age, because from then on the only consequence of drawing on
 * them is the ordinary-income tax the draw is paying in the first place.
 *
 * Roth is excluded here, and excluded AGAIN by the basis: a Roth's
 * distributions book to TAX_FREE_DISTRIBUTION, which BASIS_METRICS omits, so
 * its basis is structurally zero and it cannot take a share even if this
 * predicate were wrong. Probed across five scenarios — adding tax-free
 * instruments to this gate moved $0. Both halves are kept: the gate states the
 * intent, the basis enforces it.
 *
 * Income and pension instruments are absent because they are flows with no
 * balance to debit. Their attribution needs withholding-on-arrival, not
 * allocation — a different mechanism, deliberately out of scope.
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
 * Largest-remainder in whole cents. Proportional shares do not land on cent
 * boundaries, and letting the drift ride would break the conservation assertion
 * that the legs sum to the bill — the annual true-up's own $1 materiality
 * threshold would hide it, but reconciliation compares against the
 * FinancialPackage far more tightly than that.
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
