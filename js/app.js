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
    html_buildSlotElement,
    html_buildRemovableAssetElement,
    html_applyModelAssetToPopupTransfers,
    html_buildTransferrableAssets,
    html_setAssetElementFundTransfers,
} from './html.js';

// Chronometer and summary
import { chronometer_run } from './chronometer.js';
import { buildSummary } from './summary.js';

// Membrane (HTML ↔ model conversion)
import {
    membrane_htmlElementToAssetModel,
    membrane_htmlElementsToAssetModels,
    membrane_modelAssetsToHTML,
    membrane_rawDataToModelAssets,
    membrane_jsonObjectsToModelAssets,
    membrane_htmlElementsToFundTransfers,
} from './membrane.js';

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
import { logger } from './logger.js';

// Tax and portfolio
import { TaxTable } from './taxes.js';
import { Portfolio } from './portfolio.js';

// Globals
import {
    setActiveTaxTable,
    global_initialize,
} from './globals.js';

// Util
import {
    util_YYYYmm,
    util_ensureStoryNames,
    util_saveLocalAssetModels,
    util_loadLocalAssetModels,
    util_loadFromStorage,
} from './util.js';

// MCP
import { savePortfolioToFile } from './mcp-client.js';

// ─── DOM Element References ──────────────────────────────────

const assetElement = document.getElementById('asset');
const assetEditElement = document.getElementById('assetEdit');

const assetsContainerElement = document.getElementById('assets');
const assetsSimulatorElement = document.getElementById('assetsSimulator');

const assetsSummaryElement = document.getElementById('rollup1');
const assetsSimulatorSummaryElement = document.getElementById('rollup2');

const chartMetric1Canvas = document.getElementById('chartMetric1Canvas');
const chartMetric2Canvas = document.getElementById('chartMetric2Canvas');
const chartRollupCanvas = document.getElementById('chartRollupCanvas');
const spreadsheetElement = document.getElementById('spreadsheetElement');
const chartEarningsCanvasIndividual = document.getElementById('chartEarningsCanvasIndividual');

const tab1 = document.getElementById('tab1');
const tab2 = document.getElementById('tab2');
const tab3 = document.getElementById('tab3');
const tab4 = document.getElementById('tab4');

// ─── App State ───────────────────────────────────────────────

let activeAssetsElement = assetsContainerElement;
let activeSummaryElement = assetsSummaryElement;
let activeStoryArc = null;
let activeStoryName = null;
let activeMetric1Canvas = null;
let activeMetric2Canvas = null;
let activeRollupCanvas = null;
let activeEarningsCanvasIndividual = null;
let editingCard = null;
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
    logger.log('initiateActiveData');

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
    logger.log('connectAssetSelect');
    let instrumentElement = assetElement.querySelector('[name="instrument"]')
    let slot1Element = assetElement.querySelector('[name="slot1"]');

    instrumentElement.addEventListener('change', function(event) {
        slot1Element.innerHTML = html_buildSlotElement(event.target.value, null);
    });
}

function connectAssetsContainerSelects() {
    logger.log('connectAssetsContainerSelects');
    assetsContainerElement.addEventListener('change', function(event) {
        if (event.target.name == 'instrument') {
            let slot1Element = event.target.parentElement.parentElement.querySelector('[name="slot1"]');
            slot1Element.innerHTML = html_buildSlotElement(event.target.value, null);
        }
    });
}

function connectCreateAsset() {
    logger.log('connectCreateAsset');
    assetElement.addEventListener("submit", function(ev) {
        ev.preventDefault();

        let assetModel = membrane_htmlElementToAssetModel(assetElement);
        assetsContainerElement.innerHTML += html_buildRemovableAssetElement(null, assetModel);

        calculate('assets');

        // Close the create asset modal
        document.getElementById('popupFormCreateAsset').style.display = 'none';

        // Clear the form
        assetElement.reset();
    });
}

function openEditAssetModal(cardElement) {
    editingCard = cardElement;

    // Populate instrument select options
    let editInstrumentSelect = assetEditElement.querySelector('[name="instrument"]');
    editInstrumentSelect.innerHTML = html_buildInstrumentOptions(cardElement.querySelector('[name="instrument"]').value);

    // Populate form fields from card's hidden inputs
    assetEditElement.querySelector('[name="displayName"]').value = cardElement.querySelector('[name="displayName"]').value;
    assetEditElement.querySelector('[name="startDate"]').value = cardElement.querySelector('[name="startDate"]').value;
    assetEditElement.querySelector('[name="startValue"]').value = cardElement.querySelector('[name="startValue"]').value;
    assetEditElement.querySelector('[name="finishDate"]').value = cardElement.querySelector('[name="finishDate"]').value;
    assetEditElement.querySelector('[name="finishValue"]').value = cardElement.querySelector('[name="finishValue"]').value;
    assetEditElement.querySelector('[name="annualReturnRate"]').value = cardElement.querySelector('[name="annualReturnRate"]').value;
    assetEditElement.querySelector('[name="basisValue"]').value = cardElement.querySelector('[name="basisValue"]').value;

    document.getElementById('popupFormEditAsset').style.display = 'block';
}

function connectEditAsset() {
    logger.log('connectEditAsset');
    assetEditElement.addEventListener("submit", function(ev) {
        ev.preventDefault();

        if (!editingCard) return;

        // Update the card's hidden inputs with edited values
        editingCard.querySelector('[name="instrument"]').value = assetEditElement.querySelector('[name="instrument"]').value;
        editingCard.querySelector('[name="displayName"]').value = assetEditElement.querySelector('[name="displayName"]').value;
        editingCard.querySelector('[name="startDate"]').value = assetEditElement.querySelector('[name="startDate"]').value;
        editingCard.querySelector('[name="startValue"]').value = assetEditElement.querySelector('[name="startValue"]').value;
        editingCard.querySelector('[name="finishDate"]').value = assetEditElement.querySelector('[name="finishDate"]').value;
        editingCard.querySelector('[name="annualReturnRate"]').value = assetEditElement.querySelector('[name="annualReturnRate"]').value;
        editingCard.querySelector('[name="basisValue"]').value = assetEditElement.querySelector('[name="basisValue"]').value;

        // Close the edit modal
        document.getElementById('popupFormEditAsset').style.display = 'none';
        editingCard = null;

        calculate('assets');
    });
}

function connectAssetsContainerEdit() {
    logger.log('connectAssetsContainerEdit');
    assetsContainerElement.addEventListener('click', function(ev) {
        let editBtn = ev.target.closest('.asset-action-btn.edit');
        if (editBtn) {
            ev.preventDefault();
            let card = editBtn.closest('.asset');
            if (card) openEditAssetModal(card);
        }
    });
}

function connectAssetsContainerTransfers() {
    logger.log('connectAssetsContainerTransfers');
    assetsContainerElement.addEventListener('click', assetsContainerElementClickTransfers);
    assetsSimulatorElement.addEventListener('click', assetsContainerElementClickTransfers);
}

function assetsContainerElementClickTransfers(ev) {
    let transfersBtn = ev.target.closest('.asset-action-btn.transfers');
    if (transfersBtn) {
        ev.preventDefault();
        let card = transfersBtn.closest('.asset');
        if (card) {
            let containerElement = card.parentElement;
            let displayName = card.querySelector('input[name="displayName"]').value;
            showPopupTransfers(containerElement, displayName);
        }
    }
}

function connectAssetsContainerRemove() {
    logger.log('connectUpdateOrRemoveAsset');
    assetsContainerElement.addEventListener('click', function(ev) {
        let removeBtn = ev.target.closest('.asset-action-btn.remove');
        if (removeBtn) {
            ev.preventDefault();
            let card = removeBtn.closest('.asset');
            if (card) {
                assetsContainerElement.removeChild(card);
                calculate('assets');
            }
        }
    });
}

// ─── Mouse Event Handlers ────────────────────────────────────

function clearMouseEvents() {
    let cards = assetsContainerElement.querySelectorAll('.asset');
    for (let ii = 0; ii < cards.length; ii++) {
        cards[ii].removeEventListener('click', handleMouseEvents);
    }
}

function attachMouseEvents() {
    let cards = assetsContainerElement.querySelectorAll('.asset');
    for (let ii = 0; ii < cards.length; ii++) {
        cards[ii].addEventListener('click', handleMouseEvents);
    }
}

function handleMouseEvents(ev) {
    // Ignore clicks on action buttons (remove, transfers)
    if (ev.target.closest('.asset-action-btn')) return;

    let card = ev.target.closest('.asset');
    if (!card) return;

    logger.log('card.click ' + card.querySelector('input[name="displayName"]').value);

    // clear previous selection
    let selectedCard = document.querySelector('.asset.selected-card-chart');
    if (selectedCard != null) {
        selectedCard.classList.remove('selected-card-chart');
    }

    let clickedDisplayName = card.querySelector('input[name="displayName"]').value;

    if (charting_getHighlightDisplayName() == null || clickedDisplayName != charting_getHighlightDisplayName()) {
        card.classList.add('selected-card-chart');
        charting_setHighlightDisplayName(clickedDisplayName);
    }
    else {
        charting_setHighlightDisplayName(null);
    }

    updateCharts();
}

// ─── MCP Functions ───────────────────────────────────────────

async function savePortfolioViaMCP() {
    const filename = prompt('Enter filename:', 'portfolio.json');
    if (filename) {
        const success = await savePortfolioToFile(filename, assetsContainerElement);
        if (success) {
            alert('Portfolio saved successfully!');
        } else {
            alert('Failed to save portfolio');
        }
    }
}

// ─── Tab Handling ────────────────────────────────────────────

function tab1_click() {
    if (tab2.classList.contains('active')) {
        tab2.classList.remove('active');
        chartMetric2Canvas.parentElement.style.display = 'none';
    }
    else if (tab3.classList.contains('active')) {
        tab3.classList.remove('active');
        chartRollupCanvas.parentElement.style.display = 'none';
    }
    else if (tab4.classList.contains('active')) {
        tab4.classList.remove('active');
        spreadsheetElement.parentElement.style.display = 'none';
    }
    tab1.classList.add('active');
    chartMetric1Canvas.parentElement.style.display = '';
}

function tab2_click() {
    if (tab1.classList.contains('active')) {
        tab1.classList.remove('active');
        chartMetric1Canvas.parentElement.style.display = 'none';
    }
    else if (tab3.classList.contains('active')) {
        tab3.classList.remove('active');
        chartRollupCanvas.parentElement.style.display = 'none';
    }
    else if (tab4.classList.contains('active')) {
        tab4.classList.remove('active');
        spreadsheetElement.parentElement.style.display = 'none';
    }
    tab2.classList.add('active');
    chartMetric2Canvas.parentElement.style.display = '';
}

function tab3_click() {
    if (tab1.classList.contains('active')) {
        tab1.classList.remove('active');
        chartMetric1Canvas.parentElement.style.display = 'none';
    }
    else if (tab2.classList.contains('active')) {
        tab2.classList.remove('active');
        chartMetric2Canvas.parentElement.style.display = 'none';
    }
    else if (tab4.classList.contains('active')) {
        tab4.classList.remove('active');
        spreadsheetElement.parentElement.style.display = 'none';
    }
    tab3.classList.add('active');
    chartRollupCanvas.parentElement.style.display = '';
}

function tab4_click() {
    if (tab1.classList.contains('active')) {
        tab1.classList.remove('active');
        chartMetric1Canvas.parentElement.style.display = 'none';
    }
    else if (tab2.classList.contains('active')) {
        tab2.classList.remove('active');
        chartMetric2Canvas.parentElement.style.display = 'none';
    }
    else if (tab3.classList.contains('active')) {
        tab3.classList.remove('active');
        chartRollupCanvas.parentElement.style.display = 'none';
    }
    tab4.classList.add('active');
    spreadsheetElement.parentElement.style.display = '';
}

// ─── Save and Recall ─────────────────────────────────────────

function aplus_save() {
    let assetModels = membrane_htmlElementsToAssetModels(assetsContainerElement);
    util_saveLocalAssetModels(activeStoryArc, 'APlus', assetModels);
}

function aplus_recall() {
    let assetModelsRaw = util_loadLocalAssetModels(activeStoryArc, 'APlus');
    let assetModels = membrane_rawDataToModelAssets(assetModelsRaw);
    assetsContainerElement.innerHTML = membrane_modelAssetsToHTML(assetModels);
    calculate('assets');
}

function bplus_click() {
    let assetModels = membrane_htmlElementsToAssetModels(assetsContainerElement);
    util_saveLocalAssetModels(activeStoryArc, 'BPlus', assetModels);
}

function bplus_recall() {
    let assetModelsRaw = util_loadLocalAssetModels(activeStoryArc, 'BPlus');
    let assetModels = membrane_rawDataToModelAssets(assetModelsRaw);
    assetsContainerElement.innerHTML = membrane_modelAssetsToHTML(assetModels);
    calculate('assets');
}

// ─── Charting and Calculation ────────────────────────────────

function updateActiveAssetsElement(assetsElement, summaryElement) {
    assetsContainerElement.classList.remove('selected-assets');
    assetsSimulatorElement.classList.remove('selected-assets');
    assetsElement.classList.add('selected-assets');
    activeAssetsElement = assetsElement;
    activeSummaryElement = summaryElement;
}

function ensureHighlightDisplayName() {
    if (charting_getHighlightDisplayName() == null) {
        let selectedCards = assetsContainerElement.querySelectorAll('.asset.selected-card-chart');
        if (selectedCards != null) {
            for (let ii = 0; ii < selectedCards.length; ii++) {
                selectedCards[ii].classList.remove('selected-card-chart');
            }
        }
    }
    else {
        let displayNameInput = assetsContainerElement.querySelector('input[name="displayName"][value="' + charting_getHighlightDisplayName() + '"]');
        if (displayNameInput != null) {
            let card = displayNameInput.closest('.asset');
            if (card) card.classList.add('selected-card-chart');
        }
    }
}

function updateCharts() {
    let modelAssets = membrane_htmlElementsToAssetModels(activeAssetsElement);
    let portfolio = new Portfolio(modelAssets);
    activePortfolio = portfolio;
    chronometer_run(document.getElementById(activeSummaryElement), portfolio);
    portfolio.buildChartingDisplayData();
    ensureHighlightDisplayName();
    charting_buildFromPortfolio(portfolio, false, activeMetric1Name, activeMetric2Name);
    activeMetric1Canvas.update();
    activeMetric2Canvas.update();
    //activeRollupCanvas.update();
}

function calculate(target) {

    if (target == 'assets')
        updateActiveAssetsElement(assetsContainerElement, assetsSummaryElement);
    else if (target == 'simulator')
        updateActiveAssetsElement(assetsSimulatorElement, assetsSimulatorSummaryElement);

    let modelAssets = membrane_htmlElementsToAssetModels(activeAssetsElement);
    let portfolio = new Portfolio(modelAssets, true);
    chronometer_run(activeSummaryElement, portfolio);

    // unhook mouse events
    clearMouseEvents();

    // use the updated modelAssets to produce the updated html
    activeAssetsElement.innerHTML = membrane_modelAssetsToHTML(portfolio.modelAssets);
    if (activeAssetsElement == assetsSimulatorElement) {
        removeRemoveButtons(activeAssetsElement);
    }

    // hook mouse events
    attachMouseEvents();

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

function buildSpreadsheetHTML(portfolio) {
    const metrics = [
        { key: 'monthlyValues',                label: 'Value' },
        { key: 'monthlyEarnings',              label: 'Earning' },
        { key: 'monthlyIncomes',               label: 'Income' },
        { key: 'monthlyAfterTaxes',            label: 'After Tax' },
        { key: 'monthlyAfterExpenses',         label: 'After Expense' },
        { key: 'monthlyAccumulateds',           label: 'Accumulated' },
        { key: 'monthlyShortTermCapitalGains',  label: 'ST Cap Gain' },
        { key: 'monthlyLongTermCapitalGains',   label: 'LT Cap Gain' },
        { key: 'monthlyRMDs',                  label: 'RMD' },
        { key: 'monthlySocialSecurities',      label: 'Soc Security' },
        { key: 'monthlyMedicares',             label: 'Medicare' },
        { key: 'monthlyIncomeTaxes',           label: 'Income Tax' },
        { key: 'monthlyMortgagePayments',      label: 'Mortgage Pmt' },
        { key: 'monthlyMortgageInterests',     label: 'Mortgage Int' },
        { key: 'monthlyMortgagePrincipals',    label: 'Mortgage Prin' },
        { key: 'monthlyMortgageEscrows',       label: 'Mort Escrow' },
        { key: 'monthlyEstimatedTaxes',        label: 'Est Tax' },
        { key: 'monthlyIRAContributions',      label: 'IRA Contrib' },
        { key: 'monthlyFour01KContributions',  label: '401K Contrib' },
        { key: 'monthlyIRADistributions',      label: 'IRA Distrib' },
        { key: 'monthlyFour01KDistributions',  label: '401K Distrib' },
        { key: 'monthlyInterestIncomes',       label: 'Interest Inc' },
        { key: 'monthlyCapitalGainsTaxes',     label: 'Cap Gains Tax' },
        { key: 'monthlyCredits',               label: 'Credit' },
    ];

    // Determine which columns to show per asset (only non-zero data)
    const assetColumns = [];
    for (const modelAsset of portfolio.modelAssets) {
        const cols = [];
        for (const metric of metrics) {
            const arr = modelAsset[metric.key];
            if (arr && arr.length > 0 && arr.some(v => v !== 0)) {
                cols.push(metric);
            }
        }
        if (cols.length > 0) {
            assetColumns.push({ asset: modelAsset, metrics: cols });
        }
    }

    if (assetColumns.length === 0) {
        return '<p style="padding: 24px; font-family: DM Sans, sans-serif;">No spreadsheet data available. Run a calculation first.</p>';
    }

    // Build date labels from first to last month
    const dateLabels = [];
    const cursor = new DateInt(portfolio.firstDateInt.toInt());
    while (cursor.toInt() <= portfolio.lastDateInt.toInt()) {
        dateLabels.push(cursor.toHTML());
        cursor.nextMonth();
    }

    let html = '<table class="spreadsheet-table">';

    // Header row 1: Asset display names spanning their metric columns
    html += '<thead>';
    html += '<tr><th rowspan="2" class="spreadsheet-date-col">Date</th>';
    for (const ac of assetColumns) {
        html += '<th colspan="' + ac.metrics.length + '" class="spreadsheet-asset-header">' + ac.asset.displayName + '</th>';
    }
    html += '</tr>';

    // Header row 2: Metric labels
    html += '<tr>';
    for (const ac of assetColumns) {
        for (const metric of ac.metrics) {
            html += '<th class="spreadsheet-metric-header">' + metric.label + '</th>';
        }
    }
    html += '</tr>';
    html += '</thead>';

    // Data rows: one per month
    html += '<tbody>';
    for (let i = 0; i < dateLabels.length; i++) {
        html += '<tr>';
        html += '<td class="spreadsheet-date-col">' + dateLabels[i] + '</td>';
        for (const ac of assetColumns) {
            for (const metric of ac.metrics) {
                const arr = ac.asset[metric.key];
                const val = (arr && i < arr.length) ? arr[i] : 0;
                const formatted = val !== 0
                    ? val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                    : '\u2014';
                const cls = val < 0 ? ' class="spreadsheet-negative"' : '';
                html += '<td' + cls + '>' + formatted + '</td>';
            }
        }
        html += '</tr>';
    }
    html += '</tbody>';
    html += '</table>';

    return html;
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

    spreadsheetElement.innerHTML = buildSpreadsheetHTML(portfolio);
}

function selectLocalData_changed(ev) {
    const selectElement = document.getElementById('savedDataSets');
    activeStoryName = selectElement.value;
    loadLocalData();
}

function saveLocalData() {
    let assetModels = membrane_htmlElementsToAssetModels(assetsContainerElement);
    util_saveLocalAssetModels(activeStoryArc, activeStoryName, assetModels);
}

function loadLocalData() {
    let assetModelsRaw = util_loadLocalAssetModels(activeStoryArc, activeStoryName);
    let assetModels = membrane_rawDataToModelAssets(assetModelsRaw);
    assetsContainerElement.innerHTML = membrane_modelAssetsToHTML(assetModels);
    calculate('assets');
}

// ─── Simulation ──────────────────────────────────────────────

function clickShowHideSimulator() {
    let middleContainerElement = document.getElementById('middleContainer');
    let showHideSimulatorButton = document.getElementById('showHideSimulator');

    if (middleContainerElement.style.display == 'none') {
        updateActiveAssetsElement(assetsSimulatorElement, assetsSimulatorSummaryElement);
        middleContainerElement.style.display = '';
        showHideSimulatorButton.innerHTML = 'Hide Simulator';
    }
    else {
        updateActiveAssetsElement(assetsContainerElement, assetsSummaryElement);
        middleContainerElement.style.display = 'none';
        showHideSimulatorButton.innerHTML = 'Show Simulator';
    }
}

function doMaximize() {
    let summaryContainerElement = document.getElementById('rollup2');

    assetsSimulatorElement.innerHTML = assetsContainerElement.innerHTML;
    removeRemoveButtons(assetsSimulatorElement);

    let modelAssets = membrane_htmlElementsToAssetModels(assetsSimulatorElement);

    if (window.Worker) {
        let worker = new Worker('js/simulator.js', { type: 'module' });
        worker.postMessage(modelAssets);
        worker.onmessage = function(event) {
            let richMessage = event.data;
            if (richMessage.action == 'iteration') {
                let permutationTextBox = document.getElementById('permutations');
                permutationTextBox.value = richMessage.data;
            }
            else if (richMessage.action == 'foundBetter') {
                let assetModels = membrane_jsonObjectsToModelAssets(richMessage.data);
                let portfolio = new Portfolio(assetModels, false);
                chronometer_run(null, portfolio);
                assetsSimulatorElement.innerHTML = membrane_modelAssetsToHTML(portfolio.modelAssets);
                buildSummary(summaryContainerElement, portfolio);
                updateActiveAssetsElement(assetsSimulatorElement, assetsSimulatorSummaryElement);
                calculate('simulator');
            }
        }
    }
    else {
        assetsSimulatorElement.innerHTML = 'Web Workers not supported in this browser.';
    }
}

function removeRemoveButtons(containerElement) {
    let removeButtons = containerElement.querySelectorAll('.remove');
    for (let ii = 0; ii < removeButtons.length; ii++) {
        removeButtons[ii].remove();
    }
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

function showPopupTransfers(containerElement, currentDisplayName) {
    let popupFormTransfersElement = document.getElementById('popupFormTransfers');
    let scrollableYElement = popupFormTransfersElement.querySelector('.scrollable-y');

    let modelAssets = membrane_htmlElementsToAssetModels(containerElement);
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
    html_setAssetElementFundTransfers(assetsContainerElement, currentDisplayName, fundTransfers);

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
window.aplus_save = aplus_save;
window.aplus_recall = aplus_recall;
window.bplus_click = bplus_click;
window.bplus_recall = bplus_recall;
window.saveData = saveData;
window.shareData = shareData;
window.cardSelection = cardSelection;
window.openCreateAssetModal = openCreateAssetModal;
window.clickShowHideSimulator = clickShowHideSimulator;
window.doMaximize = doMaximize;
window.savePortfolioViaMCP = savePortfolioViaMCP;
window.popupFormTransfers_onSave = popupFormTransfers_onSave;
window.selectLocalData_changed = selectLocalData_changed;

// ─── Initialize ──────────────────────────────────────────────

function initialize() {
    global_initialize();
    setActiveTaxTable(new TaxTable());
    populateMetricSelects();
    buildInstrumentOptions();
    initiateActiveData();
    connectAssetSelect();
    connectCreateAsset();
    connectEditAsset();
    connectAssetsContainerSelects();
    connectAssetsContainerTransfers();
    connectAssetsContainerEdit();
    connectAssetsContainerRemove();
    syncRollupToLedger();
}

// Modules are deferred — DOM is ready, no need for DOMContentLoaded
initialize();
