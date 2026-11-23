/**
 * loss-years.mjs
 *
 * Spec 18 §4: the loss-years condition in figures and words (js/loss-years.js),
 * as the Test Bench and max_spending use it.
 *
 *   WHEN        the years start at the first January on or after both the
 *               retirement date and the plan's start; years past the plan's
 *               end are not run.
 *   ENTRY       the page drops a typed leading minus and refuses a plus, a
 *               fraction, anything above 100; MCP refuses a negative, a
 *               fraction, anything above 100 and a fourth year.
 *   WORDS       the chip, the line under the control and the clause.
 *   EVERY RUN   each job of a Test Bench test carries the schedule, and so does
 *               the chart's plan; none is sent when there are no loss years.
 *   MCP         max_spending solves under the loss years, names them, and the
 *               plan it hands back has none.
 *
 * The clock is pinned: quick-start dates come from `new Date()`.
 *
 * Run: node tests/loss-years.mjs   (from src/)
 */

import assert from 'node:assert/strict';
import './tools/localstorage-polyfill.js';

const RealDate = Date;
const PINNED = '2026-11-15T12:00:00Z';
globalThis.Date = class extends RealDate {
    constructor(...args) { return args.length ? new RealDate(...args) : new RealDate(PINNED); }
    static now() { return new RealDate(PINNED).getTime(); }
};

const {
    NO_LOSS_YEARS, lossYearsOf, parseLossFigure, lossYearsCalendar, lossYearsSchedule,
    lossYearsChip, lossYearsClause, lossYearsLine, lossYearsFromPercent,
} = await import('../js/loss-years.js');
const { conditionedPlan, conditionsClause, conditionChips, foundUnderText } = await import('../js/test-bench-view.js');
const { planFromProfile } = await import('../js/mcp/run-plan.js');
const { maxSpending, maxSpendingMarkdown } = await import('../js/mcp/max-spending.js');
const { MINUS } = await import('../js/utils/html.js');

let passed = 0, failed = 0;
async function check(label, fn) {
    try { await fn(); passed++; console.log(`  ok   ${label}`); }
    catch (err) { failed++; console.log(`  FAIL ${label}\n       ${err.message}`); }
}

const ym = (year, month) => ({ year, month });
const TWO = { count: 2, stocks: [30, 20, 40], bonds: [10, 0, 5] };
const PLAN_DATES = { retirement: ym(2031, 1), first: ym(2026, 1), last: ym(2060, 12) };

console.log('\n── when ──\n');

await check('from the first January on or after both retirement and the plan\'s start', () => {
    assert.equal(lossYearsCalendar(TWO, PLAN_DATES).first, 2031, 'retiring in January 2031');
    assert.equal(lossYearsCalendar(TWO, { ...PLAN_DATES, retirement: ym(2031, 6) }).first, 2032, 'retiring mid-2031');
    assert.equal(lossYearsCalendar(TWO, { retirement: ym(2020, 1), first: ym(2026, 10), last: ym(2050, 12) }).first, 2027,
        'starting mid-2026, already retired');
    assert.equal(lossYearsCalendar(TWO, { retirement: ym(2020, 1), first: ym(2026, 1), last: ym(2050, 12) }).first, 2026,
        'starting January 2026, already retired');
    assert.equal(lossYearsCalendar(TWO, { retirement: null, first: ym(2026, 3), last: ym(2050, 12) }).first, 2027,
        'no retirement date: from the plan');
});

await check('the schedule has one entry per year the plan reaches, as rates', () => {
    assert.deepEqual(lossYearsSchedule(TWO, PLAN_DATES), [
        { year: 2031, stocks: -0.3, bonds: -0.1 },
        { year: 2032, stocks: -0.2, bonds: 0 },
    ]);
    const three = { ...TWO, count: 3 };
    assert.deepEqual(lossYearsSchedule(three, { ...PLAN_DATES, last: ym(2032, 6) }).map((e) => e.year), [2031, 2032],
        'a plan ending in 2032 runs only 2031 and 2032');
    assert.equal(lossYearsSchedule(three, { ...PLAN_DATES, last: ym(2030, 12) }), null, 'a plan ending before');
    assert.equal(lossYearsSchedule(NO_LOSS_YEARS, PLAN_DATES), null, 'none');
});

await check('changing the count keeps the figures: only the count is read', () => {
    assert.deepEqual(lossYearsOf({ ...TWO, count: 1 }), { count: 1, stocks: [30], bonds: [10] });
    assert.deepEqual(lossYearsOf({ ...TWO, count: 3 }), { count: 3, stocks: [30, 20, 40], bonds: [10, 0, 5] });
    assert.deepEqual(lossYearsOf(NO_LOSS_YEARS), { count: 0, stocks: [], bonds: [] });
    assert.deepEqual(NO_LOSS_YEARS.stocks, [20, 20, 20], 'a new year\'s stock figure is 20%');
    assert.deepEqual(NO_LOSS_YEARS.bonds, [0, 0, 0], 'a new year\'s bond figure is 0%');
});

console.log('\n── entry ──\n');

await check('the page drops a typed minus and keeps a whole percentage', () => {
    for (const [typed, value] of [['30', 30], ['-30', 30], [`${MINUS}30`, 30], ['30%', 30], [' 0 ', 0], ['100', 100]]) {
        assert.deepEqual(parseLossFigure(typed), { value }, JSON.stringify(typed));
    }
});

await check('the page refuses a plus, a fraction, above 100, and nothing', () => {
    for (const typed of ['+30', '0.3', '30.5', '101', '', 'abc', '--30']) {
        assert.deepEqual(parseLossFigure(typed), { error: 'A loss is 0% to 100%' }, JSON.stringify(typed));
    }
});

await check('MCP takes a number or { stocks, bonds } per year', () => {
    assert.deepEqual(lossYearsFromPercent([30, 20]), { count: 2, stocks: [30, 20], bonds: [0, 0] });
    assert.deepEqual(lossYearsFromPercent([{ stocks: 30, bonds: 10 }, 20]), { count: 2, stocks: [30, 20], bonds: [10, 0] });
    assert.deepEqual(lossYearsFromPercent([]), { count: 0, stocks: [], bonds: [] });
});

await check('MCP refuses a negative, a fraction, above 100, a fourth year and a stray key', () => {
    assert.throws(() => lossYearsFromPercent([-30]), /negative/);
    assert.throws(() => lossYearsFromPercent([0.3]), /Pass 30 for a 30% fall, not 0\.3/);
    assert.throws(() => lossYearsFromPercent([101]), /above 100/);
    assert.throws(() => lossYearsFromPercent([10, 10, 10, 10]), /at most 3/);
    assert.throws(() => lossYearsFromPercent([{ stocks: 30, cash: 5 }]), /unknown field/);
    assert.throws(() => lossYearsFromPercent([{ bonds: 5 }]), /needs a stocks figure/);
    assert.throws(() => lossYearsFromPercent([{ stocks: 30, bonds: -5 }]), /negative/);
});

console.log('\n── words ──\n');

await check('the chip lists the stock figures, and the bond figures when there are any', () => {
    assert.equal(lossYearsChip({ count: 2, stocks: [30, 20], bonds: [0, 0] }), `2 loss years (${MINUS}30%, ${MINUS}20%)`);
    assert.equal(lossYearsChip(TWO), `2 loss years (stocks ${MINUS}30%, ${MINUS}20%; bonds ${MINUS}10%, 0%)`);
    assert.equal(lossYearsChip({ count: 1, stocks: [30], bonds: [0] }), `1 loss year (${MINUS}30%)`);
    assert.equal(lossYearsChip(NO_LOSS_YEARS), null);
});

await check('the line says what the figures do, the combined fall, and the scale', () => {
    assert.equal(lossYearsLine(TWO, PLAN_DATES),
        'Stock prices fall 30% in 2031 and 20% in 2032, 44% over the two years. Bond prices fall 10% in 2031, '
        + 'and bonds keep paying interest. For scale: since 1970 stocks have never lost more than 37.6% over one, '
        + 'two or three years in a row.');
    assert.match(lossYearsLine({ count: 1, stocks: [25], bonds: [0] }, PLAN_DATES),
        /^Stock prices fall 25% in 2031\. Bonds keep their price\. For scale/);
    assert.match(lossYearsLine({ ...TWO, count: 3 }, { ...PLAN_DATES, last: ym(2032, 6) }), /The plan ends in 2032, so 2033 is not run\./);
    assert.match(lossYearsLine(TWO, { ...PLAN_DATES, last: ym(2030, 12) }), /ends before its first loss year, 2031/);
});

await check('the clause names only the years the plan reaches', () => {
    assert.equal(lossYearsClause(TWO, PLAN_DATES), 'stock prices falling 30% in 2031 and 20% in 2032, and bond prices 10% in 2031');
    assert.equal(lossYearsClause(TWO, { ...PLAN_DATES, last: ym(2030, 12) }), null);
    assert.equal(conditionsClause({ outlook: 'optimistic', lossYears: { count: 1, stocks: [30], bonds: [0] } }, PLAN_DATES),
        'with stock and bond returns 1% a year higher than you entered and stock prices falling 30% in 2031');
    assert.equal(conditionsClause({}, PLAN_DATES), null);
});

await check('Found under carries the loss-years chip after the outlook\'s', () => {
    assert.deepEqual(conditionChips({ outlook: 'pessimistic', lossYears: { count: 1, stocks: [30], bonds: [0] } }),
        [`Pessimistic (${MINUS}1%)`, `1 loss year (${MINUS}30%)`]);
    assert.equal(foundUnderText({ conditions: { lossYears: { count: 1, stocks: [30], bonds: [0] } } }),
        `Found under · 1 loss year (${MINUS}30%)`);
});

console.log('\n── every run gets it ──\n');

// A stand-in Worker that records each job and answers at once (as market-outlook.mjs).
const jobs = [];
globalThis.Worker = class {
    constructor() { this.onmessage = null; }
    postMessage(payload) {
        jobs.push(payload);
        const results = payload.kind === 'spending'
            ? { asEntered: { monthlySpending: 1 }, best: { factor: 1.1, monthlySpending: 1.1 }, limits: payload.limits, runs: 1 }
            : payload.kind === 'routing' ? { best: null, changes: [], runs: 1 } : {};
        setTimeout(() => this.onmessage?.({ data: { action: 'complete', results } }), 0);
    }
    terminate() {}
};
const { runTestBench, runRoutingTest, runRoutingChecks, benchPlan } = await import('../js/test-bench-run.js');

const SPEC = planFromProfile('retired');
const SOURCE = { modelAssets: SPEC.modelAssets, lifeEvents: SPEC.lifeEvents ?? [], guardrailParams: {}, retirementDateInt: null };
const LOSSY = conditionedPlan(SOURCE, { lossYears: { count: 1, stocks: [30], bonds: [10] } }, PLAN_DATES);
const EXPECTED = [{ year: 2031, stocks: -0.3, bonds: -0.1 }];

await check('the conditioned plan carries the schedule, and keeps the user\'s rates', () => {
    assert.deepEqual(LOSSY.returnSchedule, EXPECTED);
    assert.equal(JSON.stringify(LOSSY.modelAssets), JSON.stringify(conditionedPlan(SOURCE, {}, PLAN_DATES).modelAssets));
    assert.equal(conditionedPlan(SOURCE, {}, PLAN_DATES).returnSchedule, null);
});

await check('every job of a spending test carries it: the solver, the markets limit, each check', async () => {
    jobs.length = 0;
    await runTestBench(LOSSY, { floor: 0, success: 0.9 }, { solved: () => {}, check: () => {} });
    assert.ok(jobs.length >= 4, `${jobs.length} jobs`);
    for (const job of jobs) assert.deepEqual(job.returnSchedule, EXPECTED, `a ${job.kind ?? 'markets'} job`);
});

await check('a routing test\'s searches and its routing\'s checks carry it', async () => {
    jobs.length = 0;
    await runRoutingTest(LOSSY, { floor: 0 }, 1, { started: () => {}, found: () => {} });
    await runRoutingChecks(LOSSY, { best: { factor: 1.05 }, lifeEvents: SOURCE.lifeEvents }, { check: () => {} });
    assert.ok(jobs.some((j) => j.kind === 'routing') && jobs.some((j) => !j.kind));
    for (const job of jobs) assert.deepEqual(job.returnSchedule, EXPECTED, `a ${job.kind ?? 'markets'} job`);
});

await check('the chart\'s plan carries it in its config', () => {
    assert.deepEqual(benchPlan(LOSSY).config.returnSchedule, EXPECTED);
    assert.equal(benchPlan(conditionedPlan(SOURCE, {}, PLAN_DATES)).config.returnSchedule, null);
});

await check('without loss years no job carries a schedule', async () => {
    jobs.length = 0;
    await runTestBench(conditionedPlan(SOURCE, {}, PLAN_DATES), { floor: 0 }, { solved: () => {}, check: () => {} });
    for (const job of jobs) assert.equal(job.returnSchedule, null);
});

console.log('\n── max_spending ──\n');

const plain = await maxSpending(SPEC);
const lossy = await maxSpending(SPEC, { lossYearsPercent: [{ stocks: 40, bonds: 10 }, 30] });

await check('loss years at the start of retirement lower what the plan can spend', () => {
    assert.ok(lossy.result.best.monthlySpending < plain.result.best.monthlySpending,
        `${lossy.result.best.monthlySpending} vs ${plain.result.best.monthlySpending}`);
});

await check('the report names them in a line and in the headline', () => {
    const md = maxSpendingMarkdown(lossy);
    assert.match(md, /\*\*Loss years:\*\* Stock prices fall 40% in \d{4} and 30% in \d{4}, 58% over the two years\./);
    assert.match(md, /\*\*With stock prices falling 40% in \d{4} and 30% in \d{4}, and bond prices 10% in \d{4}, the most/);
    assert.doesNotMatch(maxSpendingMarkdown(plain), /Loss years/);
});

await check('the plan handed back has no loss years, and the report says so', () => {
    assert.equal(JSON.stringify(lossy.solvedSpec).includes('returnSchedule'), false);
    assert.match(maxSpendingMarkdown(lossy, { handle: 'plan_x' }), /It has no loss years in it either/);
});

await check('max_spending refuses what the page refuses', async () => {
    await assert.rejects(maxSpending(SPEC, { lossYearsPercent: [0.3] }), /not 0\.3/);
    await assert.rejects(maxSpending(SPEC, { lossYearsPercent: [-20] }), /negative/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
