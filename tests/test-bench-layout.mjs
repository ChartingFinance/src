/**
 * test-bench-layout.mjs
 *
 * Spec 18, Phase 1: the Test Bench's levers in three places, and what a result
 * says about the levers it was found under (js/test-bench-view.js).
 *
 *   FOUND UNDER      a result names exactly the conditions not at their
 *                    neutral setting; "your plan as entered" when there are
 *                    none; the markets' data when a markets figure is shown;
 *                    a floor only where the floor lives on another tab.
 *
 *   WHAT DIMS        a changed condition dims both tests; a changed limit dims
 *                    the spending test, and the floor alone dims a routing
 *                    list. Changing a lever back un-dims it.
 *
 *   RESET            the neutral conditions are Moderate, and nothing else.
 *
 *   THE CHART        each tab opens the chart on its own column.
 *
 *   THE PAGE'S WORDS the headline and the markets note name the outlook for
 *                    MCP, and leave it to Found under on the page.
 *
 * Run: node tests/test-bench-layout.mjs   (from src/)
 */

import assert from 'node:assert/strict';

import {
    NEUTRAL_CONDITIONS, conditionsOf, isNeutral, sameConditions, sameLimits, conditionChips, dataChip,
    floorChip, foundUnderChips, foundUnderText, spendingChanges, routingChanges, changedLine, tabColumn,
} from '../js/test-bench-view.js';
import { spendingHeadline, successNote } from '../js/spending-report.js';
import { MINUS } from '../js/utils/html.js';

let passed = 0, failed = 0;
function check(label, fn) {
    try { fn(); passed++; console.log(`  ok   ${label}`); }
    catch (err) { failed++; console.log(`  FAIL ${label}\n       ${err.message}`); }
}

const MODERATE = { outlook: 'moderate' };
const OPTIMISTIC = { outlook: 'optimistic' };
const PESSIMISTIC = { outlook: 'pessimistic' };
const DATA = { dataMode: 'calibrated', firstYear: 1970, lastYear: 2025 };
const LIMITS = { floor: 0, successOn: true, successPercent: 90 };

console.log('\n── Found under ──\n');

check('every condition neutral and no markets figure: "your plan as entered"', () => {
    assert.equal(foundUnderText({ conditions: MODERATE }), 'Found under · your plan as entered');
    assert.equal(foundUnderText({ conditions: {} }), 'Found under · your plan as entered');
});

check('one chip for each condition not at its neutral setting, and only those', () => {
    assert.deepEqual(conditionChips(MODERATE), []);
    assert.deepEqual(conditionChips(OPTIMISTIC), ['Optimistic (+1%)']);
    assert.deepEqual(conditionChips(PESSIMISTIC), [`Pessimistic (${MINUS}1%)`]);
    assert.deepEqual(foundUnderChips({ conditions: OPTIMISTIC }), ['Optimistic (+1%)']);
});

check('the markets\' data, when a markets figure is on screen, after the conditions', () => {
    assert.equal(foundUnderText({ conditions: OPTIMISTIC, data: DATA }),
        'Found under · Optimistic (+1%) · Calibrated 1970–2025');
    assert.equal(foundUnderText({ conditions: MODERATE, data: { ...DATA, dataMode: 'historical', firstYear: 1990 } }),
        'Found under · your plan as entered · Historical 1990–2025');
    assert.equal(dataChip(DATA), 'Calibrated 1970–2025');
});

check('a floor chip only above $0', () => {
    assert.equal(floorChip(0), null);
    assert.equal(floorChip(500000), 'Leaves at least $500,000');
    assert.deepEqual(foundUnderChips({ conditions: MODERATE, floor: 0 }), ['your plan as entered']);
    assert.deepEqual(foundUnderChips({ conditions: PESSIMISTIC, floor: 500000 }),
        [`Pessimistic (${MINUS}1%)`, 'Leaves at least $500,000']);
});

check('a name that is not an outlook throws, so a typo is never read as neutral', () => {
    assert.throws(() => conditionChips({ outlook: 'optimstic' }), /Unknown market outlook/);
    assert.throws(() => conditionsOf({ outlook: 'Moderate' }), /Unknown market outlook/);
});

console.log('\n── What dims ──\n');

const at = (conditions, limits = LIMITS) => ({ conditions, limits });

check('a spending result found under the levers on screen does not dim', () => {
    const changes = spendingChanges(at(MODERATE), at({ outlook: 'moderate' }, { ...LIMITS }));
    assert.deepEqual(changes, { conditions: false, limits: false });
    assert.equal(changedLine(changes), null);
});

check('a changed condition dims the spending result: "Conditions changed. Run again."', () => {
    const changes = spendingChanges(at(MODERATE), at(OPTIMISTIC));
    assert.deepEqual(changes, { conditions: true, limits: false });
    assert.equal(changedLine(changes, 'Run'), 'Conditions changed. Run again.');
});

check('each changed limit dims it: "Limits changed. Run again."', () => {
    for (const limits of [{ ...LIMITS, floor: 1000 }, { ...LIMITS, successOn: false }, { ...LIMITS, successPercent: 80 }]) {
        const changes = spendingChanges(at(MODERATE), at(MODERATE, limits));
        assert.deepEqual(changes, { conditions: false, limits: true }, JSON.stringify(limits));
        assert.equal(changedLine(changes, 'Run'), 'Limits changed. Run again.');
    }
});

check('with the markets limit off, its percentage is not a change', () => {
    const off = { ...LIMITS, successOn: false };
    assert.ok(sameLimits(off, { ...off, successPercent: 75 }));
});

check('both changed: one line', () => {
    assert.equal(changedLine(spendingChanges(at(MODERATE), at(PESSIMISTIC, { ...LIMITS, floor: 1 })), 'Run'),
        'Conditions and limits changed. Run again.');
});

check('a lever changed back is no change: the result un-dims', () => {
    const under = at(OPTIMISTIC, { ...LIMITS, floor: 2000 });
    assert.equal(changedLine(spendingChanges(under, at({ outlook: 'optimistic' }, { ...LIMITS, floor: 2000 }))), null);
});

check('a routing list dims for a condition or the floor, never for the markets limit', () => {
    const under = { conditions: MODERATE, floor: 0 };
    assert.equal(changedLine(routingChanges(under, { conditions: OPTIMISTIC, floor: 0 }), 'Search'),
        'Conditions changed. Search again.');
    assert.equal(changedLine(routingChanges(under, { conditions: MODERATE, floor: 500 }), 'Search'),
        'Limits changed. Search again.');
    assert.equal(changedLine(routingChanges(under, { conditions: MODERATE, floor: 0 }), 'Search'), null);
});

console.log('\n── Reset ──\n');

check('the neutral conditions are Moderate, and Reset is needed only away from them', () => {
    assert.deepEqual(NEUTRAL_CONDITIONS, { outlook: 'moderate' });
    assert.ok(isNeutral(NEUTRAL_CONDITIONS));
    assert.ok(isNeutral({}));
    assert.ok(!isNeutral(OPTIMISTIC));
    assert.ok(!isNeutral(PESSIMISTIC));
    assert.ok(sameConditions({}, MODERATE));
});

console.log('\n── The chart ──\n');

check('each tab opens the chart on its own column', () => {
    assert.equal(tabColumn('spending'), 'best');
    assert.equal(tabColumn('routing'), 'routed');
});

console.log('\n── The page\'s words ──\n');

const RESULT = {
    asEntered: { monthlySpending: 5000, runsOut: null },
    best: { factor: 1.1, monthlySpending: 5500 },
    fixedBest: { factor: 1.16, monthlySpending: 5800 },
    success: { target: 0.9 },
    outlook: 'optimistic',
};

check('for MCP the headline and the markets note name the outlook, as before', () => {
    assert.match(spendingHeadline(RESULT), /^With stock and bond returns 1% a year higher than you entered, the most/);
    assert.match(successNote(RESULT), /^On the plan's own path of returns, 1% a year higher than you entered, it could/);
});

check('on the page they leave it to Found under, and say what Moderate says', () => {
    const moderate = { ...RESULT, outlook: 'moderate' };
    assert.equal(spendingHeadline(RESULT, { withConditions: false }), spendingHeadline(moderate));
    assert.equal(successNote(RESULT, { withConditions: false }), successNote(moderate));
    assert.equal(spendingHeadline({ ...RESULT, best: null }, { withConditions: false }),
        'No spending level tested keeps these limits.');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
