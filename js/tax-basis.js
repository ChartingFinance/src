/**
 * tax-basis.js — the single definition of what a package owes tax on.
 *
 * ── Why this exists ──────────────────────────────────────────────────
 *
 * The engine used to answer "what is taxed?" in nine places, and they did not
 * agree. Two bugs on 2026-08-06 came from that and nothing else:
 *
 *   - IRC §121 was applied when a home closed and handed straight back by the
 *     April true-up, because the close path taxed the post-exclusion gain while
 *     the annual path recomputed the year from the gross one.
 *   - The bracket that long-term gains land in was measured against ordinary
 *     taxable income at the annual site, and against `monthly.totalIncome() ×
 *     12` at the close site — a gross rollup containing the gains themselves,
 *     tax-free Roth distributions and qualified dividends, with no deduction
 *     removed.
 *
 * Neither was a wrong formula. Both were two right formulas fed different
 * inputs. A new tax rule had to be threaded through every site by hand, and the
 * second site got missed.
 *
 * ── The semantics, fixed before the code was written ─────────────────
 *
 * Spec 6 precondition P2: these are decided and cited here so that migrating a
 * call site cannot quietly canonise whichever site happened to be copied first.
 *
 *   ordinaryTaxable  Income taxed at the ordinary rate schedule. Gross ordinary
 *                    income with Social Security included at 85%, less the
 *                    greater of the standard or itemised deduction, less
 *                    deductible pre-tax contributions. Floored at zero.
 *                    Long-term gains and qualified dividends are NOT in it —
 *                    they have their own schedule. IRC §1(a)-(d), §63, §86.
 *
 *   capitalGains     Income taxed at the preferential schedule: long-term
 *                    capital gains plus qualified dividends, less any §121
 *                    primary-home exclusion already applied at close. Floored
 *                    at zero. IRC §1(h), §121.
 *
 *   ltcgStackBase    What `capitalGains` is stacked ON to find its 0/15/20%
 *                    band. Equal to `ordinaryTaxable`, because the §1(h)
 *                    breakpoints are measured against taxable income with net
 *                    capital gain counted last.
 *
 * `ltcgStackBase` is a named field rather than an alias for `ordinaryTaxable`
 * on purpose: it states the intent at the call site, and it gives a future
 * threshold rule (NIIT, IRMAA) somewhere to live instead of creating the tenth
 * disagreeing definition.
 *
 * ── Rules for callers ────────────────────────────────────────────────
 *
 * Pass `annualise: true` for a MONTHLY package and false for a yearly one. The
 * ×12 that annualising performs is a known modelling gap — a one-off month is
 * extrapolated as though it recurred all year — and it is deliberately
 * preserved here rather than fixed, so that unifying the base is a refactor and
 * not two changes at once. See spec 6 §8.
 */

import { Currency } from './utils/currency.js';
import { activeTaxTable } from './globals.js';

/**
 * @param {import('./financial-package.js').FinancialPackage} pkg
 *        NOT mutated. Copied internally — `limitDeductions` and
 *        `applyYearlyDeductions` both mutate, and a helper that relied on every
 *        caller remembering to copy would be one refactor away from corrupting
 *        the live monthly package.
 * @param {import('./user.js').User} activeUser  for the age-banded deduction limits
 * @param {{annualise?: boolean, taxTable?: object}} [opts]
 *        `taxTable` defaults to the active one. TaxTable's own methods pass
 *        `this`, because a table that is not the active one would otherwise be
 *        asked for a basis and silently get the active table's brackets —
 *        currently unreachable, since every caller sets the active table first,
 *        but it is the kind of mismatch this module exists to prevent.
 * @returns {{ordinaryTaxable: Currency, capitalGains: Currency, ltcgStackBase: Currency}}
 */
export function taxableBasis(pkg, activeUser, { annualise = false, taxTable = null } = {}) {

    const table = taxTable ?? activeTaxTable;

    const yearly = pkg.copy();
    if (annualise) yearly.multiply(12.0);

    // Order is load-bearing and matches every pre-existing call site: annualise
    // first, THEN cap the deductions. Capping a monthly contribution against an
    // annual limit and only then multiplying by twelve would let twelve times
    // the limit through.
    yearly.limitDeductions(activeUser);

    const ordinaryTaxable = table.calculateYearlyTaxableIncome(yearly);

    const capitalGains = new Currency(
        yearly.longTermCapitalGains.amount
        + yearly.qualifiedDividends.amount
        - yearly.excludedCapitalGains.amount
    );
    if (capitalGains.amount < 0) capitalGains.zero();

    return {
        ordinaryTaxable,
        capitalGains,
        // Copy, so a caller mutating one cannot silently move the other.
        ltcgStackBase: ordinaryTaxable.copy(),
    };
}
