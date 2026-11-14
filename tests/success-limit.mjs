/**
 * success-limit.mjs — "and lasts in at least ___% of simulated markets"
 * (js/success-limit.js, spec 15 §7).
 *
 * ── What this guards ─────────────────────────────────────────────────
 *
 * The limit turns the spending solver's answer down until the plan lasts in a
 * stated share of simulated markets. It is on by default, so it decides the
 * headline figure of the Test Bench. Four things about it are load-bearing:
 *
 *   - its answer is a limit: the plan lasts in the target share there, and
 *     not at the next level tested;
 *   - it only ever lowers the answer, and the answer still keeps the floor;
 *   - it rests on the rate never rising with spending. That is measured here
 *     on a real plan, because halving an interval is wrong without it;
 *   - the rate is the Simulations section's own: the same markets (seed),
 *     from retirement, without guardrails, in the chosen data mode. A rate
 *     measured any other way would disagree with the row beside it.
 *
 * The search itself is checked on rate curves written by hand, which run in
 * milliseconds; the real plan is run across a smaller set of markets than the
 * app uses, to keep this suite to about a minute.
 *
 * The clock is pinned: quick-start dates come from `new Date()`.
 *
 * Usage:  node tests/success-limit.mjs   (from src/)
 */

import assert from 'node:assert/strict';
import './tools/localstorage-polyfill.js';
import { planFromProfile, simConfigFromPlanSpec } from '../js/mcp/run-plan.js';
import { solveSpending, columnAt, scaledAssets } from '../js/spending-solver.js';
import { limitBySuccess, simulatedRate, SUCCESS_STEPS, SUCCESS_WITHIN } from '../js/success-limit.js';
import { whatStopsYou, successNote } from '../js/spending-report.js';
import { computeMonteCarlo } from '../js/mc-compute.js';
import { ModelAsset } from '../js/model-asset.js';
import { ModelLifeEvent } from '../js/life-event.js';
import { Portfolio } from '../js/portfolio.js';
import { DateInt } from '../js/utils/date-int.js';
import { ageToDateIntFor } from '../js/plan-dates.js';

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

const SPEC = at('2026-11-15T12:00:00Z', () => planFromProfile('midCareer'));
const freshConfig = () => simConfigFromPlanSpec(SPEC);
const PLAN = { modelAssets: SPEC.modelAssets, lifeEvents: SPEC.lifeEvents ?? [], config: freshConfig() };
const RETIREMENT = ageToDateIntFor(
    new Portfolio(PLAN.modelAssets.map((a) => ModelAsset.fromJSON(a)), false, freshConfig()).config,
    SPEC.settings.retirementAge).toInt();

/** The app's markets, fewer of them. */
const SIM = { markets: 120, seed: 1, dataMode: 'calibrated', backtestFromYear: null, retirementDateInt: RETIREMENT };

const SOLVED = solveSpending(PLAN, { floor: 0 });
const CEILING = SOLVED.best.factor;
const BOTTOM = SOLVED.curve[0].factor;

/** A rate curve written by hand: `high` up to and including `edge`, `low` past it. */
const step = (edge, high = 0.95, low = 0.8) => (factor) => Promise.resolve(factor <= edge ? high : low);
/** limitBySuccess on the real plan with a hand-written rate curve, counting what it measured. */
async function limited(rateAt, options = {}) {
    const asked = [];
    const result = await limitBySuccess(PLAN, options.solved ?? SOLVED, {
        target: 0.9, markets: 300, ...options,
        rateAt: (f) => { asked.push(f); return rateAt(f); },
    });
    return { result, asked };
}

console.log('success-limit');

// ── The search, on rate curves written by hand ──────────────────────

await check('a plan that lasts at the ceiling keeps its answer, after one measurement', async () => {
    const { result, asked } = await limited(step(99));
    assert.deepEqual(asked, [CEILING]);
    assert.equal(result.best, SOLVED.best);
    assert.equal(result.boundBy, SOLVED.boundBy);
    assert.equal('fixedBest' in result, false);
    assert.equal(result.limits.success, 0.9);
    assert.equal(result.limits.floor, 0);
    assert.equal(result.success.bestRate, 0.95);
    assert.equal(result.success.tested, 1);
});

// limit-is-a-limit
await check('the answer is the highest level that lasts, to within half a percent of spending', async () => {
    for (const edge of [0.61, 0.8317, 0.97]) {
        const { result, asked } = await limited(step(edge));
        assert.ok(result.best.factor <= edge, `edge ${edge}: answered ${result.best.factor}`);
        assert.ok(edge - result.best.factor <= SUCCESS_WITHIN, `edge ${edge}: answered ${result.best.factor}`);
        assert.ok(asked.length <= SUCCESS_STEPS + 3, `${asked.length} measurements`);
        assert.equal(result.boundBy.kind, 'success');
        assert.equal(result.boundBy.rate, 0.8);
        assert.equal(result.boundBy.noLevelPasses, false);
        assert.equal(result.success.bestRate, 0.95);
        assert.equal(result.fixedBest, SOLVED.best);
        // The column is the plan run at that level.
        assert.equal(result.best.monthlySpending, columnAt(PLAN, result.best.factor).monthlySpending);
        assert.ok(result.best.monthlySpending < SOLVED.best.monthlySpending);
    }
});

await check('it never answers above the ceiling, and starts from what was entered when that lasts', async () => {
    // Lasts as entered, not at the ceiling: the answer lies between the two.
    assert.ok(CEILING > 1.01, 'the fixture no longer has room above what was entered');
    const edge = (1 + CEILING) / 2;
    const { result, asked } = await limited(step(edge));
    assert.deepEqual(asked.slice(0, 2), [CEILING, 1]);
    assert.ok(asked.every((f) => f >= 1 && f <= CEILING), 'a level outside the interval was measured');
    assert.ok(result.best.factor >= 1 && result.best.factor <= edge);
});

await check('a plan under the limit as entered is answered below what was entered', async () => {
    const { result, asked } = await limited(step(0.9));
    assert.deepEqual(asked.slice(0, 3), [CEILING, 1, BOTTOM]);
    assert.ok(result.best.factor < 1);
    assert.ok(result.best.monthlySpending < SOLVED.asEntered.monthlySpending);
});

await check('when no level lasts there is no answer, and the result says which rate the lowest reached', async () => {
    const { result, asked } = await limited(() => Promise.resolve(0.42));
    assert.deepEqual(asked, [CEILING, 1, BOTTOM]);
    assert.equal(result.best, null);
    assert.equal(result.fixedBest, SOLVED.best);
    assert.deepEqual(result.boundBy, { kind: 'success', target: 0.9, markets: 300, rate: 0.42, noLevelPasses: true });
    assert.equal(whatStopsYou(result).text,
        'No spending level tested lasts in 90% of 300 simulated markets. The lowest lasts in 42%.');
});

await check('a rate exactly at the target lasts; just under it does not', async () => {
    const atTarget = await limited(() => Promise.resolve(0.9));
    assert.equal(atTarget.result.best, SOLVED.best);
    const under = await limited(() => Promise.resolve(0.8999));
    assert.equal(under.result.best, null);
});

// known-rates-are-used
await check('rates already measured are not measured again, at this target or another', async () => {
    const first = await limited(step(0.8317));
    const again = await limited(step(0.8317), { known: first.result.success.rates });
    assert.deepEqual(again.asked, []);
    assert.equal(again.result.best.factor, first.result.best.factor);
    assert.equal(again.result.success.tested, 0);

    // A level below one known to last is known to last; above one known not to, known not to.
    const { result, asked } = await limited(step(0.8317), { known: [[0.7, 0.95], [0.9, 0.8]] });
    assert.ok(asked.every((f) => f > 0.7 && f < 0.9), `measured ${asked}`);
    assert.ok(Math.abs(result.best.factor - first.result.best.factor) <= SUCCESS_WITHIN);
    // A ceiling at or below a level known to last needs no market at all: the
    // case of a click on the curve, which lowers the ceiling.
    const below = await limited(step(99), { known: [[CEILING + 0.2, 0.93]] });
    assert.deepEqual(below.asked, []);
    assert.equal(below.result.best, SOLVED.best);

    // The rates handed back include the ones handed in.
    assert.ok(result.success.rates.some(([f, r]) => f === 0.7 && r === 0.95));
});

// limit-keeps-the-floor
await check('the answer keeps the floor the solver was given', async () => {
    const floor = 1_200_000;
    const solved = solveSpending(PLAN, { floor });
    const { result } = await limited(step(solved.best.factor - 0.1), { solved });
    assert.equal(result.limits.floor, floor);
    assert.ok(result.best.endingReal >= floor);
    assert.ok(result.best.factor < solved.best.factor);
});

await check('if the level found breaks the floor, the highest scanned level below it that keeps it is the answer', async () => {
    // What is left does not always fall as spending rises (spec 15 §2.1). A
    // curve written to rise: only the two lowest scanned levels leave the floor.
    const floor = SOLVED.best.endingReal * 100;
    const curve = SOLVED.curve.map((p, i) => ({ ...p, endingReal: i < 2 ? floor + 1 : p.endingReal }));
    const { result } = await limited(step(0.9), { solved: { ...SOLVED, limits: { floor }, curve } });
    assert.equal(result.best.factor, curve[1].factor);
    assert.equal(result.boundBy.kind, 'success');

    // And when none does, there is no answer.
    const none = await limited(step(0.9), { solved: { ...SOLVED, limits: { floor } } });
    assert.equal(none.result.best, null);
    assert.equal(none.result.boundBy.noLevelPasses, true);
});

await check('a plan with no answer on its own path is left as it is', async () => {
    const { result, asked } = await limited(step(99), { solved: { ...SOLVED, best: null } });
    assert.deepEqual(asked, []);
    assert.equal(result.best, null);
    assert.equal(result.boundBy, SOLVED.boundBy);
});

await check('each measurement is reported as it is made', async () => {
    const steps = [];
    await limited(step(0.8317), { onStep: (s) => steps.push(s) });
    assert.ok(steps.length >= 4);
    steps.forEach((s, i) => {
        assert.equal(s.tested, i + 1);
        assert.equal(s.rate, s.factor <= 0.8317 ? 0.95 : 0.8);
    });
});

// ── The words ────────────────────────────────────────────────────────

await check('what stops it names the limit, and the note says what the limit cost', async () => {
    const { result } = await limited(step(0.8317, 0.95, 0.8866));
    assert.equal(whatStopsYou(result).text,
        'Spend more and the plan lasts in fewer than 90% of 300 simulated markets (88% at the next level tested).');
    const cost = Math.round(SOLVED.best.monthlySpending) - Math.round(result.best.monthlySpending);
    const note = successNote(result);
    assert.match(note, /^On the plan's own path of returns it could spend \$[\d,]+ a month\./);
    assert.ok(note.includes(`$${Math.round(SOLVED.best.monthlySpending).toLocaleString('en-US')} a month`));
    assert.match(note, /Lasting in 90% of simulated markets costs \$[\d,]+ a month of that\.$/);
    const said = Number(note.match(/costs \$([\d,]+)/)[1].replace(/,/g, ''));
    assert.ok(Math.abs(said - cost) <= 1, `note says ${said}, the columns differ by ${cost}`);
});

await check('when the limit does not bind the note says so, with the rate, rounded down', async () => {
    const { result } = await limited(() => Promise.resolve(0.9366));
    assert.match(successNote(result), /^The 90% limit did not bind: at this spending the plan lasts in 93% of 300 simulated markets\./);
    assert.match(successNote(result), /net worth stays above \$0, retirement accounts included/);
    assert.equal(successNote(SOLVED), null);
});

// ── The rate, on a real plan ────────────────────────────────────────

const RATES = {};
const rate = async (factor, sim = SIM) => {
    const key = JSON.stringify([factor, sim]);
    return (RATES[key] ??= await simulatedRate(PLAN, factor, sim));
};

await check("the rate is the Simulations section's: same markets, from retirement, no guardrails", async () => {
    const direct = await computeMonteCarlo(
        scaledAssets(PLAN.modelAssets, 1).map((a) => ModelAsset.fromJSON(a)), {
            numSimulations: SIM.markets, guardrailParams: null, retirementDateInt: new DateInt(RETIREMENT),
            runFromStart: false, lifeEvents: PLAN.lifeEvents.map((e) => ModelLifeEvent.fromJSON(e)),
            dataMode: 'calibrated', backtestFromYear: null, seed: 1, config: freshConfig(),
        });
    assert.equal(await rate(1), direct.successRate);
    assert.ok(direct.successRate > 0.5 && direct.successRate < 1, `rate ${direct.successRate}: the fixture pins nothing`);
});

// rate-repeats
await check('the same seed gives the same rate; the seed, the data and the era each change the markets', async () => {
    assert.equal(await simulatedRate(PLAN, 1, SIM), await rate(1));
    const differs = async (change) => (await rate(1, { ...SIM, ...change })) !== (await rate(1));
    assert.ok(await differs({ seed: 2 }), 'another seed gave the same rate');
    assert.ok(await differs({ dataMode: 'historical' }), 'another data mode gave the same rate');
    assert.ok(await differs({ backtestFromYear: 1990 }), 'another era gave the same rate');
});

await check('the spending level is the level simulated', async () => {
    assert.ok(await rate(BOTTOM) > await rate(CEILING));
});

// rate-never-rises
await check('the rate never rises with spending, across the range', async () => {
    const levels = [BOTTOM, 0.7, 0.85, 0.95, 1, CEILING];
    const rates = [];
    for (const f of levels) rates.push(await rate(f));
    rates.forEach((r, i) => assert.ok(i === 0 || r <= rates[i - 1], `rates ${rates} at levels ${levels}`));
    assert.ok(rates[0] - rates[rates.length - 1] > 0.05, `rates ${rates}: too flat to pin anything`);
});

await check('simulating a plan leaves it as it was', async () => {
    const before = JSON.stringify([PLAN.modelAssets, PLAN.lifeEvents]);
    await rate(1);
    assert.equal(JSON.stringify([PLAN.modelAssets, PLAN.lifeEvents]), before);
    const again = solveSpending(PLAN, { floor: 0 });
    assert.equal(again.best.factor, SOLVED.best.factor);
    assert.equal(again.asEntered.endingReal, SOLVED.asEntered.endingReal);
});

await check('on the real plan, at 90%: the answer lasts, the next level tested does not, and it is below the ceiling', async () => {
    assert.ok(await rate(CEILING) < 0.9, 'the plan now lasts at its ceiling: pick another target for this check');
    const result = await limitBySuccess(PLAN, SOLVED, { target: 0.9, markets: SIM.markets, rateAt: (f) => rate(f) });
    assert.equal(result.boundBy.kind, 'success');
    assert.ok(result.best.factor < CEILING);
    assert.ok(result.success.bestRate >= 0.9);
    assert.equal(result.success.bestRate, await rate(result.best.factor));
    assert.ok(result.boundBy.rate < 0.9);
    assert.ok(!result.best.runsOut && result.best.endingReal >= 0);
    // The gap between the two is the half percent the search stops at.
    const failing = result.success.rates.filter(([, r]) => r < 0.9).map(([f]) => f);
    assert.ok(Math.min(...failing) - result.best.factor <= SUCCESS_WITHIN);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
