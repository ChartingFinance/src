/**
 * test-bench-run.js — runs a Test Bench spending test off the main thread.
 *
 * One test is up to five jobs in the shared simulation worker (mc-worker.js):
 *
 *   1. the spending solver, which answers the question;
 *   2. the plan as entered, and the solved plan, each under the Guardrails
 *      section's settings;
 *   3. the same two plans across simulated markets.
 *
 * The answer is reported as soon as the solver returns; the four checks fill
 * in as they finish. Guardrail settings are read and passed along, never
 * changed.
 *
 * Starting a test cancels the one before it, so only the latest ever reports.
 */

import { global_workerSnapshot, global_backtestYear, global_simDataMode } from './globals.js';
import { scaledAssets } from './spending-solver.js';
import { guardrailsOutcome, simulationOutcome } from './outcome-summary.js';

/** Simulated markets per column. Enough for a rate to the nearest few points. */
export const CHECK_SIMULATIONS = 300;

// The Simulations panel's seed (monte-carlo.js), so the same plan draws the
// same markets here, and the two columns differ only by their spending.
const SEED = 1;

let current = null;   // { cancelled, workers:Set<Worker> }

// The entered plan's checks do not depend on the floor, and a click on the
// curve re-solves with a new one. Keep the last plan's, keyed by its payload.
let enteredCache = { key: null, checks: {} };

/** Stop the test in flight, if there is one. Nothing more is reported for it. */
export function cancelTestBench() {
    if (!current) return;
    current.cancelled = true;
    for (const worker of current.workers) worker.terminate();
    current = null;
}

/** One job in its own worker. Resolves with the results, or rejects. */
function job(run, payload, onProgress) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./mc-worker.js', import.meta.url), { type: 'module' });
        run.workers.add(worker);
        const finish = (settle, value) => {
            worker.terminate();
            run.workers.delete(worker);
            settle(value);
        };
        worker.onmessage = (event) => {
            const msg = event.data;
            if (msg.action === 'complete') finish(resolve, msg.results);
            else if (msg.action === 'error') finish(reject, new Error(msg.message));
            else if (msg.action === 'progress') onProgress?.(msg.completed, msg.total);
        };
        worker.onerror = (err) => finish(reject, err instanceof Error ? err : new Error('The test failed to run.'));
        worker.postMessage(payload);
    });
}

/** What the result table shows for one column under guardrails. */
function guardrailsCheck(results) {
    const outcome = guardrailsOutcome(results);
    if (!outcome) return null;
    return {
        endReal: results.portfolioValuesReal?.[results.portfolioValuesReal.length - 1] ?? null,
        cuts: outcome.cuts,
        raises: outcome.raises,
    };
}

/** What the result table shows for one column across simulated markets. */
function simulationsCheck(results) {
    const outcome = simulationOutcome(results);
    return outcome ? { percent: outcome.percent, runs: outcome.runs, tone: outcome.tone } : null;
}

/**
 * Run a spending test.
 *
 * @param {object} plan
 * @param {Array}  plan.modelAssets        the plan's assets (live or plain)
 * @param {Array}  plan.lifeEvents         life events as JSON
 * @param {object} plan.guardrailParams    the Guardrails section's settings
 * @param {number|null} plan.retirementDateInt  as an int, or null
 * @param {object} limits                  { floor }
 * @param {object} on
 * @param {(result) => void}                 on.solved
 * @param {(column, check, value) => void}   on.check     column 'entered'|'best',
 *                                                        check 'guardrails'|'simulations'
 * @param {(column, completed, total) => void} [on.progress]  simulated markets so far
 * @returns {Promise<void>} settles when every job has; rejects if the solver fails
 */
export async function runTestBench(plan, limits, on) {
    cancelTestBench();
    if (typeof Worker === 'undefined') throw new Error('This browser cannot run the test.');

    const run = { cancelled: false, workers: new Set() };
    current = run;

    const entered = JSON.parse(JSON.stringify(plan.modelAssets));
    const base = {
        settings: global_workerSnapshot(),
        lifeEvents: plan.lifeEvents ?? [],
        backtestYear: global_backtestYear,
        retirementDateInt: plan.retirementDateInt ?? null,
    };

    const result = await job(run, { ...base, kind: 'spending', modelAssets: entered, limits });
    if (run.cancelled) return;
    on.solved(result);

    const backtestFromYear = global_backtestYear && global_backtestYear !== 'current'
        ? parseInt(global_backtestYear, 10) : null;
    const checksFor = (modelAssets) => ({
        guardrails: () => job(run, { ...base, kind: 'guardrails', modelAssets, params: plan.guardrailParams })
            .then(guardrailsCheck),
        simulations: (onProgress) => job(run, {
            ...base, modelAssets,
            guardrailParams: null,
            runFromStart: false,
            numSimulations: CHECK_SIMULATIONS,
            dataMode: global_simDataMode,
            backtestFromYear,
            seed: SEED,
        }, onProgress).then(simulationsCheck),
    });

    const key = JSON.stringify([base, entered, plan.guardrailParams, global_simDataMode]);
    if (enteredCache.key !== key) enteredCache = { key, checks: {} };
    const cache = enteredCache;

    const columns = [{ name: 'entered', jobs: checksFor(entered), cached: cache.checks }];
    if (result.best) {
        columns.push({ name: 'best', jobs: checksFor(scaledAssets(entered, result.best.factor)), cached: null });
    }

    const pending = [];
    for (const column of columns) {
        for (const check of ['guardrails', 'simulations']) {
            if (column.cached && check in column.cached) {
                on.check(column.name, check, column.cached[check]);
                continue;
            }
            const progress = (completed, total) => {
                if (!run.cancelled) on.progress?.(column.name, completed, total);
            };
            pending.push(column.jobs[check](progress).then((value) => {
                if (run.cancelled) return;
                if (column.cached) column.cached[check] = value;
                on.check(column.name, check, value);
            }, () => {
                // A failed check leaves its cell saying so; the answer stands.
                if (!run.cancelled) on.check(column.name, check, { failed: true });
            }));
        }
    }
    await Promise.all(pending);
    if (current === run) current = null;
}
