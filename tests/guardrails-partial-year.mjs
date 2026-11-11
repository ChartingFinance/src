/**
 * guardrails-partial-year.mjs — a plan's first, partial year is not a low
 * withdrawal rate.
 *
 * The guardrails compare an ANNUAL spending rate with the rails. A plan that
 * starts in November has two months of spending in its first snapshot; divided
 * by the whole portfolio un-annualised, a 5.2% budget read as 0.87%, far under
 * the prosperity rail, and spending was raised 15% in the plan's first January.
 * Eleven starts in twelve are mid-year, so nearly every plan got the raise.
 *
 * The same household is run twice, from January and from November. Neither may
 * be adjusted for its first year, and the November plan's first recorded rate
 * must be the annual one.
 */

import assert from 'node:assert/strict';
import './tools/localstorage-polyfill.js';
import { ModelAsset } from '../js/model-asset.js';
import { Portfolio } from '../js/portfolio.js';
import { DateInt } from '../js/utils/date-int.js';
import { chronometer_run } from '../js/chronometer.js';
import {
    global_reset, global_setUserStartAge, global_setUserRetirementAge,
    setActiveTaxTable, makeActiveTaxTable, simConfigFromGlobals,
} from '../js/globals.js';
import { uniformLifetimeTable } from '../js/taxes.js';

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); failed++; }
}

// $52,000 a year against $1,000,000: 5.2%, inside rails of 4.25%–5.75%.
const PARAMS = { withdrawalRate: 5, preservation: 15, prosperity: 15, adjustment: 15 };

async function run(startMonth) {
    const START = { year: 2026, month: startMonth }, END = { year: 2031, month: 12 };
    const A = (x) => ({ startDateInt: START, finishDateInt: END, ...x });
    const assets = [
        A({ instrument: 'bank', displayName: 'Savings', annualReturnRate: { rate: 0.05 },
            startCurrency: { amount: 1_000_000 }, startBasisCurrency: { amount: 1_000_000 } }),
        A({ instrument: 'monthlyExpense', displayName: 'Living',
            startCurrency: { amount: -4333 }, startBasisCurrency: { amount: 0 },
            fundTransfers: [{ toDisplayName: 'Savings', monthlyMoveValue: 100, closeMoveValue: 0 }] }),
    ].map(ModelAsset.fromJSON);

    global_reset();
    global_setUserStartAge(65);
    global_setUserRetirementAge(65);
    setActiveTaxTable(makeActiveTaxTable());

    const portfolio = new Portfolio(assets, false, simConfigFromGlobals());
    portfolio.guardrailsParams = { ...PARAMS, retirementDateInt: DateInt.from(2026, startMonth) };
    await chronometer_run(portfolio);
    return portfolio;
}

await test('a January start: the first year is inside the rails', async () => {
    const p = await run(1);
    assert.equal(p.yearlySnapshots[0].months, 12);
    assert.ok(!p.guardrailEvents.some(e => e.year === 2026),
        `no adjustment for 2026; got ${JSON.stringify(p.guardrailEvents.filter(e => e.year === 2026))}`);
});

await test('a November start: two months are not a low rate', async () => {
    const p = await run(11);
    const first = p.yearlySnapshots[0];
    assert.equal(first.year, 2026);
    assert.equal(first.months, 2);
    assert.equal(first.partial, true);
    // The amount stays what was spent; the rate is annual.
    assert.ok(first.annualExpense < 9000, `two months of spending, got ${first.annualExpense}`);
    assert.ok(first.withdrawalRate > 0.0425 && first.withdrawalRate < 0.0575,
        `annualised rate inside the rails, got ${(first.withdrawalRate * 100).toFixed(2)}%`);
    assert.ok(!p.guardrailEvents.some(e => e.year === 2026),
        `no adjustment for 2026; got ${JSON.stringify(p.guardrailEvents.filter(e => e.year === 2026))}`);
});

await test('the Uniform Lifetime Table only ever falls', async () => {
    // IRS Pub. 590-B, table III. Age 113 read 2.1 between 3.3 and 3.0.
    for (let i = 1; i < uniformLifetimeTable.length; i++) {
        const prev = uniformLifetimeTable[i - 1], row = uniformLifetimeTable[i];
        assert.equal(row.age, prev.age + 1, `ages are consecutive at ${row.age}`);
        assert.ok(row.divisor < prev.divisor,
            `divisor at ${row.age} (${row.divisor}) is below the one at ${prev.age} (${prev.divisor})`);
    }
    assert.equal(uniformLifetimeTable.find(r => r.age === 113).divisor, 3.1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
