/**
 * double-entry-income.mjs
 *
 * Verifies that for each month the sum of modelAsset metrics
 * matches the FinancialPackage rollup values for INCOME, CONTRIBUTION,
 * EXPENSE, and TAX leaves.
 *
 * This is the core double-entry invariant: the portfolio-level FP
 * must equal the sum of per-asset tracked metrics.
 *
 * Run: node tests/double-entry-income.mjs
 */

import { Portfolio } from '../js/portfolio.js';
import { ModelAsset } from '../js/model-asset.js';
import { FundTransfer, Frequency } from '../js/fund-transfer.js';
import { Instrument, InstrumentType } from '../js/instruments/instrument.js';
import { Currency } from '../js/utils/currency.js';
import { DateInt } from '../js/utils/date-int.js';
import { ARR } from '../js/utils/arr.js';
import { Metric } from '../js/metric.js';
import { TaxTable } from '../js/taxes.js';
import { setActiveTaxTable } from '../js/globals.js';
import { chronometer_run } from '../js/chronometer.js';
import { ModelLifeEvent, LifeEvent } from '../js/life-event.js';

// ── Setup ────────────────────────────────────────────────────────────

setActiveTaxTable(new TaxTable());

let passed = 0;
let failed = 0;

/** Parse a history entry (may be Currency string, number, or null) to a float */
function toNum(entry) {
    if (entry == null) return 0;
    if (typeof entry === 'number') return entry;
    if (entry.amount != null) return entry.amount;
    const n = parseFloat(entry);
    return isNaN(n) ? 0 : n;
}

/** Sum a metric across all assets for a given month index */
function sumMetric(assets, metricKey, monthIdx) {
    let total = 0;
    for (const asset of assets) {
        const history = asset.getHistory(metricKey);
        if (history && monthIdx < history.length) {
            total += toNum(history[monthIdx]);
        }
    }
    return total;
}

// ── Build a realistic multi-asset portfolio ──────────────────────────

const salary = new ModelAsset({
    instrument: Instrument.WORKING_INCOME,
    displayName: 'Salary',
    startDateInt: DateInt.parse('2026-01'),
    finishDateInt: DateInt.parse('2027-12'),
    startCurrency: new Currency(10000),
    annualReturnRate: new ARR(0),
});

const four01k = new ModelAsset({
    instrument: Instrument.FOUR_01K,
    displayName: '401K',
    startDateInt: DateInt.parse('2026-01'),
    finishDateInt: DateInt.parse('2027-12'),
    startCurrency: new Currency(200000),
    annualReturnRate: new ARR(0.07),
});

const brokerage = new ModelAsset({
    instrument: Instrument.TAXABLE_EQUITY,
    displayName: 'Brokerage',
    startDateInt: DateInt.parse('2026-01'),
    finishDateInt: DateInt.parse('2027-12'),
    startCurrency: new Currency(500000),
    startBasisCurrency: new Currency(300000),
    annualReturnRate: new ARR(0.08),
    annualDividendRate: new ARR(0.02),
    dividendQualifiedRatio: 0.6,
});

const savings = new ModelAsset({
    instrument: Instrument.BANK,
    displayName: 'Savings',
    startDateInt: DateInt.parse('2026-01'),
    finishDateInt: DateInt.parse('2027-12'),
    startCurrency: new Currency(20000),
    annualReturnRate: new ARR(0.04),
});

const expenses = new ModelAsset({
    instrument: Instrument.MONTHLY_EXPENSE,
    displayName: 'Living',
    startDateInt: DateInt.parse('2026-01'),
    finishDateInt: DateInt.parse('2027-12'),
    startCurrency: new Currency(-4000),
    annualReturnRate: new ARR(0),
});

// 20% of salary net → 401K
salary.fundTransfers = [
    new FundTransfer('401K', Frequency.MONTHLY, 20, 0),
];

// Retire at month 7 — closes salary, expenses pull from brokerage
const accumulate = new ModelLifeEvent({
    type: LifeEvent.ACCUMULATE,
    displayName: 'Accumulate',
    triggerAge: 57,
});

const retire = new ModelLifeEvent({
    type: LifeEvent.RETIRE,
    displayName: 'Retire',
    triggerAge: 57,
    closes: ['Salary'],
});
Object.defineProperty(retire, 'triggerDateInt', {
    get() { return DateInt.parse('2026-07'); }
});

const allAssets = [salary, four01k, brokerage, savings, expenses];
const portfolio = new Portfolio(allAssets, false);
portfolio.lifeEvents = [accumulate, retire];
portfolio.firstDateInt = DateInt.parse('2026-01');
portfolio.lastDateInt = DateInt.parse('2026-12');

await chronometer_run(portfolio);

// ── Double-entry checks ──────────────────────────────────────────────

const totalMonths = portfolio.monthlyPackages.length;
const assets = portfolio.modelAssets;

console.log(`\n  Double-Entry Income & Contribution Test (${totalMonths} months)\n`);

// Define the leaf metrics to compare.
// FP method → array of Metric keys whose sum should match.

const INCOME_LEAVES = [
    { label: 'employedIncome',     fp: pkg => pkg.employedIncome.amount,         metric: Metric.EMPLOYED_INCOME },
    { label: 'selfIncome',         fp: pkg => pkg.selfIncome.amount,             metric: Metric.SELF_INCOME },
    { label: 'socialSecurityIncome', fp: pkg => pkg.socialSecurityIncome.amount,  metric: Metric.SOCIAL_SECURITY_INCOME },
    { label: 'interestIncome',     fp: pkg => pkg.interestIncome.amount,         metric: Metric.INTEREST_INCOME },
    { label: 'shortTermCapGain',   fp: pkg => pkg.shortTermCapitalGains.amount,  metric: Metric.SHORT_TERM_CAPITAL_GAIN },
    { label: 'longTermCapGain',    fp: pkg => pkg.longTermCapitalGains.amount,   metric: Metric.LONG_TERM_CAPITAL_GAIN },
    { label: 'qualifiedDividend',  fp: pkg => pkg.qualifiedDividends.amount,     metric: Metric.QUALIFIED_DIVIDEND },
    { label: 'nonQualDividend',    fp: pkg => pkg.nonQualifiedDividends.amount,  metric: Metric.NON_QUALIFIED_DIVIDEND },
];

const CONTRIBUTION_LEAVES = [
    { label: 'four01KContribution', fp: pkg => pkg.four01KContribution.amount,   metric: Metric.FOUR_01K_CONTRIBUTION },
    { label: 'tradIRAContribution', fp: pkg => pkg.tradIRAContribution.amount,   metric: Metric.TRAD_IRA_CONTRIBUTION },
    { label: 'rothIRAContribution', fp: pkg => pkg.rothIRAContribution.amount,   metric: Metric.ROTH_IRA_CONTRIBUTION },
];

const DISTRIBUTION_LEAVES = [
    { label: 'tradIRADistribution',  fp: pkg => pkg.tradIRADistribution.amount,  metric: Metric.TRAD_IRA_DISTRIBUTION },
    { label: 'four01KDistribution',  fp: pkg => pkg.four01KDistribution.amount,  metric: Metric.FOUR_01K_DISTRIBUTION },
    { label: 'rothIRADistribution',  fp: pkg => pkg.rothIRADistribution.amount,  metric: Metric.ROTH_IRA_DISTRIBUTION },
];

const EXPENSE_LEAVES = [
    { label: 'expense',           fp: pkg => pkg.expense.amount,              metric: Metric.EXPENSE },
    { label: 'mortgageInterest',  fp: pkg => pkg.mortgageInterest.amount,     metric: Metric.MORTGAGE_INTEREST },
    { label: 'mortgagePrincipal', fp: pkg => pkg.mortgagePrincipal.amount,    metric: Metric.MORTGAGE_PRINCIPAL },
    { label: 'maintenance',       fp: pkg => pkg.maintenance.amount,          metric: Metric.MAINTENANCE },
    { label: 'insurance',         fp: pkg => pkg.insurance.amount,            metric: Metric.INSURANCE },
];

const TAX_LEAVES = [
    { label: 'socialSecurityTax',  fp: pkg => pkg.socialSecurityTax.amount,        metric: Metric.SOCIAL_SECURITY_TAX },
    { label: 'medicareTax',        fp: pkg => pkg.medicareTax.amount,              metric: Metric.MEDICARE_TAX },
    { label: 'longTermCapGainsTax', fp: pkg => pkg.longTermCapitalGainsTax.amount, metric: Metric.LONG_TERM_CAPITAL_GAIN_TAX },
    { label: 'propertyTax',        fp: pkg => pkg.propertyTaxes.amount,            metric: Metric.PROPERTY_TAX },
];

const GROWTH_VALUE_FLOW_LEAVES = [
    { label: 'growth',    fp: pkg => pkg.assetAppreciation.amount,  metric: Metric.GROWTH },
    { label: 'value',     fp: pkg => pkg.value.amount,              metric: Metric.VALUE },
    { label: 'cashFlow',  fp: pkg => pkg.cashFlow().amount,         metric: Metric.CASH_FLOW },
];

const TOLERANCE = 0.02; // penny tolerance

/** @param {ModelAsset[]} [assetScope] - subset of assets to sum (defaults to all) */
function checkLeaves(label, leaves, assetScope = assets) {
    let groupPassed = 0;
    let groupFailed = 0;

    for (let m = 0; m < totalMonths; m++) {
        const pkg = portfolio.monthlyPackages[m];

        for (const leaf of leaves) {
            const fpVal = leaf.fp(pkg);
            const assetSum = sumMetric(assetScope, leaf.metric, m);
            const diff = Math.abs(fpVal - assetSum);

            if (diff < TOLERANCE) {
                groupPassed++;
                passed++;
            } else {
                groupFailed++;
                failed++;
                console.error(`  FAIL  month ${m + 1} ${leaf.label}: FP=${fpVal.toFixed(2)} assets=${assetSum.toFixed(2)} diff=${diff.toFixed(2)}`);
            }
        }
    }

    console.log(`  ${label}: ${groupPassed} passed, ${groupFailed} failed (${leaves.length} leaves x ${totalMonths} months)`);
}

// Contributions are recorded on the destination (capital accounts), not the source (income)
const capitalAssets = assets.filter(a =>
    InstrumentType.isCapital(a.instrument)
);

checkLeaves('INCOME leaves', INCOME_LEAVES);
checkLeaves('CONTRIBUTION leaves', CONTRIBUTION_LEAVES, capitalAssets);
checkLeaves('DISTRIBUTION leaves', DISTRIBUTION_LEAVES, capitalAssets);
checkLeaves('EXPENSE leaves', EXPENSE_LEAVES);
checkLeaves('TAX leaves', TAX_LEAVES);
checkLeaves('GROWTH/VALUE/FLOW leaves', GROWTH_VALUE_FLOW_LEAVES);

// Also check rollup totals
let rollupFails = 0;
for (let m = 0; m < totalMonths; m++) {
    const pkg = portfolio.monthlyPackages[m];

    // INCOME rollup
    const fpIncome = pkg.totalIncome().amount;
    const assetIncome = sumMetric(assets, Metric.INCOME, m);
    if (Math.abs(fpIncome - assetIncome) >= TOLERANCE) {
        rollupFails++;
        failed++;
        console.error(`  FAIL  month ${m + 1} INCOME rollup: FP=${fpIncome.toFixed(2)} assets=${assetIncome.toFixed(2)}`);
    } else {
        passed++;
    }

    // CONTRIBUTION rollup (sum from destination accounts only)
    const fpContrib = pkg.contributions().amount;
    const assetContrib = sumMetric(capitalAssets, Metric.CONTRIBUTION, m);
    if (Math.abs(fpContrib - assetContrib) >= TOLERANCE) {
        rollupFails++;
        failed++;
        console.error(`  FAIL  month ${m + 1} CONTRIBUTION rollup: FP=${fpContrib.toFixed(2)} assets=${assetContrib.toFixed(2)}`);
    } else {
        passed++;
    }
}
console.log(`  ROLLUP totals: ${totalMonths * 2 - rollupFails} passed, ${rollupFails} failed (INCOME + CONTRIBUTION x ${totalMonths} months)`);

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);