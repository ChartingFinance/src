/**
 * start-sign-conservation.mjs
 *
 * Regression tests for the month-one start-sign bug fixed 2026-06-12:
 *
 * Liability/outflow instruments (expense, mortgage, debt) live as negative
 * balances, but the UI and saved datasets enter them as positive amounts.
 * Sign normalization used to happen lazily inside each behavior's
 * applyMonthly, so correctness depended on tick ordering per instrument:
 *
 *   - Expense: day-30 transfers run BEFORE ExpenseBehavior.applyMonthly, so
 *     the first month's transfer read a POSITIVE balance and flowed
 *     backwards — depositing the expense amount INTO the funding account.
 *   - Debt: CapitalBehavior has no normalizer at all, and its paid-off clamp
 *     (balance >= 0 → zero) erased a positive-entered debt on day 1.
 *
 * The fix normalizes the sign when the live balance is seeded on the asset's
 * start date, before any engine reads it.
 *
 * Usage:  node src/tests/start-sign-conservation.mjs   (from repo root)
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

// ── Helpers ───────────────────────────────────────────────────────────
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

async function runPortfolio(assetData) {
  setActiveTaxTable(new TaxTable());
  const modelAssets = assetData.map(obj => ModelAsset.fromJSON(obj));
  const portfolio = new Portfolio(modelAssets, true);
  await chronometer_run(portfolio);
  return portfolio;
}

const YEAR = { startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 12 } };

// ══════════════════════════════════════════════════════════════════════
// Scenario I — POSITIVE-entered expense pays out from month one
//
// $4,000/mo expense entered as +4000 (the UI convention), funded 100% from
// a brokerage with basis == value (no gains, no taxes — every balance
// change is pure expense cash flow).
// ══════════════════════════════════════════════════════════════════════

console.log('\n── Scenario I: positive-entered expense (month one) ────\n');

const portfolioI = await runPortfolio([
  {
    instrument: 'taxableEquity', displayName: 'Brokerage', ...YEAR,
    startCurrency: { amount: 100000 }, startBasisCurrency: { amount: 100000 },
    annualReturnRate: { rate: 0 },
  },
  {
    instrument: 'monthlyExpense', displayName: 'Living Expenses', ...YEAR,
    startCurrency: { amount: 4000 },   // positive on purpose — the UI does this
    startBasisCurrency: { amount: 0 },
    annualReturnRate: { rate: 0 },
    fundTransfers: [
      { toDisplayName: 'Brokerage', monthlyMoveValue: 100, closeMoveValue: 0 },
    ],
  },
]);

const brokerageI = portfolioI.modelAssets.find(a => a.displayName === 'Brokerage');
const totalI     = portfolioI.total;

const expenseMemosI = brokerageI.creditMemos.filter(m => m.note?.includes('Living Expenses →'));

check('twelve expense withdrawals hit the brokerage', () => {
  assert.equal(expenseMemosI.length, 12, `Found ${expenseMemosI.length} expense memos, expected 12`);
});

check('every expense memo is an outflow — including month one', () => {
  const inflows = expenseMemosI.filter(m => m.amount.amount > 0);
  assert.equal(inflows.length, 0,
    `${inflows.length} expense memo(s) DEPOSITED into the brokerage ` +
    `(first: ${fmt(inflows[0]?.amount.amount ?? 0)}) — pre-fix month one flowed backwards`);
});

check('conservation: ΔBrokerage == expense recorded (±$1)', () => {
  const delta = brokerageI.finishCurrency.amount - 100000;
  assert.ok(Math.abs(delta - totalI.expense.amount) < 1,
    `ΔBrokerage ${fmt(delta)} vs FP expense ${fmt(totalI.expense.amount)} — ` +
    `residual ${fmt(delta - totalI.expense.amount)} (pre-fix: +2× the monthly expense, ` +
    `one phantom deposit plus one missing withdrawal)`);
});

// ══════════════════════════════════════════════════════════════════════
// Scenario J — POSITIVE-entered debt is a liability, not erased
//
// A $10,000 debt entered as +10000. CapitalBehavior's paid-off clamp
// (balance >= 0 → zero) used to erase it on day 1 of month one because
// debt had no sign normalizer at all. Zero interest rate so the balance
// is exact.
// ══════════════════════════════════════════════════════════════════════

console.log('\n── Scenario J: positive-entered debt (not erased) ──────\n');

const portfolioJ = await runPortfolio([
  {
    instrument: 'debt', displayName: 'Credit Card', ...YEAR,
    startCurrency: { amount: 10000 },  // positive on purpose — the UI does this
    startBasisCurrency: { amount: 0 },
    annualReturnRate: { rate: 0 },
  },
]);

const debtJ = portfolioJ.modelAssets.find(a => a.displayName === 'Credit Card');

check('debt survives as a $10,000 liability (negative balance)', () => {
  assert.ok(Math.abs(debtJ.finishCurrency.amount - (-10000)) < 0.01,
    `Debt ended at ${fmt(debtJ.finishCurrency.amount)}, expected -$10,000.00 — ` +
    `pre-fix the paid-off clamp zeroed it on day 1 (debt silently forgiven)`);
});

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
