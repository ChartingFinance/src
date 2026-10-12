/**
 * tax-basis.js — what a FinancialPackage owes tax on, defined once.
 *
 * Every tax site reads its base from taxableBasis(). When sites computed their
 * own, two of them disagreed about the same income: correct formulas, fed
 * different inputs.
 *
 * ── The fields ───────────────────────────────────────────────────────
 *
 *   ordinaryTaxable  Taxed at the ordinary brackets. Ordinary income, counting
 *                    only the §86 taxable part of Social Security, less the
 *                    larger of the standard or itemised deduction, the age-65
 *                    deductions and deductible pre-tax contributions. Excludes
 *                    long-term gains and qualified dividends. Floored at 0.
 *                    IRC §1(a)-(d), §63, §86.
 *
 *   capitalGains     Taxed at the 0/15/20% rates. Long-term gains plus
 *                    qualified dividends, less any §121 home-sale exclusion, less
 *                    any deduction ordinary income was too small to use.
 *                    Floored at 0. IRC §1(h), §121.
 *
 *   ltcgStackBase    The income capitalGains sits on top of to find its rate
 *                    band. Equal to ordinaryTaxable, because §1(h) counts gains
 *                    last; named separately so call sites say what they mean.
 *
 *   unusedDeduction  Deduction left over after both of the above. No engine site
 *                    reads it. It is kept as gain-harvesting headroom for a future
 *                    household-level view. It is a household figure: do not
 *                    attribute it to individual assets.
 *
 *   netInvestmentIncome  The NIIT base: interest, dividends and capital gains,
 *                    less the §121 exclusion. Not wages, Social Security,
 *                    pensions or IRA/401(k) distributions. IRC §1411(c).
 *
 *   taxableSocialSecurity  The §86 taxable part of the year's benefits: the
 *                    amount ordinaryTaxable and agi count.
 *
 *   agi              Adjusted gross income (Form 1040 line 11): before the
 *                    standard deduction, after pre-tax contributions. Not
 *                    floored. IRC §62.
 *
 *   magi             The modified AGI each rule measures against, keyed by
 *                    MagiPurpose. Each starts from agi and adds or removes
 *                    what that rule's statute names. The model has no foreign
 *                    income and no tax-exempt interest, so those add-backs are
 *                    always zero.
 *
 *     niit              agi. IRC §1411(d). An IRA distribution raises it
 *                       without being investment income, so it can push other
 *                       income into NIIT without being taxed by NIIT itself.
 *     seniorDeduction   agi. The OBBBA senior deduction phases out on it.
 *     irmaa             agi. 42 U.S.C. §1395r(i)(4). Medicare applies a
 *                       year's figure to the premiums two years later.
 *     iraDeduction      agi before the traditional-IRA deduction, with §86
 *                       recomputed without it. IRC §219(g)(3); the order of
 *                       Pub. 590-A appendix B.
 *     rothContribution  the iraDeduction figure less Roth conversion income.
 *                       IRC §408A(c)(3)(B)(i). Pub. 590-A worksheet 2-1 adds
 *                       the IRA deduction back without recomputing §86, so the
 *                       two differ when a household with Social Security also
 *                       deducts an IRA contribution.
 *     aca               agi plus the benefits §86 leaves untaxed.
 *                       IRC §36B(d)(2)(B).
 *
 *                    Every MAGI rule is annual, so magi is null when the
 *                    package is an annualised month. Portfolio.taxYears
 *                    records the family once per settled year.
 *
 * ── How the deduction reaches the gains ──────────────────────────────
 *
 * §63 takes the deduction off all taxable income, gains included, and §1(h)
 * counts gains last. So the deduction is used against ordinary income first and
 * only the excess reduces capitalGains — the same order as the IRS Qualified
 * Dividends and Capital Gain Tax Worksheet. It matters most for an early retiree
 * living off a brokerage account, whose gains may owe nothing.
 *
 * A site that taxes a gain not yet in this package must use unusedDeduction —
 * what is left AFTER capitalGains — or it will spend the same deduction twice.
 *
 * ── For callers ──────────────────────────────────────────────────────
 *
 * Pass `annualise: true` for a monthly package. Annualising multiplies the month
 * by 12, so a one-off month is treated as if it recurred all year. That is a
 * known modelling gap, left as it is so that this module changes no numbers.
 */

import { Currency } from './utils/currency.js';

/** The rules that measure income against a modified AGI. See the module header. */
export const MagiPurpose = Object.freeze({
    NIIT: 'niit',
    SENIOR_DEDUCTION: 'seniorDeduction',
    IRMAA: 'irmaa',
    IRA_DEDUCTION: 'iraDeduction',
    ROTH_CONTRIBUTION: 'rothContribution',
    ACA: 'aca',
});

/**
 * IRC §86 — the part of a year's Social Security benefits that is taxable.
 *
 * Based on provisional income: everything else in AGI plus half the benefits
 * (IRS Pub. 915, worksheet 1).
 *
 *     provisional ≤ base              nothing taxable
 *     base < provisional ≤ adjusted   min(½ benefits, ½ (provisional − base))
 *     provisional > adjusted          min(85% benefits,
 *                                         85% (provisional − adjusted)
 *                                         + min(½ benefits, ½ (adjusted − base)))
 *
 * `otherIncome` must include long-term gains and qualified dividends: they have
 * their own rates, but they are part of AGI.
 *
 * @param {number} benefits     the year's gross benefits
 * @param {number} otherIncome  AGI excluding benefits
 * @param {{base: number, adjusted: number}} thresholds  by filing status, never indexed
 * @returns {number}
 */
export function taxableSocialSecurity(benefits, otherIncome, { base, adjusted }) {
    if (!(benefits > 0)) return 0;
    const provisional = otherIncome + 0.5 * benefits;
    if (provisional <= base) return 0;
    if (provisional <= adjusted) return Math.min(0.5 * benefits, 0.5 * (provisional - base));
    return Math.min(
        0.85 * benefits,
        0.85 * (provisional - adjusted) + Math.min(0.5 * benefits, 0.5 * (adjusted - base)),
    );
}

/**
 * One rule's MAGI. The module header gives each definition.
 *
 * With no IRA deduction the §219(g) figure is agi exactly, not agi plus a
 * rounding error: §86 is re-run on the same inputs.
 *
 * @param {string} purpose  a MagiPurpose
 * @param {object} parts
 * @param {number} parts.agi
 * @param {{benefits: number, otherIncome: number, taxable: number}} parts.socialSecurity
 *        from FinancialPackage.socialSecurityTaxation()
 * @param {number} parts.iraDeduction    the traditional-IRA deduction inside agi
 * @param {number} parts.rothConversion  the conversion income inside agi
 * @param {{base: number, adjusted: number}} parts.thresholds  §86, by filing status
 * @returns {number}
 */
function magiAmount(purpose, { agi, socialSecurity, iraDeduction, rothConversion, thresholds }) {
    const { benefits, otherIncome, taxable } = socialSecurity;
    switch (purpose) {
        case MagiPurpose.NIIT:
        case MagiPurpose.SENIOR_DEDUCTION:
        case MagiPurpose.IRMAA:
            return agi;
        case MagiPurpose.IRA_DEDUCTION:
        case MagiPurpose.ROTH_CONTRIBUTION: {
            // §219(g)(3) measures income as if the IRA deduction did not
            // exist, and the §86 test inside it moves with it.
            const taxableBeforeIRA = taxableSocialSecurity(benefits,
                otherIncome + iraDeduction, thresholds);
            const beforeIRADeduction = agi + iraDeduction + (taxableBeforeIRA - taxable);
            return purpose === MagiPurpose.IRA_DEDUCTION
                ? beforeIRADeduction
                : beforeIRADeduction - rothConversion;
        }
        case MagiPurpose.ACA:
            return agi + (benefits - taxable);
        default:
            throw new Error(`tax-basis: unknown MAGI purpose ${JSON.stringify(purpose)}`);
    }
}

/**
 * The tax bases for one package. See the module header for what each field
 * means.
 *
 * @param {import('./financial-package.js').FinancialPackage} pkg
 *        Not mutated: it is copied, because the deduction helpers mutate.
 * @param {import('./user.js').User} activeUser  age drives the deduction limits
 *        and the age-65 deductions
 * @param {{annualise?: boolean, taxTable: object}} opts
 *        `taxTable` is required — the run's own table. TaxTable's own methods
 *        pass `this`.
 * @returns {{ordinaryTaxable: Currency, capitalGains: Currency, ltcgStackBase: Currency,
 *            unusedDeduction: Currency, netInvestmentIncome: Currency,
 *            taxableSocialSecurity: Currency, agi: Currency,
 *            magi: ?Readonly<Record<string, Currency>>}}  magi is null when annualised
 */
export function taxableBasis(pkg, activeUser, { annualise = false, taxTable = null } = {}) {

    const table = taxTable;

    const yearly = pkg.copy();
    if (annualise) yearly.multiply(12.0);

    // Annualise first, then cap the deductions. The other order would cap a
    // monthly contribution against an annual limit and then multiply it by 12.
    yearly.limitDeductions(activeUser, table);

    // AGI sits above every deduction, and the senior deduction phases out on a
    // MAGI built from it. `preTax` is the deductible contribution as this
    // engine books it (the 401(k) if there is one, otherwise the traditional
    // IRA), so AGI and taxable income agree about it. Real AGI also subtracts a
    // traditional-IRA contribution whenever §219(g) allows the deduction; see
    // markdowns/code-issues-from-comments.md #7.
    const { preTax, iraDeduction } = table.deductionComponents(yearly);
    const socialSecurity = yearly.socialSecurityTaxation(table);
    const agi = new Currency(
        yearly.irsTaxableGrossIncome(table, socialSecurity).amount
        + yearly.longTermCapitalGains.amount
        + yearly.qualifiedDividends.amount
        - yearly.excludedCapitalGains.amount
        - preTax.amount
    );
    // What the MAGI definitions draw on, beyond agi itself.
    const magiParts = {
        agi: agi.amount,
        socialSecurity,
        iraDeduction: iraDeduction.amount,
        rothConversion: yearly.rothConversion.amount,
        thresholds: table.activeSocialSecurityThresholds,
    };

    // §63(f) and the OBBBA senior deduction. Zero for anyone under 65.
    const age = table.ageDeductions(activeUser,
        new Currency(magiAmount(MagiPurpose.SENIOR_DEDUCTION, magiParts)));

    const ordinaryTaxable = table.calculateYearlyTaxableIncome(yearly, age);

    // The overflow is computed from gross figures: ordinaryTaxable is already
    // floored at zero, so the overflow cannot be read back from it. Age
    // deductions overflow onto the gains the same way the standard one does.
    const deduction = table.totalYearlyDeduction(yearly, age);
    const grossOrdinary = Math.max(0, yearly.irsTaxableGrossIncome(table).amount);
    const deductionOverflow = Math.max(0, deduction.amount - grossOrdinary);

    const grossGains = Math.max(0,
        yearly.longTermCapitalGains.amount
        + yearly.qualifiedDividends.amount
        - yearly.excludedCapitalGains.amount
    );

    // §1(h) counts net capital gain last, so the overflow lands here next.
    const capitalGains = new Currency(Math.max(0, grossGains - deductionOverflow));
    const unusedDeduction = new Currency(Math.max(0, deductionOverflow - grossGains));

    // ── NIIT (§1411) ─────────────────────────────────────────────────
    //
    // Its bases sit above the deduction line (Form 1040 line 11, before line
    // 12), so neither uses ordinaryTaxable or unusedDeduction.

    const netInvestmentIncome = new Currency(Math.max(0,
        yearly.interestIncome.amount
        + yearly.nonQualifiedDividends.amount
        + yearly.qualifiedDividends.amount
        + yearly.shortTermCapitalGains.amount
        + yearly.longTermCapitalGains.amount
        // §121-excluded gain is out of NII as well as out of gross income.
        - yearly.excludedCapitalGains.amount
    ));

    // Every MAGI rule is annual, so the family exists only for a full-year
    // package: an annualised month has none to misread, and the monthly sites
    // skip the cost of building it. Each member is its own Currency, so
    // mutating one cannot move another.
    const magi = annualise ? null : Object.freeze(Object.fromEntries(
        Object.values(MagiPurpose).map((purpose) =>
            [purpose, new Currency(magiAmount(purpose, magiParts))])));

    return {
        ordinaryTaxable,
        capitalGains,
        unusedDeduction,
        netInvestmentIncome,
        taxableSocialSecurity: new Currency(socialSecurity.taxable),
        agi,
        magi,
        // Copy, so a caller mutating one cannot silently move the other.
        ltcgStackBase: ordinaryTaxable.copy(),
    };
}
