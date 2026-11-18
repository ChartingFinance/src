/**
 * asset-references.mjs
 *
 * Everything in a plan that refers to an asset refers to it by id: a transfer's
 * target, a phase's rules, a phase's closes, a purchase's funding source. A
 * name is still accepted wherever an id is, and preparePlan() resolves it.
 * Before this, every one of those held the asset's name, and renaming an asset
 * deleted its rules (the app pruned every rule naming a name it no longer
 * had) and orphaned the rest.
 *
 *   1. preparePlan turns a plan written with names into exactly the plan
 *      written with ids, for every quick-start profile.
 *   2. A rename relabels every reference and changes nothing a run does: a
 *      plan with every asset renamed runs to the same cent. A control renames
 *      the same assets but leaves the references holding the old names; that
 *      run differs, so the check can see a broken rename.
 *   3. A deleted asset's id is never given to a new one while a rule still
 *      holds it, and the prune removes a deleted asset's rules but keeps a
 *      renamed one's.
 *   4. FundTransfer carries its target's id through JSON, copy() and system(),
 *      and binds by it.
 *   5. The routing search reads and writes rules by id, and a plan written
 *      with names routes the same as one written with ids.
 *
 * Run: node tests/asset-references.mjs
 */

import assert from 'node:assert/strict';
import './tools/localstorage-polyfill.js';
import { preparePlan, planWithIds, pruneDanglingRules } from '../js/plan-ids.js';
import { planFromProfile, runPlan, simConfigFromPlanSpec } from '../js/mcp/run-plan.js';
import { quickStartProfiles, buildQuickStart } from '../js/quick-start.js';
import { FundTransfer } from '../js/fund-transfer.js';
import { ModelAsset } from '../js/model-asset.js';
import { routingGenes, applyRouting } from '../js/routing-search.js';

// planFromProfile reads the clock for the plan's first month; pinned so this
// suite is the same test every month.
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

const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * A plan as it was written before ids: no ids, and every reference to an asset
 * by its name. What an old save, an old link or a hand-written spec holds.
 */
function namesOnly(modelAssets, lifeEvents) {
    const assets = clone(modelAssets);
    const events = clone(lifeEvents);
    const nameOf = new Map(assets.map((a) => [a.id, a.displayName]));
    const unref = (ft) => { const { toId, ...rest } = ft; return rest; };
    for (const a of assets) {
        delete a.id;
        if (a.fundingConfig) delete a.fundingConfig.sourceId;
    }
    for (const e of events) {
        delete e.id;
        e.phaseTransfers = Object.fromEntries(Object.entries(e.phaseTransfers ?? {})
            .map(([key, rules]) => [nameOf.get(key) ?? key, rules.map(unref)]));
        e.closes = (e.closes ?? []).map((c) => (typeof c === 'string' ? nameOf.get(c) ?? c : c));
    }
    return { modelAssets: assets, lifeEvents: events };
}

const idOf = (spec, name) => spec.modelAssets.find((a) => a.displayName === name).id;

/**
 * Mid Career, made to lean on every kind of reference: the salary has no
 * finish date, so only Retire's close stops it, and a cabin bought outright
 * three years in is paid for from the brokerage account by its funding config.
 */
function referenceHeavySpec() {
    const spec = clone(planFromProfile('midCareer'));
    const salary = spec.modelAssets.find((a) => a.displayName === 'Salary');
    salary.finishDateInt = null;
    const first = spec.modelAssets[0].startDateInt;
    spec.modelAssets.push({
        instrument: 'realEstate', displayName: 'Cabin',
        startDateInt: { year: first.year + 3, month: 1 },
        startCurrency: { amount: 120000 }, startBasisCurrency: { amount: 120000 },
        annualReturnRate: { rate: 0.03 },
        fundingConfig: { purchaseType: 'outright', sourceDisplayName: 'Brokerage', downPaymentPercent: 100 },
    });
    return planWithIds(spec);
}

/** What a run did, by asset id: enough that any reference going astray shows. */
async function outcome(spec) {
    const { portfolio } = await runPlan(spec);
    return {
        finish: portfolio.finishValue().amount,
        byId: Object.fromEntries(portfolio.modelAssets.map((a) => [a.id, a.finishCurrency.amount])),
        closed: portfolio.modelAssets.filter((a) => a.isClosed).map((a) => a.id).sort(),
    };
}

/** Every asset renamed, and every reference left as it is. */
function renamed(spec) {
    const out = clone(spec);
    for (const a of out.modelAssets) a.displayName = `${a.displayName} (renamed)`;
    return out;
}

console.log('asset-references');

// ── 1. Names resolve to exactly the ids ─────────────────────────────────────

await check('a plan written with names prepares to the plan written with ids, for every profile', () => {
    for (const profile of quickStartProfiles) {
        const { assets, lifeEvents } = buildQuickStart(profile);
        const withIds = { modelAssets: clone(assets), lifeEvents: clone(lifeEvents.map((e) => e.toJSON())) };
        const old = namesOnly(withIds.modelAssets, withIds.lifeEvents);
        preparePlan(old.modelAssets, old.lifeEvents);
        assert.deepEqual(old, withIds, profile.key);
    }
});

await check('a prepared profile refers to its assets only by id', () => {
    const spec = referenceHeavySpec();
    const ids = new Set(spec.modelAssets.map((a) => a.id));
    for (const event of spec.lifeEvents) {
        for (const [owner, rules] of Object.entries(event.phaseTransfers)) {
            // A profile's rules can name an asset it does not have (Rent before
            // there is rent); those stay names, refer to nothing, and the app prunes them.
            if (!ids.has(owner)) {
                assert.ok(!spec.modelAssets.some((a) => a.displayName === owner), `${owner} left as a name`);
                continue;
            }
            for (const ft of rules) {
                if (ft.toId != null) assert.ok(ids.has(ft.toId), `${ft.toDisplayName} → ${ft.toId}`);
                else assert.ok(!spec.modelAssets.some((a) => a.displayName === ft.toDisplayName),
                    `a transfer to ${ft.toDisplayName} was not resolved`);
            }
        }
        for (const entry of event.closes) assert.ok(ids.has(entry), `closes ${entry}`);
    }
    const cabin = spec.modelAssets.find((a) => a.displayName === 'Cabin');
    assert.equal(cabin.fundingConfig.sourceId, idOf(spec, 'Brokerage'));
});

await check('rules under both an id and the old name: the id\'s win', () => {
    const assets = [{ id: 'a1', displayName: 'Salary' }, { id: 'a2', displayName: 'Brokerage' }];
    const byId = [{ toId: 'a2', toDisplayName: 'Brokerage', monthlyMoveValue: 30, closeMoveValue: 0 }];
    const byName = [{ toDisplayName: 'Brokerage', monthlyMoveValue: 99, closeMoveValue: 0 }];
    for (const phaseTransfers of [{ Salary: byName, a1: byId }, { a1: byId, Salary: byName }]) {
        const events = [{ type: 'accumulate', phaseTransfers: clone(phaseTransfers), closes: [] }];
        preparePlan(assets, events);
        assert.deepEqual(Object.keys(events[0].phaseTransfers), ['a1']);
        assert.equal(events[0].phaseTransfers.a1[0].monthlyMoveValue, 30);
    }
});

// ── 2. A rename changes nothing a run does ──────────────────────────────────

await check('a rename relabels every reference and keeps every key', () => {
    const spec = renamed(referenceHeavySpec());
    preparePlan(spec.modelAssets, spec.lifeEvents);
    const accumulate = spec.lifeEvents[0];
    const salaryRules = accumulate.phaseTransfers[idOf(spec, 'Salary (renamed)')];
    assert.ok(salaryRules.length > 0, 'the salary\'s rules are gone');
    assert.ok(salaryRules.every((ft) => ft.toDisplayName.endsWith('(renamed)')), JSON.stringify(salaryRules));
    const cabin = spec.modelAssets.find((a) => a.displayName === 'Cabin (renamed)');
    assert.equal(cabin.fundingConfig.sourceDisplayName, 'Brokerage (renamed)');
});

const baseline = await outcome(referenceHeavySpec());

await check('the references are live: the close, the rules and the funding each move the outcome', async () => {
    const spec = referenceHeavySpec();
    const noClose = clone(spec); noClose.lifeEvents.forEach((e) => { e.closes = []; });
    const noRules = clone(spec); noRules.lifeEvents.forEach((e) => { e.phaseTransfers = {}; });
    const noFunding = clone(spec);
    noFunding.modelAssets.find((a) => a.displayName === 'Cabin').fundingConfig.sourceId = 'a999';
    for (const [label, variant] of [['close', noClose], ['rules', noRules], ['funding', noFunding]]) {
        assert.notEqual((await outcome(variant)).finish, baseline.finish, `without the ${label}, nothing changed`);
    }
    assert.ok(baseline.closed.includes(idOf(spec, 'Salary')), 'Retire did not close the salary');
});

await check('every asset renamed: the run is the same to the cent', async () => {
    assert.deepEqual(await outcome(renamed(referenceHeavySpec())), baseline);
});

await check('control: renamed with the references still holding the old names, the run differs', async () => {
    // What a rename was before ids: the assets change name, the references do not.
    const spec = referenceHeavySpec();
    const old = { ...spec, ...namesOnly(spec.modelAssets, spec.lifeEvents) };
    const after = await outcome(renamed(old));
    assert.notEqual(after.finish, baseline.finish);
});

// ── 3. Deleting an asset ────────────────────────────────────────────────────

await check('a deleted asset\'s id is not given to a new asset while a rule still holds it', () => {
    const spec = referenceHeavySpec();
    const number = (id) => Number(id.slice(1));
    const highest = spec.modelAssets.map((a) => number(a.id)).reduce((a, b) => Math.max(a, b));
    const target = `a${highest}`;
    // A rule pays into the highest-numbered asset; delete that asset, and add a new one.
    spec.lifeEvents[0].phaseTransfers[idOf(spec, 'Salary')].push(
        { toId: target, toDisplayName: 'Doomed', monthlyMoveValue: 1, closeMoveValue: 0 });
    spec.modelAssets = spec.modelAssets.filter((a) => a.id !== target);
    spec.modelAssets.push({ instrument: 'bank', displayName: 'New Savings',
        startDateInt: spec.modelAssets[0].startDateInt, startCurrency: { amount: 0 } });
    preparePlan(spec.modelAssets, spec.lifeEvents);
    const added = spec.modelAssets.at(-1);
    assert.notEqual(added.id, target);
    assert.equal(added.id, `a${highest + 1}`);
});

await check('the prune removes a deleted asset\'s rules and transfers to it, and keeps a renamed one\'s', () => {
    const spec = renamed(referenceHeavySpec());
    preparePlan(spec.modelAssets, spec.lifeEvents);
    const brokerage = idOf(spec, 'Brokerage (renamed)');
    const salary = idOf(spec, 'Salary (renamed)');
    const before = spec.lifeEvents[0].phaseTransfers[salary].length;
    pruneDanglingRules(spec.modelAssets, spec.lifeEvents);
    assert.equal(spec.lifeEvents[0].phaseTransfers[salary].length, before, 'a rename pruned rules');

    spec.modelAssets = spec.modelAssets.filter((a) => a.id !== brokerage && a.id !== salary);
    pruneDanglingRules(spec.modelAssets, spec.lifeEvents);
    for (const event of spec.lifeEvents) {
        assert.ok(!(salary in event.phaseTransfers), 'the deleted salary\'s rules stayed');
        for (const rules of Object.values(event.phaseTransfers)) {
            assert.ok(rules.every((ft) => ft.toId !== brokerage), 'a transfer to the deleted brokerage stayed');
        }
    }
});

// ── 4. FundTransfer ─────────────────────────────────────────────────────────

await check('a transfer keeps its target\'s id through JSON, copy() and system()', () => {
    const ft = new FundTransfer('Brokerage', 25, 10, 'a5');
    assert.equal(FundTransfer.fromJSON(clone(ft.toJSON())).toId, 'a5');
    assert.equal(ft.copy().toId, 'a5');
    const from = { id: 'a1', displayName: 'Salary' }, to = { id: 'a5', displayName: 'Brokerage' };
    const sys = FundTransfer.system(from, to, { copy: () => ({}) });
    assert.equal(sys.toId, 'a5');
    assert.ok(!('toId' in new FundTransfer('Nowhere', 5).toJSON()), 'an unresolved transfer wrote toId');
});

await check('a transfer binds by id, whatever its label says, and by name only without one', () => {
    const a = { id: 'a1', displayName: 'Savings' }, b = { id: 'a2', displayName: 'Brokerage' };
    const stale = new FundTransfer('Savings', 10, 0, 'a2');
    stale.bind({}, [a, b]);
    assert.equal(stale.toModel, b);
    const named = new FundTransfer('Savings', 10, 0);
    named.bind({}, [a, b]);
    assert.equal(named.toModel, a);
    const gone = new FundTransfer('Brokerage', 10, 0, 'a9');
    gone.bind({}, [a, b]);
    assert.equal(gone.toModel, null, 'an id that names no asset fell back to the label');
});

await check('a transfer built from a form reads the target\'s id', () => {
    const ft = FundTransfer.fromHTML([
        { name: 'toId', value: 'a4' }, { name: 'toDisplayName', value: 'Roth IRA' },
        { name: 'monthlyMoveValue', value: '12' }, { name: 'closeMoveValue', value: '0' }]);
    assert.equal(ft.toId, 'a4');
    assert.equal(ft.toDisplayName, 'Roth IRA');
});

// ── 5. Routing ──────────────────────────────────────────────────────────────

await check('the routing search groups and writes rules by id; names route the same', () => {
    const spec = referenceHeavySpec();
    const plan = { modelAssets: spec.modelAssets, lifeEvents: spec.lifeEvents, config: simConfigFromPlanSpec(spec) };
    const map = routingGenes(plan);
    assert.ok(map.genes.length > 0, 'nothing to route');
    const ids = new Set(spec.modelAssets.map((a) => a.id));
    for (const group of map.groups) {
        assert.ok(ids.has(group.sourceId), group.source);
        for (const t of group.targets.filter((x) => !x.locked)) assert.ok(ids.has(t.id), t.name);
    }
    // The percentages it starts from are the plan's own rules.
    const salary = idOf(spec, 'Salary');
    const salaryGroup = map.groups.find((g) => g.phaseIdx === 0 && g.sourceId === salary);
    const rules = spec.lifeEvents[0].phaseTransfers[salary];
    assert.ok(salaryGroup && rules.length > 0, 'no salary group to check');
    for (const rule of rules) {
        assert.equal(salaryGroup.targets.find((t) => t.id === rule.toId)?.entered, rule.monthlyMoveValue,
            `${rule.toDisplayName}: the search did not start from the plan's rule`);
    }
    // Retire closes the salary (it has no finish date of its own), so after it
    // the salary is neither routed nor routed into.
    const retireIdx = spec.lifeEvents.findIndex((e) => e.type === 'retire');
    assert.ok(!map.groups.some((g) => g.phaseIdx === retireIdx
        && (g.sourceId === salary || g.targets.some((t) => t.id === salary))), 'the closed salary is routed');
    const old = { ...plan, ...namesOnly(spec.modelAssets, spec.lifeEvents) };
    assert.deepEqual(routingGenes(old).groups, map.groups);

    const values = map.entered.map((v) => (v > 0 ? v : 7));
    const events = applyRouting(plan, map, values);
    for (const [owner, rules] of Object.entries(events[0].phaseTransfers)) {
        if (!ids.has(owner)) continue;
        for (const ft of rules) assert.ok(ft.toId == null || ids.has(ft.toId), JSON.stringify(ft));
    }
    assert.deepEqual(applyRouting(old, routingGenes(old), values), events);
});

await check('a ModelAsset\'s own transfers resolve when a Portfolio is built from it', async () => {
    // Fixtures build assets with transfers by name and no life events.
    const { Portfolio } = await import('../js/portfolio.js');
    const { simConfigFromGlobals, setActiveTaxTable, makeActiveTaxTable } = await import('../js/globals.js');
    setActiveTaxTable(makeActiveTaxTable());
    const spec = referenceHeavySpec();
    const assets = namesOnly(spec.modelAssets, []).modelAssets.map((o) => ModelAsset.fromJSON(o));
    assets[0].fundTransfers = [new FundTransfer('Brokerage', 10, 0)];
    const portfolio = new Portfolio(assets, false, simConfigFromGlobals());
    const brokerage = portfolio.modelAssets.find((a) => a.displayName === 'Brokerage');
    assert.equal(assets[0].fundTransfers[0].toId, brokerage.id);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
