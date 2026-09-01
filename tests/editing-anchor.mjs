/**
 * editing-anchor.mjs
 *
 * The editor and the run resolve a plan's ages to the SAME months.
 *
 * ── Why this test exists ─────────────────────────────────────────────
 *
 * Spec 10 step 0 anchored derived dates to `config.birthYear`, attached by
 * `Portfolio` from the plan's first month, and made `birthYearFor()` throw
 * rather than fall back. It fixed the run and it broke the editor: the app
 * binds assets and life events to `simConfigFromGlobals()`, a builder with no
 * plan to read a first month from, so `birthYear` stayed null and the first
 * read of `triggerDateInt` took the app down. Loading any Quick Start profile
 * on charting.finance threw before the charts drew.
 *
 * ── Why "it does not throw" is not the assertion ─────────────────────
 *
 * Putting `new Date().getFullYear() - startAge` back in the UI layer stops the
 * crash and passes any test that only checks for an exception. It also
 * restores, exactly, the divergence step 0 removed — the editor anchored to
 * the clock and the run anchored to the plan, agreeing only while a plan is
 * read in the year it was built.
 *
 * That divergence is not cosmetic. `charting_buildPhaseMarkers` plots the
 * EDITOR's `ev.triggerDateInt` against the RUN's `portfolio.firstDateInt`, so
 * a one-year disagreement draws the "Retire" marker on a month the engine did
 * not change regime in. Nothing errors and the picture is wrong.
 *
 * So the assertions are: the two anchors are EQUAL, on a plan whose first
 * month is not this year, under a clock set well away from both. A revert to
 * the wall clock passes the crash test and fails these.
 *
 * -- The display surfaces (added after the editor fix) ----------------
 *
 * Three more sites derived their own birth year from `new Date()` and were
 * missed the first time, because none of them binds anything - they only draw:
 *
 *   - `<finplan-timeline>`'s `_birthYear`, behind the axis year labels, the
 *     phase band edges, the mortgage payoff marker and the scrub cursor;
 *   - `global_getRetirementDateInt()` / `global_getFinishDateInt()`, whose
 *     result is handed to Monte Carlo and Guardrails as the month the
 *     withdrawal regime starts;
 *   - `currentPhaseEvent()` in finplan-app.js, behind the "Viewing:" badge.
 *
 * The first two are checked below, on the real code. The third is not
 * importable - finplan-app.js touches `document` at module load - and was
 * verified in the browser instead; it is three lines reading the same
 * `displayConfig()` the second one is called with.
 *
 * Note the divergence is NOT capped at one year. `_timelineStartAge` takes a
 * min against `portfolio.firstDateInt.year - birthYear`, so a clock anchor
 * shifts the axis by however old the saved plan is: the fixture below reads
 * 2020-2067 on the plan's anchor and 2021-2072 on a clock set to 2026 (and
 * 2021-2077 on one set to 2031 - measured, by reverting the fix).
 *
 * Usage:  node tests/editing-anchor.mjs   (from src/)
 */

import assert from 'node:assert/strict';

import './tools/localstorage-polyfill.js';
import { editingConfigFor } from '../js/editing-env.js';
import { AppState } from '../js/app-state.js';
import { Portfolio } from '../js/portfolio.js';
import { ModelAsset } from '../js/model-asset.js';
import { ModelLifeEvent, LifeEvent } from '../js/life-event.js';
import { Instrument } from '../js/instruments/instrument.js';
import { Currency } from '../js/utils/currency.js';
import { DateInt } from '../js/utils/date-int.js';
import { ARR } from '../js/utils/arr.js';
import { FinplanTimeline } from '../js/components/finplan-timeline.js';
import { finishDateIntFor } from '../js/plan-dates.js';
import {
    global_reset, simConfigFromGlobals,
    global_getRetirementDateInt, global_getFinishDateInt,
    global_setUserStartAge, global_getUserStartAge,
    global_setUserRetirementAge, global_getUserRetirementAge,
    global_setUserFinishAge, global_getUserFinishAge,
} from '../js/globals.js';

let passed = 0, failed = 0;
function check(label, fn) {
    try { fn(); console.log(`  ✓ ${label}`); passed++; }
    catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

// The plan is deliberately OLD — a scenario saved years ago and reopened. A
// clock-derived anchor and a plan-derived one agree for a plan built today,
// which is why this bug survived so long: quick start creates every asset
// starting this month.
const PLAN_FIRST_YEAR = 2021;
const START_AGE = 45, RETIREMENT_AGE = 67, FINISH_AGE = 90;
const EXPECTED_BIRTH_YEAR = PLAN_FIRST_YEAR - START_AGE;   // 1976

const RealDate = Date;
function withClock(iso, fn) {
    const fixed = new RealDate(iso);
    globalThis.Date = class extends RealDate {
        constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(fixed); }
        static now() { return fixed.getTime(); }
    };
    try { return fn(); } finally { globalThis.Date = RealDate; }
}

function setAges() {
    global_reset();
    global_setUserStartAge(START_AGE);           global_getUserStartAge();
    global_setUserRetirementAge(RETIREMENT_AGE); global_getUserRetirementAge();
    global_setUserFinishAge(FINISH_AGE);         global_getUserFinishAge();
}

// `finishDateInt: null` is the point — that is what makes
// effectiveFinishDateInt derived, and so anchor-dependent.
const anAsset = (year, month = 3, name = 'Brokerage') => new ModelAsset({
    instrument: Instrument.TAXABLE_EQUITY,
    displayName: name,
    startDateInt: DateInt.from(year, month),
    startCurrency: new Currency(100000),
    startBasisCurrency: new Currency(0),
    finishDateInt: null,
    annualReturnRate: new ARR(0.07),
});

const aRetireEvent = () => new ModelLifeEvent({
    type: LifeEvent.RETIRE, displayName: 'Retire', triggerAge: RETIREMENT_AGE,
});

console.log('\n── The editor anchors on the plan, not on the calendar ──\n');

check('the anchor comes from the plan\'s earliest asset', () => {
    setAges();
    const assets = [anAsset(2024, 6, 'Later'), anAsset(PLAN_FIRST_YEAR, 3)];
    assert.equal(editingConfigFor(assets).birthYear, EXPECTED_BIRTH_YEAR);
});

check('and it does not move when the calendar does', () => {
    setAges();
    const assets = [anAsset(PLAN_FIRST_YEAR)];
    const years = ['2026-08-31', '2027-01-01', '2031-06-15'].map(
        (iso) => withClock(iso, () => editingConfigFor(assets).birthYear));
    assert.deepEqual(years, [EXPECTED_BIRTH_YEAR, EXPECTED_BIRTH_YEAR, EXPECTED_BIRTH_YEAR],
        `anchor drifted with the clock: ${years.join(', ')}`);
});

check('an empty plan falls back to the current year — there is nothing to ask', () => {
    setAges();
    const birthYear = withClock('2031-06-15', () => editingConfigFor([]).birthYear);
    assert.equal(birthYear, 2031 - START_AGE);
});

console.log('\n── The editor and the run agree ──\n');

check('editor and Portfolio derive the same birth year', () => {
    setAges();
    const editing = editingConfigFor([anAsset(PLAN_FIRST_YEAR)]);
    const run = new Portfolio([anAsset(PLAN_FIRST_YEAR)], false, simConfigFromGlobals());
    assert.equal(editing.birthYear, run.config.birthYear);
});

check('the same life event triggers in the same month in both', () => {
    setAges();
    // The editor's copy: bound the way the app binds it.
    const editingEvent = aRetireEvent().bindEnv(editingConfigFor([anAsset(PLAN_FIRST_YEAR)]));

    // The run's copy: bound by the Portfolio from the plan's first month.
    const run = new Portfolio([anAsset(PLAN_FIRST_YEAR)], false, simConfigFromGlobals());
    run.lifeEvents = [aRetireEvent()];
    run.bindEnvironment();

    assert.equal(
        editingEvent.triggerDateInt.toInt(), run.lifeEvents[0].triggerDateInt.toInt(),
        'the phase marker would be drawn on a different month than the regime change');
    assert.equal(editingEvent.triggerDateInt.year, EXPECTED_BIRTH_YEAR + RETIREMENT_AGE);
});

check('a derived finish date agrees too', () => {
    setAges();
    const editingAsset = anAsset(PLAN_FIRST_YEAR);
    editingAsset.bindEnv(editingConfigFor([editingAsset]));
    const run = new Portfolio([anAsset(PLAN_FIRST_YEAR)], false, simConfigFromGlobals());
    assert.equal(editingAsset.effectiveFinishDateInt.toInt(),
        run.modelAssets[0].effectiveFinishDateInt.toInt());
});

console.log('\n── AppState hands the anchor to the events it holds ──\n');

check('life events are readable as soon as they are set', () => {
    setAges();
    const appState = new AppState();
    appState.editingConfig = editingConfigFor([anAsset(PLAN_FIRST_YEAR)]);
    appState.lifeEvents = [aRetireEvent()];
    assert.equal(appState.lifeEvents[0].triggerDateInt.year,
        EXPECTED_BIRTH_YEAR + RETIREMENT_AGE);
});

check('events set BEFORE the assets are rebound when the anchor arrives', () => {
    // This is the shared-scenario import order: the life events land first so
    // the legacy per-asset transfers can be migrated onto the accumulate
    // phase, and only then are the assets built.
    setAges();
    const appState = new AppState();
    appState.lifeEvents = [aRetireEvent()];
    appState.editingConfig = editingConfigFor([anAsset(PLAN_FIRST_YEAR)]);
    assert.equal(appState.lifeEvents[0].triggerDateInt.year,
        EXPECTED_BIRTH_YEAR + RETIREMENT_AGE,
        'the event kept the anchor it was born with');
});

check('a first-run app with no plan still resolves its default timeline', () => {
    setAges();
    const appState = new AppState();
    const year = withClock('2031-06-15', () => {
        appState.lifeEvents = [aRetireEvent()];
        return appState.lifeEvents[0].triggerDateInt.year;
    });
    assert.equal(year, (2031 - START_AGE) + RETIREMENT_AGE);
});

console.log('\n-- The timeline draws the plan\'s axis, not the calendar\'s --\n');

// A custom element cannot be constructed under node. Every method used here is
// a pure function of these five fields, so the prototype is borrowed instead,
// which means these assertions run against the shipped code rather than a
// re-implementation of it. That matters for an anchor bug specifically: the
// two errors cancel in the round trip through `_ageAtIndex`, and a copy
// written to match would cancel them the same way.
function aTimeline(portfolio) {
    // Own DATA properties, not assignment: Lit installs a reactive accessor on
    // the prototype for every entry in `static properties`, and its setter
    // reaches for update machinery a bare object does not have. An own data
    // property shadows the accessor.
    const fields = {
        portfolio,
        startAge: START_AGE, retirementAge: RETIREMENT_AGE, finishAge: FINISH_AGE,
        selectedYear: PLAN_FIRST_YEAR, selectedMonth: 3,
    };
    return Object.create(FinplanTimeline.prototype, Object.fromEntries(
        Object.entries(fields).map(([k, value]) => [k, { value, writable: true }])));
}

const aRun = () => new Portfolio([anAsset(PLAN_FIRST_YEAR)], false, simConfigFromGlobals());

check('the arc reads the plan\'s birth year', () => {
    setAges();
    const el = aTimeline(aRun());
    assert.equal(withClock('2026-08-31', () => el._birthYear), EXPECTED_BIRTH_YEAR);
});

check('the axis year labels do not move when the calendar does', () => {
    setAges();
    const el = aTimeline(aRun());
    const ranges = ['2026-08-31', '2027-01-01', '2031-06-15'].map((iso) => withClock(iso, () => {
        const years = el._getYearRange();
        return `${years[0]}-${years[years.length - 1]}`;
    }));
    // The year before the plan's first month, through the year after the last.
    const expected = `${PLAN_FIRST_YEAR - 1}-${EXPECTED_BIRTH_YEAR + FINISH_AGE + 1}`;
    assert.deepEqual(ranges, [expected, expected, expected],
        `the axis drifted with the clock: ${ranges.join(', ')}`);
});

check('the axis ends where the engine\'s last month does', () => {
    setAges();
    const run = aRun();
    const years = aTimeline(run)._getYearRange();
    assert.equal(years[years.length - 1], finishDateIntFor(run.config).year + 1,
        'the arc would run past, or stop short of, the plan it plots');
    assert.equal(years[0], run.firstDateInt.year - 1);
});

check('an age on the arc is the age the engine has in that month', () => {
    setAges();
    const run = aRun();
    const el = aTimeline(run);
    // Index 0 is the plan's first month; twelve months on is one year older.
    assert.equal(el._ageAtIndex(0), START_AGE + (3 - 1) / 12);
    assert.equal(el._ageAtIndex(12), START_AGE + 1 + (3 - 1) / 12);
    // ...and the retirement age maps back to the month the engine retires in.
    assert.equal(el._historyIndexForAge(RETIREMENT_AGE),
        DateInt.diffMonths(run.firstDateInt,
            DateInt.from(EXPECTED_BIRTH_YEAR + RETIREMENT_AGE, 1)));
});

check('the mortgage payoff marker lands on the month the balance clears', () => {
    setAges();
    const run = aRun();
    const el = aTimeline(run);
    // Negative until index 15, which is June of the plan's second year: the
    // plan starts in March, so index 0 is March and index 15 is June + 1yr.
    const history = [...Array(15).fill(-1000), 0, 500];
    const payoffAge = withClock('2031-06-15',
        () => el._mortgagePayoffAge({ getHistory: () => history }, el._birthYear));
    assert.equal(EXPECTED_BIRTH_YEAR + Math.floor(payoffAge), PLAN_FIRST_YEAR + 1);
    assert.equal(Math.round((payoffAge % 1) * 12) + 1, 6);
});

check('with no portfolio there is nothing to ask, so the clock answers', () => {
    setAges();
    assert.equal(withClock('2031-06-15', () => aTimeline(null)._birthYear),
        2031 - START_AGE);
});

console.log('\n-- The retirement date handed to Monte Carlo --\n');

check('global_getRetirementDateInt anchors on the plan', () => {
    setAges();
    const config = aRun().config;
    const months = ['2026-08-31', '2027-01-01', '2031-06-15'].map(
        (iso) => withClock(iso, () => global_getRetirementDateInt(config).toInt()));
    const expected = DateInt.from(EXPECTED_BIRTH_YEAR + RETIREMENT_AGE, 1).toInt();
    assert.deepEqual(months, [expected, expected, expected],
        `the withdrawal regime moved with the clock: ${months.join(', ')}`);
});

check('and it names the month the engine changes regime in', () => {
    setAges();
    const run = aRun();
    run.lifeEvents = [aRetireEvent()];
    run.bindEnvironment();
    assert.equal(global_getRetirementDateInt(run.config).toInt(),
        run.lifeEvents[0].triggerDateInt.toInt(),
        'guardrails would start withdrawing in a different month than the plan retires');
});

check('global_getFinishDateInt agrees with the plan\'s last month', () => {
    setAges();
    const config = aRun().config;
    assert.equal(global_getFinishDateInt(config).toInt(), finishDateIntFor(config).toInt());
});

check('an unanchored config throws rather than guessing', () => {
    // simConfigFromGlobals() has no plan to read a first month from, so it
    // carries no birthYear. Falling back to the clock here is exactly the bug.
    setAges();
    assert.throws(() => global_getRetirementDateInt(simConfigFromGlobals()), /birthYear/);
    assert.throws(() => global_getFinishDateInt(undefined), /birthYear/);
});

console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
