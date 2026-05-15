/**
 * double-entry-income.mjs
 *
 * Verifies that the ModelAsset metric DAG and FinancialPackage agree on
 * INCOME for every month of the simulation.
 *
 * After chronometer_run, for each month i:
 *   DAG INCOME  = sum of asset.getHistory('income')[i] across all assets
 *   FP  INCOME  = portfolio.monthlyPackages[i].totalIncome()
 *
 * Usage:  node src/tests/double-entry-income.mjs   (from repo root)
 */

import assert from 'node:assert/strict';

// ── Mock browser globals ──────────────────────────────────────────────
const store = {};
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

// ── Imports ───────────────────────────────────────────────────────────
import { ModelAsset, Metric } from '../js/model-asset.js';
import { Portfolio } from '../js/portfolio.js';
import { chronometer_run } from '../js/chronometer.js';
import { TaxTable } from '../js/taxes.js';
import { setActiveTaxTable } from '../js/globals.js';

// ── QuickStart dataset ───────────────────────────────────────────────
const QUICK_START_DATA = [
    {
        instrument: 'workingIncome',
        displayName: 'Salary',
        startDateInt: { year: 2026, month: 1 },
        finishDateInt: { year: 2036, month: 12 },
        startCurrency: { amount: 6000 },
        startBasisCurrency: { amount: 0 },
        annualReturnRate: { rate: 0.025 },
        fundTransfers: [
            { toDisplayName: '401K', monthlyMoveValue: 10, closeMoveValue: 0 },
            { toDisplayName: 'Roth IRA', monthlyMoveValue: 5, closeMoveValue: 0 },
            { toDisplayName: 'Brokerage', monthlyMoveValue: 85, closeMoveValue: 0 },
        ],
    },
    {
        instrument: '401K',
        displayName: '401K',
        startDateInt: { year: 2026, month: 1 },
        finishDateInt: { year: 2036, month: 12 },
        startCurrency: { amount: 50000 },
        startBasisCurrency: { amount: 50000 },
        annualReturnRate: { rate: 0.09 },
    },
    {
        instrument: 'rothIRA',
        displayName: 'Roth IRA',
        startDateInt: { year: 2026, month: 1 },
        finishDateInt: { year: 2036, month: 12 },
        startCurrency: { amount: 25000 },
        startBasisCurrency: { amount: 20000 },
        annualReturnRate: { rate: 0.09 },
    },
    {
        instrument: 'taxableEquity',
        displayName: 'Brokerage',
        startDateInt: { year: 2026, month: 1 },
        finishDateInt: { year: 2036, month: 12 },
        startCurrency: { amount: 30000 },
        startBasisCurrency: { amount: 25000 },
        annualReturnRate: { rate: 0.09 },
        annualDividendRate: { rate: 0.02 },
    },
    {
        instrument: 'realEstate',
        displayName: 'Home',
        startDateInt: { year: 2026, month: 1 },
        finishDateInt: { year: 2036, month: 12 },
        startCurrency: { amount: 400000 },
        startBasisCurrency: { amount: 400000 },
        annualReturnRate: { rate: 0.03 },
        annualTaxRate: { rate: 0.012 },
    },
    {
        instrument: 'mortgage',
        displayName: 'Mortgage',
        startDateInt: { year: 2026, month: 1 },
        finishDateInt: { year: 2036, month: 12 },
        startCurrency: { amount: 320000 },
        startBasisCurrency: { amount: 0 },
        annualReturnRate: { rate: 0.065 },
        monthsRemaining: 360,
        fundTransfers: [
            { toDisplayName: 'Brokerage', monthlyMoveValue: 100, closeMoveValue: 0 },
        ],
    },
    {
        instrument: 'monthlyExpense',
        displayName: 'Living Expenses',
        startDateInt: { year: 2026, month: 1 },
        finishDateInt: { year: 2036, month: 12 },
        startCurrency: { amount: 3000 },
        startBasisCurrency: { amount: 0 },
        annualReturnRate: { rate: 0.03 },
        fundTransfers: [
            { toDisplayName: 'Brokerage', monthlyMoveValue: 100, closeMoveValue: 0 },
        ],
    },
];

// ── Helpers ───────────────────────────────────────────────────────────
const fmt = (n) => {
    const sign = n < 0 ? '-' : '';
    return sign + '$' + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

/** Parse a history entry to a number (handles Currency objects, strings, numbers, nulls) */
function historyVal(entry) {
    if (entry == null) return 0;
    if (typeof entry === 'number') return entry;
    if (entry.amount != null) return entry.amount;
    const parsed = parseFloat(entry);
    return isNaN(parsed) ? 0 : parsed;
}

// ── Run simulation ───────────────────────────────────────────────────
setActiveTaxTable(new TaxTable());

const modelAssets = QUICK_START_DATA.map(obj => ModelAsset.fromJSON(obj));
const portfolio = new Portfolio(modelAssets, true);
await chronometer_run(portfolio);

const assets = portfolio.modelAssets;
const monthlyPkgs = portfolio.monthlyPackages;
const numMonths = monthlyPkgs.length;

console.log(`\n── Double-Entry Income Test (${numMonths} months) ─────────────────\n`);

// ── Month-by-month comparison ────────────────────────────────────────

let passed = 0;
let failed = 0;
const tolerance = 0.01;
const mismatches = [];

for (let i = 0; i < numMonths; i++) {
    const pkg = monthlyPkgs[i];
    const fpIncome = pkg.totalIncome().amount;

    // Sum INCOME metric across all model assets at month i
    let dagIncome = 0;
    for (const asset of assets) {
        const history = asset.getHistory(Metric.INCOME);
        if (history && i < history.length) {
            dagIncome += historyVal(history[i]);
        }
    }

    if (Math.abs(dagIncome - fpIncome) > tolerance) {
        mismatches.push({ month: i, dagIncome, fpIncome, delta: dagIncome - fpIncome });
        failed++;
    } else {
        passed++;
    }
}

// ── Report results ───────────────────────────────────────────────────

if (mismatches.length > 0) {
    console.log(`  Found ${mismatches.length} month(s) with DAG vs FP income mismatch:\n`);

    // Show first 10 mismatches in detail
    const show = mismatches.slice(0, 10);
    for (const m of show) {
        console.log(`  Month ${String(m.month).padStart(3)}: DAG=${fmt(m.dagIncome).padStart(12)}  FP=${fmt(m.fpIncome).padStart(12)}  Δ=${fmt(m.delta).padStart(12)}`);
    }
    if (mismatches.length > 10) {
        console.log(`  ... and ${mismatches.length - 10} more`);
    }

    // Drill into first mismatch — show per-asset breakdown
    const firstBad = mismatches[0];
    console.log(`\n  ── Per-asset INCOME breakdown at month ${firstBad.month} ──\n`);
    for (const asset of assets) {
        const history = asset.getHistory(Metric.INCOME);
        const val = (history && firstBad.month < history.length) ? historyVal(history[firstBad.month]) : 0;
        if (val !== 0) {
            console.log(`    ${asset.displayName.padEnd(20)} ${fmt(val).padStart(12)}`);
        }
    }

    console.log(`\n  ── FP income breakdown at month ${firstBad.month} ──\n`);
    const pkg = monthlyPkgs[firstBad.month];
    console.log(`    wageIncome (employed+self):  ${fmt(pkg.wageIncome().amount)}`);
    console.log(`    ordinaryIncome:             ${fmt(pkg.ordinaryIncome().amount)}`);
    console.log(`    nontaxableIncome:           ${fmt(pkg.nontaxableIncome().amount)}`);
    console.log(`    longTermCapitalGains:       ${fmt(pkg.longTermCapitalGains.amount)}`);
    console.log(`    qualifiedDividends:         ${fmt(pkg.qualifiedDividends.amount)}`);
    console.log(`    nonQualifiedDividends:      ${fmt(pkg.nonQualifiedDividends.amount)}`);
    console.log(`    totalIncome:                ${fmt(pkg.totalIncome().amount)}`);
}

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} months matched, ${failed} months mismatched`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
