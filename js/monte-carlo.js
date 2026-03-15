/**
 * monte-carlo.js
 *
 * Runs N Monte Carlo simulations by randomizing annual return rates
 * (sampled from historical data) and collects portfolio value timelines.
 * Renders a fan chart (percentile bands) in the Monte Carlo tab.
 */

import { Portfolio } from './portfolio.js';
import { ModelAsset, Metric } from './model-asset.js';
import { DateInt } from './utils/date-int.js';
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

// ── Clone assets via JSON round-trip (fully independent) ─────────

function cloneAssets(sourceAssets) {
    return sourceAssets.map(a => {
        const json = JSON.parse(JSON.stringify(a));
        return ModelAsset.fromJSON(json);
    });
}

// ── Single simulation run ────────────────────────────────────────

function runOnce(sourceAssets, guardrailParams, retirementDateInt) {
    const assets = cloneAssets(sourceAssets);
    const portfolio = new Portfolio(assets, false);

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
            activeTaxTable.yearlyChron(currentDateInt);
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

// ── Cached results (read by projections markdown generator) ──────

let cachedResults = null;

export function getMonteCarloResults() { return cachedResults; }

// ── Main entry point ─────────────────────────────────────────────

let monteCarloChart = null;

export function runMonteCarlo(sourceAssets, container, numSimulations = 1000, guardrailParams = null, retirementDateInt = null, runFromStart = false) {
    // Determine number of months from a reference run
    const refAssets = cloneAssets(sourceAssets);
    const refPortfolio = new Portfolio(refAssets, false);
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

    if (numMonths === 0) return;

    // Build month labels
    const labels = [];
    let ld = new DateInt(startDateInt.toInt());
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    for (let i = 0; i < numMonths; i++) {
        labels.push(`${monthNames[ld.month - 1]} ${ld.year}`);
        if (ld.month === 12) ld = DateInt.from(ld.year + 1, 1);
        else ld = DateInt.from(ld.year, ld.month + 1);
    }

    // Show loading state
    container.innerHTML = '<p style="padding: 24px; color: #64748b;">Running 1,000 simulations...</p>';

    // Run simulations asynchronously to not block UI
    setTimeout(() => {
        const allRuns = [];
        for (let i = 0; i < numSimulations; i++) {
            const totals = runOnce(sourceAssets, guardrailParams, runFromStart ? null : retirementDateInt);
            while (totals.length < numMonths) totals.push(totals[totals.length - 1] ?? 0);
            if (totals.length > numMonths) totals.length = numMonths;
            allRuns.push(totals);
        }

        // Compute percentile bands
        const bands = [10, 25, 50, 75, 90];
        const bandData = bands.map(() => []);

        for (let m = 0; m < numMonths; m++) {
            const col = allRuns.map(run => run[m]).sort((a, b) => a - b);
            for (let b = 0; b < bands.length; b++) {
                bandData[b].push(percentile(col, bands[b]));
            }
        }

        // Compute deterministic baseline
        const baseAssets = cloneAssets(sourceAssets);
        const basePf = new Portfolio(baseAssets, false);
        activeTaxTable.initializeChron();
        basePf.initializeChron();

        let bd = new DateInt(basePf.firstDateInt.toInt());
        const bLast = new DateInt(basePf.lastDateInt.toInt());
        const baselineData = [];

        while (bd.toInt() <= bLast.toInt()) {
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
                basePf.applyYear(bd);
                activeTaxTable.applyYear(basePf.yearly);
                basePf.yearlyChron(bd);
                activeTaxTable.yearlyChron(bd);
            }
        }
        basePf.finalizeChron();
        activeTaxTable.finalizeChron();

        // Compute retirement trigger index for chart annotation
        let retirementMonthIndex = null;
        if (retirementDateInt) {
            const retirementLabel = `${monthNames[retirementDateInt.month - 1]} ${retirementDateInt.year}`;
            retirementMonthIndex = labels.indexOf(retirementLabel);
            if (retirementMonthIndex < 0) retirementMonthIndex = null;
        }

        cachedResults = {
            labels,
            bands,
            bandData,
            baselineData,
            numSimulations,
            withGuardrails: !!guardrailParams,
            runFromStart,
            startDateInt: new DateInt(startDateInt.toInt()),
            retirementDateInt,
            retirementMonthIndex,
        };

        renderFanChart(container, labels, bands, bandData, baselineData, numSimulations, !!guardrailParams, retirementMonthIndex);
    }, 50);
}

// ── Chart rendering ──────────────────────────────────────────────

function renderFanChart(container, labels, bands, bandData, baselineData, numSimulations, withGuardrails, retirementMonthIndex) {
    container.innerHTML = '';

    const canvas = document.createElement('canvas');
    container.appendChild(canvas);

    if (monteCarloChart) {
        monteCarloChart.destroy();
        monteCarloChart = null;
    }

    const fmt = (v) => '$' + Math.round(v).toLocaleString();

    const step = Math.max(1, Math.floor(labels.length / 12));
    const thinLabels = labels.map((l, i) => i % step === 0 ? l : '');

    // Custom plugin: vertical "Retirement" line
    const retirementLinePlugin = {
        id: 'retirementLine',
        afterDraw(chart) {
            if (retirementMonthIndex == null) return;
            const meta = chart.getDatasetMeta(0);
            if (!meta.data[retirementMonthIndex]) return;
            const x = meta.data[retirementMonthIndex].x;
            const { top, bottom } = chart.chartArea;
            const ctx = chart.ctx;
            ctx.save();
            ctx.strokeStyle = 'rgba(245, 158, 11, 0.8)';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            ctx.moveTo(x, top);
            ctx.lineTo(x, bottom);
            ctx.stroke();
            // Label
            ctx.setLineDash([]);
            ctx.fillStyle = 'rgba(245, 158, 11, 0.9)';
            ctx.font = 'bold 11px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Retirement', x, top - 6);
            ctx.restore();
        },
    };

    monteCarloChart = new Chart(canvas, {
        type: 'line',
        plugins: [retirementLinePlugin],
        data: {
            labels: thinLabels,
            datasets: [
                // 90th percentile (upper bound of outer band)
                {
                    label: '90th percentile',
                    data: bandData[4],
                    fill: false,
                    backgroundColor: 'rgba(168, 85, 247, 0.08)',
                    borderColor: 'rgba(168, 85, 247, 0.2)',
                    borderWidth: 1,
                    pointRadius: 0,
                    tension: 0.3,
                },
                // 75th percentile (upper bound of inner band)
                {
                    label: '75th percentile',
                    data: bandData[3],
                    fill: '-1',
                    backgroundColor: 'rgba(168, 85, 247, 0.08)',
                    borderColor: 'rgba(168, 85, 247, 0.3)',
                    borderWidth: 1,
                    pointRadius: 0,
                    tension: 0.3,
                },
                // Median
                {
                    label: 'Median (50th)',
                    data: bandData[2],
                    fill: '-1',
                    backgroundColor: 'rgba(168, 85, 247, 0.15)',
                    borderColor: 'rgba(168, 85, 247, 0.9)',
                    borderWidth: 2.5,
                    pointRadius: 0,
                    tension: 0.3,
                },
                // 25th percentile
                {
                    label: '25th percentile',
                    data: bandData[1],
                    fill: '-1',
                    backgroundColor: 'rgba(168, 85, 247, 0.15)',
                    borderColor: 'rgba(168, 85, 247, 0.3)',
                    borderWidth: 1,
                    pointRadius: 0,
                    tension: 0.3,
                },
                // 10th percentile (lower bound of outer band)
                {
                    label: '10th percentile',
                    data: bandData[0],
                    fill: '-1',
                    backgroundColor: 'rgba(168, 85, 247, 0.08)',
                    borderColor: 'rgba(168, 85, 247, 0.2)',
                    borderWidth: 1,
                    pointRadius: 0,
                    tension: 0.3,
                },
                // Baseline (deterministic)
                {
                    label: 'Baseline',
                    data: baselineData,
                    fill: false,
                    borderColor: 'rgba(17, 24, 39, 0.6)',
                    borderWidth: 2,
                    borderDash: [6, 3],
                    pointRadius: 0,
                    tension: 0.3,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                title: {
                    display: true,
                    text: `Monte Carlo · ${numSimulations.toLocaleString()} simulations · Portfolio Value${withGuardrails ? ' · With Guardrails' : ''}`,
                    font: { size: 14, weight: '600' },
                    padding: { bottom: 16 },
                },
                legend: {
                    display: true,
                    position: 'bottom',
                    labels: { usePointStyle: true, pointStyle: 'line', boxWidth: 30 },
                },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`,
                    },
                },
            },
            scales: {
                y: {
                    ticks: { callback: (v) => fmt(v) },
                    grid: { color: 'rgba(0,0,0,0.04)' },
                },
                x: {
                    grid: { display: false },
                    ticks: { maxRotation: 45, font: { size: 10 } },
                },
            },
        },
    });
}
