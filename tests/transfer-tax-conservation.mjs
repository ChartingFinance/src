/**
 * transfer-tax-conservation.mjs
 *
 * Books-equal-balances regression tests for two transfer-engine bugs fixed
 * 2026-06-12:
 *
 *   F3 — Roth IRA annual limit must be enforced on the EXECUTED cash flows.
 *        Before the fix: the clamp formula subtracted the proposed
 *        contribution from itself (always negative when triggered),
 *        calculatePostTaxContributions then deleted the approved amount and
 *        recalculated without any limit, and the FP booked the running total
 *        once per transfer. Balances and books disagreed by tens of
 *        thousands per year.
 *
 *   F4 — Rebalance transfers must record tax consequences against the
 *        SOURCE of funds with a positive amount. Before the fix the
 *        DESTINATION instrument and a negative amount were passed: realized
 *        gains from taxable sales never reached the tax base, and phantom
 *        NEGATIVE distributions were booked against target accounts,
 *        shielding real taxable income.
 *
 * Core invariant, same as payroll-tax-conservation.mjs:
 *        the books and the balances must tell the same story, to the penny.
 *
 * Usage:  node src/tests/transfer-tax-conservation.mjs   (from repo root)
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
import { setActiveTaxTable, activeTaxTable } from '../js/globals.js';

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

// Returns { portfolio, iraLimit }. The IRA limit is captured BEFORE the run:
// the tax table inflation-indexes its limits at each simulated year boundary,
// so a post-run read reports next year's limit, not the one the simulation
// enforced.
async function runPortfolio(assetData) {
  setActiveTaxTable(new TaxTable());
  const modelAssets = assetData.map(obj => ModelAsset.fromJSON(obj));
  const portfolio = new Portfolio(modelAssets, true);
  const iraLimit = activeTaxTable.iraContributionLimit(portfolio.activeUser).amount;
  await chronometer_run(portfolio);
  return { portfolio, iraLimit };
}

const YEAR = { startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 12 } };

// ══════════════════════════════════════════════════════════════════════
// Scenario C — F3: Roth IRA annual limit enforced on executed flows
//
// $10,000/mo salary, 40% → Roth IRA (≈ $2,900/mo, blows through the annual
// limit in month 3), 60% → Brokerage. Zero growth everywhere, so the Roth
// balance delta IS the executed contributions.
// ══════════════════════════════════════════════════════════════════════

console.log('\n── Scenario C: Roth annual limit (F3) ──────────────────\n');

const { portfolio: portfolioC, iraLimit } = await runPortfolio([
  {
    instrument: 'workingIncome', displayName: 'Salary', ...YEAR,
    startCurrency: { amount: 10000 }, startBasisCurrency: { amount: 0 },
    annualReturnRate: { rate: 0 },
    fundTransfers: [
      { toDisplayName: 'Roth IRA', monthlyMoveValue: 40, closeMoveValue: 0 },
      { toDisplayName: 'Brokerage', monthlyMoveValue: 60, closeMoveValue: 0 },
    ],
  },
  {
    instrument: 'rothIRA', displayName: 'Roth IRA', ...YEAR,
    startCurrency: { amount: 10000 }, startBasisCurrency: { amount: 10000 },
    annualReturnRate: { rate: 0 },
  },
  {
    instrument: 'taxableEquity', displayName: 'Brokerage', ...YEAR,
    startCurrency: { amount: 30000 }, startBasisCurrency: { amount: 30000 },
    annualReturnRate: { rate: 0 },
  },
]);

const rothC      = portfolioC.modelAssets.find(a => a.displayName === 'Roth IRA');
const brokerageC = portfolioC.modelAssets.find(a => a.displayName === 'Brokerage');
const totalC     = portfolioC.total;

const rothDeltaC = rothC.finishCurrency.amount - 10000;

check(`Roth received exactly the annual IRA limit (${fmt(iraLimit)})`, () => {
  assert.ok(Math.abs(rothDeltaC - iraLimit) < 0.01,
    `Roth Δ ${fmt(rothDeltaC)} vs limit ${fmt(iraLimit)} — ` +
    `pre-fix the limit was computed but never applied to executed flows (~$35k/yr delivered)`);
});

check('books match balances: FP rothIRAContribution == Roth balance delta', () => {
  assert.ok(Math.abs(totalC.rothIRAContribution.amount - rothDeltaC) < 0.01,
    `FP booked ${fmt(totalC.rothIRAContribution.amount)} vs delivered ${fmt(rothDeltaC)} — ` +
    `pre-fix the books and balances disagreed (per-transfer running-total booking)`);
});

check('no negative Roth deposits (clamp never approves a reverse transfer)', () => {
  const negatives = rothC.creditMemos.filter(m => m.note?.includes('Salary') && m.amount.amount < 0);
  assert.equal(negatives.length, 0,
    `Found ${negatives.length} negative Salary→Roth memos — the old clamp formula went negative when triggered`);
});

check('conservation: Δ(Roth + Brokerage) == gross − FICA − income tax (±$1)', () => {
  const delta = rothDeltaC + (brokerageC.finishCurrency.amount - 30000);
  const expected = totalC.employedIncome.amount + totalC.fica().amount + totalC.incomeTax.amount
                 + memoSum(rothC, 'Annual tax true-up') + memoSum(brokerageC, 'Annual tax true-up');
  assert.ok(Math.abs(delta - expected) < 1,
    `Δbalances ${fmt(delta)} vs net flows ${fmt(expected)} — residual ${fmt(delta - expected)}`);
});

// ══════════════════════════════════════════════════════════════════════
// Scenario D — F4: taxable → IRA rebalance books the realized gain
//
// $100k brokerage with $20k basis (80% unrealized gain), 10%/mo → trad IRA.
// The IRA contribution cap clamps the transfer to one limit-sized move in
// month 1, realizing gain = 80% of the amount moved. Zero growth.
// ══════════════════════════════════════════════════════════════════════

console.log('\n── Scenario D: taxable→IRA rebalance gains (F4) ────────\n');

const { portfolio: portfolioD } = await runPortfolio([
  {
    instrument: 'taxableEquity', displayName: 'Brokerage', ...YEAR,
    startCurrency: { amount: 100000 }, startBasisCurrency: { amount: 20000 },
    annualReturnRate: { rate: 0 },
    fundTransfers: [
      { toDisplayName: 'IRA', monthlyMoveValue: 10, closeMoveValue: 0 },
    ],
  },
  {
    instrument: 'ira', displayName: 'IRA', ...YEAR,
    startCurrency: { amount: 50000 }, startBasisCurrency: { amount: 0 },
    annualReturnRate: { rate: 0 },
  },
]);

const brokerageD = portfolioD.modelAssets.find(a => a.displayName === 'Brokerage');
const iraD       = portfolioD.modelAssets.find(a => a.displayName === 'IRA');
const totalD     = portfolioD.total;

const movedD = iraD.finishCurrency.amount - 50000;          // capped at the IRA limit
const expectedGainD = movedD * 0.8;                          // 80% unrealized gain ratio

check('IRA received the contribution-capped transfer amount', () => {
  assert.ok(movedD > 0 && Math.abs((100000 - brokerageD.finishCurrency.amount) - movedD) < 0.01,
    `IRA Δ ${fmt(movedD)} vs Brokerage Δ ${fmt(100000 - brokerageD.finishCurrency.amount)}`);
});

check('realized gain from the taxable sale reached the tax base (FP LTCG)', () => {
  assert.ok(Math.abs(totalD.longTermCapitalGains.amount - expectedGainD) < 0.01,
    `FP LTCG ${fmt(totalD.longTermCapitalGains.amount)} vs expected ${fmt(expectedGainD)} — ` +
    `pre-fix this was $0.00: the gain never left the per-asset metric`);
});

check('no phantom IRA distribution from money flowing INTO the IRA', () => {
  assert.ok(Math.abs(totalD.tradIRADistribution.amount) < 0.01,
    `FP tradIRADistribution ${fmt(totalD.tradIRADistribution.amount)}, expected $0.00 — ` +
    `pre-fix this went NEGATIVE by the transfer amount, shielding real taxable income`);
});

check('conservation: pure transfer, Δ(Brokerage + IRA) == 0 (±$1)', () => {
  const delta = (brokerageD.finishCurrency.amount - 100000) + movedD;
  assert.ok(Math.abs(delta) < 1, `Δbalances ${fmt(delta)}, expected $0.00`);
});

// ══════════════════════════════════════════════════════════════════════
// Scenario E — F4: Roth conversion classifies as trad-IRA income
//
// $100k trad IRA, 10%/mo → Roth IRA (a Roth conversion). The shared IRA
// cap clamps it to one limit-sized conversion in month 1. The converted
// amount is ordinary income (tradIRADistribution); the Roth side must NOT
// book any distribution. Zero growth.
// ══════════════════════════════════════════════════════════════════════

console.log('\n── Scenario E: Roth conversion classification (F4) ─────\n');

const { portfolio: portfolioE } = await runPortfolio([
  {
    instrument: 'ira', displayName: 'IRA', ...YEAR,
    startCurrency: { amount: 100000 }, startBasisCurrency: { amount: 0 },
    annualReturnRate: { rate: 0 },
    fundTransfers: [
      { toDisplayName: 'Roth IRA', monthlyMoveValue: 10, closeMoveValue: 0 },
    ],
  },
  {
    instrument: 'rothIRA', displayName: 'Roth IRA', ...YEAR,
    startCurrency: { amount: 10000 }, startBasisCurrency: { amount: 10000 },
    annualReturnRate: { rate: 0 },
  },
]);

const iraE   = portfolioE.modelAssets.find(a => a.displayName === 'IRA');
const rothE  = portfolioE.modelAssets.find(a => a.displayName === 'Roth IRA');
const totalE = portfolioE.total;

const convertedE = rothE.finishCurrency.amount - 10000;

check('conversion executed and balances mirror each other', () => {
  assert.ok(convertedE > 0 && Math.abs((100000 - iraE.finishCurrency.amount) - convertedE) < 0.01,
    `Roth Δ ${fmt(convertedE)} vs IRA Δ ${fmt(100000 - iraE.finishCurrency.amount)}`);
});

check('converted amount booked as trad-IRA distribution (ordinary income)', () => {
  assert.ok(Math.abs(totalE.tradIRADistribution.amount - convertedE) < 0.01,
    `FP tradIRADistribution ${fmt(totalE.tradIRADistribution.amount)} vs converted ${fmt(convertedE)}`);
});

check('no phantom Roth distribution from the conversion', () => {
  assert.ok(Math.abs(totalE.rothIRADistribution.amount) < 0.01,
    `FP rothIRADistribution ${fmt(totalE.rothIRADistribution.amount)}, expected $0.00 — ` +
    `pre-fix this went NEGATIVE by the converted amount, corrupting the tax-free rollup`);
});

check('conservation: pure transfer, Δ(IRA + Roth) == 0 (±$1)', () => {
  const delta = (iraE.finishCurrency.amount - 100000) + convertedE;
  assert.ok(Math.abs(delta) < 1, `Δbalances ${fmt(delta)}, expected $0.00`);
});

// ══════════════════════════════════════════════════════════════════════
// Scenario K — closing a traditional IRA is a FULL ordinary-income
// distribution (fixed 2026-06-12)
//
// $50k IRA (zero growth) closes at its finish date mid-run, sweeping 100%
// to the brokerage. The ENTIRE balance must be booked as tradIRADistribution
// (ordinary income) with income tax withheld at close — NOT capital gains
// on finish − basis, which the old code computed (basis 0 → the whole
// balance taxed at LTCG rates, or $0 for an account whose basis equaled
// its value).
// ══════════════════════════════════════════════════════════════════════

console.log('\n── Scenario K: IRA close = ordinary income (D-fix) ─────\n');

const { portfolio: portfolioK } = await runPortfolio([
  {
    instrument: 'ira', displayName: 'IRA',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 6 },
    startCurrency: { amount: 50000 }, startBasisCurrency: { amount: 0 },
    annualReturnRate: { rate: 0 },
    fundTransfers: [
      { toDisplayName: 'Brokerage', monthlyMoveValue: 0, closeMoveValue: 100 },
    ],
  },
  {
    instrument: 'taxableEquity', displayName: 'Brokerage', ...YEAR,
    startCurrency: { amount: 20000 }, startBasisCurrency: { amount: 20000 },
    annualReturnRate: { rate: 0 },
  },
]);

const iraK       = portfolioK.modelAssets.find(a => a.displayName === 'IRA');
const brokerageK = portfolioK.modelAssets.find(a => a.displayName === 'Brokerage');
const totalK     = portfolioK.total;

check('IRA actually closed mid-run (scenario premise)', () => {
  assert.ok(iraK.isClosed && Math.abs(iraK.finishCurrency.amount) < 0.01,
    `IRA isClosed=${iraK.isClosed}, balance ${fmt(iraK.finishCurrency.amount)}`);
});

check('full balance booked as ordinary-income distribution', () => {
  assert.ok(Math.abs(totalK.tradIRADistribution.amount - 50000) < 0.01,
    `FP tradIRADistribution ${fmt(totalK.tradIRADistribution.amount)}, expected $50,000.00 — ` +
    `pre-fix this was $0: the close was classified as capital gains on growth only`);
});

check('no capital gains booked from the deferred close (neither LT nor ST)', () => {
  // Pre-fix, the close fell into calculateCapitalGainsTax: a >12-month
  // holding booked the whole balance as LTCG; a shorter holding (like this
  // 6-month one) booked it as shortTermCapitalGains. Both must be zero.
  assert.ok(Math.abs(totalK.longTermCapitalGains.amount) < 0.01 &&
            Math.abs(totalK.shortTermCapitalGains.amount) < 0.01,
    `FP LTCG ${fmt(totalK.longTermCapitalGains.amount)} / STCG ${fmt(totalK.shortTermCapitalGains.amount)}, ` +
    `expected both $0.00 — pre-fix the $50,000 balance was booked as a capital gain`);
});

check('ordinary income tax was withheld at close', () => {
  assert.ok(totalK.incomeTax.amount < -4000,
    `FP incomeTax ${fmt(totalK.incomeTax.amount)}, expected a material withholding ` +
    `(ordinary brackets on a $50k distribution)`);
});

check('conservation: Δ(IRA + Brokerage) == taxes collected (±$1)', () => {
  const delta = (0 - 50000) + (brokerageK.finishCurrency.amount - 20000);
  const expected = totalK.incomeTax.amount
                 + memoSum(brokerageK, 'Annual tax true-up') + memoSum(iraK, 'Annual tax true-up');
  assert.ok(Math.abs(delta - expected) < 1,
    `Δbalances ${fmt(delta)} vs taxes ${fmt(expected)} — residual ${fmt(delta - expected)}`);
});

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
