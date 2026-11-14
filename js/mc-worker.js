// mc-worker.js — Web Worker entry for the simulation compute modules.
// Dispatches on payload.kind: 'monteCarlo' (default), 'guardrails',
// 'spending' (the Test Bench's spending solver) or 'routing' (one of the
// Test Bench's routing searches).
//
// Rehydrate the payload, install a fresh tax table, run the pure compute
// module, stream progress back.
//
// Messages in:
//   compute payload (kind, modelAssets, …)  starts a run
//   { action: 'pause' }                     halt at the next batch boundary
//   { action: 'resume' }                    continue a paused run
//
// Messages out:
//   { action: 'progress', completed, total }
//   { action: 'progress', runs, gain }   a routing search, every 25 plan runs
//   { action: 'progress', tested, completed, total }   the spending solver's
//                                         simulated-markets limit: levels tested
//                                         so far, and markets run at this one
//   { action: 'interim', results }    partial snapshot (results.completed < total)
//   { action: 'paused', completed }   pause took effect at this sim count
//   { action: 'complete', results }   compute module output
//   { action: 'error', message }

import { setActiveTaxTable, global_setBacktestYearDirect, global_applyWorkerSnapshot,
         simConfigFromGlobals } from './globals.js';
import { ModelAsset } from './model-asset.js';
import { ModelLifeEvent } from './life-event.js';
import { DateInt } from './utils/date-int.js';
import { computeMonteCarlo } from './mc-compute.js';
import { computeGuardrails } from './gr-compute.js';
import { solveSpending } from './spending-solver.js';
import { searchRouting } from './routing-search.js';
import { limitBySuccess, simulatedRate } from './success-limit.js';
import { makeActiveTaxTable } from './globals.js';

// Guard so Node-side tests can import this module without a Worker context.
const isWorker = typeof self !== 'undefined' && typeof self.postMessage === 'function';

// Pause gate: the compute loop awaits a macrotask at every batch boundary,
// which yields the worker's event loop so queued control messages get
// processed. While paused, the checkpoint blocks on gate.promise.
let pauseGate = null;

if (isWorker) self.onmessage = async function (event) {
    const payload = event.data;

    if (payload?.action === 'pause') {
        if (!pauseGate) {
            let release;
            const promise = new Promise((resolve) => { release = resolve; });
            pauseGate = { promise, release };
        }
        return;
    }
    if (payload?.action === 'resume') {
        pauseGate?.release();
        pauseGate = null;
        return;
    }

    try {
        // Workers boot with default globals (no localStorage) — install the
        // main thread's settings before anything reads them. Life-event
        // trigger dates, filing status, RMD ages, and tax-bracket inflation
        // all depend on these.
        global_applyWorkerSnapshot(payload.settings);
        setActiveTaxTable(makeActiveTaxTable());
        if (payload.backtestYear) {
            global_setBacktestYearDirect(payload.backtestYear);
        }

        if (payload.kind === 'spending') {
            // The solver builds its own portfolios from the serialized plan,
            // one per spending level, so it takes the payload as it arrived.
            const plan = {
                modelAssets: payload.modelAssets,
                lifeEvents: payload.lifeEvents || [],
                // After global_applyWorkerSnapshot, as below.
                config: simConfigFromGlobals(),
            };
            let results = solveSpending(plan, payload.limits || {});

            // The third limit: turn the answer down until the plan lasts in
            // enough simulated markets. Each level tested is one run of them.
            const target = payload.limits?.success;
            if (target > 0) {
                let tested = 0;
                const sim = {
                    ...payload.sim,
                    retirementDateInt: payload.retirementDateInt ?? null,
                    onProgress: (completed, total) =>
                        self.postMessage({ action: 'progress', tested, completed, total }),
                };
                results = await limitBySuccess(plan, results, {
                    target,
                    markets: sim.markets,
                    known: payload.knownRates || [],
                    rateAt: (factor) => {
                        self.postMessage({ action: 'progress', tested, completed: 0, total: sim.markets });
                        return simulatedRate(plan, factor, sim);
                    },
                    onStep: (step) => { tested = step.tested; },
                });
            }
            self.postMessage({ action: 'complete', results });
            return;
        }

        if (payload.kind === 'routing') {
            // One search of a routing test. Like the solver, it builds its own
            // portfolios from the serialized plan.
            const results = searchRouting({
                modelAssets: payload.modelAssets,
                lifeEvents: payload.lifeEvents || [],
                config: simConfigFromGlobals(),
            }, {
                floor: payload.limits?.floor ?? 0,
                start: payload.search.start,
                seed: payload.search.seed,
                onProgress: (progress) => self.postMessage({ action: 'progress', ...progress }),
            });
            self.postMessage({ action: 'complete', results });
            return;
        }

        const modelAssets = payload.modelAssets.map(obj => ModelAsset.fromJSON(obj));
        const lifeEvents = (payload.lifeEvents || []).map(e => ModelLifeEvent.fromJSON(e));
        const retirementDateInt = payload.retirementDateInt ? new DateInt(payload.retirementDateInt) : null;

        let results;
        if (payload.kind === 'guardrails') {
            results = await computeGuardrails(modelAssets, {
                params: payload.params,
                retirementDateInt,
                lifeEvents,
                // Built AFTER global_applyWorkerSnapshot above, so it captures
                // the main thread's settings rather than the worker defaults.
                config: simConfigFromGlobals(),
            });
        } else {
            results = await computeMonteCarlo(modelAssets, {
                numSimulations: payload.numSimulations,
                guardrailParams: payload.guardrailParams || null,
                retirementDateInt,
                runFromStart: !!payload.runFromStart,
                lifeEvents,
                onProgress: (completed, total) => self.postMessage({ action: 'progress', completed, total }),
                interimEvery: payload.interimEvery || null,
                onInterim: (results) => self.postMessage({ action: 'interim', results }),
                dataMode: payload.dataMode || 'historical',
                backtestFromYear: payload.backtestFromYear ?? null,
                seed: payload.seed ?? null,
                config: simConfigFromGlobals(),
                checkpoint: async (completed) => {
                    // Macrotask yield: lets queued pause/resume messages run
                    await new Promise((resolve) => setTimeout(resolve, 0));
                    while (pauseGate) {
                        self.postMessage({ action: 'paused', completed });
                        await pauseGate.promise;
                    }
                },
            });
        }

        self.postMessage({ action: 'complete', results });
    } catch (err) {
        self.postMessage({ action: 'error', message: err?.message || String(err) });
    }
};
