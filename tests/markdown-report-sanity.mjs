/**
 * markdown-report-sanity.mjs
 *
 * Runs the simulation on the QuickStart dataset, generates the AI markdown
 * report, and asserts key structural and content invariants.
 *
 * Usage:  node src/tests/markdown-report-sanity.mjs   (from repo root)
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
import { ModelAsset } from '../js/model-asset.js';
import { Portfolio } from '../js/portfolio.js';
import { chronometer_run } from '../js/chronometer.js';
import { TaxTable } from '../js/taxes.js';
import { setActiveTaxTable } from '../js/globals.js';
import { generatePortfolioMarkdown } from '../js/generators/assets-ai.js';

// ── QuickStart data ───────────────────────────────────────────────────
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
            { toDisplayName: '401K', frequency: 'monthly', monthlyMoveValue: 10, closeMoveValue: 0 },
            { toDisplayName: 'Roth IRA', frequency: 'monthly', monthlyMoveValue: 5, closeMoveValue: 0 },
            { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 85, closeMoveValue: 0 },
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
            { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 100, closeMoveValue: 0 },
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
            { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 100, closeMoveValue: 0 },
        ],
    },
];

// ── Helpers ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function check(label, fn) {
    try {
        fn();
        console.log(`  ✓ ${label}`);
        passed++;
    } catch (e) {
        console.log(`  ✗ ${label}`);
        console.log(`    ${e.message}`);
        failed++;
    }
}

// ── Run simulation & generate report ─────────────────────────────────
setActiveTaxTable(new TaxTable());

const modelAssets = QUICK_START_DATA.map(obj => ModelAsset.fromJSON(obj));
const portfolio = new Portfolio(modelAssets, true);
await chronometer_run(portfolio);

const md = generatePortfolioMarkdown(portfolio);

// ── Structure Tests ──────────────────────────────────────────────────

console.log('\n── Markdown Structure Tests ─────────────────────────────\n');

check('Report is a non-empty string', () => {
    assert.ok(typeof md === 'string' && md.length > 500,
        `Report is ${typeof md}, length ${md.length}`);
});

check('Contains top-level heading', () => {
    assert.ok(md.includes('# Portfolio Projection Report'),
        'Missing top-level heading');
});

check('Contains Simulation Parameters section', () => {
    assert.ok(md.includes('## Simulation Parameters'),
        'Missing Simulation Parameters section');
});

check('Contains Net Worth Summary section', () => {
    assert.ok(md.includes('## Net Worth Summary'),
        'Missing Net Worth Summary section');
});

check('Contains Annual Cash Flow section', () => {
    assert.ok(md.includes('## Annual Cash Flow'),
        'Missing Annual Cash Flow section');
});

check('Contains Asset Inventory section', () => {
    assert.ok(md.includes('## Asset Inventory'),
        'Missing Asset Inventory section');
});

check('Contains Money Flow Topology section', () => {
    assert.ok(md.includes('## Money Flow Topology'),
        'Missing Money Flow Topology section');
});

check('Contains Lifetime Tax Breakdown section', () => {
    assert.ok(md.includes('## Lifetime Tax Breakdown'),
        'Missing Lifetime Tax Breakdown section');
});

// ── Content Tests ────────────────────────────────────────────────────

console.log('\n── Markdown Content Tests ──────────────────────────────\n');

check('All 7 assets appear in the report', () => {
    for (const name of ['Salary', '401K', 'Roth IRA', 'Brokerage', 'Home', 'Mortgage', 'Living Expenses']) {
        assert.ok(md.includes(name), `Missing asset: ${name}`);
    }
});

check('Simulation dates are present', () => {
    assert.ok(md.includes('2026'), 'Missing start year');
    assert.ok(md.includes('2036'), 'Missing end year');
});

check('Filing status is present', () => {
    assert.ok(md.includes('Single') || md.includes('Married'),
        'Missing filing status');
});

check('Fund transfer topology shows Salary → Brokerage', () => {
    assert.ok(md.includes('Salary') && md.includes('Brokerage') && md.includes('85%'),
        'Missing Salary → Brokerage 85% transfer');
});

check('Fund transfer topology shows Salary → 401K', () => {
    assert.ok(md.includes('10%') && md.includes('401K'),
        'Missing Salary → 401K 10% transfer');
});

check('Mortgage shows interest rate', () => {
    assert.ok(md.includes('6.5%'),
        'Missing mortgage interest rate (6.5%)');
});

check('Tax breakdown includes income tax row', () => {
    assert.ok(md.includes('Federal Income Tax'),
        'Missing Federal Income Tax in breakdown');
});

check('Tax breakdown includes FICA taxes', () => {
    assert.ok(md.includes('Social Security Tax') && md.includes('Medicare Tax'),
        'Missing FICA taxes in breakdown');
});

check('Tax breakdown includes property taxes', () => {
    assert.ok(md.includes('Property Taxes'),
        'Missing Property Taxes in breakdown');
});

check('Annual cash flow table has multiple year rows', () => {
    const yearRows = md.match(/\| 20\d{2}-\d{2} \|/g);
    assert.ok(yearRows && yearRows.length >= 5,
        `Expected at least 5 annual rows, found ${yearRows ? yearRows.length : 0}`);
});

check('Tax-deferred status noted for 401K', () => {
    // Find the 401K section and check for tax status
    const idx401k = md.indexOf('401K');
    const section = md.substring(idx401k, idx401k + 500);
    assert.ok(section.includes('Tax-Deferred'),
        'Missing Tax-Deferred status for 401K');
});

check('Tax-free status noted for Roth IRA', () => {
    const idxRoth = md.indexOf('Roth IRA');
    const section = md.substring(idxRoth, idxRoth + 500);
    assert.ok(section.includes('Tax-Free'),
        'Missing Tax-Free status for Roth IRA');
});

check('Brokerage negative balance triggers observation', () => {
    assert.ok(md.includes('Observations') && md.includes('negative balance'),
        'Missing observation about Brokerage going negative');
});

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
