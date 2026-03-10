/**
 * app.js - ES6 Module Application Entry Point
 *
 * Replaces all inline scripts from index.html.
 * Imports from all ES6 modules directly.
 * Exposes onclick-referenced functions on window.
 */

// Core types
import { findByName } from './asset-queries.js';
import { Metric, MetricLabel } from './model-asset.js';


// Chronometer and summary
import { chronometer_run, chronometer_run_animated } from './chronometer.js';

// Membrane (model conversion)
import { membrane_rawDataToModelAssets } from './membrane.js';
import { quickStartAssets } from './quick-start.js';

// Lit components
import './components/asset-list.js';
import './components/asset-form-modal.js';
import './components/transfer-modal.js';
import './components/portfolio-ledger.js';

// Charting
import {
    charting_getHighlightDisplayName,
    charting_setHighlightDisplayName,
    charting_jsonMetric1ChartData,
    charting_buildFromPortfolio,
    charting_buildPortfolioMetric,
} from './charting.js';

// Monte Carlo
import { runMonteCarlo } from './monte-carlo.js';

// Guardrails
import { runGuardrails } from './guardrails.js';

// Logger
import { logger, LogCategory } from './utils/logger.js';

// Tax and portfolio
import { TaxTable } from './taxes.js';
import { Portfolio } from './portfolio.js';

// Globals
import {
    setActiveTaxTable,
    global_initialize,
    global_inflationRate,
    global_taxYear,
    global_filingAs,
    global_user_startAge,
    global_user_retirementAge,
    global_user_finishAge,
    global_backtestYear,
    global_multBy100,
    global_divBy100,
    global_setInflationRate,
    global_getInflationRate,
    global_setTaxYear,
    global_getTaxYear,
    global_setFilingAs,
    global_getFilingAs,
    global_setUserStartAge,
    global_getUserStartAge,
    global_setUserRetirementAge,
    global_setUserFinishAge,
    global_setBacktestYear,
    global_getBacktestYear,
    global_guardrail_withdrawalRate,
    global_guardrail_preservation,
    global_guardrail_prosperity,
    global_guardrail_adjustment,
    global_setGuardrailWithdrawalRate,
    global_setGuardrailPreservation,
    global_setGuardrailProsperity,
    global_setGuardrailAdjustment,
    global_default_guardrail_withdrawalRate,
    global_default_guardrail_preservation,
    global_default_guardrail_prosperity,
    global_default_guardrail_adjustment,
} from './globals.js';

// Util
import {
    util_YYYYmm,
    util_ensureStoryNames,
    util_saveLocalAssetModels,
    util_loadLocalAssetModels,
    util_saveLocalGuardrailParams,
    util_loadLocalGuardrailParams,
} from './utils/util.js';

// Spreadsheet + Credit Memos (Lit components)
import './components/spreadsheet-view.js';
import './components/credit-memo-view.js';

// Debug tab view (Lit component)
import './components/debug-report-view.js';

// Simulator modal (Lit component)
import './components/simulator-modal.js';

// Share modal (Lit component)
import './components/share-modal.js';

// ─── DOM Element References ──────────────────────────────────

const assetFormModal = document.getElementById('assetFormModal');
const assetsContainerElement = document.getElementById('assets');

const portfolioLedger = document.getElementById('portfolioLedger');

const chartMetric1Canvas = document.getElementById('chartMetric1Canvas');
const spreadsheetElement = document.getElementById('spreadsheetElement');
const creditMemosElement = document.getElementById('creditMemosElement');
const debugReportsElement = document.getElementById('debugReportsElement');
const transferModal = document.getElementById('transferModal');
const shareModal = document.getElementById('shareModal');

const tab1 = document.getElementById('tab1');
const tab2 = document.getElementById('tab2');
const tab3 = document.getElementById('tab3');
const tab4 = document.getElementById('tab4');
const tab5 = document.getElementById('tab5');
const tab6 = document.getElementById('tab6');

// ─── App State ───────────────────────────────────────────────

let activeAssetsElement = assetsContainerElement;
let activeStoryArc = null;
let activeStoryName = null;
let activeScenario = 'default';
let activeMetric1Canvas = null;
let editingModelAsset = null;
let activeMetric1Name = Metric.VALUE;
let activePortfolio = null;
let monteCarloStale = true;
let guardrailsStale = true;

const metric1Select = document.getElementById('metric1Select');
const monteCarloContainer = document.getElementById('monteCarloContainer');
const guardrailsContainer = document.getElementById('guardrailsContainer');
const guardrailsCanvas = document.getElementById('guardrailsCanvas');

// ─── Metric Select Setup ─────────────────────────────────────

function populateMetricSelects() {
    const options = Object.values(Metric).map(m =>
        '<option value="' + m + '">' + MetricLabel[m] + '</option>'
    ).join('');
    metric1Select.innerHTML = options;
    metric1Select.value = activeMetric1Name;
    tab1.querySelector('.tab-label').textContent = MetricLabel[activeMetric1Name];
}

metric1Select.addEventListener('click', function(ev) { ev.stopPropagation(); });
metric1Select.addEventListener('change', function() {
    activeMetric1Name = metric1Select.value;
    tab1.querySelector('.tab-label').textContent = MetricLabel[activeMetric1Name];
    portfolioLedger.metricName = activeMetric1Name;
    if (!activePortfolio) return;
    const chartData = charting_buildPortfolioMetric(activePortfolio, activeMetric1Name, true);
    if (activeMetric1Canvas != null) activeMetric1Canvas.destroy();
    activeMetric1Canvas = new Chart(chartMetric1Canvas, chartData);
});

portfolioLedger.addEventListener('ledger-metric1-change', function(e) {
    activeMetric1Name = e.detail.metricName;
    metric1Select.value = activeMetric1Name;
    tab1.querySelector('.tab-label').textContent = MetricLabel[activeMetric1Name];
    if (!activePortfolio) return;
    const chartData = charting_buildPortfolioMetric(activePortfolio, activeMetric1Name, true);
    if (activeMetric1Canvas != null) activeMetric1Canvas.destroy();
    activeMetric1Canvas = new Chart(chartMetric1Canvas, chartData);
});


// ─── Initial Setup Functions ─────────────────────────────────

function initiateActiveData() {
    logger.log(LogCategory.INIT, 'initiateActiveData');

    activeStoryArc = localStorage.getItem('activeStoryArc');
    if (!activeStoryArc)
        activeStoryArc = 'default';

    activeStoryName = localStorage.getItem('activeStoryName');
    if (!activeStoryName) {
        activeStoryName = util_YYYYmm();
        util_ensureStoryNames(activeStoryArc, activeStoryName);
    }

    // Restore active scenario
    const savedScenario = localStorage.getItem('activeScenario');
    if (savedScenario && ['Scenario1', 'Scenario2', 'Fittest'].includes(savedScenario)) {
        activeScenario = savedScenario;
    }
    document.getElementById('scenario-select').value = activeScenario;
    updateResetButtonVisibility();

    // Get the last working data set
    loadLocalData();
}

function connectAssetFormModal() {
    logger.log(LogCategory.INIT, 'connectAssetFormModal');

    assetFormModal.addEventListener('save-asset', function(ev) {
        const { modelAsset: newAsset, mode } = ev.detail;

        if (mode === 'create') {
            assetsContainerElement.modelAssets = [...(assetsContainerElement.modelAssets || []), newAsset];
        } else if (mode === 'edit' && editingModelAsset) {
            // Copy updated properties back to the editing model asset
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

        calculate('assets');
    });
}

function openCreateAssetModal() {
    assetFormModal.mode = 'create';
    assetFormModal.modelAsset = null;
    assetFormModal.open = true;
}

function openEditAssetModal(modelAsset) {
    editingModelAsset = modelAsset;
    assetFormModal.mode = 'edit';
    assetFormModal.modelAsset = modelAsset;
    assetFormModal.open = true;
}

function connectAssetListEvents() {
    logger.log(LogCategory.INIT, 'connectAssetListEvents');

    assetsContainerElement.addEventListener('edit-asset', function(ev) {
        openEditAssetModal(ev.detail.modelAsset);
    });

    assetsContainerElement.addEventListener('show-transfers', function(ev) {
        showPopupTransfers(ev.detail.modelAsset.displayName);
    });

    assetsContainerElement.addEventListener('quick-start', function() {
        assetsContainerElement.modelAssets = quickStartAssets();
        calculate('assets');
    });

    assetsContainerElement.addEventListener('remove-asset', function(ev) {
        const ma = ev.detail.modelAsset;
        assetsContainerElement.modelAssets = assetsContainerElement.modelAssets.filter(a => a !== ma);
        calculate('assets');
    });

    assetsContainerElement.addEventListener('select-asset', function(ev) {
        const clickedName = ev.detail.modelAsset.displayName;
        if (charting_getHighlightDisplayName() == null || clickedName !== charting_getHighlightDisplayName()) {
            charting_setHighlightDisplayName(clickedName);
        } else {
            charting_setHighlightDisplayName(null);
        }
        assetsContainerElement.highlightName = charting_getHighlightDisplayName();
        updateCharts();
    });
}

// ─── Tab Handling ────────────────────────────────────────────

function hideAllTabs() {
    const tabs = [
        { tab: tab1, content: chartMetric1Canvas.parentElement },
        { tab: tab2, content: monteCarloContainer },
        { tab: tab3, content: guardrailsContainer },
        { tab: tab4, content: spreadsheetElement.parentElement },
        { tab: tab5, content: creditMemosElement.parentElement },
        { tab: tab6, content: debugReportsElement.parentElement },
    ];
    for (const { tab, content } of tabs) {
        tab.classList.remove('active');
        content.style.display = 'none';
    }
}

function tab1_click() {
    hideAllTabs();
    tab1.classList.add('active');
    chartMetric1Canvas.parentElement.style.display = '';
}

function tab2_click() {
    hideAllTabs();
    tab2.classList.add('active');
    monteCarloContainer.style.display = 'flex';

    if (monteCarloStale && activePortfolio) {
        monteCarloStale = false;
        const chartArea = document.getElementById('monteCarloChartArea');
        const useGuardrails = document.getElementById('monte-carlo-guardrails').checked;
        runMonteCarlo(activePortfolio.modelAssets, chartArea, 1000,
            useGuardrails ? getGuardrailsParams() : null);
    }
}

function getGuardrailsParams() {
    return {
        withdrawalRate: parseFloat(document.getElementById('guardrail-withdrawal-rate').value) || 4,
        preservation: parseFloat(document.getElementById('guardrail-preservation').value) || 20,
        prosperity: parseFloat(document.getElementById('guardrail-prosperity').value) || 20,
        adjustment: parseFloat(document.getElementById('guardrail-adjustment').value) || 10,
    };
}

function syncGuardrailsToDOM() {
    document.getElementById('guardrail-withdrawal-rate').value = global_guardrail_withdrawalRate;
    document.getElementById('guardrail-preservation').value = global_guardrail_preservation;
    document.getElementById('guardrail-prosperity').value = global_guardrail_prosperity;
    document.getElementById('guardrail-adjustment').value = global_guardrail_adjustment;
}

function refreshGuardrails() {
    if (activePortfolio) {
        guardrailsStale = false;
        runGuardrails(activePortfolio.modelAssets, guardrailsCanvas, getGuardrailsParams());
    }
}

function tab3_click() {
    hideAllTabs();
    tab3.classList.add('active');
    guardrailsContainer.style.display = 'flex';

    if (guardrailsStale) {
        refreshGuardrails();
    }
}

function tab4_click() {
    hideAllTabs();
    tab4.classList.add('active');
    spreadsheetElement.parentElement.style.display = '';
}

function tab5_click() {
    hideAllTabs();
    tab5.classList.add('active');
    creditMemosElement.parentElement.style.display = '';
}

function tab6_click() {
    hideAllTabs();
    tab6.classList.add('active');
    debugReportsElement.parentElement.style.display = '';
}

// ─── Scenarios ───────────────────────────────────────────────

function switchScenario(newScenario) {
    // Save current work to current slot before switching
    saveLocalData();

    activeScenario = newScenario;
    localStorage.setItem('activeScenario', activeScenario);

    // Fittest: if no data exists yet, launch the genetic algorithm
    if (activeScenario === 'Fittest') {
        const data = util_loadLocalAssetModels(activeStoryArc, 'Fittest');
        if (!data) {
            updateResetButtonVisibility();
            doMaximize();
            return;
        }
    }

    // Clone Default into scenario slot if it doesn't exist yet
    if (activeScenario !== 'default' && activeScenario !== 'Fittest') {
        const data = util_loadLocalAssetModels(activeStoryArc, activeScenario);
        if (!data) {
            const defaultData = util_loadLocalAssetModels(activeStoryArc, activeStoryName);
            util_saveLocalAssetModels(activeStoryArc, activeScenario, defaultData || []);
        }
    }

    loadLocalData();
    updateResetButtonVisibility();
}

function resetScenario() {
    if (activeScenario === 'default') return;
    const defaultData = util_loadLocalAssetModels(activeStoryArc, activeStoryName);
    util_saveLocalAssetModels(activeStoryArc, activeScenario, defaultData || []);
    loadLocalData();
}

function updateResetButtonVisibility() {
    const btn = document.getElementById('btn-scenario-reset');
    btn.classList.toggle('invisible', activeScenario === 'default' || activeScenario === 'Fittest');
}

// ─── Charting and Calculation ────────────────────────────────

function updateActiveAssetsElement(assetsElement) {
    assetsContainerElement.classList.remove('selected-assets');
    assetsElement.classList.add('selected-assets');
    activeAssetsElement = assetsElement;
}

function ensureHighlightDisplayName() {
    assetsContainerElement.highlightName = charting_getHighlightDisplayName();
}

function updateCharts() {
    let modelAssets = assetsContainerElement.modelAssets || [];
    let portfolio = new Portfolio(modelAssets);
    activePortfolio = portfolio;
    chronometer_run(portfolio);
    portfolio.buildChartingDisplayData();
    ensureHighlightDisplayName();
    charting_buildFromPortfolio(portfolio, false, activeMetric1Name);
    activeMetric1Canvas.update();
}

function calculate(target) {

    if (target == 'assets')
        updateActiveAssetsElement(assetsContainerElement);

    let modelAssets = assetsContainerElement.modelAssets || [];    
    let portfolio = new Portfolio(modelAssets, true);
    chronometer_run(portfolio);

    // Update asset cards with calculated values
    assetsContainerElement.modelAssets = [...portfolio.modelAssets];

    // prepare the chart data
    portfolio.buildChartingDisplayData();

    // if there is a highlightDisplayName, make sure it's selected
    ensureHighlightDisplayName();

    // store portfolio for metric select change handlers
    activePortfolio = portfolio;
    monteCarloStale = true;
    guardrailsStale = true;

    // If Monte Carlo or Guardrails tab is active, refresh immediately
    if (tab2.classList.contains('active')) {
        monteCarloStale = false;
        const chartArea = document.getElementById('monteCarloChartArea');
        const useGuardrails = document.getElementById('monte-carlo-guardrails').checked;
        runMonteCarlo(portfolio.modelAssets, chartArea, 1000,
            useGuardrails ? getGuardrailsParams() : null);
    } else if (tab3.classList.contains('active')) {
        guardrailsStale = false;
        runGuardrails(portfolio.modelAssets, guardrailsCanvas, getGuardrailsParams());
    }

    // build the chart configs (must happen before innerCalculate creates Chart instances)
    charting_buildFromPortfolio(portfolio, true, activeMetric1Name);

    innerCalculate(portfolio);

    if (activeAssetsElement == assetsContainerElement) {
        saveLocalData();
    }

    // Update ledger display
    portfolioLedger.metricName = activeMetric1Name;
    portfolioLedger.portfolio = portfolio;
}

function innerCalculate(portfolio) {
    if (activeMetric1Canvas != null)
        activeMetric1Canvas.destroy();
    if (charting_jsonMetric1ChartData != null)
        activeMetric1Canvas = new Chart(chartMetric1Canvas, charting_jsonMetric1ChartData);
    spreadsheetElement.portfolio = portfolio;
    creditMemosElement.portfolio = portfolio;
    debugReportsElement.reports = portfolio.generatedReports;
}

function saveLocalData() {
    // Don't overwrite GA-generated fittest scenario with manual edits
    if (activeScenario === 'Fittest') return;
    const slotName = activeScenario === 'default' ? activeStoryName : activeScenario;
    util_saveLocalAssetModels(activeStoryArc, slotName, assetsContainerElement.modelAssets || []);
    util_saveLocalGuardrailParams(activeStoryArc, slotName, getGuardrailsParams());
}

function loadLocalData() {
    const slotName = activeScenario === 'default' ? activeStoryName : activeScenario;
    let assetModelsRaw = util_loadLocalAssetModels(activeStoryArc, slotName);
    assetsContainerElement.modelAssets = membrane_rawDataToModelAssets(assetModelsRaw);

    // Load per-scenario guardrail params (fall back to globals if none saved)
    const gp = util_loadLocalGuardrailParams(activeStoryArc, slotName);
    if (gp) {
        global_setGuardrailWithdrawalRate(gp.withdrawalRate);
        global_setGuardrailPreservation(gp.preservation);
        global_setGuardrailProsperity(gp.prosperity);
        global_setGuardrailAdjustment(gp.adjustment);
        syncGuardrailsToDOM();
    }

    calculate('assets');
}

// ─── Visualizer ──────────────────────────────────────────────

let isVisualizing = false;

async function doVisualize() {
    if (isVisualizing) return;
    isVisualizing = true;

    const popup = document.getElementById('popupFormVisualize');
    popup.classList.remove('hidden');
    popup.style.display = 'flex'; // Force display to override Tailwind hidden

    let modelAssets = assetsContainerElement.modelAssets || [];
    
    // Crucial: We create a throwaway copy of the portfolio so the animation 
    // doesn't pollute your real ledger / charts while it runs!
    let portfolio = new Portfolio(modelAssets, false);

    // Launch the animation loop
    await chronometer_run_animated(portfolio, 'hydraulic-container');
    
    isVisualizing = false;
}

// ─── Simulation ──────────────────────────────────────────────

function _ensureSimModal() {
    let simModal = document.querySelector('simulator-modal');
    if (!simModal) {
        simModal = document.createElement('simulator-modal');
        document.body.appendChild(simModal);

        simModal.addEventListener('found-fittest', (e) => {
            util_saveLocalAssetModels(activeStoryArc, 'Fittest', e.detail.modelAssets);

            // Save and apply optimized guardrail params
            const gp = e.detail.guardrailParams;
            if (gp) {
                util_saveLocalGuardrailParams(activeStoryArc, 'Fittest', gp);
                global_setGuardrailWithdrawalRate(gp.withdrawalRate);
                global_setGuardrailPreservation(gp.preservation);
                global_setGuardrailProsperity(gp.prosperity);
                global_setGuardrailAdjustment(gp.adjustment);
                syncGuardrailsToDOM();
                guardrailsStale = true;
            }
        });

        simModal.addEventListener('close', () => {
            if (activeScenario === 'Fittest') {
                loadLocalData();
            }
        });
    }
    return simModal;
}

function _launchSimulator(sliderDefault) {
    const simModal = _ensureSimModal();
    simModal.modelAssets = assetsContainerElement.modelAssets || [];
    simModal.guardrailParams = getGuardrailsParams();
    simModal.fitnessBalance = sliderDefault;
    simModal.open = true;
}

function doMaximize() {
    _launchSimulator(100); // slider right → terminal value
}



// ─── Popup Functions ─────────────────────────────────────────

function donateData() {
    document.getElementById('popupFormDonate').style.display = 'block';
}

function openShareModal() {
    shareModal.modelAssets = assetsContainerElement.modelAssets || [];
    shareModal.portfolioName = activeStoryName || '';
    shareModal.globalSettings = {
        inflationRate: global_inflationRate,
        taxYear: global_taxYear,
        filingAs: global_filingAs,
        startAge: global_user_startAge,
        retirementAge: global_user_retirementAge,
        finishAge: global_user_finishAge,
    };
    shareModal.guardrailParams = getGuardrailsParams();
    shareModal.open = true;
}

function showPopupTransfers(currentDisplayName) {
    transferModal.currentDisplayName = currentDisplayName;
    transferModal.modelAssets = assetsContainerElement.modelAssets || [];
    transferModal.open = true;
}

function connectTransferModal() {
    logger.log(LogCategory.INIT, 'connectTransferModal');

    transferModal.addEventListener('save-transfers', function(ev) {
        const { displayName, fundTransfers } = ev.detail;
        let modelAsset = findByName(assetsContainerElement.modelAssets || [], displayName);
        if (modelAsset) {
            modelAsset.fundTransfers = fundTransfers;
        }
        calculate();
    });
}

// Close buttons
const closeButtonElements = document.querySelectorAll('.closeBtn');
for (const closeButtonElement of closeButtonElements) {
    closeButtonElement.addEventListener('click', function() {
        closeButtonElement.parentElement.parentElement.style.display = 'none';
    });
}

// ─── Guardrails Input Listeners ──────────────────────────────
const guardrailSetters = {
    'guardrail-withdrawal-rate': global_setGuardrailWithdrawalRate,
    'guardrail-preservation': global_setGuardrailPreservation,
    'guardrail-prosperity': global_setGuardrailProsperity,
    'guardrail-adjustment': global_setGuardrailAdjustment,
};
for (const [id, setter] of Object.entries(guardrailSetters)) {
    document.getElementById(id).addEventListener('change', function() {
        setter(parseFloat(this.value));
        if (tab3.classList.contains('active')) {
            refreshGuardrails();
        } else {
            guardrailsStale = true;
        }
    });
}

// Monte Carlo guardrails checkbox — rerun when toggled
document.getElementById('monte-carlo-guardrails').addEventListener('change', function() {
    if (activePortfolio) {
        const chartArea = document.getElementById('monteCarloChartArea');
        runMonteCarlo(activePortfolio.modelAssets, chartArea, 1000,
            this.checked ? getGuardrailsParams() : null);
    }
});

// ─── Button Event Listeners ──────────────────────────────────

document.getElementById('btn-calculate').addEventListener('click', () => calculate('assets'));
document.getElementById('scenario-select').addEventListener('change', (e) => switchScenario(e.target.value));
document.getElementById('btn-scenario-reset').addEventListener('click', resetScenario);
document.getElementById('btn-donate').addEventListener('click', donateData);
document.getElementById('btn-share').addEventListener('click', openShareModal);
document.getElementById('btn-add-asset').addEventListener('click', openCreateAssetModal);
document.getElementById('btn-visualize').addEventListener('click', doVisualize);
document.getElementById('btn-maximize').addEventListener('click', doMaximize);
document.getElementById('btn-revert-guardrails').addEventListener('click', () => {
    global_setGuardrailWithdrawalRate(global_default_guardrail_withdrawalRate);
    global_setGuardrailPreservation(global_default_guardrail_preservation);
    global_setGuardrailProsperity(global_default_guardrail_prosperity);
    global_setGuardrailAdjustment(global_default_guardrail_adjustment);
    syncGuardrailsToDOM();
    refreshGuardrails();
});

// Tab switching
tab1.addEventListener('click', tab1_click);
tab2.addEventListener('click', tab2_click);
tab3.addEventListener('click', tab3_click);
tab4.addEventListener('click', tab4_click);
tab5.addEventListener('click', tab5_click);
tab6.addEventListener('click', tab6_click);

// ─── Settings Row ─────────────────────────────────────────────

function syncGlobalsToSettings() {
    document.getElementById('setting-startAge').value = global_user_startAge;
    document.getElementById('setting-taxYear').value = global_taxYear;
    document.getElementById('setting-filingAs').value = global_filingAs;
    document.getElementById('setting-inflationRate').value = global_multBy100(global_inflationRate);
    document.getElementById('setting-backtestYear').value = global_backtestYear;
}

function connectSettings() {
    document.getElementById('setting-startAge').addEventListener('change', function() {
        global_setUserStartAge(parseInt(this.value));
        global_getUserStartAge();
        calculate('assets');
    });
    document.getElementById('setting-taxYear').addEventListener('change', function() {
        global_setTaxYear(parseInt(this.value));
        global_getTaxYear();
        setActiveTaxTable(new TaxTable());
        calculate('assets');
    });
    document.getElementById('setting-filingAs').addEventListener('change', function() {
        global_setFilingAs(this.value);
        global_getFilingAs();
        setActiveTaxTable(new TaxTable());
        calculate('assets');
    });
    document.getElementById('setting-inflationRate').addEventListener('change', function() {
        global_setInflationRate(global_divBy100(this.value));
        global_getInflationRate();
        calculate('assets');
    });
    document.getElementById('setting-backtestYear').addEventListener('change', function() {
        global_setBacktestYear(this.value);
        global_getBacktestYear();
        calculate('assets');
    });
}

// ─── Initialize ──────────────────────────────────────────────

function loadSharedPortfolio() {
    const params = new URLSearchParams(window.location.search);
    const compressed = params.get('portfolio');
    if (!compressed) return false;

    try {
        const json = LZString.decompressFromEncodedURIComponent(compressed);
        if (!json) return false;
        const data = JSON.parse(json);

        // Apply global settings
        if (data.settings) {
            global_setInflationRate(data.settings.inflationRate);
            global_setTaxYear(data.settings.taxYear);
            global_setFilingAs(data.settings.filingAs);
            global_setUserStartAge(data.settings.startAge);
            global_setUserRetirementAge(data.settings.retirementAge);
            global_setUserFinishAge(data.settings.finishAge);
            setActiveTaxTable(new TaxTable());
            syncGlobalsToSettings();
        }

        // Load guardrail params
        if (data.guardrailParams) {
            const gp = data.guardrailParams;
            global_setGuardrailWithdrawalRate(gp.withdrawalRate);
            global_setGuardrailPreservation(gp.preservation);
            global_setGuardrailProsperity(gp.prosperity);
            global_setGuardrailAdjustment(gp.adjustment);
            syncGuardrailsToDOM();
        }

        // Load assets
        if (data.modelAssets) {
            assetsContainerElement.modelAssets = membrane_rawDataToModelAssets(data.modelAssets);
            calculate('assets');
        }

        // Clean URL without reloading
        window.history.replaceState({}, '', window.location.pathname);
        return true;
    } catch (e) {
        console.error('Failed to load shared portfolio:', e);
        return false;
    }
}

function initialize() {
    global_initialize();
    setActiveTaxTable(new TaxTable());
    syncGlobalsToSettings();
    syncGuardrailsToDOM();
    connectSettings();
    populateMetricSelects();
    connectAssetFormModal();
    connectTransferModal();
    connectAssetListEvents();

    // Check for shared portfolio in URL first, otherwise load local data
    if (!loadSharedPortfolio()) {
        initiateActiveData();
    }
}

// Modules are deferred — DOM is ready, no need for DOMContentLoaded
initialize();
