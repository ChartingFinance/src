/**
 * plan-ids.mjs
 *
 * Every asset and life event in a plan carries an id that is unique within the
 * plan and survives everything that copies or saves the plan. Nothing reads the
 * ids yet; the next change makes transfers, phase rules, closes and purchase
 * funding refer to assets by id instead of by name, so a rename stops breaking
 * them. These checks are what that change will stand on:
 *
 *   1. assignPlanIds numbers what lacks an id, keeps what has one, and is
 *      idempotent and deterministic.
 *   2. An id survives toJSON/fromJSON, copy(), cloneArray, the spending
 *      solver's scaled copies, and Portfolio.copy().
 *   3. Plans get ids where they come in: every quick-start profile, build_plan
 *      (the same intent gives the same spec twice), and a Portfolio built
 *      straight from JSON.
 *
 * Run: node tests/plan-ids.mjs
 */

import assert from 'node:assert/strict';
import './tools/localstorage-polyfill.js';
import { assignPlanIds, planWithIds } from '../js/plan-ids.js';
import { planFromProfile, runPlanCached, specForHandle } from '../js/mcp/run-plan.js';
import { planFromReference } from '../js/mcp/plan-reference.js';
import { maxSpending } from '../js/mcp/max-spending.js';
import { shareUrlFromPlan } from '../js/share-link.js';
import { ModelAsset } from '../js/model-asset.js';
import { ModelLifeEvent, LifeEvent } from '../js/life-event.js';
import { Portfolio } from '../js/portfolio.js';
import { quickStartProfiles, buildQuickStart } from '../js/quick-start.js';
import { buildPlan } from '../js/mcp/build-plan.js';
import { scaledAssets } from '../js/spending-solver.js';
import { setActiveTaxTable, makeActiveTaxTable, simConfigFromGlobals } from '../js/globals.js';
import { chronometer_run } from '../js/chronometer.js';

setActiveTaxTable(makeActiveTaxTable());

// build_plan reads the clock for the plan's first month; pinned so this suite
// is the same test every month.
const WallClock = Date;
globalThis.Date = class extends WallClock {
    constructor(...args) { return args.length ? new WallClock(...args) : new WallClock('2026-11-15T12:00:00'); }
    static now() { return new WallClock('2026-11-15T12:00:00').getTime(); }
};

let passed = 0, failed = 0;
async function check(label, fn) {
    try { await fn(); passed++; console.log(`  ok   ${label}`); }
    catch (err) { failed++; console.log(`  FAIL ${label}\n       ${err.message}`); }
}

const ids = (items) => items.map((i) => i.id);
const unique = (items) => new Set(ids(items)).size === items.length;

/** A small plan as JSON, with no ids: what an old save or a test fixture holds. */
function legacyPlanJSON() {
    const { assets, lifeEvents } = buildQuickStart(quickStartProfiles[1]);
    const strip = (o) => { const { id, ...rest } = JSON.parse(JSON.stringify(o)); return rest; };
    return { modelAssets: assets.map(strip), lifeEvents: lifeEvents.map((e) => strip(e.toJSON())) };
}

console.log('plan-ids');

// ── 1. assignPlanIds ────────────────────────────────────────────────────────

await check('numbers assets a1… and life events e1… in list order', () => {
    const assets = [{}, {}, {}], events = [{}, {}];
    assignPlanIds(assets, events);
    assert.deepEqual(ids(assets), ['a1', 'a2', 'a3']);
    assert.deepEqual(ids(events), ['e1', 'e2']);
});

await check('is idempotent', () => {
    const assets = [{}, {}], events = [{}];
    assignPlanIds(assets, events);
    const before = JSON.stringify([assets, events]);
    assignPlanIds(assets, events);
    assert.equal(JSON.stringify([assets, events]), before);
});

await check('keeps ids in use and numbers new items after the highest', () => {
    const assets = [{ id: 'a1' }, { id: 'a5' }, {}, { id: null }];
    assignPlanIds(assets);
    assert.deepEqual(ids(assets), ['a1', 'a5', 'a6', 'a7']);
});

await check('a repeated id stays with the first item; the later one gets a new id', () => {
    const assets = [{ id: 'a2' }, { id: 'a2' }, { id: 'a1' }];
    assignPlanIds(assets);
    assert.deepEqual(ids(assets), ['a2', 'a3', 'a1']);
});

await check('keeps a caller\'s own unique id, and replaces an empty or non-string one', () => {
    const assets = [{ id: 'brokerage' }, { id: '' }, { id: 7 }];
    assignPlanIds(assets);
    assert.deepEqual(ids(assets), ['brokerage', 'a1', 'a2']);
});

await check('asset and life-event ids are numbered separately', () => {
    const assets = [{ id: 'a3' }, {}], events = [{}];
    assignPlanIds(assets, events);
    assert.deepEqual(ids(assets), ['a3', 'a4']);
    assert.deepEqual(ids(events), ['e1']);
});

await check('tolerates missing lists', () => {
    assignPlanIds();
    assignPlanIds(null, null);
});

// ── 2. Ids survive copies and saves ─────────────────────────────────────────

const { assets: qsAssets, lifeEvents: qsEvents } = buildQuickStart(quickStartProfiles[1]);

await check('a ModelAsset\'s id survives toJSON/fromJSON twice', () => {
    for (const asset of qsAssets) {
        const once = ModelAsset.fromJSON(JSON.parse(JSON.stringify(asset)));
        const twice = ModelAsset.fromJSON(JSON.parse(JSON.stringify(once)));
        assert.equal(twice.id, asset.id, asset.displayName);
    }
});

await check('a ModelAsset\'s id survives copy(), cloneArray and scaledAssets', () => {
    assert.deepEqual(ids(qsAssets.map((a) => a.copy())), ids(qsAssets));
    assert.deepEqual(ids(ModelAsset.cloneArray(qsAssets)), ids(qsAssets));
    assert.deepEqual(ids(scaledAssets(qsAssets, 0.8)), ids(qsAssets));
});

await check('a life event\'s id survives toJSON/fromJSON and copy()', () => {
    for (const event of qsEvents) {
        assert.equal(ModelLifeEvent.fromJSON(JSON.parse(JSON.stringify(event.toJSON()))).id, event.id);
        assert.equal(event.copy().id, event.id);
    }
});

await check('a life event read from a save without an id has none until assigned', () => {
    const event = ModelLifeEvent.fromJSON({ type: LifeEvent.RETIRE, displayName: 'Retire', triggerAge: 65 });
    assert.equal(event.id, null);
});

// ── 3. Plans get ids where they come in ─────────────────────────────────────

await check('every quick-start profile gives each asset and life event a unique id', () => {
    for (const profile of quickStartProfiles) {
        const { assets, lifeEvents } = buildQuickStart(profile);
        assert.ok(assets.every((a) => typeof a.id === 'string'), 'an asset without an id');
        assert.ok(lifeEvents.every((e) => typeof e.id === 'string'), 'a life event without an id');
        assert.ok(unique(assets) && unique(lifeEvents), 'a repeated id');
    }
});

await check('a quick-start profile gets the same ids every time', () => {
    for (const profile of quickStartProfiles) {
        const a = buildQuickStart(profile), b = buildQuickStart(profile);
        assert.deepEqual(ids(a.assets), ids(b.assets));
        assert.deepEqual(ids(a.lifeEvents), ids(b.lifeEvents));
    }
});

const INTENT = {
    horizonYears: 10,
    income: [{ label: 'Salary', annual: 100000 }],
    accounts: [{ label: 'Savings', startingBalance: 0 }, { label: 'Brokerage', startingBalance: 0 }],
    savingsSplit: [{ from: 'Salary', to: 'Savings', percent: 10 }],
};

await check('build_plan emits a spec whose assets and life events have unique ids', () => {
    const { spec } = buildPlan(INTENT);
    assert.ok(spec.modelAssets.every((a) => typeof a.id === 'string'));
    assert.ok(spec.lifeEvents.every((e) => typeof e.id === 'string'));
    assert.ok(unique(spec.modelAssets) && unique(spec.lifeEvents));
});

await check('build_plan emits the same spec for the same intent (run handles stay stable)', () => {
    assert.equal(JSON.stringify(buildPlan(INTENT).spec), JSON.stringify(buildPlan(INTENT).spec));
});

await check('a Portfolio built from JSON without ids numbers its assets in the order written', () => {
    const plan = legacyPlanJSON();
    const assets = plan.modelAssets.map((o) => ModelAsset.fromJSON(o));
    const written = assets.map((a) => a.displayName);
    const portfolio = new Portfolio(assets, false, simConfigFromGlobals());
    for (const asset of portfolio.modelAssets) {
        assert.equal(asset.id, `a${written.indexOf(asset.displayName) + 1}`, asset.displayName);
    }
});

await check('a run gives life events without ids theirs, and Portfolio.copy() keeps every id', async () => {
    const plan = legacyPlanJSON();
    const portfolio = new Portfolio(plan.modelAssets.map((o) => ModelAsset.fromJSON(o)), false, simConfigFromGlobals());
    portfolio.lifeEvents = plan.lifeEvents.map((o) => ModelLifeEvent.fromJSON(o));
    await chronometer_run(portfolio);
    assert.deepEqual(ids(portfolio.lifeEvents), plan.lifeEvents.map((_, i) => `e${i + 1}`));
    const copy = portfolio.copy();
    assert.deepEqual(ids(copy.modelAssets), ids(portfolio.modelAssets));
    assert.deepEqual(ids(copy.lifeEvents), ids(portfolio.lifeEvents));
});

// ── 4. MCP: a spec without ids gets them once, as it comes in ───────────────
//
// Claude often writes a spec without ids. Each tool stamps them on as the spec
// comes in (planWithIds), so every run built from it reads the same ids from
// the data, rather than numbering again from the written order each time.

/** A profile's spec with every id removed: what a hand-written spec looks like. */
function idlessSpec() {
    const spec = planFromProfile('midCareer');
    const strip = ({ id, ...rest }) => rest;
    return { ...spec, modelAssets: spec.modelAssets.map(strip), lifeEvents: spec.lifeEvents.map(strip) };
}
const hasNoIds = (spec) => [...spec.modelAssets, ...spec.lifeEvents].every((i) => !('id' in i));

await check('planWithIds adds ids to a copy and leaves the caller\'s spec alone', () => {
    const spec = idlessSpec();
    const before = JSON.stringify(spec);
    const out = planWithIds(spec);
    assert.equal(JSON.stringify(spec), before, 'the caller\'s spec was changed');
    assert.deepEqual(ids(out.modelAssets), out.modelAssets.map((_, i) => `a${i + 1}`));
    assert.deepEqual(ids(out.lifeEvents), out.lifeEvents.map((_, i) => `e${i + 1}`));
    assert.equal(JSON.stringify(planWithIds(out)), JSON.stringify(out), 'not idempotent');
});

await check('planWithIds keeps a missing list missing, and passes null through', () => {
    const { lifeEvents, ...noEvents } = idlessSpec();
    assert.ok(!('lifeEvents' in planWithIds(noEvents)));
    assert.equal(planWithIds(null), null);
});

await check('an old share link without ids reads back with them, the same every time', () => {
    const spec = idlessSpec();
    const { url } = shareUrlFromPlan(spec);
    const a = planFromReference(url), b = planFromReference(url);
    assert.deepEqual(ids(a.modelAssets), spec.modelAssets.map((_, i) => `a${i + 1}`));
    assert.deepEqual(ids(a.lifeEvents), ids(b.lifeEvents));
    assert.ok(a.lifeEvents.every((e) => typeof e.id === 'string'));
});

await check('run_plan registers a spec without ids under one with them; one plan, one handle', async () => {
    const spec = idlessSpec();
    const first = await runPlanCached(spec);
    assert.ok(hasNoIds(spec), 'the caller\'s spec was changed');
    const registered = specForHandle(first.handle);
    assert.deepEqual(ids(registered.modelAssets), spec.modelAssets.map((_, i) => `a${i + 1}`));
    assert.ok(registered.lifeEvents.every((e) => typeof e.id === 'string'));
    assert.equal((await runPlanCached(idlessSpec())).handle, first.handle, 'the same spec, a new handle');
    assert.equal((await runPlanCached(planWithIds(spec))).handle, first.handle,
        'the spec with its ids written in got a different handle');
    assert.deepEqual(ids(planFromReference(first.handle).modelAssets), ids(registered.modelAssets));
});

await check('max_spending on a spec without ids: the solved plan carries the same ids', async () => {
    const spec = idlessSpec();
    const expected = planWithIds(spec);
    const { solvedSpec, plan } = await maxSpending(spec);
    assert.ok(hasNoIds(spec), 'the caller\'s spec was changed');
    assert.ok(solvedSpec, 'no level kept the limits; this check needs a solved plan');
    assert.deepEqual(ids(plan.modelAssets), ids(expected.modelAssets));
    assert.deepEqual(ids(plan.lifeEvents), ids(expected.lifeEvents));
    assert.deepEqual(ids(solvedSpec.modelAssets), ids(expected.modelAssets));
    assert.deepEqual(ids(solvedSpec.lifeEvents), ids(expected.lifeEvents));
    // And the solved plan's handle, which every other tool takes, keeps them.
    const { handle } = await runPlanCached(solvedSpec);
    assert.deepEqual(ids(specForHandle(handle).modelAssets), ids(expected.modelAssets));
    assert.deepEqual(ids(specForHandle(handle).lifeEvents), ids(expected.lifeEvents));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
