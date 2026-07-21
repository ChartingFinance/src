/**
 * retirement-income-conservation.mjs
 *
 * Guards against retirement income leaking into the WAGE ledger.
 *
 * Bug (found 2026-07-21 end-result audit): RetirementIncomeBehavior and
 * PensionBehavior returned `IncomeResult(zero, income)` — whose second
 * constructor argument is employedIncome — and PayrollEngine fed that to
 * monthly.addResult(), booking every benefit check as WAGES on top of the
 * explicit socialSecurityIncome/pensionIncome add. Every tax computation
 * then saw Social Security at 185% of the benefit (100% wages + 85% SS
 * inclusion) and pensions at 200%.
 *
 * Invariants on a zero-salary, zero-growth scenario:
 *   1. Lifetime employedIncome and selfIncome are exactly $0.
 *   2. Benefits land once: socialSecurityIncome / pensionIncome == 12 × benefit.
 *   3. A benefit fully under the standard deduction generates ZERO income tax
 *      (SS at 85% of $12,000 = $10,200 < $16,100; pension $12,000 < $16,100).
 *   4. The bank account that would fund tax true-ups is untouched.
 *
 * Usage:  node src/tests/retirement-income-conservation.mjs   (from repo root)
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

// ── Scenario builders ─────────────────────────────────────────────────
// One year, no growth anywhere, no salary. The bank is present so tax
// true-ups have a liquid account to collect from — if the engine thinks
// tax is due, the bank balance moves and invariant 4 catches it.

const YEAR = { start: { year: 2026, month: 1 }, finish: { year: 2026, month: 12 } };

function buildAssets(incomeInstrument, incomeName) {
  return [
    {
      instrument: incomeInstrument,
      displayName: incomeName,
      startDateInt: YEAR.start,
      finishDateInt: YEAR.finish,
      startCurrency: { amount: 1000 },
      startBasisCurrency: { amount: 0 },
      annualReturnRate: { rate: 0 },
      fundTransfers: [
        { toDisplayName: 'Brokerage', monthlyMoveValue: 100, closeMoveValue: 0 },
      ],
    },
    {
      instrument: 'bank',
      displayName: 'Savings',
      startDateInt: YEAR.start,
      finishDateInt: YEAR.finish,
      startCurrency: { amount: 50000 },
      startBasisCurrency: { amount: 0 },
      annualReturnRate: { rate: 0 },
    },
    {
      instrument: 'taxableEquity',
      displayName: 'Brokerage',
      startDateInt: YEAR.start,
      finishDateInt: YEAR.finish,
      startCurrency: { amount: 10000 },
      startBasisCurrency: { amount: 10000 },
      annualReturnRate: { rate: 0 },
    },
  ];
}

async function run(incomeInstrument, incomeName) {
  setActiveTaxTable(new TaxTable());
  const modelAssets = buildAssets(incomeInstrument, incomeName).map(o => ModelAsset.fromJSON(o));
  const portfolio = new Portfolio(modelAssets, false);
  await chronometer_run(portfolio);
  return portfolio;
}

// ── Harness ───────────────────────────────────────────────────────────
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
const near = (a, b, eps = 0.005) => Math.abs(a - b) <= eps;

// ── Social Security scenario ─────────────────────────────────────────
console.log('\n── Social Security ($1,000/mo, one year) ───────────────\n');
{
  const p = await run('retirementIncome', 'Social Security');
  const T = p.total;
  const savings = p.modelAssets.find(a => a.displayName === 'Savings');
  const brokerage = p.modelAssets.find(a => a.displayName === 'Brokerage');

  check('employedIncome is $0 (benefits are not wages)', () => {
    assert.ok(near(T.employedIncome.amount, 0),
      `total.employedIncome = ${fmt(T.employedIncome.amount)}, expected $0.00`);
  });
  check('selfIncome is $0', () => {
    assert.ok(near(T.selfIncome.amount, 0),
      `total.selfIncome = ${fmt(T.selfIncome.amount)}, expected $0.00`);
  });
  check('socialSecurityIncome booked exactly once (12 × $1,000)', () => {
    assert.ok(near(T.socialSecurityIncome.amount, 12000),
      `total.socialSecurityIncome = ${fmt(T.socialSecurityIncome.amount)}, expected $12,000.00`);
  });
  check('no income tax: 85% of $12,000 sits under the standard deduction', () => {
    assert.ok(near(T.incomeTax.amount, 0),
      `total.incomeTax = ${fmt(T.incomeTax.amount)}, expected $0.00`);
  });
  check('bank untouched by tax true-ups', () => {
    assert.ok(near(savings.finishCurrency.amount, 50000),
      `Savings ended at ${fmt(savings.finishCurrency.amount)}, expected $50,000.00`);
  });
  check('benefit cash actually arrived in Brokerage ($10,000 + 12 × $1,000)', () => {
    assert.ok(near(brokerage.finishCurrency.amount, 22000),
      `Brokerage ended at ${fmt(brokerage.finishCurrency.amount)}, expected $22,000.00`);
  });
}

// ── Pension scenario ─────────────────────────────────────────────────
console.log('\n── Pension ($1,000/mo, one year) ────────────────────────\n');
{
  const p = await run('pension', 'FERS Pension');
  const T = p.total;
  const savings = p.modelAssets.find(a => a.displayName === 'Savings');

  check('employedIncome is $0 (pension is not wages)', () => {
    assert.ok(near(T.employedIncome.amount, 0),
      `total.employedIncome = ${fmt(T.employedIncome.amount)}, expected $0.00`);
  });
  check('pensionIncome booked exactly once (12 × $1,000)', () => {
    assert.ok(near(T.pensionIncome.amount, 12000),
      `total.pensionIncome = ${fmt(T.pensionIncome.amount)}, expected $12,000.00`);
  });
  check('socialSecurityIncome is $0 in the pension scenario', () => {
    assert.ok(near(T.socialSecurityIncome.amount, 0),
      `total.socialSecurityIncome = ${fmt(T.socialSecurityIncome.amount)}, expected $0.00`);
  });
  check('no income tax: $12,000 pension sits under the standard deduction', () => {
    assert.ok(near(T.incomeTax.amount, 0),
      `total.incomeTax = ${fmt(T.incomeTax.amount)}, expected $0.00`);
  });
  check('bank untouched by tax true-ups', () => {
    assert.ok(near(savings.finishCurrency.amount, 50000),
      `Savings ended at ${fmt(savings.finishCurrency.amount)}, expected $50,000.00`);
  });
}

// ── Summary ───────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
