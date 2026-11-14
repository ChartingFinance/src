/**
 * test-bench-run.js — runs the Test Bench's tests off the main thread.
 *
 * ── The spending test ────────────────────────────────────────────────
 *
 * One test is up to five jobs in the shared simulation worker (mc-worker.js):
 *
 *   1. the spending solver, which answers the question. With the
 *      simulated-markets limit on, the same job then tests spending levels
 *      across simulated markets (success-limit.js), about ten seconds each;
 *   2. the plan as entered, and the solved plan, each under the Guardrails
 *      section's settings;
 *   3. the same two plans across simulated markets.
 *
 *   4. with the limit on, the answer once more across 1,000 markets.
 *
 * The answer is reported as soon as the solver returns; the checks fill in as
 * they finish. A rate the solver measured is not measured again: it fills its
 * cell directly, and is kept for the next solve of the same plan. Guardrail settings are read and passed along, never
 * changed.
 *
 * Starting a test cancels the one before it, so only the latest ever reports.
 *
 * ── The routing test ─────────────────────────────────────────────────
 *
 * A routing test is the searches of the depth the user picked
 * (routing-search.js, searchesAt), each a job in its own worker, as many side
 * by side as the machine has cores less one. Each reports its progress and
 * then its result. The routing the user selects from the list is then checked
 * as a column is: under guardrails and across simulated markets.
 */

import { global_workerSnapshot, global_backtestYear, global_simDataMode, simConfigFromGlobals } from './globals.js';
import { scaledAssets } from './spending-solver.js';
import { routingGenes, searchesAt, estimateRuns } from './routing-search.js';
import { guardrailsOutcome, simulationOutcome, successTone } from './outcome-summary.js';

/** Simulated markets per column. Enough for a rate to the nearest few points. */
export const CHECK_SIMULATIONS = 300;
/** Simulated markets the answer is run across once more, when the limit is on. */
export const CONFIRM_SIMULATIONS = 1000;

// The Simulations panel's seed (monte-carlo.js), so the same plan draws the
// same markets here, and the two columns differ only by their spending.
const SEED = 1;

let current = null;   // { cancelled, workers:Set<Worker> }

// What one plan run takes on this machine, in milliseconds, from the latest
// test. Null until a test has run.
let msPerRun = null;

// The entered plan's checks do not depend on the floor, and a click on the
// curve re-solves with a new one. Keep the last plan's, keyed by its payload.
let enteredCache = { key: null, checks: {} };

// Rates the success limit has measured for the last plan, [factor, rate]. They
// do not depend on the floor or the target, so a click on the curve reuses them.
let rateCache = { key: null, rates: [] };

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
            else if (msg.action === 'progress') onProgress?.(msg.completed, msg.total, msg);
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

/** What every job of a test carries: the settings in force and the plan's own. */
function baseFor(plan) {
    return {
        settings: global_workerSnapshot(),
        lifeEvents: plan.lifeEvents ?? [],
        backtestYear: global_backtestYear,
        retirementDateInt: plan.retirementDateInt ?? null,
    };
}

/**
 * The simulated markets every rate on the Test Bench is measured in: the same
 * seed, data and era for the limit, the check rows and the confirmation, so
 * two rates differ only by the plan they are of.
 */
function simFor() {
    return {
        markets: CHECK_SIMULATIONS,
        seed: SEED,
        dataMode: global_simDataMode,
        backtestFromYear: global_backtestYear && global_backtestYear !== 'current'
            ? parseInt(global_backtestYear, 10) : null,
    };
}

/** The two checks of one column, as jobs to start. */
function checkJobs(run, base, plan, modelAssets) {
    const sim = simFor();
    return {
        guardrails: () => job(run, { ...base, kind: 'guardrails', modelAssets, params: plan.guardrailParams })
            .then(guardrailsCheck),
        simulations: (onProgress) => job(run, {
            ...base, modelAssets,
            guardrailParams: null,
            runFromStart: false,
            numSimulations: sim.markets,
            dataMode: sim.dataMode,
            backtestFromYear: sim.backtestFromYear,
            seed: sim.seed,
        }, onProgress).then(simulationsCheck),
    };
}

/**
 * Run a spending test.
 *
 * @param {object} plan
 * @param {Array}  plan.modelAssets        the plan's assets (live or plain)
 * @param {Array}  plan.lifeEvents         life events as JSON
 * @param {object} plan.guardrailParams    the Guardrails section's settings
 * @param {number|null} plan.retirementDateInt  as an int, or null
 * @param {object} limits                  { floor, success? } `success` is the
 *                                         share of simulated markets the answer
 *                                         must last in (0.9), or absent
 * @param {object} on
 * @param {(result) => void}                 on.solved
 * @param {(column, check, value) => void}   on.check     column 'entered'|'best',
 *                                                        check 'guardrails'|'simulations'|'confirm'
 * @param {(column, completed, total) => void} [on.progress]  simulated markets so far
 * @param {(tested, completed, total) => void} [on.solving]   the limit's progress: levels
 *                                                        tested, and markets run at this one
 * @returns {Promise<void>} settles when every job has; rejects if the solver fails
 */
export async function runTestBench(plan, limits, on) {
    cancelTestBench();
    if (typeof Worker === 'undefined') throw new Error('This browser cannot run the test.');

    const run = { cancelled: false, workers: new Set() };
    current = run;

    const entered = JSON.parse(JSON.stringify(plan.modelAssets));
    const base = baseFor(plan);

    const key = JSON.stringify([base, entered, plan.guardrailParams, global_simDataMode]);
    if (enteredCache.key !== key) enteredCache = { key, checks: {} };
    const cache = enteredCache;
    if (rateCache.key !== key) rateCache = { key, rates: [] };
    const rates = rateCache;

    const started = Date.now();
    let firstStep = null;
    const result = await job(run, {
        ...base, kind: 'spending', modelAssets: entered, limits,
        sim: simFor(),
        knownRates: rates.rates,
    }, (completed, total, progress) => {
        firstStep ??= Date.now();
        if (!run.cancelled) on.solving?.(progress.tested, completed, total);
    });
    if (run.cancelled) return;
    // Traced runs, so slower than a search's: a first guess, until a search has run.
    if (result.runs && msPerRun == null) msPerRun = ((firstStep ?? Date.now()) - started) / result.runs;
    if (result.success) rates.rates = result.success.rates;
    on.solved(result);

    const checksFor = (modelAssets) => checkJobs(run, base, plan, modelAssets);
    // A rate the limit measured, as the cell shows it.
    const measured = (factor) => {
        const found = result.success?.rates.find(([f]) => f === factor);
        if (!found) return null;
        const percent = Math.round(found[1] * 100);
        return { percent, runs: CHECK_SIMULATIONS, tone: successTone(percent) };
    };
    if (!('simulations' in cache.checks) && measured(1)) cache.checks.simulations = measured(1);

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
            if (column.name === 'best' && check === 'simulations' && measured(result.best.factor)) {
                on.check('best', 'simulations', measured(result.best.factor));
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
    // With the limit on, the answer once more across more markets: 300 markets
    // chose it, so they cannot also be the check on it.
    if (limits.success > 0 && result.best) {
        const answer = scaledAssets(entered, result.best.factor);
        pending.push(job(run, { ...base, modelAssets: answer, guardrailParams: null, runFromStart: false,
            ...simFor(), numSimulations: CONFIRM_SIMULATIONS },
            (completed, total) => { if (!run.cancelled) on.progress?.('confirm', completed, total); })
            .then((results) => { if (!run.cancelled) on.check('best', 'confirm', simulationsCheck(results)); },
                  () => { if (!run.cancelled) on.check('best', 'confirm', { failed: true }); }));
    }
    await Promise.all(pending);
    if (current === run) current = null;
}

// ── The routing test ────────────────────────────────────────────────

let routing = null;        // the routing test in flight
let routingChecks = null;  // the checks of the routing selected from its list

/** Searches that run side by side: the machine's cores, less one for the page. */
function sideBySide() {
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    return Math.max(1, cores - 1);
}

function stop(run) {
    if (!run) return;
    run.cancelled = true;
    for (const worker of run.workers) worker.terminate();
}

/** Stop the routing test in flight and the checks of its selected routing. */
export function cancelRouting() {
    stop(routing);
    stop(routingChecks);
    routing = null;
    routingChecks = null;
}

/**
 * What a routing test at a depth costs, before it is started.
 *
 * @returns {{ searches: number, genes: number, runs: number, seconds: number|null }}
 *   `runs` is about how many times the plan will be run; `seconds` about how
 *   long that takes here, or null when no test has run yet to time one.
 */
export function routingCost(plan, depth) {
    const { genes } = routingGenes({
        modelAssets: JSON.parse(JSON.stringify(plan.modelAssets)),
        lifeEvents: plan.lifeEvents ?? [],
        config: simConfigFromGlobals(),
    });
    const each = searchesAt(depth).map((search) => estimateRuns(genes.length, search));
    const runs = each.reduce((sum, n) => sum + n, 0);
    // Side by side, a test takes its share of the total, and never less than
    // its longest search.
    const wall = Math.max(runs / Math.min(sideBySide(), each.length), Math.max(...each));
    return {
        searches: each.length, genes: genes.length, runs,
        seconds: msPerRun == null ? null : wall * msPerRun / 1000,
    };
}

/**
 * Run a routing test: every search of the depth.
 *
 * @param {object} plan     as runTestBench()
 * @param {object} limits   { floor }
 * @param {number} depth    one of routing-search.js DEPTHS
 * @param {object} on
 * @param {(searches: Array<{start, seed}>) => void}        on.started
 * @param {(index: number, progress: {runs, gain}) => void} [on.progress]
 * @param {(index: number, result: object|null) => void}    on.found   null when
 *                                                          the search failed
 * @returns {Promise<void>} settles when every search has
 */
export async function runRoutingTest(plan, limits, depth, on) {
    cancelRouting();
    if (typeof Worker === 'undefined') throw new Error('This browser cannot run the test.');

    const run = { cancelled: false, workers: new Set() };
    routing = run;

    const base = baseFor(plan);
    const modelAssets = JSON.parse(JSON.stringify(plan.modelAssets));
    const searches = searchesAt(depth);
    on.started(searches);

    let next = 0;
    const lane = async () => {
        while (!run.cancelled && next < searches.length) {
            const index = next++;
            const started = Date.now();
            try {
                const result = await job(run, { ...base, kind: 'routing', modelAssets, limits, search: searches[index] },
                    (_completed, _total, progress) => {
                        if (!run.cancelled) on.progress?.(index, { runs: progress.runs, gain: progress.gain });
                    });
                if (run.cancelled) return;
                if (result.runs) msPerRun = (Date.now() - started) / result.runs;
                on.found(index, result);
            } catch {
                // One failed search leaves its row saying so; the others stand.
                if (!run.cancelled) on.found(index, null);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(sideBySide(), searches.length) }, lane));
    if (routing === run) routing = null;
}

/**
 * Check one routing from the list as a column is checked: under guardrails
 * and across simulated markets, at the most the routed plan can spend.
 * Starting this cancels the checks of the routing selected before.
 *
 * @param {object} plan    as runTestBench()
 * @param {object} result  a search's result, with `best` and `lifeEvents`
 * @param {object} on      { check(check, value), progress?(completed, total) }
 */
export async function runRoutingChecks(plan, result, on) {
    stop(routingChecks);
    routingChecks = null;
    if (!result?.best) return;
    const run = { cancelled: false, workers: new Set() };
    routingChecks = run;

    const base = { ...baseFor(plan), lifeEvents: result.lifeEvents };
    const jobs = checkJobs(run, base, plan,
        scaledAssets(JSON.parse(JSON.stringify(plan.modelAssets)), result.best.factor));
    const report = (check) => (value) => { if (!run.cancelled) on.check(check, value); };
    const failed = (check) => () => { if (!run.cancelled) on.check(check, { failed: true }); };
    await Promise.all([
        jobs.guardrails().then(report('guardrails'), failed('guardrails')),
        jobs.simulations((completed, total) => { if (!run.cancelled) on.progress?.(completed, total); })
            .then(report('simulations'), failed('simulations')),
    ]);
    if (routingChecks === run) routingChecks = null;
}
