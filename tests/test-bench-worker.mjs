/**
 * test-bench-worker.mjs
 *
 * The Test Bench's spending solver and its routing searches run in the shared
 * simulation worker (js/mc-worker.js, kinds 'spending' and 'routing'). This
 * drives the worker's real message handler, with a stand-in for the Worker
 * context, and checks, for each kind, that:
 *
 *   - the handler answers a 'spending' payload with the solver's result;
 *   - it solves under the settings the payload carries, not the worker's
 *     defaults. A worker boots without localStorage, so a handler that skipped
 *     `global_applyWorkerSnapshot` would solve some other household's plan and
 *     still return a result that looks fine.
 *
 * The clock is pinned: quick-start dates come from `new Date()`.
 *
 * Usage:  node tests/test-bench-worker.mjs   (from src/)
 */

import assert from 'node:assert/strict';
import './tools/localstorage-polyfill.js';

const RealDate = Date;
const PINNED = '2026-11-15T12:00:00Z';
globalThis.Date = class extends RealDate {
    constructor(...args) { return args.length ? new RealDate(...args) : new RealDate(PINNED); }
    static now() { return new RealDate(PINNED).getTime(); }
};

// The Worker context the handler posts to. Set before the module loads: it
// installs its handler only when it finds one.
const posted = [];
globalThis.self = { postMessage: (message) => posted.push(message) };

const { planFromProfile } = await import('../js/mcp/run-plan.js');
const { solveSpending } = await import('../js/spending-solver.js');
const { searchRouting } = await import('../js/routing-search.js');
const globals = await import('../js/globals.js');
await import('../js/mc-worker.js');

let passed = 0, failed = 0;
async function check(label, fn) {
    try { await fn(); passed++; console.log(`  ok   ${label}`); }
    catch (err) { failed++; console.log(`  FAIL ${label}\n       ${err.message}`); }
}

/** Send one payload through the worker's handler and return what it posted. */
async function send(payload) {
    posted.length = 0;
    await globalThis.self.onmessage({ data: payload });
    return posted.slice();
}

/** The settings a main thread on this plan would send. */
function snapshotFor(spec, overrides = {}) {
    return {
        ...globals.global_workerSnapshot(),
        inflationRate: spec.settings.inflationRate,
        filingAs: spec.settings.filingAs,
        userStartAge: spec.settings.startAge,
        userRetirementAge: spec.settings.retirementAge,
        userFinishAge: spec.settings.finishAge,
        backtestYear: 'current',
        ...overrides,
    };
}

console.log('test-bench-worker');

const spec = planFromProfile('retired');
const payload = (settings, limits = { floor: 0 }) => ({
    kind: 'spending',
    settings,
    modelAssets: JSON.parse(JSON.stringify(spec.modelAssets)),
    lifeEvents: spec.lifeEvents ?? [],
    backtestYear: 'current',
    limits,
});

let answer = null;

await check("a 'spending' payload is answered with the solver's result", async () => {
    const messages = await send(payload(snapshotFor(spec)));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].action, 'complete', messages[0].message);
    answer = messages[0].results;
    assert.ok(answer.best.factor > 0);
    assert.equal(answer.curve.length, 40);
    // Posted to another thread: nothing in it may be a live object.
    assert.deepEqual(JSON.parse(JSON.stringify(answer)), answer);
});

await check('it is the result of solving under the settings the payload carried', async () => {
    // The handler left the payload's settings in force; solve here under them.
    const direct = solveSpending({
        modelAssets: spec.modelAssets,
        lifeEvents: spec.lifeEvents ?? [],
        config: globals.simConfigFromGlobals(),
    }, { floor: 0 });
    assert.equal(answer.best.factor, direct.best.factor);
    assert.equal(answer.asEntered.endingReal, direct.asEntered.endingReal);
});

await check('other settings in the payload give another answer', async () => {
    const longer = await send(payload(snapshotFor(spec, { userFinishAge: spec.settings.finishAge + 5 })));
    assert.equal(longer[0].action, 'complete', longer[0].message);
    assert.notEqual(longer[0].results.asEntered.lifetimeSpending, answer.asEntered.lifetimeSpending);
    assert.ok(longer[0].results.best.factor < answer.best.factor,
        'five more years to pay for did not lower what the plan can spend');
});

await check('the floor in the payload is the floor that is solved for', async () => {
    const floor = Math.round(answer.asEntered.endingReal);
    const held = await send(payload(snapshotFor(spec), { floor }));
    assert.equal(held[0].results.limits.floor, floor);
    assert.ok(held[0].results.best.factor < answer.best.factor);
    assert.ok(held[0].results.best.endingReal >= floor);
});

// ── A routing search ─────────────────────────────────────────────────

const routing = (settings, search = { start: 'near', seed: 2 }, limits = { floor: 0 }) => ({
    ...payload(settings, limits), kind: 'routing', search,
});
let routed = null;

await check("a 'routing' payload is answered with one search's result, after its progress", async () => {
    const messages = await send(routing(snapshotFor(spec)));
    const last = messages[messages.length - 1];
    assert.equal(last.action, 'complete', last.message);
    routed = last.results;
    assert.equal(routed.start, 'near');
    assert.equal(routed.seed, 2);
    assert.ok(routed.best.monthlySpending > answer.best.monthlySpending);
    assert.deepEqual(JSON.parse(JSON.stringify(routed)), routed);

    const progress = messages.slice(0, -1);
    assert.ok(progress.length >= 4);
    progress.forEach((m, i) => {
        assert.equal(m.action, 'progress');
        assert.equal(m.runs, (i + 1) * 25);
        assert.equal(typeof m.gain, 'number');
    });
});

await check('it is the search the payload named, under the settings it carried', async () => {
    const plan = { modelAssets: spec.modelAssets, lifeEvents: spec.lifeEvents ?? [], config: globals.simConfigFromGlobals() };
    assert.deepEqual(searchRouting(plan, { start: 'near', seed: 2 }), routed);
    // Another search of the same plan is another result.
    const other = await send(routing(snapshotFor(spec), { start: 'random', seed: 3 }));
    assert.notDeepEqual(other[other.length - 1].results.values, routed.values);
});

await check('other settings, or a floor, in a routing payload give another answer', async () => {
    const longer = await send(routing(snapshotFor(spec, { userFinishAge: spec.settings.finishAge + 5 })));
    const longerResult = longer[longer.length - 1].results;
    assert.ok(longerResult.best.monthlySpending < routed.best.monthlySpending,
        'five more years to pay for did not lower what the routed plan can spend');

    const floor = 1_000_000;
    const held = await send(routing(snapshotFor(spec), { start: 'near', seed: 2 }, { floor }));
    const heldResult = held[held.length - 1].results;
    assert.ok(heldResult.best.endingReal >= floor);
    assert.ok(heldResult.best.monthlySpending < routed.best.monthlySpending);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
