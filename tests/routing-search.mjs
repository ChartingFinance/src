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
 * And one thing makes it harmful while looking like a gain: ranking a routing
 * by what it leaves at the end. Measured on the eight quick-starts (spec 15
 * §8.7), that search moved money into retirement accounts and the plan could
 * then spend less on seven of them. A routing is ranked by what the plan can
 * spend, and that is pinned here.
 *
 * The clock is pinned: quick-start dates come from `new Date()`.
 *
 * Usage:  node tests/routing-search.mjs          (from src/)
 *         node tests/routing-search.mjs --all    every profile in the
 *             never-worse check; the three largest take minutes
 */

import assert from 'node:assert/strict';
import './tools/localstorage-polyfill.js';
import { planFromProfile, listProfiles, simConfigFromPlanSpec } from '../js/mcp/run-plan.js';
import { runAt, solveSpending } from '../js/spending-solver.js';
import * as Report from '../js/routing-report.js';
import { resultRows } from '../js/spending-report.js';
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

await check('a source running on an earlier phase\'s rules keeps them all when one is changed', () => {
    // Young Couple, with one of the salary's rules also moving money when the
    // salary closes: a part of a rule the search never touches.
    const plan = JSON.parse(JSON.stringify({ ...PLANS.youngCouple, config: undefined }));
    plan.config = PLANS.youngCouple.config;
    const inherits = R.routingGenes(plan).groups.find((x) => x.inherited && x.rules.length > 1);
    const setIn = plan.lifeEvents.findLast((e, idx) => idx < inherits.phaseIdx && inherits.source in (e.phaseTransfers ?? {}));
    setIn.phaseTransfers[inherits.source][0].closeMoveValue = 50;

    const map = R.routingGenes(plan);
    const g = map.groups.findIndex((x) => x.inherited && x.source === inherits.source);
    const group = map.groups[g];
    assert.ok(!(group.source in plan.lifeEvents[group.phaseIdx].phaseTransfers), 'the fixture no longer inherits');

    // Written back as entered, the phase still says nothing about the source.
    const same = R.applyRouting(plan, map, map.entered);
    assert.ok(!(group.source in same[group.phaseIdx].phaseTransfers));

    // One percentage changed: the phase now holds every rule that was in force.
    const i = map.genes.findIndex((gene) => gene.group === g && group.targets[gene.target].entered >= 1);
    const values = map.entered.slice();
    values[i] -= 1;
    const written = R.applyRouting(plan, map, values)[group.phaseIdx].phaseTransfers[group.source];
    const target = group.targets[map.genes[i].target].name;
    // Each rule whole, in order, with the one percentage moved.
    assert.deepEqual(written, setIn.phaseTransfers[group.source].map((rule) =>
        (rule.toDisplayName === target ? { ...rule, monthlyMoveValue: rule.monthlyMoveValue - 1 } : rule)));
    assert.equal(written[0].closeMoveValue, 50);
});

// ── The measure ──────────────────────────────────────────────────────

/** Mid Career with more of the salary sent to the 401(k). */
function moreToThe401k(map) {
    const g = map.groups.findIndex((x) => x.source === 'Salary');
    const at = (name) => map.genes.findIndex((gene) => gene.group === g && map.groups[g].targets[gene.target].name === name);
    const values = map.entered.slice();
    values[at('401K')] = 25;
    values[at('Brokerage')] = 73;
    return values;
}

await check('a routing that leaves more at the end and pays fewer bills is not taken', () => {
    const plan = PLANS.midCareer;
    const map = R.routingGenes(plan);
    const values = moreToThe401k(map);
    const asEntered = R.scoreRouting(plan, map, map.entered);
    const routed = R.scoreRouting(plan, map, values);
    // The trap: it leaves three times as much.
    assert.ok(routed.endingReal > asEntered.endingReal * 2, 'the fixture no longer leaves more');
    assert.ok(routed.unpaid > 0 && asEntered.unpaid === 0);

    const ranker = R.makeRanker(plan, map);
    const before = ranker.edge;
    assert.equal(ranker.offer(values), false);
    assert.equal(ranker.edge, before);
    assert.deepEqual(ranker.values, ranker.entered);
});

/**
 * A ranker on a landscape written out by hand: one percentage, and for each
 * value of it the level up to which every bill is paid and what goes unpaid
 * past it.
 */
function handRanker(landscape) {
    const map = { genes: [{ group: 0, target: 0 }], groups: [{ targets: [{ locked: false, entered: 0 }] }], entered: [0] };
    const score = (_plan, _map, values, factor) => {
        const [paysTo, unpaid] = landscape[values[0]];
        return { unpaid: factor <= paysTo ? 0 : unpaid, endingReal: 0 };
    };
    // No expenses, so a level step is `within` itself.
    return R.makeRanker({ modelAssets: [] }, map, { within: 0.01, score });
}

await check('a candidate is taken when it raises the level, or comes closer while keeping it; never otherwise', () => {
    const ranker = handRanker({
        0: [1.0, 1000],    // as entered: pays to 1.0, then a cliff
        20: [1.0, 500],    // the same level, a smaller shortfall past it
        50: [0.9, 100],    // a smaller shortfall still, but it fails at 1.0
        30: [1.5, 1000],   // a higher level
        10: [1.5, 1000],   // the same higher level again
    });
    const near = (a, b) => Math.abs(a - b) < 0.02;
    assert.ok(near(ranker.enteredLevel, 1.0), `entered level ${ranker.enteredLevel}`);

    // Closer to paying just above the level, but short at the level itself.
    assert.equal(ranker.offer([50]), false);
    assert.deepEqual(ranker.values, [0]);

    assert.equal(ranker.offer([20]), 'closer');
    assert.deepEqual(ranker.values, [20]);
    assert.ok(near(ranker.edge, 1.0));

    assert.equal(ranker.offer([30]), 'raised');
    assert.deepEqual(ranker.values, [30]);
    assert.ok(near(ranker.edge, 1.5), `level ${ranker.edge}`);

    // No better than the best so far: left alone.
    assert.equal(ranker.offer([10]), false);
    assert.equal(ranker.offer([0]), false);
    assert.deepEqual(ranker.values, [30]);
});

await check('the ranker starts at the level the plan as entered can spend', () => {
    const plan = PLANS.midCareer;
    const map = R.routingGenes(plan);
    const ranker = R.makeRanker(plan, map);
    const solved = solveSpending(plan, { floor: 0 });
    // Both answer to within $10 a month of spending.
    assert.ok(Math.abs(ranker.enteredLevel - solved.best.factor) * solved.asEntered.monthlySpending < 20,
        `ranker ${ranker.enteredLevel}, solver ${solved.best.factor}`);
});

await check('with a floor, the level is the highest that leaves it', () => {
    const plan = PLANS.retired;
    const map = R.routingGenes(plan);
    const open = R.makeRanker(plan, map);
    const floor = 1_000_000;
    const held = R.makeRanker(plan, map, { floor });
    assert.ok(held.enteredLevel < open.enteredLevel);
    assert.ok(R.scoreRouting(plan, map, map.entered, held.enteredLevel).endingReal >= floor - R.TIE);
    assert.ok(R.scoreRouting(plan, map, map.entered, held.enteredLevel + 3 * held.step).endingReal < floor);
});

// ── One search ───────────────────────────────────────────────────────

const SEARCHED = {};
const searched = (key) => (SEARCHED[key] ??= R.searchRouting(PLANS[key]));
const mostAsEntered = (key) => solveSpending(PLANS[key], { floor: 0 }).best.monthlySpending;

// routing-never-worse. The three couples with a working phase take one to
// three minutes each, so they run with --all.
const QUICK = ['earlyCareer', 'midCareer', 'preRetirement', 'retired', 'retiredCouple'];
const NEVER_WORSE = process.argv.includes('--all') ? Object.keys(PLANS) : QUICK;

await check(`a search from the plan never ends below it (${NEVER_WORSE.length} profiles)`, () => {
    for (const key of NEVER_WORSE) {
        const result = searched(key);
        assert.ok(result.best.monthlySpending >= mostAsEntered(key) - 10,
            `${key}: ${result.best.monthlySpending} against ${mostAsEntered(key)} as entered`);
    }
});

await check('and on Mid Career it finds more than $250 a month', () => {
    // Recorded 2026-11-13: $5,316 as entered, $5,627 routed.
    const gain = searched('midCareer').best.monthlySpending - mostAsEntered('midCareer');
    assert.ok(gain > 250 && gain < 400, `gain ${gain}`);
});

await check('the result is the routed plan, solved: its life events give its figures', () => {
    const result = searched('midCareer');
    const solved = solveSpending({ ...PLANS.midCareer, lifeEvents: result.lifeEvents }, { floor: 0 });
    assert.equal(solved.best.monthlySpending, result.best.monthlySpending);
    assert.equal(solved.best.endingReal, result.best.endingReal);
    // And it can be posted to another thread.
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

await check('the changes listed are the changes made, and no others', () => {
    const plan = PLANS.midCareer;
    const result = searched('midCareer');
    assert.ok(result.changes.length > 0);
    const rule = (events, c) => events[c.phaseIdx].phaseTransfers[c.source]
        ?.find((r) => r.toDisplayName === c.target)?.monthlyMoveValue ?? 0;
    for (const c of result.changes) {
        assert.equal(rule(plan.lifeEvents, c), c.now, `${c.phase} ${c.source} → ${c.target} now`);
        assert.equal(rule(result.lifeEvents, c), c.proposed);
        assert.notEqual(c.now, c.proposed);
    }
    // Put each listed change back: the plan as entered, rule for rule.
    const back = JSON.parse(JSON.stringify(result.lifeEvents));
    for (const c of result.changes) {
        back[c.phaseIdx].phaseTransfers[c.source].find((r) => r.toDisplayName === c.target).monthlyMoveValue = c.now;
    }
    const live = (events) => events.map((e) => Object.fromEntries(Object.entries(e.phaseTransfers ?? {})
        .map(([name, rules]) => [name, rules.filter((r) => r.monthlyMoveValue > 0)
            .map((r) => `${r.toDisplayName}:${r.monthlyMoveValue}`).sort()])));
    assert.deepEqual(live(back), live(plan.lifeEvents));
});

// routing-legal
await check('no search, wherever it starts, makes a move the search may not make', () => {
    const plan = PLANS.midCareer;
    const starts = [{ start: 'plan', seed: 0 }, { start: 'near', seed: 2 }, { start: 'random', seed: 3 }];
    for (const search of starts) {
        const result = search.start === 'plan' ? searched('midCareer') : R.searchRouting(plan, search);
        assert.equal(result.lifeEvents.length, plan.lifeEvents.length);
        result.lifeEvents.forEach((event, phaseIdx) => {
            const early = plan.lifeEvents[phaseIdx].triggerAge < R.PENALTY_FREE_AGE;
            const was = plan.lifeEvents[phaseIdx].phaseTransfers ?? {};
            for (const [source, rules] of Object.entries(event.phaseTransfers ?? {})) {
                const s = instrumentOf(plan, source);
                const routed = InstrumentType.isMonthlyIncome(s) || InstrumentType.isMonthlyExpense(s);
                // Anything else, a home or an account among them, is as it was.
                if (!routed) { assert.deepEqual(rules, was[source], `${search.start}: ${source}`); continue; }
                const total = rules.reduce((sum, r) => sum + r.monthlyMoveValue, 0);
                assert.ok(total <= 100 + 1e-9, `${search.start}: ${source} sums to ${total}`);
                for (const r of rules) {
                    const t = instrumentOf(plan, r.toDisplayName);
                    const entered = was[source]?.find((w) => w.toDisplayName === r.toDisplayName)?.monthlyMoveValue ?? 0;
                    if (r.monthlyMoveValue === entered) continue;
                    const label = `${search.start}: ${event.displayName} ${source} → ${r.toDisplayName}`;
                    assert.ok(!InstrumentType.isRealEstate(t) && !InstrumentType.isMortgage(t) && !InstrumentType.isDebt(t), label);
                    if (InstrumentType.isMonthlyExpense(s)) assert.ok(!(early && isRetirement(t)), `${label}: an early draw`);
                    if (InstrumentType.isRetirementIncome(s)) assert.ok(!isRetirement(t), label);
                }
            }
        });
    }
});

// routing-repeats
await check('the same plan and search give the same result, and another seed starts elsewhere', () => {
    const plan = PLANS.retired;
    const once = R.searchRouting(plan, { start: 'random', seed: 3 });
    const again = R.searchRouting(plan, { start: 'random', seed: 3 });
    assert.deepEqual(again, once);
    // And it is pruned. Recorded 2026-11-13: the climb from this start leaves
    // six percentages changed, of which three carry the gain.
    assert.equal(once.changes.length, 3, 'the search did not prune its result');
    // Recorded 2026-11-13: seed 3 ends at $9,820, the climb from the plan at $9,782.
    assert.notDeepEqual(once.values, searched('retired').values);
    // A depth is only as wide as its searches are different: another seed, and
    // a start near the plan, each end somewhere of their own ($9,782, $9,806).
    assert.notDeepEqual(R.searchRouting(plan, { start: 'random', seed: 1 }).values, once.values);
    assert.notDeepEqual(R.searchRouting(plan, { start: 'near', seed: 2 }).values, searched('retired').values);
});

await check('with a floor, the search is for the most that leaves the floor', () => {
    const plan = PLANS.retired;
    const floor = 1_000_000;
    const asEntered = solveSpending(plan, { floor }).best.monthlySpending;
    const result = R.searchRouting(plan, { floor });
    assert.ok(result.best.endingReal >= floor);
    assert.ok(result.best.monthlySpending > asEntered + 50, `${result.best.monthlySpending} against ${asEntered}`);
    // Not the routing found without one.
    assert.notDeepEqual(result.values, searched('retired').values);
});

// polish-finishes
await check('after a climb no one-point move, alone or within a group, is a gain', () => {
    const plan = PLANS.retired;
    const map = R.routingGenes(plan);
    const ranker = R.makeRanker(plan, map);
    R.climb(map, ranker);
    assert.ok(ranker.edge > ranker.enteredLevel, 'the climb found nothing: the fixture proves nothing');
    const at = ranker.values.slice();
    const offer = (next) => {
        const fixed = R.repair(map, next);
        if (fixed.some((v, i) => v !== next[i])) return;
        assert.equal(ranker.offer(fixed), false, `a move to ${fixed} was a gain`);
    };
    map.genes.forEach((gene, i) => {
        for (const delta of [1, -1]) {
            const next = at.slice();
            next[i] += delta;
            if (next[i] >= 0 && next[i] <= 100) offer(next);
        }
        map.genes.forEach((other, j) => {
            if (j === i || other.group !== gene.group || at[j] < 1 || at[i] + 1 > 100) return;
            const next = at.slice();
            next[i] += 1;
            next[j] -= 1;
            offer(next);
        });
    });
    assert.deepEqual(ranker.values, at);
});

// prune-keeps-the-gain
await check('prune puts back what does not carry the gain, and keeps the level', () => {
    const plan = PLANS.retired;
    const map = R.routingGenes(plan);
    const ranker = R.makeRanker(plan, map);
    // A routing with a change that does nothing: Social Security is already
    // all paid into one account, so a climb from far away leaves noise.
    ranker.startFrom(map.genes.map((_, i) => (i * 37) % 100));
    R.climb(map, ranker);
    const climbed = ranker.values.slice();
    const pruned = R.prune(map, ranker);
    const changed = (values) => values.filter((v, i) => v !== ranker.entered[i]).length;
    assert.ok(changed(pruned) < changed(climbed), `${changed(climbed)} changes before, ${changed(pruned)} after`);
    // Every percentage it touched went back to the entered value.
    pruned.forEach((v, i) => assert.ok(v === climbed[i] || v === ranker.entered[i]));
    // The level is kept, less a thousandth of the gain.
    const slack = (ranker.edge - ranker.enteredLevel) * 0.001;
    assert.ok(ranker.holds(pruned, slack));
    assert.ok(R.scoreRouting(plan, map, pruned, ranker.edge - slack).unpaid <= R.TIE);
});

await check('a genetic search repeats from its seed and never loses the best it has', () => {
    const plan = PLANS.retired;
    const map = R.routingGenes(plan);
    const run = (seed) => {
        const ranker = R.makeRanker(plan, map);
        const edges = [];
        R.geneticSearch(map, ranker, { seed, start: 'random', population: 12, generations: 6,
            onGeneration: (_g, rk) => edges.push(rk.edge) });
        return { values: ranker.values, edge: ranker.edge, edges, entered: ranker.enteredLevel };
    };
    const a = run(5), b = run(5);
    assert.deepEqual(b, a);
    assert.equal(a.edges.length, 6);
    a.edges.forEach((edge, i) => assert.ok(edge >= (i ? a.edges[i - 1] : a.entered), 'the level fell'));
    assert.deepEqual(R.repair(map, a.values), a.values);
});

await check('a plan with nothing to route comes back as it is', () => {
    const plan = { ...PLANS.retired, lifeEvents: [] };
    const result = R.searchRouting(plan);
    assert.equal(result.genes, 0);
    assert.deepEqual(result.changes, []);
    assert.deepEqual(result.lifeEvents, []);
    assert.equal(result.best.monthlySpending, solveSpending(plan, { floor: 0 }).best.monthlySpending);
});

await check('a search reports its progress every 25 plan runs', () => {
    const seen = [];
    R.searchRouting(PLANS.retired, { onProgress: (p) => seen.push(p) });
    assert.ok(seen.length >= 4);
    seen.forEach((p, i) => assert.equal(p.runs, (i + 1) * 25));
    assert.ok(seen[seen.length - 1].gain > 0.01);
});

// ── Depth ────────────────────────────────────────────────────────────

// depth-adds-searches
await check('each depth holds the one before it and adds searches', () => {
    assert.deepEqual(R.DEPTHS.map((d) => R.searchesAt(d).length), [1, 5, 10, 20]);
    assert.ok(R.DEPTHS.includes(R.DEFAULT_DEPTH));
    assert.deepEqual(R.searchesAt(1), [{ start: 'plan', seed: 0 }]);
    for (let d = 1; d < R.DEPTHS.length; d++) {
        const shallow = R.searchesAt(R.DEPTHS[d - 1]), deep = R.searchesAt(R.DEPTHS[d]);
        assert.deepEqual(deep.slice(0, shallow.length), shallow);
    }
    const deepest = R.searchesAt(4).map((s) => `${s.start}:${s.seed}`);
    assert.equal(new Set(deepest).size, deepest.length);
    // The genetic searches are the last depth alone.
    assert.ok(R.searchesAt(3).every((s) => !s.start.startsWith('genetic')));
    assert.equal(R.searchesAt(4).filter((s) => s.start.startsWith('genetic')).length, 10);
});

await check('a genetic search is estimated at its 10,000 runs and a climb; a climb grows with the plan', () => {
    const climb = R.estimateRuns(30, { start: 'near', seed: 1 });
    assert.equal(R.estimateRuns(30, { start: 'genetic-plan', seed: 1 }), 10000 + climb);
    assert.ok(climb > R.estimateRuns(6, { start: 'plan', seed: 0 }));
    // Within a factor of three of what was measured (§8.7): 181 to 315 runs
    // for 13 percentages, 2,944 to 4,523 for 30.
    assert.ok(R.estimateRuns(13, { start: 'plan', seed: 0 }) < 315 * 3);
    assert.ok(climb > 2944 / 3 && climb < 4523 * 3);
});

// ── The list ─────────────────────────────────────────────────────────

const found = (start, seed, monthly, values) => ({ start, seed, values, changes: [], best: { monthlySpending: monthly } });

await check('the list is best first, and searches that found the same routing share a row', () => {
    const ranked = R.rankSearches([
        found('near', 2, 5000, [1, 2]),
        found('random', 1, 5200, [3, 4]),
        found('plan', 0, 5200, [3, 4]),
        found('near', 1, 5100, [5, 6]),
    ]);
    assert.deepEqual(ranked.rows.map((r) => r.monthly), [5200, 5100, 5000]);
    assert.deepEqual(ranked.rows[0].starts, [{ start: 'plan', seed: 0 }, { start: 'random', seed: 1 }]);
    assert.equal(ranked.rows[0].result.start, 'plan');
    assert.equal(ranked.searches, 4);
});

await check('the list is the same whatever order the searches finished in', () => {
    const results = [found('near', 3, 5000, [1]), found('random', 2, 5000, [2]), found('plan', 0, 5000, [3]), found('near', 1, 4000, [4])];
    const keys = (list) => R.rankSearches(list).rows.map((r) => r.key);
    assert.deepEqual(keys(results), ['3', '1', '2', '4']);
    assert.deepEqual(keys(results.slice().reverse()), keys(results));
});

await check('a search that found nothing fundable ranks last and agrees with no one', () => {
    const ranked = R.rankSearches([{ ...found('random', 1, 0, [9]), best: null }, found('plan', 0, 5000, [1])]);
    assert.deepEqual(ranked.rows.map((r) => r.monthly), [5000, 0]);
    assert.equal(ranked.agreeing, 1);
});

// disagreement-is-reported
await check('the line under the list says how many searches reached the best', () => {
    const line = (monthlies) => Report.agreementLine(R.rankSearches(
        monthlies.map((m, i) => found(i ? 'near' : 'plan', i, m, [i]))));
    assert.equal(line([5000, 4990, 4960, 4951, 4950]), 'All 5 searches came within 1% of the best.');
    assert.equal(line([5000, 4990, 4949, 4700, 4000]), '2 of 5 searches came within 1% of the best.');
    // Two separated bests: one search alone at the top is said to be alone.
    assert.equal(line([5000, 4700, 4700, 4700, 4700]),
        'No other search came within 1% of the best. A deeper search may find more.');
    assert.match(line([5000]), /^One search, with nothing to compare it to/);
    assert.equal(Report.agreementLine(R.rankSearches([])), '');
});

await check('a best that stands alone is marked; one that others reached, or a single search, is not', () => {
    const lone = (monthlies) => Report.isLoneBest(R.rankSearches(
        monthlies.map((m, i) => found(i ? 'near' : 'plan', i, m, [i]))));
    assert.equal(lone([5000, 4700, 4700, 4700, 4700]), true);
    assert.equal(lone([5000, 4949]), true);
    // Within 1% of the best is company.
    assert.equal(lone([5000, 4951, 4000]), false);
    assert.equal(lone([5000, 5000]), false);
    // One search has nothing to stand apart from, and the line under the list says so.
    assert.equal(lone([5000]), false);
    assert.equal(lone([]), false);
    // Nothing fundable anywhere is not a find.
    assert.equal(Report.isLoneBest(R.rankSearches(
        [{ ...found('plan', 0, 0, [1]), best: null }, { ...found('near', 1, 0, [2]), best: null }])), false);
    assert.match(Report.LONE_BEST_NOTE, /No other search came within 1%/);
});

// ── The words ────────────────────────────────────────────────────────

await check('a row names where its searches started', () => {
    assert.equal(Report.startsLabel([{ start: 'plan', seed: 0 }]), 'Your plan');
    assert.equal(Report.startsLabel([{ start: 'random', seed: 2 }, { start: 'near', seed: 1 }, { start: 'plan', seed: 0 }, { start: 'near', seed: 4 }]),
        'Your plan, Near your plan ×2, A random routing');
    for (const search of R.searchesAt(4)) assert.ok(Report.startsLabel([search]).length > 0, search.start);
    for (const depth of R.DEPTHS) assert.ok(Report.DEPTH_NOTES[depth]);
});

await check('the cost of a depth is said before it is run', () => {
    assert.equal(Report.costLine({ searches: 10, runs: 6760, seconds: null }), '10 searches, about 7,000 runs of your plan');
    assert.equal(Report.costLine({ searches: 1, runs: 676, seconds: null }), '1 search, about 700 runs of your plan');
    assert.equal(Report.costLine({ searches: 10, runs: 6760, seconds: 31 }), '10 searches, about 30 seconds on this machine');
    assert.equal(Report.costLine({ searches: 20, runs: 1e5, seconds: 400 }), '20 searches, about 7 minutes on this machine');
    assert.equal(Report.duration(4), 'a few seconds');
    assert.equal(Report.duration(3600 * 2.2), '2 hours');
});

await check('an income reads from the income to the account, an expense from the account to the expense', () => {
    const rows = Report.changeRows([
        { phaseIdx: 1, phase: 'Retire', source: 'Rent', kind: 'expense', target: '401K', now: 10, proposed: 29 },
        { phaseIdx: 0, phase: 'Accumulate', source: 'Salary', kind: 'income', target: 'Roth IRA', now: 2.5, proposed: 0 },
    ]);
    assert.deepEqual(rows, [
        { phase: 'Accumulate', from: 'Salary', to: 'Roth IRA', now: '2.5%', proposed: '0%' },
        { phase: 'Retire', from: '401K', to: 'Rent', now: '10%', proposed: '29%' },
    ]);
});

await check('the headline and the list say the gain against the plan as entered', () => {
    const result = { best: { monthlySpending: 5627 }, changes: [{}] };
    assert.equal(Report.routingHeadline(result, 5316.4),
        'With this routing the plan could spend $5,627 a month, $311 more than the most it can with yours.');
    assert.equal(Report.routingHeadline(result, 0), 'With this routing the plan could spend $5,627 a month.');
    assert.match(Report.routingHeadline({ ...result, best: { monthlySpending: 5000 } }, 5316), /\$316 less than/);
    assert.match(Report.routingHeadline({ ...result, changes: [] }, 5316), /found no routing/);
    assert.match(Report.routingHeadline({ best: null, changes: [{}] }, 5316), /no spending level/);
    assert.equal(Report.versusEntered(5627, 5316), '+$311/mo (+5.9%)');
    assert.equal(Report.versusEntered(5000, 5316), '−$316/mo (−5.9%)');
    assert.equal(Report.versusEntered(5316.3, 5316), 'the same');
    assert.equal(Report.versusEntered(5627, 0), '');
});

await check('the selected routing is a third column of the spending table, row for row', () => {
    const solved = solveSpending(PLANS.midCareer, { floor: 0 });
    const routed = searched('midCareer').best;
    const two = resultRows(solved);
    const three = resultRows(solved, routed);
    assert.ok(two.every((row) => !('routed' in row)));
    assert.deepEqual(three.map(({ routed: _r, ...rest }) => rest), two);
    const cell = (label) => three.find((row) => row.label === label).routed;
    assert.equal(cell('Monthly spending'), `$${Math.round(routed.monthlySpending).toLocaleString('en-US')}/mo`);
    assert.equal(cell('Runs out'), 'never');
    assert.notEqual(cell('Monthly spending'), three.find((row) => row.label === 'Monthly spending').best);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
