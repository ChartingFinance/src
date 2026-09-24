/**
 * mc-calibration-base.mjs
 *
 * Calibrated Monte Carlo re-centres each year's historical deviation on the
 * rate an asset grows at in the plan. For an expense left at the DEFAULT rate
 * that rate is the plan's inflation — the asset stores 0, and
 * `effectiveAnnualReturnRate` reads 0 as "use plan inflation".
 *
 * The bug guarded: capturing the base from the raw `annualReturnRate` (0) and
 * adding the year's CPI deviation writes back a small nonzero rate, so the
 * fallback never fires again and the expense grows by the deviation alone —
 * about 0% a year instead of 3.1% plus the deviation. On Mid Career that put
 * the calibrated median at 1.75x the plan.
 *
 * ── Why these assertions and not a zero-deviation check ─────────────
 *
 * "Zero deviation reproduces the plan" is the natural sanity test for a
 * calibration, and it is BLIND to this bug: at zero the written rate is 0
 * again and the fallback still works. Every check below uses real, nonzero
 * historical draws.
 *
 *   THE BASE         calibrationBaseRates gives an expense at the default rate
 *                    the plan's inflation, and leaves explicit rates alone.
 *
 *   THE OUTCOME      a plan whose ending depends ONLY on how its expense
 *                    inflates — a bank earning nothing, one expense at the
 *                    default rate — must end, at the median, where the plan
 *                    does.
 *
 * Run: node tests/mc-calibration-base.mjs   (from src/)
 */

const RealDate = Date;
const PINNED = new RealDate(2026, 0, 15);
globalThis.Date = class extends RealDate {
    constructor(...args) {
        if (args.length === 0) super(PINNED.getTime());
        else super(...args);
    }
    static now() { return PINNED.getTime(); }
};

const store = {};
globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

import assert from 'node:assert/strict';

const G = await import('../js/globals.js');
const { Portfolio } = await import('../js/portfolio.js');
const { ModelAsset } = await import('../js/model-asset.js');
const { chronometer_run } = await import('../js/chronometer.js');
const { computeMonteCarlo, calibrationBaseRates } = await import('../js/mc-compute.js');
const { Metric } = await import('../js/metric.js');

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); failed++; }
}

/** A deterministic stand-in for Math.random, so the draws are the same every run. */
function seeded(seed) {
    return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

const START = { year: 2026, month: 1 }, END = { year: 2045, month: 12 };
const A = (x) => ({ startDateInt: START, finishDateInt: END, ...x });

function plainPlan() {
    return [
        // Earns nothing and is never randomised: the ending depends only on
        // how much the expense has drawn.
        A({ instrument: 'bank', displayName: 'Checking', annualReturnRate: { rate: 0 },
            startCurrency: { amount: 2_000_000 }, startBasisCurrency: { amount: 2_000_000 } }),
        // No annualReturnRate: the DEFAULT, which means "grow with plan inflation".
        A({ instrument: 'monthlyExpense', displayName: 'Living',
            startCurrency: { amount: -3000 }, startBasisCurrency: { amount: 0 },
            fundTransfers: [{ toDisplayName: 'Checking', monthlyMoveValue: 100, closeMoveValue: 0 }] }),
    ].map(ModelAsset.fromJSON);
}

G.global_reset();
G.global_setUserStartAge(50);
G.global_setUserRetirementAge(65);
G.setActiveTaxTable(G.makeActiveTaxTable());
const config = G.simConfigFromGlobals();

// ── the base ─────────────────────────────────────────────────────────

console.log('\n── What a calibrated draw is centred on ──\n');

await test('an expense at the default rate is centred on the plan\'s inflation', () => {
    const p = new Portfolio(plainPlan(), false, config);
    const living = p.modelAssets.find((a) => a.displayName === 'Living');
    assert.equal(living.annualReturnRate.rate, 0, 'precondition: the stored rate is the 0 sentinel');
    assert.equal(calibrationBaseRates(p.modelAssets).get(living), p.config.inflationRate);
});

await test('explicit rates are taken as they are', () => {
    const assets = [
        A({ instrument: 'taxableEquity', displayName: 'Brokerage', annualReturnRate: { rate: 0.085 },
            startCurrency: { amount: 1000 }, startBasisCurrency: { amount: 1000 } }),
        A({ instrument: 'monthlyExpense', displayName: 'Rent', annualReturnRate: { rate: 0.04 },
            startCurrency: { amount: -1000 }, startBasisCurrency: { amount: 0 } }),
    ].map(ModelAsset.fromJSON);
    const p = new Portfolio(assets, false, config);
    const bases = calibrationBaseRates(p.modelAssets);
    assert.equal(bases.get(p.modelAssets.find((a) => a.displayName === 'Brokerage')), 0.085);
    assert.equal(bases.get(p.modelAssets.find((a) => a.displayName === 'Rent')), 0.04);
});

// ── the outcome ──────────────────────────────────────────────────────

console.log('\n── With real draws, the median ends where the plan does ──\n');

const plan = new Portfolio(plainPlan(), false, config);
await chronometer_run(plan);
const planEnd = plan.modelAssets.reduce((s, a) => s + (a.getHistory(Metric.VALUE).at(-1) ?? 0), 0);

const realRandom = Math.random;
Math.random = seeded(20260923);
const mc = await computeMonteCarlo(plainPlan(), {
    config, numSimulations: 300, dataMode: 'calibrated',
    // No retirement date: randomise from the first year.
    retirementDateInt: null, lifeEvents: [],
});
Math.random = realRandom;
const last = mc.labels.length - 1;
const median = mc.bandData[2][last];
const ratio = median / planEnd;
console.log(`       plan ends $${Math.round(planEnd).toLocaleString('en-US')}, calibrated median $${Math.round(median).toLocaleString('en-US')} (${ratio.toFixed(3)}x)`);

await test('an inflation-only plan: calibrated median within 3% of the plan', () => {
    // Before the fix this plan's expense stopped inflating in every run, so
    // every run spent less than the plan and ended richer.
    assert.ok(Math.abs(ratio - 1) < 0.03,
        `median is ${ratio.toFixed(3)}x the plan — the expense is not inflating around the plan's rate`);
});

await test('and the draws really were nonzero — the check is not the blind one', () => {
    // The bands must spread: a zero-deviation run would put p10 and p90 on
    // the median, and that is the case that could never see this bug.
    const spread = (mc.bandData[4][last] - mc.bandData[0][last]) / planEnd;
    assert.ok(spread > 0.05, `p10-p90 spread is only ${(spread * 100).toFixed(2)}% of the plan`);
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);
process.exit(failed > 0 ? 1 : 0);
