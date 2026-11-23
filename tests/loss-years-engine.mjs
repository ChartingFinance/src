/**
 * loss-years-engine.mjs
 *
 * Spec 18 §4: loss years in the engine. SimConfig `returnSchedule` is a list
 * of { year, stocks, bonds }; in that calendar year every stock asset's rate
 * is `stocks`, and every bond account's price changes by `bonds` while its
 * interest keeps paying (js/return-schedule.js).
 *
 *   OWN PATH        a stock account with no money in or out ends a −30% year
 *                   at exactly 70% of its start, and grows at its own rate the
 *                   years around it; dividends keep paying. A 0% bond ends a
 *                   −10% year at exactly 90%. A Treasury keeps paying interest,
 *                   never negative, and its fall is booked as growth. A bank
 *                   account is untouched.
 *
 *   EDGES           a plan that starts on a scheduled January has it from its
 *                   first month; a 100% year empties stocks without a NaN;
 *                   with a backtest the scheduled year still runs the figure;
 *                   the live assets get their own rates back after a run.
 *
 *   MARKETS         in every simulated market the scheduled year scales a
 *                   stock-only plan by exactly 0.70 and a 0% bond plan by
 *                   exactly 0.90, in both data modes and under an outlook.
 *
 *   CONFIG          makeSimConfig refuses a malformed schedule, and an absent
 *                   or empty one runs exactly as before.
 *
 * Run: node tests/loss-years-engine.mjs   (from src/)
 */

import assert from 'node:assert/strict';

import './tools/localstorage-polyfill.js';
import { ModelAsset } from '../js/model-asset.js';
import { Portfolio } from '../js/portfolio.js';
import { Metric } from '../js/metric.js';
import { EventType } from '../js/sim-event.js';
import { chronometer_run } from '../js/chronometer.js';
import { computeMonteCarlo } from '../js/mc-compute.js';
import { makeSimConfig, withSimConfig } from '../js/sim-config.js';
import {
    global_reset, global_setUserStartAge, global_setUserRetirementAge,
    setActiveTaxTable, makeActiveTaxTable, simConfigFromGlobals,
} from '../js/globals.js';
import { DateInt } from '../js/utils/date-int.js';

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); failed++; }
}

global_reset();
global_setUserStartAge(70);
global_setUserRetirementAge(70);
setActiveTaxTable(makeActiveTaxTable());
const BASE = simConfigFromGlobals();
const schedule = (returnSchedule, extra = {}) => withSimConfig(BASE, { returnSchedule, ...extra });

const START = { year: 2026, month: 1 };
const END = { year: 2030, month: 12 };
const A = (x) => ({ startDateInt: START, finishDateInt: END, ...x });
const money = (amount) => ({ startCurrency: { amount }, startBasisCurrency: { amount } });

/** Every kind of account a loss year touches or must not touch. */
function mixedPlan() {
    return [
        A({ instrument: 'taxableEquity', displayName: 'Brokerage', annualReturnRate: { rate: 0.07 }, ...money(1_000_000) }),
        A({ instrument: 'taxableEquity', displayName: 'Dividends', annualReturnRate: { rate: 0.05 },
            annualDividendRate: { rate: 0.02 }, ...money(100_000) }),
        A({ instrument: 'corpBond', displayName: 'Flat Bond', annualReturnRate: { rate: 0 }, ...money(200_000) }),
        A({ instrument: 'usBond', displayName: 'Treasuries', annualReturnRate: { rate: 0.04 }, ...money(200_000) }),
        A({ instrument: 'bank', displayName: 'Bank', annualReturnRate: { rate: 0.02 }, ...money(500_000) }),
    ];
}

function runOwn(plain, config) {
    const assets = plain.map((a) => ModelAsset.fromJSON(a));
    const portfolio = new Portfolio(assets, false, config);
    chronometer_run(portfolio);
    return portfolio;
}

const asset = (pf, name) => pf.modelAssets.find((a) => a.displayName === name);
/** An asset's value at the end of a month, by its place from the plan's first month. */
const valueAt = (a, year, month) => a.getHistory(Metric.VALUE)[(year - START.year) * 12 + (month - 1)];
const endOf = (a, year) => valueAt(a, year, 12);
const close = (actual, expected, label, tol = 1e-9) =>
    assert.ok(Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected)),
        `${label}: ${actual} is not ${expected}`);
const eventsIn = (a, type, year) => a.events.filter((e) => e.type === type && e.dateInt.year === year);
const sum = (events) => events.reduce((s, e) => s + e.amount.amount, 0);

const LOSS_2027 = [{ year: 2027, stocks: -0.30, bonds: -0.10 }];

console.log('\n── the plan\'s own path ──\n');

const plain = runOwn(mixedPlan(), BASE);
const lossy = runOwn(mixedPlan(), schedule(LOSS_2027));

await test('a no-flow, no-dividend stock account ends a −30% year at exactly 70% of its start', () => {
    const b = asset(lossy, 'Brokerage');
    close(endOf(b, 2027) / endOf(b, 2026), 0.70, 'Brokerage 2027');
});

await test('the years around it grow at the account\'s own rate', () => {
    const b = asset(lossy, 'Brokerage');
    close(endOf(b, 2026) / 1_000_000, 1.07, 'Brokerage 2026');
    close(endOf(b, 2028) / endOf(b, 2027), 1.07, 'Brokerage 2028');
});

await test('dividends keep paying: an account with a dividend rate falls a little less', () => {
    const d = asset(lossy, 'Dividends');
    const ratio = endOf(d, 2027) / endOf(d, 2026);
    assert.ok(ratio > 0.70 && ratio < 0.70 * 1.03, `Dividends 2027 ratio ${ratio}`);
    assert.ok(sum(eventsIn(d, EventType.DIVIDEND, 2027)) > 0, 'no dividends in the loss year');
});

await test('a 0% bond ends a −10% year at exactly 90%, and the next year flat', () => {
    const f = asset(lossy, 'Flat Bond');
    close(endOf(f, 2027) / endOf(f, 2026), 0.90, 'Flat Bond 2027');
    close(endOf(f, 2028) / endOf(f, 2027), 1, 'Flat Bond 2028');
    close(endOf(f, 2026) / 200_000, 1, 'Flat Bond 2026');
});

await test('a Treasury keeps paying interest, never negative, and its fall is booked as growth', () => {
    const t = asset(lossy, 'Treasuries');
    const interest = eventsIn(t, EventType.INTEREST_INCOME, 2027);
    assert.ok(interest.length >= 12, `${interest.length} interest events in 2027`);
    assert.ok(interest.every((e) => e.amount.amount >= 0), 'a negative interest event');
    assert.ok(sum(interest) > 0, 'no interest in the loss year');
    assert.ok(sum(eventsIn(t, EventType.ASSET_GROWTH, 2027)) < 0, 'the fall was not booked as growth');
    assert.equal(eventsIn(t, EventType.ASSET_GROWTH, 2028).filter((e) => e.amount.amount !== 0).length, 0,
        'the fall carried into 2028');
    const ratio = endOf(t, 2027) / endOf(t, 2026);
    assert.ok(ratio > 0.90 && ratio < 0.95, `Treasuries 2027 ratio ${ratio}`);
});

await test('the month\'s package counts the bond\'s fall as asset appreciation, not interest', () => {
    const pf = runOwn([A({ instrument: 'corpBond', displayName: 'Flat Bond', annualReturnRate: { rate: 0 }, ...money(200_000) })],
        schedule(LOSS_2027));
    const months2027 = pf.monthlyPackages.slice(12, 24);
    const appreciation = months2027.reduce((s, p) => s + p.assetAppreciation.amount, 0);
    const interest = months2027.reduce((s, p) => s + p.interestIncome.amount, 0);
    close(appreciation, -20_000, 'the packages\' 2027 asset appreciation', 1e-6);
    close(interest, 0, 'the packages\' 2027 interest', 1e-9);
});

await test('no income account ever books negative interest', () => {
    for (const a of lossy.modelAssets) {
        const negative = a.events.filter((e) => e.type === EventType.INTEREST_INCOME && e.amount.amount < 0);
        assert.equal(negative.length, 0, `${a.displayName} booked negative interest`);
    }
});

await test('a bank account is untouched: no growth, no price change', () => {
    const bank = asset(lossy, 'Bank');
    assert.equal(bank.events.filter((e) => e.type === EventType.ASSET_GROWTH && e.amount.amount !== 0).length, 0,
        'the bank booked growth');
});

await test('the scheduled year changes only that year: 2026 is the same as without a schedule', () => {
    for (const name of ['Brokerage', 'Dividends', 'Flat Bond', 'Treasuries']) {
        close(endOf(asset(lossy, name), 2026), endOf(asset(plain, name), 2026), `${name} 2026`);
    }
});

console.log('\n── edges ──\n');

await test('absent, null and empty schedules run exactly as before', () => {
    const histories = (pf) => JSON.stringify(pf.modelAssets.map((a) => a.getHistory(Metric.VALUE)));
    const expected = histories(plain);
    assert.equal(histories(runOwn(mixedPlan(), schedule(null))), expected, 'null');
    assert.equal(histories(runOwn(mixedPlan(), schedule([]))), expected, 'empty');
});

await test('a plan that starts on a scheduled January has the loss from its first month', () => {
    const pf = runOwn(mixedPlan(), schedule([{ year: 2026, stocks: -0.30, bonds: -0.10 }]));
    close(endOf(asset(pf, 'Brokerage'), 2026) / 1_000_000, 0.70, 'Brokerage 2026');
    close(endOf(asset(pf, 'Flat Bond'), 2026) / 200_000, 0.90, 'Flat Bond 2026');
});

await test('a 100% year empties stocks and bonds in its first month, with no NaN anywhere', () => {
    const pf = runOwn(mixedPlan(), schedule([{ year: 2027, stocks: -1, bonds: -1 }]));
    close(valueAt(asset(pf, 'Brokerage'), 2027, 1), 0, 'Brokerage Jan 2027', 1e-6);
    close(valueAt(asset(pf, 'Flat Bond'), 2027, 1), 0, 'Flat Bond Jan 2027', 1e-6);
    for (const a of pf.modelAssets) {
        assert.ok(a.getHistory(Metric.VALUE).every(Number.isFinite), `${a.displayName} has a non-finite value`);
    }
});

await test('with a backtest the scheduled year still runs the figure', () => {
    const pf = runOwn(mixedPlan(), schedule(LOSS_2027, { backtestYear: '2000' }));
    const b = asset(pf, 'Brokerage');
    close(endOf(b, 2027) / endOf(b, 2026), 0.70, 'Brokerage 2027 under a backtest');
});

await test('the live assets get their own rates back after a run', () => {
    const assets = mixedPlan().map((a) => ModelAsset.fromJSON(a));
    const pf = new Portfolio(assets, false, schedule([{ year: 2030, stocks: -0.30, bonds: -0.10 }]));
    chronometer_run(pf);
    assert.equal(asset(pf, 'Brokerage').annualReturnRate.rate, 0.07);
    assert.equal(asset(pf, 'Flat Bond').annualPriceChange, 0);
});

console.log('\n── the simulated markets ──\n');

const markets = (plainAssets, config, opts = {}) => computeMonteCarlo(plainAssets.map((a) => ModelAsset.fromJSON(a)), {
    config, numSimulations: 30, seed: 3, dataMode: 'historical', retirementDateInt: DateInt.from(2026, 1),
    lifeEvents: [], ...opts,
});
const bandRatios = (mc, from, to) => {
    const i = mc.labels.indexOf(from), j = mc.labels.indexOf(to);
    assert.ok(i >= 0 && j >= 0, `no ${from} or ${to}`);
    return mc.bandData.map((band) => band[j] / band[i]);
};
const STOCKS = [A({ instrument: 'taxableEquity', displayName: 'Brokerage', annualReturnRate: { rate: 0.07 }, ...money(1_000_000) })];
const BOND = [A({ instrument: 'corpBond', displayName: 'Flat Bond', annualReturnRate: { rate: 0 }, ...money(1_000_000) })];

for (const [label, opts] of [
    ['historical', {}],
    ['calibrated', { dataMode: 'calibrated' }],
    ['historical, under Optimistic\'s shift', { returnShift: 0.01 }],
]) {
    await test(`${label}: every market scales a stock-only plan by exactly 0.70 in the scheduled year`, async () => {
        const mc = await markets(STOCKS, schedule(LOSS_2027), opts);
        for (const r of bandRatios(mc, 'Dec 2026', 'Dec 2027')) close(r, 0.70, 'band ratio', 1e-7);
    });
}

await test('the markets\' baseline run, the plan\'s own path, has the loss year too', async () => {
    const mc = await markets(STOCKS, schedule(LOSS_2027));
    const i = mc.labels.indexOf('Dec 2026'), j = mc.labels.indexOf('Dec 2027');
    close(mc.baselineData[j] / mc.baselineData[i], 0.70, 'baseline 2027', 1e-7);
});

await test('control: without a schedule the markets do not all fall 30%', async () => {
    const mc = await markets(STOCKS, BASE);
    assert.ok(bandRatios(mc, 'Dec 2026', 'Dec 2027').some((r) => Math.abs(r - 0.70) > 0.01));
});

await test('every market scales a 0% bond plan by exactly 0.90, and the next year not at all', async () => {
    const mc = await markets(BOND, schedule(LOSS_2027));
    for (const r of bandRatios(mc, 'Dec 2026', 'Dec 2027')) close(r, 0.90, 'band ratio 2027', 1e-7);
    for (const r of bandRatios(mc, 'Dec 2027', 'Dec 2028')) close(r, 1, 'band ratio 2028', 1e-7);
});

console.log('\n── the config ──\n');

await test('makeSimConfig keeps a schedule frozen, with a missing bond figure as 0', () => {
    const c = schedule([{ year: 2027, stocks: -0.3 }]);
    assert.deepEqual(c.returnSchedule, [{ year: 2027, stocks: -0.3, bonds: 0 }]);
    assert.ok(Object.isFrozen(c.returnSchedule) && Object.isFrozen(c.returnSchedule[0]));
    assert.equal(BASE.returnSchedule, null);
    assert.equal(schedule([]).returnSchedule, null);
});

await test('makeSimConfig refuses a malformed schedule', () => {
    const bad = [
        [{ year: 2027, stocks: -1.01 }],
        [{ year: 2027, stocks: NaN }],
        [{ year: 2027, stocks: -0.3, bonds: -2 }],
        [{ year: 2027.5, stocks: -0.3 }],
        [{ year: 2027, stocks: -0.3 }, { year: 2027, stocks: -0.2 }],
        [{ year: 2027, stocks: -0.3, cash: -0.1 }],
        [{ year: 2027 }],
        { year: 2027, stocks: -0.3 },
    ];
    for (const returnSchedule of bad) {
        assert.throws(() => makeSimConfig({ ...BASE, returnSchedule }), /returnSchedule/, JSON.stringify(returnSchedule));
    }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
