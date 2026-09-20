/**
 * close-before-first-month.mjs
 *
 * An asset can be closed in the plan's very first month, before it has ever
 * been handed a month to live through. `ModelAsset.close()` zeroes
 * `firstDayOfMonthValue`, and that field was assigned in exactly one place —
 * the tail of `applyFirstDayOfMonth`. Close first, and it is `undefined`:
 * `undefined.zero()` took the whole run down with a TypeError.
 *
 * ── The two reachable paths ──────────────────────────────────────────
 *
 * Portfolio.applyFirstDayOfMonth closes past-finish assets and paid-off
 * mortgages in its first two loops, BEFORE the per-asset applyFirstDayOfMonth
 * loop. And applyLifeEvents runs before applyMonth entirely. So:
 *
 *   1. a mortgage entered with `monthsRemaining: 0` — nothing left to pay, so
 *      the paid-off loop closes it on day one
 *   2. a life event triggered at the plan's start age that `closes:` an asset —
 *      "sell the house now", the most ordinary thing a user can ask for
 *
 * Neither is exotic input. Both killed the run.
 *
 * ── What keeps these assertions from being vacuous ───────────────────
 *
 * "the run completes" alone would pass on an engine that quietly stopped
 * closing anything, so each case also asserts the close actually HAPPENED.
 *
 * The last test guards the fix itself rather than the bug. Initializing
 * `firstDayOfMonthValue` to zero means that deleting its real assignment in
 * applyFirstDayOfMonth would no longer throw — it would silently read zero
 * forever, which is this project's signature failure shape. So a live asset's
 * field is asserted to carry the month's opening value, not the initializer.
 *
 * Run: node tests/close-before-first-month.mjs   (from src/)
 */

// ── Pin the clock BEFORE quick-start.js is imported ──────────────────
// Life-event trigger dates are age-relative and the plan is anchored to the
// wall clock; an unpinned fixture is a different test every month.
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
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

import assert from 'node:assert/strict';

import { ModelAsset } from '../js/model-asset.js';
import { ModelLifeEvent } from '../js/life-event.js';
import { Portfolio } from '../js/portfolio.js';
import { chronometer_run } from '../js/chronometer.js';
import { simConfigFromGlobals, global_setUserStartAge, global_reset } from '../js/globals.js';

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); failed++; }
}

const START = { year: 2026, month: 1 };
const DEC = { year: 2030, month: 12 };

/** Every plan here needs somewhere for money to come from and go to. */
const checking = () => ({
    instrument: 'bank', displayName: 'Checking',
    startDateInt: START, finishDateInt: DEC,
    annualReturnRate: { rate: 0 },
    startCurrency: { amount: 50000 }, startBasisCurrency: { amount: 50000 },
});

const byName = (portfolio, name) =>
    portfolio.modelAssets.find((a) => a.displayName === name);

/** Build and run, returning the portfolio or the error that stopped it. */
async function attempt(assets, lifeEvents) {
    const portfolio = new Portfolio(assets.map(ModelAsset.fromJSON), false,
        simConfigFromGlobals());
    if (lifeEvents) portfolio.lifeEvents = lifeEvents;
    try {
        await chronometer_run(portfolio);
        return { portfolio, error: null };
    } catch (error) {
        return { portfolio, error };
    }
}

// ── 1. the paid-off mortgage ─────────────────────────────────────────

const paidOff = await attempt([
    checking(),
    {
        instrument: 'mortgage', displayName: 'Mortgage',
        startDateInt: START, finishDateInt: DEC,
        annualReturnRate: { rate: 0.065 }, monthsRemaining: 0,
        startCurrency: { amount: 0 }, startBasisCurrency: { amount: 0 },
    },
]);

test('a mortgage with monthsRemaining 0 does not take the run down', () => {
    assert.equal(paidOff.error, null,
        `run threw: ${paidOff.error?.message}`);
});

test('and it is closed for real, rather than skipped', () => {
    const mortgage = byName(paidOff.portfolio, 'Mortgage');
    assert.ok(mortgage, 'mortgage missing from the portfolio');
    assert.equal(mortgage.isClosed, true, 'mortgage was not closed');
});

// ── 2. a life event closing an asset in month one ────────────────────

global_reset();
global_setUserStartAge(50);

const soldAtOnce = await attempt([
    checking(),
    {
        instrument: 'realEstate', displayName: 'Home', isPrimaryHome: true,
        startDateInt: START, finishDateInt: DEC,
        annualReturnRate: { rate: 0.03 },
        startCurrency: { amount: 500000 }, startBasisCurrency: { amount: 300000 },
    },
], [new ModelLifeEvent({
    type: 'sellHome', displayName: 'Sell the house', triggerAge: 50,
    closes: ['Home'],
})]);

test('a life event may close an asset in the plan\'s first month', () => {
    assert.equal(soldAtOnce.error, null,
        `run threw: ${soldAtOnce.error?.message}`);
});

test('and that close happens, rather than being skipped', () => {
    const home = byName(soldAtOnce.portfolio, 'Home');
    assert.ok(home, 'home missing from the portfolio');
    assert.equal(home.isClosed, true, 'home was not closed');
});

// ── 3. the initializer must not stand in for the real assignment ─────

test('a live asset carries the month\'s opening value, not the initializer', () => {
    // Checking has a zero return rate and no transfers, so its opening value
    // every month is its balance. If applyFirstDayOfMonth stopped assigning
    // firstDayOfMonthValue, the zero initializer would make this read 0 — and
    // nothing else in the suite would notice.
    const cash = byName(paidOff.portfolio, 'Checking');
    assert.ok(cash, 'checking missing from the portfolio');
    assert.ok(cash.firstDayOfMonthValue, 'firstDayOfMonthValue was never set');
    assert.equal(cash.firstDayOfMonthValue.amount, cash.finishCurrency.amount,
        'opening value does not match the balance of an asset with no flows');
    assert.notEqual(cash.firstDayOfMonthValue.amount, 0,
        'opening value is zero — the initializer, not the month');
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
