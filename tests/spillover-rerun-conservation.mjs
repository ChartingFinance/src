/**
 * spillover-rerun-conservation.mjs
 *
 * Regression tests for two bugs fixed 2026-06-12:
 *
 *   F6 — Expenses funded from a depleted tax-advantaged account must not
 *        create money. Before the fix, expense withdrawals clamp the funding
 *        IRA at $0 on the credit side, but execute() only handled FROM-side
 *        spillover: the unfunded remainder vanished, the expense was counted
 *        fully paid, and the books recorded the full request as a taxable
 *        IRA distribution.
 *
 *   F7 — Re-running the chronometer on the same Portfolio must simulate the
 *        same world. Before the fix, the user's age was never rewound by
 *        initializeChron (each GA fitness evaluation started where the last
 *        ended), and with metric history disabled (as the GA does) the RMD
 *        prior-December lookup returned NaN → $0, deleting RMDs from every
 *        fitness world.
 *
 * Usage:  node src/tests/spillover-rerun-conservation.mjs   (from repo root)
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
import { setActiveTaxTable, global_user_startAge, global_setUserStartAge, global_getUserStartAge } from '../js/globals.js';

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

const memoSum = (asset, match) =>
  asset.creditMemos.filter(m => m.note && m.note.includes(match))
    .reduce((s, m) => s + m.amount.amount, 0);

function buildPortfolio(assetData) {
  setActiveTaxTable(new TaxTable());
  const modelAssets = assetData.map(obj => ModelAsset.fromJSON(obj));
  return new Portfolio(modelAssets, true);
}

const YEAR = { startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 12 } };

// ══════════════════════════════════════════════════════════════════════
// Scenario F — F6: expense funded from a near-empty IRA
//
// $5,000/mo expense funded 100% from an IRA holding only $1,000. The IRA
// covers $1,000 in month 1 and clamps; everything else must be sourced from
// the brokerage (50% unrealized gain ratio) via spillover. Zero growth, so
// every balance change is a cash flow.
// ══════════════════════════════════════════════════════════════════════

console.log('\n── Scenario F: depleted-IRA expense spillover (F6) ─────\n');

const portfolioF = buildPortfolio([
  {
    instrument: 'ira', displayName: 'IRA', ...YEAR,
    startCurrency: { amount: 1000 }, startBasisCurrency: { amount: 0 },
    annualReturnRate: { rate: 0 },
  },
  {
    instrument: 'taxableEquity', displayName: 'Brokerage', ...YEAR,
    startCurrency: { amount: 100000 }, startBasisCurrency: { amount: 50000 },
    annualReturnRate: { rate: 0 },
  },
  {
    // Negative start: expense balances are normalized to negative by their
    // first applyMonthly, which runs AFTER day-30 transfers — a positive
    // start makes month 1's transfer flow backwards (deposit into the
    // funding account). Pre-existing quirk, sidestepped here.
    instrument: 'monthlyExpense', displayName: 'Living Expenses', ...YEAR,
    startCurrency: { amount: -5000 }, startBasisCurrency: { amount: 0 },
    annualReturnRate: { rate: 0 },
    fundTransfers: [
      { toDisplayName: 'IRA', monthlyMoveValue: 100, closeMoveValue: 0 },
    ],
  },
]);
await chronometer_run(portfolioF);

const iraF       = portfolioF.modelAssets.find(a => a.displayName === 'IRA');
const brokerageF = portfolioF.modelAssets.find(a => a.displayName === 'Brokerage');
const totalF     = portfolioF.total;

check('IRA clamped at $0, never negative', () => {
  assert.ok(Math.abs(iraF.finishCurrency.amount) < 0.01,
    `IRA ended at ${fmt(iraF.finishCurrency.amount)}, expected $0.00`);
});

check('conservation: cash leaving accounts == expense recorded (±$1)', () => {
  const delta = (iraF.finishCurrency.amount - 1000) + (brokerageF.finishCurrency.amount - 100000);
  const expected = totalF.expense.amount + totalF.incomeTax.amount
                 + memoSum(brokerageF, 'Annual tax true-up');
  assert.ok(Math.abs(delta - expected) < 1,
    `Δbalances ${fmt(delta)} vs expense+taxes ${fmt(expected)} — residual ${fmt(delta - expected)} ` +
    `(pre-fix residual was ~$59,000: expenses paid with money that never existed)`);
});

check('books: IRA distribution == the $1,000 the IRA actually held', () => {
  assert.ok(Math.abs(totalF.tradIRADistribution.amount - 1000) < 0.01,
    `FP tradIRADistribution ${fmt(totalF.tradIRADistribution.amount)}, expected $1,000.00 — ` +
    `pre-fix the full $60,000 of requests was booked as IRA income`);
});

check('spillover gains booked: FP LTCG == 50% of brokerage sales', () => {
  // Every brokerage debit (spillover AND tax payments) sells shares at the
  // constant 50% gain ratio. Total debits = start − end + refunds-credited.
  const refunds = memoSum(brokerageF, 'Annual tax true-up');
  const totalDebits = 100000 - brokerageF.finishCurrency.amount + refunds;
  assert.ok(Math.abs(totalF.longTermCapitalGains.amount - totalDebits * 0.5) < 1,
    `FP LTCG ${fmt(totalF.longTermCapitalGains.amount)} vs expected ${fmt(totalDebits * 0.5)} — ` +
    `pre-fix spillover never touched the brokerage, so this was ~$0`);
});

// ══════════════════════════════════════════════════════════════════════
// Scenario G — F7a: the chronometer is idempotent on the same Portfolio
//
// Run the identical 5-year simulation twice on ONE Portfolio object (the GA
// optimizer does this thousands of times). Same inputs must give the same
// ending age and the same ending balances, to the penny.
// ══════════════════════════════════════════════════════════════════════

console.log('\n── Scenario G: re-run isolation (F7) ───────────────────\n');

const SPAN5 = { startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2030, month: 12 } };
const portfolioG = buildPortfolio([
  {
    instrument: 'workingIncome', displayName: 'Salary', ...SPAN5,
    startCurrency: { amount: 10000 }, startBasisCurrency: { amount: 0 },
    annualReturnRate: { rate: 0.025 },
    fundTransfers: [
      { toDisplayName: '401K', monthlyMoveValue: 10, closeMoveValue: 0 },
      { toDisplayName: 'Brokerage', monthlyMoveValue: 90, closeMoveValue: 0 },
    ],
  },
  {
    instrument: '401K', displayName: '401K', ...SPAN5,
    startCurrency: { amount: 50000 }, startBasisCurrency: { amount: 50000 },
    annualReturnRate: { rate: 0.07 },
  },
  {
    instrument: 'taxableEquity', displayName: 'Brokerage', ...SPAN5,
    startCurrency: { amount: 30000 }, startBasisCurrency: { amount: 30000 },
    annualReturnRate: { rate: 0.07 },
  },
]);

await chronometer_run(portfolioG);
const ageAfterRun1 = portfolioG.activeUser.age;
const balancesRun1 = portfolioG.modelAssets.map(a => a.finishCurrency.amount);

await chronometer_run(portfolioG);
const ageAfterRun2 = portfolioG.activeUser.age;
const balancesRun2 = portfolioG.modelAssets.map(a => a.finishCurrency.amount);

check('user age is rewound between runs (same ending age both runs)', () => {
  assert.equal(ageAfterRun2, ageAfterRun1,
    `Run 1 ended at age ${ageAfterRun1}, run 2 at age ${ageAfterRun2} — ` +
    `pre-fix every re-run started where the previous one ended`);
});

check('identical inputs give identical balances on re-run (to the penny)', () => {
  for (let i = 0; i < balancesRun1.length; i++) {
    assert.ok(Math.abs(balancesRun1[i] - balancesRun2[i]) < 0.01,
      `${portfolioG.modelAssets[i].displayName}: run 1 ${fmt(balancesRun1[i])} vs run 2 ${fmt(balancesRun2[i])}`);
  }
});

// ══════════════════════════════════════════════════════════════════════
// Scenario H — F7b: RMDs survive history-less runs
//
// 75-year-old with a $600k IRA, metric history disabled exactly the way the
// GA optimizer disables it. RMDs must still be computed (from the live
// balance) and must reconcile: books == balances.
// ══════════════════════════════════════════════════════════════════════

console.log('\n── Scenario H: RMDs with metric history off (F7) ───────\n');

const savedStartAge = global_user_startAge;
// Globals pattern: the setter writes localStorage only; the getter refreshes
// the mutable export. Both calls are required for the new value to apply.
global_setUserStartAge(75);
global_getUserStartAge();

const portfolioH = buildPortfolio([
  {
    instrument: 'ira', displayName: 'IRA', ...YEAR,
    startCurrency: { amount: 600000 }, startBasisCurrency: { amount: 0 },
    annualReturnRate: { rate: 0 },
  },
  {
    instrument: 'taxableEquity', displayName: 'Brokerage', ...YEAR,
    startCurrency: { amount: 100000 }, startBasisCurrency: { amount: 100000 },
    annualReturnRate: { rate: 0 },
  },
]);
// Disable history exactly like Simulator._setTrackHistory does for fitness runs
portfolioH.modelAssets.forEach(a => a.setTrackHistory(false));
await chronometer_run(portfolioH);

global_setUserStartAge(savedStartAge);
global_getUserStartAge();

const iraH       = portfolioH.modelAssets.find(a => a.displayName === 'IRA');
const brokerageH = portfolioH.modelAssets.find(a => a.displayName === 'Brokerage');
const totalH     = portfolioH.total;

check('metric history really is off (the GA condition is reproduced)', () => {
  assert.equal(iraH.monthlyValues.length, 0,
    `IRA VALUE history has ${iraH.monthlyValues.length} entries, expected 0`);
});

check('RMDs still happen without history (live-balance fallback)', () => {
  assert.ok(totalH.tradIRADistribution.amount > 10000,
    `FP tradIRADistribution ${fmt(totalH.tradIRADistribution.amount)}, expected ~$24k of RMDs — ` +
    `pre-fix the prior-December lookup returned NaN → $0 and the fitness world had no RMDs`);
});

check('books match balances: IRA outflow == booked distributions (±$1)', () => {
  const iraOutflow = 600000 - iraH.finishCurrency.amount;
  assert.ok(Math.abs(iraOutflow - totalH.tradIRADistribution.amount) < 1,
    `IRA outflow ${fmt(iraOutflow)} vs booked ${fmt(totalH.tradIRADistribution.amount)}`);
});

check('conservation: Δ(IRA + Brokerage) == taxes collected (±$1)', () => {
  const delta = (iraH.finishCurrency.amount - 600000) + (brokerageH.finishCurrency.amount - 100000);
  const expected = totalH.incomeTax.amount + memoSum(brokerageH, 'Annual tax true-up');
  assert.ok(Math.abs(delta - expected) < 1,
    `Δbalances ${fmt(delta)} vs taxes ${fmt(expected)} — residual ${fmt(delta - expected)}`);
});

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
