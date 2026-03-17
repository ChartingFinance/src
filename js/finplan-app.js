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
import { Metric } from './model-asset.js';
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
    charting_buildGroupedMetric,
    charting_buildPortfolioMetric,
    charting_jsonMetric1ChartData,
    charting_jsonRollupChartData,
} from './charting.js';

// ── Simulations ─────────────────────────────────────────────
import { runMonteCarlo } from './monte-carlo.js';
import { runGuardrails } from './guardrails.js';

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

// Wire buttons
document.getElementById('btn-calculate').addEventListener('click', () => calculate());
document.getElementById('btn-add-asset').addEventListener('click', () => openCreateAssetModal());
document.getElementById('btn-run-mc').addEventListener('click', () => doMonteCarlo());
document.getElementById('btn-run-guardrails').addEventListener('click', () => doGuardrails());
document.getElementById('btn-visualize').addEventListener('click', () => doVisualize());
document.getElementById('btn-maximize').addEventListener('click', () => doMaximize());

// Wire store
store.setRetirementDate(global_getRetirementDateInt());
store.setSelectedDate(DateInt.today());

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function updateViewingBadge(year, month) {
    if (viewingBadge) viewingBadge.textContent = `Viewing: ${MONTH_NAMES[month - 1]} ${year}`;
}
updateViewingBadge(store.selectedYear, store.selectedMonth);
store.addEventListener('date-change', (e) => updateViewingBadge(e.detail.year, e.detail.month));

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

    // Build charting data
    portfolio.buildChartingDisplayData();

    // Build chart configs
    charting_buildFromPortfolio(portfolio, true, activeMetricName, expandedGroups);

    // Render macro chart
    if (macroChart) macroChart.destroy();
    if (charting_jsonMetric1ChartData) {
        const cfg = charting_jsonMetric1ChartData;
        macroChart = new Chart(macroCanvas, cfg);
    }

    // Render micro chart (cash flow rollup)
    if (microChart) microChart.destroy();
    if (charting_jsonRollupChartData) {
        const cfg = charting_jsonRollupChartData;
        microChart = new Chart(microCanvas, cfg);
    }

    // Update details
    if (spreadsheetView) spreadsheetView.portfolio = portfolio;
    if (reportView) reportView.reports = portfolio.generatedReports;

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
}

function doGuardrails() {
    if (!activePortfolio) return;
    runGuardrails(
        activePortfolio.modelAssets, guardrailsCanvas, getGuardrailParams(),
        global_getRetirementDateInt(), activeLifeEvents
    );
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

function updateCharts() {
    if (!activePortfolio) return;

    const modelAssets = assetList.modelAssets || [];
    const p2 = new Portfolio(modelAssets);
    p2.lifeEvents = activeLifeEvents.map(e => e.copy());
    chronometer_run(p2);
    p2.buildChartingDisplayData();

    charting_buildFromPortfolio(p2, true, activeMetricName, expandedGroups);

    if (macroChart) macroChart.destroy();
    if (charting_jsonMetric1ChartData) {
        const cfg = charting_jsonMetric1ChartData;
        macroChart = new Chart(macroCanvas, cfg);
    }

    if (microChart) microChart.destroy();
    if (charting_jsonRollupChartData) {
        const cfg = charting_jsonRollupChartData;
        microChart = new Chart(microCanvas, cfg);
    }
}


// ── Timeline ────────────────────────────────────────────────

function updateTimeline() {
    if (!timeline) return;
    timeline.startAge = global_user_startAge;
    timeline.retirementAge = global_user_retirementAge;
    timeline.finishAge = global_user_finishAge;
    timeline.lifeEvents = activeLifeEvents;
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
        updateCharts();
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
