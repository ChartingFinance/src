/**
 * market-outlook.mjs — the Test Bench's market outlook (spec 17,
 * js/market-outlook.js).
 *
 * ── What this guards ─────────────────────────────────────────────────
 *
 * Pessimistic and Optimistic run a test with every stock and bond return one
 * point a year lower or higher. Five things about that are load-bearing:
 *
 *   - which assets move, and by how much: the six stock and bond instruments,
 *     the growth part only, whatever shape the rate arrives in;
 *   - Moderate is today: every number equal to a run with no outlook at all;
 *   - the simulated markets carry the shift exactly once: through the copy's
 *     rates in calibrated mode, and through returnShift in historical mode,
 *     never both;
 *   - the Test Bench's runner sends the copy and the shift to every job, keeps
 *     a separate cache per outlook, and names the outlook on its result;
 *   - the words say which outlook a figure is under, and say nothing new at
 *     Moderate.
 *
 * The clock is pinned: quick-start dates come from `new Date()`.
 *
 * Usage:  node tests/market-outlook.mjs   (from src/)
 */

import assert from 'node:assert/strict';
import './tools/localstorage-polyfill.js';

const RealDate = Date;
const PINNED = '2026-11-15T12:00:00Z';
globalThis.Date = class extends RealDate {
    constructor(...args) { return args.length ? new RealDate(...args) : new RealDate(PINNED); }
    static now() { return new RealDate(PINNED).getTime(); }
};

const { MarketOutlook, OUTLOOKS, returnShift, isStockOrBond, outlookAssets, outlookPlan,
        outlookLabel, outlookClause, outlookNote } = await import('../js/market-outlook.js');
const { Instrument } = await import('../js/instruments/instrument.js');
const { ModelAsset } = await import('../js/model-asset.js');
const { ModelLifeEvent } = await import('../js/life-event.js');
const { ARR } = await import('../js/utils/arr.js');
const { DateInt } = await import('../js/utils/date-int.js');
const { applyRandomRates, buildYearPool, computeMonteCarlo } = await import('../js/mc-compute.js');
const { global_sp500_annual_returns, global_10yr_treasury_rates, global_cpi_annual_inflation,
        global_wage_growth_annual } = await import('../js/market-data.js');
const { planFromProfile, simConfigFromPlanSpec } = await import('../js/mcp/run-plan.js');
const { quickStartProfiles } = await import('../js/quick-start.js');
const { solveSpending } = await import('../js/spending-solver.js');
const { simulatedRate } = await import('../js/success-limit.js');
const { spendingHeadline, successNote } = await import('../js/spending-report.js');
const { Portfolio } = await import('../js/portfolio.js');
const { ageToDateIntFor } = await import('../js/plan-dates.js');

let passed = 0, failed = 0;
async function check(label, fn) {
    try { await fn(); passed++; console.log(`  ok   ${label}`); }
    catch (err) { failed++; console.log(`  FAIL ${label}\n       ${err.message}`); }
}

const MOVED = ['taxableEquity', 'ira', 'rothIRA', '401K', 'usBond', 'corpBond'];

/** One plain asset of every instrument, each with its own return and a dividend. */
function everyInstrument() {
    return Object.values(Instrument).map((instrument, i) => ({
        id: `a${i + 1}`, instrument, displayName: `${instrument} ${i}`,
        startDateInt: { year: 2027, month: 1 }, startCurrency: { amount: 10000 },
        annualReturnRate: { annualReturnRate: 0.01 * (i + 1) },
        annualDividendRate: { annualReturnRate: 0.005 },
    }));
}
const rateOf = (plain) => plain.annualReturnRate?.annualReturnRate ?? plain.annualReturnRate?.rate;

console.log('\n── Which assets move, and by how much ──');

await check('the six stock and bond instruments move by ±1%, and nothing else moves', () => {
    const before = everyInstrument();
    for (const outlook of [MarketOutlook.PESSIMISTIC, MarketOutlook.OPTIMISTIC]) {
        const after = outlookAssets(before, outlook);
        const shift = outlook === MarketOutlook.OPTIMISTIC ? 0.01 : -0.01;
        after.forEach((a, i) => {
            const b = before[i];
            if (MOVED.includes(b.instrument)) {
                assert.ok(Math.abs(rateOf(a) - (rateOf(b) + shift)) < 1e-12, `${b.instrument} moved by ${rateOf(a) - rateOf(b)}`);
                assert.deepEqual({ ...a, annualReturnRate: null }, { ...b, annualReturnRate: null },
                    `${b.instrument}: only the return rate changes`);
            } else {
                assert.deepEqual(a, b, `${b.instrument} must not move`);
            }
            assert.deepEqual(a.annualDividendRate, b.annualDividendRate, `${b.instrument}: dividend rate left alone`);
        });
    }
    assert.deepEqual(Object.values(Instrument).filter(isStockOrBond).sort(), [...MOVED].sort());
});

await check('the moved rate is the one ModelAsset.fromJSON reads, whatever shape it arrived in', () => {
    const shapes = {
        app: { annualReturnRate: { annualReturnRate: 0.07 } },
        spec: { annualReturnRate: { rate: 0.07 } },
        live: { annualReturnRate: new ARR(0.07) },
    };
    for (const [name, shape] of Object.entries(shapes)) {
        const asset = { instrument: 'taxableEquity', displayName: name, startDateInt: { year: 2027, month: 1 },
            startCurrency: { amount: 1000 }, ...shape };
        const [moved] = outlookAssets([asset], MarketOutlook.OPTIMISTIC);
        assert.ok(Math.abs(ModelAsset.fromJSON(moved).annualReturnRate.rate - 0.08) < 1e-12, `${name}: read back 8%`);
    }
    // A live ModelAsset, as the app's plan source hands over.
    const live = ModelAsset.fromJSON({ instrument: 'rothIRA', displayName: 'Roth', startDateInt: { year: 2027, month: 1 },
        startCurrency: { amount: 1000 }, annualReturnRate: { rate: 0.06 } });
    const [moved] = outlookAssets([live], MarketOutlook.PESSIMISTIC);
    assert.ok(Math.abs(ModelAsset.fromJSON(moved).annualReturnRate.rate - 0.05) < 1e-12, 'live: read back 5%');
    // A stock asset with no rate is 0%, as fromJSON reads it, and moves from there.
    const [bare] = outlookAssets([{ instrument: 'ira', displayName: 'IRA', startDateInt: { year: 2027, month: 1 },
        startCurrency: { amount: 1 } }], MarketOutlook.OPTIMISTIC);
    assert.equal(ModelAsset.fromJSON(bare).annualReturnRate.rate, 0.01);
});

await check('an old instrument name is read as fromJSON reads it (a "home" is real estate and does not move)', () => {
    const [home] = outlookAssets([{ instrument: 'home', displayName: 'Home', startDateInt: { year: 2027, month: 1 },
        startCurrency: { amount: 1 }, annualReturnRate: { rate: 0.03 } }], MarketOutlook.OPTIMISTIC);
    assert.equal(rateOf(home), 0.03);
});

await check('Moderate is an exact copy, and nothing given is changed', () => {
    for (const p of quickStartProfiles) {
        const spec = planFromProfile(p.key);
        const json = JSON.stringify(spec.modelAssets);
        assert.equal(JSON.stringify(outlookAssets(spec.modelAssets, MarketOutlook.MODERATE)), json, p.key);
        outlookAssets(spec.modelAssets, MarketOutlook.OPTIMISTIC);
        assert.equal(JSON.stringify(spec.modelAssets), json, `${p.key}: input unchanged`);
    }
});

await check('a name that is not an outlook is refused; absent is Moderate', () => {
    assert.equal(returnShift(), 0);
    assert.equal(returnShift(undefined), 0);
    assert.equal(returnShift('optimistic'), 0.01);
    assert.equal(returnShift('pessimistic'), -0.01);
    assert.throws(() => returnShift('rosy'), /Unknown market outlook "rosy"/);
    assert.throws(() => outlookAssets([], 'Optimistic'), /Unknown market outlook/);
    assert.deepEqual(OUTLOOKS, ['pessimistic', 'moderate', 'optimistic']);
    const plan = outlookPlan({ modelAssets: everyInstrument(), lifeEvents: [] }, 'optimistic');
    assert.equal(plan.outlook, 'optimistic');
});

console.log('\n── The simulated markets carry the shift once ──');

const POOL = buildYearPool();
const FIRST = POOL.years[0];
const pct = (series) => series[FIRST] / 100;

/** The drawn rates of every instrument, for one draw of the pool's first year. */
function drawn(dataMode, shift) {
    const assets = everyInstrument().map((a) => ModelAsset.fromJSON(a));
    const base = new Map(assets.map((a) => [a, a.annualReturnRate.rate]));
    applyRandomRates(assets, POOL, dataMode, dataMode === 'calibrated' ? base : null, 0.025, () => 0, shift);
    return new Map(assets.map((a) => [a.instrument, a.annualReturnRate.rate]));
}

await check('historical: drawn stock and Treasury rates gain the shift; nothing else does', () => {
    const plain = drawn('historical', 0), up = drawn('historical', 0.01);
    for (const instrument of ['taxableEquity', 'ira', 'rothIRA', '401K']) {
        assert.ok(Math.abs(plain.get(instrument) - (pct(global_sp500_annual_returns) - 0.005)) < 1e-12, `${instrument} is the S&P year`);
        assert.ok(Math.abs(up.get(instrument) - plain.get(instrument) - 0.01) < 1e-12, `${instrument} +1%`);
    }
    assert.ok(Math.abs(plain.get('usBond') - (pct(global_10yr_treasury_rates) - 0.005)) < 1e-12, 'usBond is the Treasury year');
    assert.ok(Math.abs(up.get('usBond') - plain.get('usBond') - 0.01) < 1e-12, 'usBond +1%');
    for (const [instrument, rate] of plain) {
        if (['taxableEquity', 'ira', 'rothIRA', '401K', 'usBond'].includes(instrument)) continue;
        assert.equal(up.get(instrument), rate, `${instrument} must not take the shift`);
    }
    // corpBond is never drawn: it keeps its own (the copy's) rate.
    assert.equal(plain.get('corpBond'), 0.01 * (Object.values(Instrument).indexOf('corpBond') + 1));
    // Expenses and incomes follow CPI and wages, unshifted.
    assert.ok(Math.abs(up.get('monthlyExpense') - pct(global_cpi_annual_inflation)) < 1e-12);
    assert.ok(Math.abs(up.get('workingIncome') - pct(global_wage_growth_annual)) < 1e-12);
});

await check('calibrated: returnShift is ignored (the copy already carries it)', () => {
    assert.deepEqual([...drawn('calibrated', 0.01)], [...drawn('calibrated', 0)]);
});

await check('the drawn stocks and bonds are all among the assets an outlook moves', () => {
    const plain = drawn('historical', 0), up = drawn('historical', 0.01);
    for (const [instrument, rate] of plain) {
        if (up.get(instrument) !== rate) assert.ok(isStockOrBond(instrument), `${instrument} took the shift but is not a stock or bond`);
    }
});

// A real plan across a few markets.
const SPEC = planFromProfile('midCareer');
const config = () => simConfigFromPlanSpec(SPEC);
const RETIREMENT = ageToDateIntFor(
    new Portfolio(SPEC.modelAssets.map((a) => ModelAsset.fromJSON(a)), false, config()).config,
    SPEC.settings.retirementAge);

async function markets(modelAssets, dataMode, shift) {
    return computeMonteCarlo(modelAssets.map((a) => ModelAsset.fromJSON(a)), {
        numSimulations: 24, retirementDateInt: new DateInt(RETIREMENT.toInt()),
        lifeEvents: (SPEC.lifeEvents ?? []).map((e) => ModelLifeEvent.fromJSON(e)),
        dataMode, seed: 1, returnShift: shift, config: config(),
    });
}
const median = (r) => r.bandData[2][r.bandData[2].length - 1];

await check('calibrated markets: the copy moves them, and returnShift on top changes nothing', async () => {
    const up = outlookAssets(SPEC.modelAssets, 'optimistic');
    const once = await markets(up, 'calibrated', 0);
    const twice = await markets(up, 'calibrated', 0.01);
    assert.deepEqual(twice.bandData, once.bandData, 'adding returnShift in calibrated mode would count it twice');
    const asEntered = await markets(SPEC.modelAssets, 'calibrated', 0);
    assert.ok(median(once) > median(asEntered), `optimistic median ${median(once)} must beat ${median(asEntered)}`);
});

await check('historical markets: the shift raises every simulated year after retirement', async () => {
    const up = outlookAssets(SPEC.modelAssets, 'optimistic');
    const withShift = await markets(up, 'historical', 0.01);
    const without = await markets(up, 'historical', 0);
    assert.ok(median(withShift) > median(without), `${median(withShift)} must beat ${median(without)}`);
});

await check('simulatedRate carries sim.returnShift to the markets', async () => {
    const plan = { modelAssets: outlookAssets(SPEC.modelAssets, 'pessimistic'), lifeEvents: SPEC.lifeEvents ?? [], config: config() };
    const sim = { markets: 24, seed: 1, dataMode: 'historical', backtestFromYear: null, retirementDateInt: RETIREMENT.toInt() };
    const down = await simulatedRate(plan, 1.15, { ...sim, returnShift: -0.01 });
    const level = await simulatedRate({ ...plan, config: config() }, 1.15, { ...sim, returnShift: 0 });
    assert.ok(down < level, `−1% in historical markets must last in fewer: ${down} vs ${level}`);
});

console.log('\n── Moderate is today, and the answer moves with the outlook ──');

for (const p of quickStartProfiles) {
    await check(`${p.key}: Moderate equals no outlook; Pessimistic ≤ Moderate ≤ Optimistic`, () => {
        const spec = planFromProfile(p.key);
        const solve = (modelAssets) => solveSpending(
            { modelAssets, lifeEvents: spec.lifeEvents ?? [], config: simConfigFromPlanSpec(spec) }, { floor: 0 });
        const today = solve(spec.modelAssets);
        const moderate = solve(outlookAssets(spec.modelAssets, 'moderate'));
        assert.deepEqual(moderate, today, 'Moderate must give every figure today gives');
        const lo = solve(outlookAssets(spec.modelAssets, 'pessimistic')).best?.monthlySpending ?? 0;
        const hi = solve(outlookAssets(spec.modelAssets, 'optimistic')).best?.monthlySpending ?? 0;
        const mid = today.best?.monthlySpending ?? 0;
        assert.ok(lo <= mid + 0.01 && mid <= hi + 0.01, `${lo} ≤ ${mid} ≤ ${hi}`);
    });
}

console.log('\n── The words ──');

const RESULT = {
    asEntered: { monthlySpending: 5185, runsOut: null },
    best: { monthlySpending: 5545, factor: 1.07 },
    fixedBest: { monthlySpending: 5800 },
    success: { target: 0.9, markets: 300, bestRate: 0.9 },
};

await check('the headline opens with the outlook, and is unchanged at Moderate', () => {
    const today = spendingHeadline(RESULT);
    assert.equal(spendingHeadline({ ...RESULT, outlook: 'moderate' }), today);
    assert.match(today, /^The most this plan can spend is \$5,545 a month/);
    assert.match(spendingHeadline({ ...RESULT, outlook: 'optimistic' }),
        /^With stock and bond returns 1% a year higher than you entered, the most this plan can spend is \$5,545 a month/);
    assert.match(spendingHeadline({ ...RESULT, outlook: 'pessimistic', asEntered: { monthlySpending: 4945, runsOut: { year: 2066 } } }),
        /^With stock and bond returns 1% a year lower than you entered, the expenses as entered cannot all be paid\./);
    assert.match(spendingHeadline({ ...RESULT, best: null, outlook: 'optimistic' }), /^With stock and bond returns 1% a year higher/);
});

await check('the markets note names the outlook on the plan\'s own path, and is unchanged at Moderate', () => {
    assert.equal(successNote({ ...RESULT, outlook: 'moderate' }), successNote(RESULT));
    assert.match(successNote(RESULT), /^On the plan's own path of returns it could spend \$5,800/);
    assert.match(successNote({ ...RESULT, outlook: 'pessimistic' }),
        /^On the plan's own path of returns, 1% a year lower than you entered, it could spend \$5,800/);
});

await check('labels carry the size; Moderate adds no note', () => {
    assert.deepEqual(OUTLOOKS.map(outlookLabel), ['Pessimistic (−1%)', 'Moderate', 'Optimistic (+1%)']);
    assert.equal(outlookClause('moderate'), null);
    assert.equal(outlookNote('moderate'), null);
    assert.equal(outlookNote(undefined), null);
    assert.equal(outlookNote('optimistic'),
        'Every figure assumes stock and bond returns 1% a year higher than you entered. Inflation, wages and cash stay as entered.');
});

console.log('\n── The Test Bench runner ──');

// A stand-in Worker that records each job and answers at once with the least
// a result needs. The runner's plumbing is what is under test, not the jobs.
const jobs = [];
globalThis.Worker = class {
    constructor() { this.onmessage = null; }
    postMessage(payload) {
        jobs.push(payload);
        const results = payload.kind === 'spending'
            ? { asEntered: { monthlySpending: 1 }, best: { factor: 1.1, monthlySpending: 1.1 }, limits: payload.limits, runs: 1 }
            : {};
        setTimeout(() => this.onmessage?.({ data: { action: 'complete', results } }), 0);
    }
    terminate() {}
};
const { runTestBench, runRoutingChecks, benchPlan } = await import('../js/test-bench-run.js');

const SOURCE = { modelAssets: SPEC.modelAssets, lifeEvents: SPEC.lifeEvents ?? [], guardrailParams: {},
                 retirementDateInt: RETIREMENT.toInt() };
const stockRate = (assets) => rateOf(assets.find((a) => a.instrument === '401K'));
const ENTERED = stockRate(SOURCE.modelAssets);

async function bench(outlook, limits = { floor: 0 }) {
    jobs.length = 0;
    let solved = null;
    await runTestBench(outlookPlan(SOURCE, outlook), limits, { solved: (r) => { solved = r; }, check: () => {} });
    return { solved, jobs: [...jobs] };
}

await check('every job gets the moved copy, and the markets get the shift', async () => {
    const { solved, jobs: sent } = await bench('optimistic', { floor: 0, success: 0.9 });
    assert.equal(solved.outlook, 'optimistic', 'the result names its outlook');
    const spending = sent.find((j) => j.kind === 'spending');
    assert.ok(Math.abs(stockRate(spending.modelAssets) - (ENTERED + 0.01)) < 1e-12, 'the solver runs the copy');
    assert.equal(spending.sim.returnShift, 0.01, 'the markets limit gets the shift');
    const markets = sent.filter((j) => !j.kind);
    assert.ok(markets.length >= 2, 'the market checks ran');
    for (const job of markets) {
        assert.equal(job.returnShift, 0.01, 'each market check gets the shift');
        assert.ok(Math.abs(stockRate(job.modelAssets) - (ENTERED + 0.01)) < 1e-12, 'each check runs the copy');
    }
    for (const job of sent.filter((j) => j.kind === 'guardrails')) {
        assert.ok(Math.abs(stockRate(job.modelAssets) - (ENTERED + 0.01)) < 1e-12, 'the guardrails check runs the copy');
    }
});

await check('Moderate sends the plan as entered and no shift', async () => {
    const { solved, jobs: sent } = await bench('moderate');
    assert.equal(solved.outlook, 'moderate');
    for (const job of sent) {
        assert.equal(stockRate(job.modelAssets), ENTERED);
        if (!job.kind) assert.equal(job.returnShift, 0);
        if (job.kind === 'spending') assert.equal(job.sim.returnShift, 0);
    }
});

await check('each outlook has its own cache: a second outlook measures its own checks', async () => {
    await bench('pessimistic');
    const again = await bench('pessimistic');
    assert.equal(again.jobs.filter((j) => !j.kind).length, 1, 'the same outlook reuses its entered check');
    const other = await bench('optimistic');
    assert.equal(other.jobs.filter((j) => !j.kind).length, 2, 'another outlook must not reuse it');
});

await check('a routing\'s checks run the copy with the shift', async () => {
    jobs.length = 0;
    await runRoutingChecks(outlookPlan(SOURCE, 'pessimistic'),
        { best: { factor: 1.05 }, lifeEvents: SOURCE.lifeEvents }, { check: () => {} });
    const markets = jobs.find((j) => !j.kind);
    assert.equal(markets.returnShift, -0.01);
    assert.ok(Math.abs(stockRate(markets.modelAssets) - (ENTERED - 0.01)) < 1e-12);
});

await check('the chart draws the copy (benchPlan of the plan under the outlook)', () => {
    assert.ok(Math.abs(stockRate(benchPlan(outlookPlan(SOURCE, 'optimistic')).modelAssets) - (ENTERED + 0.01)) < 1e-12);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
