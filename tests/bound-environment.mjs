/**
 * bound-environment.mjs
 *
 * The run's environment is BORROWED by assets and life events, never owned.
 *
 * ── Why this test exists ─────────────────────────────────────────────
 *
 * Spec 9 step 4a. Everything asserted here is invisible to the snapshot
 * harness, which is the migration's usual gate. If `copy()` wrongly carried the
 * environment, or every asset held its own clone instead of sharing the
 * Portfolio's, or the env leaked into `toJSON()` — the simulated numbers would
 * be **identical** and all 28 baselines would report "no simulated number
 * moved". Step 1 proved that blind spot by construction: a live-forwarding
 * config passed the snapshot while failing three assertions in
 * tests/sim-config.mjs.
 *
 * So the semantics are asserted directly, not inferred from arithmetic.
 *
 * ── The three rules, and why each has teeth ──────────────────────────
 *
 *  1. Not in toJSON(). The env is RUN state; an asset is PLAN data, serialised
 *     into share URLs and localStorage. A config that rode along would put one
 *     user's settings into another's imported portfolio.
 *
 *  2. Not carried by copy(). ModelAsset.copy() is an explicit allowlist and
 *     ModelLifeEvent.copy() round-trips through JSON, so both drop it for free
 *     — which means a copy is UNBOUND, and Portfolio.copy() has to rebind.
 *     That is the assertion with the sharpest edge: under step 4b an unbound
 *     read throws, so a missing rebind is a crash on a Monte Carlo copy.
 *
 *  3. One env per run, shared. Not N clones that must agree. Ownership is what
 *     makes a stale binding impossible rather than merely unlikely.
 *
 * Usage:  node tests/bound-environment.mjs   (from src/)
 */

import assert from 'node:assert/strict';

import './tools/localstorage-polyfill.js';
import { Portfolio } from '../js/portfolio.js';
import { ModelAsset } from '../js/model-asset.js';
import { ModelLifeEvent, LifeEvent } from '../js/life-event.js';
import { makeSimConfig } from '../js/sim-config.js';
import { global_reset } from '../js/globals.js';
import { TaxTable } from '../js/taxes.js';
import { Currency } from '../js/utils/currency.js';
import { DateInt } from '../js/utils/date-int.js';
import { ARR } from '../js/utils/arr.js';
import { Instrument } from '../js/instruments/instrument.js';

let passed = 0, failed = 0;
function check(label, fn) {
    try { fn(); console.log(`  ✓ ${label}`); passed++; }
    catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

const cfg = (over = {}) => {
    const base = {
        inflationRate: 0.031, filingAs: 'Single',
        startAge: 45, retirementAge: 67, finishAge: 90,
        propertyTaxDeductionMax: 40000, allocateHouseholdTax: false,
        pensionWithholdingRate: 0.1, socialSecurityWithholdingRate: 0,
        backtestYear: 'current', simDataMode: 'calibrated', ...over,
    };
    // Every config carries its own table as of Spec 9 step 6 — a Portfolio
    // rejects one without. Built from THIS config's filing status, which is
    // what makes the table per-run rather than ambient.
    return makeSimConfig({
        ...base,
        taxTable: new TaxTable(base.filingAs, base.propertyTaxDeductionMax),
    });
};

const anAsset = (name = 'Brokerage') => new ModelAsset({
    instrument: Instrument.TAXABLE_EQUITY,
    displayName: name,
    startDateInt: DateInt.from(2026, 1),
    startCurrency: new Currency(100000),
    startBasisCurrency: new Currency(0),
    finishDateInt: null,              // so effectiveFinishDateInt is DERIVED
    annualReturnRate: new ARR(0.07),
});

const anEvent = () => new ModelLifeEvent({
    type: LifeEvent.RETIRE, displayName: 'Retire', triggerAge: 67,
});

function aPortfolio(config = cfg()) {
    global_reset();
    const p = new Portfolio([anAsset()], false, config);
    p.lifeEvents = [anEvent()];
    p.initializeChron();
    return p;
}

console.log('\n── The Portfolio binds; assets and events borrow ──\n');

check('initializeChron binds every asset and life event', () => {
    const p = aPortfolio();
    assert.ok(p.modelAssets[0].env, 'asset unbound after initializeChron');
    assert.ok(p.lifeEvents[0].env, 'life event unbound after initializeChron');
});

check('they share the Portfolio\'s ONE config — not clones of it', () => {
    const p = aPortfolio();
    assert.equal(p.modelAssets[0].env, p.config, 'asset holds a different object');
    assert.equal(p.lifeEvents[0].env, p.config, 'life event holds a different object');
});

check('binding is idempotent — the GA re-runs initializeChron thousands of times', () => {
    const p = aPortfolio();
    p.initializeChron();
    p.initializeChron();
    assert.equal(p.modelAssets[0].env, p.config);
    assert.equal(p.lifeEvents[0].env, p.config);
});

check('the bound env carries the run\'s tax table, not a null', () => {
    // initializeChron attaches the table to the config BEFORE binding; binding
    // earlier would hand out a config whose taxTable is still null, and every
    // consumer would read null rather than the run's table.
    const p = aPortfolio();
    assert.ok(p.modelAssets[0].env.taxTable, 'asset env has no tax table');
});

console.log('\n── It is run state, so it must not become plan data ──\n');

check('env is absent from ModelAsset.toJSON()', () => {
    const p = aPortfolio();
    assert.ok(!('env' in p.modelAssets[0].toJSON()), 'env leaked into the asset JSON');
});

check('env is absent from ModelLifeEvent.toJSON()', () => {
    const p = aPortfolio();
    assert.ok(!('env' in p.lifeEvents[0].toJSON()), 'env leaked into the event JSON');
});

check('env is non-enumerable, so a bare JSON.stringify cannot reach it either', () => {
    const a = anAsset().bindEnv(cfg());
    assert.ok(!Object.keys(a).includes('env'), 'env is enumerable');
    assert.ok(!JSON.stringify(a).includes('inflationRate'),
        'a config field reached the serialised asset');
});

console.log('\n── A copy is unbound, and Portfolio.copy() rebinds it ──\n');

check('ModelAsset.copy() does NOT carry the env', () => {
    const a = anAsset().bindEnv(cfg());
    assert.equal(a.copy().env, undefined, 'the copy inherited its source\'s env');
});

check('ModelLifeEvent.copy() does NOT carry the env', () => {
    const e = anEvent().bindEnv(cfg());
    assert.equal(e.copy().env, undefined, 'the copy inherited its source\'s env');
});

check('Portfolio.copy() rebinds both collections to the COPY\'s config', () => {
    // The sharp one. Both copy() implementations drop the env by construction,
    // so without an explicit rebind the copy's derived getters fall back to
    // module state under 4a and throw under 4b — on a Monte Carlo copy, which
    // is exactly where nobody is watching.
    const p = aPortfolio();
    const clone = p.copy();
    assert.ok(clone.modelAssets[0].env, 'copied asset left unbound');
    assert.ok(clone.lifeEvents[0].env, 'copied life event left unbound');
    assert.equal(clone.modelAssets[0].env, clone.config);
    assert.equal(clone.lifeEvents[0].env, clone.config);
});

console.log('\n── The binding actually drives the derived getters ──\n');

check('effectiveFinishDateInt follows the env\'s finishAge', () => {
    const young = aPortfolio(cfg({ finishAge: 80 }));
    const old   = aPortfolio(cfg({ finishAge: 95 }));
    const y = young.modelAssets[0].effectiveFinishDateInt.year;
    const o = old.modelAssets[0].effectiveFinishDateInt.year;
    assert.equal(o - y, 15, `expected 15 years apart, got ${y} and ${o}`);
});

check('triggerDateInt follows the env\'s startAge', () => {
    const a = aPortfolio(cfg({ startAge: 45 }));
    const b = aPortfolio(cfg({ startAge: 55 }));
    const ya = a.lifeEvents[0].triggerDateInt.year;
    const yb = b.lifeEvents[0].triggerDateInt.year;
    assert.equal(ya - yb, 10,
        `a later startAge means an earlier trigger year; got ${ya} and ${yb}`);
});

check('an explicit finishDateInt still wins over the env', () => {
    const p = aPortfolio();
    const pinned = anAsset();
    pinned.finishDateInt = DateInt.from(2040, 6);
    pinned.bindEnv(p.config);
    assert.equal(pinned.effectiveFinishDateInt.year, 2040);
    assert.equal(pinned.effectiveFinishDateInt.month, 6);
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
