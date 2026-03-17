/**
 * finplan-app.js
 *
 * Orchestrator for finplan.html — the new single-page FinPlan layout.
 * Follows the same pattern as app.js but targets the finplan layout:
 *   - Globals init + settings wiring
 *   - Load assets + life events from localStorage
 *   - Build portfolio, run chronometer
 *   - Wire timeline, charts, and sidebar
 *   - Sacred x-axis alignment via forced y-axis width on all Chart.js instances
 */

// ── Core types ──────────────────────────────────────────────
import { Metric, MetricLabel } from './model-asset.js';
import { DateInt } from './utils/date-int.js';

// ── Simulation ──────────────────────────────────────────────
import { chronometer_run, chronometer_run_animated } from './chronometer.js';
import { Portfolio } from './portfolio.js';
import { TaxTable } from './taxes.js';

// ── Data loading ────────────────────────────────────────────
import { membrane_rawDataToModelAssets } from './membrane.js';
import { quickStartAssets, quickStartLifeEvents } from './quick-start.js';
import { ModelLifeEvent, LifeEvent, LifeEventType } from './life-event.js';

// ── Charting ────────────────────────────────────────────────
import {
    charting_buildFromPortfolio,
    charting_buildDateMarkers,
    charting_buildDisplayLabels,
    charting_buildPhaseMarkers,
    charting_jsonMetric1ChartData,
} from './charting.js';

import { classifyAssets, classifyAssetGroup, GROUP_DISPLAY_ORDER, getAssetChartColor } from './asset-groups.js';

// ── Simulations ─────────────────────────────────────────────
import { runMonteCarlo, getMonteCarloChart, getMonteCarloResults } from './monte-carlo.js';
import { runGuardrails, getGuardrailsChart } from './guardrails.js';

// ── Lit components ──────────────────────────────────────────
import './components/asset-list.js';
import './components/asset-card.js';
import './components/asset-form-modal.js';
import './components/transfer-modal.js';
import './components/event-form-modal.js';
import './components/finplan-timeline.js';
import './components/simulator-modal.js';
import './components/spreadsheet-view.js';
import './components/debug-report-view.js';
import './components/credit-memo-view.js';
import './components/share-modal.js';

// ── AI Summary generators ──────────────────────────────────
import {
    generateTimelineMarkdown,
    generatePortfolioSectionMarkdown,
    generateProjectionsSectionMarkdown,
    generateSimulationsSectionMarkdown,
    generateDetailsSectionMarkdown,
    generateSpreadsheetSectionMarkdown,
} from './generators/finplan-ai.js';

// ── Store ───────────────────────────────────────────────────
import { store } from './finplan-store.js';


// ── Globals ─────────────────────────────────────────────────
import {
    setActiveTaxTable,
    global_initialize,
    global_inflationRate,
    global_filingAs,
    global_user_startAge,
    global_user_retirementAge,
    global_user_finishAge,
    global_backtestYear,
    global_multBy100,
    global_divBy100,
    global_setInflationRate,
    global_getInflationRate,
    global_setFilingAs,
    global_getFilingAs,
    global_setUserStartAge,
    global_getUserStartAge,
    global_setUserRetirementAge,
    global_getUserRetirementAge,
    global_setUserFinishAge,
    global_getUserFinishAge,
    global_getRetirementDateInt,
    global_setBacktestYear,
    global_getBacktestYear,
    global_guardrail_withdrawalRate,
    global_guardrail_preservation,
    global_guardrail_prosperity,
    global_guardrail_adjustment,
} from './globals.js';

// ── Util ────────────────────────────────────────────────────
import {
    util_YYYYmm,
    util_ensureStoryNames,
    util_saveLocalAssetModels,
    util_loadLocalAssetModels,
    util_saveLocalLifeEvents,
    util_loadLocalLifeEvents,
} from './utils/util.js';

// ── DOM refs ────────────────────────────────────────────────
const assetList         = document.getElementById('finplanAssetList');
const assetFormModal    = document.getElementById('assetFormModal');
const transferModal     = document.getElementById('transferModal');
const eventFormModal    = document.getElementById('eventFormModal');
const timeline          = document.getElementById('finplanTimeline');
const viewingBadge      = document.getElementById('viewingBadge');
const macroCanvas       = document.getElementById('finplan-macro-canvas');
const microCanvas       = document.getElementById('finplan-micro-canvas');
const mcContainer       = document.getElementById('finplan-mc-container');
const guardrailsCanvas  = document.getElementById('finplan-guardrails-canvas');
const spreadsheetView   = document.getElementById('finplanSpreadsheet');
const reportView        = document.getElementById('finplanReport');
const creditMemoView    = document.getElementById('finplanCreditMemos');
const metricSelect      = document.getElementById('finplan-metric-select');
const shareModal        = document.getElementById('shareModal');

// ── App state ───────────────────────────────────────────────
let activePortfolio     = null;
let activeLifeEvents    = [];
let expandedGroups      = new Set();
let activeMetricName    = Metric.VALUE;
let macroChart          = null;
let microChart          = null;
let editingModelAsset   = null;

let activeStoryArc      = null;
let activeStoryName     = null;

// ── Init ────────────────────────────────────────────────────

global_initialize();
setActiveTaxTable(new TaxTable());

// Sync settings inputs to globals
syncGlobalsToSettings();
connectSettings();

// Load data
initiateActiveData();

// Wire sidebar events
connectAssetListEvents();
connectAssetFormModal();
connectTransferModal();

// Wire timeline edit event
timeline.addEventListener('event-edit', (ev) => {
    const { event: lifeEvent, index } = ev.detail;
    eventFormModal.mode = 'edit';
    eventFormModal.lifeEvent = lifeEvent;
    eventFormModal.editIndex = index;
    eventFormModal.modelAssets = assetList.modelAssets || [];
    eventFormModal.open = true;
});

// Wire event form modal save/delete
eventFormModal.addEventListener('save-life-event', (ev) => {
    const { lifeEvent, index, mode } = ev.detail;
    if (mode === 'create') {
        activeLifeEvents.push(lifeEvent);
        activeLifeEvents.sort((a, b) => a.triggerAge - b.triggerAge);
    } else if (mode === 'edit') {
        activeLifeEvents[index] = lifeEvent;
    }
    calculate();
});

eventFormModal.addEventListener('delete-life-event', (ev) => {
    activeLifeEvents.splice(ev.detail.index, 1);
    calculate();
});

// Wire buttons
document.getElementById('btn-donate').addEventListener('click', () => {
    document.getElementById('popupFormDonate').style.display = 'flex';
});
document.getElementById('btn-share').addEventListener('click', () => {
    if (shareModal) {
        shareModal.modelAssets = activePortfolio?.modelAssets || [];
        shareModal.lifeEvents = activeLifeEvents;
        shareModal.portfolioName = activeStoryName || '';
        shareModal.globalSettings = {
            inflationRate: global_inflationRate,
            filingAs: global_filingAs,
            startAge: global_user_startAge,
            retirementAge: global_user_retirementAge,
            finishAge: global_user_finishAge,
            backtestYear: global_backtestYear,
        };
        shareModal.guardrailParams = getGuardrailParams();
        shareModal.open = true;
    }
});
// Donate popup close
const donatePopup = document.getElementById('popupFormDonate');
donatePopup.querySelector('.closeBtn').addEventListener('click', () => donatePopup.style.display = 'none');
donatePopup.addEventListener('click', (e) => { if (e.target === donatePopup) donatePopup.style.display = 'none'; });

// ── AI Summary popup ────────────────────────────────────────
const aiPopup = document.getElementById('ai-summary-popup');
const aiTitle = document.getElementById('ai-summary-title');
const aiTextarea = document.getElementById('ai-summary-textarea');

function openAiSummary(title, content) {
    aiTitle.textContent = title;
    aiTextarea.value = content;
    aiPopup.style.display = 'flex';
}

const aiGenerators = {
    timeline:    () => generateTimelineMarkdown(activePortfolio, activeLifeEvents),
    portfolio:   () => generatePortfolioSectionMarkdown(activePortfolio),
    projections: () => generateProjectionsSectionMarkdown(activePortfolio, activeMetricName),
    simulations: () => generateSimulationsSectionMarkdown(activePortfolio),
    details:     () => generateDetailsSectionMarkdown(activePortfolio),
    spreadsheet: () => generateSpreadsheetSectionMarkdown(activePortfolio),
};

const aiLabels = {
    timeline: 'Your Timeline', portfolio: 'Your Portfolio', projections: 'Projections',
    simulations: 'Simulations', details: 'Details', spreadsheet: 'Spreadsheet',
};

for (const btn of document.querySelectorAll('.ai-fab')) {
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const section = btn.dataset.section;
        const gen = aiGenerators[section];
        if (gen) openAiSummary(`${aiLabels[section]} — AI Summary`, gen());
    });
}

document.getElementById('ai-summary-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(aiTextarea.value).then(() => {
        const btn = document.getElementById('ai-summary-copy');
        btn.title = 'Copied!';
        setTimeout(() => { btn.title = 'Copy to clipboard'; }, 2000);
    });
});
document.getElementById('ai-summary-close').addEventListener('click', () => aiPopup.style.display = 'none');
aiPopup.addEventListener('click', (e) => { if (e.target === aiPopup) aiPopup.style.display = 'none'; });

document.getElementById('btn-spreadsheet-copy').addEventListener('click', () => {
    if (!spreadsheetView) return;
    const csv = spreadsheetView.toCSV();
    navigator.clipboard.writeText(csv).then(() => {
        const btn = document.getElementById('btn-spreadsheet-copy');
        btn.textContent = '✅';
        setTimeout(() => { btn.textContent = '📋'; }, 2000);
    });
});
document.getElementById('btn-spreadsheet-download').addEventListener('click', () => {
    if (!spreadsheetView) return;
    const csv = spreadsheetView.toCSV();
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'spreadsheet.csv';
    a.click();
    URL.revokeObjectURL(url);
});

document.getElementById('btn-add-asset').addEventListener('click', () => openCreateAssetModal());
document.getElementById('btn-run-mc').addEventListener('click', () => doMonteCarlo());
document.getElementById('btn-run-guardrails').addEventListener('click', () => doGuardrails());
document.getElementById('btn-visualize').addEventListener('click', () => doVisualize());
document.getElementById('btn-maximize').addEventListener('click', () => doMaximize());

// Wire metric select
metricSelect.innerHTML = Object.values(Metric).map(m =>
    `<option value="${m}">${MetricLabel[m]}</option>`
).join('');
metricSelect.value = activeMetricName;
metricSelect.addEventListener('change', () => {
    activeMetricName = metricSelect.value;
    if (timeline) timeline.metricName = activeMetricName;
    assetList.metricName = activeMetricName;
    if (!activePortfolio) return;
    rebuildProjectionCharts();
});

// Wire store
store.setRetirementDate(global_getRetirementDateInt());
store.setSelectedDate(DateInt.today());

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function updateViewingBadge(year, month) {
    const text = `Viewing: ${MONTH_NAMES[month - 1]} ${year}`;
    if (viewingBadge) viewingBadge.textContent = text;
    document.querySelectorAll('.viewing-badge').forEach(el => el.textContent = text);
}
/** Sync asset-list to show metric values at the selected date */
function syncAssetListToDate(year, month) {
    const dateInt = DateInt.from(year, month);
    assetList.atDateInt = dateInt;
    assetList.metricName = activeMetricName;
    if (activePortfolio?.firstDateInt) {
        assetList.historyIndex = DateInt.diffMonths(activePortfolio.firstDateInt, dateInt);
    } else {
        assetList.historyIndex = -1;
    }
}

updateViewingBadge(store.selectedYear, store.selectedMonth);
store.addEventListener('date-change', (e) => {
    updateViewingBadge(e.detail.year, e.detail.month);
    updateProjectionCursor();
    syncAssetListToDate(e.detail.year, e.detail.month);
    if (spreadsheetView) spreadsheetView.scrollToDate(e.detail.year, e.detail.month);
    if (reportView) reportView.scrollToDate(e.detail.year, e.detail.month);
    if (creditMemoView) creditMemoView.scrollToDate(e.detail.year, e.detail.month);
});

// ── Settings ────────────────────────────────────────────────

function syncGlobalsToSettings() {
    document.getElementById('setting-startAge').value = global_user_startAge;
    document.getElementById('setting-retirementAge').value = global_user_retirementAge;
    document.getElementById('setting-finishAge').value = global_user_finishAge;
    document.getElementById('setting-filingAs').value = global_filingAs;
    document.getElementById('setting-inflationRate').value = global_multBy100(global_inflationRate);
    document.getElementById('setting-backtestYear').value = global_backtestYear;
}

function connectSettings() {
    document.getElementById('setting-startAge').addEventListener('change', function() {
        global_setUserStartAge(parseInt(this.value));
        global_getUserStartAge();
        calculate();
    });
    document.getElementById('setting-retirementAge').addEventListener('change', function() {
        global_setUserRetirementAge(parseInt(this.value));
        global_getUserRetirementAge();
        store.setRetirementDate(global_getRetirementDateInt());
        calculate();
    });
    document.getElementById('setting-finishAge').addEventListener('change', function() {
        global_setUserFinishAge(parseInt(this.value));
        global_getUserFinishAge();
        calculate();
    });
    document.getElementById('setting-filingAs').addEventListener('change', function() {
        global_setFilingAs(this.value);
        global_getFilingAs();
        setActiveTaxTable(new TaxTable());
        calculate();
    });
    document.getElementById('setting-inflationRate').addEventListener('change', function() {
        global_setInflationRate(global_divBy100(this.value));
        global_getInflationRate();
        calculate();
    });
    document.getElementById('setting-backtestYear').addEventListener('change', function() {
        global_setBacktestYear(this.value);
        global_getBacktestYear();
        calculate();
    });
}

// ── Data Loading ────────────────────────────────────────────

function initiateActiveData() {
    activeStoryArc = localStorage.getItem('activeStoryArc') || 'default';
    activeStoryName = localStorage.getItem('activeStoryName');
    if (!activeStoryName) {
        activeStoryName = util_YYYYmm();
        util_ensureStoryNames(activeStoryArc, activeStoryName);
    }
    loadLocalData();
}

function loadLocalData() {
    const slotName = activeStoryName;
    const assetModelsRaw = util_loadLocalAssetModels(activeStoryArc, slotName);
    assetList.modelAssets = membrane_rawDataToModelAssets(assetModelsRaw);

    // Load life events (or create defaults)
    const savedEvents = util_loadLocalLifeEvents(activeStoryArc, slotName);
    if (savedEvents) {
        activeLifeEvents = savedEvents.map(ModelLifeEvent.fromJSON);
    } else {
        activeLifeEvents = ModelLifeEvent.defaultTimeline(
            global_user_startAge, global_user_retirementAge
        );
    }

    // Migration: copy legacy per-asset transfers to accumulate phase
    const accEvent = activeLifeEvents.find(e => LifeEventType.isAccumulation(e.type));
    if (accEvent && Object.keys(accEvent.phaseTransfers).length === 0) {
        const assets = assetList.modelAssets || [];
        for (const asset of assets) {
            if (asset.fundTransfers?.length > 0) {
                accEvent.phaseTransfers[asset.displayName] = asset.fundTransfers.map(ft => ft.toJSON());
            }
        }
    }

    calculate();
}

// ── Calculation ─────────────────────────────────────────────

function calculate() {
    const modelAssets = assetList.modelAssets || [];
    const portfolio = new Portfolio(modelAssets, true);
    portfolio.lifeEvents = activeLifeEvents.map(e => e.copy());

    chronometer_run(portfolio);
    activePortfolio = portfolio;

    // Update sidebar
    assetList.modelAssets = [...portfolio.modelAssets];
    assetList.expandedGroups = new Set(expandedGroups);
    assetList.activeLifeEvent = activeLifeEvents[0] ?? null;
    assetList.portfolio = portfolio;
    syncAssetListToDate(store.selectedYear, store.selectedMonth);

    // Build charting data
    portfolio.buildChartingDisplayData();

    // Build and render projection charts
    rebuildProjectionCharts();

    // Update details
    if (spreadsheetView) spreadsheetView.portfolio = portfolio;
    if (reportView) reportView.reports = portfolio.generatedReports;
    if (creditMemoView) creditMemoView.portfolio = portfolio;

    // Update timeline
    updateTimeline();

    // Save
    saveLocalData();
}

function getGuardrailParams() {
    return {
        withdrawalRate: global_guardrail_withdrawalRate,
        preservation: global_guardrail_preservation,
        prosperity: global_guardrail_prosperity,
        adjustment: global_guardrail_adjustment,
    };
}

function doMonteCarlo() {
    if (!activePortfolio) return;
    runMonteCarlo(
        activePortfolio.modelAssets, mcContainer, 1000,
        getGuardrailParams(), global_getRetirementDateInt(),
        false, activeLifeEvents
    );
    // MC renders async (setTimeout 50ms) — apply phase markers after it's done
    setTimeout(() => {
        const mc = getMonteCarloChart();
        if (mc) {
            mc.options.plugins.dateMarkers = { markers: buildSimulationMarkers(mc, getMonteCarloResults()?.labels) };
            mc.update('none');
        }
    }, 200);
}

function doGuardrails() {
    if (!activePortfolio) return;
    runGuardrails(
        activePortfolio.modelAssets, guardrailsCanvas, getGuardrailParams(),
        global_getRetirementDateInt(), activeLifeEvents
    );
    // Apply phase markers after render
    setTimeout(() => {
        const gr = getGuardrailsChart();
        if (gr) {
            gr.options.plugins.dateMarkers = { markers: buildSimulationMarkers(gr) };
            gr.update('none');
        }
    }, 100);
}

let isVisualizing = false;

async function doVisualize() {
    if (isVisualizing) return;
    isVisualizing = true;

    const modelAssets = assetList.modelAssets || [];
    const portfolio = new Portfolio(modelAssets, false);
    portfolio.lifeEvents = activeLifeEvents.map(e => e.copy());

    await chronometer_run_animated(portfolio, 'finplan-hydraulic-container');
    isVisualizing = false;
}

function doMaximize() {
    let simModal = document.querySelector('simulator-modal');
    if (!simModal) {
        simModal = document.createElement('simulator-modal');
        document.body.appendChild(simModal);

        simModal.addEventListener('found-fittest', (e) => {
            // Apply optimized assets
            assetList.modelAssets = e.detail.modelAssets;
            calculate();
        });
    }
    simModal.modelAssets = assetList.modelAssets || [];
    simModal.lifeEvents = activeLifeEvents;
    simModal.guardrailParams = getGuardrailParams();
    simModal.fitnessBalance = 100;
    simModal.open = true;
}

function buildPhaseMarkersForCharts() {
    const cursorDateInt = DateInt.from(store.selectedYear, store.selectedMonth);
    return charting_buildPhaseMarkers(
        activePortfolio, activeLifeEvents,
        global_user_startAge, global_user_retirementAge, cursorDateInt
    );
}

function rebuildProjectionCharts() {
    if (!activePortfolio) return;

    const markers = buildPhaseMarkersForCharts();

    // Macro: always fully grouped (never expand into individual assets)
    charting_buildFromPortfolio(activePortfolio, true, activeMetricName, new Set());

    if (macroChart) macroChart.destroy();
    if (charting_jsonMetric1ChartData) {
        charting_jsonMetric1ChartData.options.plugins.dateMarkers = { markers };
        macroChart = new Chart(macroCanvas, charting_jsonMetric1ChartData);
    }

    // Micro: individual assets from expanded groups only
    rebuildMicroChart(markers);
}

function rebuildMicroChart(markers) {
    if (!activePortfolio) return;
    if (!markers) markers = buildPhaseMarkersForCharts();

    if (microChart) microChart.destroy();
    microChart = null;

    const labels = charting_buildDisplayLabels(activePortfolio.firstDateInt, activePortfolio.lastDateInt);

    if (expandedGroups.size === 0) {
        // Empty state: axes but no data, with a prompt message
        const microCfg = {
            type: 'bar',
            data: { labels, datasets: [] },
            options: {
                responsive: true,
                plugins: {
                    title: { display: true, text: 'Expand a group to see data', color: '#9ca3af', font: { size: 13, weight: 'normal' } },
                    dateMarkers: { markers },
                },
                scales: { x: { stacked: true }, y: { stacked: true } },
            },
        };
        microChart = new Chart(microCanvas, microCfg);
        return;
    }

    // Classify by instrument (ignore isClosed) so chart shows full history
    const groups = new Map();
    for (const asset of activePortfolio.modelAssets) {
        const groupKey = classifyAssetGroup(asset.instrument);
        if (!groups.has(groupKey)) groups.set(groupKey, []);
        groups.get(groupKey).push(asset);
    }

    const datasets = [];
    for (const groupKey of GROUP_DISPLAY_ORDER) {
        if (!expandedGroups.has(groupKey)) continue;
        const assets = groups.get(groupKey);
        if (!assets || assets.length === 0) continue;
        for (const asset of assets) {
            datasets.push({
                label: asset.displayName,
                data: asset.getDisplayHistory(activeMetricName),
                backgroundColor: getAssetChartColor(asset.instrument, false),
            });
        }
    }

    if (datasets.length === 0) return;

    const microCfg = {
        type: 'bar',
        data: { labels, datasets },
        options: {
            responsive: true,
            plugins: { title: { display: false }, dateMarkers: { markers } },
            scales: { x: { stacked: true }, y: { stacked: true } },
        },
    };
    microChart = new Chart(microCanvas, microCfg);
}

function buildSimulationMarkers(chart, fullLabels) {
    if (!chart?.data?.labels) return [];
    // Use full (unthinned) labels for index lookup when available
    const labels = fullLabels || chart.data.labels;
    const markers = [];

    // Accumulate line (if visible)
    if (global_user_startAge < global_user_retirementAge) {
        const accEvent = activeLifeEvents.find(ev => ev.type === 'accumulate');
        if (accEvent) {
            const accLabel = `Jan ${accEvent.triggerDateInt.year}`;
            const accIdx = labels.indexOf(accLabel);
            if (accIdx >= 0) markers.push({ index: accIdx, color: '#0F6E56', label: 'Accumulate' });
        }
    }

    // Retire line — already drawn by retirementLinePlugin, but we want consistent style
    // Skip — let the existing plugin handle it to avoid double-drawing

    // Cursor
    const cursorLabel = `${MONTH_NAMES[store.selectedMonth - 1]} ${store.selectedYear}`;
    const cursorIdx = labels.indexOf(cursorLabel);
    if (cursorIdx >= 0) markers.push({ index: cursorIdx, color: '#111827', label: '\u25BC' });

    return markers;
}

function updateProjectionCursor() {
    if (!activePortfolio) return;
    const markers = buildPhaseMarkersForCharts();
    if (macroChart) {
        macroChart.options.plugins.dateMarkers = { markers };
        macroChart.update('none');
    }
    if (microChart) {
        microChart.options.plugins.dateMarkers = { markers };
        microChart.update('none');
    }

    // Simulation charts
    const mcChart = getMonteCarloChart();
    if (mcChart) {
        mcChart.options.plugins.dateMarkers = { markers: buildSimulationMarkers(mcChart, getMonteCarloResults()?.labels) };
        mcChart.update('none');
    }
    const grChart = getGuardrailsChart();
    if (grChart) {
        grChart.options.plugins.dateMarkers = { markers: buildSimulationMarkers(grChart) };
        grChart.update('none');
    }
}

function updateCharts() {
    if (!activePortfolio) return;

    const modelAssets = assetList.modelAssets || [];
    const p2 = new Portfolio(modelAssets);
    p2.lifeEvents = activeLifeEvents.map(e => e.copy());
    chronometer_run(p2);
    p2.buildChartingDisplayData();
    activePortfolio = p2;

    rebuildProjectionCharts();
}


// ── Timeline ────────────────────────────────────────────────

function updateTimeline() {
    if (!timeline) return;
    timeline.startAge = global_user_startAge;
    timeline.retirementAge = global_user_retirementAge;
    timeline.finishAge = global_user_finishAge;
    timeline.lifeEvents = activeLifeEvents;
    timeline.portfolio = activePortfolio;
    timeline.metricName = activeMetricName;
}

// ── Asset List Events ───────────────────────────────────────

function connectAssetListEvents() {
    assetList.addEventListener('edit-asset', (ev) => {
        openEditAssetModal(ev.detail.modelAsset);
    });

    assetList.addEventListener('show-transfers', (ev) => {
        showPopupTransfers(ev.detail.modelAsset.displayName);
    });

    assetList.addEventListener('quick-start', () => {
        assetList.modelAssets = quickStartAssets();
        activeLifeEvents = quickStartLifeEvents();
        calculate();
    });

    assetList.addEventListener('remove-asset', (ev) => {
        assetList.modelAssets = assetList.modelAssets.filter(a => a !== ev.detail.modelAsset);
        calculate();
    });

    assetList.addEventListener('select-asset', (ev) => {
        // Toggle highlight (for future chart highlight support)
        assetList.highlightName = ev.detail.modelAsset.displayName;
    });

    assetList.addEventListener('group-toggle', (ev) => {
        const group = ev.detail.group;
        if (expandedGroups.has(group)) expandedGroups.delete(group);
        else expandedGroups.add(group);
        assetList.expandedGroups = new Set(expandedGroups);
        rebuildMicroChart();
    });
}

// ── Asset Form ──────────────────────────────────────────────

function connectAssetFormModal() {
    assetFormModal.addEventListener('save-asset', (ev) => {
        const { modelAsset: newAsset, mode } = ev.detail;
        if (mode === 'create') {
            assetList.modelAssets = [...(assetList.modelAssets || []), newAsset];
        } else if (mode === 'edit' && editingModelAsset) {
            editingModelAsset.instrument = newAsset.instrument;
            editingModelAsset.displayName = newAsset.displayName;
            editingModelAsset.startDateInt = newAsset.startDateInt;
            editingModelAsset.startCurrency = newAsset.startCurrency;
            editingModelAsset.finishDateInt = newAsset.finishDateInt;
            editingModelAsset.annualReturnRate = newAsset.annualReturnRate;
            editingModelAsset.startBasisCurrency = newAsset.startBasisCurrency;
            editingModelAsset.monthsRemaining = newAsset.monthsRemaining;
            editingModelAsset.annualDividendRate = newAsset.annualDividendRate;
            editingModelAsset.longTermCapitalHoldingPercentage = newAsset.longTermCapitalHoldingPercentage;
            editingModelAsset.isSelfEmployed = newAsset.isSelfEmployed;
            editingModelAsset.annualTaxRate = newAsset.annualTaxRate;
            editingModelAsset = null;
        }
        calculate();
    });
}

function openCreateAssetModal(preselectedInstrument, preselectedStartDate) {
    assetFormModal.mode = 'create';
    assetFormModal.modelAsset = null;
    assetFormModal.preselectedInstrument = preselectedInstrument || null;
    assetFormModal.preselectedStartDate = preselectedStartDate || null;
    assetFormModal.open = true;
}

function openEditAssetModal(modelAsset) {
    editingModelAsset = modelAsset;
    assetFormModal.mode = 'edit';
    assetFormModal.modelAsset = modelAsset;
    assetFormModal.open = true;
}

// ── Transfer Modal ──────────────────────────────────────────

function connectTransferModal() {
    transferModal.addEventListener('save-transfers', (ev) => {
        const { displayName, fundTransfers } = ev.detail;
        // Default to first life event (accumulate phase)
        const activePhase = activeLifeEvents[0];
        if (activePhase) {
            activePhase.phaseTransfers[displayName] = fundTransfers.map(ft => ft.toJSON());
        }
        calculate();
    });
}

function showPopupTransfers(currentDisplayName) {
    const activePhase = activeLifeEvents[0];
    transferModal.currentDisplayName = currentDisplayName;
    transferModal.modelAssets = assetList.modelAssets || [];
    transferModal.phaseTransfers = activePhase?.phaseTransfers ?? {};
    transferModal.open = true;
}

// ── Persistence ─────────────────────────────────────────────

function saveLocalData() {
    const slotName = activeStoryName;
    util_saveLocalAssetModels(activeStoryArc, slotName, assetList.modelAssets || []);
    util_saveLocalLifeEvents(activeStoryArc, slotName, activeLifeEvents.map(e => e.toJSON()));
}
