/**
 * rmd-satisfaction-conservation.mjs
 *
 * Guards the IRS rule that ANY distribution from a tax-deferred account
 * counts toward its Required Minimum Distribution.
 *
 * Bug (found 2026-07-21 end-result audit): expense-, escrow- and
 * carrying-cost-funded withdrawals from IRA/401K accounts were booked only
 * on the household FinancialPackage (recordTransfer); nothing wrote the
 * asset-level TRAD_IRA_DISTRIBUTION / FOUR_01K_DISTRIBUTION metric that
 * ExpenseEngine.ensureRMDs reads. The check therefore saw $0 distributed
 * every month and forced the FULL RMD on top of withdrawals that already
 * satisfied it — $736k of excess forced distributions over one audited
 * 30-year plan.
 *
 * Invariants (zero growth, zero inflation, one year, RMD age):
 *   1. When monthly draws exceed the RMD, ZERO top-ups fire: the IRA loses
 *      exactly the draws, and the bank receives nothing.
 *   2. When draws fall short, the top-up is exactly (RMD − draws), month by
 *      month, mirroring the engine's documented year-one RMD base (live
 *      balance in January, the January snapshot thereafter).
 *   3. Double entry holds: household FP distributions === the asset's own
 *      distribution-metric total, in every scenario.
 *
 * Usage:  node src/tests/rmd-satisfaction-conservation.mjs   (from repo root)
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
import {
  setActiveTaxTable,
  global_setUserStartAge, global_getUserStartAge,
  global_setInflationRate, global_getInflationRate,
  global_setFilingAs, global_getFilingAs,
} from '../js/globals.js';

// Age 76 in 2026 → birth year 1950 → RMD age 72 → RMDs required.
// Uniform lifetime divisor at 76: 23.8. IRA $238,000 → RMD $10,000/yr,
// $833.33 in January (live-balance base), then the January snapshot base.
global_setUserStartAge(76); global_getUserStartAge();
global_setInflationRate(0); global_getInflationRate();
global_setFilingAs('Single'); global_getFilingAs();

const YEAR = { start: { year: 2026, month: 1 }, finish: { year: 2026, month: 12 } };
const DIVISOR_76 = 23.8;

function buildAssets(deferredInstrument, monthlyExpense) {
  return [
    {
      instrument: deferredInstrument,
      displayName: 'Deferred',
      startDateInt: YEAR.start,
      finishDateInt: YEAR.finish,
      startCurrency: { amount: 238000 },
      startBasisCurrency: { amount: 0 },
      annualReturnRate: { rate: 0 },
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
      instrument: 'monthlyExpense',
      displayName: 'Living Expenses',
      startDateInt: YEAR.start,
      finishDateInt: YEAR.finish,
      startCurrency: { amount: -monthlyExpense },
      startBasisCurrency: { amount: 0 },
      annualReturnRate: { rate: 0 },
      fundTransfers: [
        { toDisplayName: 'Deferred', monthlyMoveValue: 100, closeMoveValue: 0 },
      ],
    },
  ];
}

async function run(deferredInstrument, monthlyExpense) {
  setActiveTaxTable(new TaxTable());
  const modelAssets = buildAssets(deferredInstrument, monthlyExpense).map(o => ModelAsset.fromJSON(o));
  const portfolio = new Portfolio(modelAssets, false);
  await chronometer_run(portfolio);
  return portfolio;
}

const sum = (arr) => (arr ?? []).reduce((s, v) => s + (v ?? 0), 0);
const distMetric = (asset) =>
  sum(asset.getHistory(Metric.TRAD_IRA_DISTRIBUTION)) + sum(asset.getHistory(Metric.FOUR_01K_DISTRIBUTION));

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
const near = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;

// ── Scenario 1: IRA, draws ($1,000/mo) EXCEED the RMD (~$833/mo) ─────
console.log('\n── IRA: expense draws already satisfy the RMD ───────────\n');
{
  const p = await run('ira', 1000);
  const ira = p.modelAssets.find(a => a.displayName === 'Deferred');
  const savings = p.modelAssets.find(a => a.displayName === 'Savings');

  check('IRA loses exactly the 12 × $1,000 expense draws — no forced top-ups', () => {
    assert.ok(near(ira.finishCurrency.amount, 226000),
      `IRA ended at ${fmt(ira.finishCurrency.amount)}, expected $226,000.00`);
  });
  check('bank receives no RMD deposits and pays no tax', () => {
    assert.ok(near(savings.finishCurrency.amount, 50000),
      `Savings ended at ${fmt(savings.finishCurrency.amount)}, expected $50,000.00`);
  });
  check('household books show exactly $12,000 of distributions', () => {
    assert.ok(near(p.total.tradIRADistribution.amount, 12000),
      `total.tradIRADistribution = ${fmt(p.total.tradIRADistribution.amount)}, expected $12,000.00`);
  });
  check('double entry: asset distribution metric equals household books', () => {
    assert.ok(near(distMetric(ira), p.total.tradIRADistribution.amount),
      `asset metric ${fmt(distMetric(ira))} !== FP ${fmt(p.total.tradIRADistribution.amount)}`);
  });
}

// ── Scenario 2: IRA, draws ($500/mo) FALL SHORT — top-up = RMD − draws ─
console.log('\n── IRA: draws fall short, top-up is exactly the gap ─────\n');
{
  const p = await run('ira', 500);
  const ira = p.modelAssets.find(a => a.displayName === 'Deferred');
  const savings = p.modelAssets.find(a => a.displayName === 'Savings');

  // Replica of the engine's year-one RMD base: January divides the live
  // balance; later months divide the January month-end snapshot.
  const draws = 500;
  let balance = 238000;
  let expectedTopUps = 0;
  let janSnapshot = null;
  for (let m = 1; m <= 12; m++) {
    const base = m === 1 ? balance : janSnapshot;
    const rmd = base / DIVISOR_76 / 12;
    const topUp = Math.max(0, rmd - draws);
    expectedTopUps += topUp;
    balance -= draws + topUp;
    if (m === 1) janSnapshot = balance;
  }

  check('IRA drop equals draws + computed top-ups', () => {
    const expected = 238000 - 12 * draws - expectedTopUps;
    assert.ok(near(ira.finishCurrency.amount, expected, 0.10),
      `IRA ended at ${fmt(ira.finishCurrency.amount)}, expected ${fmt(expected)}`);
  });
  check('bank receives exactly the top-ups (income under deduction, no tax)', () => {
    assert.ok(near(savings.finishCurrency.amount, 50000 + expectedTopUps, 0.10),
      `Savings ended at ${fmt(savings.finishCurrency.amount)}, expected ${fmt(50000 + expectedTopUps)}`);
  });
  check('household books equal draws + top-ups', () => {
    assert.ok(near(p.total.tradIRADistribution.amount, 12 * draws + expectedTopUps, 0.10),
      `total.tradIRADistribution = ${fmt(p.total.tradIRADistribution.amount)}, expected ${fmt(12 * draws + expectedTopUps)}`);
  });
  check('double entry: asset distribution metric equals household books', () => {
    assert.ok(near(distMetric(ira), p.total.tradIRADistribution.amount, 0.10),
      `asset metric ${fmt(distMetric(ira))} !== FP ${fmt(p.total.tradIRADistribution.amount)}`);
  });
}

// ── Scenario 3: 401K path gets the same credit ────────────────────────
console.log('\n── 401K: expense draws already satisfy the RMD ──────────\n');
{
  const p = await run('401K', 1000);
  const k = p.modelAssets.find(a => a.displayName === 'Deferred');

  check('401K loses exactly the draws — no forced top-ups', () => {
    assert.ok(near(k.finishCurrency.amount, 226000),
      `401K ended at ${fmt(k.finishCurrency.amount)}, expected $226,000.00`);
  });
  check('double entry: 401K distribution metric equals household books', () => {
    assert.ok(near(distMetric(k), p.total.four01KDistribution.amount),
      `asset metric ${fmt(distMetric(k))} !== FP ${fmt(p.total.four01KDistribution.amount)}`);
  });
}

// ── Summary ───────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
