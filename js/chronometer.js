import { DateInt } from './utils/date-int.js';
import { logger, LogCategory } from './utils/logger.js';
import { resetTraces, traceScopes, assertNoOpenScopes } from './trace.js';
import { activeTaxTable, global_backtestYear, global_inflationRate, global_sp500_annual_returns, global_10yr_treasury_rates, global_cpi_annual_inflation, global_wage_growth_annual } from './globals.js';
import { Instrument, InstrumentType } from './instruments/instrument.js';
import { PriceIndex } from './utils/price-index.js';

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

/**
 * Inflation rate driving the real-dollar deflator for one simulated year.
 *
 * Deliberately mirrors applyBacktestForYear's data-year mapping AND its
 * fallback: CPI data covers 1970-2025, so a long plan backtested from a
 * recent year runs off the end. There, applyBacktestForYear restores the
 * assets' configured rates — so the deflator must fall back to the general
 * inflation rate rather than flattening the real line to zero growth.
 */
function inflationRateForYear(backtesting, backtestStartYear, simStartYear, simulationYear) {
    if (!backtesting) return global_inflationRate;
    const dataYear = backtestStartYear + (simulationYear - simStartYear);
    const cpi = global_cpi_annual_inflation[dataYear];
    return cpi != null ? cpi / 100 : global_inflationRate;
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

    // Clear the logger's per-run output cap. SANITY fires once a month, so a
    // 666-month plan with a real reconciliation problem can emit thousands of
    // lines; without a per-run reset the cap would silence the second run of a
    // session instead of the tail of the first.
    logger.reset();
    resetTraces();

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

    // Real-dollar deflator. Stepped on the same tick as monthlyChron so its
    // history lines up index-for-index with every asset metric history.
    const priceIndex = new PriceIndex(
        inflationRateForYear(backtesting, backtestStartYear, simStartYear, simStartYear)
    );
    portfolio.monthlyPriceIndex = priceIndex.history;

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
            priceIndex.stepAndRecord();
        }

        if (currentDateInt.isNewYearsDay()) {
            if (backtesting) {
                applyBacktestForYear(portfolio, currentDateInt.year, backtestStartYear, simStartYear, savedRates);
            }
            // Same data year the asset rates and tax tables just moved to.
            priceIndex.setAnnualRate(
                inflationRateForYear(backtesting, backtestStartYear, simStartYear, currentDateInt.year)
            );

            portfolio.applyGuardrails(currentDateInt);
            portfolio.applyYear(currentDateInt);
            activeTaxTable.applyYear(portfolio.yearly, portfolio.activeUser);

            portfolio.yearlyChron(currentDateInt);

            // When backtesting, inflate tax tables using historical CPI
            const cpiRate = backtesting
                ? global_cpi_annual_inflation[backtestStartYear + (currentDateInt.year - simStartYear)]
                : undefined;
            activeTaxTable.yearlyChron(cpiRate != null ? cpiRate / 100 : undefined);
        }

        portfolio.totalMonths = totalMonths;

    }

    // Capture the plan's trailing stub year for guardrails.
    //
    // The loop above snapshots a year on each New Year's rollover and then
    // zeroes portfolio.yearly (yearlyChron). A plan ending in December has
    // therefore already been snapshotted in full — currentDateInt sits on the
    // following New Year's Day — and appending here would duplicate that year
    // with an empty accumulator ($0 spend, 0% withdrawal rate). Only a plan
    // that ends mid-year leaves unaccumulated months in portfolio.yearly.
    if (portfolio.guardrailsParams && !currentDateInt.isNewYearsDay()) {
        const investable = portfolio.getTotalInvestableAssets().amount;
        const annualExpense = Math.abs(portfolio.yearly.expense.amount);
        const finalYear = portfolio.lastDateInt.year;
        portfolio.yearlySnapshots.push({
            year: finalYear,
            months: portfolio.monthsInPlanYear(finalYear),
            partial: true,
            investableAssets: investable,
            annualExpense,
            withdrawalRate: investable > 0 ? annualExpense / investable : 0,
        });
    }

    if (backtesting) {
        restoreOriginalRates(savedRates);
    }

    // The loop's last iteration runs applyYear AFTER monthlyChron, so anything
    // the annual pass emitted has never been through a reconciliation scan.
    // Nothing below appends events, so this is the last point that can see them.
    portfolio.finalSanityCheck(currentDateInt);

    portfolio.finalizeChron();
    activeTaxTable.finalizeChron();

    // Hand the causal scopes to the portfolio so any consumer can answer
    // "why did this happen?" without reaching into module state.
    portfolio.traceScopes = traceScopes();

    // A scope left open means an engine operation returned without unwinding,
    // and every event after it was attributed to the wrong parent. Silent
    // misattribution is worse than none, so say so.
    if (!assertNoOpenScopes()) {
        logger.log(LogCategory.SANITY,
            'trace scopes left open at end of run — causal attribution is unreliable');
    }
}
