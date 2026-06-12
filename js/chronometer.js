import { DateInt } from './utils/date-int.js';
import { logger, LogCategory } from './utils/logger.js';
import { activeTaxTable, global_backtestYear, global_sp500_annual_returns, global_10yr_treasury_rates, global_cpi_annual_inflation, global_wage_growth_annual } from './globals.js';
import { Instrument, InstrumentType } from './instruments/instrument.js';

// ── Backtest helpers ──────────────────────────────────────────

function saveOriginalRates(portfolio) {
    return portfolio.modelAssets.map(a => ({ asset: a, rate: a.annualReturnRate.rate }));
}

function restoreOriginalRates(saved) {
    for (const { asset, rate } of saved) {
        asset.annualReturnRate.rate = rate;
    }
}

function applyBacktestRates(portfolio, calendarYear) {
    const year = parseInt(calendarYear);
    const sp500 = global_sp500_annual_returns[year];
    const treasury = global_10yr_treasury_rates[year];
    const cpi = global_cpi_annual_inflation[year];
    const wage = global_wage_growth_annual[year];

    for (const asset of portfolio.modelAssets) {
        if (sp500 !== undefined) {
            if (InstrumentType.isTaxableAccount(asset.instrument) ||
                InstrumentType.isIRA(asset.instrument) ||
                InstrumentType.isRothIRA(asset.instrument) ||
                InstrumentType.is401K(asset.instrument)) {
                asset.annualReturnRate.rate = sp500 / 100;
            }
        }
        if (treasury !== undefined && asset.instrument === Instrument.US_BOND) {
            asset.annualReturnRate.rate = treasury / 100;
        }
        if (cpi !== undefined && InstrumentType.isMonthlyExpense(asset.instrument)) {
            asset.annualReturnRate.rate = cpi / 100;
        }
        if (wage !== undefined && InstrumentType.isMonthlyIncome(asset.instrument)) {
            asset.annualReturnRate.rate = wage / 100;
        }
    }
}

function applyBacktestForYear(portfolio, simulationYear, backtestStartYear, simStartYear, savedRates) {
    const dataYear = backtestStartYear + (simulationYear - simStartYear);
    if (global_sp500_annual_returns[dataYear] !== undefined ||
        global_10yr_treasury_rates[dataYear] !== undefined ||
        global_cpi_annual_inflation[dataYear] !== undefined ||
        global_wage_growth_annual[dataYear] !== undefined) {
        applyBacktestRates(portfolio, dataYear);
    } else {
        restoreOriginalRates(savedRates);
    }
}

// ── Main simulation loops ─────────────────────────────────────

export async function chronometer_run(portfolio) {

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

    const backtesting = global_backtestYear !== 'current';
    const savedRates = backtesting ? saveOriginalRates(portfolio) : null;
    const backtestStartYear = backtesting ? parseInt(global_backtestYear) : 0;

    if (backtesting) {
        applyBacktestRates(portfolio, backtestStartYear);
    }

    const simStartYear = portfolio.firstDateInt.year;
    let currentDateInt = new DateInt(portfolio.firstDateInt.toInt());
    let lastDateInt = new DateInt(portfolio.lastDateInt.toInt());
    while (currentDateInt.toInt() <= lastDateInt.toInt()) {

        // Life events fire at the first tick of their trigger month,
        // before any financial calculations for that month.
        if (currentDateInt.day === 1) {
            portfolio.applyLifeEvents(currentDateInt);
        }

        totalMonths += portfolio.applyMonth(currentDateInt);
        currentDateInt.next();

        if (currentDateInt.day == 1) {
            portfolio.monthlyChron(currentDateInt);
            activeTaxTable.monthlyChron(currentDateInt);
        }

        if (currentDateInt.isNewYearsDay()) {
            if (backtesting) {
                applyBacktestForYear(portfolio, currentDateInt.year, backtestStartYear, simStartYear, savedRates);
            }

            portfolio.applyGuardrails(currentDateInt);
            portfolio.applyYear(currentDateInt);
            activeTaxTable.applyYear(portfolio.yearly);

            portfolio.yearlyChron(currentDateInt);

            // When backtesting, inflate tax tables using historical CPI
            const cpiRate = backtesting
                ? global_cpi_annual_inflation[backtestStartYear + (currentDateInt.year - simStartYear)]
                : undefined;
            activeTaxTable.yearlyChron(cpiRate != null ? cpiRate / 100 : undefined);
        }

        portfolio.totalMonths = totalMonths;

    }

    // Capture final year snapshot for guardrails
    if (portfolio.guardrailsParams) {
        const investable = portfolio.getTotalInvestableAssets().amount;
        const annualExpense = Math.abs(portfolio.yearly.expense.amount);
        portfolio.yearlySnapshots.push({
            year: portfolio.lastDateInt.year,
            investableAssets: investable,
            annualExpense,
            withdrawalRate: investable > 0 ? annualExpense / investable : 0,
        });
    }

    if (backtesting) {
        restoreOriginalRates(savedRates);
    }

    portfolio.finalizeChron();
    activeTaxTable.finalizeChron();

}
