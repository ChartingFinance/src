/**
 * mc-worker-sanity.mjs — exercises the exact rehydration + compute path the
 * simulation worker runs (Monte Carlo and Guardrails), without a Worker
 * context (isWorker guard is false).
 */
import assert from 'node:assert/strict';

const store = {};
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

import { ModelAsset } from '../js/model-asset.js';
import { TaxTable } from '../js/taxes.js';
import { setActiveTaxTable } from '../js/globals.js';
import { DateInt } from '../js/utils/date-int.js';
import { computeMonteCarlo } from '../js/mc-compute.js';
import { computeGuardrails } from '../js/gr-compute.js';
import '../js/mc-worker.js'; // must import cleanly outside a Worker

const QUICK_START_DATA = [
    {
        instrument: 'workingIncome',
        displayName: 'Salary',
        startDateInt: { year: 2026, month: 1 },
        finishDateInt: { year: 2036, month: 12 },
        startCurrency: { amount: 6000 },
        startBasisCurrency: { amount: 0 },
        annualReturnRate: { rate: 0.025 },
        fundTransfers: [
            { toDisplayName: '401K', monthlyMoveValue: 10, closeMoveValue: 0 },
            { toDisplayName: 'Roth IRA', monthlyMoveValue: 5, closeMoveValue: 0 },
            { toDisplayName: 'Brokerage', monthlyMoveValue: 85, closeMoveValue: 0 },
        ],
    },
    {
        instrument: '401K',
        displayName: '401K',
        startDateInt: { year: 2026, month: 1 },
        finishDateInt: { year: 2036, month: 12 },
        startCurrency: { amount: 50000 },
        startBasisCurrency: { amount: 50000 },
        annualReturnRate: { rate: 0.09 },
    },
    {
        instrument: 'rothIRA',
        displayName: 'Roth IRA',
        startDateInt: { year: 2026, month: 1 },
        finishDateInt: { year: 2036, month: 12 },
        startCurrency: { amount: 25000 },
        startBasisCurrency: { amount: 20000 },
        annualReturnRate: { rate: 0.09 },
    },
    {
        instrument: 'taxableEquity',
        displayName: 'Brokerage',
        startDateInt: { year: 2026, month: 1 },
        finishDateInt: { year: 2036, month: 12 },
        startCurrency: { amount: 30000 },
        startBasisCurrency: { amount: 25000 },
        annualReturnRate: { rate: 0.09 },
    },
    {
        instrument: 'realEstate',
        displayName: 'Home',
        startDateInt: { year: 2026, month: 1 },
        finishDateInt: { year: 2036, month: 12 },
        startCurrency: { amount: 400000 },
        startBasisCurrency: { amount: 400000 },
        annualReturnRate: { rate: 0.03 },
        annualTaxRate: { rate: 0.012 },
    },
    {
        instrument: 'mortgage',
        displayName: 'Mortgage',
        startDateInt: { year: 2026, month: 1 },
        finishDateInt: { year: 2036, month: 12 },
        startCurrency: { amount: 320000 },
        startBasisCurrency: { amount: 0 },
        annualReturnRate: { rate: 0.065 },
        monthsRemaining: 360,
        fundTransfers: [
            { toDisplayName: 'Brokerage', monthlyMoveValue: 100, closeMoveValue: 0 },
        ],
    },
    {
        instrument: 'monthlyExpense',
        displayName: 'Living Expenses',
        startDateInt: { year: 2026, month: 1 },
        finishDateInt: { year: 2036, month: 12 },
        startCurrency: { amount: 3000 },
        startBasisCurrency: { amount: 0 },
        annualReturnRate: { rate: 0.03 },
        fundTransfers: [
            { toDisplayName: 'Brokerage', monthlyMoveValue: 100, closeMoveValue: 0 },
        ],
    },
];

// Worker-style rehydration: through JSON, then fromJSON
setActiveTaxTable(new TaxTable());
const serialized = JSON.parse(JSON.stringify(QUICK_START_DATA));
const assets = serialized.map(o => ModelAsset.fromJSON(o));

const t0 = Date.now();
const interims = [];
const checkpoints = [];
const results = await computeMonteCarlo(assets, {
    numSimulations: 100,
    retirementDateInt: new DateInt(DateInt.from(2036, 12).toInt()),
    onProgress: (c, t) => process.stdout.write(`  progress ${c}/${t}\n`),
    interimEvery: 40,
    onInterim: (r) => { interims.push(r); },
    checkpoint: async (c) => { checkpoints.push(c); },
});
const elapsed = Date.now() - t0;

// Checkpoints: every PROGRESS_EVERY (50) sims, excluding the final increment
assert.deepEqual(checkpoints, [50], 'checkpoint awaited at batch boundary, not at final');

// Interim snapshots: every interimEvery sims, excluding the final increment
assert.equal(interims.length, 2, 'two interim snapshots (at 40 and 80, not 100)');
assert.deepEqual(interims.map(r => r.completed), [40, 80], 'interim completed counts');
for (const interim of interims) {
    assert.equal(interim.numSimulations, 100, 'interim carries target total');
    assert.equal(interim.bandData.length, 5, 'interim has 5 bands');
    assert.equal(interim.bandData[0].length, interim.labels.length, 'interim band length matches labels');
    assert.equal(interim.baselineData.length, interim.labels.length, 'interim baseline matches labels');
    assert.ok(interim.successRate >= 0 && interim.successRate <= 1, 'interim successRate in [0,1]');
    for (let b = 1; b < 5; b++) {
        const last = interim.labels.length - 1;
        assert.ok(interim.bandData[b][last] >= interim.bandData[b-1][last] - 1e-6,
            `interim percentiles ordered at final month (band ${b})`);
    }
    assert.ok(JSON.stringify(interim), 'interim is JSON-serializable');
}

assert.ok(results, 'results returned');
assert.equal(results.completed, 100, 'final completed count equals total');
assert.equal(results.bands.length, 5);
assert.equal(results.bandData.length, 5);
assert.ok(results.labels.length > 100, 'labels span many months');
assert.equal(results.bandData[0].length, results.labels.length, 'band length matches labels');
assert.equal(results.baselineData.length, results.labels.length, 'baseline matches labels');
assert.ok(results.successRate >= 0 && results.successRate <= 1, 'successRate in [0,1]');
for (let b = 1; b < 5; b++) {
    const last = results.labels.length - 1;
    assert.ok(results.bandData[b][last] >= results.bandData[b-1][last] - 1e-6,
        `percentiles ordered at final month (band ${b})`);
}
assert.ok(Number.isInteger(results.startDateInt), 'startDateInt serialized as int');
assert.ok(JSON.stringify(results), 'results are JSON-serializable');

// ── Guardrails: same rehydrated assets through the worker's other path ──

const grT0 = Date.now();
const grResults = await computeGuardrails(assets, {
    params: { withdrawalRate: 4, preservation: 20, prosperity: 20, adjustment: 10 },
    retirementDateInt: new DateInt(DateInt.from(2030, 1).toInt()),
    lifeEvents: [],
});
const grElapsed = Date.now() - grT0;

assert.ok(grResults, 'guardrails results returned');
assert.equal(grResults.portfolioValues.length, grResults.labels.length, 'guardrails values match labels');
assert.equal(grResults.withdrawalSteps.length, grResults.labels.length, 'guardrails steps match labels');
assert.ok(Array.isArray(grResults.events), 'guardrails events is an array');
assert.equal(grResults.params.withdrawalRate, 4, 'guardrails params echoed');
assert.ok(Number.isInteger(grResults.retirementDateInt), 'guardrails retirementDateInt serialized as int');
assert.ok(grResults.retirementMonthIndex === null || Number.isInteger(grResults.retirementMonthIndex),
    'guardrails retirementMonthIndex is null or int');
assert.ok(JSON.stringify(grResults), 'guardrails results are JSON-serializable');

// ── MC + guardrails: adjustments must be gated on retirement ────
//
// The baseline run is deterministic, and portfolio.applyGuardrails skips
// years before guardrailsParams.retirementDateInt — so a guardrailed
// baseline must match a plain baseline exactly for every pre-retirement
// month. If the retirement gate is dropped (the bug this locks against),
// the preservation cut fires from year one and the series diverge early.

const retirement = DateInt.from(2030, 1);   // sims span 2026-01 … 2036-12
const mcPlain = await computeMonteCarlo(assets, {
    numSimulations: 5,
    retirementDateInt: new DateInt(retirement.toInt()),
});
const mcGuarded = await computeMonteCarlo(assets, {
    numSimulations: 5,
    guardrailParams: { withdrawalRate: 4, preservation: 20, prosperity: 20, adjustment: 10 },
    retirementDateInt: new DateInt(retirement.toInt()),
});

assert.ok(mcGuarded.withGuardrails, 'guardrailed MC flags withGuardrails');
const retirementIdx = mcPlain.labels.indexOf('Jan 2030');
assert.ok(retirementIdx > 0, 'retirement month found in labels');
for (let m = 0; m < retirementIdx; m++) {
    assert.ok(Math.abs(mcGuarded.baselineData[m] - mcPlain.baselineData[m]) < 0.01,
        `guardrailed baseline matches plain baseline pre-retirement (month ${m}: ` +
        `${mcGuarded.baselineData[m]} vs ${mcPlain.baselineData[m]})`);
}

console.log(`mc-worker-sanity OK — 100 sims in ${elapsed}ms, ` +
    `successRate=${results.successRate}, months=${results.labels.length}; ` +
    `guardrails in ${grElapsed}ms, events=${grResults.events.length}; ` +
    `MC guardrail gate verified over ${retirementIdx} pre-retirement months`);
