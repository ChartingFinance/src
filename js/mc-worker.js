// mc-worker.js — Web Worker entry for the simulation compute modules.
// Dispatches on payload.kind: 'monteCarlo' (default) or 'guardrails'.
//
// Mirrors the simulator.js worker pattern: rehydrate the payload, install a
// fresh tax table, run the pure compute module, stream progress back.
//
// Messages in:
//   compute payload (kind, modelAssets, …)  starts a run
//   { action: 'pause' }                     halt at the next batch boundary
//   { action: 'resume' }                    continue a paused run
//
// Messages out:
//   { action: 'progress', completed, total }
//   { action: 'interim', results }    partial snapshot (results.completed < total)
//   { action: 'paused', completed }   pause took effect at this sim count
//   { action: 'complete', results }   compute module output
//   { action: 'error', message }

import { setActiveTaxTable, global_setBacktestYearDirect } from './globals.js';
import { TaxTable } from './taxes.js';
import { ModelAsset } from './model-asset.js';
import { ModelLifeEvent } from './life-event.js';
import { DateInt } from './utils/date-int.js';
import { computeMonteCarlo } from './mc-compute.js';
import { computeGuardrails } from './gr-compute.js';

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
        setActiveTaxTable(new TaxTable());
        if (payload.backtestYear) {
            global_setBacktestYearDirect(payload.backtestYear);
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
