/**
 * transfers-and-portfolio-leaks.mjs — regression tests for RED-5 and RED-6.
 *
 * ── RED-5 (FundTransfer.execute + ExpenseEngine) ─────────────────────
 *
 * When a paired transfer clamps at $0 and no fallback backstop exists (or the
 * fallback also clamps), FundTransferResult previously left `spillover = 0`
 * with no `supplied` / `unfunded` field. ExpenseEngine then subtracted
 * `result.spillover` ($0) from the full requested withdrawal and booked
 * phantom taxable IRA/401(k) distributions every month on a $0 account.
 *
 * ── RED-6 (Portfolio open, one-time, and close paths) ────────────────
 *
 * 1. `applyAssetOpenFundTransfer` called raw `source.debit()`, dropping
 *    `realizedGain` and `spillover`, and emitted a one-sided `TRANSFER` that
 *    broke transfer conservation.
 * 2. Negative `oneTimeEvents` called raw `modelAsset.debit()`, dropping
 *    `realizedGain`, retirement distributions, and `spillover`.
 * 3. `applyAssetCloseFundTransfers` discarded `execute()` results (dropping
 *    capital gains realized when paying off a closing mortgage from a
 *    brokerage) and recalculated close percentages sequentially against the
 *    shrinking `finishCurrency` (turning a 50%/50% split into 75%/25%).
 *
 * Run: node tests/transfers-and-portfolio-leaks.mjs
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
const { Metric } = await import('../js/metric.js');
const { FundTransfer } = await import('../js/fund-transfer.js');
const { moneyFlows, monthWindow } = await import('../js/money-flows.js');
const { logger, LogCategory } = await import('../js/utils/logger.js');

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

function setupSingle({ startAge = 65, retirementAge = 65, finishAge = 66 } = {}) {
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

/** Run a portfolio while capturing any SANITY conservation/reconciliation findings. */
async function runCapturingSanity(assets) {
  const sanityIssues = [];
  const origLog = logger.log.bind(logger);
  logger.log = (category, msgOrFn) => {
    if (category === LogCategory.SANITY) {
      const text = typeof msgOrFn === 'function' ? msgOrFn() : String(msgOrFn);
      if (/conservation|mismatch|reconcil/i.test(text)) sanityIssues.push(text);
    }
    return origLog(category, msgOrFn);
  };
  try {
    const p = new Portfolio(assets, false, simConfigFromGlobals());
    await chronometer_run(p);
    return { p, sanityIssues };
  } finally {
    logger.log = origLog;
  }
}

console.log('\n── RED-5: Clamped transfers book only what each account supplied ──\n');

await check('clamped IRA expense transfer with no backstop books exact $2,000 distribution, not $60k phantom', async () => {
  setupSingle({ startAge: 65, retirementAge: 65, finishAge: 66 });
  const assets = makeAssets([
    { instrument: 'ira', displayName: 'IRA', startCurrency: { amount: 2000 } },
    {
      instrument: 'monthlyExpense', displayName: 'Rent', startCurrency: { amount: 5000 },
      finishDateInt: { year: 2026, month: 12 },
      fundTransfers: [{ toDisplayName: 'IRA', monthlyMoveValue: 100, closeMoveValue: 0 }],
    },
  ]);

  const { p, sanityIssues } = await runCapturingSanity(assets);
  const ira = p.modelAssets.find(a => a.displayName === 'IRA');
  const ty2026 = p.taxYears.find(y => y.year === 2026);
  const histSum = ira.getHistory(Metric.TRAD_IRA_DISTRIBUTION).reduce((a, b) => a + b, 0);

  assert.equal(sanityIssues.length, 0, `unexpected sanity issues: ${sanityIssues.join('; ')}`);
  assert.ok(Math.abs(p.total.tradIRADistribution.amount - 2000) < 0.01,
    `expected $2,000.00 tradIRADistribution, got $${p.total.tradIRADistribution.amount.toFixed(2)}`);
  assert.ok(Math.abs(histSum - 2000) < 0.01,
    `expected $2,000.00 IRA metric history sum, got $${histSum.toFixed(2)}`);
  assert.ok(Math.abs(ty2026.agi - 2000) < 0.01,
    `expected $2,000.00 2026 AGI, got $${ty2026.agi.toFixed(2)}`);
  assert.equal(ty2026.incomeTax, 0,
    `expected $0.00 2026 income tax on $2,000 AGI, got $${ty2026.incomeTax.toFixed(2)}`);
});

await check('clamped IRA expense transfer with partial Checking fallback books exact $2,000 IRA distribution', async () => {
  setupSingle({ startAge: 65, retirementAge: 65, finishAge: 66 });
  const assets = makeAssets([
    { instrument: 'ira', displayName: 'IRA', startCurrency: { amount: 2000 } },
    { instrument: 'bank', displayName: 'Checking', startCurrency: { amount: 1500 } },
    {
      instrument: 'monthlyExpense', displayName: 'Rent', startCurrency: { amount: 5000 },
      finishDateInt: { year: 2026, month: 12 },
      fundTransfers: [{ toDisplayName: 'IRA', monthlyMoveValue: 100, closeMoveValue: 0 }],
    },
  ]);

  const { p, sanityIssues } = await runCapturingSanity(assets);
  const checking = p.modelAssets.find(a => a.displayName === 'Checking');

  assert.equal(sanityIssues.length, 0, `unexpected sanity issues: ${sanityIssues.join('; ')}`);
  assert.ok(Math.abs(p.total.tradIRADistribution.amount - 2000) < 0.01,
    `expected $2,000.00 tradIRADistribution, got $${p.total.tradIRADistribution.amount.toFixed(2)}`);
  assert.equal(checking.finishCurrency.amount, 0, 'Checking fallback should be drained to $0');
});

await check('FundTransfer.execute() reports supplied + spillover + unfunded === |requested|', () => {
  const ira = ModelAsset.fromJSON({
    instrument: 'ira', displayName: 'IRA',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 12 },
    startCurrency: { amount: 2000 }, startBasisCurrency: { amount: 0 }, annualReturnRate: { rate: 0 },
  });
  const dest = ModelAsset.fromJSON({
    instrument: 'rothIRA', displayName: 'Roth IRA',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 12 },
    startCurrency: { amount: 0 }, startBasisCurrency: { amount: 0 }, annualReturnRate: { rate: 0 },
  });
  ira.initializeChron(); ira.finishCurrency = new Currency(2000);
  dest.initializeChron(); dest.finishCurrency = new Currency(0);

  const res = FundTransfer.system(ira, dest, new Currency(5000), [ira, dest]).execute();
  assert.equal(res.supplied.amount, 2000);
  assert.equal(res.spillover.amount, 0);
  assert.equal(res.unfunded.amount, 3000);
});

console.log('\n── RED-6a: Funded asset opens settle gains, spillovers, and conservation ──\n');

await check('funded home purchase from insufficient brokerage books $80k LTCG, reports $100k unfunded, and passes conservation', async () => {
  setupSingle({ startAge: 45, retirementAge: 65, finishAge: 46 });
  // $100k brokerage ($20k basis => $80k gain) funding $200k 100%-down home.
  const assets = makeAssets([
    { instrument: 'taxableEquity', displayName: 'Brokerage', startCurrency: { amount: 100000 }, startBasisCurrency: { amount: 20000 } },
    {
      instrument: 'realEstate', displayName: 'Home', startCurrency: { amount: 200000 }, startBasisCurrency: { amount: 200000 },
      startDateInt: { year: 2026, month: 3 },
      annualTaxRate: { rate: 0 },
      fundingConfig: { purchaseType: 'cash', sourceDisplayName: 'Brokerage', downPaymentPercent: 100 },
    },
  ]);

  const { p, sanityIssues } = await runCapturingSanity(assets);
  const brok = p.modelAssets.find(a => a.displayName === 'Brokerage');
  const home = p.modelAssets.find(a => a.displayName === 'Home');
  const fundingUnfunded = eventsOf(home, EventType.UNFUNDED)
    .filter(e => e.data?.cause === 'Brokerage → Home (funding)');

  assert.equal(sanityIssues.length, 0, `unexpected sanity issues: ${sanityIssues.join('; ')}`);
  assert.equal(brok.finishCurrency.amount, 0, 'Brokerage should clamp at $0');
  assert.ok(Math.abs(p.total.longTermCapitalGains.amount - 80000) < 0.01,
    `expected $80,000.00 LTCG on home funding draw, got $${p.total.longTermCapitalGains.amount.toFixed(2)}`);
  assert.equal(fundingUnfunded.length, 1, 'expected an UNFUNDED event on Home for the $100k purchase shortfall');
  assert.ok(Math.abs(Math.abs(fundingUnfunded[0].amount.amount) - 100000) < 0.01,
    `expected $100,000.00 unfunded, got $${Math.abs(fundingUnfunded[0].amount.amount).toFixed(2)}`);
});

await check('funded home purchase spills shortfall to Savings fallback and books Brokerage LTCG', async () => {
  setupSingle({ startAge: 45, retirementAge: 65, finishAge: 46 });
  const assets = makeAssets([
    { instrument: 'taxableEquity', displayName: 'Brokerage', startCurrency: { amount: 100000 }, startBasisCurrency: { amount: 20000 } },
    { instrument: 'bank', displayName: 'Savings', startCurrency: { amount: 150000 } },
    {
      instrument: 'realEstate', displayName: 'Home', startCurrency: { amount: 200000 }, startBasisCurrency: { amount: 200000 },
      startDateInt: { year: 2026, month: 3 },
      annualTaxRate: { rate: 0 },
      fundingConfig: { purchaseType: 'cash', sourceDisplayName: 'Brokerage', downPaymentPercent: 100 },
    },
  ]);

  const { p, sanityIssues } = await runCapturingSanity(assets);
  const brok = p.modelAssets.find(a => a.displayName === 'Brokerage');
  const savings = p.modelAssets.find(a => a.displayName === 'Savings');
  const home = p.modelAssets.find(a => a.displayName === 'Home');

  assert.equal(sanityIssues.length, 0, `unexpected sanity issues: ${sanityIssues.join('; ')}`);
  assert.equal(brok.finishCurrency.amount, 0);
  assert.ok(Math.abs(p.total.longTermCapitalGains.amount - 80000) < 0.01,
    `expected $80,000.00 LTCG, got $${p.total.longTermCapitalGains.amount.toFixed(2)}`);
  assert.equal(eventsOf(home, EventType.UNFUNDED).length, 0, 'no shortfall should be unfunded when Savings covers it');
  // Savings paid $100k spillover plus 2026 LTCG true-up tax in Jan 2027.
  assert.ok(savings.finishCurrency.amount <= 50000 + 0.01,
    `Savings should be reduced by at least $100k spillover, ended at $${savings.finishCurrency.amount.toFixed(2)}`);
});

console.log('\n── RED-6b: Negative one-time events settle gains, distributions, and spillovers ──\n');

await check('negative one-time debit on appreciated brokerage books realized LTCG', async () => {
  setupSingle({ startAge: 45, retirementAge: 65, finishAge: 46 });
  const assets = makeAssets([
    {
      instrument: 'taxableEquity', displayName: 'Brokerage',
      startCurrency: { amount: 100000 }, startBasisCurrency: { amount: 20000 },
      oneTimeEvents: [{ dateInt: { year: 2026, month: 4 }, amount: { amount: -50000 }, note: 'Boat' }],
    },
  ]);

  const { p, sanityIssues } = await runCapturingSanity(assets);
  const brok = p.modelAssets.find(a => a.displayName === 'Brokerage');

  assert.equal(sanityIssues.length, 0, `unexpected sanity issues: ${sanityIssues.join('; ')}`);
  assert.ok(Math.abs(p.total.longTermCapitalGains.amount - 40000) < 0.01,
    `expected $40,000.00 LTCG on -$50k one-time debit, got $${p.total.longTermCapitalGains.amount.toFixed(2)}`);
  assert.ok(Math.abs(brok.finishCurrency.amount - 50000) < 0.01,
    `Brokerage should end at $50,000 (0% LTCG bracket), got $${brok.finishCurrency.amount.toFixed(2)}`);
});

await check('negative one-time debit on Traditional IRA books taxable distribution', async () => {
  setupSingle({ startAge: 65, retirementAge: 65, finishAge: 66 });
  const assets = makeAssets([
    {
      instrument: 'ira', displayName: 'IRA', startCurrency: { amount: 50000 },
      oneTimeEvents: [{ dateInt: { year: 2026, month: 4 }, amount: { amount: -10000 }, note: 'Medical' }],
    },
  ]);

  const { p, sanityIssues } = await runCapturingSanity(assets);
  const ira = p.modelAssets.find(a => a.displayName === 'IRA');
  const histSum = ira.getHistory(Metric.TRAD_IRA_DISTRIBUTION).reduce((a, b) => a + b, 0);

  assert.equal(sanityIssues.length, 0, `unexpected sanity issues: ${sanityIssues.join('; ')}`);
  // Note: withholdOnDeferredDistributions grosses up on top of the $10k distribution
  // at 10% (total distribution >= $10,000), proving the distribution was booked!
  assert.ok(p.total.tradIRADistribution.amount >= 10000 - 0.01,
    `expected tradIRADistribution >= $10,000, got $${p.total.tradIRADistribution.amount.toFixed(2)}`);
  assert.ok(histSum >= 10000 - 0.01,
    `expected IRA distribution metric >= $10,000, got $${histSum.toFixed(2)}`);
});

await check('negative one-time debit on short Checking spills to Brokerage, books LTCG, and flows cleanly', async () => {
  setupSingle({ startAge: 45, retirementAge: 65, finishAge: 46 });
  const assets = makeAssets([
    {
      instrument: 'bank', displayName: 'Checking', startCurrency: { amount: 10000 },
      oneTimeEvents: [{ dateInt: { year: 2026, month: 4 }, amount: { amount: -30000 }, note: 'Roof' }],
    },
    { instrument: 'taxableEquity', displayName: 'Brokerage', startCurrency: { amount: 100000 }, startBasisCurrency: { amount: 20000 } },
  ]);

  const { p, sanityIssues } = await runCapturingSanity(assets);
  const checking = p.modelAssets.find(a => a.displayName === 'Checking');
  const brok = p.modelAssets.find(a => a.displayName === 'Brokerage');

  assert.equal(sanityIssues.length, 0, `unexpected sanity issues: ${sanityIssues.join('; ')}`);
  assert.equal(checking.finishCurrency.amount, 0);
  assert.ok(Math.abs(brok.finishCurrency.amount - 80000) < 0.01,
    `Brokerage should pay $20k spillover (ending at $80k), got $${brok.finishCurrency.amount.toFixed(2)}`);
  assert.ok(Math.abs(p.total.longTermCapitalGains.amount - 16000) < 0.01,
    `expected $16,000.00 LTCG on $20k Brokerage spillover, got $${p.total.longTermCapitalGains.amount.toFixed(2)}`);

  const w = monthWindow(p, 2026, 4);
  const flows = moneyFlows(p, w.from, w.to);
  assert.equal(flows.totals.oneTimeOut, 30000,
    `expected $30,000 oneTimeOut in Flows, got $${flows.totals.oneTimeOut}`);
});

console.log('\n── RED-6c & 6d: Closing mortgage payoff LTCG & multi-target close splits ──\n');

await check('closing a mortgage paid from appreciated brokerage books full payoff LTCG into portfolio.total', async () => {
  setupSingle({ startAge: 45, retirementAge: 65, finishAge: 46 });
  // Mortgage starts Jan 2026 and finishes Jan 2026 (closes Feb 2026 with ~$99.9k remaining).
  // Brokerage ($200k value, $40k basis => 80% gain) pays the monthly payment and payoff.
  const assets = makeAssets([
    { instrument: 'taxableEquity', displayName: 'Brokerage', startCurrency: { amount: 200000 }, startBasisCurrency: { amount: 40000 } },
    {
      instrument: 'mortgage', displayName: 'Mortgage',
      startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 1 },
      startCurrency: { amount: -100000 }, annualReturnRate: { rate: 0.06 }, monthsRemaining: 360,
    },
  ]);

  const { p, sanityIssues } = await runCapturingSanity(assets);
  const brok = p.modelAssets.find(a => a.displayName === 'Brokerage');
  const brokGainHist = brok.getHistory(Metric.LONG_TERM_CAPITAL_GAIN).reduce((a, b) => a + b, 0);

  assert.equal(sanityIssues.length, 0, `unexpected sanity issues: ${sanityIssues.join('; ')}`);
  assert.ok(p.total.longTermCapitalGains.amount > 79000,
    `expected ~$80,000 LTCG from mortgage payoff, got $${p.total.longTermCapitalGains.amount.toFixed(2)}`);
  assert.ok(Math.abs(p.total.longTermCapitalGains.amount - brokGainHist) < 0.05,
    `total.longTermCapitalGains ($${p.total.longTermCapitalGains.amount.toFixed(2)}) must match Brokerage metric ($${brokGainHist.toFixed(2)})`);
});

await check('multi-target 50%/50% close split pays exact 50%/50%, not 75%/25% via sequential base shrinkage', async () => {
  setupSingle({ startAge: 45, retirementAge: 65, finishAge: 46 });
  const assets = makeAssets([
    { instrument: 'bank', displayName: 'Savings', startCurrency: { amount: 10000 } },
    { instrument: 'taxableEquity', displayName: 'Brokerage', startCurrency: { amount: 10000 }, startBasisCurrency: { amount: 10000 } },
    {
      instrument: 'realEstate', displayName: 'Home',
      startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 1 },
      startCurrency: { amount: 500000 }, startBasisCurrency: { amount: 500000 },
      annualTaxRate: { rate: 0 },
      fundTransfers: [
        { toDisplayName: 'Savings', monthlyMoveValue: 0, closeMoveValue: 50 },
        { toDisplayName: 'Brokerage', monthlyMoveValue: 0, closeMoveValue: 50 },
      ],
    },
  ]);

  const { p, sanityIssues } = await runCapturingSanity(assets);
  const savings = p.modelAssets.find(a => a.displayName === 'Savings');
  const brok = p.modelAssets.find(a => a.displayName === 'Brokerage');

  assert.equal(sanityIssues.length, 0, `unexpected sanity issues: ${sanityIssues.join('; ')}`);
  assert.ok(Math.abs(savings.finishCurrency.amount - 260000) < 0.01,
    `Savings expected $260,000 ($10k + 50% of $500k), got $${savings.finishCurrency.amount.toFixed(2)}`);
  assert.ok(Math.abs(brok.finishCurrency.amount - 260000) < 0.01,
    `Brokerage expected $260,000 ($10k + 50% of $500k), got $${brok.finishCurrency.amount.toFixed(2)}`);
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);
process.exit(failed > 0 ? 1 : 0);
