/**
 * sim-config.mjs
 *
 * A config is a CAPTURED COPY, not a live view of the globals.
 *
 * ── Why this test exists ─────────────────────────────────────────────
 *
 * Spec 9 §4.2. The tempting way to build this object is getters that forward to
 * the live module bindings:
 *
 *     const env = { get inflationRate() { return global_inflationRate; } };
 *
 * That works in JavaScript, preserves the exact coupling the migration exists to
 * remove — two concurrent plans still read the same cell — and, worst of all, is
 * INVISIBLE TO THE MIGRATION'S OWN GATE. Every step of Spec 9 is verified by a
 * bit-identical snapshot, and a forwarding view is trivially bit-identical
 * because it is the same value read through one more layer. Someone could
 * rewrite makeSimConfig as a proxy tomorrow, and all 28 baselines plus 450
 * assertions would stay green while the entire point was lost.
 *
 * So the capture is asserted directly: build a config, change the global
 * afterwards, and require that the config does not move. That is the one
 * property no other test in this repo can see.
 *
 * Usage:  node tests/sim-config.mjs   (from src/)
 */

import assert from 'node:assert/strict';

import '../js/mcp/polyfill.js';
import { makeSimConfig, withSimConfig, SIM_CONFIG_FIELDS } from '../js/sim-config.js';
import { Portfolio } from '../js/portfolio.js';
import {
    simConfigFromGlobals, global_reset,
    global_setInflationRate, global_getInflationRate, global_inflationRate,
    global_setFilingAs, global_getFilingAs,
} from '../js/globals.js';

let passed = 0, failed = 0;
function check(label, fn) {
    try { fn(); console.log(`  ✓ ${label}`); passed++; }
    catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

const complete = () => ({
    inflationRate: 0.031,
    filingAs: 'Single',
    startAge: 45,
    retirementAge: 67,
    finishAge: 90,
    propertyTaxDeductionMax: 40000,
    allocateHouseholdTax: false,
    pensionWithholdingRate: 0.1,
    socialSecurityWithholdingRate: 0,
    backtestYear: 'current',
    simDataMode: 'calibrated',
});

console.log('\n── A config is captured, not forwarded ──\n');

check('a config does NOT track a later change to the global it came from', () => {
    global_reset();
    global_setInflationRate(0.031); global_getInflationRate();

    const config = simConfigFromGlobals();
    const captured = config.inflationRate;

    global_setInflationRate(0.09); global_getInflationRate();

    assert.equal(config.inflationRate, captured,
        'the config moved with the global — it is a live view, not a capture');
    assert.notEqual(config.inflationRate, global_inflationRate,
        'the global did not actually change, so this test proved nothing');
});

check('the same holds for filing status', () => {
    global_reset();
    global_setFilingAs('Single'); global_getFilingAs();
    const config = simConfigFromGlobals();

    global_setFilingAs('MFJ'); global_getFilingAs();

    assert.equal(config.filingAs, 'Single');
});

check('two configs captured either side of a change disagree', () => {
    // The control for the two above: if the setter were a no-op, "did not
    // move" would pass for the wrong reason.
    global_reset();
    global_setInflationRate(0.02); global_getInflationRate();
    const before = simConfigFromGlobals();
    global_setInflationRate(0.07); global_getInflationRate();
    const after = simConfigFromGlobals();

    assert.equal(before.inflationRate, 0.02);
    assert.equal(after.inflationRate, 0.07);
});

check('a config is frozen', () => {
    const config = makeSimConfig(complete());
    assert.ok(Object.isFrozen(config));
    try { config.inflationRate = 0.99; } catch { /* strict mode throws */ }
    assert.equal(config.inflationRate, 0.031);
});

console.log('\n── It refuses to invent values ──\n');

check('a missing field throws rather than defaulting', () => {
    const partial = complete();
    delete partial.filingAs;
    assert.throws(() => makeSimConfig(partial), /missing filingAs/);
});

check('an unknown field throws rather than being dropped', () => {
    assert.throws(() => makeSimConfig({ ...complete(), taxYear: 2025 }),
        /unknown setting/);
});

check('a non-finite number throws', () => {
    assert.throws(() => makeSimConfig({ ...complete(), inflationRate: NaN }),
        /must be a finite number/);
    assert.throws(() => makeSimConfig({ ...complete(), startAge: '45' }),
        /must be a finite number/);
});

check('an unknown filing status throws — it is not coerced here', () => {
    // asFilingStatus() coerces untrusted input at the boundary. By the time a
    // value reaches makeSimConfig it has been through that, so a bad one here
    // means a caller skipped the boundary and should hear about it.
    assert.throws(() => makeSimConfig({ ...complete(), filingAs: 'Married' }),
        /not a known filing status/);
});

check('allocateHouseholdTax must be a boolean, not truthy', () => {
    assert.throws(() => makeSimConfig({ ...complete(), allocateHouseholdTax: 1 }),
        /must be a boolean/);
});

console.log('\n── Portfolio carries one ──\n');

check('a Portfolio built without a config captures the globals', () => {
    global_reset();
    global_setInflationRate(0.031); global_getInflationRate();
    const p = new Portfolio([], false);
    assert.ok(p.config, 'no config on the portfolio');
    assert.equal(p.config.inflationRate, 0.031);
});

check('a supplied config is used verbatim, not merged with the globals', () => {
    global_reset();
    global_setInflationRate(0.031); global_getInflationRate();
    const supplied = makeSimConfig({ ...complete(), inflationRate: 0.05 });
    const p = new Portfolio([], false, supplied);
    assert.equal(p.config.inflationRate, 0.05,
        'the portfolio ignored the config it was handed');
    assert.equal(p.config, supplied, 'the config was rebuilt rather than held');
});

check('copy() carries the source run\'s config, not a fresh capture', () => {
    global_reset();
    const supplied = makeSimConfig({ ...complete(), inflationRate: 0.05 });
    const p = new Portfolio([], false, supplied);

    global_setInflationRate(0.09); global_getInflationRate();
    const clone = p.copy();

    assert.equal(clone.config.inflationRate, 0.05,
        'the copy recaptured the globals and diverged from its source');
});

console.log('\n── Shape ──\n');

check('taxTable is present and null — step 2 fills it', () => {
    const config = makeSimConfig(complete());
    assert.ok('taxTable' in config, 'taxTable missing from the shape');
    assert.equal(config.taxTable, null);
});

check('withSimConfig returns a new frozen config and leaves the original alone', () => {
    const base = makeSimConfig(complete());
    const varied = withSimConfig(base, { inflationRate: 0.06 });

    assert.equal(varied.inflationRate, 0.06);
    assert.equal(base.inflationRate, 0.031, 'the original was mutated');
    assert.ok(Object.isFrozen(varied));
    assert.notEqual(varied, base);
});

check('every declared field survives construction', () => {
    const config = makeSimConfig(complete());
    for (const f of SIM_CONFIG_FIELDS) {
        assert.ok(f in config, `${f} was dropped`);
    }
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
