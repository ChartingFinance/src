/**
 * mc-first-year-draw.mjs
 *
 * The simulated markets draw a year's returns from the first January on or
 * after retirement. That January can be the plan's own first month: a plan
 * that starts in January already retired, or retiring that month.
 *
 * The draw used to happen only when the loop crossed into a new year, so the
 * plan's first month never got one. That plan's whole first year ran at its
 * entered rates in every market. Each December showed a $0 spread across the
 * markets, so a year of sequence risk was never tested.
 *
 *   JANUARY START          a plan that starts in January at or after its
 *                          retirement date draws its first year, and draws
 *                          exactly as a plan with no retirement date does.
 *
 *   MID-YEAR START         a plan that starts in November, already retired,
 *                          keeps those two months as entered and draws from
 *                          the next January.
 *
 *   BEFORE RETIREMENT      a plan that starts in January and retires two years
 *                          later keeps both years as entered.
 *
 * Run: node tests/mc-first-year-draw.mjs   (from src/)
 */

import assert from 'node:assert/strict';

import './tools/localstorage-polyfill.js';
import { ModelAsset } from '../js/model-asset.js';
import {
    global_reset, global_setUserStartAge, global_setUserRetirementAge,
    setActiveTaxTable, makeActiveTaxTable, simConfigFromGlobals,
} from '../js/globals.js';
import { computeMonteCarlo } from '../js/mc-compute.js';
import { DateInt } from '../js/utils/date-int.js';

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); failed++; }
}

const END = { year: 2030, month: 12 };

// One stock asset and one Treasury, both drawn, and nothing that spends.
function plan(start) {
    const A = (x) => ({ startDateInt: start, finishDateInt: END, ...x });
    return [
        A({ instrument: 'taxableEquity', displayName: 'Brokerage', annualReturnRate: { rate: 0.07 },
            startCurrency: { amount: 1_000_000 }, startBasisCurrency: { amount: 1_000_000 } }),
        A({ instrument: 'usBond', displayName: 'Treasuries', annualReturnRate: { rate: 0.04 },
            startCurrency: { amount: 200_000 }, startBasisCurrency: { amount: 200_000 } }),
    ].map(ModelAsset.fromJSON);
}

global_reset();
global_setUserStartAge(70);
global_setUserRetirementAge(70);
setActiveTaxTable(makeActiveTaxTable());
const config = simConfigFromGlobals();

const run = (start, retirementDateInt) => computeMonteCarlo(plan(start), {
    config, numSimulations: 40, seed: 1, dataMode: 'historical', retirementDateInt, lifeEvents: [],
});

/** P90 − P10 in a month, by its label ("Dec 2026"). */
function spread(mc, label) {
    const i = mc.labels.indexOf(label);
    assert.ok(i >= 0, `no month labelled ${label}`);
    return mc.bandData[4][i] - mc.bandData[0][i];
}

const JAN_2026 = { year: 2026, month: 1 };
const NOV_2026 = { year: 2026, month: 11 };

console.log('\n── a January start, at or after retirement ──\n');

const atStart = await run(JAN_2026, DateInt.from(2026, 1));
const before = await run(JAN_2026, DateInt.from(2020, 1));
const noDate = await run(JAN_2026, null);

await test('retiring in the plan\'s first month: the first year is drawn', () => {
    assert.ok(spread(atStart, 'Dec 2026') > 0,
        `Dec 2026 spreads $${spread(atStart, 'Dec 2026')} across the markets; the first year was not drawn`);
});

await test('retired before the plan starts: the first year is drawn', () => {
    assert.ok(spread(before, 'Dec 2026') > 0,
        `Dec 2026 spreads $${spread(before, 'Dec 2026')} across the markets; the first year was not drawn`);
});

// Compared as text: a failing deepEqual prints every band of every month.
const same = (a, b) => JSON.stringify(a.bandData) === JSON.stringify(b.bandData);

await test('both draw exactly as a plan with no retirement date', () => {
    assert.ok(same(atStart, noDate), 'retiring at the start does not draw as a plan with no retirement date');
    assert.ok(same(before, noDate), 'retired before the start does not draw as a plan with no retirement date');
});

console.log('\n── the controls ──\n');

await test('a November start, already retired, keeps November and December as entered', async () => {
    const mc = await run(NOV_2026, DateInt.from(2020, 1));
    assert.equal(spread(mc, 'Dec 2026'), 0, 'the partial first year was drawn');
    assert.ok(spread(mc, 'Dec 2027') > 0, 'the first full year was not drawn');
});

await test('a January start retiring two years later keeps both years as entered', async () => {
    const mc = await run(JAN_2026, DateInt.from(2028, 1));
    assert.equal(spread(mc, 'Dec 2026'), 0, '2026 was drawn before retirement');
    assert.equal(spread(mc, 'Dec 2027'), 0, '2027 was drawn before retirement');
    assert.ok(spread(mc, 'Dec 2028') > 0, 'the retirement year was not drawn');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
