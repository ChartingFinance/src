/**
 * app.js - ES6 Module Application Entry Point
 *
 * Replaces all inline scripts from index.html.
 * Imports from all ES6 modules directly.
 * Exposes onclick-referenced functions on window.
 */

// Core types
import { DateInt } from './date-int.js';
import { findByName } from './asset-queries.js';
import { Metric, MetricLabel } from './model-asset.js';

// HTML builder functions
import {
    html_buildInstrumentOptions,
    html_buildInstrumentFields,
    html_applyModelAssetToPopupTransfers,
    html_buildTransferrableAssets,
} from './html.js';

// Chronometer and summary
import { chronometer_run } from './chronometer.js';

// Membrane (model conversion)
import {
    membrane_htmlElementToAssetModel,
    membrane_rawDataToModelAssets,
    membrane_htmlElementsToFundTransfers,
} from './membrane.js';

// Asset list Lit component
import './components/asset-list.js';

// Charting
import {
    charting_getHighlightDisplayName,
    charting_setHighlightDisplayName,
    charting_jsonMetric1ChartData,
    charting_jsonMetric2ChartData,
    charting_jsonRollupChartData,
    charting_buildFromPortfolio,
    charting_buildPortfolioMetric,
    charting_buildFromModelAsset,
    charting_jsonMetricChartConfigIndividual,
} from './charting.js';

// Logger
import { logger, LogCategory } from './logger.js';

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
    global_getUserRetirementAge,
    global_setUserFinishAge,
    global_getUserFinishAge,
} from './globals.js';

// Util
import {
    util_YYYYmm,
    util_ensureStoryNames,
    util_saveLocalAssetModels,
    util_loadLocalAssetModels,
    util_loadFromStorage,
} from './util.js';

// Spreadsheet + Credit Memos (Lit components)
import './components/spreadsheet-view.js';
import './components/credit-memo-view.js';

// MCP
import { savePortfolioToFile } from './mcp-client.js';

// Debug panel
import { toggle as toggleDebugPanel, clearReports as debugPanelClearReports } from './debug-panel.js';

// Debug tab view (Lit component)
import './components/debug-report-view.js';
import { getReports } from './debug-panel.js';

// Simulator popup
import { openSimulatorPopup } from './simulator-popup.js';

// ─── DOM Element References ──────────────────────────────────

const assetElement = document.getElementById('asset');
const assetEditElement = document.getElementById('assetEdit');

const assetsContainerElement = document.getElementById('assets');

const assetsSummaryElement = document.getElementById('rollup1');

const chartMetric1Canvas = document.getElementById('chartMetric1Canvas');
const chartMetric2Canvas = document.getElementById('chartMetric2Canvas');
const chartRollupCanvas = document.getElementById('chartRollupCanvas');
const spreadsheetElement = document.getElementById('spreadsheetElement');
const creditMemosElement = document.getElementById('creditMemosElement');
const debugReportsElement = document.getElementById('debugReportsElement');
const chartEarningsCanvasIndividual = document.getElementById('chartEarningsCanvasIndividual');

const instrumentFieldsCreate = document.getElementById('instrumentFieldsCreate');
const instrumentFieldsEdit = document.getElementById('instrumentFieldsEdit');

const tab1 = document.getElementById('tab1');
const tab2 = document.getElementById('tab2');
const tab3 = document.getElementById('tab3');
const tab4 = document.getElementById('tab4');
const tab5 = document.getElementById('tab5');
const tab6 = document.getElementById('tab6');

// ─── App State ───────────────────────────────────────────────

let activeAssetsElement = assetsContainerElement;
let activeSummaryElement = assetsSummaryElement;
let activeStoryArc = null;
let activeStoryName = null;
let activeMetric1Canvas = null;
let activeMetric2Canvas = null;
let activeRollupCanvas = null;
let activeEarningsCanvasIndividual = null;
let editingModelAsset = null;
let activeMetric1Name = Metric.VALUE;
let activeMetric2Name = Metric.EARNING;
let activePortfolio = null;

const metric1Select = document.getElementById('metric1Select');
const metric2Select = document.getElementById('metric2Select');

// ─── Metric Select Setup ─────────────────────────────────────

function populateMetricSelects() {
    const options = Object.values(Metric).map(m =>
        '<option value="' + m + '">' + MetricLabel[m] + '</option>'
    ).join('');
    metric1Select.innerHTML = options;
    metric2Select.innerHTML = options;
    metric1Select.value = activeMetric1Name;
    metric2Select.value = activeMetric2Name;
    tab1.querySelector('.tab-label').textContent = MetricLabel[activeMetric1Name];
    tab2.querySelector('.tab-label').textContent = MetricLabel[activeMetric2Name];
}

metric1Select.addEventListener('click', function(ev) { ev.stopPropagation(); });
metric1Select.addEventListener('change', function() {
    activeMetric1Name = metric1Select.value;
    tab1.querySelector('.tab-label').textContent = MetricLabel[activeMetric1Name];
    if (!activePortfolio) return;
    const chartData = charting_buildPortfolioMetric(activePortfolio, activeMetric1Name, true);
    if (activeMetric1Canvas != null) activeMetric1Canvas.destroy();
    activeMetric1Canvas = new Chart(chartMetric1Canvas, chartData);
});

metric2Select.addEventListener('click', function(ev) { ev.stopPropagation(); });
metric2Select.addEventListener('change', function() {
    activeMetric2Name = metric2Select.value;
    tab2.querySelector('.tab-label').textContent = MetricLabel[activeMetric2Name];
    if (!activePortfolio) return;
    const chartData = charting_buildPortfolioMetric(activePortfolio, activeMetric2Name, true);
    if (activeMetric2Canvas != null) activeMetric2Canvas.destroy();
    activeMetric2Canvas = new Chart(chartMetric2Canvas, chartData);
});

// ─── Initial Setup Functions ─────────────────────────────────

function buildInstrumentOptions() {
    let selectElement = assetElement.querySelector('[name="instrument"]');
    selectElement.innerHTML = html_buildInstrumentOptions(null)
}

function initiateActiveData() {
    logger.log(LogCategory.INIT, 'initiateActiveData');

    let startDateElement = assetElement.querySelector('[name="startDate"]');
    let di = DateInt.today();
    startDateElement.value = di.toHTML();

    activeStoryArc = localStorage.getItem('activeStoryArc');
    if (!activeStoryArc)
        activeStoryArc = 'default';

    activeStoryName = localStorage.getItem('activeStoryName');
    if (!activeStoryName) {
        activeStoryName = util_YYYYmm();
        util_ensureStoryNames(activeStoryArc, activeStoryName);
    }

    // Get the last working data set
    loadLocalData();
}

function connectAssetSelect() {
    logger.log(LogCategory.INIT, 'connectAssetSelect');
    let instrumentElement = assetElement.querySelector('[name="instrument"]');

    instrumentElement.addEventListener('change', function(event) {
        instrumentFieldsCreate.innerHTML = html_buildInstrumentFields(event.target.value, null);
    });
}

function connectCreateAsset() {
    logger.log(LogCategory.INIT, 'connectCreateAsset');
    assetElement.addEventListener("submit", function(ev) {
        ev.preventDefault();

        let assetModel = membrane_htmlElementToAssetModel(assetElement);
        assetsContainerElement.modelAssets = [...(assetsContainerElement.modelAssets || []), assetModel];

        calculate('assets');

        // Close the create asset modal
        document.getElementById('popupFormCreateAsset').style.display = 'none';

        // Clear the form
        assetElement.reset();
    });
}

function openEditAssetModal(modelAsset) {
    editingModelAsset = modelAsset;

    // Populate instrument select options
    let editInstrumentSelect = assetEditElement.querySelector('[name="instrument"]');
    editInstrumentSelect.innerHTML = html_buildInstrumentOptions(modelAsset.instrument);

    // Populate form fields from modelAsset properties
    assetEditElement.querySelector('[name="displayName"]').value = modelAsset.displayName;
    assetEditElement.querySelector('[name="startDate"]').value = modelAsset.startDateInt.toHTML();
    assetEditElement.querySelector('[name="startValue"]').value = modelAsset.startCurrency.toHTML();
    assetEditElement.querySelector('[name="finishDate"]').value = modelAsset.finishDateInt.toHTML();
    assetEditElement.querySelector('[name="finishValue"]').value = modelAsset.finishCurrency ? modelAsset.finishCurrency.toHTML() : '0.0';
    assetEditElement.querySelector('[name="annualReturnRate"]').value = modelAsset.annualReturnRate.toHTML();

    // Populate instrument-specific fields
    instrumentFieldsEdit.innerHTML = html_buildInstrumentFields(modelAsset.instrument, modelAsset);

    document.getElementById('popupFormEditAsset').style.display = 'block';
}

function connectEditAsset() {
    logger.log(LogCategory.INIT, 'connectEditAsset');

    // Rebuild instrument-specific fields when instrument changes in edit form
    assetEditElement.querySelector('[name="instrument"]').addEventListener('change', function(event) {
        instrumentFieldsEdit.innerHTML = html_buildInstrumentFields(event.target.value, null);
    });

    assetEditElement.addEventListener("submit", function(ev) {
        ev.preventDefault();

        if (!editingModelAsset) return;

        // Update the modelAsset from form values via membrane (reuses existing parsing)
        let updated = membrane_htmlElementToAssetModel(assetEditElement);
        // Copy updated properties back to the editing model asset
        editingModelAsset.instrument = updated.instrument;
        editingModelAsset.displayName = updated.displayName;
        editingModelAsset.startDateInt = updated.startDateInt;
        editingModelAsset.startCurrency = updated.startCurrency;
        editingModelAsset.finishDateInt = updated.finishDateInt;
        editingModelAsset.annualReturnRate = updated.annualReturnRate;
        editingModelAsset.basisCurrency = updated.basisCurrency;
        editingModelAsset.monthsRemaining = updated.monthsRemaining;
        editingModelAsset.annualDividendRate = updated.annualDividendRate;
        editingModelAsset.longTermCapitalGainRate = updated.longTermCapitalGainRate;
        editingModelAsset.isSelfEmployed = updated.isSelfEmployed;

        // Close the edit modal
        document.getElementById('popupFormEditAsset').style.display = 'none';
        editingModelAsset = null;

        calculate('assets');
    });
}

function connectAssetListEvents() {
    logger.log(LogCategory.INIT, 'connectAssetListEvents');

    assetsContainerElement.addEventListener('edit-asset', function(ev) {
        openEditAssetModal(ev.detail.modelAsset);
    });

    assetsContainerElement.addEventListener('show-transfers', function(ev) {
        showPopupTransfers(ev.detail.modelAsset.displayName);
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

// ─── MCP Functions ───────────────────────────────────────────

async function savePortfolioViaMCP() {
    const filename = prompt('Enter filename:', 'portfolio.json');
    if (filename) {
        const success = await savePortfolioToFile(filename, assetsContainerElement.modelAssets || []);
        if (success) {
            alert('Portfolio saved successfully!');
        } else {
            alert('Failed to save portfolio');
        }
    }
}

// ─── Tab Handling ────────────────────────────────────────────

function hideAllTabs() {
    const tabs = [
        { tab: tab1, content: chartMetric1Canvas.parentElement },
        { tab: tab2, content: chartMetric2Canvas.parentElement },
        { tab: tab3, content: chartRollupCanvas.parentElement },
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
    chartMetric2Canvas.parentElement.style.display = '';
}

function tab3_click() {
    hideAllTabs();
    tab3.classList.add('active');
    chartRollupCanvas.parentElement.style.display = '';
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

// ─── Save and Recall ─────────────────────────────────────────

function aplus_save() {
    util_saveLocalAssetModels(activeStoryArc, 'APlus', assetsContainerElement.modelAssets || []);
}

function aplus_recall() {
    let assetModelsRaw = util_loadLocalAssetModels(activeStoryArc, 'APlus');
    assetsContainerElement.modelAssets = membrane_rawDataToModelAssets(assetModelsRaw);
    calculate('assets');
}

function bplus_click() {
    util_saveLocalAssetModels(activeStoryArc, 'BPlus', assetsContainerElement.modelAssets || []);
}

function bplus_recall() {
    let assetModelsRaw = util_loadLocalAssetModels(activeStoryArc, 'BPlus');
    assetsContainerElement.modelAssets = membrane_rawDataToModelAssets(assetModelsRaw);
    calculate('assets');
}

// ─── Charting and Calculation ────────────────────────────────

function updateActiveAssetsElement(assetsElement, summaryElement) {
    assetsContainerElement.classList.remove('selected-assets');
    assetsElement.classList.add('selected-assets');
    activeAssetsElement = assetsElement;
    activeSummaryElement = summaryElement;
}

function ensureHighlightDisplayName() {
    assetsContainerElement.highlightName = charting_getHighlightDisplayName();
}

function updateCharts() {
    let modelAssets = assetsContainerElement.modelAssets || [];
    let portfolio = new Portfolio(modelAssets);
    activePortfolio = portfolio;
    chronometer_run(activeSummaryElement, portfolio);
    portfolio.buildChartingDisplayData();
    ensureHighlightDisplayName();
    charting_buildFromPortfolio(portfolio, false, activeMetric1Name, activeMetric2Name);
    activeMetric1Canvas.update();
    activeMetric2Canvas.update();
}

function calculate(target) {

    if (target == 'assets')
        updateActiveAssetsElement(assetsContainerElement, assetsSummaryElement);

    let modelAssets = assetsContainerElement.modelAssets || [];
    debugPanelClearReports();
    let portfolio = new Portfolio(modelAssets, true);
    chronometer_run(activeSummaryElement, portfolio);

    // Update asset cards with calculated values
    assetsContainerElement.modelAssets = [...portfolio.modelAssets];

    // prepare the chart data
    portfolio.buildChartingDisplayData();

    // if there is a highlightDisplayName, make sure it's selected
    ensureHighlightDisplayName();

    // store portfolio for metric select change handlers
    activePortfolio = portfolio;

    // build the chart configs (must happen before innerCalculate creates Chart instances)
    charting_buildFromPortfolio(portfolio, true, activeMetric1Name, activeMetric2Name);

    innerCalculate(portfolio);

    if (activeAssetsElement == assetsContainerElement) {
        saveLocalData();
    }

    // Sync ledger display
    syncRollupToLedger();
}

function innerCalculate(portfolio) {
    if (activeMetric1Canvas != null)
        activeMetric1Canvas.destroy();
    if (activeMetric2Canvas != null)
        activeMetric2Canvas.destroy();
    if (activeRollupCanvas != null)
        activeRollupCanvas.destroy();

    if (charting_jsonMetric1ChartData != null)
        activeMetric1Canvas = new Chart(chartMetric1Canvas, charting_jsonMetric1ChartData);
    if (charting_jsonMetric2ChartData != null)
        activeMetric2Canvas = new Chart(chartMetric2Canvas, charting_jsonMetric2ChartData);
    if (charting_jsonRollupChartData != null)
        activeRollupCanvas = new Chart(chartRollupCanvas, charting_jsonRollupChartData);

    spreadsheetElement.portfolio = portfolio;
    creditMemosElement.portfolio = portfolio;
    debugReportsElement.reports = [...getReports()];
}

function selectLocalData_changed(ev) {
    const selectElement = document.getElementById('savedDataSets');
    activeStoryName = selectElement.value;
    loadLocalData();
}

function saveLocalData() {
    util_saveLocalAssetModels(activeStoryArc, activeStoryName, assetsContainerElement.modelAssets || []);
}

function loadLocalData() {
    let assetModelsRaw = util_loadLocalAssetModels(activeStoryArc, activeStoryName);
    assetsContainerElement.modelAssets = membrane_rawDataToModelAssets(assetModelsRaw);
    calculate('assets');
}

// ─── Simulation ──────────────────────────────────────────────

function doMaximize() {
    openSimulatorPopup(assetsContainerElement.modelAssets || []);
}

// ─── Popup Functions ─────────────────────────────────────────

const saveLocally = 'Save Locally';
const shareGlobally = 'Share Globally';

function saveData() {
    loadPopupList(saveLocally);
    doPopup(saveLocally);
}

function shareData() {
    doPopupShare(shareGlobally);
}

function cardSelection() {
    doPopupCardSelection();
}

function loadPopupList(popupTitle) {
    let popupDatasets = document.getElementById('popupDatasets');
    let datasets = util_loadFromStorage(popupTitle);
    if (datasets && datasets.length > 0) {
        popupDatasets.innertHTML = '';
        for (let dataset of datasets) {
            popupDatasets.innertHTML += '<option>' + dataset.displayName + '</option>';
        }
    }
}

function doPopupShare(popupTitle) {
    document.getElementById('popupFormShare').style.display = 'block';
}

function openCreateAssetModal() {
    document.getElementById('popupFormCreateAsset').style.display = 'block';
}

function showPopupTransfers(currentDisplayName) {
    let popupFormTransfersElement = document.getElementById('popupFormTransfers');
    let scrollableYElement = popupFormTransfersElement.querySelector('.scrollable-y');

    let modelAssets = assetsContainerElement.modelAssets || [];
    let portfolio = new Portfolio(modelAssets, false);
    chronometer_run(null, portfolio);
    portfolio.buildChartingDisplayData();
    charting_buildFromModelAsset(portfolio, currentDisplayName);

    html_applyModelAssetToPopupTransfers(findByName(portfolio.modelAssets, currentDisplayName), popupFormTransfersElement);
    scrollableYElement.innerHTML = html_buildTransferrableAssets(portfolio.modelAssets, currentDisplayName);

    if (activeEarningsCanvasIndividual != null)
        activeEarningsCanvasIndividual.destroy();

    popupFormTransfersElement.style.display = 'block';

    if (charting_jsonMetricChartConfigIndividual != null)
        activeEarningsCanvasIndividual = new Chart(chartEarningsCanvasIndividual, charting_jsonMetricChartConfigIndividual);
}

function popupFormTransfers_onSave(ev) {
    let popupFormTransfersElement = document.getElementById('popupFormTransfers');
    let currentDisplayName = popupFormTransfersElement.querySelector('#popupFormTransfers-title').innerHTML;
    let scrollableYElement = popupFormTransfersElement.querySelector('.scrollable-y');
    let fundTransfers = membrane_htmlElementsToFundTransfers(currentDisplayName, scrollableYElement);

    // Update the modelAsset's fund transfers directly
    let modelAsset = findByName(assetsContainerElement.modelAssets || [], currentDisplayName);
    if (modelAsset) {
        modelAsset.fundTransfers = fundTransfers;
    }

    calculate();
    popupFormTransfersElement.style.display = 'none';
}

// Close buttons
const closeButtonElements = document.querySelectorAll('.closeBtn');
for (const closeButtonElement of closeButtonElements) {
    closeButtonElement.addEventListener('click', function() {
        closeButtonElement.parentElement.parentElement.style.display = 'none';
    });
}

// ─── Ledger Sync ─────────────────────────────────────────────

function syncRollupToLedger() {
    const rollup = document.getElementById('rollup1');
    if (!rollup) return;

    const startDate = rollup.querySelector('[name="startDate"]').value;
    const startValue = rollup.querySelector('[name="startValue"]').value;
    const finishDate = rollup.querySelector('[name="finishDate"]').value;
    const finishValue = rollup.querySelector('[name="finishValue"]').value;
    const accumulated = rollup.querySelector('[name="accumulatedValue"]').value;
    const totalMonths = rollup.querySelector('[name="totalMonths"]').value;
    const annualReturn = rollup.querySelector('[name="annualReturnRate"]').value;

    const formatCurrency = (val) => val ? `$${parseFloat(val).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : '$0.00';

    const formatDate = (val) => {
        if (!val) return '\u2014';
        const [year, month] = val.split('-');
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        return `${monthNames[parseInt(month) - 1]} ${year}`;
    };

    document.getElementById('display-startDate').textContent = formatDate(startDate);
    document.getElementById('display-startValue').textContent = formatCurrency(startValue);
    document.getElementById('display-startTotal').textContent = formatCurrency(startValue);
    document.getElementById('display-finishDate').textContent = formatDate(finishDate);
    document.getElementById('display-finishValue').textContent = formatCurrency(finishValue);
    document.getElementById('display-finishTotal').textContent = formatCurrency(finishValue);

    const accValue = parseFloat(accumulated) || 0;
    const accFormatted = formatCurrency(Math.abs(accValue));
    document.getElementById('display-accumulated').textContent = accValue >= 0 ? `+${accFormatted.substring(1)}` : `-${accFormatted.substring(1)}`;
    document.getElementById('display-totalMonths').textContent = totalMonths ? `${totalMonths} months` : '0 months';
    document.getElementById('display-annualReturn').textContent = annualReturn ? `${parseFloat(annualReturn).toFixed(2)}%` : '0.00%';

    const displayFinishValue = document.getElementById('display-finishValue');
    const displayFinishTotal = document.getElementById('display-finishTotal');
    const displayAccumulated = document.getElementById('display-accumulated');
    const displayAnnualReturn = document.getElementById('display-annualReturn');

    if (accValue > 0) {
        displayFinishValue.className = 'ledger-item-value val-positive';
        displayFinishTotal.className = 'ledger-item-value total val-positive';
        displayAccumulated.className = 'ledger-item-value val-positive';
        displayAnnualReturn.className = 'ledger-item-value total val-positive';
    } else if (accValue < 0) {
        displayFinishValue.className = 'ledger-item-value val-negative';
        displayFinishTotal.className = 'ledger-item-value total val-negative';
        displayAccumulated.className = 'ledger-item-value val-negative';
        displayAnnualReturn.className = 'ledger-item-value total val-negative';
    } else {
        displayFinishValue.className = 'ledger-item-value val-neutral';
        displayFinishTotal.className = 'ledger-item-value total val-neutral';
        displayAccumulated.className = 'ledger-item-value val-neutral';
        displayAnnualReturn.className = 'ledger-item-value total val-neutral';
    }
}

// ─── Window Bridge for onclick Handlers ──────────────────────

window.calculate = calculate;
window.tab1_click = tab1_click;
window.tab2_click = tab2_click;
window.tab3_click = tab3_click;
window.tab4_click = tab4_click;
window.tab5_click = tab5_click;
window.tab6_click = tab6_click;
window.aplus_save = aplus_save;
window.aplus_recall = aplus_recall;
window.bplus_click = bplus_click;
window.bplus_recall = bplus_recall;
window.saveData = saveData;
window.shareData = shareData;
window.cardSelection = cardSelection;
window.openCreateAssetModal = openCreateAssetModal;
window.doMaximize = doMaximize;
window.savePortfolioViaMCP = savePortfolioViaMCP;
window.popupFormTransfers_onSave = popupFormTransfers_onSave;
window.selectLocalData_changed = selectLocalData_changed;
window.toggleDebugPanel = toggleDebugPanel;

// ─── Settings Row ─────────────────────────────────────────────

function syncGlobalsToSettings() {
    document.getElementById('setting-inflationRate').value = global_multBy100(global_inflationRate);
    document.getElementById('setting-taxYear').value = global_taxYear;
    document.getElementById('setting-filingAs').value = global_filingAs;
    document.getElementById('setting-startAge').value = global_user_startAge;
    document.getElementById('setting-retirementAge').value = global_user_retirementAge;
    document.getElementById('setting-finishAge').value = global_user_finishAge;
}

function connectSettings() {
    document.getElementById('setting-inflationRate').addEventListener('change', function() {
        global_setInflationRate(global_divBy100(this.value));
        global_getInflationRate();
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
    document.getElementById('setting-startAge').addEventListener('change', function() {
        global_setUserStartAge(parseInt(this.value));
        global_getUserStartAge();
        calculate('assets');
    });
    document.getElementById('setting-retirementAge').addEventListener('change', function() {
        global_setUserRetirementAge(parseInt(this.value));
        global_getUserRetirementAge();
        calculate('assets');
    });
    document.getElementById('setting-finishAge').addEventListener('change', function() {
        global_setUserFinishAge(parseInt(this.value));
        global_getUserFinishAge();
        calculate('assets');
    });
}

// ─── Initialize ──────────────────────────────────────────────

function initialize() {
    global_initialize();
    setActiveTaxTable(new TaxTable());
    syncGlobalsToSettings();
    connectSettings();
    populateMetricSelects();
    buildInstrumentOptions();
    initiateActiveData();
    connectAssetSelect();
    connectCreateAsset();
    connectEditAsset();
    connectAssetListEvents();
    syncRollupToLedger();
}

// Modules are deferred — DOM is ready, no need for DOMContentLoaded
initialize();
