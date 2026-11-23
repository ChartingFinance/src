/**
 * test-bench-view.js — what the Test Bench's layout says about its levers.
 *
 * The Test Bench has three kinds of lever (spec 18, §2):
 *
 *   CONDITIONS   about the world: the market outlook and loss years. They
 *                apply to both tests and the chart.
 *   LIMITS       what the spending test requires: leaves at least a floor,
 *                and lasts in a share of simulated markets. The floor also
 *                ranks routings.
 *   EFFORT       how hard the routing test looks (Depth). It changes only
 *                how long the next search takes, so nothing here reads it.
 *
 * A result records the levers it was found under. These functions compare
 * that record with the levers on screen, and name it in one line:
 *
 *   Found under · Optimistic (+1%) · Calibrated 1970–2025
 *
 * Nothing re-runs when a lever changes. A result found under other levers is
 * dimmed, with one line saying what changed, until it is run again.
 *
 * Headless: no DOM, no globals, nothing it is given is changed.
 */

import { MarketOutlook, outlookLabel, outlookClause, outlookPlan, returnShift } from './market-outlook.js';
import { NO_LOSS_YEARS, lossYearsOf, lossYearsChip, lossYearsClause, lossYearsSchedule } from './loss-years.js';
import { formatCurrency } from './utils/html.js';

/** Every condition at its neutral setting: the plan as entered. */
export const NEUTRAL_CONDITIONS = Object.freeze({ outlook: MarketOutlook.MODERATE, lossYears: NO_LOSS_YEARS });

/**
 * The conditions as one record, loss years with only the figures in use.
 * Absent means neutral.
 */
export function conditionsOf({ outlook = MarketOutlook.MODERATE, lossYears = NO_LOSS_YEARS } = {}) {
    returnShift(outlook);   // throws on a name that is not an outlook
    return { outlook, lossYears: lossYearsOf(lossYears) };
}

/**
 * A plan under conditions: the outlook's copy (market-outlook.js), with the
 * loss years as the engine's `returnSchedule` for this plan's dates. Every
 * job of a test, and the chart, runs this one.
 *
 * @param {object} plan  as the Test Bench's planSource gives it
 * @param {object} conditions
 * @param {object} dates  { retirement, first, last }, each { year, month }
 */
export function conditionedPlan(plan, conditions, dates) {
    const { outlook, lossYears } = conditionsOf(conditions);
    return { ...outlookPlan(plan, outlook), returnSchedule: lossYearsSchedule(lossYears, dates) };
}

/**
 * What a save note and a report say the result assumed: "with stock and bond
 * returns 1% a year higher than you entered and stock prices falling 30% in
 * 2031". Null when every condition is neutral, or none applies.
 */
export function conditionsClause(conditions, dates) {
    const { outlook, lossYears } = conditionsOf(conditions);
    const clauses = [outlookClause(outlook), lossYearsClause(lossYears, dates)].filter(Boolean);
    return clauses.length ? `with ${clauses.join(' and ')}` : null;
}

/** Whether every condition is at its neutral setting. */
export function isNeutral(conditions) {
    return sameConditions(conditions, NEUTRAL_CONDITIONS);
}

/** Whether two sets of conditions are the same. */
export function sameConditions(a, b) {
    const x = conditionsOf(a), y = conditionsOf(b);
    return x.outlook === y.outlook && JSON.stringify(x.lossYears) === JSON.stringify(y.lossYears);
}

/** Whether two sets of the spending test's limits are the same. */
export function sameLimits(a, b) {
    return a.floor === b.floor && !!a.successOn === !!b.successOn
        && (!a.successOn || a.successPercent === b.successPercent);
}

/** One chip per condition not at its neutral setting, in the card's order. */
export function conditionChips(conditions) {
    const { outlook, lossYears } = conditionsOf(conditions);
    return [outlook === MarketOutlook.MODERATE ? null : outlookLabel(outlook), lossYearsChip(lossYears)]
        .filter(Boolean);
}

/** "Calibrated 1970–2025": the data the simulated markets drew from. */
export function dataChip({ dataMode, firstYear, lastYear }) {
    const mode = dataMode === 'calibrated' ? 'Calibrated' : 'Historical';
    return `${mode} ${firstYear}–${lastYear}`;
}

/** "Leaves at least $500,000", or null for a floor of $0. */
export function floorChip(floor) {
    return floor > 0 ? `Leaves at least ${formatCurrency(floor)}` : null;
}

/**
 * The chips of a result's Found under line. "your plan as entered" stands in
 * when no condition is set, so the line always names something.
 *
 * @param {object} under
 * @param {object} under.conditions  the conditions the result was found under
 * @param {object} [under.data]      the markets' data, when a markets figure is on screen
 * @param {number} [under.floor]     a floor to name, for a result whose floor lives elsewhere
 */
export function foundUnderChips({ conditions, data = null, floor = 0 }) {
    const chips = conditionChips(conditions);
    if (!chips.length) chips.push('your plan as entered');
    const f = floorChip(floor);
    if (f) chips.push(f);
    if (data) chips.push(dataChip(data));
    return chips;
}

/** The line as text: "Found under · Optimistic (+1%) · Calibrated 1970–2025". */
export function foundUnderText(under) {
    return ['Found under', ...foundUnderChips(under)].join(' · ');
}

/**
 * What changed between the levers a spending result was found under and the
 * levers on screen.
 *
 * @param {{ conditions, limits }} under  as the result was found
 * @param {{ conditions, limits }} now    as the page shows them
 * @returns {{ conditions: boolean, limits: boolean }}
 */
export function spendingChanges(under, now) {
    return {
        conditions: !sameConditions(under.conditions, now.conditions),
        limits: !sameLimits(under.limits, now.limits),
    };
}

/**
 * What changed for a routing list: its conditions, or the floor that ranked
 * it. The markets limit does not rank routings, so it is not compared.
 */
export function routingChanges(under, now) {
    return {
        conditions: !sameConditions(under.conditions, now.conditions),
        limits: under.floor !== now.floor,
    };
}

/**
 * The one line over a result found under other levers, or null when it was
 * found under the ones on screen. `again` is the button's word: "Run" or
 * "Search".
 */
export function changedLine(changes, again = 'Run') {
    const what = changes.conditions && changes.limits ? 'Conditions and limits'
        : changes.conditions ? 'Conditions'
        : changes.limits ? 'Limits'
        : null;
    return what ? `${what} changed. ${again} again.` : null;
}

/** The chart column each tab opens on (spec 18, §3.4). */
export function tabColumn(tab) {
    return tab === 'routing' ? 'routed' : 'best';
}
