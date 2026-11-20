/**
 * overdraft-gain-and-provision.mjs — regression tests for RED-1 and RED-2.
 *
 * ── RED-1 (ModelAsset.planWithdrawal) ────────────────────────────────
 *
 * When a taxable withdrawal exceeds the remaining balance, `fractionSold` is
 * clamped to 1.0 so `basisWithdrawn` equals the remaining basis, but
 * `realizedGain` previously computed the unclamped `fromVested - basisWithdrawn`
 * instead of `Math.min(fromVested, valueAfterCredit) - basisWithdrawn`. That
 * fabricated phantom capital gains equal to the overshoot.
 *
 * ── RED-2 (ExpenseEngine.#applyExpenseTransfersInScope) ──────────────
 *
 * After `settleFromBackstop`, `#bookTaxProvision` previously booked
 * `grossWithdrawal.amount - netShortfall.amount` into `monthly.estimatedTaxes`
 * even when the backstop clamped at $0 and left part or all of the draw
 * unfunded. The annual true-up then treated the uncollected provision as
 * already paid — masking RED-1 in flat 15% LTCG years, and refunding free cash
 * out of thin air when actual tax was lower (e.g., 0% LTCG bracket).
 *
 * Both fixes land together and are verified both individually and in
 * combination below.
 *
 * Run: node tests/overdraft-gain-and-provision.mjs
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
const { Currency } = await import('../js/utils/currency.js');
const { Portfolio } = await import('../js/portfolio.js');
const { chronometer_run } = await import('../js/chronometer.js');
const { EventType } = await import('../js/sim-event.js');

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

function setupSingle({ startAge = 50, retirementAge = 70, finishAge = 51 } = {}) {
  G.global_reset();
  G.global_setAllocateHouseholdTax(false);
  G.global_setUserStartAge(startAge);
  G.global_setUserRetirementAge(retirementAge);
  G.global_setUserFinishAge(finishAge);
  G.global_setFilingAs('Single');
  G.global_setInflationRate(0);
  G.setActiveTaxTable(makeActiveTaxTable());
}

function makeAssets(defs) {
  return defs.map(o => ModelAsset.fromJSON({
    startDateInt: { year: 2026, month: 1 },
    finishDateInt: { year: 2027, month: 12 },
    startBasisCurrency: { amount: 0 },
    annualReturnRate: { rate: 0 },
    ...o,
  }));
}

function eventsOf(asset, type) {
  return (asset.events ?? []).filter(e => e.type === type);
}

console.log('\n── RED-1: Taxable overdraft realizes only actual remaining gain ──\n');

await check('overdraft on appreciated brokerage realizes exact unrealized gain, no overshoot phantom gain', async () => {
  setupSingle();
  // $10,000 balance, $2,000 basis => $8,000 actual unrealized gain.
  // $25,000 single-month expense overdraws by $15,000.
  const assets = makeAssets([
    { instrument: 'taxableEquity', displayName: 'Brokerage', startCurrency: { amount: 10000 }, startBasisCurrency: { amount: 2000 } },
    { instrument: 'monthlyExpense', displayName: 'Living', startCurrency: { amount: 25000 }, finishDateInt: { year: 2026, month: 1 } },
  ]);

  const p = new Portfolio(assets, false, simConfigFromGlobals());
  await chronometer_run(p);

  const brok = p.modelAssets.find(a => a.displayName === 'Brokerage');
  assert.ok(Math.abs(p.total.longTermCapitalGains.amount - 8000) < 0.01,
    `expected $8,000.00 actual gain, got $${p.total.longTermCapitalGains.amount.toFixed(2)}`);
  assert.equal(brok.finishCurrency.amount, 0, 'brokerage should clamp at $0');
});

await check('overdraft on zero-gain brokerage realizes $0 capital gain', async () => {
  setupSingle();
  const assets = makeAssets([
    { instrument: 'taxableEquity', displayName: 'Brokerage', startCurrency: { amount: 10000 }, startBasisCurrency: { amount: 10000 } },
    { instrument: 'monthlyExpense', displayName: 'Living', startCurrency: { amount: 25000 }, finishDateInt: { year: 2026, month: 1 } },
  ]);

  const p = new Portfolio(assets, false, simConfigFromGlobals());
  await chronometer_run(p);

  assert.ok(Math.abs(p.total.longTermCapitalGains.amount) < 0.01,
    `expected $0.00 gain, got $${p.total.longTermCapitalGains.amount.toFixed(2)}`);
});

console.log('\n── RED-2: Unfunded gross-up books only collected tax provision ──\n');

await check('direct backstop (overflow=false): unfunded draw books $0 provision and true-up does not refund phantom tax', async () => {
  setupSingle();
  // Jan salary of $8,000 annualizes to $96,000 (15% LTCG bracket in Jan), so
  // calculateGrossWithdrawal asks for a 15% tax provision on the $8,000 gain
  // ($1,200). Actual annual income is only $8,000 + $8,000 LTCG = $16,000
  // (0% LTCG bracket). Brokerage (~$16,100 after Jan net pay) cannot even cover
  // the $30,000 Living bill, so settled.paid < netShortfall => $0 provision
  // collected. Under RED-2, $1,200 was booked into estimatedTaxes and refunded
  // in cash at the 2027-01 annual true-up.
  const assets = makeAssets([
    { instrument: 'workingIncome', displayName: 'Salary', startCurrency: { amount: 8000 }, finishDateInt: { year: 2026, month: 1 } },
    { instrument: 'taxableEquity', displayName: 'Brokerage', startCurrency: { amount: 10000 }, startBasisCurrency: { amount: 2000 } },
    { instrument: 'monthlyExpense', displayName: 'Living', startCurrency: { amount: 30000 }, finishDateInt: { year: 2026, month: 1 } },
  ]);

  const p = new Portfolio(assets, false, simConfigFromGlobals());
  await chronometer_run(p);

  const brok = p.modelAssets.find(a => a.displayName === 'Brokerage');
  const ty2026 = p.taxYears.find(y => y.year === 2026);
  assert.ok(ty2026, 'expected 2026 tax year to be settled');
  assert.ok(Math.abs(p.total.longTermCapitalGains.amount - 8000) < 0.01,
    `expected $8,000.00 LTCG, got $${p.total.longTermCapitalGains.amount.toFixed(2)}`);
  assert.equal(p.total.estimatedTaxes.amount, 0,
    `expected $0 estimatedTaxes when settled.paid < netShortfall, got $${p.total.estimatedTaxes.amount.toFixed(2)}`);
  assert.equal(eventsOf(brok, EventType.TAX_PROVISION).length, 0,
    'no TAX_PROVISION event should be recorded when nothing beyond netShortfall was collected');

  // Verify true-up refunded ONLY the legitimate paycheck income-tax withholding,
  // not an extra $1,200 phantom LTCG tax provision.
  const actualFederalTax = ty2026.incomeTax + ty2026.capitalGainsTax;
  const legitimateRefund = Math.abs(p.total.incomeTax.amount) - actualFederalTax;
  assert.ok(Math.abs(ty2026.settledTrueUp - legitimateRefund) < 1.0,
    `2026 true-up $${ty2026.settledTrueUp.toFixed(2)} diverged from legitimate withholding refund $${legitimateRefund.toFixed(2)}`);
  assert.ok(Math.abs(brok.finishCurrency.amount - legitimateRefund) < 1.0,
    `Brokerage ended at $${brok.finishCurrency.amount.toFixed(2)}, expected only legitimate refund $${legitimateRefund.toFixed(2)}`);
});

await check('partial-transfer backstop (overflow=true): unfunded draw books $0 provision and exact remaining gain', async () => {
  setupSingle();
  // Roth IRA pays 50% ($15,000) of the $30,000 Living bill; the remaining
  // $15,000 netShortfall hits the Brokerage backstop (overflow: true).
  // Brokerage holds $5,000 vested ($1,000 basis => $4,000 gain) + Jan net pay
  // (~$6,100) = ~$11,100 < $15,000 netShortfall.
  const assets = makeAssets([
    { instrument: 'workingIncome', displayName: 'Salary', startCurrency: { amount: 8000 }, finishDateInt: { year: 2026, month: 1 } },
    { instrument: 'rothIRA', displayName: 'Roth IRA', startCurrency: { amount: 50000 }, startBasisCurrency: { amount: 50000 } },
    { instrument: 'taxableEquity', displayName: 'Brokerage', startCurrency: { amount: 5000 }, startBasisCurrency: { amount: 1000 } },
    {
      instrument: 'monthlyExpense', displayName: 'Living', startCurrency: { amount: 30000 },
      finishDateInt: { year: 2026, month: 1 },
      fundTransfers: [{ toDisplayName: 'Roth IRA', monthlyMoveValue: 50, closeMoveValue: 0 }],
    },
  ]);

  const p = new Portfolio(assets, false, simConfigFromGlobals());
  await chronometer_run(p);

  const brok = p.modelAssets.find(a => a.displayName === 'Brokerage');
  assert.ok(Math.abs(p.total.longTermCapitalGains.amount - 4000) < 0.01,
    `expected $4,000.00 LTCG, got $${p.total.longTermCapitalGains.amount.toFixed(2)}`);
  assert.equal(p.total.estimatedTaxes.amount, 0,
    `expected $0 estimatedTaxes on unfunded overflow draw, got $${p.total.estimatedTaxes.amount.toFixed(2)}`);
  assert.equal(eventsOf(brok, EventType.TAX_PROVISION).length, 0,
    'no TAX_PROVISION event should be recorded on unfunded overflow draw');
});

await check('partially funded provision (netShortfall < settled.paid < grossWithdrawal): books only excess paid above netShortfall', async () => {
  setupSingle();
  // Jan salary $8,000 (net ~$6,100) lands in Brokerage, which starts at $24,500
  // ($4,500 basis => $20,000 unrealized gain). Total available in Jan is
  // ~$30,600. Living bill is $30,000, so calculateGrossWithdrawal asks for
  // ~$33,000 ($3,000 provision), Brokerage clamps at $0 paying ~$30,600,
  // leaving ~$2,400 unfunded. Only ~$600 was actually collected above $30,000.
  const assets = makeAssets([
    { instrument: 'workingIncome', displayName: 'Salary', startCurrency: { amount: 8000 }, finishDateInt: { year: 2026, month: 1 } },
    { instrument: 'taxableEquity', displayName: 'Brokerage', startCurrency: { amount: 24500 }, startBasisCurrency: { amount: 4500 } },
    { instrument: 'monthlyExpense', displayName: 'Living', startCurrency: { amount: 30000 }, finishDateInt: { year: 2026, month: 1 } },
  ]);

  const p = new Portfolio(assets, false, simConfigFromGlobals());
  await chronometer_run(p);

  const brok = p.modelAssets.find(a => a.displayName === 'Brokerage');
  const grossUpEvent = eventsOf(brok, EventType.GROSS_UP)[0];
  const provisionEvents = eventsOf(brok, EventType.TAX_PROVISION);
  assert.ok(grossUpEvent, 'expected a GROSS_UP event on Brokerage');
  assert.equal(provisionEvents.length, 1, 'expected one partial TAX_PROVISION event');

  const actuallyPaid = Math.abs(grossUpEvent.amount.amount);
  const expectedProvision = actuallyPaid - 30000;
  assert.ok(expectedProvision > 100 && expectedProvision < 2500,
    `fixture sanity: expected partial provision between $100 and $2,500, got $${expectedProvision.toFixed(2)}`);
  assert.ok(Math.abs(Math.abs(p.total.estimatedTaxes.amount) - expectedProvision) < 0.01,
    `estimatedTaxes $${Math.abs(p.total.estimatedTaxes.amount).toFixed(2)} should equal settled.paid - netShortfall ($${expectedProvision.toFixed(2)})`);
  assert.ok(Math.abs(Math.abs(provisionEvents[0].amount.amount) - expectedProvision) < 0.01,
    `TAX_PROVISION event should match collected excess ($${expectedProvision.toFixed(2)})`);
  assert.ok(Math.abs(p.total.longTermCapitalGains.amount - 20000) < 0.01,
    `expected exact $20,000.00 unrealized gain, got $${p.total.longTermCapitalGains.amount.toFixed(2)}`);
});

await check('fallback covers the full gross-up: full tax provision is still booked', async () => {
  setupSingle();
  // Brokerage ($5,000, basis $1,000 => $4,000 gain) + Jan net pay (~$6,100)
  // clamps at $0 on a $15,000 Living bill, spilling to US Treasury ($50,000),
  // which covers the rest with $0 unfunded. settled.paid === grossWithdrawal,
  // so the full 15% * $4,000 = $600 tax provision IS collected and booked.
  const assets = makeAssets([
    { instrument: 'workingIncome', displayName: 'Salary', startCurrency: { amount: 8000 }, finishDateInt: { year: 2026, month: 1 } },
    { instrument: 'taxableEquity', displayName: 'Brokerage', startCurrency: { amount: 5000 }, startBasisCurrency: { amount: 1000 } },
    { instrument: 'usBond', displayName: 'Treasuries', startCurrency: { amount: 50000 }, startBasisCurrency: { amount: 50000 } },
    { instrument: 'monthlyExpense', displayName: 'Living', startCurrency: { amount: 15000 }, finishDateInt: { year: 2026, month: 1 } },
  ]);

  const p = new Portfolio(assets, false, simConfigFromGlobals());
  await chronometer_run(p);

  const expectedProvision = 0.15 * 4000; // $600
  assert.ok(Math.abs(p.total.longTermCapitalGains.amount - 4000) < 0.01,
    `expected $4,000.00 LTCG, got $${p.total.longTermCapitalGains.amount.toFixed(2)}`);
  assert.ok(Math.abs(Math.abs(p.total.estimatedTaxes.amount) - expectedProvision) < 0.01,
    `expected full $${expectedProvision.toFixed(2)} provision when fallback paid it, got $${Math.abs(p.total.estimatedTaxes.amount).toFixed(2)}`);
});

console.log('\n── RED-1 + RED-2 together: flat 15% LTCG year (unmasked) ──\n');

await check('flat 15% LTCG year: true-up collects actual $1,200 LTCG tax instead of masking phantom gain against phantom provision', async () => {
  setupSingle();
  // Full-year 2026 $8,000/mo salary ($96,000/yr) keeps the taxpayer solidly in
  // the 15% LTCG bracket all year. In Jan 2026, Brokerage ($10,000, basis
  // $2,000 => $8,000 actual gain) + Jan net pay (~$6,100) clamps at $0 on a
  // $30,000 bill. Feb–Dec 2026 salary refills Brokerage so the 2027-01 annual
  // true-up can collect the unprovisioned LTCG tax.
  //
  // With BOTH fixes:
  //   - LTCG realized = $8,000 (not $8,000 + overshoot)
  //   - LTCG tax owed = 15% * $8,000 = $1,200
  //   - estimatedTaxes booked = $0 (nothing beyond the $30,000 bill was paid)
  //   - 2027-01 annual true-up collects the $1,200 LTCG tax (not ~$0!)
  const assets = makeAssets([
    {
      instrument: 'workingIncome', displayName: 'Salary', startCurrency: { amount: 8000 },
      finishDateInt: { year: 2026, month: 12 },
      fundTransfers: [{ toDisplayName: 'Brokerage', monthlyMoveValue: 100, closeMoveValue: 0 }],
    },
    { instrument: 'taxableEquity', displayName: 'Brokerage', startCurrency: { amount: 10000 }, startBasisCurrency: { amount: 2000 } },
    { instrument: 'monthlyExpense', displayName: 'Living', startCurrency: { amount: 30000 }, finishDateInt: { year: 2026, month: 1 } },
  ]);

  const p = new Portfolio(assets, false, simConfigFromGlobals());
  await chronometer_run(p);

  const ty2026 = p.taxYears.find(y => y.year === 2026);
  assert.ok(ty2026, 'expected 2026 tax year to be settled');
  assert.ok(Math.abs(p.total.longTermCapitalGains.amount - 8000) < 0.01,
    `expected $8,000.00 LTCG, got $${p.total.longTermCapitalGains.amount.toFixed(2)}`);
  assert.ok(Math.abs(ty2026.capitalGainsTax - 1200) < 0.05,
    `expected $1,200.00 LTCG tax in 15% bracket, got $${ty2026.capitalGainsTax.toFixed(2)}`);
  assert.equal(p.total.estimatedTaxes.amount, 0,
    `expected $0 estimatedTaxes, got $${p.total.estimatedTaxes.amount.toFixed(2)}`);

  // Annual true-up must collect the unprovisioned $1,200 LTCG tax (plus any
  // tiny income-tax rounding difference).
  const expectedTrueUp = -(ty2026.incomeTax + ty2026.capitalGainsTax - Math.abs(p.total.incomeTax.amount));
  assert.ok(ty2026.settledTrueUp < -1100,
    `expected 2026 true-up to collect ~$1,200 LTCG tax, got $${ty2026.settledTrueUp.toFixed(2)}`);
  assert.ok(Math.abs(ty2026.settledTrueUp - expectedTrueUp) < 1.0,
    `2026 true-up $${ty2026.settledTrueUp.toFixed(2)} vs expected $${expectedTrueUp.toFixed(2)}`);
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);
process.exit(failed > 0 ? 1 : 0);
