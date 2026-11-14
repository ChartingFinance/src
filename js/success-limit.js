/**
 * success-limit.js
 *
 * The Test Bench's third limit: "and lasts in at least ___% of simulated
 * markets" (spec 15 §7).
 *
 * The spending solver answers for one fixed path of returns, and at the most
 * a plan can spend there it has no margin: measured on the quick-starts, such
 * a plan lasts in about half of simulated markets. This limit turns the
 * answer down until the plan lasts in the share of markets the user asks for.
 *
 * ── How ──────────────────────────────────────────────────────────────
 *
 * The solver's answer is the ceiling: no level above it keeps the other
 * limits. If the plan lasts in enough markets there, nothing changes.
 * Otherwise the interval between a level that does last and the ceiling is
 * halved, at most seven times, each step one run of the same simulated
 * markets (the same seed), so two steps differ only by their spending and the
 * same plan gives the same answer every time.
 *
 * Halving rests on one assumption, which a test pins on the quick-starts:
 * spending more never makes a plan last in more markets.
 *
 * A step costs about ten seconds, so every rate measured is handed back, and
 * a later solve of the same plan (another floor, another target) is given
 * them: a level at or below one known to last is known to last.
 *
 * ── What it does not touch ───────────────────────────────────────────
 *
 * Headless. It builds its own portfolios, changes nothing it is given, and
 * reads no global. The rate is the Simulations section's: the share of
 * markets in which the plan never reaches $0 from retirement on, without
 * guardrails.
 */

import { ModelAsset } from './model-asset.js';
import { ModelLifeEvent } from './life-event.js';
import { DateInt } from './utils/date-int.js';
import { computeMonteCarlo } from './mc-compute.js';
import { scaledAssets, columnAt } from './spending-solver.js';

/** Halvings at most. From half of what was entered they reach under 0.5% of spending. */
export const SUCCESS_STEPS = 7;
/** Halving stops early when the gap is under this share of the entered spending. */
export const SUCCESS_WITHIN = 0.005;

/**
 * The share of simulated markets a plan lasts in at a spending level.
 *
 * @param {object} plan    { modelAssets, lifeEvents, config }, serialized
 * @param {number} factor  the spending dial
 * @param {object} sim
 * @param {number} sim.markets                 simulated markets to run
 * @param {number} sim.seed                    the same seed gives the same markets
 * @param {number|null} [sim.retirementDateInt]  as an int; markets vary from here
 * @param {string} [sim.dataMode]
 * @param {number|null} [sim.backtestFromYear]
 * @param {(completed: number, total: number) => void} [sim.onProgress]
 * @returns {Promise<number>} 0 to 1
 */
export async function simulatedRate(plan, factor, sim) {
    const results = await computeMonteCarlo(
        scaledAssets(plan.modelAssets, factor).map((a) => ModelAsset.fromJSON(a)),
        {
            numSimulations: sim.markets,
            guardrailParams: null,
            retirementDateInt: sim.retirementDateInt ? new DateInt(sim.retirementDateInt) : null,
            runFromStart: false,
            lifeEvents: (plan.lifeEvents ?? []).map((e) => ModelLifeEvent.fromJSON(e)),
            dataMode: sim.dataMode || 'historical',
            backtestFromYear: sim.backtestFromYear ?? null,
            seed: sim.seed,
            onProgress: sim.onProgress ?? null,
            config: plan.config,
        });
    return results ? results.successRate : 0;
}

/**
 * Turn a solved result down until it lasts in `target` of simulated markets.
 *
 * @param {object} plan     as solveSpending()
 * @param {object} solved   solveSpending() output for the same plan
 * @param {object} options
 * @param {number} options.target             0 to 1, e.g. 0.9
 * @param {number} options.markets            for the result's own record
 * @param {(factor: number) => Promise<number>} options.rateAt
 *        the rate at a spending level; `simulatedRate` in the app
 * @param {Array<[number, number]>} [options.known]  [factor, rate] pairs
 *        measured earlier for this plan under the same markets
 * @param {(step: { tested: number, factor: number, rate: number }) => void} [options.onStep]
 * @returns {Promise<object>} `solved`, with
 *   limits.success   the target
 *   best             the answer under every limit, or null
 *   fixedBest        the solver's own answer, when the success limit lowered it
 *   boundBy          { kind: 'success', target, markets, rate, noLevelPasses }
 *                    when this limit is the one that binds
 *   success          { target, markets, rates: [[factor, rate]], bestRate, tested }
 */
export async function limitBySuccess(plan, solved, { target, markets, rateAt, known = [], onStep = null }) {
    const rates = new Map(known);
    let tested = 0;

    /** Whether the plan lasts in enough markets at a level, measuring only when it must. */
    const lasts = async (factor) => {
        for (const [f, rate] of rates) {
            // Spending no more than a level that lasts, or no less than one that does not.
            if (f >= factor && rate >= target) return true;
            if (f <= factor && rate < target) return false;
        }
        const rate = await rateAt(factor);
        rates.set(factor, rate);
        tested++;
        onStep?.({ tested, factor, rate });
        return rate >= target;
    };

    const done = (extra) => ({
        ...solved,
        limits: { ...solved.limits, success: target },
        ...extra,
        success: {
            target, markets, tested,
            rates: [...rates].sort((a, b) => a[0] - b[0]),
            bestRate: extra?.best ? (rates.get(extra.best.factor) ?? null)
                : solved.best ? (rates.get(solved.best.factor) ?? null) : null,
        },
    });

    // No level keeps the other limits: there is nothing to turn down.
    if (!solved.best) return done();

    const ceiling = solved.best.factor;
    if (await lasts(ceiling)) return done();

    /** The lowest level known not to last, and the highest below it known to. */
    const bracket = () => {
        let top = ceiling, low = null;
        for (const [f, rate] of rates) if (rate < target && f < top) top = f;
        for (const [f, rate] of rates) if (rate >= target && f < top && (low === null || f > low)) low = f;
        return { top, low };
    };

    // A level that lasts, below the ceiling: what was entered when that is
    // lower, otherwise the bottom of the scan.
    const bottom = solved.curve[0].factor;
    let { top: hi, low: lo } = bracket();
    if (lo === null && hi > 1 && bottom < 1) {
        await lasts(1);
        ({ top: hi, low: lo } = bracket());
    }
    if (lo === null) {
        if (!(await lasts(bottom))) {
            return done({
                best: null,
                fixedBest: solved.best,
                boundBy: { kind: 'success', target, markets, rate: rates.get(bottom) ?? null, noLevelPasses: true },
            });
        }
        lo = bottom;
    }

    const span = SUCCESS_WITHIN;
    for (let i = 0; i < SUCCESS_STEPS && hi - lo > span; i++) {
        const mid = (lo + hi) / 2;
        if (await lasts(mid)) lo = mid; else hi = mid;
    }

    // The level found must still keep the other limits. It nearly always does
    // (it spends less than a level that keeps them), but what is left does not
    // always fall as spending rises, so it is checked, and the highest scanned
    // level below it that keeps them is the fallback.
    const floor = solved.limits.floor;
    const keeps = (c) => !c.runsOut && c.endingReal >= floor;
    let best = columnAt(plan, lo);
    if (!keeps(best)) {
        const below = solved.curve.filter((p) => p.factor <= lo && keeps(p));
        best = below.length ? columnAt(plan, below[below.length - 1].factor) : null;
    }

    return done({
        best,
        fixedBest: solved.best,
        boundBy: {
            kind: 'success', target, markets,
            // The rate at the lowest level known not to last: what "spend more" means here.
            rate: rates.get(hi) ?? null,
            noLevelPasses: !best,
        },
    });
}
