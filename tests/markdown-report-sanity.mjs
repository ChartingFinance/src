/**
 * markdown-report-sanity.mjs
 *
 * Runs the simulation on the QuickStart dataset, generates the combined AI
 * markdown report (generatePortfolioMarkdown in generators/finplan-ai.js),
 * and asserts key structural and content invariants.
 *
 * Section names assert the CURRENT finplan-ai.js contract (Your Portfolio /
 * Net Worth / Assets by Group / Fund Transfer Topology / Reports /
 * Lifetime Tax Summary / Annual Cash Flow / Spreadsheet). The original
 * version of this test targeted the retired assets-ai.js generator, whose
 * section names no longer exist.
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
import { generatePortfolioMarkdown } from '../js/generators/finplan-ai.js';

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

check('Contains Portfolio top-level section', () => {
    assert.ok(md.includes('# Your Portfolio'),
        'Missing # Your Portfolio section');
});

check('Contains Net Worth section', () => {
    assert.ok(md.includes('## Net Worth'),
        'Missing Net Worth section');
});

check('Contains Assets by Group section', () => {
    assert.ok(md.includes('## Assets by Group'),
        'Missing Assets by Group section');
});

check('Contains Fund Transfer Topology section', () => {
    assert.ok(md.includes('## Fund Transfer Topology'),
        'Missing Fund Transfer Topology section');
});

check('Contains Projections section', () => {
    assert.ok(md.includes('# Projections'),
        'Missing Projections section');
});

check('Contains Credit Memos section', () => {
    assert.ok(md.includes('# Credit Memos'),
        'Missing Credit Memos section');
});

check('Contains Lifetime Tax Summary section', () => {
    assert.ok(md.includes('## Lifetime Tax Summary'),
        'Missing Lifetime Tax Summary section');
});

check('Contains Annual Cash Flow section', () => {
    assert.ok(md.includes('## Annual Cash Flow'),
        'Missing Annual Cash Flow section');
});

check('Contains Spreadsheet Asset Summary section', () => {
    assert.ok(md.includes('# Spreadsheet') && md.includes('## Asset Summary'),
        'Missing Spreadsheet / Asset Summary section');
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

// NOTE: filing status lives in the Timeline section (generateTimelineMarkdown),
// which generatePortfolioMarkdown does not include — so it is deliberately
// not asserted here.

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

check('Tax summary includes income tax row', () => {
    assert.ok(md.includes('| Income Tax |'),
        'Missing Income Tax row in Lifetime Tax Summary');
});

check('Tax summary includes FICA taxes', () => {
    assert.ok(md.includes('| SS Tax |') && md.includes('| Medicare Tax |'),
        'Missing FICA tax rows in Lifetime Tax Summary');
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

check('Asset summary table lists every asset with start/end values', () => {
    // The Spreadsheet section's Asset Summary table has one row per asset
    const rows = md.match(/\n\| (Salary|401K|Roth IRA|Brokerage|Home|Mortgage|Living Expenses) \|/g);
    assert.ok(rows && rows.length >= 7,
        `Expected 7 asset rows in Asset Summary, found ${rows ? rows.length : 0}`);
});
// NOTE: the retired assets-ai.js generator annotated assets with
// Tax-Deferred / Tax-Free status and emitted an Observations section for
// negative balances. finplan-ai.js does not — those checks were removed,
// not relaxed. If those features return, re-assert them here.

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
