import { DateInt } from './date-int.js';
import { Currency } from './currency.js';
import { logger, LogCategory } from './logger.js';
import { activeTaxTable } from './globals.js';
import { firstDateInt, lastDateInt } from './asset-queries.js';
import { buildSummary } from './summary.js';
import { GraphMapper } from './graph-mapper.js';
import { HydraulicVisualizer } from './hydraulic-visualizer.js';

export async function chronometer_run(summaryContainerElement, portfolio) {

    if (portfolio.modelAssets == null || portfolio.modelAssets.length == 0) {
        logger.log(LogCategory.GENERAL, 'chronometer_run - no modelAssets');
        return;
    }

    if (portfolio.firstDateInt == null || portfolio.lastDateInt == null) {
        logger.log(LogCategory.GENERAL, 'chronometer_run - non firstDateInt or lastDateInt');
        return;
    }

    let totalMonths = 0;
    activeTaxTable.initializeChron();
    portfolio.initializeChron();

    let currentDateInt = new DateInt(portfolio.firstDateInt.toInt());
    let lastDateInt = new DateInt(portfolio.lastDateInt.toInt());
    while (currentDateInt.toInt() <= lastDateInt.toInt()) {

        totalMonths += portfolio.applyMonth(currentDateInt);
        currentDateInt.next();

        if (currentDateInt.day == 1) {
            portfolio.monthlyChron(currentDateInt);
            activeTaxTable.monthlyChron(currentDateInt);
        }

        if (currentDateInt.isNewYearsDay()) {
            portfolio.applyYear(currentDateInt);
            activeTaxTable.applyYear(portfolio.yearly);

            portfolio.yearlyChron(currentDateInt);
            activeTaxTable.yearlyChron(currentDateInt);
        }

        portfolio.totalMonths = totalMonths;

        if (summaryContainerElement)
            buildSummary(summaryContainerElement, portfolio);

    }

    portfolio.finalizeChron();
    activeTaxTable.finalizeChron();

}

export async function chronometer_run_animated(portfolio, visualizerContainerId) {

    if (portfolio.modelAssets == null || portfolio.modelAssets.length == 0) return;
    if (portfolio.firstDateInt == null || portfolio.lastDateInt == null) return;

    let totalMonths = 0;

    activeTaxTable.initializeChron();
    portfolio.initializeChron();

    const visualizer = new HydraulicVisualizer(visualizerContainerId);
    const graphLayout = GraphMapper.buildGraph(portfolio);
    
    // Pass the portfolio to init so tanks scale dynamically
    visualizer.init(graphLayout, portfolio);

    // Grab the date display element and setup month formatting
    const dateDisplay = document.getElementById('visualizer-date-display');
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

    let currentDateInt = new DateInt(portfolio.firstDateInt.toInt());
    let lastDateInt = new DateInt(portfolio.lastDateInt.toInt());
    while (currentDateInt.toInt() <= lastDateInt.toInt()) {
        
        // Break out of the loop if the popup was closed
        const container = document.getElementById(visualizerContainerId);
        if (!container || (container.closest('.popup') && container.closest('.popup').style.display === 'none')) {
            break;
        }

        // Update the date in the UI
        if (dateDisplay) {
            dateDisplay.textContent = `${monthNames[currentDateInt.month - 1]} ${currentDateInt.year}`;
        }

        totalMonths += portfolio.applyMonth(currentDateInt);

        GraphMapper.calculateFlows(portfolio, currentDateInt, graphLayout.edges);
        visualizer.update(graphLayout, portfolio);

        await new Promise(resolve => setTimeout(resolve, 80));

        currentDateInt.next();

        if (currentDateInt.day == 1) {
            portfolio.monthlyChron(currentDateInt);
            activeTaxTable.monthlyChron(currentDateInt);
        }

        if (currentDateInt.isNewYearsDay()) {
            portfolio.applyYear(currentDateInt);
            activeTaxTable.applyYear(portfolio.yearly);

            portfolio.yearlyChron(currentDateInt);
            activeTaxTable.yearlyChron(currentDateInt);
        }

        portfolio.totalMonths = totalMonths;
    }

    portfolio.finalizeChron();
    activeTaxTable.finalizeChron();

}

export function chronometer_applyMonths(modelAssets) {
    if (modelAssets == null || modelAssets.length == 0) {
        logger.log(LogCategory.GENERAL, 'chronometer_applyMonths - no modelAssets');
        return;
    }

    if (activeTaxTable != null)
        activeTaxTable.initializeChron();

    for (let modelAsset of modelAssets) {
        modelAsset.initializeChron();
    }

    const first = firstDateInt(modelAssets);
    const last = lastDateInt(modelAssets);

    summary_setStartDate(first);
    summary_setFinishDate(last);
    let totalMonths = 0;

    let currentDateInt = new DateInt(first.toInt());
    while (currentDateInt.toInt() <= last.toInt()) {
        totalMonths += chronometer_applyMonth(first, last, currentDateInt, modelAssets, activeUser);
        currentDateInt.next();
    }

    summary_setAccruedMonths(totalMonths);
    summary_computeCAGR()
}

export function chronometer_applyMonth_accumulate(firstDateInt, lastDateInt, currentDateInt, modelAsset, activeUser) {
    let startTotal = new Currency(0.0);
    let finishTotal = new Currency(0.0);
    let accumulatedValue = new Currency(0.0);

    if (modelAsset.applyMonth(currentDateInt, activeUser)) {
        if (firstDateInt.toInt() == currentDateInt.toInt())
            startTotal.add(modelAsset.startCurrency);
        if (lastDateInt.toInt() == currentDateInt.toInt())
            finishTotal.add(modelAsset.finishCurrency);
        accumulatedValue.add(modelAsset.accumulatedCurrency);
    }

    let result = { startTotal: startTotal, finishTotal: finishTotal, accumulatedValue: accumulatedValue };
    return result;
}

export function chronometer_applyTaxesBeforeComputationsThisMonth(currentDateInt, modelAssets, activeUser) {
    logger.log(LogCategory.TAX, 'chronometer_applyTaxesBeforeComputationsThisMonth');

    if (!activeTaxTable) {
        logger.log(LogCategory.TAX, 'chronometer_applyTaxesBeforeComputationsThisMonth - activeTaxTable not set');
        return;
    }

    if (currentDateInt.month == 1)
        activeTaxTable.applyYearlyTaxes(currentDateInt, modelAssets);

    if (activeTaxTable.isEstimatedTaxPaymentDue(currentDateInt))
        activeTaxTable.payEstimatedTaxes(currentDateInt, modelAssets);

    if (activeTaxTable.isYearlyTaxPaymentDue(currentDateInt))
        activeTaxTable.payYearlyTaxes(currentDateInt, modelAssets);
}

export function chronometer_applyTaxesAfterComputationsThisMonth(currentDateInt, modelAssets, activeUser) {
    logger.log(LogCategory.TAX, 'chronometer_applyTaxesAfterComputationsThisMonth');

    if (!activeTaxTable) {
        logger.log(LogCategory.TAX, 'chronometer_applyTaxesAfterComputationsThisMonth - activeTaxTable not set');
        return;
    }

    activeTaxTable.applyMonthlyTaxes(currentDateInt, modelAssets, activeUser);
}
