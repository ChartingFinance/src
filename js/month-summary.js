/**
 * month-summary.js — one month of a finished run, as the Month Details section
 * shows it.
 *
 * This used to live inside <finplan-timeline> as `_cursorMonthTotals()`, feeding
 * a popover that opened from the ⋯ on the cursor chip. It moved out when the
 * month got a section of its own, and it moved out HEADLESS: the numbers are
 * the part worth testing, and a Lit component cannot be run under node. The
 * section, the timeline chip and the AI summary all read from here, so they
 * cannot disagree about what a month contained.
 *
 * Two cadences live in the result, and they must not be confused:
 *
 *   the month       value, income, expense, taxes, cashFlow, growth, netChange —
 *                   what happened in the single selected month
 *
 *   trailing year   `drawn` — what left the household's accounts over the twelve
 *                   months ENDING at the selected month. See annual-expenditure.js
 *                   for why that is not twelve times the monthly Expenses figure.
 */

import { Metric } from './metric.js';
import { trailingYearExpenditure } from './annual-expenditure.js';
import { PriceIndex } from './utils/price-index.js';
import { DateInt } from './utils/date-int.js';

/** Sum a metric across every asset at one history index. */
export function metricAtIndex(portfolio, metricName, idx) {
    if (!portfolio || idx < 0) return 0;
    let total = 0;
    for (const asset of portfolio.modelAssets) {
        const history = asset.getHistory(metricName);
        if (history && idx < history.length) total += history[idx] ?? 0;
    }
    return total;
}

/** The last month the run recorded. Every metric history has the same length. */
export function lastHistoryIndex(portfolio) {
    if (!portfolio) return 0;
    for (const asset of portfolio.modelAssets) {
        const h = asset.getHistory(Metric.VALUE);
        if (h?.length > 0) return h.length - 1;
    }
    return 0;
}

/**
 * Tax withheld at source over an inclusive window — from a paycheck, a pension
 * or Social Security. Returned as a positive amount.
 *
 * It exists to explain a $0, and it is only safe to read as "paid but never
 * withdrawn" WHEN the trailing-year Tax line is $0. Withholding on an IRA or
 * 401(k) distribution books here too, and that one IS debited from an account:
 * midCareer June 2055 shows $4,641 withheld and $4,641 drawn — the same
 * dollars. When nothing was drawn for tax, whatever was withheld must have come
 * from a paycheck, a pension or Social Security, none of which pass through an
 * account. Measured: midCareer June 2030, $14,044 withheld, $0 drawn.
 *
 * Deliberately NOT the TAXES rollup: that includes property tax through
 * SALT_TAXES, and a retired homeowner with no withholding at all would then be
 * told their $0 was "withheld at source".
 */
function withheldAtSource(portfolio, from, to) {
    let total = 0;
    for (let i = Math.max(0, from); i <= to; i++) {
        total += metricAtIndex(portfolio, Metric.WITHHELD_INCOME_TAX, i)
               + metricAtIndex(portfolio, Metric.WITHHELD_FICA_TAX, i);
    }
    // Withheld tax is booked negative, like every other tax paid. `0 - total`,
    // not `-total`: negating a zero sum gives -0, which strict equality — and
    // anything that formats a sign — treats as a different number.
    return 0 - total;
}

/**
 * May a $0 trailing-year Tax line be explained as "withheld at source"?
 *
 * Only when all three hold: nothing was drawn for tax, tax WAS withheld, and
 * the plan was not short. The last clause is not decorative — earlyCareer in
 * December 2029 withholds $11,090, draws $0 for tax, and falls $7,144 short of
 * its obligations; without it, the section would call that $0 routine.
 *
 * One definition, read by the section and by its AI summary, so the two cannot
 * disagree and the test exercises the rule that ships.
 */
export function zeroTaxWasWithheld(summary) {
    if (!summary) return false;
    const d = summary.drawn;
    return d.tax < 0.5 && d.unfunded < 0.5 && summary.withheldAtSource >= 0.5;
}

/**
 * Everything the Month Details section shows for one calendar month, or null
 * when the month is outside the run.
 *
 * @param {Portfolio} portfolio  a portfolio that has been through chronometer_run
 * @param {number}    year
 * @param {number}    month      1–12
 */
export function monthSummary(portfolio, year, month) {
    if (!portfolio?.firstDateInt) return null;
    const idx = DateInt.diffMonths(portfolio.firstDateInt, DateInt.from(year, month));
    if (idx < 0 || idx > lastHistoryIndex(portfolio)) return null;

    const value = metricAtIndex(portfolio, Metric.VALUE, idx);
    const drawn = trailingYearExpenditure(portfolio, idx);

    return {
        index:     idx,
        value,
        income:    metricAtIndex(portfolio, Metric.INCOME, idx),
        expense:   metricAtIndex(portfolio, Metric.EXPENSE, idx),
        taxes:     metricAtIndex(portfolio, Metric.TAXES, idx),
        cashFlow:  metricAtIndex(portfolio, Metric.CASH_FLOW, idx),
        growth:    metricAtIndex(portfolio, Metric.GROWTH, idx),
        netChange: metricAtIndex(portfolio, Metric.NET_WORTH_CHANGE, idx),
        valueReal: PriceIndex.deflateAt(value, portfolio.monthlyPriceIndex, idx),
        drawn,
        // Over the SAME window as `drawn`, so the two can be read together.
        withheldAtSource: withheldAtSource(portfolio, idx - drawn.months + 1, idx),
    };
}
