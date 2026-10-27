/**
 * premium-tax-credit.js — IRC §36B, the ACA premium tax credit.
 *
 * The law as per-year data, and the arithmetic Form 8962 does with it. Pure
 * functions with no engine state: the engine supplies the household's income
 * and coverage months, and tests/aca-oracle.mjs checks the results against an
 * independent reading of the form.
 *
 * ── The credit ───────────────────────────────────────────────────────
 *
 * For each month of marketplace coverage (Form 8962 Part II):
 *
 *     credit = min(premium, max(0, benchmark − annual contribution / 12))
 *
 * `benchmark` is the second-lowest-cost silver plan (SLCSP) for the household
 * and `premium` is what the plan bought costs, both summed over the household's
 * policies. The annual contribution is the applicable percentage times
 * household income, which is ACA MAGI (IRC §36B(d)(2)(B)).
 *
 * The applicable percentage depends on household income as a percentage of the
 * poverty line for the household's size, on a straight line within each band
 * (Treas. Reg. §1.36B-3(g)). This module follows Form 8962: the percentage is
 * rounded to a whole number (line 5), the applicable figure is the line's value
 * there to four decimals (Table 2), and the contributions are whole dollars
 * (lines 8a and 8b).
 *
 * ── Who gets it ──────────────────────────────────────────────────────
 *
 * No credit when household income is over 400% of the poverty line
 * (§36B(c)(1)(A)), tested in dollars, so one dollar over loses it all. None
 * below 100% either, unless the household enrolled with an advance credit paid
 * on an estimate of 100% to 400% (Treas. Reg. §1.36B-2(b)(6)); it then keeps
 * the credit at the lowest band.
 *
 * ── The tables ───────────────────────────────────────────────────────
 *
 * PTC_TABLES is keyed by coverage year. Each year uses the poverty guidelines
 * HHS published the year before, for the 48 contiguous states and D.C. Past the
 * last published year `ptcTableFor` indexes the last one: the poverty line by a
 * price level, the percentages by a premium-growth factor, because §36B(b)(3)
 * (A)(ii) adjusts them each year for premium growth over income growth. A
 * revived enhanced schedule (no cliff, an 8.5% cap) would be a new entry here.
 */

/**
 * One coverage year's parameters.
 *
 *   povertyLine  the HHS guideline the year uses: `first` for one person,
 *                plus `additional` for each person after the first
 *   bands        applicable percentages by income as a multiple of the poverty
 *                line: each band runs from the previous band's `upTo` (0 for
 *                the first) up to, not including, its own `upTo`, rising in a
 *                straight line from `initial` to `final`. The last band
 *                includes its `upTo`.
 *   cliff        the multiple above which there is no credit
 */
export const PTC_TABLES = Object.freeze({
    // Rev. Proc. 2025-25; 2025 HHS poverty guidelines.
    2026: Object.freeze({
        povertyLine: Object.freeze({ first: 15650, additional: 5500 }),
        bands: Object.freeze([
            Object.freeze({ upTo: 1.33, initial: 0.0210, final: 0.0210 }),
            Object.freeze({ upTo: 1.50, initial: 0.0314, final: 0.0419 }),
            Object.freeze({ upTo: 2.00, initial: 0.0419, final: 0.0660 }),
            Object.freeze({ upTo: 2.50, initial: 0.0660, final: 0.0844 }),
            Object.freeze({ upTo: 3.00, initial: 0.0844, final: 0.0996 }),
            Object.freeze({ upTo: 4.00, initial: 0.0996, final: 0.0996 }),
        ]),
        cliff: 4.0,
    }),
    // Rev. Proc. 2026-26; 2026 HHS poverty guidelines.
    2027: Object.freeze({
        povertyLine: Object.freeze({ first: 15960, additional: 5680 }),
        bands: Object.freeze([
            Object.freeze({ upTo: 1.33, initial: 0.0215, final: 0.0215 }),
            Object.freeze({ upTo: 1.50, initial: 0.0323, final: 0.0430 }),
            Object.freeze({ upTo: 2.00, initial: 0.0430, final: 0.0678 }),
            Object.freeze({ upTo: 2.50, initial: 0.0678, final: 0.0866 }),
            Object.freeze({ upTo: 3.00, initial: 0.0866, final: 0.1022 }),
            Object.freeze({ upTo: 4.00, initial: 0.1022, final: 0.1022 }),
        ]),
        cliff: 4.0,
    }),
});

const PUBLISHED_YEARS = Object.keys(PTC_TABLES).map(Number).sort((a, b) => a - b);

/** The first and last coverage years PTC_TABLES has published figures for. */
export const FIRST_PUBLISHED_YEAR = PUBLISHED_YEARS[0];
export const LAST_PUBLISHED_YEAR = PUBLISHED_YEARS[PUBLISHED_YEARS.length - 1];

/**
 * The parameters for coverage year `year`.
 *
 * A published year is returned as it is. A later year is the last published
 * year indexed forward; an earlier one uses the first published year as it is.
 *
 * @param {number} year
 * @param {object} [index]  only read past the last published year
 * @param {number} [index.priceLevel=1]  the price level in `year` relative to
 *        the last published year, which the poverty line follows
 * @param {number} [index.percentageGrowth=1]  how much each applicable
 *        percentage moves a year: (1 + premium growth) / (1 + income growth)
 * @returns {{year: number, povertyLine: {first: number, additional: number},
 *            bands: ReadonlyArray<{upTo: number, initial: number, final: number}>,
 *            cliff: number, indexed: boolean}}
 */
export function ptcTableFor(year, { priceLevel = 1, percentageGrowth = 1 } = {}) {
    if (PTC_TABLES[year]) return { year, ...PTC_TABLES[year], indexed: false };
    if (year < FIRST_PUBLISHED_YEAR) return { year, ...PTC_TABLES[FIRST_PUBLISHED_YEAR], indexed: false };

    const last = PTC_TABLES[LAST_PUBLISHED_YEAR];
    const growth = Math.pow(percentageGrowth, year - LAST_PUBLISHED_YEAR);
    return {
        year,
        povertyLine: {
            first: last.povertyLine.first * priceLevel,
            additional: last.povertyLine.additional * priceLevel,
        },
        bands: last.bands.map((b) => ({ upTo: b.upTo, initial: b.initial * growth, final: b.final * growth })),
        cliff: last.cliff,
        indexed: true,
    };
}

/** The poverty line for a household of `householdSize` people. */
export function povertyLine(table, householdSize) {
    const size = Math.max(1, Math.floor(householdSize));
    return table.povertyLine.first + table.povertyLine.additional * (size - 1);
}

/**
 * Household income as a percentage of the poverty line, rounded to a whole
 * number: Form 8962 line 5.
 */
export function fplPercent(householdIncome, table, householdSize) {
    return Math.round(100 * householdIncome / povertyLine(table, householdSize));
}

/**
 * The applicable figure for a whole percentage of the poverty line: Form 8962
 * line 7, the value Table 2 lists, to four decimals. Below the first band it is
 * the first band's figure; above the cliff there is none, and this returns null.
 *
 * Worked in whole hundredths of a percent, so a point that falls exactly half
 * way (5.395% at 175% in 2026) rounds up every time instead of whichever way
 * floating point happens to land.
 */
export function applicableFigure(table, percent) {
    if (percent > table.cliff * 100) return null;
    const hundredths = (rate) => Math.round(rate * 10000);
    let lower = 0;
    for (let i = 0; i < table.bands.length; i++) {
        const band = table.bands[i];
        const upper = Math.round(band.upTo * 100);
        const isLast = i === table.bands.length - 1;
        if (percent < upper || (isLast && percent <= upper)) {
            const initial = hundredths(band.initial);
            const final = hundredths(band.final);
            // Below the first band's floor (under 100%, kept by the advance
            // exception) the first band's figure applies.
            const position = Math.max(0, percent - lower) / (upper - lower);
            const figure = initial + (final - initial) * position;
            return Math.floor(figure + 0.5) / 10000;
        }
        lower = upper;
    }
    return null;
}

/**
 * Why a household does or does not get the credit for a year.
 *
 *   'eligible'         100% to 400% of the poverty line
 *   'advanceException' under 100%, kept because an advance was paid on an
 *                      estimate of 100% to 400%
 *   'overCliff'        over 400%
 *   'underFloor'       under 100%, with no advance to keep it
 */
export const PtcEligibility = Object.freeze({
    ELIGIBLE: 'eligible',
    ADVANCE_EXCEPTION: 'advanceException',
    OVER_CLIFF: 'overCliff',
    UNDER_FLOOR: 'underFloor',
});

/**
 * The year's premium tax credit, month by month: Form 8962 Parts I and II.
 *
 * @param {object} args
 * @param {object} args.table            from ptcTableFor()
 * @param {number} args.householdSize
 * @param {number} args.householdIncome  the year's ACA MAGI
 * @param {Array<{benchmark: number, premium: number}>} args.months
 *        one entry per coverage month, each the household's totals, positive
 * @param {number|null} [args.advanceIncome]  the income an advance was paid on
 *        this year, or null when none was paid; decides the under-100% exception
 * @returns {{percent: number, eligibility: string, applicable: number|null,
 *            annualContribution: number, monthlyContribution: number,
 *            monthly: number[], total: number}}
 */
export function premiumTaxCredit({ table, householdSize, householdIncome, months, advanceIncome = null }) {
    const line = povertyLine(table, householdSize);
    const percent = fplPercent(householdIncome, table, householdSize);
    const none = (eligibility) => ({
        percent, eligibility, applicable: null,
        annualContribution: 0, monthlyContribution: 0,
        monthly: months.map(() => 0), total: 0,
    });

    // The two limits are tested in dollars, as the statute states them, not on
    // the rounded percentage.
    if (householdIncome > table.cliff * line) return none(PtcEligibility.OVER_CLIFF);

    let eligibility = PtcEligibility.ELIGIBLE;
    if (householdIncome < line) {
        const advanced = advanceIncome != null
            && advanceIncome >= line && advanceIncome <= table.cliff * line;
        if (!advanced) return none(PtcEligibility.UNDER_FLOOR);
        eligibility = PtcEligibility.ADVANCE_EXCEPTION;
    }

    const applicable = applicableFigure(table, Math.max(0, percent));
    const annualContribution = Math.round(Math.max(0, householdIncome) * applicable);
    const monthlyContribution = Math.round(annualContribution / 12);
    const monthly = months.map(({ benchmark, premium }) =>
        Math.min(premium, Math.max(0, benchmark - monthlyContribution)));
    const total = monthly.reduce((sum, credit) => sum + credit, 0);

    return { percent, eligibility, applicable, annualContribution, monthlyContribution, monthly, total };
}
