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
import { ModelLifeEvent, LifeEvent, LifeEventMeta, assetsClosedBy, isCloseTemplate, closeAssetId } from '../js/life-event.js';
import { DateInt } from '../js/utils/date-int.js';

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
        // A close names an asset by id, or a type of asset (a template).
        for (const entry of event.closes) {
            assert.ok(ids.has(closeAssetId(entry)) || isCloseTemplate(entry), `closes ${JSON.stringify(entry)}`);
        }
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
    // A dead id alone is not enough now: the name would find the brokerage.
    Object.assign(noFunding.modelAssets.find((a) => a.displayName === 'Cabin').fundingConfig,
        { sourceId: 'a999', sourceDisplayName: 'Nowhere' });
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

await check('a deleted asset\'s number can go to a new asset, and the transfers to it do not follow', () => {
    const spec = referenceHeavySpec();
    const number = (id) => Number(id.slice(1));
    const highest = spec.modelAssets.map((a) => number(a.id)).reduce((a, b) => Math.max(a, b));
    const target = `a${highest}`;
    // A rule pays into the highest-numbered asset; delete that asset, and add a
    // new one in the same pass, so it is numbered into the freed id.
    const salaryRules = spec.lifeEvents[0].phaseTransfers[idOf(spec, 'Salary')];
    salaryRules.push({ toId: target, toDisplayName: 'Doomed', monthlyMoveValue: 1, closeMoveValue: 0 });
    spec.modelAssets = spec.modelAssets.filter((a) => a.id !== target);
    spec.modelAssets.push({ instrument: 'bank', displayName: 'New Savings',
        startDateInt: spec.modelAssets[0].startDateInt, startCurrency: { amount: 0 } });
    preparePlan(spec.modelAssets, spec.lifeEvents);
    const added = spec.modelAssets.at(-1);
    assert.equal(added.id, target, 'the freed number was not reused (the case this check is for)');
    const doomed = salaryRules.find((ft) => ft.toDisplayName === 'Doomed');
    assert.ok(doomed, 'the transfer to the deleted asset is gone');
    assert.equal(doomed.toId, undefined, `the transfer followed the number to ${doomed.toId}`);
});

await check('a deleted asset\'s own rules hold its id until the app prunes them', () => {
    const spec = referenceHeavySpec();
    const salary = idOf(spec, 'Salary');
    const highest = Math.max(...spec.modelAssets.map((a) => Number(a.id.slice(1))));
    // Make the salary the highest-numbered asset, then delete it and add one.
    spec.modelAssets.find((a) => a.id === salary).id = `a${highest + 5}`;
    for (const e of spec.lifeEvents) {
        if (e.phaseTransfers[salary]) { e.phaseTransfers[`a${highest + 5}`] = e.phaseTransfers[salary]; delete e.phaseTransfers[salary]; }
    }
    spec.modelAssets = spec.modelAssets.filter((a) => a.id !== `a${highest + 5}`);
    spec.modelAssets.push({ instrument: 'bank', displayName: 'New Savings',
        startDateInt: spec.modelAssets[0].startDateInt, startCurrency: { amount: 0 } });
    preparePlan(spec.modelAssets, spec.lifeEvents);
    assert.equal(spec.modelAssets.at(-1).id, `a${highest + 6}`, 'a new asset took a number its rules still key');
});

await check('the prune removes a deleted asset\'s own rules; transfers to it wait by name', () => {
    const spec = renamed(referenceHeavySpec());
    preparePlan(spec.modelAssets, spec.lifeEvents);
    const brokerage = idOf(spec, 'Brokerage (renamed)');
    const salary = idOf(spec, 'Salary (renamed)');
    const before = spec.lifeEvents[0].phaseTransfers[salary].length;
    pruneDanglingRules(spec.modelAssets, spec.lifeEvents);
    assert.equal(spec.lifeEvents[0].phaseTransfers[salary].length, before, 'a rename pruned rules');

    // What calculate() does after a delete: prepare, then prune.
    spec.modelAssets = spec.modelAssets.filter((a) => a.id !== brokerage && a.id !== salary);
    preparePlan(spec.modelAssets, spec.lifeEvents);
    pruneDanglingRules(spec.modelAssets, spec.lifeEvents);
    let waiting = 0;
    for (const event of spec.lifeEvents) {
        assert.ok(!(salary in event.phaseTransfers), 'the deleted salary\'s rules stayed');
        for (const rules of Object.values(event.phaseTransfers)) {
            for (const ft of rules) {
                assert.notEqual(ft.toId, brokerage, 'a transfer still holds the deleted brokerage\'s id');
                if (ft.toDisplayName === 'Brokerage (renamed)') { assert.equal(ft.toId, undefined); waiting++; }
            }
        }
    }
    assert.ok(waiting > 0, 'no transfer to the deleted brokerage is waiting (the fixture routes none?)');
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

// ── 6. Closing a type of asset: templates ───────────────────────────────────

await check('a template closes every asset of its type already running, and nothing else', () => {
    const at = (y, m) => DateInt.from(y, m);
    const assets = [
        { id: 'a1', instrument: 'workingIncome', startDateInt: at(2030, 1) },
        { id: 'a2', instrument: 'workingIncome', startDateInt: at(2040, 1) },   // starts the month it fires
        { id: 'a3', instrument: 'workingIncome', startDateInt: at(2042, 6) },   // a job after retiring
        { id: 'a4', instrument: 'retirementIncome', startDateInt: at(2030, 1) },
    ];
    const retire = at(2040, 1);
    assert.deepEqual(assetsClosedBy({ instrument: 'workingIncome' }, assets, retire).map((a) => a.id), ['a1', 'a2']);
    // By id, the asset is closed whenever it starts: the user chose it.
    assert.deepEqual(assetsClosedBy('a3', assets, retire).map((a) => a.id), ['a3']);
    assert.deepEqual(assetsClosedBy('Salary', assets, retire), [], 'an unresolved name closed something');
    assert.deepEqual(assetsClosedBy({ instrument: 'pension' }, assets, retire), []);
});

await check("Retire's default closes every working income, as a template no phase shares", () => {
    assert.deepEqual(LifeEventMeta.get(LifeEvent.RETIRE).defaultMutations.closes, [{ instrument: 'workingIncome' }]);
    const a = ModelLifeEvent.createDefault(LifeEvent.RETIRE, 65);
    a.closes[0].instrument = 'pension';
    assert.equal(ModelLifeEvent.createDefault(LifeEvent.RETIRE, 65).closes[0].instrument, 'workingIncome',
        "a phase's template is the meta's object");
});

await check('preparePlan leaves a template as it is, and gives an asset close its id and name', () => {
    const events = [{ type: 'retire', phaseTransfers: {}, closes: [{ instrument: 'workingIncome' }, 'Salary'] }];
    preparePlan([{ id: 'a1', displayName: 'Salary', instrument: 'workingIncome' }], events);
    assert.deepEqual(events[0].closes, [{ instrument: 'workingIncome' }, { assetId: 'a1', displayName: 'Salary' }]);
});

await check('Dual Income: Retire closes Salary A and Salary B, which the old name "Salary" never matched', async () => {
    const spec = planFromProfile('dualIncome');
    const { portfolio } = await runPlan(spec);
    const retire = portfolio.lifeEvents.find((e) => e.type === 'retire').triggerDateInt;
    for (const name of ['Salary A', 'Salary B']) {
        const salary = portfolio.modelAssets.find((a) => a.displayName === name);
        assert.ok(salary.isClosed, `${name} is open`);
        assert.equal(salary.closedDateInt?.toInt(), retire.toInt(), `${name} closed in ${salary.closedDateInt}`);
    }
    // A plan saved with the old default, the name "Salary", which names neither:
    // preparing it turns that into the template, and both close.
    const old = clone(spec);
    old.lifeEvents.find((e) => e.type === 'retire').closes = ['Salary'];
    const migrated = (await runPlan(planWithIds(old))).portfolio;
    for (const name of ['Salary A', 'Salary B']) {
        const salary = migrated.modelAssets.find((a) => a.displayName === name);
        assert.equal(salary.closedDateInt?.toInt(), retire.toInt(), `${name} closed in ${salary.closedDateInt}`);
    }
    // Control: "Salary" beside another close is a name like any other. It waits,
    // and closes neither.
    const named = clone(spec);
    named.lifeEvents.find((e) => e.type === 'retire').closes = ['Salary', 'Home'];
    const prepared = planWithIds(named);
    assert.deepEqual(prepared.lifeEvents.find((e) => e.type === 'retire').closes[0], { displayName: 'Salary' });
    const before = (await runPlan(prepared)).portfolio;
    for (const name of ['Salary A', 'Salary B']) {
        const salary = before.modelAssets.find((a) => a.displayName === name);
        assert.notEqual(salary.closedDateInt?.toInt(), retire.toInt(), `${name} was closed by the name`);
    }
});

await check("a job that starts after retiring is not closed by Retire's template", async () => {
    const spec = clone(planFromProfile('midCareer'));
    const salary = spec.modelAssets.find((a) => a.displayName === 'Salary');
    const retireYear = salary.finishDateInt.year;
    spec.modelAssets.push({
        instrument: 'workingIncome', displayName: 'Part-time',
        startDateInt: { year: retireYear + 2, month: 1 }, finishDateInt: { year: retireYear + 4, month: 12 },
        startCurrency: { amount: 1500 }, annualReturnRate: { rate: 0 },
    });
    const { portfolio } = await runPlan(planWithIds(spec));
    const job = portfolio.modelAssets.find((a) => a.displayName === 'Part-time');
    const retire = portfolio.lifeEvents.find((e) => e.type === 'retire').triggerDateInt;
    assert.ok(retire.toInt() < job.startDateInt.toInt(), 'the fixture job starts before retiring');
    assert.notEqual(job.closedDateInt?.toInt(), retire.toInt(), 'Retire closed the job before it began');
    assert.ok(job.closedDateInt == null || job.closedDateInt.toInt() > job.startDateInt.toInt(), 'the job never ran');

    // The routing search agrees: in the Retire phase the job is still routed.
    const prepared = planWithIds(spec);
    const map = routingGenes({ modelAssets: prepared.modelAssets, lifeEvents: prepared.lifeEvents,
        config: simConfigFromPlanSpec(prepared) });
    const retireIdx = prepared.lifeEvents.findIndex((e) => e.type === 'retire');
    const jobId = prepared.modelAssets.find((a) => a.displayName === 'Part-time').id;
    assert.ok(map.groups.some((g) => g.phaseIdx === retireIdx && g.sourceId === jobId),
        'the routing search treats the later job as closed at retirement');
});

// ── 7. What the page reads: the run's phase record, rule rows, issues ───────
//
// The page (asset list, Flows view, transfer and one-time forms) keys assets
// by id. These are the run's outputs it reads them from.

const { moneyFlows, rulesInForce } = await import('../js/money-flows.js');
const { buildPipelines } = await import('../js/flow-pipelines.js');
const { alertAssetIds, alertAssetNames } = await import('../js/portfolio-issues.js');

await check("the run's phase record keys each asset's rules by id, and names its phase's id", async () => {
    const spec = referenceHeavySpec();
    const { portfolio } = await runPlan(spec);
    const ids = new Set(spec.modelAssets.map((a) => a.id));
    assert.ok(portfolio.phaseRules.length >= 2, 'no phases recorded');
    for (const record of portfolio.phaseRules) {
        assert.ok(Object.keys(record.transfers).every((k) => ids.has(k)), Object.keys(record.transfers).join());
        const event = spec.lifeEvents.find((e) => e.displayName === record.phase);
        assert.equal(record.phaseId, event.id, record.phase);
    }
});

await check('rule rows carry the owner\'s id and each phase\'s id; a rename changes only the names', async () => {
    const rows = async (spec) => {
        const { portfolio } = await runPlan(spec);
        const all = rulesInForce(portfolio, moneyFlows(portfolio, 0, portfolio.monthlyPriceIndex.length - 1)).rules;
        return { portfolio, all };
    };
    const base = await rows(referenceHeavySpec());
    const after = await rows(renamed(referenceHeavySpec()));
    assert.ok(base.all.length > 0, 'no rules in force');
    for (const row of base.all) {
        assert.equal(base.portfolio.modelAssets.find((a) => a.id === row.ownerId)?.displayName, row.owner);
        assert.equal(row.phaseIds.length, row.phases.length);
        assert.ok(row.phaseIds.every((id) => base.portfolio.lifeEvents.some((e) => e.id === id)), row.phaseIds.join());
    }
    const shape = (r) => r.all.map((x) => `${x.ownerId}|${x.half}|${x.phaseIds.join(',')}|${x.moved.toFixed(2)}`).sort();
    assert.deepEqual(shape(after), shape(base));
    assert.ok(after.all.every((x) => x.owner.endsWith('(renamed)')), 'a row kept an old name');
});

await check('the Flows pipelines read each asset\'s rules from the phase record by id', async () => {
    const { portfolio } = await runPlan(referenceHeavySpec());
    const ruled = (p) => JSON.stringify(buildPipelines(p, 0)).length;
    // Without the record, the pipelines fall back to the assets' last-phase
    // rules; with it, the first month reads Accumulate's. A lookup by name would
    // find nothing in the record and read the same as no rules at all.
    const empty = Object.assign(Object.create(Object.getPrototypeOf(portfolio)), portfolio, {
        phaseRules: portfolio.phaseRules.map((r) => ({ ...r, transfers: {} })) });
    assert.notEqual(ruled(portfolio), ruled(empty), 'the phase record\'s rules changed nothing');
});

await check('an asset-scoped issue names its asset\'s id; the alert set by id matches the set by name', async () => {
    // Rent with nothing to pay it: an unpayable obligation, an alert on Rent.
    const spec = planWithIds({
        settings: { startAge: 60, retirementAge: 65, finishAge: 62, filingAs: 'Single' },
        modelAssets: [
            { instrument: 'bank', displayName: 'Checking', startDateInt: { year: 2027, month: 1 }, startCurrency: { amount: 100 } },
            { instrument: 'monthlyExpense', displayName: 'Rent', startDateInt: { year: 2027, month: 1 }, startCurrency: { amount: -2000 } },
        ],
        lifeEvents: [],
    });
    const { portfolio, issues } = await runPlan(spec);
    const rent = portfolio.modelAssets.find((a) => a.displayName === 'Rent');
    const forRent = issues.filter((i) => i.scope === 'asset' && i.assetName === 'Rent');
    assert.ok(forRent.length > 0, 'no issue on the rent');
    assert.ok(forRent.every((i) => i.assetId === rent.id), JSON.stringify(forRent.map((i) => i.assetId)));
    assert.ok(alertAssetIds(issues).has(rent.id), 'the rent has no ⚠️');
    const byName = [...alertAssetNames(issues)].map((n) => portfolio.modelAssets.find((a) => a.displayName === n).id);
    assert.deepEqual([...alertAssetIds(issues)].sort(), byName.sort());
});

// ── 8. A reference to an asset the plan does not have waits by name ────────
//
// Deleting an asset leaves its transfers, closes and purchase funding waiting
// by name (its own rules go); an asset given that name picks them up. An id
// that names nothing falls back to the name. A spec whose id and name disagree
// is refused at the MCP door. (plan-ids.js header)

const { detectIssues } = await import('../js/portfolio-issues.js');
const { EventType } = await import('../js/sim-event.js');
await import('../js/components/transfer-modal.js');
await import('../js/components/event-form-modal.js');

/** referenceHeavySpec, with Retire closing the brokerage by id as well. */
function closesBrokerageSpec() {
    const spec = referenceHeavySpec();
    const brokerage = spec.modelAssets.find((a) => a.displayName === 'Brokerage');
    spec.lifeEvents.find((e) => e.type === 'retire').closes.push({ assetId: brokerage.id, displayName: 'Brokerage' });
    return spec;
}

/** What calculate() does to the plan before a run: prepare, then prune. */
function appPrepare(spec) {
    preparePlan(spec.modelAssets, spec.lifeEvents);
    pruneDanglingRules(spec.modelAssets, spec.lifeEvents);
    return spec;
}

/** Every id a reference holds, anywhere in the plan. */
function heldIds(spec) {
    const out = [];
    for (const a of spec.modelAssets) {
        for (const ft of a.fundTransfers ?? []) if (ft.toId != null) out.push(ft.toId);
        if (a.fundingConfig?.sourceId != null) out.push(a.fundingConfig.sourceId);
    }
    for (const e of spec.lifeEvents) {
        out.push(...Object.keys(e.phaseTransfers ?? {}));
        for (const list of Object.values(e.phaseTransfers ?? {})) for (const ft of list) if (ft.toId != null) out.push(ft.toId);
        for (const c of e.closes ?? []) if (closeAssetId(c) != null) out.push(closeAssetId(c));
    }
    return out;
}

/** Finish values by asset name: ids change on a re-add, names do not. */
async function outcomeByName(spec) {
    const { portfolio } = await runPlan(spec);
    return {
        finish: portfolio.finishValue().amount,
        byName: Object.fromEntries(portfolio.modelAssets.map((a) => [a.displayName, a.finishCurrency.amount])),
        closed: portfolio.modelAssets.filter((a) => a.isClosed).map((a) => a.displayName).sort(),
    };
}

await check('deleting an asset: its transfers, close and funding wait by its name, and no reference keeps its id', () => {
    const spec = closesBrokerageSpec();
    const brokerage = idOf(spec, 'Brokerage');
    spec.modelAssets = spec.modelAssets.filter((a) => a.id !== brokerage);
    appPrepare(spec);
    assert.ok(!heldIds(spec).includes(brokerage), `still held: ${brokerage}`);
    const waitingRules = spec.lifeEvents.flatMap((e) => Object.values(e.phaseTransfers).flat())
        .filter((ft) => ft.toDisplayName === 'Brokerage');
    assert.ok(waitingRules.length > 0, 'the transfers to the brokerage are gone');
    assert.ok(waitingRules.every((ft) => ft.toId === undefined), JSON.stringify(waitingRules));
    const cabin = spec.modelAssets.find((a) => a.displayName === 'Cabin');
    assert.equal(cabin.fundingConfig.sourceId, undefined);
    assert.equal(cabin.fundingConfig.sourceDisplayName, 'Brokerage');
    assert.deepEqual(spec.lifeEvents.find((e) => e.type === 'retire').closes.at(-1), { displayName: 'Brokerage' });
});

await check('re-adding an asset of that name reconnects all of them, and the run is the original to the cent', async () => {
    const spec = closesBrokerageSpec();
    const before = await outcomeByName(spec);
    const brokerage = spec.modelAssets.find((a) => a.displayName === 'Brokerage');
    const again = clone(brokerage); delete again.id;
    spec.modelAssets = spec.modelAssets.filter((a) => a !== brokerage);
    appPrepare(spec);
    spec.modelAssets.push(again);
    appPrepare(spec);
    const newId = idOf(spec, 'Brokerage');
    assert.notEqual(newId, brokerage.id, 'the re-added asset kept the deleted one\'s id (not the case under test)');
    assert.equal(spec.modelAssets.find((a) => a.displayName === 'Cabin').fundingConfig.sourceId, newId);
    // Byte for byte, keys in order: a run handle is a hash of the plan's JSON.
    assert.equal(JSON.stringify(spec.lifeEvents.find((e) => e.type === 'retire').closes.at(-1)),
        JSON.stringify({ assetId: newId, displayName: 'Brokerage' }));
    assert.deepEqual(await outcomeByName(spec), before);
});

await check('control: an asset of another name picks up nothing', () => {
    const spec = closesBrokerageSpec();
    const brokerage = idOf(spec, 'Brokerage');
    spec.modelAssets = spec.modelAssets.filter((a) => a.id !== brokerage);
    appPrepare(spec);
    spec.modelAssets.push({ instrument: 'bank', displayName: 'Savings', startDateInt: spec.modelAssets[0].startDateInt,
        startCurrency: { amount: 0 } });
    appPrepare(spec);
    const savings = idOf(spec, 'Savings');
    assert.ok(!heldIds(spec).includes(savings), 'a reference attached itself to Savings');
    assert.equal(spec.modelAssets.find((a) => a.displayName === 'Cabin').fundingConfig.sourceId, undefined);
});

await check('an id that names nothing falls back to the name: a number, a typo, a name in the id field', async () => {
    const reference = await outcome(referenceHeavySpec());
    for (const bad of [3, 'a99', 'Brokerage']) {
        const spec = clone(referenceHeavySpec());
        const salary = idOf(spec, 'Salary');
        const brokerage = idOf(spec, 'Brokerage');
        const rule = spec.lifeEvents[0].phaseTransfers[salary].find((ft) => ft.toId === brokerage);
        rule.toId = bad;
        spec.modelAssets.find((a) => a.displayName === 'Cabin').fundingConfig.sourceId = bad;
        const prepared = planWithIds(spec);
        assert.equal(prepared.lifeEvents[0].phaseTransfers[salary].find((ft) => ft.toDisplayName === 'Brokerage').toId,
            brokerage, `toId ${JSON.stringify(bad)}`);
        assert.equal(prepared.modelAssets.find((a) => a.displayName === 'Cabin').fundingConfig.sourceId, brokerage);
        assert.equal((await outcome(prepared)).finish, reference.finish, `toId ${JSON.stringify(bad)}: the run changed`);
    }
});

await check('a name that differs only in case or outer spaces resolves when one asset has it, and waits when two do', () => {
    const one = [{ id: 'a1', displayName: 'Salary' }, { id: 'a2', displayName: 'Brokerage' }];
    const events = [{ type: 'accumulate', closes: [],
        phaseTransfers: { a1: [{ toDisplayName: '  brokerage ', monthlyMoveValue: 50, closeMoveValue: 0 }] } }];
    preparePlan(one, events);
    assert.equal(events[0].phaseTransfers.a1[0].toId, 'a2');
    assert.equal(events[0].phaseTransfers.a1[0].toDisplayName, 'Brokerage');

    const two = [{ id: 'a1', displayName: 'Salary' }, { id: 'a2', displayName: 'Brokerage' }, { id: 'a3', displayName: 'BROKERAGE' }];
    const ambiguous = [{ type: 'accumulate', closes: [],
        phaseTransfers: { a1: [{ toDisplayName: 'brokerage', monthlyMoveValue: 50, closeMoveValue: 0 }] } }];
    preparePlan(two, ambiguous);
    assert.equal(ambiguous[0].phaseTransfers.a1[0].toId, undefined, 'a guess between two assets');
});

await check('a spec whose id and name are two different assets is refused by planWithIds; preparePlan keeps the id', () => {
    const spec = clone(referenceHeavySpec());
    const salary = idOf(spec, 'Salary');
    const brokerage = idOf(spec, 'Brokerage');
    const rule = spec.lifeEvents[0].phaseTransfers[salary].find((ft) => ft.toId === brokerage);
    rule.toDisplayName = 'Roth IRA';   // edited by hand, its id left
    assert.throws(() => planWithIds(spec), /two different assets.*Roth IRA/s);
    const app = clone(spec);
    const { conflicts } = preparePlan(app.modelAssets, app.lifeEvents);
    assert.equal(conflicts.length, 1, JSON.stringify(conflicts));
    const kept = app.lifeEvents[0].phaseTransfers[salary].find((ft) => ft.toId === brokerage);
    assert.equal(kept?.toDisplayName, 'Brokerage', 'the id did not win');
    // Control: a label left by a rename names no asset, and is not a conflict.
    const renamedLabel = clone(referenceHeavySpec());
    renamedLabel.lifeEvents[0].phaseTransfers[salary].find((ft) => ft.toId === brokerage).toDisplayName = 'Old Brokerage';
    assert.doesNotThrow(() => planWithIds(renamedLabel));
});

await check('closes: a bare id or name becomes { assetId, displayName }; a dead bare id goes; an unknown name waits', () => {
    const assets = [{ id: 'a1', displayName: 'Salary' }, { id: 'a2', displayName: 'Home' }];
    const events = [{ type: 'accumulate', phaseTransfers: {}, closes: ['a1', 'Home', 'a9', 'Cottage', { instrument: 'workingIncome' }] }];
    preparePlan(assets, events);
    assert.deepEqual(events[0].closes, [
        { assetId: 'a1', displayName: 'Salary' }, { assetId: 'a2', displayName: 'Home' },
        { displayName: 'Cottage' }, { instrument: 'workingIncome' }]);
});

await check('a Retire "Salary" that names a real asset stays that asset, not the template', () => {
    const spec = clone(planFromProfile('midCareer'));
    spec.lifeEvents.find((e) => e.type === 'retire').closes = ['Salary'];
    const prepared = planWithIds(spec);
    assert.deepEqual(prepared.lifeEvents.find((e) => e.type === 'retire').closes,
        [{ assetId: idOf(prepared, 'Salary'), displayName: 'Salary' }]);
});

await check('"What needs attention": one notice per missing name, listing what waits for it; none on any profile', async () => {
    const spec = closesBrokerageSpec();
    spec.modelAssets = spec.modelAssets.filter((a) => a.displayName !== 'Brokerage');
    appPrepare(spec);
    const { issues } = await runPlan(spec);
    const notices = issues.filter((i) => i.id === 'missing-asset-reference');
    assert.equal(notices.length, 1, JSON.stringify(notices.map((n) => n.headline)));
    const [n] = notices;
    assert.equal(n.severity, 'notice');
    assert.match(n.headline, /"Brokerage" is not in the plan/);
    assert.deepEqual(n.reasons, [], 'the panel\'s "why" line repeats the detail');
    assert.ok(n.detail.includes('Retire closes it'), n.detail);
    assert.ok(n.detail.includes('the purchase of Cabin is paid for from it'), n.detail);
    assert.ok(n.detail.includes('Salary sends 93% a month in Accumulate;'), n.detail);
    assert.equal(n.occurrences, n.references.length);
    assert.deepEqual([...new Set(n.references.map((r) => r.kind))].sort(), ['close', 'funding', 'transfer']);
    // After a run an asset's own transfers are its last phase's rules: listed
    // once, under that phase, not again without one.
    const transfers = n.references.filter((r) => r.kind === 'transfer');
    assert.ok(transfers.every((r) => r.phaseId != null), JSON.stringify(transfers));
    for (const profile of quickStartProfiles) {
        const { issues: clean } = await runPlan(planFromProfile(profile.key));
        assert.ok(!clean.some((i) => i.id === 'missing-asset-reference'), `${profile.key} has a missing reference`);
    }
});

await check('a purchase whose source is gone or closed is unfunded, with ⚠️; with its source, it is not', async () => {
    const unfundedPurchase = (portfolio) => portfolio.modelAssets.find((a) => a.displayName === 'Cabin')
        .events.filter((e) => e.type === EventType.UNFUNDED && /^purchase/.test(e.data?.cause ?? ''));
    const funded = await runPlan(referenceHeavySpec());
    assert.equal(unfundedPurchase(funded.portfolio).length, 0, 'a funded purchase was reported unfunded');

    const gone = clone(referenceHeavySpec());
    Object.assign(gone.modelAssets.find((a) => a.displayName === 'Cabin').fundingConfig, { sourceId: 'a999', sourceDisplayName: 'Nowhere' });
    const g = await runPlan(planWithIds(gone));
    const [event] = unfundedPurchase(g.portfolio);
    assert.ok(event, 'no unfunded purchase');
    assert.equal(Math.abs(event.amount.amount), 120000);
    assert.match(event.data.cause, /Nowhere is not in the plan/);
    assert.ok(detectIssues(g.portfolio).some((i) => i.id === 'unfunded-obligation' && i.assetName === 'Cabin'), 'no ⚠️ on the Cabin');

    const closed = clone(referenceHeavySpec());
    const cabin = closed.modelAssets.find((a) => a.displayName === 'Cabin');
    const brokerage = closed.modelAssets.find((a) => a.displayName === 'Brokerage');
    brokerage.finishDateInt = { year: cabin.startDateInt.year - 1, month: 6 };
    const c = await runPlan(planWithIds(closed));
    assert.match(unfundedPurchase(c.portfolio)[0]?.data?.cause ?? '', /Brokerage has closed/);
});

await check('the transfer modal keeps a waiting transfer on Save, and drops it once removed', () => {
    const el = new (customElements.get('transfer-modal'))();
    el.currentAssetId = 'a1';
    el.phaseTransfers = { a1: [
        { toId: 'a3', toDisplayName: '401K', monthlyMoveValue: 5, closeMoveValue: 0 },
        { toDisplayName: 'Brokerage', monthlyMoveValue: 93, closeMoveValue: 0 }] };
    el.querySelectorAll = () => [];   // the plan's assets' cards: none drawn here
    let saved = null;
    el.addEventListener('save-transfers', (e) => { saved = e.detail.fundTransfers.map((ft) => ft.toJSON()); });
    el._onSave();
    assert.deepEqual(saved, [{ toDisplayName: 'Brokerage', monthlyMoveValue: 93, closeMoveValue: 0 }]);
    el._removedWaiting = new Set(['Brokerage']);
    el._onSave();
    assert.deepEqual(saved, []);
});

await check('the event form ticks an asset as { assetId, displayName } and lists a waiting close it can remove', () => {
    const el = new (customElements.get('event-form-modal'))();
    el._closes = [{ instrument: 'workingIncome' }, { displayName: 'Brokerage' }];
    assert.deepEqual(el._waitingCloses(), ['Brokerage']);
    el._onCloseToggle({ id: 'a2', displayName: 'Home' }, true);
    assert.ok(el._closesAsset('a2'));
    assert.deepEqual(el._closes.at(-1), { assetId: 'a2', displayName: 'Home' });
    el._onCloseToggle({ id: 'a2', displayName: 'Home' }, false);
    assert.ok(!el._closesAsset('a2'));
    el._onWaitingCloseRemove('Brokerage');
    assert.deepEqual(el._closes, [{ instrument: 'workingIncome' }]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
