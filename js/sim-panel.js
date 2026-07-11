/**
 * sim-panel.js
 *
 * Shared layout for simulation chart panels (Monte Carlo, Guardrails, …).
 * Splits a fixed-height container into a status line and a chart area so run
 * feedback (sim counts, progress, summaries) lives in the DOM above the
 * chart instead of inside the canvas, where a render would paint over it.
 */

export function ensureLayout(container) {
    let statusEl = container.querySelector('.sim-status');
    let chartEl = container.querySelector('.sim-chart-area');
    if (!statusEl || !chartEl) {
        container.innerHTML =
            '<div style="display: flex; flex-direction: column; height: 100%;">' +
            '<div class="sim-status" style="flex: none; text-align: center; font-size: 12px; color: #64748b; padding: 2px 0 6px;"></div>' +
            '<div class="sim-chart-area" style="flex: 1 1 auto; min-height: 0; position: relative;"></div>' +
            '</div>';
        statusEl = container.querySelector('.sim-status');
        chartEl = container.querySelector('.sim-chart-area');
    }
    return { statusEl, chartEl };
}

export function setStatus(container, text) {
    ensureLayout(container).statusEl.textContent = text;
}
