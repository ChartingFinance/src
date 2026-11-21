/**
 * max-spending.js — the Test Bench's Spending test, for a plan spec.
 *
 * "How much can this plan spend?" asked of the same solver the app's Test
 * Bench runs (spending-solver.js, success-limit.js), so the answer here is the
 * app's answer for the same plan and the same limits.
 *
 * ── What it returns ──────────────────────────────────────────────────
 *
 * The solver's result, and the plan at the answer as a spec of its own: the
 * same plan with every monthly expense at the solved level, cut to the cent
 * toward spending less (`solvedAssets`, as the app saves it). The server gives
 * that spec a handle, so the answer can be opened, run or compared like any
 * other plan. Nothing here changes the spec it is given.
 *
 * ── The simulated-markets limit ──────────────────────────────────────
 *
 * Off unless a share of markets is asked for. In the app it is on, at 90%; it
 * costs up to ten runs of 300 simulated markets, a minute or two, which is
 * long for a tool call. When it is off the report says so, and says what the
 * answer does not account for. When it is on, the markets are the app's: 300
 * of them, seed 1, varying from retirement, in the plan's data mode.
 *
 * ── The market outlook ───────────────────────────────────────────────
 *
 * As on the Test Bench (market-outlook.js): Pessimistic or Optimistic solves
 * a copy of the plan with every stock and bond return 1% a year lower or
 * higher, and the markets add the same shift to historical draws. The plan at
 * the answer is built from the spec as given, with the user's own rates, and
 * the report says so.
 */

import { Portfolio } from '../portfolio.js';
import { ModelAsset } from '../model-asset.js';
import { solveSpending, solvedAssets } from '../spending-solver.js';
import { limitBySuccess, simulatedRate } from '../success-limit.js';
import { whatStopsYou, riseNote, healthNote, successNote, resultRows, spendingHeadline } from '../spending-report.js';
import { ageToDateIntFor } from '../plan-dates.js';
import { formatCurrency } from '../utils/html.js';
import { simConfigFromPlanSpec } from './run-plan.js';
import { planWithIds } from '../plan-ids.js';
import { MarketOutlook, outlookAssets, outlookLabel, outlookClause, outlookNote, returnShift } from '../market-outlook.js';

/** The app's simulated markets (test-bench-run.js): how many, and which. */
export const MARKETS = 300;
export const MARKETS_SEED = 1;

/**
 * Solve "spend the most that keeps these limits" for a plan spec.
 *
 * @param {object} spec  a plan spec, as runPlan takes
 * @param {object} [limits]
 * @param {number} [limits.leaveAtLeast=0]  least to leave at the end, today's dollars
 * @param {number|null} [limits.simulatedMarketsPercent]  50 to 99; null leaves the limit off
 * @param {string} [limits.marketOutlook='moderate']  'pessimistic', 'moderate' or 'optimistic'
 * @param {number} [limits.markets]  simulated markets to run; the app's 300 unless a test asks for fewer
 * @returns {Promise<{ result: object, solvedSpec: object|null, plan: object }>}
 *   `result` is solveSpending()'s, or limitBySuccess()'s with the limit on;
 *   `solvedSpec` is the plan at the answer, or null when no level keeps the limits
 */
export async function maxSpending(spec, { leaveAtLeast = 0, simulatedMarketsPercent = null,
                                          marketOutlook = MarketOutlook.MODERATE, markets = MARKETS } = {}) {
    if (!spec?.modelAssets?.length) {
        throw new Error('Plan spec has no modelAssets — nothing to solve.');
    }
    const shift = returnShift(marketOutlook);   // throws on a name that is not an outlook
    // Every run below is built from this plan, and the solved spec is copied
    // from it, so all of them carry the same ids.
    spec = planWithIds(spec);
    // Solved under the outlook. The spec itself keeps the user's rates, and the
    // plan at the answer is built from it.
    const plan = {
        modelAssets: outlookAssets(spec.modelAssets, marketOutlook),
        lifeEvents: spec.lifeEvents ?? [],
        config: simConfigFromPlanSpec(spec),
    };

    let result = solveSpending(plan, { floor: leaveAtLeast });

    if (simulatedMarketsPercent != null) {
        // The retirement date comes from the plan's birth year, which only a
        // Portfolio attaches to a config (as runMonteCarloFor does).
        const bound = new Portfolio(plan.modelAssets.map((a) => ModelAsset.fromJSON(a)), false,
            simConfigFromPlanSpec(spec)).config;
        const sim = {
            markets,
            seed: MARKETS_SEED,
            dataMode: plan.config.simDataMode,
            backtestFromYear: null,
            retirementDateInt: ageToDateIntFor(bound, bound.retirementAge).toInt(),
            returnShift: shift,
        };
        result = await limitBySuccess(plan, result, {
            target: simulatedMarketsPercent / 100,
            markets: sim.markets,
            rateAt: (factor) => simulatedRate(plan, factor, sim),
        });
    }

    result = { ...result, outlook: marketOutlook };

    const solvedSpec = result.best ? {
        ...spec,
        name: `${spec.name ?? 'Plan'}: spend the most`,
        modelAssets: solvedAssets(spec.modelAssets, result.best.factor),
    } : null;

    return { result, solvedSpec, plan };
}

/** Format to one decimal place, truncated rather than rounded so 89.97% never displays as the 90% threshold it missed. */
const percent = (rate) => `${(Math.floor(rate * 1000) / 10).toFixed(1)}%`;

/**
 * The answer as Markdown.
 *
 * @param {{ result: object, plan: object }} solved  maxSpending()'s return
 * @param {object} [options]
 * @param {string|null} [options.handle]  the run handle of the plan at the answer
 */
export function maxSpendingMarkdown({ result, plan }, { handle = null } = {}) {
    const c = plan.config;
    const limits = [
        'never runs out',
        `leaves at least ${formatCurrency(result.limits.floor)} at the end`,
        result.success
            ? `lasts in ${Math.round(result.success.target * 100)}% of ${result.success.markets} simulated markets`
            : null,
    ].filter(Boolean).join(' · ');

    const lines = [
        '# How much can this plan spend?',
        '',
        `**Plan:** ${c.filingAs} · ages ${c.startAge} → retires ${c.retirementAge} → ends ${c.finishAge} · `
            + `inflation ${(c.inflationRate * 100).toFixed(1)}%`,
        `**Limits:** ${limits}`,
        ...(outlookNote(result.outlook) ? [`**Market outlook:** ${outlookLabel(result.outlook)}. ${outlookNote(result.outlook)}`] : []),
        '',
        `**${spendingHeadline(result)}**`,
        '',
        '| | As entered | Spend the most |',
        '| :--- | ---: | ---: |',
        ...resultRows(result).map((row) => `| ${row.label} | ${row.entered} | ${row.best} |`),
        '',
        `**What stops it:** ${whatStopsYou(result).text}`,
    ];

    // Append simulated success rates for the baseline and solved spending levels when measured.
    if (result.success) {
        const rateAt = (factor) => result.success.rates.find(([f]) => f === factor)?.[1];
        const entered = rateAt(1);
        const best = result.best ? rateAt(result.best.factor) : undefined;
        const said = [
            entered != null ? `as entered the plan lasts in ${percent(entered)}` : null,
            best != null ? `at the answer in ${percent(best)}` : null,
        ].filter(Boolean);
        if (said.length) lines.push('', `Across ${result.success.markets} simulated markets, ${said.join(', ')}.`);
    }

    for (const note of [successNote(result), riseNote(result), healthNote(result)].filter(Boolean)) {
        lines.push('', note);
    }

    if (result.best) {
        const before = new Map(result.asEntered.expenses.map((e) => [e.displayName, e.monthly]));
        lines.push('', '## The expenses at that level', '',
            '| Expense | As entered | At the most |', '| :--- | ---: | ---: |',
            ...result.best.expenses.map((e) =>
                `| ${e.displayName} | ${formatCurrency(before.get(e.displayName) ?? 0)}/mo | ${formatCurrency(e.monthly)}/mo |`),
            '', 'Each is its starting monthly amount. Every monthly expense is turned by the same factor, a '
            + 'marketplace health plan included; nothing else in the plan is changed.');
    }

    if (handle) {
        lines.push('', `**The plan at this spending:** \`${handle}\`. Pass it to \`share_link\` to open it in the app, `
            + 'to `run_plan` (as `shareUrl`) for its full report, or to `diff_plans` against the plan it came from. '
            + 'The plan it came from is unchanged.'
            + (outlookClause(result.outlook)
                ? ` That plan has your own return rates, not the outlook's: this answer assumed ${outlookClause(result.outlook)},`
                  + ' so run as it stands it will not give this answer.'
                : ''));
    }

    lines.push('', '---', '',
        'Figures are in today\'s dollars. Spending is what the plan pays out to live on, averaged over the whole '
        + 'plan; taxes are not in it.');
    if (!result.success) {
        lines.push('', '**This answer is for one fixed path of returns**, the plan\'s own. At the most a plan can spend '
            + 'on that path it has no margin, and it will not last in every market. The app\'s Test Bench also '
            + 'requires the plan to last in 90% of simulated markets by default; pass `simulatedMarketsPercent: 90` '
            + 'for that figure. It takes one to two minutes.');
    }
    return lines.join('\n');
}
