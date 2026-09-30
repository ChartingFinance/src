/**
 * retirement-move.mjs
 *
 * Changing the retirement age on a loaded plan moves the plan's retirement,
 * not just the setting.
 *
 * The Retire phase is age-relative but asset dates are absolute, so the
 * setting used to move the simulations' retirement date and nothing in the
 * plan: the salary kept paying and Social Security started at the old age.
 *
 *   THE ORACLE    every quick-start profile, moved from its own retirement age,
 *                 must equal the same profile BUILT at the new age: same asset
 *                 JSON, same phase ages. The builder derives every retirement
 *                 date independently, so this checks both what moves and that
 *                 nothing else does.
 *
 *   REVERSIBLE    moving back restores the original plan exactly.
 *
 *   ONLY INCOME   an unrelated asset dated at the retirement month stays put.
 *
 *   NEVER BEFORE THE PLAN   a date that would move before the plan's first
 *                 month (its anchor) or across its asset's other end is left
 *                 alone and reported, so the plan is not re-dated.
 *
 *   THE RUN       after the move, the salary's last paycheck and Social
 *                 Security's first payment come at the new retirement.
 *
 * Run: node tests/retirement-move.mjs   (from src/)
 */

import assert from 'node:assert/strict';

import './tools/localstorage-polyfill.js';
import { quickStartProfiles, buildQuickStart } from '../js/quick-start.js';
import { editingConfigFor } from '../js/editing-env.js';
import { moveRetirement, describeRetirementMove } from '../js/retirement-move.js';
import { ModelAsset } from '../js/model-asset.js';
import { LifeEvent } from '../js/life-event.js';
import { Portfolio } from '../js/portfolio.js';
import { chronometer_run } from '../js/chronometer.js';
import { Metric } from '../js/metric.js';
import { DateInt } from '../js/utils/date-int.js';
import {
    global_reset, global_setUserStartAge, global_setUserRetirementAge, global_setUserFinishAge,
    global_setFilingAs, setActiveTaxTable, makeActiveTaxTable, simConfigFromGlobals,
} from '../js/globals.js';

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); failed++; }
}

// quick-start dates every asset from the clock, so pin it (see the note in
// quickstart-golden.mjs).
const RealDate = Date;
const PINNED = new RealDate(2026, 8, 15);
globalThis.Date = class extends RealDate {
    constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(PINNED); }
    static now() { return PINNED.getTime(); }
};

/** Settings as the app would hold them for this profile, then its plan, bound for editing. */
function loaded(profile, retirementAge = profile.retirementAge) {
    global_reset();
    global_setUserStartAge(profile.startAge);
    global_setUserRetirementAge(retirementAge);
    global_setUserFinishAge(profile.finishAge);
    global_setFilingAs(profile.filingAs);
    setActiveTaxTable(makeActiveTaxTable());
    const { assets, lifeEvents } = buildQuickStart(profile, { retirementAge });
    const config = editingConfigFor(assets);
    for (const a of assets) a.bindEnv(config);
    for (const e of lifeEvents) e.bindEnv(config);
    return { assets, lifeEvents, config };
}

const planJSON = ({ assets, lifeEvents }) => JSON.stringify({
    assets: assets.map((a) => a.toJSON()),
    phases: lifeEvents.map((e) => [e.type, e.triggerAge]),
});

// ── the oracle ───────────────────────────────────────────────────────

console.log('\n── Moved equals built at the new age ──\n');

for (const profile of quickStartProfiles) {
    for (const delta of [-5, +2]) {
        const toAge = profile.retirementAge + delta;
        if (toAge <= profile.startAge) continue;   // covered by the skip tests
        await test(`${profile.label}: ${profile.retirementAge} → ${toAge}`, () => {
            const plan = loaded(profile);
            const assetsBefore = JSON.stringify(plan.assets.map((a) => a.toJSON()));
            const result = moveRetirement(plan.assets, plan.lifeEvents, toAge);
            assert.equal(result.skipped.length, 0);
            if (profile.startAge < profile.retirementAge) {
                assert.ok(result.moved.length > 0, 'nothing moved: no retirement-dated income');
                assert.equal(planJSON(plan), planJSON(loaded(profile, toAge)));
            } else {
                // Already retired: the income started with the plan and the
                // builder ignores the retirement age, so there is no oracle.
                // Only the phase moves.
                assert.equal(result.moved.length, 0);
                assert.equal(JSON.stringify(plan.assets.map((a) => a.toJSON())), assetsBefore);
                assert.equal(plan.lifeEvents.find((e) => e.type === LifeEvent.RETIRE).triggerAge, toAge);
            }
        });
    }
}

// ── reversible ───────────────────────────────────────────────────────

console.log('\n── Reversible ──\n');

for (const profile of quickStartProfiles.filter((p) => p.startAge < p.retirementAge - 5)) {
    await test(`${profile.label}: down five years and back restores the plan`, () => {
        const plan = loaded(profile);
        const before = planJSON(plan);
        moveRetirement(plan.assets, plan.lifeEvents, profile.retirementAge - 5);
        assert.notEqual(planJSON(plan), before);
        moveRetirement(plan.assets, plan.lifeEvents, profile.retirementAge);
        assert.equal(planJSON(plan), before);
    });
}

// ── only income ──────────────────────────────────────────────────────

console.log('\n── Only retirement-dated income moves ──\n');

const MID = quickStartProfiles.find((p) => p.key === 'midCareer');

await test('an expense ending in the retirement month stays put', () => {
    const plan = loaded(MID);
    const retireMonth = plan.lifeEvents.find((e) => e.type === LifeEvent.RETIRE).triggerDateInt;
    const commute = ModelAsset.fromJSON({
        instrument: 'monthlyExpense', displayName: 'Commute',
        startDateInt: { year: plan.assets[0].startDateInt.year, month: plan.assets[0].startDateInt.month },
        finishDateInt: { year: retireMonth.year, month: retireMonth.month },
        startCurrency: { amount: -300 }, startBasisCurrency: { amount: 0 },
    });
    commute.bindEnv(plan.config);
    plan.assets.push(commute);
    const result = moveRetirement(plan.assets, plan.lifeEvents, 62);
    assert.equal(commute.finishDateInt.toInt(), retireMonth.toInt());
    assert.ok(!result.moved.some((m) => m.asset === commute));
});

await test('a pension starting in the retirement month moves with it', () => {
    const plan = loaded(MID);
    const retireMonth = plan.lifeEvents.find((e) => e.type === LifeEvent.RETIRE).triggerDateInt;
    const pension = ModelAsset.fromJSON({
        instrument: 'pension', displayName: 'Pension',
        startDateInt: { year: retireMonth.year, month: retireMonth.month },
        startCurrency: { amount: 1500 }, startBasisCurrency: { amount: 0 },
    });
    pension.bindEnv(plan.config);
    plan.assets.push(pension);
    const result = moveRetirement(plan.assets, plan.lifeEvents, 62);
    assert.equal(pension.startDateInt.toInt(), result.to.toInt());
    assert.ok(result.moved.some((m) => m.asset === pension && m.edge === 'start'));
});

await test('every moved date is its own object', () => {
    // Shared DateInts are how closedDateInt once tracked the live clock: one
    // in-place change would move every asset holding it, and the phase.
    const plan = loaded(quickStartProfiles.find((p) => p.key === 'dualIncome'));
    const result = moveRetirement(plan.assets, plan.lifeEvents, 62);
    const dates = result.moved.map(({ asset, edge }) => edge === 'finish' ? asset.finishDateInt : asset.startDateInt);
    assert.ok(dates.length >= 4, `expected both salaries and both benefits, moved ${dates.length}`);
    assert.equal(new Set(dates).size, dates.length, 'two moved assets share a DateInt');
    assert.ok(!dates.includes(result.to), 'a moved date is the object the phase reported');
});

await test('a plan with no Retire phase is left alone', () => {
    const plan = loaded(MID);
    const before = planJSON(plan);
    const result = moveRetirement(plan.assets, plan.lifeEvents.filter((e) => e.type !== LifeEvent.RETIRE), 62);
    assert.equal(result.from, null);
    assert.equal(planJSON(plan), before);
});

// ── never before the plan ────────────────────────────────────────────

console.log('\n── Never before the plan starts ──\n');

await test('a retirement age below the current age moves the phase and no asset', () => {
    const plan = loaded(MID);                          // age 45, retiring at 67
    const firstBefore = Math.min(...plan.assets.map((a) => a.startDateInt.toInt()));
    const datesBefore = JSON.stringify(plan.assets.map((a) => [a.startDateInt?.toInt(), a.finishDateInt?.toInt()]));
    const result = moveRetirement(plan.assets, plan.lifeEvents, 40);
    assert.equal(result.moved.length, 0, `moved ${result.moved.map((m) => m.asset.displayName)}`);
    assert.ok(result.skipped.length > 0, 'the retirement-dated income should be reported as skipped');
    assert.equal(JSON.stringify(plan.assets.map((a) => [a.startDateInt?.toInt(), a.finishDateInt?.toInt()])), datesBefore);
    assert.equal(Math.min(...plan.assets.map((a) => a.startDateInt.toInt())), firstBefore, 'the plan was re-dated');
    assert.equal(plan.lifeEvents.find((e) => e.type === LifeEvent.RETIRE).triggerAge, 40);
});

await test('Social Security is not moved past its own end', () => {
    const plan = loaded(MID);
    const ss = plan.assets.find((a) => a.displayName === 'Social Security');
    const retireMonth = plan.lifeEvents.find((e) => e.type === LifeEvent.RETIRE).triggerDateInt;
    ss.finishDateInt = new DateInt(retireMonth.toInt());
    ss.finishDateInt.addMonths(12);
    const result = moveRetirement(plan.assets, plan.lifeEvents, 70);   // three years later: past SS's end
    assert.equal(ss.startDateInt.toInt(), retireMonth.toInt());
    assert.ok(result.skipped.some((s) => s.asset === ss && s.edge === 'start'));
});

// ── the note ─────────────────────────────────────────────────────────

console.log('\n── The note ──\n');

await test('the note names what moved and when', () => {
    const plan = loaded(MID);
    const text = describeRetirementMove(moveRetirement(plan.assets, plan.lifeEvents, 62));
    const year = plan.lifeEvents.find((e) => e.type === LifeEvent.RETIRE).triggerDateInt.year;
    assert.equal(text, `Moved Salary's end and Social Security's start to Jan ${year} with your retirement.`);
});

await test('no change, no note', () => {
    const plan = loaded(MID);
    assert.equal(describeRetirementMove(moveRetirement(plan.assets, plan.lifeEvents, MID.retirementAge)), null);
});

// ── the run ──────────────────────────────────────────────────────────

console.log('\n── The run retires at the new age ──\n');

await test('Mid Career moved to 62: last paycheck and first benefit at the new retirement', async () => {
    const plan = loaded(MID);
    moveRetirement(plan.assets, plan.lifeEvents, 62);
    global_setUserRetirementAge(62);
    const portfolio = new Portfolio(plan.assets, true, simConfigFromGlobals());
    portfolio.lifeEvents = plan.lifeEvents.map((e) => e.copy());
    await chronometer_run(portfolio);

    const first = portfolio.firstDateInt;
    const lastNonZero = (name, metric) => {
        const h = portfolio.modelAssets.find((a) => a.displayName === name).getHistory(metric);
        let last = -1; h.forEach((v, i) => { if (v) last = i; }); return last;
    };
    const firstNonZero = (name, metric) =>
        portfolio.modelAssets.find((a) => a.displayName === name).getHistory(metric).findIndex((v) => v);

    const retireYear = portfolio.config.birthYear + 62;
    const retireIndex = retireYear * 12 - (first.year * 12 + first.month - 1);
    const salaryLast = lastNonZero('Salary', Metric.EMPLOYED_INCOME);
    const ssFirst = firstNonZero('Social Security', Metric.SOCIAL_SECURITY_INCOME);
    assert.ok(Math.abs(salaryLast - retireIndex) <= 1,
        `last paycheck at month index ${salaryLast}, retirement at ${retireIndex} (Jan ${retireYear})`);
    assert.ok(Math.abs(ssFirst - retireIndex) <= 1,
        `first benefit at month index ${ssFirst}, retirement at ${retireIndex} (Jan ${retireYear})`);
});

globalThis.Date = RealDate;
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
