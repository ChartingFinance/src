/**
 * mc-compute.js
 *
 * Pure Monte Carlo computation — no DOM, no Chart.js. Safe to run on the
 * main thread (tests, fallback) or inside a Web Worker (mc-worker.js).
 *
 * Randomizes annual return rates (sampled from historical data, one year
 * per draw to preserve cross-asset correlation) and collects portfolio
 * value timelines into percentile bands.
 */

import { Portfolio } from './portfolio.js';
import { ModelAsset } from './model-asset.js';
import { Metric } from './metric.js';
import { DateInt, MONTH_NAMES } from './utils/date-int.js';
import { InstrumentType, Instrument } from './instruments/instrument.js';
import { activeTaxTable } from './globals.js';
import {
    global_sp500_annual_returns,
    global_10yr_treasury_rates,
    global_cpi_annual_inflation,
    global_wage_growth_annual,
} from './globals.js';

// ── Historical year pool (correlated sampling) ──────────────────

// Build array of years present in all four datasets so we sample
// a single historical year and preserve cross-asset correlation.
const historicalYears = Object.keys(global_sp500_annual_returns)
    .filter(y => y in global_10yr_treasury_rates &&
                 y in global_cpi_annual_inflation &&
                 y in global_wage_growth_annual);

function pickRandomYear() {
    return historicalYears[Math.floor(Math.random() * historicalYears.length)];
}

// ── Apply random rates for one year ──────────────────────────────

function applyRandomRates(modelAssets) {
    const year = pickRandomYear();
    const sp500 = global_sp500_annual_returns[year];
    const treasury = global_10yr_treasury_rates[year];
    const cpi = global_cpi_annual_inflation[year];
    const wage = global_wage_growth_annual[year];

    for (const asset of modelAssets) {
        if (InstrumentType.isTaxableAccount(asset.instrument) ||
            InstrumentType.isIRA(asset.instrument) ||
            InstrumentType.isRothIRA(asset.instrument) ||
            InstrumentType.is401K(asset.instrument)) {
            asset.annualReturnRate.rate = sp500 / 100;
        }
        if (asset.instrument === Instrument.US_BOND) {
            asset.annualReturnRate.rate = treasury / 100;
        }
        if (InstrumentType.isMonthlyExpense(asset.instrument)) {
            asset.annualReturnRate.rate = cpi / 100;
        }
        if (InstrumentType.isMonthlyIncome(asset.instrument)) {
            asset.annualReturnRate.rate = wage / 100;
        }
    }
}

// ── Single simulation run ────────────────────────────────────────

function runOnce(sourceAssets, guardrailParams, retirementDateInt, lifeEvents) {
    const assets = ModelAsset.cloneArray(sourceAssets);
    const portfolio = new Portfolio(assets, false);
    if (lifeEvents) portfolio.lifeEvents = lifeEvents.map(e => e.copy());

    if (guardrailParams) {
        portfolio.guardrailsParams = guardrailParams;
    }

    activeTaxTable.initializeChron();
    portfolio.initializeChron();

    // Two-phase simulation: deterministic rates before retirement, randomized after
    const retirementInt = retirementDateInt ? retirementDateInt.toInt() : 0;
    let withdrawalPhase = !retirementDateInt; // no trigger = randomize from start
    if (withdrawalPhase) applyRandomRates(portfolio.modelAssets);

    let currentDateInt = new DateInt(portfolio.firstDateInt.toInt());
    const lastDateInt = new DateInt(portfolio.lastDateInt.toInt());
    const monthlyTotals = [];

    while (currentDateInt.toInt() <= lastDateInt.toInt()) {
        if (currentDateInt.day === 1) {
            portfolio.applyLifeEvents(currentDateInt);
        }
        portfolio.applyMonth(currentDateInt);
        currentDateInt.next();

        if (currentDateInt.day === 1) {
            portfolio.monthlyChron(currentDateInt);
            activeTaxTable.monthlyChron(currentDateInt);

            let total = 0;
            for (const asset of portfolio.modelAssets) {
                const history = asset.getHistory(Metric.VALUE);
                if (history?.length > 0) {
                    total += history[history.length - 1] ?? 0;
                }
            }
            monthlyTotals.push(total);
        }

        if (currentDateInt.isNewYearsDay()) {
            // Activate randomization once we reach the withdrawal phase
            if (!withdrawalPhase && currentDateInt.toInt() >= retirementInt) {
                withdrawalPhase = true;
            }
            if (withdrawalPhase) {
                applyRandomRates(portfolio.modelAssets);
            }
            portfolio.applyGuardrails(currentDateInt);
            portfolio.applyYear(currentDateInt);
            activeTaxTable.applyYear(portfolio.yearly);
            portfolio.yearlyChron(currentDateInt);
            activeTaxTable.yearlyChron(undefined);
        }
    }

    portfolio.finalizeChron();
    activeTaxTable.finalizeChron();

    return monthlyTotals;
}

// ── Percentile helper ────────────────────────────────────────────

function percentile(sortedArr, p) {
    const idx = (p / 100) * (sortedArr.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sortedArr[lo];
    return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

// ── Deterministic baseline run ───────────────────────────────────

function computeBaseline(sourceAssets, guardrailParams, lifeEvents) {
    const baseAssets = ModelAsset.cloneArray(sourceAssets);
    const basePf = new Portfolio(baseAssets, false);
    if (lifeEvents.length) basePf.lifeEvents = lifeEvents.map(e => e.copy());
    if (guardrailParams) basePf.guardrailsParams = guardrailParams;
    activeTaxTable.initializeChron();
    basePf.initializeChron();

    let bd = new DateInt(basePf.firstDateInt.toInt());
    const bLast = new DateInt(basePf.lastDateInt.toInt());
    const baselineData = [];

    while (bd.toInt() <= bLast.toInt()) {
        if (bd.day === 1) {
            basePf.applyLifeEvents(bd);
        }
        basePf.applyMonth(bd);
        bd.next();
        if (bd.day === 1) {
            basePf.monthlyChron(bd);
            activeTaxTable.monthlyChron(bd);

            let total = 0;
            for (const asset of basePf.modelAssets) {
                const history = asset.getHistory(Metric.VALUE);
                if (history?.length > 0) total += history[history.length - 1] ?? 0;
            }
            baselineData.push(total);
        }
        if (bd.isNewYearsDay()) {
            basePf.applyGuardrails(bd);
            basePf.applyYear(bd);
            activeTaxTable.applyYear(basePf.yearly);
            basePf.yearlyChron(bd);
            activeTaxTable.yearlyChron(undefined);
        }
    }
    basePf.finalizeChron();
    activeTaxTable.finalizeChron();

    return baselineData;
}

// ── Main entry point ─────────────────────────────────────────────

/**
 * Run the full Monte Carlo computation.
 *
 * @param {ModelAsset[]} sourceAssets  live model assets
 * @param {Object} opts
 *   numSimulations    {number}
 *   guardrailParams   {Object|null}
 *   retirementDateInt {DateInt|null}
 *   runFromStart      {boolean}  randomize from month 0 (ignores retirement trigger)
 *   lifeEvents        {ModelLifeEvent[]}
 *   onProgress        {function(completed, total)|null}
 *   interimEvery      {number|null}  emit a partial-results snapshot every N sims
 *   onInterim         {function(results)|null}  receives snapshots (same shape as final)
 * @returns results object (JSON-serializable; DateInts carried as ints)
 */
export function computeMonteCarlo(sourceAssets, {
    numSimulations = 1000,
    guardrailParams = null,
    retirementDateInt = null,
    runFromStart = false,
    lifeEvents = [],
    onProgress = null,
    interimEvery = null,
    onInterim = null,
} = {}) {
    // Determine number of months from a reference run
    const refAssets = ModelAsset.cloneArray(sourceAssets);
    const refPortfolio = new Portfolio(refAssets, false);
    if (lifeEvents.length) refPortfolio.lifeEvents = lifeEvents.map(e => e.copy());
    activeTaxTable.initializeChron();
    refPortfolio.initializeChron();

    let d = new DateInt(refPortfolio.firstDateInt.toInt());
    const last = new DateInt(refPortfolio.lastDateInt.toInt());
    let numMonths = 0;
    const startDateInt = new DateInt(refPortfolio.firstDateInt.toInt());

    // Count months
    while (d.toInt() <= last.toInt()) {
        d.next();
        if (d.day === 1) numMonths++;
    }

    if (numMonths === 0) return null;

    // Build month labels
    const labels = [];
    let ld = new DateInt(startDateInt.toInt());
    for (let i = 0; i < numMonths; i++) {
        labels.push(`${MONTH_NAMES[ld.month - 1]} ${ld.year}`);
        if (ld.month === 12) ld = DateInt.from(ld.year + 1, 1);
        else ld = DateInt.from(ld.year, ld.month + 1);
    }

    // Deterministic baseline — computed up front so interim snapshots carry it too
    const baselineData = computeBaseline(sourceAssets, guardrailParams, lifeEvents);

    // Retirement trigger index for chart annotation
    let retirementMonthIndex = null;
    if (retirementDateInt) {
        const retirementLabel = `${MONTH_NAMES[retirementDateInt.month - 1]} ${retirementDateInt.year}`;
        retirementMonthIndex = labels.indexOf(retirementLabel);
        if (retirementMonthIndex < 0) retirementMonthIndex = null;
    }

    const PROGRESS_EVERY = 50;
    const allRuns = [];

    // Assemble a results object from the runs collected so far. `completed`
    // tells the consumer how many sims back this snapshot (< numSimulations
    // for an interim, == numSimulations for the final).
    const buildResults = (completed) => {
        const bands = [10, 25, 50, 75, 90];
        const bandData = bands.map(() => []);
        for (let m = 0; m < numMonths; m++) {
            const col = allRuns.map(run => run[m]).sort((a, b) => a - b);
            for (let b = 0; b < bands.length; b++) {
                bandData[b].push(percentile(col, bands[b]));
            }
        }

        // Success rate: fraction of runs whose terminal value stays above zero
        const lastMonth = numMonths - 1;
        const successRate = allRuns.filter(run => run[lastMonth] > 0).length / allRuns.length;

        return {
            labels,
            bands,
            bandData,
            baselineData,
            successRate,
            numSimulations,
            completed,
            withGuardrails: !!guardrailParams,
            runFromStart,
            startDateInt: startDateInt.toInt(),
            retirementDateInt: retirementDateInt ? retirementDateInt.toInt() : null,
            retirementMonthIndex,
        };
    };

    for (let i = 0; i < numSimulations; i++) {
        const totals = runOnce(sourceAssets, guardrailParams, runFromStart ? null : retirementDateInt, lifeEvents);
        while (totals.length < numMonths) totals.push(totals[totals.length - 1] ?? 0);
        if (totals.length > numMonths) totals.length = numMonths;
        allRuns.push(totals);
        // An interim snapshot supersedes the plain progress ping at the same
        // increment — the consumer gets one coherent update per tick.
        const emitInterim = onInterim && interimEvery
            && (i + 1) % interimEvery === 0 && (i + 1) < numSimulations;
        if (emitInterim) {
            onInterim(buildResults(i + 1));
        } else if (onProgress && (i + 1) % PROGRESS_EVERY === 0) {
            onProgress(i + 1, numSimulations);
        }
    }

    return buildResults(numSimulations);
}
