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
 *                    primary-home exclusion already applied at close, less any
 *                    deduction ordinary income was too small to absorb. Floored
 *                    at zero. IRC §1(h), §121, §63.
 *
 *   ltcgStackBase    What `capitalGains` is stacked ON to find its 0/15/20%
 *                    band. Equal to `ordinaryTaxable`, because the §1(h)
 *                    breakpoints are measured against taxable income with net
 *                    capital gain counted last.
 *
 *   unusedDeduction  Deduction left over after BOTH of the above have taken
 *                    what they can. Nonzero only when the deduction exceeds
 *                    ordinary income plus net capital gain combined.
 *
 *                    NO ENGINE SITE READS THIS TODAY. Its ONE justification is
 *                    the double-counting invariant below: a site that taxes a
 *                    gain not yet in this package must subtract the RESIDUAL,
 *                    not the raw overflow. The only caller that wanted it — the
 *                    close path — was measured and turned down (tax-engine.js
 *                    records why), so the invariant currently has no site to
 *                    protect.
 *
 *                    It does NOT serve NIIT or IRMAA, contrary to what this
 *                    comment claimed on 2026-08-18. Both key off MAGI, which is
 *                    AGI — measured BEFORE the standard deduction — so neither
 *                    can ever consult a leftover deduction. Do not keep this
 *                    field alive on that argument.
 *
 *                    KEPT ANYWAY, by an explicit decision on 2026-08-18: this
 *                    number is gain-harvesting headroom ("you can realise
 *                    $6,100 more long-term gain at zero tax"), and surfacing it
 *                    was parked pending a household income-optimization surface
 *                    rather than dropped. It cannot become a rule note as
 *                    things stand — rule-notes Rule 1 forbids recomputing an
 *                    unbooked amount, Rule 2 forbids allocating a household
 *                    fact to one asset, and every explanation surface here is
 *                    per-asset. Do not attribute it to individual assets to get
 *                    around that.
 *
 *   netInvestmentIncome  Income subject to the 3.8% net investment income tax:
 *                    interest, both kinds of dividend, and both kinds of
 *                    capital gain, less any §121 exclusion. Wages, Social
 *                    Security, pensions and qualified-plan distributions are
 *                    NOT in it. Gross of allocable deductions, which this model
 *                    does not track. Floored at zero. IRC §1411(c).
 *
 *   magi             Modified adjusted gross income, the figure the §1411
 *                    threshold is measured against. This is AGI — BEFORE the
 *                    standard or itemised deduction, AFTER the deductible
 *                    pre-tax contribution. NOT floored: a MAGI below the
 *                    threshold must stay below it, and the 3.8% calculation
 *                    floors its own result. IRC §1411(d).
 *
 *                    The asymmetry between these two is the point, not an
 *                    accident: an IRA or 401(k) distribution is OUT of
 *                    netInvestmentIncome but IN magi, so a withdrawal or Roth
 *                    conversion can never be taxed by NIIT itself and can still
 *                    drag other investment income into it. Roth distributions
 *                    raise neither.
 *
 * ── Why the deduction reaches the gains at all ───────────────────────
 *
 * This module originally floored `ordinaryTaxable` at zero and stopped, which
 * silently discarded the unabsorbed remainder. That is not what §63 does. The
 * standard deduction comes off TAXABLE INCOME, which includes capital gain;
 * §1(h) then splits taxable income into an ordinary part and a preferential
 * part, with the gain counted LAST. Counting it last is exactly why the
 * deduction lands on ordinary income first and only the excess reaches the
 * gain — it is not a separate rule, it is the same rule read in order. The IRS
 * mechanises it as the Qualified Dividends and Capital Gain Tax Worksheet,
 * where line 9 caps the 0% band at `min(taxable income, threshold)` — against
 * taxable income, not against gross gains.
 *
 * Discarding the remainder over-taxed exactly the household this simulator is
 * most often pointed at: an early retiree with little ordinary income living
 * off a brokerage account. Measured 2026-08-18 on the 2026 Single table — $0
 * ordinary income and $60,000 of long-term gain was billed $1,582.50 where the
 * worksheet says $0, because $43,900 of taxable income sits below the $49,450
 * top of the 0% band. The whole bill was an artifact of the floor.
 *
 * ── The double-counting trap, for whoever wires this up next ─────────
 *
 * `unusedDeduction` is what remains AFTER `capitalGains` has absorbed what it
 * can, not the raw ordinary-income overflow. Any site that taxes a gain not yet
 * added to this package must use it in that form, or it will spend the same
 * deduction dollars twice — once here against the gains already accumulated,
 * once there against the new one.
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
 * @returns {{ordinaryTaxable: Currency, capitalGains: Currency, ltcgStackBase: Currency,
 *            unusedDeduction: Currency, netInvestmentIncome: Currency, magi: Currency}}
 */
export function taxableBasis(pkg, activeUser, { annualise = false, taxTable = null } = {}) {

    const table = taxTable;

    const yearly = pkg.copy();
    if (annualise) yearly.multiply(12.0);

    // Order is load-bearing and matches every pre-existing call site: annualise
    // first, THEN cap the deductions. Capping a monthly contribution against an
    // annual limit and only then multiplying by twelve would let twelve times
    // the limit through.
    yearly.limitDeductions(activeUser, table);

    const ordinaryTaxable = table.calculateYearlyTaxableIncome(yearly);

    // Measured, not inferred from `ordinaryTaxable` — by the time that is
    // floored at zero the overflow is gone. Ordinary income is clamped at zero
    // too: a negative gross cannot buy MORE shelter than the deduction itself.
    const deduction = table.totalYearlyDeduction(yearly);
    const grossOrdinary = Math.max(0, yearly.irsTaxableGrossIncome().amount);
    const deductionOverflow = Math.max(0, deduction.amount - grossOrdinary);

    const grossGains = Math.max(0,
        yearly.longTermCapitalGains.amount
        + yearly.qualifiedDividends.amount
        - yearly.excludedCapitalGains.amount
    );

    // §1(h) counts net capital gain last, so the overflow lands here next.
    const capitalGains = new Currency(Math.max(0, grossGains - deductionOverflow));
    const unusedDeduction = new Currency(Math.max(0, deductionOverflow - grossGains));

    // ── IRC §1411 bases ──────────────────────────────────────────────
    //
    // BOTH sit ABOVE the deduction line. Neither is derived from
    // `ordinaryTaxable` and neither consults `unusedDeduction` — §1411 keys off
    // AGI (Form 1040 line 11), and the standard deduction is line 12. Deriving
    // MAGI from ordinaryTaxable would under-state it by the whole deduction and
    // put households under the threshold that are genuinely over it.

    const netInvestmentIncome = new Currency(Math.max(0,
        yearly.interestIncome.amount
        + yearly.nonQualifiedDividends.amount
        + yearly.qualifiedDividends.amount
        + yearly.shortTermCapitalGains.amount
        + yearly.longTermCapitalGains.amount
        // §121-excluded gain is out of NII as well as out of gross income.
        - yearly.excludedCapitalGains.amount
    ));

    // The deductible contribution as THIS ENGINE books it — 401(k) if there is
    // one, otherwise the traditional IRA. NOT `pkg.preTaxContribution()`, which
    // sums both: real AGI subtracts both, but `applyYearlyDeductions` has always
    // taken one or the other, and MAGI disagreeing with taxable income about the
    // same contribution is precisely the tenth-definition failure this module
    // exists to prevent. The either/or is a pre-existing simplification; fixing
    // it is its own change, not a side effect of adding NIIT.
    const { preTax } = table.deductionComponents(yearly);

    const magi = new Currency(
        yearly.irsTaxableGrossIncome().amount
        + yearly.longTermCapitalGains.amount
        + yearly.qualifiedDividends.amount
        - yearly.excludedCapitalGains.amount
        - preTax.amount
    );

    return {
        ordinaryTaxable,
        capitalGains,
        unusedDeduction,
        netInvestmentIncome,
        magi,
        // Copy, so a caller mutating one cannot silently move the other.
        ltcgStackBase: ordinaryTaxable.copy(),
    };
}
