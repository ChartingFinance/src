/**
 * debug-panel.js
 *
 * Thin adapter over <debug-panel-element>. Maintains the same exported API
 * (show/hide/toggle/clear/appendReport/clearReports/getReports) so callers
 * don't need to change.
 */

import './components/debug-panel-element.js';
import { FinancialPackage } from './portfolio.js';

let panelEl = null;
let reportAccumulator = [];

function ensurePanel() {
    if (panelEl) return;
    panelEl = document.createElement('debug-panel-element');
    panelEl.addEventListener('panel-clear', () => { reportAccumulator = []; });
    document.body.appendChild(panelEl);
}

function show() {
    ensurePanel();
    panelEl.visible = true;
}

function hide() {
    if (panelEl) panelEl.visible = false;
}

function toggle() {
    ensurePanel();
    panelEl.visible = !panelEl.visible;
}

function clear() {
    reportAccumulator = [];
    if (panelEl) panelEl.reports = [];
}

function clearReports() {
    reportAccumulator = [];
}

function getReports() {
    return reportAccumulator;
}

/**
 * Append a monthly or yearly FinancialPackage report.
 * @param {'monthly'|'yearly'} type
 * @param {string} dateLabel    e.g. "2026-03"
 * @param {FinancialPackage} pkg
 */
function appendReport(type, dateLabel, pkg) {
    reportAccumulator.push({ type, dateLabel, pkg: new FinancialPackage().add(pkg) });
    ensurePanel();
    panelEl.reports = [...reportAccumulator];
    if (!panelEl.visible) panelEl.visible = true;
}

// Expose on window for console use
if (typeof window !== 'undefined') {
    window.debugPanel = { show, hide, toggle, clear, appendReport };
}

export { show, hide, toggle, clear, appendReport, clearReports, getReports };
