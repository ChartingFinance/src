/**
 * routing-report.js — what a routing test says, in words and rows.
 *
 * The Test Bench shows a routing test as a control with its cost beside it, a
 * ranked list of searches, one line on whether they agree, and a table of the
 * selected routing's changes. They are built here, with no DOM, so tests can
 * read the sentences (as spending-report.js does for the spending test).
 */

import { formatCurrency, MINUS } from './utils/html.js';

/** Where a search starts, as the list names it. In the order the depths add them. */
const STARTS = [
    ['plan', 'Your plan'],
    ['near', 'Near your plan'],
    ['random', 'A random routing'],
    ['genetic-plan', 'Genetic search from your plan'],
    ['genetic-random', 'Genetic search from random routings'],
];

/** "Your plan, Near your plan ×3": the searches that share a row. */
export function startsLabel(starts) {
    return STARTS
        .map(([start, label]) => {
            const count = starts.filter((s) => s.start === start).length;
            return count === 0 ? null : count === 1 ? label : `${label} ×${count}`;
        })
        .filter(Boolean)
        .join(', ');
}

/** What each depth adds, for the control. */
export const DEPTH_NOTES = {
    1: 'One search: a climb from your plan.',
    2: 'Adds four climbs from near your plan.',
    3: 'Adds five climbs from random routings.',
    4: 'Adds ten genetic searches of 10,000 plan runs each. The widest and by far the slowest.',
};

/** "a few seconds", "40 seconds", "3 minutes", "2 hours". Rough on purpose. */
export function duration(seconds) {
    if (seconds < 10) return 'a few seconds';
    if (seconds < 90) return `${Math.round(seconds / 10) * 10} seconds`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes} minutes`;
    const hours = Math.round(minutes / 60);
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/**
 * What a depth costs, before it is started: "10 searches, about 3 minutes on
 * this machine". Before any test has run there is no timing to go on, and it
 * gives the count of plan runs instead.
 *
 * @param {{ searches: number, runs: number, seconds: number|null }} cost
 */
export function costLine(cost) {
    const searches = `${cost.searches} ${cost.searches === 1 ? 'search' : 'searches'}`;
    if (cost.seconds == null) {
        const runs = cost.runs >= 1000 ? Math.round(cost.runs / 1000) * 1000 : Math.round(cost.runs / 100) * 100;
        return `${searches}, about ${runs.toLocaleString('en-US')} runs of your plan`;
    }
    return `${searches}, about ${duration(cost.seconds)} on this machine`;
}

/**
 * Whether the searches agree, from rankSearches().
 * One answer is never shown as the best without saying how many reached it.
 */
export function agreementLine(ranked) {
    const { searches, agreeing } = ranked;
    if (searches === 0) return '';
    if (searches === 1) return 'One search, with nothing to compare it to. A deeper test checks it against others.';
    if (agreeing <= 1) return 'No other search came within 1% of the best. A deeper search may find more.';
    if (agreeing === searches) return `All ${searches} searches came within 1% of the best.`;
    return `${agreeing} of ${searches} searches came within 1% of the best.`;
}

const percent = (v) => `${Math.round(v * 10) / 10}%`;

/**
 * The selected routing's changes, by phase.
 *
 * An income's rule reads from the income to the account it is paid into; an
 * expense's from the account that pays to the expense.
 *
 * @param {object[]} changes  a search result's `changes`
 * @returns {Array<{ phase: string, from: string, to: string, now: string, proposed: string }>}
 */
export function changeRows(changes) {
    return changes
        .slice()
        .sort((a, b) => a.phaseIdx - b.phaseIdx)
        .map((c) => ({
            phase: c.phase,
            from: c.kind === 'income' ? c.source : c.target,
            to: c.kind === 'income' ? c.target : c.source,
            now: percent(c.now),
            proposed: percent(c.proposed),
        }));
}

/** "+$279/mo (+2.9%)" against the most the plan can spend as entered; '' without it. */
export function versusEntered(monthly, enteredMonthly) {
    if (!(enteredMonthly > 0)) return '';
    const change = monthly - enteredMonthly;
    if (Math.abs(change) < 1) return 'the same';
    const sign = change > 0 ? '+' : MINUS;
    return `${sign}${formatCurrency(Math.abs(change))}/mo (${sign}${Math.abs(change / enteredMonthly * 100).toFixed(1)}%)`;
}

/**
 * The sentence over the selected routing.
 *
 * @param {object} result          a search's result
 * @param {number} enteredMonthly  the most the plan can spend as entered, or 0
 */
export function routingHeadline(result, enteredMonthly = 0) {
    if (!result.best) return 'Under this routing no spending level tested keeps the limits.';
    if (result.changes.length === 0) return 'This search found no routing that lets the plan spend more than yours does.';
    const lead = `With this routing the plan could spend ${formatCurrency(result.best.monthlySpending)} a month`;
    const change = result.best.monthlySpending - enteredMonthly;
    if (!(enteredMonthly > 0) || Math.abs(change) < 1) return `${lead}.`;
    return `${lead}, ${formatCurrency(Math.abs(change))} ${change > 0 ? 'more' : 'less'} than the most it can with yours.`;
}
