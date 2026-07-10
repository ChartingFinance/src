/**
 * monte-carlo.js
 *
 * Main-thread orchestration + Chart.js rendering for Monte Carlo.
 * The simulation itself lives in mc-compute.js and runs inside a module
 * Web Worker (mc-worker.js) so the UI thread never blocks. Falls back to
 * main-thread compute where module workers are unavailable.
 */

import { Chart } from 'chart.js';
import { DateInt } from './utils/date-int.js';
import { global_backtestYear } from './globals.js';

// ── Cached results (read by projections markdown generator) ──────

let cachedResults = null;

export function getMonteCarloResults() { return cachedResults; }

let monteCarloChart = null;

export function getMonteCarloChart() { return monteCarloChart; }

// ── Worker lifecycle ─────────────────────────────────────────────

let mcWorker = null;

function terminateWorker() {
    if (mcWorker) {
        mcWorker.terminate();
        mcWorker = null;
    }
}

// \u2500\u2500 Container layout \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
//
// The container (a fixed-height .finplan-chart-canvas-wrap) is split into a
// status line and a chart area, so the simulation count lives in the DOM
// above the chart instead of inside the canvas \u2014 it stays visible and keeps
// ticking while the interim chart is already on screen.

function ensureLayout(container) {
    let statusEl = container.querySelector('.mc-status');
    let chartEl = container.querySelector('.mc-chart-area');
    if (!statusEl || !chartEl) {
        container.innerHTML =
            '<div style="display: flex; flex-direction: column; height: 100%;">' +
            '<div class="mc-status" style="flex: none; text-align: center; font-size: 12px; color: #64748b; padding: 2px 0 6px;"></div>' +
            '<div class="mc-chart-area" style="flex: 1 1 auto; min-height: 0; position: relative;"></div>' +
            '</div>';
        statusEl = container.querySelector('.mc-status');
        chartEl = container.querySelector('.mc-chart-area');
    }
    return { statusEl, chartEl };
}

function setStatus(container, text) {
    ensureLayout(container).statusEl.textContent = text;
}

function showLoading(container, completed, total) {
    const msg = completed
        ? `Running simulations\u2026 ${completed.toLocaleString()} / ${total.toLocaleString()}`
        : `Running ${total.toLocaleString()} simulations\u2026`;
    setStatus(container, msg);
}

// ── Main entry point ─────────────────────────────────────────────

// First paint lands after this many sims; the same worker run then continues
// to the requested total and re-renders. The early chart is a prefix of the
// final run pool, so it converges rather than being replaced by a rival.
const INTERIM_AT = 200;

/**
 * Same signature as before, but now resolves a Promise once the final fan
 * chart has rendered (or resolves null if there was nothing to run).
 * Renders progressively: an interim paint at INTERIM_AT sims, then the final.
 * `onRender(chart)` fires after every paint so callers can apply chart
 * decorations to both without setTimeout guesswork.
 */
export function runMonteCarlo(sourceAssets, container, numSimulations = 1000, guardrailParams = null, retirementDateInt = null, runFromStart = false, lifeEvents = [], onRender = null) {
    showLoading(container, 0, numSimulations);

    const render = (results) => {
        if (!results) {
            container.innerHTML = '';
            return null;
        }
        cachedResults = {
            ...results,
            startDateInt: new DateInt(results.startDateInt),
            retirementDateInt: retirementDateInt ?? null,
        };
        const isInterim = results.completed < results.numSimulations;
        setStatus(container, isInterim
            ? `Showing ${results.completed.toLocaleString()} of ${results.numSimulations.toLocaleString()} simulations · refining…`
            : `${results.numSimulations.toLocaleString()} simulations`);
        renderFanChart(ensureLayout(container).chartEl, results.labels, results.bands,
            results.bandData, results.baselineData, results.withGuardrails,
            results.retirementMonthIndex);
        if (monteCarloChart && onRender) onRender(monteCarloChart);
        return monteCarloChart;
    };

    // Fallback: no module-worker support — compute on the main thread.
    // No interim paint here: it would just block the thread twice.
    const canWorker = typeof Worker !== 'undefined';
    if (!canWorker) {
        return new Promise((resolve) => {
            setTimeout(async () => {
                const { computeMonteCarlo } = await import('./mc-compute.js');
                const results = computeMonteCarlo(sourceAssets, {
                    numSimulations, guardrailParams,
                    retirementDateInt: runFromStart ? null : retirementDateInt,
                    runFromStart, lifeEvents,
                });
                resolve(render(results));
            }, 50);
        });
    }

    // Terminating any in-flight worker doubles as cancellation: only the
    // latest requested run ever resolves into the chart.
    terminateWorker();
    mcWorker = new Worker(new URL('./mc-worker.js', import.meta.url), { type: 'module' });

    return new Promise((resolve, reject) => {
        mcWorker.onmessage = (event) => {
            const msg = event.data;
            if (msg.action === 'progress') {
                // The status line is separate from the chart area, so it can
                // keep ticking even after the interim chart is on screen.
                showLoading(container, msg.completed, msg.total);
            } else if (msg.action === 'interim') {
                render(msg.results);
            } else if (msg.action === 'complete') {
                terminateWorker();
                resolve(render(msg.results));
            } else if (msg.action === 'error') {
                terminateWorker();
                container.innerHTML = `<p style="padding: 24px; color: #dc2626;">Monte Carlo failed: ${msg.message}</p>`;
                reject(new Error(msg.message));
            }
        };
        mcWorker.onerror = (err) => {
            console.error('Monte Carlo worker error:', err);
            terminateWorker();
            container.innerHTML = '<p style="padding: 24px; color: #dc2626;">Monte Carlo worker failed.</p>';
            reject(err instanceof Error ? err : new Error('Monte Carlo worker failed'));
        };

        mcWorker.postMessage({
            modelAssets: JSON.parse(JSON.stringify(sourceAssets)),
            lifeEvents: (lifeEvents || []).map(e => e.toJSON()),
            guardrailParams,
            retirementDateInt: retirementDateInt ? retirementDateInt.toInt() : null,
            runFromStart,
            numSimulations,
            backtestYear: global_backtestYear,
            interimAt: INTERIM_AT,
        });
    });
}

// ── Chart rendering ──────────────────────────────────────────────

function renderFanChart(chartEl, labels, bands, bandData, baselineData, withGuardrails, retirementMonthIndex) {
    chartEl.innerHTML = '';

    const canvas = document.createElement('canvas');
    chartEl.appendChild(canvas);

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
                    text: `Monte Carlo · Portfolio Value${withGuardrails ? ' · With Guardrails' : ''}`,
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
