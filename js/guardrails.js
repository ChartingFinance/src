/**
 * guardrails.js
 *
 * Runs a single simulation with Guyton-Klinger guardrails active,
 * then renders a dual-axis chart:
 *   Axis 1 (line):      Total portfolio value over time
 *   Axis 2 (step-line): Annual cash flow (withdrawal amount)
 */

import { Portfolio } from './portfolio.js';
import { ModelAsset, Metric } from './model-asset.js';
import { DateInt } from './utils/date-int.js';
import { chronometer_run } from './chronometer.js';

// ── Chart instance ───────────────────────────────────────────────

let guardrailsChart = null;

// ── Cached results (read by projections markdown generator) ──────

let cachedResults = null;

export function getGuardrailsResults() { return cachedResults; }

// ── Clone assets via JSON round-trip ─────────────────────────────

function cloneAssets(sourceAssets) {
    return sourceAssets.map(a => {
        const json = JSON.parse(JSON.stringify(a));
        return ModelAsset.fromJSON(json);
    });
}

// ── Main entry point ─────────────────────────────────────────────

export function runGuardrails(sourceAssets, canvas, params, retirementDateInt = null, lifeEvents = []) {
    const assets = cloneAssets(sourceAssets);
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

    chronometer_run(portfolio);

    // Collect monthly portfolio value from metric histories
    const numMonths = getMonthCount(portfolio);
    if (numMonths === 0) return;

    // Build month labels
    const labels = [];
    let d = new DateInt(portfolio.firstDateInt.toInt());
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    for (let i = 0; i < numMonths; i++) {
        labels.push(`${monthNames[d.month - 1]} ${d.year}`);
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
    const snapshots = portfolio.yearlySnapshots;

    // Compute retirement trigger index for chart annotation
    const monthNames2 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    let retirementMonthIndex = null;
    if (retirementDateInt) {
        const retirementLabel = `${monthNames2[retirementDateInt.month - 1]} ${retirementDateInt.year}`;
        retirementMonthIndex = labels.indexOf(retirementLabel);
        if (retirementMonthIndex < 0) retirementMonthIndex = null;
    }

    cachedResults = {
        labels,
        portfolioValues,
        withdrawalSteps,
        events,
        snapshots,
        params,
        retirementDateInt,
        retirementMonthIndex,
    };

    renderChart(canvas, labels, portfolioValues, withdrawalSteps, events, snapshots, params, retirementMonthIndex);
}

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
    const lastExpense = snapshots[snapshots.length - 1].annualExpense;
    for (let i = 0; i < numMonths; i++) {
        if (steps[i] === 0 && i > 0) steps[i] = steps[i - 1];
    }

    return steps;
}

// ── Chart rendering ──────────────────────────────────────────────

function renderChart(canvas, labels, portfolioValues, withdrawalSteps, events, snapshots, params, retirementMonthIndex) {
    if (guardrailsChart) {
        guardrailsChart.destroy();
        guardrailsChart = null;
    }

    const fmt = (v) => '$' + Math.round(v).toLocaleString();

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

    // Build sparse arrays for event markers — same length as labels so indices align
    const preservationData = new Array(labels.length).fill(null);
    const prosperityData = new Array(labels.length).fill(null);
    let hasPreservation = false;
    let hasProsperity = false;

    for (const evt of events) {
        const targetLabel = `Jan ${evt.year + 1}`;
        const monthIdx = labels.indexOf(targetLabel);
        if (monthIdx >= 0 && monthIdx < labels.length) {
            if (evt.type === 'preservation') {
                preservationData[monthIdx] = withdrawalSteps[monthIdx];
                hasPreservation = true;
            } else {
                prosperityData[monthIdx] = withdrawalSteps[monthIdx];
                hasProsperity = true;
            }
        }
    }

    guardrailsChart = new Chart(canvas, {
        type: 'line',
        plugins: [retirementLinePlugin],
        data: {
            labels,
            datasets: [
                // Portfolio value (left axis)
                {
                    label: 'Portfolio Value',
                    data: portfolioValues,
                    yAxisID: 'yValue',
                    fill: false,
                    borderColor: 'rgba(59, 130, 246, 0.8)',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    borderWidth: 2.5,
                    pointRadius: 0,
                    tension: 0.3,
                    order: 2,
                },
                // Annual withdrawal (right axis, step-line)
                {
                    label: 'Annual Withdrawal',
                    data: withdrawalSteps,
                    yAxisID: 'yWithdrawal',
                    fill: false,
                    borderColor: 'rgba(239, 68, 68, 0.7)',
                    backgroundColor: 'rgba(239, 68, 68, 0.1)',
                    borderWidth: 2,
                    pointRadius: 0,
                    stepped: 'before',
                    order: 1,
                },
                // Preservation events (markers — line dataset with sparse data, no connecting line)
                ...(hasPreservation ? [{
                    label: 'Preservation Cut',
                    data: preservationData,
                    yAxisID: 'yWithdrawal',
                    showLine: false,
                    pointRadius: preservationData.map(v => v !== null ? 8 : 0),
                    pointStyle: 'triangle',
                    pointRotation: 180,
                    backgroundColor: 'rgba(239, 68, 68, 0.9)',
                    borderColor: 'rgba(239, 68, 68, 1)',
                    order: 0,
                }] : []),
                // Prosperity events (markers — line dataset with sparse data, no connecting line)
                ...(hasProsperity ? [{
                    label: 'Prosperity Raise',
                    data: prosperityData,
                    showLine: false,
                    yAxisID: 'yWithdrawal',
                    pointRadius: prosperityData.map(v => v !== null ? 8 : 0),
                    pointStyle: 'triangle',
                    backgroundColor: 'rgba(34, 197, 94, 0.9)',
                    borderColor: 'rgba(34, 197, 94, 1)',
                    order: 0,
                }] : []),
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                title: {
                    display: true,
                    text: `Guyton-Klinger Guardrails · ${params.withdrawalRate}% target rate · ±${params.adjustment}% adjustment`,
                    font: { size: 14, weight: '600' },
                    padding: { bottom: 16 },
                },
                legend: {
                    display: true,
                    position: 'bottom',
                    labels: { usePointStyle: true, boxWidth: 20 },
                },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`,
                    },
                },
            },
            scales: {
                yValue: {
                    type: 'linear',
                    position: 'left',
                    title: { display: true, text: 'Portfolio Value', font: { weight: '600' } },
                    ticks: { callback: (v) => fmt(v) },
                    grid: { color: 'rgba(0,0,0,0.04)' },
                },
                yWithdrawal: {
                    type: 'linear',
                    position: 'right',
                    title: { display: true, text: 'Annual Withdrawal', font: { weight: '600' } },
                    ticks: { callback: (v) => fmt(v) },
                    grid: { drawOnChartArea: false },
                },
                x: {
                    grid: { display: false },
                    ticks: {
                        maxRotation: 45,
                        font: { size: 10 },
                        autoSkip: true,
                        maxTicksLimit: 12,
                    },
                },
            },
        },
    });
}
