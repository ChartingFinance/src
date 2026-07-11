// mc-worker.js — Web Worker entry for the simulation compute modules.
// Dispatches on payload.kind: 'monteCarlo' (default) or 'guardrails'.
//
// Mirrors the simulator.js worker pattern: rehydrate the payload, install a
// fresh tax table, run the pure compute module, stream progress back.
//
// Messages out:
//   { action: 'progress', completed, total }
//   { action: 'interim', results }    partial snapshot (results.completed < total)
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

if (isWorker) self.onmessage = async function (event) {
    const payload = event.data;

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
            results = computeMonteCarlo(modelAssets, {
                numSimulations: payload.numSimulations,
                guardrailParams: payload.guardrailParams || null,
                retirementDateInt,
                runFromStart: !!payload.runFromStart,
                lifeEvents,
                onProgress: (completed, total) => self.postMessage({ action: 'progress', completed, total }),
                interimEvery: payload.interimEvery || null,
                onInterim: (results) => self.postMessage({ action: 'interim', results }),
            });
        }

        self.postMessage({ action: 'complete', results });
    } catch (err) {
        self.postMessage({ action: 'error', message: err?.message || String(err) });
    }
};
