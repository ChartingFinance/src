/**
 * payroll-tax-conservation.mjs
 *
 * Money-conservation regression tests for two formula bugs fixed 2026-06-12:
 *
 *   F2 — Pre-tax 401K/IRA payroll deferrals must reduce the paycheck.
 *        Before the fix, the 401K was credited with the contribution AND the
 *        full unreduced net income was swept to savings: the household
 *        fabricated exactly the contribution amount every month.
 *
 *   F1 — The Day-30 monthly tax true-up must actually debit a liquid account.
 *        Before the fix it only recorded a metric and a credit memo, so tax on
 *        all non-payroll income (interest, dividends, distributions) was
 *        booked as withheld but never left any balance.
 *
 * Core invariant asserted by both scenarios:
 *        Δ(asset balances) == Σ(income) − Σ(taxes recorded in the books)
 * i.e. the books and the balances must tell the same story, to the penny.
 *
 * Usage:  node src/tests/payroll-tax-conservation.mjs   (from repo root)
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

// Sum of credit-memo amounts on an asset whose note matches a predicate.
// Annual tax true-ups move cash without touching FinancialPackage fields,
// so conservation checks must pick them up from the memo trail.
const memoSum = (asset, match) =>
  asset.creditMemos.filter(m => m.note && m.note.includes(match))
    .reduce((s, m) => s + m.amount.amount, 0);

async function runPortfolio(assetData) {
  setActiveTaxTable(new TaxTable());
  const modelAssets = assetData.map(obj => ModelAsset.fromJSON(obj));
  const portfolio = new Portfolio(modelAssets, true);
  await chronometer_run(portfolio);
  return portfolio;
}

// ══════════════════════════════════════════════════════════════════════
// Scenario A — F2: pre-tax deferrals reduce the paycheck
//
// $10,000/mo salary, 10% → 401K (pre-tax), 90% → Brokerage. All growth
// rates zero so every dollar of balance change is a cash flow.
// ══════════════════════════════════════════════════════════════════════

console.log('\n── Scenario A: 401K deferral conservation (F2) ─────────\n');

const portfolioA = await runPortfolio([
  {
    instrument: 'workingIncome',
    displayName: 'Salary',
    startDateInt: { year: 2026, month: 1 },
    finishDateInt: { year: 2026, month: 12 },
    startCurrency: { amount: 10000 },
    startBasisCurrency: { amount: 0 },
    annualReturnRate: { rate: 0 },
    fundTransfers: [
      { toDisplayName: '401K', monthlyMoveValue: 10, closeMoveValue: 0 },
      { toDisplayName: 'Brokerage', monthlyMoveValue: 90, closeMoveValue: 0 },
    ],
  },
  {
    instrument: '401K',
    displayName: '401K',
    startDateInt: { year: 2026, month: 1 },
    finishDateInt: { year: 2026, month: 12 },
    startCurrency: { amount: 50000 },
    startBasisCurrency: { amount: 50000 },
    annualReturnRate: { rate: 0 },
  },
  {
    instrument: 'taxableEquity',
    displayName: 'Brokerage',
    startDateInt: { year: 2026, month: 1 },
    finishDateInt: { year: 2026, month: 12 },
    startCurrency: { amount: 30000 },
    startBasisCurrency: { amount: 30000 },
    annualReturnRate: { rate: 0 },
  },
]);

const four01kA   = portfolioA.modelAssets.find(a => a.displayName === '401K');
const brokerageA = portfolioA.modelAssets.find(a => a.displayName === 'Brokerage');
const totalA     = portfolioA.total;

const gross     = totalA.employedIncome.amount;          // positive
const fica      = totalA.fica().amount;                  // negative
const incomeTax = totalA.incomeTax.amount;               // negative
const trueUpA   = memoSum(brokerageA, 'Annual tax true-up')
                + memoSum(four01kA, 'Annual tax true-up');

const deltaA = (four01kA.finishCurrency.amount - 50000)
             + (brokerageA.finishCurrency.amount - 30000);
const expectedA = gross + fica + incomeTax + trueUpA;

check('401K received exactly 12 × $1,000 of contributions', () => {
  assert.ok(Math.abs(four01kA.finishCurrency.amount - 62000) < 0.01,
    `401K ended at ${fmt(four01kA.finishCurrency.amount)}, expected $62,000.00`);
});

check('conservation: Δbalances == gross − FICA − income tax (±$1)', () => {
  assert.ok(Math.abs(deltaA - expectedA) < 1,
    `Δbalances ${fmt(deltaA)} vs net flows ${fmt(expectedA)} — ` +
    `residual ${fmt(deltaA - expectedA)} (pre-fix residual was +$12,000: one phantom contribution per month)`);
});

check('brokerage received net income reduced by the 401K deferral', () => {
  const brokerageDelta = brokerageA.finishCurrency.amount - 30000;
  const expectedNet = gross + fica + incomeTax + trueUpA - 12000;
  assert.ok(Math.abs(brokerageDelta - expectedNet) < 1,
    `Brokerage Δ ${fmt(brokerageDelta)} vs expected net pay ${fmt(expectedNet)}`);
});

// ══════════════════════════════════════════════════════════════════════
// Scenario B — F1: monthly tax true-up collects cash
//
// Lone $1M bank account at 12% APY for 2 years. All tax on the interest
// arrives via the monthly true-up (there is no payroll withholding), so
// before the fix the balance compounded tax-free to the cent.
// ══════════════════════════════════════════════════════════════════════

console.log('\n── Scenario B: interest income tax collection (F1) ─────\n');

const portfolioB = await runPortfolio([
  {
    instrument: 'bank',
    displayName: 'Bank',
    startDateInt: { year: 2026, month: 1 },
    finishDateInt: { year: 2027, month: 12 },
    startCurrency: { amount: 1000000 },
    startBasisCurrency: { amount: 1000000 },
    annualReturnRate: { rate: 0.12 },
  },
]);

const bankB  = portfolioB.modelAssets.find(a => a.displayName === 'Bank');
const totalB = portfolioB.total;

// 1,000,000 × (1 + 0.12/12)^24 — what the balance reaches when no tax is
// ever collected (the pre-fix end balance, to within rounding).
const NO_TAX_COMPOUNDING = 1000000 * Math.pow(1.01, 24);

const deltaB = bankB.finishCurrency.amount - 1000000;
const trueUpB = memoSum(bankB, 'Annual tax true-up');
const expectedB = totalB.interestIncome.amount + totalB.incomeTax.amount + trueUpB;

check('tax on interest income was recorded in the books', () => {
  assert.ok(totalB.incomeTax.amount < -10000,
    `total income tax ${fmt(totalB.incomeTax.amount)}, expected a material negative amount`);
});

check('tax was collected in cash: balance well below tax-free compounding', () => {
  assert.ok(bankB.finishCurrency.amount < NO_TAX_COMPOUNDING - 10000,
    `Bank ended at ${fmt(bankB.finishCurrency.amount)} vs tax-free ${fmt(NO_TAX_COMPOUNDING)} — ` +
    `pre-fix these matched to the cent`);
});

check('conservation: Δbalance == interest − taxes collected (±$1)', () => {
  assert.ok(Math.abs(deltaB - expectedB) < 1,
    `Δbalance ${fmt(deltaB)} vs interest+taxes ${fmt(expectedB)} — residual ${fmt(deltaB - expectedB)}`);
});

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
