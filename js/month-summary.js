/**
 * month-summary.js — a month and its calendar year of a finished run, as the
 * Month & Year Details section shows them.
 *
 * Headless, so it can be tested under node. The section, the timeline chip and
 * the AI summary all read from here, so they cannot disagree about a month.
 *
 * One definition for both rows. A year's income, expenses, taxes, growth and
 * withdrawals are its months added up, so a figure means the same thing over
 * one month and over twelve. Two things are not sums:
 *
 *   net worth       a balance: the year shows where it ended and the change
 *
 *   the tax year    what the year's income owed, AGI and MAGI, read from the
 *                   year's TaxYear record. The year's Taxes figure is what was
 *                   PAID in it, which includes the previous year's settlement.
 *
 * Cash flow is income received less expenses and taxes, so the four headline
 * figures always reconcile. Income received is money from outside the
 * household's accounts; a withdrawal from its own IRA or brokerage is not
 * income here, it shows under `drawn`. Expenses include mortgage principal.
 * That is the rule Metric.CASH_FLOW applies to each account and
 * FinancialPackage.cashFlow() applies to the household (Reports), so all three
 * agree.
 *
 * `drawn` is what left the household's accounts to meet obligations over the
 * same window, itemised; see annual-expenditure.js for why that is not the
 * Expenses figure.
 */

import { Metric, MetricLabel, LEAF_TAX_METRICS, LEAF_EXPENSE_METRICS } from './metric.js';
import { RECEIVED_INCOME_METRICS } from './instruments/instrument-behavior.js';
import { expenditureOverWindow, Expenditure } from './annual-expenditure.js';
import { MagiPurpose } from './tax-basis.js';
import { PriceIndex } from './utils/price-index.js';
import { DateInt, MONTH_NAMES } from './utils/date-int.js';

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
 * It explains a $0 Tax line, and only then: withholding on an IRA or 401(k)
 * distribution books here too, and that one is debited from an account. When
 * nothing was drawn for tax, what was withheld came from a paycheck, pension or
 * Social Security, none of which pass through an account.
 *
 * Not the TAXES rollup, which includes property tax: a retired homeowner would
 * be told their $0 was "withheld at source".
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
 * May a $0 withdrawn-for-tax line be explained as "withheld at source"?
 *
 * Only when nothing was drawn for tax, tax was withheld, and the plan was not
 * short of money (a short plan also draws $0 for tax). Read by both the section
 * and its AI summary.
 */
export function zeroTaxWasWithheld(summary) {
    if (!summary) return false;
    const d = summary.drawn;
    return d.tax < 0.5 && d.unfunded < 0.5 && summary.withheldAtSource >= 0.5;
}

/**
 * The flows both rows show, over an inclusive window of month indexes. The one
 * definition the month and the year share.
 */
function flowsOver(portfolio, from, to) {
    const sum = (metric) => {
        let total = 0;
        for (let i = from; i <= to; i++) total += metricAtIndex(portfolio, metric, i);
        return total;
    };
    const income = RECEIVED_INCOME_METRICS.reduce((total, metric) => total + sum(metric), 0);
    const expense = sum(Metric.EXPENSE) + sum(Metric.MORTGAGE_PRINCIPAL);
    const taxes = sum(Metric.TAXES);
    return {
        income,
        // Every income, withdrawals from the household's own accounts included:
        // what tax is levied on, so the effective rate's base.
        totalIncome: sum(Metric.INCOME),
        expense,
        taxes,
        // Expenses and taxes are stored negative, so this is income less both.
        cashFlow:  income + expense + taxes,
        growth:    sum(Metric.GROWTH),
        netChange: sum(Metric.NET_WORTH_CHANGE),
        drawn:     expenditureOverWindow(portfolio, from, to),
        // Over the SAME window as `drawn`, so the two can be read together.
        withheldAtSource: withheldAtSource(portfolio, from, to),
        // What Expenses and Taxes are made of, for their lists.
        expenseItems: byAccount(portfolio, EXPENSE_PIECES, from, to),
        taxItems:     byAccount(portfolio, LEAF_TAX_METRICS, from, to),
        settlement:   settlementIn(portfolio, from, to),
    };
}

/** What the Expenses figure is made of: the expense leaves, and mortgage principal. */
const EXPENSE_PIECES = Object.freeze([...LEAF_EXPENSE_METRICS, Metric.MORTGAGE_PRINCIPAL]);

/** Each account's amount of each metric over a window, where it is not zero. */
function byAccount(portfolio, metrics, from, to) {
    const out = [];
    for (const asset of portfolio.modelAssets) {
        for (const metric of metrics) {
            const history = asset.getHistory(metric);
            if (!history) continue;
            let amount = 0;
            for (let i = Math.max(0, from); i <= to && i < history.length; i++) amount += history[i] ?? 0;
            if (amount !== 0) out.push({ account: asset.displayName, metric, amount });
        }
    }
    return out;
}

/**
 * The previous year's settlement paid inside a window. The annual pass books it
 * in January, so a window holds one only if it holds a January.
 *
 * @returns {{year: number, parts: Array<{label: string, amount: number}>} | null}
 */
function settlementIn(portfolio, from, to) {
    const first = portfolio.firstDateInt;
    for (let i = Math.max(0, from); i <= to; i++) {
        const d = DateInt.from(first.year, first.month);
        d.addMonths(i);
        if (d.month !== 1) continue;
        const t = portfolio.taxYears?.find((r) => r.year === d.year - 1);
        return t ? { year: t.year, parts: settlementParts(t) } : null;
    }
    return null;
}

/**
 * One calendar month, or null when it is outside the run.
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
    return {
        index:     idx,
        value,
        valueReal: PriceIndex.deflateAt(value, portfolio.monthlyPriceIndex, idx),
        ...flowsOver(portfolio, idx, idx),
    };
}

/**
 * One calendar year: its months inside the run added up, the balance at its
 * last month, and its TaxYear record. Null when no month of it is in the run.
 *
 * A plan's first and last years can be short; `firstMonth`, `lastMonth` and
 * `months` say so. A year that ends before December was never settled, so it
 * has no TaxYear and no effective rates.
 *
 * @param {Portfolio} portfolio
 * @param {number}    year
 */
export function yearSummary(portfolio, year) {
    if (!portfolio?.firstDateInt) return null;
    const first = portfolio.firstDateInt;
    const from = Math.max(0, DateInt.diffMonths(first, DateInt.from(year, 1)));
    const to = Math.min(lastHistoryIndex(portfolio), DateInt.diffMonths(first, DateInt.from(year, 12)));
    if (to < from) return null;

    const flows = flowsOver(portfolio, from, to);
    const value = metricAtIndex(portfolio, Metric.VALUE, to);
    const taxYear = portfolio.taxYears?.find((t) => t.year === year) ?? null;
    const rateOn = (base) => (taxYear && base > 0 ? taxYear.federalTax / base : null);
    const monthAt = (i) => { const d = DateInt.from(first.year, first.month); d.addMonths(i); return d.month; };

    return {
        year,
        firstMonth: monthAt(from),
        lastMonth:  monthAt(to),
        months:     to - from + 1,
        value,
        // NET_WORTH_CHANGE is each month's change, so the year's sum is the
        // year's change and this is where the year began.
        valueStart: value - flows.netChange,
        valueReal:  PriceIndex.deflateAt(value, portfolio.monthlyPriceIndex, to),
        ...flows,
        taxYear,
        effectiveRateOnIncome: rateOn(flows.totalIncome),
        effectiveRateOnAGI:    rateOn(taxYear?.agi),
    };
}

// ── Whole dollars that add up ────────────────────────────────────────

/**
 * An amount rounded to whole dollars exactly as formatCurrency rounds it for
 * display: half away from zero.
 */
export function wholeDollars(amount) {
    const dollars = Math.round(Math.abs(amount));
    // Never -0: it would compare unequal to the 0 it displays as.
    return dollars === 0 ? 0 : Math.sign(amount) * dollars;
}

/**
 * The four headline figures as shown, in whole dollars. Cash flow is the sum
 * of the other three AS SHOWN, so the row adds up on screen. Rounded on its
 * own it could miss by a dollar: $6,500 − $5,022.60 − $1,434.60 is $42.80,
 * which shows as $43 beside figures that add to $42.
 */
export function headlineAsShown(summary) {
    const income = wholeDollars(summary.income);
    // Expenses and Taxes are the totals of their lists, so a list opened from
    // the row ends on the figure it was opened from.
    const expense = expensesAsShown(summary).total;
    const taxes = taxesAsShown(summary).total;
    return { income, expense, taxes, cashFlow: income + expense + taxes };
}

const EXPENSE_LINE = Object.freeze({
    // An expense account is the expense, so its line needs no name of its own.
    [Metric.LIVING_EXPENSE]:     null,
    [Metric.MORTGAGE_INTEREST]:  'Interest',
    [Metric.MORTGAGE_PRINCIPAL]: 'Principal',
    [Metric.MAINTENANCE]:        'Maintenance',
    [Metric.INSURANCE]:          'Insurance',
});

/**
 * The Expenses figure as a list: a group per account ("Mortgage"), its pieces
 * the lines ("Interest", "Principal"). Signed, like the row: negative is paid.
 */
export function expensesAsShown(summary) {
    return groupsAsShown(summary.expenseItems, (it) => ({
        heading: it.account,
        label: it.metric in EXPENSE_LINE ? EXPENSE_LINE[it.metric] : MetricLabel[it.metric],
    }));
}

/** Where each tax goes in the list: [group, line]. Line 'account' names the property. */
const TAX_LINE = Object.freeze({
    [Metric.WITHHELD_INCOME_TAX]:         ['Income tax', 'Withheld'],
    [Metric.ESTIMATED_INCOME_TAX]:        ['Income tax', 'Estimated and true-up'],
    [Metric.SHORT_TERM_CAPITAL_GAIN_TAX]: ['Income tax', 'Short-term gains'],
    [Metric.LONG_TERM_CAPITAL_GAIN_TAX]:  ['Long-term capital gains tax', null],
    [Metric.NIIT]:                        ['Net investment income tax', null],
    [Metric.SOCIAL_SECURITY_TAX]:         ['FICA', 'Social Security'],
    [Metric.MEDICARE_TAX]:                ['FICA', 'Medicare'],
    [Metric.PROPERTY_TAX]:                ['Property tax', 'account'],
});

/**
 * The Taxes figure as a list, grouped by kind across accounts, except property
 * tax, which is by property. Signed, like the row: a refund is positive.
 *
 * Taxes are what was paid in the window, so a January holds the previous
 * year's true-up and NIIT; `settlement` names them for a note.
 */
export function taxesAsShown(summary) {
    const view = groupsAsShown(summary.taxItems, (it) => {
        const [heading, line] = TAX_LINE[it.metric] ?? ['Other tax', MetricLabel[it.metric]];
        return { heading, label: line === 'account' ? it.account : line };
    });
    return { ...view, settlement: summary.settlement };
}

/**
 * Items into groups in whole dollars that add up: each line rounded, each group
 * the sum of its lines, the total the sum of the groups. Items that share a
 * group and line are added before rounding, so withholding from three accounts
 * is one line. Largest first; a line that rounds to $0 adds nothing and is left
 * out.
 *
 * @returns {{groups: Array<{heading, total, items: Array<{label, amount}>}>, total: number}}
 */
function groupsAsShown(items, place) {
    const groups = new Map();
    for (const it of items) {
        const { heading, label } = place(it);
        const lines = groups.get(heading) ?? new Map();
        lines.set(label, (lines.get(label) ?? 0) + it.amount);
        groups.set(heading, lines);
    }
    const bySize = (a, b) => Math.abs(b) - Math.abs(a);
    const shown = [...groups].map(([heading, lines]) => {
        const items = [...lines]
            .map(([label, amount]) => ({ label, amount: wholeDollars(amount) }))
            .filter((it) => it.amount !== 0)
            .sort((a, b) => bySize(a.amount, b.amount));
        return { heading, items, total: items.reduce((t, it) => t + it.amount, 0) };
    })
        .filter((g) => g.items.length)
        .sort((a, b) => bySize(a.total, b.total));
    return { groups: shown, total: shown.reduce((t, g) => t + g.total, 0) };
}

/**
 * A withdrawals list as shown, in whole dollars, by the same rule: each
 * obligation rounded, each group the sum of its lines, the total the sum of
 * the groups.
 *
 * @returns {{spending: {items, total}, tax: {items, total}, total: number, unfunded: number}}
 */
export function drawnAsShown(drawn) {
    const group = (bucket) => {
        const items = drawn.items
            .filter((it) => it.bucket === bucket)
            .map((it) => ({ label: it.label, amount: wholeDollars(it.amount) }));
        return { items, total: items.reduce((t, it) => t + it.amount, 0) };
    };
    const spending = group(Expenditure.SPENDING);
    const tax = group(Expenditure.TAX);
    return { spending, tax, total: spending.total + tax.total, unfunded: wholeDollars(drawn.unfunded) };
}

// ── Wording the section and its AI summary share ─────────────────────

/** The months a year covers: "Jan–Dec", or "Oct–Dec" for a short year. */
export function yearSpan(summary) {
    const first = MONTH_NAMES[summary.firstMonth - 1];
    return summary.months === 1 ? first : `${first}–${MONTH_NAMES[summary.lastMonth - 1]}`;
}

const MAGI_NAME = Object.freeze({
    [MagiPurpose.NIIT]:              'NIIT',
    [MagiPurpose.IRMAA]:             'IRMAA',
    [MagiPurpose.SENIOR_DEDUCTION]:  'senior deduction',
    [MagiPurpose.IRA_DEDUCTION]:     'IRA deduction',
    [MagiPurpose.ROTH_CONTRIBUTION]: 'Roth contribution',
    [MagiPurpose.ACA]:               'ACA',
});

/**
 * A year's MAGI, one line per distinct figure: the rules that measure the same
 * amount share a line. NIIT's line comes first; it is AGI in this model.
 *
 * @returns {Array<{amount: number, purposes: string[]}>}
 */
export function magiLines(taxYear) {
    const lines = [];
    for (const purpose of Object.values(MagiPurpose)) {
        const amount = taxYear.magi[purpose];
        const line = lines.find((l) => Math.abs(l.amount - amount) < 0.5);
        if (line) line.purposes.push(MAGI_NAME[purpose]);
        else lines.push({ amount, purposes: [MAGI_NAME[purpose]] });
    }
    return lines;
}

/**
 * What the January after a year settled, as positive amounts: a refund or a
 * bill from the true-up, and NIIT. Empty when nothing was settled.
 *
 * @returns {Array<{label: string, amount: number}>}
 */
export function settlementParts(taxYear) {
    const parts = [];
    if (taxYear.settledTrueUp > 0.5) parts.push({ label: 'refund', amount: taxYear.settledTrueUp });
    if (taxYear.settledTrueUp < -0.5) parts.push({ label: 'bill', amount: -taxYear.settledTrueUp });
    if (taxYear.settledNIIT < -0.5) parts.push({ label: 'NIIT', amount: -taxYear.settledNIIT });
    return parts;
}
