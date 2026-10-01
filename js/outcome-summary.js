/**
 * outcome-summary.js — the three answers to "will my money last?".
 *
 * The plan as entered, the plan across simulated markets, and the plan with
 * spending guardrails. They should differ (the simulations randomise returns,
 * the guardrails change spending), and the Outcome strip shows them side by
 * side, each labelled with what it assumes.
 *
 * Headless, so it can be tested under node. The Outcome strip and the stat
 * cards under each simulation read the same functions, so the two cannot
 * disagree about a number.
 */

import { Metric } from './metric.js';
import { metricAtIndex, lastHistoryIndex } from './month-summary.js';
import { planExhaustion, monthLabel } from './portfolio-issues.js';
import { PriceIndex } from './utils/price-index.js';
import { formatCompactCurrency } from './utils/html.js';

/** 'good' from 90%, 'warn' from 70%, 'bad' below. */
export function successTone(percent) {
    return percent >= 90 ? 'good' : percent >= 70 ? 'warn' : 'bad';
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The plan as entered: net worth in its last month, in nominal and today's
 * dollars, and whether it ever failed to pay a bill (the exhaustion finding,
 * so it says the same thing as "What needs attention").
 *
 * @returns {null|{ end, endReal, exhaustion: DateInt|null, value, detail, tone }}
 */
export function planOutcome(portfolio, issues = []) {
    if (!portfolio?.firstDateInt) return null;
    const last = lastHistoryIndex(portfolio);
    const end = metricAtIndex(portfolio, Metric.VALUE, last);
    const index = portfolio.monthlyPriceIndex;
    const endReal = index?.length ? PriceIndex.deflateAt(end, index, last) : null;
    const exhaustion = planExhaustion(issues)?.firstDateInt ?? null;
    return {
        end, endReal, exhaustion,
        value: formatCompactCurrency(end),
        detail: [
            endReal != null ? `${formatCompactCurrency(endReal)} in today's $` : null,
            exhaustion ? `runs out ${monthLabel(exhaustion)}` : 'never runs out',
        ].filter(Boolean).join(' · '),
        tone: exhaustion ? 'bad' : 'good',
    };
}

/**
 * Monte Carlo: the share of runs that never hit $0 from retirement on, and
 * the median ending.
 *
 * @param {object|null} results  getMonteCarloResults()
 */
export function simulationOutcome(results) {
    if (!results?.labels?.length) return null;
    const last = results.labels.length - 1;
    const percent = Math.round(results.successRate * 100);
    const [p10, , median, , p90] = results.bandData.map((band) => band[last]);
    return {
        percent, median, p10, p90,
        horizon: results.labels[last],
        runs: results.numSimulations,
        value: `${percent}%`,
        detail: `succeed · median ${formatCompactCurrency(median)}`,
        tone: successTone(percent),
    };
}

/**
 * Guardrails: the ending with spending cut or raised as the portfolio falls
 * behind or runs ahead.
 *
 * @param {object|null} results  getGuardrailsResults()
 */
export function guardrailsOutcome(results) {
    if (!results?.portfolioValues?.length) return null;
    const last = results.portfolioValues.length - 1;
    const end = results.portfolioValues[last];
    const cuts = results.events.filter((e) => e.type === 'preservation').length;
    const raises = results.events.length - cuts;
    return {
        end, cuts, raises,
        finalWithdrawal: results.withdrawalSteps?.[last] ?? null,
        horizon: results.labels?.[last] ?? null,
        value: formatCompactCurrency(end),
        detail: `${plural(cuts, 'spending cut', 'spending cuts')} · ${plural(raises, 'raise', 'raises')}`,
        tone: end > 0 ? undefined : 'bad',
    };
}
