/**
 * routing-search.mjs — the Test Bench's routing search (js/routing-search.js).
 *
 * ── What is at stake ──────────────────────────────────────────────────
 *
 * The search proposes changes to a household's transfer rules. Three things
 * make a proposal worthless or harmful, and each has shipped before:
 *
 *   - a move that cannot be made. The old search recommended Roth IRA → 401(k)
 *     and wrote it into the plan. What the search may change is pinned here
 *     rule by rule;
 *   - a draw the engine prices at nothing. The early-withdrawal penalty is not
 *     charged yet (spec 13), so a retirement-account draw before 60 looks free.
 *     Those stay at the entered value;
 *   - an answer that differs from run to run. Every random number comes from a
 *     seed.
 *
 * The clock is pinned: quick-start dates come from `new Date()`.
 *
 * Usage:  node tests/routing-search.mjs   (from src/)
 */

import assert from 'node:assert/strict';
import './tools/localstorage-polyfill.js';
import { planFromProfile, listProfiles, simConfigFromPlanSpec } from '../js/mcp/run-plan.js';
import { runAt } from '../js/spending-solver.js';
import { InstrumentType } from '../js/instruments/instrument.js';
import * as R from '../js/routing-search.js';

let passed = 0, failed = 0;
async function check(label, fn) {
    try { await fn(); passed++; console.log(`  ok   ${label}`); }
    catch (err) { failed++; console.log(`  FAIL ${label}\n       ${err.message}`); }
}

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
const PLANS = at('2026-11-15T12:00:00Z', () =>
    Object.fromEntries(listProfiles().map(({ key }) => [key, planOf(planFromProfile(key))])));
const instrumentOf = (plan, name) => plan.modelAssets.find((a) => a.displayName === name).instrument;
const isRetirement = (i) => InstrumentType.isTaxDeferred(i) || InstrumentType.isTaxFree(i);

console.log('routing-search');

// ── What may change ──────────────────────────────────────────────────

await check('only incomes and monthly expenses are routed, in every profile', () => {
    for (const [key, plan] of Object.entries(PLANS)) {
        const map = R.routingGenes(plan);
        assert.ok(map.genes.length > 0, `${key} has nothing to route`);
        for (const group of map.groups) {
            const i = instrumentOf(plan, group.source);
            assert.ok(InstrumentType.isMonthlyIncome(i) || InstrumentType.isMonthlyExpense(i),
                `${key}: ${group.source} (${i}) is routed`);
            assert.equal(group.kind, InstrumentType.isMonthlyIncome(i) ? 'income' : 'expense');
        }
    }
});

await check('no gene pays into or draws on a home, a mortgage or a debt', () => {
    for (const [key, plan] of Object.entries(PLANS)) {
        const map = R.routingGenes(plan);
        for (const gene of map.genes) {
            const group = map.groups[gene.group];
            const t = instrumentOf(plan, group.targets[gene.target].name);
            assert.ok(!InstrumentType.isRealEstate(t) && !InstrumentType.isMortgage(t) && !InstrumentType.isDebt(t),
                `${key}: ${group.source} → ${group.targets[gene.target].name}`);
        }
    }
});

await check('a pension or Social Security is never routed into a retirement account', () => {
    let seen = 0;
    for (const [key, plan] of Object.entries(PLANS)) {
        const map = R.routingGenes(plan);
        for (const gene of map.genes) {
            const group = map.groups[gene.group];
            if (!InstrumentType.isRetirementIncome(instrumentOf(plan, group.source))) continue;
            seen++;
            assert.ok(!isRetirement(instrumentOf(plan, group.targets[gene.target].name)),
                `${key}: ${group.source} → ${group.targets[gene.target].name}`);
        }
    }
    assert.ok(seen > 0);
});

await check('a salary may be routed into a retirement account', () => {
    const plan = PLANS.midCareer;
    const map = R.routingGenes(plan);
    const salary = map.groups.find((g) => g.source === 'Salary');
    assert.deepEqual(salary.targets.map((t) => t.name).sort(), ['401K', 'Brokerage', 'Roth IRA']);
    assert.ok(salary.targets.every((t) => !t.locked));
});

await check('before 60 no expense gene draws on a retirement account; from 60 it may', () => {
    const plan = PLANS.midCareer;
    const map = R.routingGenes(plan);
    const expenses = map.groups.filter((g) => g.kind === 'expense');
    const early = expenses.filter((g) => plan.lifeEvents[g.phaseIdx].triggerAge < R.PENALTY_FREE_AGE);
    const late = expenses.filter((g) => plan.lifeEvents[g.phaseIdx].triggerAge >= R.PENALTY_FREE_AGE);
    assert.ok(early.length && late.length);
    for (const group of early) {
        for (const target of group.targets.filter((t) => !t.locked)) {
            assert.ok(!isRetirement(instrumentOf(plan, target.name)), `${group.phase} ${group.source} → ${target.name}`);
        }
    }
    assert.ok(late.some((g) => g.targets.some((t) => !t.locked && isRetirement(instrumentOf(plan, t.name)))));
});

/** Mid Career with an early retirement-account draw the user entered. */
function withEarlyDraw() {
    const plan = JSON.parse(JSON.stringify({ ...PLANS.midCareer, config: undefined }));
    plan.config = PLANS.midCareer.config;
    plan.lifeEvents[0].phaseTransfers.Rent = [
        { toDisplayName: 'Brokerage', monthlyMoveValue: 60, closeMoveValue: 0 },
        { toDisplayName: '401K', monthlyMoveValue: 40, closeMoveValue: 0 },
    ];
    return plan;
}

await check('an early draw the user entered is kept, locked, and counts toward the 100', () => {
    const plan = withEarlyDraw();
    const map = R.routingGenes(plan);
    const rent = map.groups.find((g) => g.phaseIdx === 0 && g.source === 'Rent');
    const draw = rent.targets.find((t) => t.name === '401K');
    assert.equal(draw.locked, true);
    assert.equal(draw.entered, 40);

    // Ask for everything from the brokerage: only 60 is left to give.
    const values = map.entered.slice();
    const i = map.genes.findIndex((g) => map.groups[g.group] === rent && rent.targets[g.target].name === 'Brokerage');
    values[i] = 100;
    assert.equal(R.repair(map, values)[i], 60);

    const events = R.applyRouting(plan, map, R.repair(map, values));
    assert.equal(events[0].phaseTransfers.Rent.find((r) => r.toDisplayName === '401K').monthlyMoveValue, 40);
});

// ── Repair ───────────────────────────────────────────────────────────

await check('repair gives whole percentages from 0 to 100 and no group over 100', () => {
    const plan = PLANS.youngCouple;
    const map = R.routingGenes(plan);
    const random = R.seededRandom(7);
    for (let n = 0; n < 200; n++) {
        const fixed = R.repair(map, map.genes.map(() => random() * 240 - 60));
        assert.ok(fixed.every((v) => Number.isInteger(v) && v >= 0 && v <= 100));
        assert.deepEqual(R.repair(map, fixed), fixed);
        const totals = new Map();
        map.genes.forEach((gene, i) => totals.set(gene.group, (totals.get(gene.group) ?? 0) + fixed[i]));
        for (const [g, total] of totals) {
            const locked = map.groups[g].targets.filter((t) => t.locked).reduce((s, t) => s + t.entered, 0);
            assert.ok(total + locked <= 100, `group ${map.groups[g].source} sums to ${total + locked}`);
        }
    }
});

await check('a routing inside its limits is left as it is', () => {
    for (const plan of Object.values(PLANS)) {
        const map = R.routingGenes(plan);
        assert.deepEqual(R.repair(map, map.entered), map.entered);
    }
});

await check('a group over 100 is scaled down, keeping its proportions', () => {
    const map = R.routingGenes(PLANS.midCareer);
    const salary = map.groups.findIndex((g) => g.source === 'Salary');
    const values = map.entered.slice();
    const mine = map.genes.map((gene, i) => (gene.group === salary ? i : -1)).filter((i) => i >= 0);
    [100, 60, 40].forEach((v, n) => { values[mine[n]] = v; });
    const fixed = R.repair(map, values);
    assert.deepEqual(mine.map((i) => fixed[i]), [50, 30, 20]);
});

// ── Writing a routing in ─────────────────────────────────────────────

await check('the entered routing, written back, runs as the plan as entered', () => {
    for (const [key, plan] of Object.entries(PLANS)) {
        const map = R.routingGenes(plan);
        const routed = { ...plan, lifeEvents: R.applyRouting(plan, map, map.entered) };
        assert.equal(runAt(routed, 1).endingReal, runAt(plan, 1).endingReal, key);
    }
});

await check('a new rule is added only when it carries something, and nothing given is changed', () => {
    const plan = PLANS.midCareer;
    const before = JSON.stringify(plan);
    const map = R.routingGenes(plan);
    const group = map.groups.findIndex((g) => g.kind === 'expense' && g.targets.some((t) => !t.locked && t.entered === 0));
    const target = map.groups[group].targets.findIndex((t) => !t.locked && t.entered === 0);
    const i = map.genes.findIndex((g) => g.group === group && g.target === target);
    const { phaseIdx, source, targets } = map.groups[group];

    const same = R.applyRouting(plan, map, map.entered);
    assert.equal(same[phaseIdx].phaseTransfers[source].some((r) => r.toDisplayName === targets[target].name
        && !plan.lifeEvents[phaseIdx].phaseTransfers[source].some((p) => p.toDisplayName === r.toDisplayName)), false);

    const values = map.entered.slice();
    values[i] = 0;
    const others = map.genes.map((g, n) => (g.group === group && n !== i ? n : -1)).filter((n) => n >= 0);
    values[others[0]] -= 7;
    values[i] = 7;
    const changed = R.applyRouting(plan, map, values);
    assert.equal(changed[phaseIdx].phaseTransfers[source].find((r) => r.toDisplayName === targets[target].name).monthlyMoveValue, 7);
    assert.equal(JSON.stringify(plan), before);
});

await check('home and mortgage rules pass through untouched', () => {
    const plan = PLANS.midCareer;
    const map = R.routingGenes(plan);
    const events = R.applyRouting(plan, map, map.genes.map(() => 0));
    for (const name of ['Home', 'Mortgage']) {
        assert.deepEqual(events[0].phaseTransfers[name], plan.lifeEvents[0].phaseTransfers[name]);
    }
});

// ── Seeds ────────────────────────────────────────────────────────────

await check('a seed gives the same stream every time, and another seed another', () => {
    const a = R.seededRandom(3), b = R.seededRandom(3), c = R.seededRandom(4);
    const take = (r) => Array.from({ length: 20 }, r);
    const first = take(a);
    assert.deepEqual(take(b), first);
    assert.notDeepEqual(take(c), first);
    assert.ok(first.every((v) => v >= 0 && v < 1));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
