/**
 * mc-seeded-draws.mjs
 *
 * The app's Monte Carlo is seeded, so its answer changes only when the plan
 * does.
 *
 * The simulations re-run on every plan change. With unseeded draws, an edit
 * that changes nothing the simulations read would still move the success rate
 * and the median by sampling noise, and the user would reasonably take that as
 * the edit's effect.
 *
 *   SAME SEED, SAME ANSWER   a seeded run is reproducible to the last band.
 *
 *   NO LEAK                  a seeded run never calls Math.random. A single
 *                            draw site left on the default would make the
 *                            answer quietly nondeterministic again, and
 *                            "same seed, same answer" could still pass on a
 *                            plan that happens not to reach that site.
 *
 *   OPT-IN                   without a seed, Math.random is used as before:
 *                            the MCP path and the calibration test rely on it.
 *
 *   THE WORKER               the real worker handler forwards the seed. The
 *                            app only ever runs Monte Carlo through it, and a
 *                            dropped field would be silent.
 *
 * Per-run seeding (runRandom(seed, i)) keeps run i on the same sequence of
 * historical years whatever the plan's retirement date, so two versions of a
 * plan are compared on the same draws.
 *
 * Run: node tests/mc-seeded-draws.mjs   (from src/)
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import './tools/localstorage-polyfill.js';
import { ModelAsset } from '../js/model-asset.js';
import {
    global_reset, global_setUserStartAge, global_setUserRetirementAge,
    setActiveTaxTable, makeActiveTaxTable, simConfigFromGlobals, global_workerSnapshot,
} from '../js/globals.js';
import { computeMonteCarlo, runRandom } from '../js/mc-compute.js';

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); failed++; }
}

const START = { year: 2026, month: 1 }, END = { year: 2040, month: 12 };
const A = (x) => ({ startDateInt: START, finishDateInt: END, ...x });

// Two randomised asset kinds (equity and bond) and an inflating expense, so
// every branch of applyRandomRates draws.
const PLAN = [
    A({ instrument: 'taxableEquity', displayName: 'Brokerage', annualReturnRate: { rate: 0.07 },
        startCurrency: { amount: 900_000 }, startBasisCurrency: { amount: 600_000 } }),
    A({ instrument: 'usBond', displayName: 'Treasuries', annualReturnRate: { rate: 0.04 },
        startCurrency: { amount: 200_000 }, startBasisCurrency: { amount: 200_000 } }),
    A({ instrument: 'bank', displayName: 'Checking', annualReturnRate: { rate: 0.01 },
        startCurrency: { amount: 50_000 }, startBasisCurrency: { amount: 50_000 } }),
    A({ instrument: 'monthlyExpense', displayName: 'Living',
        startCurrency: { amount: -4000 }, startBasisCurrency: { amount: 0 },
        fundTransfers: [{ toDisplayName: 'Checking', monthlyMoveValue: 100, closeMoveValue: 0 }] }),
];
const assets = () => PLAN.map(ModelAsset.fromJSON);

global_reset();
global_setUserStartAge(60);
global_setUserRetirementAge(60);
setActiveTaxTable(makeActiveTaxTable());
const config = simConfigFromGlobals();

const N = 40;
const run = (opts) => computeMonteCarlo(assets(), {
    config, numSimulations: N, retirementDateInt: null, lifeEvents: [], ...opts,
});
const answer = (mc) => ({ bands: mc.bandData, real: mc.bandDataReal, success: mc.successRate });

/** Run fn with Math.random replaced; restore it whatever happens. */
async function withRandom(replacement, fn) {
    const real = Math.random;
    Math.random = replacement;
    try { return await fn(); } finally { Math.random = real; }
}

// ── the generator ────────────────────────────────────────────────────

console.log('\n── runRandom ──\n');

await test('no seed means Math.random itself', () => {
    assert.equal(runRandom(null, 0), Math.random);
    assert.equal(runRandom(undefined, 7), Math.random);
});

await test('a (seed, run) pair always gives the same stream, in [0, 1)', () => {
    const a = runRandom(1, 3), b = runRandom(1, 3);
    for (let k = 0; k < 200; k++) {
        const x = a();
        assert.equal(x, b());
        assert.ok(x >= 0 && x < 1, `draw ${x} outside [0, 1)`);
    }
});

await test('different runs and different seeds give different streams', () => {
    const first = (seed, i) => Array.from({ length: 8 }, runRandom(seed, i));
    assert.notDeepEqual(first(1, 0), first(1, 1));
    assert.notDeepEqual(first(1, 0), first(2, 0));
});

// ── the computation ──────────────────────────────────────────────────

console.log('\n── computeMonteCarlo ──\n');

for (const dataMode of ['historical', 'calibrated']) {
    await test(`${dataMode}: the same seed gives the same answer`, async () => {
        const a = await run({ seed: 1, dataMode });
        const b = await run({ seed: 1, dataMode });
        assert.deepEqual(answer(a), answer(b));
    });

    await test(`${dataMode}: a seeded run never calls Math.random`, async () => {
        await withRandom(() => { throw new Error('Math.random called during a seeded run'); },
            () => run({ seed: 1, dataMode }));
    });
}

await test('the seed matters: another seed gives another sample', async () => {
    const a = await run({ seed: 1 });
    const b = await run({ seed: 2 });
    assert.notDeepEqual(a.bandData, b.bandData);
});

await test('without a seed, Math.random is used as before', async () => {
    let calls = 0;
    await withRandom(() => { calls++; return 0.5; }, () => run({}));
    // One draw per run per year, from the first year.
    assert.ok(calls >= N, `Math.random called ${calls} times for ${N} runs`);
});

// ── the worker ───────────────────────────────────────────────────────

console.log('\n── mc-worker.js ──\n');

// The handler installs itself only inside a Worker, which it detects by
// `self.postMessage`. Provide one, then import it.
const inbox = [];
globalThis.self = { postMessage: (msg) => inbox.push(msg) };
await import('../js/mc-worker.js');
assert.equal(typeof self.onmessage, 'function', 'mc-worker.js did not install its handler');

/** Post a payload shaped like monte-carlo.js builds it; resolve with the result. */
async function viaWorker(extra) {
    inbox.length = 0;
    await self.onmessage({ data: {
        settings: global_workerSnapshot(),
        modelAssets: JSON.parse(JSON.stringify(assets())),
        lifeEvents: [],
        guardrailParams: null,
        retirementDateInt: null,
        runFromStart: true,
        numSimulations: N,
        backtestYear: 'current',
        interimEvery: null,
        dataMode: 'historical',
        backtestFromYear: null,
        ...extra,
    } });
    const done = inbox.find((m) => m.action === 'complete' || m.action === 'error');
    assert.ok(done, 'the worker posted neither complete nor error');
    assert.equal(done.action, 'complete', done.message);
    return done.results;
}

await test('the worker forwards the seed: same seed, same answer, no Math.random', async () => {
    const a = await viaWorker({ seed: 1 });
    const b = await withRandom(() => { throw new Error('Math.random called in a seeded worker run'); },
        () => viaWorker({ seed: 1 }));
    assert.deepEqual(answer(a), answer(b));
});

await test('the worker without a seed still draws from Math.random', async () => {
    let calls = 0;
    await withRandom(() => { calls++; return 0.5; }, () => viaWorker({}));
    assert.ok(calls >= N, `Math.random called ${calls} times`);
});

// ── the app ──────────────────────────────────────────────────────────

console.log('\n── monte-carlo.js ──\n');

await test('the app seeds both the worker run and the main-thread fallback', () => {
    // monte-carlo.js needs a DOM and Chart.js, so this one is read, not run.
    const src = readFileSync('js/monte-carlo.js', 'utf8');
    assert.match(src, /const MC_SEED = \d+;/, 'no MC_SEED constant');
    const uses = src.match(/seed: MC_SEED/g) ?? [];
    assert.equal(uses.length, 2, `expected the seed in both run paths, found ${uses.length}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
