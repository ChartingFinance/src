/**
 * test-bench-chart.mjs — the Test Bench's chart of a plan.
 *
 * ── What this guards ─────────────────────────────────────────────────
 *
 * js/test-bench-chart.js runs one column of the result table again on the
 * page and groups it as Macro Projection does. What is load-bearing:
 *
 *   - it draws Macro's groups, with Macro's labels, colours, order and
 *     periods, so the two cannot disagree about what "Retirement" holds;
 *   - each bar is the end of its period in today's dollars, so the last bar's
 *     total is the table's "Left at the end";
 *   - the run it draws is the run the bench reported: the solver's answer, and
 *     a routing's answer under that routing's life events;
 *   - it changes nothing it is given;
 *   - every column fits one y-axis.
 *
 * ── The clock ───────────────────────────────────────────────────────
 *
 * Quick-start dates come from the clock, so every plan here is built under a
 * pinned date. The runs themselves read no clock.
 *
 * Usage:  node tests/test-bench-chart.mjs   (from src/)
 */

import assert from 'node:assert/strict';
import './tools/localstorage-polyfill.js';
import { planFromProfile, listProfiles, simConfigFromPlanSpec } from '../js/mcp/run-plan.js';
import { solveSpending, portfolioAt, runAt } from '../js/spending-solver.js';
import { searchRouting } from '../js/routing-search.js';
import { columnSeries, groupSeries, stackedRange, chartConfig, CHART_COLUMNS, periodWord } from '../js/test-bench-chart.js';
import { charting_buildGroupedMetric, charting_buildPhaseMarkers } from '../js/charting.js';
import { planOutcome } from '../js/outcome-summary.js';
import { detectIssues } from '../js/portfolio-issues.js';
import { Metric } from '../js/metric.js';
import { DateInt } from '../js/utils/date-int.js';
import { benchPlan } from '../js/test-bench-run.js';
import { simConfigFromGlobals } from '../js/globals.js';

let passed = 0, failed = 0;
async function check(label, fn) {
    try { await fn(); passed++; console.log(`  ok   ${label}`); }
    catch (err) { failed++; console.log(`  FAIL ${label}\n       ${err.message}`); }
}

/** Run `fn` with the clock pinned to `iso`. */
function at(iso, fn) {
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
        constructor(...args) { return args.length ? new RealDate(...args) : new RealDate(iso); }
        static now() { return new RealDate(iso).getTime(); }
    };
    try { return fn(); } finally { globalThis.Date = RealDate; }
}

const planOf = (spec) => ({
    modelAssets: spec.modelAssets,
    lifeEvents: spec.lifeEvents ?? [],
    config: simConfigFromPlanSpec(spec),
});

const PROFILES = at('2026-11-15T12:00:00Z', () =>
    listProfiles().map(({ key }) => ({ key, plan: planOf(planFromProfile(key)) })));
const planFor = (key) => PROFILES.find((p) => p.key === key).plan;

const lastOf = (series) => series.total[series.total.length - 1];
/** Two dollar amounts equal to the cent. */
const sameCents = (actual, expected, what) =>
    assert.ok(Math.abs(actual - expected) < 0.005, `${what}: ${actual} against ${expected}`);

console.log('\n── Macro\'s groups, at the end of each period ──\n');

await check('every quick-start: the groups, labels, colours, order and periods are Macro\'s', () => {
    for (const { key, plan } of PROFILES) {
        const portfolio = portfolioAt(plan, 1);
        portfolio.buildChartingDisplayData();
        const macro = charting_buildGroupedMetric(portfolio, Metric.VALUE, new Set());
        const mine = groupSeries(portfolio);
        assert.deepEqual(mine.labels, macro.data.labels, `${key}: periods`);
        assert.deepEqual(
            mine.datasets.map((d) => [d.label, d.backgroundColor]),
            macro.data.datasets.map((d) => [d.label, d.backgroundColor]), `${key}: groups`);
        assert.ok(mine.datasets.length >= 3, `${key}: only ${mine.datasets.length} groups`);
        for (const d of mine.datasets) assert.equal(d.data.length, mine.labels.length, `${key}: ${d.label} bars`);
    }
});

await check('each bar is the last month of its period, and the last bar is the plan\'s last month', () => {
    for (const { key, plan } of PROFILES) {
        const portfolio = portfolioAt(plan, 1);
        const { labels, months } = groupSeries(portfolio);
        const length = portfolio.modelAssets[0].getHistory(Metric.VALUE).length;
        assert.equal(months[months.length - 1], length - 1, `${key}: the last bar`);
        months.forEach((m, k) => {
            const when = DateInt.from(portfolio.firstDateInt.year, portfolio.firstDateInt.month);
            when.addMonths(m);
            // Every quick-start runs past 18 years, so its bars are years.
            assert.equal(String(when.year), labels[k], `${key}: bar ${k} is in ${labels[k]}`);
            if (k < months.length - 1) assert.equal(when.month, 12, `${key}: bar ${k} is December`);
        });
    }
});

await check('every quick-start: the last bar\'s total is the Outcome card\'s ending, in today\'s dollars', () => {
    for (const { key, plan } of PROFILES) {
        const portfolio = portfolioAt(plan, 1);
        const outcome = planOutcome(portfolio, detectIssues(portfolio));
        sameCents(lastOf(groupSeries(portfolio)), outcome.endReal, key);
        // And it is not the nominal figure: the deflation is applied.
        assert.ok(outcome.end - outcome.endReal > 1000, `${key}: no inflation to tell the two apart`);
    }
});

await check('a bar\'s segments sum to its total, and the total is every asset\'s value then', () => {
    const portfolio = portfolioAt(planFor('dualIncome'), 1);
    const series = groupSeries(portfolio);
    const k = Math.floor(series.labels.length / 2);
    const m = series.months[k];
    const nominal = portfolio.modelAssets.reduce((sum, a) => sum + (a.getHistory(Metric.VALUE)[m] ?? 0), 0);
    const real = nominal / portfolio.monthlyPriceIndex[m];
    sameCents(series.total[k], real, 'the middle bar');
    sameCents(series.datasets.reduce((s, d) => s + d.data[k], 0), series.total[k], 'its segments');
});

console.log('\n── The run the bench reported ──\n');

const SOLVED = new Map();
const solved = (key) => {
    if (!SOLVED.has(key)) SOLVED.set(key, solveSpending(planFor(key), { floor: 0 }));
    return SOLVED.get(key);
};

await check('As entered and Spend the most end on the table\'s own figures', () => {
    for (const key of ['midCareer', 'retired']) {
        const plan = planFor(key);
        const result = solved(key);
        assert.ok(result.best && Math.abs(result.best.factor - 1) > 0.01, `${key}: the answer is the plan as entered`);
        const entered = columnSeries(plan, 1);
        const best = columnSeries(plan, result.best.factor);
        sameCents(lastOf(entered), result.asEntered.endingReal, `${key} as entered`);
        sameCents(lastOf(best), result.best.endingReal, `${key} at the most`);
        assert.ok(Math.abs(lastOf(best) - lastOf(entered)) > 1000, `${key}: the two columns draw the same run`);
    }
});

await check('With this routing ends on the routing\'s figure, under the routing\'s life events', () => {
    const plan = planFor('retired');
    const found = searchRouting(plan, { floor: 0, start: 'plan', seed: 1 });
    assert.ok(found.best && found.changes.length > 0, 'the search found no routing to draw');
    const routed = columnSeries(plan, found.best.factor, { lifeEvents: found.lifeEvents });
    sameCents(lastOf(routed), found.best.endingReal, 'the routing at its most');
    // The same spending without the routing is another run.
    const unrouted = columnSeries(plan, found.best.factor);
    assert.ok(Math.abs(lastOf(routed) - lastOf(unrouted)) > 1000,
        `the routing changes nothing the chart shows: ${lastOf(routed)} against ${lastOf(unrouted)}`);
});

await check('it changes nothing it is given', () => {
    const plan = planFor('midCareer');
    const lifeEvents = JSON.parse(JSON.stringify(plan.lifeEvents));
    lifeEvents[0].displayName = 'Renamed';
    const before = JSON.stringify(plan);
    const eventsBefore = JSON.stringify(lifeEvents);
    columnSeries(plan, 1.3);
    columnSeries(plan, 0.7, { lifeEvents, ages: { startAge: 45, retirementAge: 65 } });
    assert.equal(JSON.stringify(plan), before, 'the plan');
    assert.equal(JSON.stringify(lifeEvents), eventsBefore, 'the life events');
    // And a run at 1 after them is the plan's own.
    sameCents(lastOf(columnSeries(plan, 1)), runAt(plan, 1).endingReal, 'a later run');
});

await check('the phase markers are Macro\'s, for the column\'s own run', () => {
    const plan = planFor('midCareer');
    const ages = { startAge: 45, retirementAge: 65 };
    const series = columnSeries(plan, 1, { ages });
    const portfolio = portfolioAt(plan, 1);
    assert.deepEqual(series.markers,
        charting_buildPhaseMarkers(portfolio, portfolio.lifeEvents, ages.startAge, ages.retirementAge, null));
    assert.ok(series.markers.some((m) => /retire/i.test(m.label)), 'no Retire marker');
    assert.deepEqual(columnSeries(plan, 1).markers, [], 'markers without ages');
});

console.log('\n── One axis ──\n');

await check('the range holds every column stacked, and no more', () => {
    const plan = planFor('midCareer');
    const columns = [columnSeries(plan, 1), columnSeries(plan, solved('midCareer').best.factor)];
    const range = stackedRange(columns);
    let top = 0, bottom = 0;
    for (const s of columns) {
        for (let k = 0; k < s.labels.length; k++) {
            const values = s.datasets.map((d) => d.data[k]);
            top = Math.max(top, values.filter((v) => v > 0).reduce((a, b) => a + b, 0));
            bottom = Math.min(bottom, values.filter((v) => v < 0).reduce((a, b) => a + b, 0));
        }
    }
    assert.equal(range.max, top);
    assert.equal(range.min, bottom);
    assert.ok(range.min < 0, 'Mid Career has a mortgage, so its bars go below $0');
    // The bigger column sets the top, so the other's own range is inside it.
    for (const s of columns) {
        const own = stackedRange([s]);
        assert.ok(own.max <= range.max && own.min >= range.min);
    }
});

await check('the chart takes the shared axis and copies its data', () => {
    const series = columnSeries(planFor('retired'), 1);
    const range = { min: -5, max: 9e6 };
    const config = chartConfig(series, range);
    assert.equal(config.options.scales.y.suggestedMin, -5);
    assert.equal(config.options.scales.y.suggestedMax, 9e6);
    assert.equal(config.options.scales.y.stacked, true);
    config.data.datasets[0].data[0] = 'changed';
    config.data.labels[0] = 'changed';
    assert.notEqual(series.datasets[0].data[0], 'changed', 'the series was changed through the chart');
    assert.notEqual(series.labels[0], 'changed', 'the labels were changed through the chart');
    const footer = config.options.plugins.tooltip.callbacks.footer([{ parsed: { y: 1000 } }, { parsed: { y: 234.5 } }]);
    assert.equal(footer, 'Total: $1,235');
});

await check('the picker\'s columns are the table\'s', () => {
    assert.deepEqual(CHART_COLUMNS.map((c) => c.label), ['As entered', 'Spend the most', 'With this routing']);
});

await check('the caption names the period a bar stands for', () => {
    assert.equal(groupSeries(portfolioAt(planFor('retired'), 1)).periodMonths, 12);
    assert.deepEqual([1, 3, 6, 12].map(periodWord), ['month', 'quarter', 'half-year', 'year']);
    // A plan of two years has a bar a month (MonthsSpan), and its last bar is still its last month.
    const plan = planFor('retired');
    const short = { ...plan, config: { ...plan.config, finishAge: plan.config.startAge + 2 } };
    const portfolio = portfolioAt(short, 1);
    const series = groupSeries(portfolio);
    assert.equal(series.periodMonths, 1, `a ${series.labels.length}-bar plan`);
    assert.deepEqual(series.months, series.labels.map((_, k) => k));
    sameCents(lastOf(series), planOutcome(portfolio, detectIssues(portfolio)).endReal, 'the short plan');
});

await check('benchPlan copies the plan and carries the settings in force', () => {
    const plan = planFor('retired');
    const copy = benchPlan(plan);
    assert.deepEqual(copy.config, simConfigFromGlobals());
    assert.equal(JSON.stringify(copy.modelAssets), JSON.stringify(plan.modelAssets));
    assert.notEqual(copy.modelAssets, plan.modelAssets);
    assert.notEqual(copy.lifeEvents[0], plan.lifeEvents[0]);
    assert.equal(typeof copy.ages.startAge, 'number');
    assert.equal(typeof copy.ages.retirementAge, 'number');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
