/**
 * spending-report.js — what a spending-solver result says, in words and rows.
 *
 * The Test Bench shows a solved result as a table, one sentence naming what
 * stopped spending from rising, and up to two notes. They are built here, with
 * no DOM, so the page and any other reader of `solveSpending()` say the same
 * thing, and so tests can read the sentences.
 *
 * Every figure is in today's dollars, as the solver reports it.
 */

import { DateInt, monthLabel } from './utils/date-int.js';
import { formatCompactCurrency, formatCurrency, MINUS } from './utils/html.js';
import { outlookClause, returnShift } from './market-outlook.js';
import { inflationClause } from './inflation-condition.js';

const DASH = '—';

/** Join 1, 2, or 3+ condition clauses into readable English. */
function joinClauses(clauses) {
    if (clauses.length <= 1) return clauses[0] ?? '';
    if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}`;
    return `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`;
}

/** "the 401K holds $1.9M and the Roth IRA $1.0M", or '' when nothing is held. */
function holdings(untouched = []) {
    if (!untouched.length) return '';
    const parts = untouched.map((u, i) =>
        `the ${u.displayName}${i === 0 ? ' holds' : ''} ${formatCompactCurrency(u.amount)}`);
    const last = parts.pop();
    return parts.length ? `${parts.join(', ')} and ${last}` : last;
}

/**
 * The answer in one sentence: "The most this plan can spend is $5,316 a month,
 * $131 a month more than you entered (+3%)."
 *
 * Spending is what a plan paid. When the plan as entered runs out, what it
 * paid is less than its bills, and comparing the answer with it would call a
 * cut a raise. The answer is then given as the dial's setting, a share of
 * every expense as entered, cut to the whole percent so it never reads higher
 * than the level tested.
 *
 * Under a market outlook other than Moderate (`result.outlook`), the sentence
 * opens with it: "With stock and bond returns 1% a year higher than you
 * entered, the most this plan can spend is…". So do loss years
 * (`result.lossYearsClause`, loss-years.js) and higher inflation
 * (`result.inflationShift`, inflation-condition.js). The Test Bench passes
 * `withConditions: false`: its Found under line names the conditions, directly
 * above the sentence (test-bench-view.js).
 */
export function spendingHeadline(result, { withConditions = true } = {}) {
    const { asEntered, best } = result;
    const clauses = withConditions
        ? [outlookClause(result.outlook), result.lossYearsClause, inflationClause(result.inflationShift)].filter(Boolean)
        : [];
    const clause = clauses.length ? joinClauses(clauses) : null;
    const lead = clause ? `With ${clause}, the` : 'The';
    if (!best) return clause ? `With ${clause}, no spending level tested keeps these limits.`
        : 'No spending level tested keeps these limits.';
    if (asEntered.runsOut) {
        const share = Math.floor(best.factor * 100);
        return `${lead} expenses as entered cannot all be paid. The most this plan can spend is`
            + ` ${formatCurrency(best.monthlySpending)} a month, with every expense cut to`
            + ` ${share < 1 ? 'less than 1%' : `${share}%`} of what you entered.`;
    }
    const change = best.monthlySpending - asEntered.monthlySpending;
    const percent = asEntered.monthlySpending ? Math.round(change / asEntered.monthlySpending * 100) : 0;
    const versus = Math.abs(change) < 1
        ? 'the same as you entered'
        : `${formatCurrency(Math.abs(change))} a month ${change > 0 ? 'more' : 'less'} than you entered`
          + ` (${percent > 0 ? '+' : percent < 0 ? MINUS : ''}${Math.abs(percent)}%)`;
    return `${lead} most this plan can spend is ${formatCurrency(best.monthlySpending)} a month, ${versus}.`;
}

/**
 * One sentence naming the limit that stopped spending from rising.
 *
 * @param {object} result  solveSpending() output
 * @returns {{ text: string, year?: number, month?: number }} `year` and
 *   `month` are the month to show, when the limit is a month
 */
export function whatStopsYou(result) {
    const by = result.boundBy;

    if (by.kind === 'cap') {
        return {
            text: `Even at ${Math.round(by.factor)} times what you entered, the plan pays every bill`
                + ` and ends with more than ${formatCurrency(result.limits.floor)}. The test stops there.`,
        };
    }

    if (by.kind === 'runsOut') {
        const when = monthLabel(DateInt.from(by.year, by.month));
        const held = holdings(by.untouched);
        const tail = held
            ? `, while ${held}. The plan does not draw on retirement accounts before age 60.`
            : '.';
        const lead = by.noLevelPasses
            ? `Even at the lowest spending tested, bills go unpaid from ${when}`
            : `Spend more and bills go unpaid from ${when}`;
        return { text: lead + tail, year: by.year, month: by.month };
    }

    if (by.kind === 'success') {
        const target = Math.round(by.target * 100);
        const rate = by.rate == null ? null : Math.floor(by.rate * 100);
        if (by.noLevelPasses) {
            return {
                text: `No spending level tested lasts in ${target}% of ${by.markets} simulated markets.`
                    + (rate == null ? '' : ` The lowest lasts in ${rate}%.`),
            };
        }
        return {
            text: `Spend more and the plan lasts in fewer than ${target}% of ${by.markets} simulated markets`
                + (rate == null ? '.' : ` (${rate}% at the next level tested).`),
        };
    }

    const floor = formatCurrency(by.floor);
    return {
        text: by.noLevelPasses
            ? `No spending level tested leaves ${floor}. The lowest leaves ${formatCompactCurrency(by.endingReal)}.`
            : `Spend more and the plan would end with less than ${floor}.`,
    };
}

/**
 * The note for a curve that rises: spending less would leave less. Null when
 * the curve does not rise.
 */
export function riseNote(result) {
    const rise = result.rise;
    if (!rise) return null;
    const where = rise.account
        ? ` At the lower level ${formatCompactCurrency(rise.account.balance)} is left in ${rise.account.displayName},`
          + ' where it grows more slowly.'
        : '';
    return `Over part of this range, spending more leaves more at the end (${formatCompactCurrency(rise.gain)} more).`
        + where
        + ' A transfer rule that moves that money would change the answer.';
}

/**
 * The note for the simulated-markets limit: what it cost, or that it cost
 * nothing. Null when the limit is off. Under an outlook other than Moderate
 * the plan's own path is named with it, unless `withConditions` is false, as
 * for spendingHeadline().
 */
export function successNote(result, { withConditions = true } = {}) {
    const s = result.success;
    if (!s) return null;
    const target = Math.round(s.target * 100);
    if (result.fixedBest && result.best) {
        const cost = result.fixedBest.monthlySpending - result.best.monthlySpending;
        const shift = withConditions ? returnShift(result.outlook) : 0;
        const path = shift ? `the plan's own path of returns, 1% a year ${shift > 0 ? 'higher' : 'lower'} than you entered,`
            : "the plan's own path of returns";
        return `On ${path} it could spend ${formatCurrency(result.fixedBest.monthlySpending)} a month.`
            + ` Lasting in ${target}% of simulated markets costs ${formatCurrency(cost)} a month of that.`;
    }
    if (result.best && s.bestRate != null) {
        return `The ${target}% limit did not bind: at this spending the plan lasts in ${Math.floor(s.bestRate * 100)}% of`
            + ` ${s.markets} simulated markets. A market counts as lasting while the plan's net worth stays above $0,`
            + ' retirement accounts included.';
    }
    return null;
}

/** The note for a health plan with nothing after it. Null when it does not apply. */
export function healthNote(result) {
    if (!result.healthNote) return null;
    return 'The health plan ends at 65 and this plan has no health expense after it,'
        + ' so spending steps down at 65. Medicare premiums are not charged unless you add them as an expense.';
}

/**
 * The rows of the result table.
 *
 * A column whose plan runs out has its spending marked "paid": the bills it
 * could pay, which is less than was entered, so that a reader does not take
 * the As entered column's spending for the amount entered.
 *
 * @param {object} result    solveSpending() output
 * @param {object} [routed]  a third column: the most the plan can spend under
 *                           a routing from the routing test, when one is selected
 * @returns {Array<{ label: string, entered: string, best: string, routed?: string }>}
 */
export function resultRows(result, routed = null) {
    const a = result.asEntered;
    const b = result.best;
    const cell = (column, read) => (column ? read(column) : DASH);
    const row = (label, read) => ({
        label, entered: cell(a, read), best: cell(b, read),
        ...(routed ? { routed: cell(routed, read) } : {}),
    });
    const paid = (c, text) => (c.runsOut ? `${text} paid` : text);
    const monthly = (c, v) => paid(c, `${formatCurrency(v)}/mo`);
    const runsOut = (c) => (c.runsOut ? monthLabel(DateInt.from(c.runsOut.year, c.runsOut.month)) : 'never');

    const rows = [];
    if (a.monthlySpendingBefore65 != null) {
        rows.push(row('Monthly spending before 65', (c) => monthly(c, c.monthlySpendingBefore65)));
        rows.push(row('Monthly spending from 65', (c) => monthly(c, c.monthlySpendingFrom65)));
        rows.push(row('Premium tax credit, whole plan', (c) => formatCurrency(c.premiumTaxCredit)));
    } else {
        rows.push(row('Monthly spending', (c) => monthly(c, c.monthlySpending)));
    }
    rows.push(row('Lifetime spending', (c) => paid(c, formatCompactCurrency(c.lifetimeSpending))));
    rows.push(row('Left at the end', (c) => formatCompactCurrency(c.endingReal)));
    rows.push(row('Runs out', runsOut));
    return rows;
}
