/**
 * spending-solver.mjs — "how much can this plan spend?"
 *
 * ── What this guards ─────────────────────────────────────────────────
 *
 * js/spending-solver.js turns one dial, a factor on every monthly expense, and
 * reports the highest setting at which the plan never runs out and leaves at
 * least a floor. Three things about it are load-bearing:
 *
 *   - its "as entered" column is the plan's own run, to the dollar;
 *   - its answer is a limit: the limits hold at it and fail just above it;
 *   - it takes the HIGHEST level that keeps the limits. The money left at the
 *     end does not always fall as spending rises (a surplus can sit idle in a
 *     checking account at lower spending), so halving an interval can stop
 *     below a level that passes. The retiree below is such a plan.
 *
 * ── The clock ───────────────────────────────────────────────────────
 *
 * Quick-start dates and build_plan's anchor come from the clock. Every plan
 * here is built under a pinned date; the runs themselves read no clock.
 *
 * Usage:  node tests/spending-solver.mjs   (from src/)
 */

import assert from 'node:assert/strict';
import './tools/localstorage-polyfill.js';
import { planFromProfile, listProfiles, runPlan, simConfigFromPlanSpec } from '../js/mcp/run-plan.js';
import { buildPlan } from '../js/mcp/build-plan.js';
import { solveSpending, runAt, scaledAssets, SCAN_LEVELS } from '../js/spending-solver.js';
import { Instrument } from '../js/instruments/instrument.js';
import { expenditureOverWindow } from '../js/annual-expenditure.js';

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
    listProfiles().map(({ key }) => ({ key, spec: planFromProfile(key) })));

/** A retiree whose lower spending leaves a surplus idle in Checking. */
const RETIREE = at('2026-10-15T12:00:00Z', () => buildPlan({
    settingsOverrides: { startAge: 60, retirementAge: 60, finishAge: 85 },
    income: [{ label: 'Pension', annual: 30000, kind: 'pension' }],
    accounts: [{ label: 'Checking', startingBalance: 30000 },
               { label: 'Brokerage', startingBalance: 900000 },
               { label: 'IRA', startingBalance: 600000, kind: 'ira' }],
    healthInsurance: [{ label: 'Marketplace Plan', premium: { monthly: 1000 },
        benchmark: { monthly: 950 }, estimatedIncome: 40000 }],
}).spec);

const keeps = (run, floor) => !run.runsOut && run.endingReal >= floor;
/** A factor `dollars` a month above `factor`, at the entered plan's spending. */
const above = (result, dollars) => result.best.factor + dollars / result.asEntered.monthlySpending;

const solved = new Map();
const solve = (key, spec, floor = 0) => {
    const id = `${key}:${floor}`;
    if (!solved.has(id)) solved.set(id, solveSpending(planOf(spec), { floor }));
    return solved.get(id);
};

console.log('spending-solver');

// ── The first column is the plan ─────────────────────────────────────

for (const { key, spec } of PROFILES) {
    await check(`${key}: "as entered" is the plan's own run`, async () => {
        const own = (await runPlan(spec)).portfolio.finishValue().amount;
        const r = solve(key, spec);
        assert.equal(Math.round(r.asEntered.endingNominal), Math.round(own));
        assert.equal(r.asEntered.factor, 1);
    });
}

await check("what is left is in today's dollars, by the run's own price index", () => {
    const { spec } = PROFILES.find((p) => p.key === 'retired');
    const run = runAt(planOf(spec), 1);
    const index = run.portfolio.monthlyPriceIndex;
    const level = index[index.length - 1];
    assert.ok(level > 1.5, `price level ${level} at the plan's end`);
    assert.ok(Math.abs(run.endingReal - run.endingNominal / level) < 0.01);
});

await check("spending is what was withdrawn to spend, month by month, in today's dollars", () => {
    // The same reading as annual-expenditure.js, one month at a time: tax is
    // not spending, and money moved between the household's accounts is not.
    const { spec } = PROFILES.find((p) => p.key === 'retired');
    const run = runAt(planOf(spec), 1);
    const index = run.portfolio.monthlyPriceIndex;
    let expected = 0, tax = 0;
    for (let m = 0; m < index.length; m++) {
        const w = expenditureOverWindow(run.portfolio, m, m);
        expected += w.spending / index[m];
        tax += w.tax;
    }
    assert.ok(tax > 10_000, 'this plan should draw tax, or the check proves nothing');
    assert.ok(Math.abs(run.lifetimeSpending - expected) < 1,
        `${Math.round(run.lifetimeSpending)} vs ${Math.round(expected)}`);
    assert.ok(Math.abs(run.monthlySpending - expected / index.length) < 0.01);
});

// ── The answer is a limit ────────────────────────────────────────────

for (const { key, spec } of PROFILES) {
    await check(`${key}: the limits hold at the answer and fail $20 a month above it`, () => {
        const entered = solve(key, spec).asEntered.endingReal;
        for (const floor of [0, Math.round(entered / 2)]) {
            const r = solve(key, spec, floor);
            assert.ok(r.best, `no level found at floor ${floor}`);
            assert.ok(keeps(r.best, floor), `the answer breaks its own limit at floor ${floor}`);
            const over = runAt(planOf(spec), above(r, 20));
            assert.ok(!keeps(over, floor),
                `$20 a month above the answer still keeps the limits at floor ${floor}`);
        }
    });
}

await check('a floor never raises the answer', () => {
    for (const { key, spec } of PROFILES) {
        const free = solve(key, spec);
        const half = solve(key, spec, Math.round(free.asEntered.endingReal / 2));
        assert.ok(half.best.factor <= free.best.factor + 1e-9, key);
    }
});

// ── The same answer every time ───────────────────────────────────────

await check('two solves of one plan give the same result', () => {
    const { spec } = PROFILES.find((p) => p.key === 'preRetirement');
    const a = solveSpending(planOf(spec), { floor: 250000 });
    const b = solveSpending(planOf(spec), { floor: 250000 });
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

await check('solving does not change the plan it was given', () => {
    const { spec } = PROFILES.find((p) => p.key === 'retired');
    const before = JSON.stringify(spec);
    solveSpending(planOf(spec));
    assert.equal(JSON.stringify(spec), before);
});

// ── What stops it ────────────────────────────────────────────────────

await check('Early Career, which runs out as entered, solves below what was entered', () => {
    const { spec } = PROFILES.find((p) => p.key === 'earlyCareer');
    const r = solve('earlyCareer', spec);
    assert.ok(r.asEntered.runsOut, 'the profile no longer runs out as entered');
    assert.equal(r.asEntered.runsOut.year, 2030);
    assert.equal(r.asEntered.runsOut.month, 7);
    assert.ok(r.best.factor < 1, `factor ${r.best.factor}`);
    assert.ok(!r.best.runsOut);
    assert.equal(r.boundBy.kind, 'runsOut');
});

await check('Mid Career is stopped by an empty brokerage with its retirement accounts untouched', () => {
    const { spec } = PROFILES.find((p) => p.key === 'midCareer');
    const r = solve('midCareer', spec);
    assert.equal(r.boundBy.kind, 'runsOut');
    assert.ok(r.best.factor > 1 && r.best.factor < 1.1, `factor ${r.best.factor}`);
    // Retirement accounts only: the home also holds value that month, and is
    // not money the plan could have spent.
    const names = r.boundBy.untouched.map((u) => u.displayName).sort();
    assert.deepEqual(names, ['401K', 'Roth IRA']);
    const held = r.boundBy.untouched.reduce((sum, u) => sum + u.amount, 0);
    assert.ok(held > 1_000_000, `only ${Math.round(held)} untouched`);
});

await check('a floor above what any level leaves is reported, with no answer', () => {
    const { spec } = PROFILES.find((p) => p.key === 'retired');
    const r = solveSpending(planOf(spec), { floor: 1e12 });
    assert.equal(r.best, null);
    assert.equal(r.boundBy.kind, 'floor');
    assert.equal(r.boundBy.noLevelPasses, true);
});

// ── The curve ────────────────────────────────────────────────────────

await check('the curve rises in spending, and ends where the plan first runs out', () => {
    for (const { key, spec } of PROFILES) {
        const { curve } = solve(key, spec);
        assert.equal(curve.length, SCAN_LEVELS, key);
        for (let i = 1; i < curve.length; i++) {
            assert.ok(curve[i].factor > curve[i - 1].factor, `${key}: factors out of order`);
        }
        assert.ok(curve[curve.length - 1].runsOut, `${key}: the last level is still funded`);
        const out = curve.filter((c) => c.runsOut).length;
        assert.ok(out <= 3, `${key}: ${out} of ${curve.length} levels lie past the edge`);
    }
});

await check('on the quick-starts the funded curve does not rise (measured, not a law)', () => {
    for (const { key, spec } of PROFILES) {
        assert.equal(solve(key, spec).rise, null, key);
    }
});

// ── Where the steady fall fails ──────────────────────────────────────

await check('the retiree ends with more at a higher level of spending', () => {
    const r = solve('retiree', RETIREE);
    assert.ok(r.rise, 'no rise found');
    assert.ok(r.rise.gain > 50_000, `gain ${Math.round(r.rise.gain)}`);
    // Near what was entered: just under it Checking keeps a surplus, just over
    // it the bills keep Checking empty.
    assert.ok(r.rise.fromFactor >= 0.9 && r.rise.toFactor <= 1.25,
        `rise at ${r.rise.fromFactor}..${r.rise.toFactor}`);
});

await check('and the result names the account that held the idle money', () => {
    const r = solve('retiree', RETIREE);
    assert.equal(r.rise.account.displayName, 'Checking');
    assert.ok(r.rise.account.amount > 500_000, `${Math.round(r.rise.account.amount)}`);
});

await check('the solver takes the highest passing level, above a failing one', () => {
    const floor = 5_100_000;
    const r = solve('retiree', RETIREE, floor);
    assert.ok(runAt(planOf(RETIREE), 1).endingReal < floor, 'as entered now passes the floor');
    assert.ok(r.best.factor > 1, `answered ${r.best.factor}, at or below what was entered`);
    assert.ok(keeps(r.best, floor));
    assert.equal(r.boundBy.kind, 'floor');
});

// ── Health costs and the step at 65 ──────────────────────────────────

await check('the dial turns the health plan with the other expenses', () => {
    const scaled = scaledAssets(RETIREE.modelAssets, 1.5);
    const card = (list) => list.find((a) => a.instrument === Instrument.HEALTH_INSURANCE);
    const living = (list) => list.find((a) => a.instrument === Instrument.MONTHLY_EXPENSE);
    assert.equal(card(scaled).startCurrency.amount, card(RETIREE.modelAssets).startCurrency.amount * 1.5);
    assert.equal(living(scaled).startCurrency.amount, living(RETIREE.modelAssets).startCurrency.amount * 1.5);
    const others = (list) => list.filter((a) => a !== card(list) && a !== living(list))
        .map((a) => a.startCurrency?.amount);
    assert.deepEqual(others(scaled), others(RETIREE.modelAssets));
});

await check('and leaves its benchmark premium where it was', () => {
    // The credit is the benchmark less what the household is expected to pay.
    // In the plan's first year income is the same at every level, so the
    // credit is too, unless the dial moved the benchmark with the premium.
    const firstYear = (factor) => runAt(planOf(RETIREE), factor).portfolio.taxYears[0];
    const entered = firstYear(1);
    assert.ok(entered.ptc > 1000, `first-year credit ${entered.ptc}`);
    for (const factor of [0.7, 1.5]) {
        const y = firstYear(factor);
        assert.ok(Math.abs(y.ptc - entered.ptc) < 5,
            `credit ${y.ptc} at x${factor}, ${entered.ptc} as entered`);
    }
});

await check('a plan with a health plan shows spending before and from 65, and the credit', () => {
    const r = solve('retiree', RETIREE);
    for (const col of [r.asEntered, r.best]) {
        assert.ok(col.monthlySpendingBefore65 > 0 && col.monthlySpendingFrom65 > 0);
        assert.ok(col.premiumTaxCredit > 0);
    }
    assert.ok(r.asEntered.monthlySpendingBefore65 > r.asEntered.monthlySpendingFrom65,
        'the premium stops at 65, so spending should step down');
});

await check('the split falls after the December before 65', () => {
    // Built in October 2026 at age 60: 65 arrives in January 2031, so the
    // health plan's last month is December 2030, the plan's 51st.
    const run = runAt(planOf(RETIREE), 1);
    const mean = (xs) => xs.reduce((sum, v) => sum + v, 0) / xs.length;
    const r = solve('retiree', RETIREE);
    assert.ok(Math.abs(r.asEntered.monthlySpendingBefore65 - mean(run.spendingByMonth.slice(0, 51))) < 0.01);
    assert.ok(Math.abs(r.asEntered.monthlySpendingFrom65 - mean(run.spendingByMonth.slice(51))) < 0.01);
});

await check('and says when nothing pays for health cover from 65', () => {
    assert.equal(solve('retiree', RETIREE).healthNote, true);

    const withCover = JSON.parse(JSON.stringify(RETIREE));
    const card = withCover.modelAssets.find((a) => a.instrument === Instrument.HEALTH_INSURANCE);
    const living = withCover.modelAssets.find((a) => a.instrument === Instrument.MONTHLY_EXPENSE);
    const end = runAt(planOf(RETIREE), 1).portfolio.modelAssets
        .find((a) => a.instrument === Instrument.HEALTH_INSURANCE).effectiveFinishDateInt;
    withCover.modelAssets.push({
        ...JSON.parse(JSON.stringify(living)),
        displayName: 'Medicare and supplement',
        startDateInt: { year: end.year + 1, month: 1 },
        startCurrency: { amount: -400 },
    });
    assert.ok(card);
    assert.equal(solveSpending(planOf(withCover)).healthNote, false);
});

await check('a plan with no health plan has neither the split nor the note', () => {
    const { spec } = PROFILES.find((p) => p.key === 'retired');
    const r = solve('retired', spec);
    assert.equal(r.healthNote, false);
    assert.equal(r.asEntered.monthlySpendingBefore65, undefined);
    assert.equal(r.asEntered.premiumTaxCredit, undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
