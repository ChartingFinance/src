/**
 * deposits-and-fica.mjs — regression tests for RED-7 and RED-4.
 *
 * ── RED-7 (FundTransfer.resolveDeposit for deposit targets) ──────────
 *
 * Three deposit destinations previously called `FundTransfer.resolveFunding`
 * (which requires `balance > 0`) instead of `FundTransfer.resolveDeposit`
 * (which accepts any open everyday account, even at $0):
 *   1. Unallocated take-home pay (`payroll-engine.js`)
 *   2. RMD top-up destination (`expense-engine.js`)
 *   3. Positive asset-close / sale proceeds (`portfolio.js`)
 *
 * Closing liabilities (mortgages/debts with negative balances) must still use
 * `resolveFunding` so payoffs draw from an account with funds.
 *
 * ── RED-4 (Mixed SE + W-2 Social Security wage-base tracking) ────────
 *
 * `TaxTable.yearlySocialSecurityByOwner` previously accumulated tax dollars
 * and subtracted them from `maxSSEarnings * rate` without a zero floor. When a
 * household had both Self-Employed (12.4%) and W-2 (6.2%) income, crossing the
 * lower W-2 tax cap made W-2 Social Security tax negative, printing free
 * take-home pay every month.
 *
 * Run: node tests/deposits-and-fica.mjs
 */

import assert from 'node:assert/strict';

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

const G = await import('../js/globals.js');
const { makeActiveTaxTable, simConfigFromGlobals } = G;
const { ModelAsset } = await import('../js/model-asset.js');
const { Portfolio } = await import('../js/portfolio.js');
const { chronometer_run } = await import('../js/chronometer.js');
const { EventType } = await import('../js/sim-event.js');
const { Metric } = await import('../js/metric.js');

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

function setupSingle({ startAge = 50, retirementAge = 70, finishAge = 50 } = {}) {
  G.global_reset();
  G.global_setAllocateHouseholdTax(false);
  G.global_setUserStartAge(startAge);
  G.global_setUserRetirementAge(retirementAge);
  G.global_setUserFinishAge(finishAge);
  G.global_setFilingAs('Single');
  G.global_setInflationRate(0);
  G.setActiveTaxTable(makeActiveTaxTable());
}

function makeAssets(defs, finishYear = 2026) {
  return defs.map(o => ModelAsset.fromJSON({
    startDateInt: { year: 2026, month: 1 },
    finishDateInt: { year: finishYear, month: 12 },
    startBasisCurrency: { amount: 0 },
    annualReturnRate: { rate: 0 },
    ...o,
  }));
}

function eventsOf(asset, type) {
  return (asset.events ?? []).filter(e => e.type === type);
}

console.log('\n── RED-7: Deposits land in open $0 everyday accounts ──\n');

await check('unallocated salary deposits into an open $0 Checking account instead of vanishing', async () => {
  setupSingle({ startAge: 45, retirementAge: 65, finishAge: 45 });
  const assets = makeAssets([
    { instrument: 'workingIncome', displayName: 'Salary', startCurrency: { amount: 8000 } },
    { instrument: 'bank', displayName: 'Checking', startCurrency: { amount: 0 } },
  ]);

  const p = new Portfolio(assets, false, simConfigFromGlobals());
  await chronometer_run(p);

  const salary = p.modelAssets.find(a => a.displayName === 'Salary');
  const checking = p.modelAssets.find(a => a.displayName === 'Checking');
  assert.equal(eventsOf(salary, EventType.UNFUNDED).length, 0, 'no paycheck should be reported unfunded');
  // $96k gross less FICA ($7,344) and income tax withholding (~$12,290) ≈ $76,366
  assert.ok(checking.finishCurrency.amount > 75000,
    `Checking should receive full year of take-home pay, got $${checking.finishCurrency.amount.toFixed(2)}`);
});

await check('RMD top-up deposits into an open $0 Checking account instead of being skipped', async () => {
  setupSingle({ startAge: 75, retirementAge: 65, finishAge: 75 });
  const assets = makeAssets([
    { instrument: 'ira', displayName: 'IRA', startCurrency: { amount: 500000 } },
    { instrument: 'bank', displayName: 'Checking', startCurrency: { amount: 0 } },
  ]);

  const p = new Portfolio(assets, false, simConfigFromGlobals());
  await chronometer_run(p);

  const checking = p.modelAssets.find(a => a.displayName === 'Checking');
  const expectedRMD = 500000 / 24.7; // $20,242.92 at age 75
  assert.ok(p.total.tradIRADistribution.amount >= expectedRMD - 1,
    `expected RMD distribution >= $${expectedRMD.toFixed(2)}, got $${p.total.tradIRADistribution.amount.toFixed(2)}`);
  assert.ok(checking.finishCurrency.amount >= expectedRMD - 1,
    `Checking should receive the RMD deposit, got $${checking.finishCurrency.amount.toFixed(2)}`);
});

await check('positive home sale proceeds deposit into an open $0 Checking account', async () => {
  setupSingle({ startAge: 50, retirementAge: 65, finishAge: 50 });
  const assets = makeAssets([
    {
      instrument: 'realEstate', displayName: 'Home',
      startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 1 },
      startCurrency: { amount: 500000 }, startBasisCurrency: { amount: 500000 },
      annualTaxRate: { rate: 0 },
    },
    { instrument: 'bank', displayName: 'Checking', startCurrency: { amount: 0 } },
  ]);

  const p = new Portfolio(assets, false, simConfigFromGlobals());
  await chronometer_run(p);

  const home = p.modelAssets.find(a => a.displayName === 'Home');
  const checking = p.modelAssets.find(a => a.displayName === 'Checking');
  assert.equal(eventsOf(home, EventType.UNFUNDED).length, 0, 'sale proceeds must not go unfunded');
  assert.ok(Math.abs(checking.finishCurrency.amount - 500000) < 0.01,
    `Checking should receive $500,000 sale proceeds, got $${checking.finishCurrency.amount.toFixed(2)}`);
});

await check('partial close rule sweeps positive remainder into an open $0 Checking account', async () => {
  setupSingle({ startAge: 50, retirementAge: 65, finishAge: 50 });
  const assets = makeAssets([
    {
      instrument: 'realEstate', displayName: 'Home',
      startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 1 },
      startCurrency: { amount: 500000 }, startBasisCurrency: { amount: 500000 },
      annualTaxRate: { rate: 0 },
      fundTransfers: [{ toDisplayName: 'Brokerage', monthlyMoveValue: 0, closeMoveValue: 60 }],
    },
    { instrument: 'bank', displayName: 'Checking', startCurrency: { amount: 0 } },
    { instrument: 'taxableEquity', displayName: 'Brokerage', startCurrency: { amount: 10000 }, startBasisCurrency: { amount: 10000 } },
  ]);

  const p = new Portfolio(assets, false, simConfigFromGlobals());
  await chronometer_run(p);

  const checking = p.modelAssets.find(a => a.displayName === 'Checking');
  const brok = p.modelAssets.find(a => a.displayName === 'Brokerage');
  assert.ok(Math.abs(brok.finishCurrency.amount - 310000) < 0.01,
    `Brokerage should end at $310,000, got $${brok.finishCurrency.amount.toFixed(2)}`);
  assert.ok(Math.abs(checking.finishCurrency.amount - 200000) < 0.01,
    `Checking should receive $200,000 remainder, got $${checking.finishCurrency.amount.toFixed(2)}`);
});

await check('closing mortgage (negative balance) still draws payoff from funded Brokerage, not $0 Checking', async () => {
  setupSingle({ startAge: 50, retirementAge: 65, finishAge: 50 });
  const assets = makeAssets([
    { instrument: 'bank', displayName: 'Checking', startCurrency: { amount: 0 } },
    { instrument: 'taxableEquity', displayName: 'Brokerage', startCurrency: { amount: 200000 }, startBasisCurrency: { amount: 200000 } },
    {
      instrument: 'mortgage', displayName: 'Mortgage',
      startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 1 },
      startCurrency: { amount: -100000 }, annualReturnRate: { rate: 0.06 }, monthsRemaining: 360,
    },
  ]);

  const p = new Portfolio(assets, false, simConfigFromGlobals());
  await chronometer_run(p);

  const checking = p.modelAssets.find(a => a.displayName === 'Checking');
  const brok = p.modelAssets.find(a => a.displayName === 'Brokerage');
  assert.equal(checking.finishCurrency.amount, 0, 'Checking stays at $0');
  assert.ok(brok.finishCurrency.amount < 101000 && brok.finishCurrency.amount > 98000,
    `Brokerage should fund the ~$100k mortgage payoff, ended at $${brok.finishCurrency.amount.toFixed(2)}`);
});

console.log('\n── RED-4: Mixed SE + W-2 FICA never generates negative Social Security tax ──\n');

await check('SE ($15k/mo) + W-2 ($5k/mo): no negative FICA withholding, exact covered-earnings SS cap', async () => {
  setupSingle({ startAge: 45, retirementAge: 65, finishAge: 45 });
  const assets = makeAssets([
    { instrument: 'workingIncome', displayName: 'Consulting', isSelfEmployed: true, startCurrency: { amount: 15000 } },
    { instrument: 'workingIncome', displayName: 'Salary', isSelfEmployed: false, startCurrency: { amount: 5000 } },
    { instrument: 'bank', displayName: 'Checking', startCurrency: { amount: 0 } },
  ]);

  const p = new Portfolio(assets, false, simConfigFromGlobals());
  await chronometer_run(p);

  const se = p.modelAssets.find(a => a.displayName === 'Consulting');
  const w2 = p.modelAssets.find(a => a.displayName === 'Salary');

  for (const a of [se, w2]) {
    for (const ev of eventsOf(a, EventType.FICA_WITHHOLDING)) {
      assert.ok(ev.amount.amount <= 0,
        `${a.displayName} emitted positive FICA withholding ($${ev.amount.amount.toFixed(2)}) in ${ev.dateInt}`);
    }
    for (const v of a.getHistory(Metric.SOCIAL_SECURITY_TAX)) {
      assert.ok(v <= 0.001, `${a.displayName} had positive SS tax metric ($${v.toFixed(2)})`);
    }
  }

  // 9 months × ($15k × 12.4% + $5k × 6.2%) + month 10 remaining $4,500 × 12.4%
  const expectedSE = -(9 * 15000 + 4500) * 0.124; // -$17,298.00
  const expectedW2 = -(9 * 5000) * 0.062;         // -$2,790.00
  const seSum = se.getHistory(Metric.SOCIAL_SECURITY_TAX).reduce((a, b) => a + b, 0);
  const w2Sum = w2.getHistory(Metric.SOCIAL_SECURITY_TAX).reduce((a, b) => a + b, 0);

  assert.ok(Math.abs(seSum - expectedSE) < 0.05,
    `Consulting SS tax expected $${expectedSE.toFixed(2)}, got $${seSum.toFixed(2)}`);
  assert.ok(Math.abs(w2Sum - expectedW2) < 0.05,
    `Salary SS tax expected $${expectedW2.toFixed(2)}, got $${w2Sum.toFixed(2)}`);
  assert.ok(Math.abs(p.total.socialSecurityTax.amount - (expectedSE + expectedW2)) < 0.05,
    `total SS tax expected $${(expectedSE + expectedW2).toFixed(2)}, got $${p.total.socialSecurityTax.amount.toFixed(2)}`);
});

await check('W-2 ($5k/mo) + SE ($15k/mo) reversed order: no negative FICA withholding, exact covered-earnings SS cap', async () => {
  setupSingle({ startAge: 45, retirementAge: 65, finishAge: 45 });
  const assets = makeAssets([
    { instrument: 'workingIncome', displayName: 'Day Job', isSelfEmployed: false, startCurrency: { amount: 5000 } },
    { instrument: 'workingIncome', displayName: 'Side Business', isSelfEmployed: true, startCurrency: { amount: 15000 } },
    { instrument: 'bank', displayName: 'Checking', startCurrency: { amount: 0 } },
  ]);

  const p = new Portfolio(assets, false, simConfigFromGlobals());
  await chronometer_run(p);

  const w2 = p.modelAssets.find(a => a.displayName === 'Day Job');
  const se = p.modelAssets.find(a => a.displayName === 'Side Business');

  // 9 months × ($5k × 6.2% + $15k × 12.4%) + month 10 remaining $4,500 × 6.2%
  const expectedW2 = -(9 * 5000 + 4500) * 0.062; // -$3,069.00
  const expectedSE = -(9 * 15000) * 0.124;       // -$16,740.00
  const w2Sum = w2.getHistory(Metric.SOCIAL_SECURITY_TAX).reduce((a, b) => a + b, 0);
  const seSum = se.getHistory(Metric.SOCIAL_SECURITY_TAX).reduce((a, b) => a + b, 0);

  assert.ok(Math.abs(w2Sum - expectedW2) < 0.05,
    `Day Job SS tax expected $${expectedW2.toFixed(2)}, got $${w2Sum.toFixed(2)}`);
  assert.ok(Math.abs(seSum - expectedSE) < 0.05,
    `Side Business SS tax expected $${expectedSE.toFixed(2)}, got $${seSum.toFixed(2)}`);
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);
process.exit(failed > 0 ? 1 : 0);
