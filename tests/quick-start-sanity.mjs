/**
 * quick-start-sanity.mjs
 *
 * Runs the simulation on the QuickStart dataset and asserts key invariants:
 *   - simulation completes without error
 *   - capital gains are recorded when taxable accounts are debited
 *   - asset balances move in expected directions
 *   - fund transfers flow to the correct accounts
 *
 * Usage:  node src/tests/quick-start-sanity.mjs   (from repo root)
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

// ── QuickStart data (inline to avoid Lit import from quick-start.js) ──
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
const find = (assets, name) => assets.find(a => a.displayName === name);
const fmt = (n) => {
    const sign = n < 0 ? '-' : '';
    return sign + '$' + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};
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

// ── Run simulation ───────────────────────────────────────────────────
setActiveTaxTable(new TaxTable());

const modelAssets = QUICK_START_DATA.map(obj => ModelAsset.fromJSON(obj));
const portfolio = new Portfolio(modelAssets, true);
await chronometer_run(portfolio);

const assets = portfolio.modelAssets;

// ── Tests ────────────────────────────────────────────────────────────

console.log('\n── Asset Direction Tests ────────────────────────────────\n');

const four01k   = find(assets, '401K');
const roth      = find(assets, 'Roth IRA');
const brokerage = find(assets, 'Brokerage');
const home      = find(assets, 'Home');
const mortgage  = find(assets, 'Mortgage');

check('401K grew above starting value (contributions + growth)', () => {
    assert.ok(four01k.finishCurrency.amount > 50000,
        `401K ended at ${fmt(four01k.finishCurrency.amount)}, expected > $50,000`);
});

check('Roth IRA grew above starting value (contributions + growth)', () => {
    assert.ok(roth.finishCurrency.amount > 25000,
        `Roth ended at ${fmt(roth.finishCurrency.amount)}, expected > $25,000`);
});

check('Home appreciated above starting value', () => {
    assert.ok(home.finishCurrency.amount > 400000,
        `Home ended at ${fmt(home.finishCurrency.amount)}, expected > $400,000`);
});

check('Mortgage balance decreased (principal paid down)', () => {
    assert.ok(Math.abs(mortgage.finishCurrency.amount) < 320000,
        `Mortgage ended at ${fmt(mortgage.finishCurrency.amount)}, expected less than $320,000 remaining`);
});

check('Brokerage balance changed from start (salary in, expenses/mortgage out)', () => {
    assert.ok(brokerage.finishCurrency.amount !== 30000,
        `Brokerage unchanged at ${fmt(brokerage.finishCurrency.amount)}, expected activity`);
});

console.log('\n── Capital Gains Tests ─────────────────────────────────\n');

// Total accumulated LTCG across the entire simulation
const totalLTCG = portfolio.total.longTermCapitalGains.amount;

check('Long-term capital gains were recorded (taxable account debits)', () => {
    assert.ok(totalLTCG !== 0,
        `Total recorded LTCG = ${fmt(totalLTCG)}, expected non-zero (mortgage & property tax debit brokerage)`);
});

console.log('\n── Fund Transfer Flow Tests ────────────────────────────\n');

// Verify salary fund transfers created memos on target accounts
const brokerageMemos = brokerage.creditMemos.filter(m => m.note && m.note.includes('Salary'));
const four01kMemos = four01k.creditMemos.filter(m => m.note && m.note.includes('Salary'));
const rothMemos = roth.creditMemos.filter(m => m.note && m.note.includes('Salary'));

check('Salary deposited to Brokerage (credit memos exist)', () => {
    assert.ok(brokerageMemos.length > 0,
        `Expected Salary→Brokerage credit memos, found ${brokerageMemos.length}`);
});

check('Salary deposited to 401K (credit memos exist)', () => {
    assert.ok(four01kMemos.length > 0,
        `Expected Salary→401K credit memos, found ${four01kMemos.length}`);
});

check('Salary deposited to Roth IRA (credit memos exist)', () => {
    assert.ok(rothMemos.length > 0,
        `Expected Salary→Roth IRA credit memos, found ${rothMemos.length}`);
});

// Mortgage payment memos on brokerage (funding source)
const mortgageMemos = brokerage.creditMemos.filter(m => m.note && m.note.toLowerCase().includes('mortgage'));

check('Mortgage payments debited from Brokerage (credit memos exist)', () => {
    assert.ok(mortgageMemos.length > 0,
        `Expected mortgage payment memos on Brokerage, found ${mortgageMemos.length}`);
});

// Property tax memos on brokerage (funding source)
const propTaxMemos = brokerage.creditMemos.filter(m => m.note && m.note.includes('property tax'));

check('Property tax debited from Brokerage (credit memos exist)', () => {
    assert.ok(propTaxMemos.length > 0,
        `Expected property tax memos on Brokerage, found ${propTaxMemos.length}`);
});

console.log('\n── Balance Snapshot ─────────────────────────────────────\n');

for (const asset of assets) {
    const start = asset.startCurrency.amount;
    const end = asset.finishCurrency.amount;
    const closed = asset.isClosed ? ' (closed)' : '';
    console.log(`  ${asset.displayName.padEnd(20)} ${fmt(start).padStart(12)} → ${fmt(end).padStart(12)}${closed}`);
}

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
