/**
 * gr-compute.js
 *
 * Pure Guyton-Klinger guardrails computation — no DOM, no Chart.js. One
 * deterministic chronometer run with guardrails active. Safe to run on the
 * main thread (tests, fallback) or inside the simulation worker
 * (mc-worker.js, kind: 'guardrails').
 */

import { Portfolio } from './portfolio.js';
import { ModelAsset } from './model-asset.js';
import { Metric } from './metric.js';
import { DateInt, MONTH_NAMES } from './utils/date-int.js';
import { chronometer_run } from './chronometer.js';

// ── Helpers ──────────────────────────────────────────────────────

function getMonthCount(portfolio) {
    for (const asset of portfolio.modelAssets) {
        const h = asset.getHistory(Metric.VALUE);
        if (h && h.length > 0) return h.length;
    }
    return 0;
}

function buildWithdrawalSteps(portfolio, numMonths) {
    const snapshots = portfolio.yearlySnapshots;
    const steps = new Array(numMonths).fill(0);

    if (snapshots.length === 0) return steps;

    // Map each snapshot year to month indices
    const startYear = portfolio.firstDateInt.year;
    const startMonth = portfolio.firstDateInt.month;

    for (const snap of snapshots) {
        // Months from simulation start to Jan of this snapshot's year
        const yearOffset = (snap.year - startYear) * 12 - (startMonth - 1);
        for (let m = 0; m < 12; m++) {
            const idx = yearOffset + m;
            if (idx >= 0 && idx < numMonths) {
                steps[idx] = snap.annualExpense;
            }
        }
    }

    // Fill any trailing months with the last known value
    for (let i = 0; i < numMonths; i++) {
        if (steps[i] === 0 && i > 0) steps[i] = steps[i - 1];
    }

    return steps;
}

// ── Main entry point ─────────────────────────────────────────────

/**
 * Run the guardrails simulation.
 *
 * @param {ModelAsset[]} sourceAssets  live model assets
 * @param {Object} opts
 *   params            {Object}  { withdrawalRate, preservation, prosperity, adjustment }
 *   retirementDateInt {DateInt|null}
 *   lifeEvents        {ModelLifeEvent[]}
 * @returns results object (JSON-serializable; DateInts carried as ints),
 *          or null if there was nothing to run
 */
export async function computeGuardrails(sourceAssets, {
    params,
    retirementDateInt = null,
    lifeEvents = [],
} = {}) {
    const assets = ModelAsset.cloneArray(sourceAssets);
    const portfolio = new Portfolio(assets, false);
    if (lifeEvents.length) portfolio.lifeEvents = lifeEvents.map(e => e.copy());

    // Activate guardrails on this portfolio
    portfolio.guardrailsParams = {
        withdrawalRate: params.withdrawalRate,
        preservation: params.preservation,
        prosperity: params.prosperity,
        adjustment: params.adjustment,
        retirementDateInt,
    };

    await chronometer_run(portfolio);

    // Collect monthly portfolio value from metric histories
    const numMonths = getMonthCount(portfolio);
    if (numMonths === 0) return null;

    // Build month labels
    const labels = [];
    let d = new DateInt(portfolio.firstDateInt.toInt());
    for (let i = 0; i < numMonths; i++) {
        labels.push(`${MONTH_NAMES[d.month - 1]} ${d.year}`);
        if (d.month === 12) d = DateInt.from(d.year + 1, 1);
        else d = DateInt.from(d.year, d.month + 1);
    }

    // Portfolio value at each month
    const portfolioValues = [];
    for (let m = 0; m < numMonths; m++) {
        let total = 0;
        for (const asset of portfolio.modelAssets) {
            const history = asset.getHistory(Metric.VALUE);
            if (history && history.length > m) {
                total += history[m] ?? 0;
            }
        }
        portfolioValues.push(total);
    }

    // Annual withdrawal as step-line (held constant for 12 months, changes at year boundaries)
    const withdrawalSteps = buildWithdrawalSteps(portfolio, numMonths);

    // Guardrail event markers
    const events = portfolio.guardrailEvents;

    // Compute retirement index — withdrawal line starts here, vertical line drawn here
    let retirementMonthIndex = null;
    if (retirementDateInt) {
        const retirementLabel = `${MONTH_NAMES[retirementDateInt.month - 1]} ${retirementDateInt.year}`;
        const idx = labels.indexOf(retirementLabel);
        if (idx >= 0) retirementMonthIndex = idx;
    }

    // Zero out withdrawal before retirement so the line only appears post-retirement
    if (retirementMonthIndex !== null) {
        for (let i = 0; i < retirementMonthIndex; i++) withdrawalSteps[i] = null;
    }

    return {
        labels,
        portfolioValues,
        withdrawalSteps,
        events,
        params,
        retirementDateInt: retirementDateInt ? retirementDateInt.toInt() : null,
        retirementMonthIndex,
    };
}
