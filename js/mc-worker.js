// mc-worker.js — Web Worker entry for Monte Carlo simulation
//
// Mirrors the simulator.js worker pattern: rehydrate the payload, install a
// fresh tax table, run the pure compute module, stream progress back.
//
// Messages out:
//   { action: 'progress', completed, total }
//   { action: 'interim', results }    partial snapshot (results.completed < total)
//   { action: 'complete', results }   results = computeMonteCarlo() output
//   { action: 'error', message }

import { setActiveTaxTable, global_setBacktestYearDirect } from './globals.js';
import { TaxTable } from './taxes.js';
import { ModelAsset } from './model-asset.js';
import { ModelLifeEvent } from './life-event.js';
import { DateInt } from './utils/date-int.js';
import { computeMonteCarlo } from './mc-compute.js';

// Guard so Node-side tests can import this module without a Worker context.
const isWorker = typeof self !== 'undefined' && typeof self.postMessage === 'function';

if (isWorker) self.onmessage = function (event) {
    const payload = event.data;

    try {
        setActiveTaxTable(new TaxTable());
        if (payload.backtestYear) {
            global_setBacktestYearDirect(payload.backtestYear);
        }

        const results = computeMonteCarlo(
            payload.modelAssets.map(obj => ModelAsset.fromJSON(obj)),
            {
                numSimulations: payload.numSimulations,
                guardrailParams: payload.guardrailParams || null,
                retirementDateInt: payload.retirementDateInt ? new DateInt(payload.retirementDateInt) : null,
                runFromStart: !!payload.runFromStart,
                lifeEvents: (payload.lifeEvents || []).map(e => ModelLifeEvent.fromJSON(e)),
                onProgress: (completed, total) => self.postMessage({ action: 'progress', completed, total }),
                interimAt: payload.interimAt || null,
                onInterim: (results) => self.postMessage({ action: 'interim', results }),
            },
        );

        self.postMessage({ action: 'complete', results });
    } catch (err) {
        self.postMessage({ action: 'error', message: err?.message || String(err) });
    }
};
