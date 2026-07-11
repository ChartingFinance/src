/**
 * guardrails.js
 *
 * Main-thread orchestration + Chart.js rendering for the Guyton-Klinger
 * guardrails simulation (one deterministic run). The compute lives in
 * gr-compute.js and runs inside the shared simulation worker (mc-worker.js,
 * kind: 'guardrails') so the UI thread never blocks. Falls back to
 * main-thread compute where module workers are unavailable.
 *
 * Renders a dual-axis chart:
 *   Axis 1 (line):      Total portfolio value over time
 *   Axis 2 (step-line): Annual cash flow (withdrawal amount)
 */

import { Chart } from 'chart.js';
import { global_backtestYear } from './globals.js';
import { ensureLayout, setStatus } from './sim-panel.js';

// ── Chart instance ───────────────────────────────────────────────

let guardrailsChart = null;

export function getGuardrailsChart() { return guardrailsChart; }

// ── Cached results (read by projections markdown generator) ──────

let cachedResults = null;

export function getGuardrailsResults() { return cachedResults; }

// ── Worker lifecycle ─────────────────────────────────────────────

let grWorker = null;

function terminateWorker() {
    if (grWorker) {
        grWorker.terminate();
        grWorker = null;
    }
}

// Status line: a single deterministic run has no counter to tick, so the
// line reports what the run found — the guardrail events themselves.
function summarize(events) {
    const cuts = events.filter(e => e.type === 'preservation').length;
    const raises = events.length - cuts;
    if (!cuts && !raises) return 'Single run · no guardrail adjustments triggered';
    const parts = [];
    if (cuts) parts.push(`${cuts} preservation cut${cuts === 1 ? '' : 's'}`);
    if (raises) parts.push(`${raises} prosperity raise${raises === 1 ? '' : 's'}`);
    return `Single run · ${parts.join(' · ')}`;
}

// ── Main entry point ─────────────────────────────────────────────

/**
 * Resolves once the chart has rendered (or resolves null if there was
 * nothing to run). `onRender(chart)` fires after the paint so callers can
 * apply chart decorations without setTimeout guesswork.
 */
export function runGuardrails(sourceAssets, container, params, retirementDateInt = null, lifeEvents = [], onRender = null) {
    setStatus(container, 'Running guardrails simulation…');

    const render = (results) => {
        if (!results) {
            container.innerHTML = '';
            return null;
        }
        cachedResults = {
            ...results,
            retirementDateInt: retirementDateInt ?? null,
        };
        setStatus(container, summarize(results.events));
        renderChart(ensureLayout(container).chartEl, results.labels, results.portfolioValues,
            results.withdrawalSteps, results.events, results.params, results.retirementMonthIndex);
        if (guardrailsChart && onRender) onRender(guardrailsChart);
        return guardrailsChart;
    };

    // Fallback: no module-worker support — compute on the main thread.
    const canWorker = typeof Worker !== 'undefined';
    if (!canWorker) {
        return new Promise((resolve) => {
            setTimeout(async () => {
                const { computeGuardrails } = await import('./gr-compute.js');
                const results = await computeGuardrails(sourceAssets, { params, retirementDateInt, lifeEvents });
                resolve(render(results));
            }, 50);
        });
    }

    // Terminating any in-flight worker doubles as cancellation: only the
    // latest requested run ever resolves into the chart.
    terminateWorker();
    grWorker = new Worker(new URL('./mc-worker.js', import.meta.url), { type: 'module' });

    return new Promise((resolve, reject) => {
        grWorker.onmessage = (event) => {
            const msg = event.data;
            if (msg.action === 'complete') {
                terminateWorker();
                resolve(render(msg.results));
            } else if (msg.action === 'error') {
                terminateWorker();
                container.innerHTML = `<p style="padding: 24px; color: #dc2626;">Guardrails failed: ${msg.message}</p>`;
                reject(new Error(msg.message));
            }
        };
        grWorker.onerror = (err) => {
            console.error('Guardrails worker error:', err);
            terminateWorker();
            container.innerHTML = '<p style="padding: 24px; color: #dc2626;">Guardrails worker failed.</p>';
            reject(err instanceof Error ? err : new Error('Guardrails worker failed'));
        };

        grWorker.postMessage({
            kind: 'guardrails',
            modelAssets: JSON.parse(JSON.stringify(sourceAssets)),
            lifeEvents: (lifeEvents || []).map(e => e.toJSON()),
            params,
            retirementDateInt: retirementDateInt ? retirementDateInt.toInt() : null,
            backtestYear: global_backtestYear,
        });
    });
}

// ── Chart rendering ──────────────────────────────────────────────

function renderChart(chartEl, labels, portfolioValues, withdrawalSteps, events, params, retirementMonthIndex) {
    chartEl.innerHTML = '';

    const canvas = document.createElement('canvas');
    chartEl.appendChild(canvas);

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
