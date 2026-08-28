/**
 * earnings-on-deficit.mjs
 *
 * No account earns a return on a negative balance.
 *
 * Growth, dividends and interest are all computed as `finishCurrency * rate`.
 * When the balance is below zero that produces NEGATIVE earnings — an overdraft
 * compounding at the account's own return rate, as though being overdrawn at a
 * brokerage were a margin loan priced at the equity return.
 *
 * Found 2026-07-28 in the shipped Early Career quick start: the Brokerage dips
 * to -$424 in month 34 and compounds to -$11.5M by plan end, of which
 * -$9,506,467 — 82% — is this phantom negative growth.
 *
 * DEBT is exempt on purpose: it is legitimately negative and its "growth" IS
 * the interest accruing on what is still owed. CapitalBehavior already caps a
 * paid-off debt at $0 to avoid reverse interest; this is the same idea applied
 * to accounts that are supposed to be positive.
 *
 * NOTE: this suite does not assert that balances stay above zero. Nothing
 * floors funding-backstop accounts yet — that is the other half of the
 * overdraft work. This pins only that a deficit does not COMPOUND.
 *
 * Usage:  node src/tests/earnings-on-deficit.mjs   (from repo root)
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
import { setActiveTaxTable } from '../js/globals.js';
import { Metric } from '../js/metric.js';
import { simConfigFromGlobals } from '../js/globals.js';
import { makeActiveTaxTable } from '../js/globals.js';

// ── Helpers ───────────────────────────────────────────────────────────
const fmt = (n) => {
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};
let passed = 0;
let failed = 0;

function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

const hv = (e) => (e == null ? 0 : (e.amount ?? Number(e) ?? 0));
const hist = (a, m) => (a.getHistory(m) ?? []).map(hv);

/** One funding account, one expense far larger than it — forced overdraft. */
async function overdraw(instrument, name, rate = 0.06) {
  setActiveTaxTable(makeActiveTaxTable());
  const p = new Portfolio([
    {
      instrument, displayName: name,
      startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2036, month: 12 },
      startCurrency: { amount: 10000 }, startBasisCurrency: { amount: 10000 },
      annualReturnRate: { rate },
    },
    {
      instrument: 'monthlyExpense', displayName: 'Living',
      startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2036, month: 12 },
      startCurrency: { amount: 3000 }, startBasisCurrency: { amount: 0 },
      annualReturnRate: { rate: 0 },
    },
  ].map(o => ModelAsset.fromJSON(o)), true, simConfigFromGlobals());
  await chronometer_run(p);
  return { portfolio: p, account: p.modelAssets.find(a => a.displayName === name) };
}

const FUNDING = [
  ['cash',          'Cash'],
  ['bank',          'Savings'],
  ['taxableEquity', 'Brokerage'],
  ['usBond',        'Treasuries'],
  ['corpBond',      'Corp Bonds'],
];

console.log('\n── No funding account earns on a deficit ──\n');

for (const [instrument, name] of FUNDING) {
  const { portfolio, account: a } = await overdraw(instrument, name);

  check(`${instrument}: never books negative growth, dividends or interest`, () => {
    const earnings = [
      ...hist(a, Metric.GROWTH),
      ...hist(a, Metric.INTEREST_INCOME),
      ...hist(a, Metric.QUALIFIED_DIVIDEND),
      ...hist(a, Metric.NON_QUALIFIED_DIVIDEND),
    ];
    const negatives = earnings.filter(v => v < -0.01);
    const total = negatives.reduce((s, v) => s + v, 0);
    assert.equal(negatives.length, 0,
      `${negatives.length} month(s) of negative earnings totalling ${fmt(total)} — ` +
      `a deficit must not compound`);
  });

  check(`${instrument}: never goes below $0 at all`, () => {
    const vals = hist(a, Metric.VALUE);
    const worst = Math.min(...vals);
    assert.ok(worst >= -0.01,
      `balance reached ${fmt(worst)} — funding accounts floor at $0 and the ` +
      `shortfall re-sources through the backstop chain`);
  });

  check(`${instrument}: running dry surfaces as unfunded, not silence`, () => {
    const ranDry = hist(a, Metric.VALUE).some(v => Math.abs(v) < 0.01);
    assert.ok(ranDry, 'scenario should have emptied the account');
    // reportUnfunded lands on the asset that OWES, so look across the whole
    // portfolio. Money the plan could not pay must never simply disappear.
    const unfunded = portfolio.modelAssets
      .flatMap(x => x.creditMemos.filter(m => /^Unfunded\b/.test(m.note ?? '')));
    assert.ok(unfunded.length > 0,
      'account ran dry and the expense went unpaid, but nothing was recorded as unfunded');
  });
}

console.log('\n── Debt still accrues its interest ──\n');

// Guard the exemption: the fix must not silence real debt interest.
setActiveTaxTable(makeActiveTaxTable());
const debtPortfolio = new Portfolio([
  {
    instrument: 'debt', displayName: 'Card',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2028, month: 12 },
    startCurrency: { amount: -20000 }, startBasisCurrency: { amount: 0 },
    annualReturnRate: { rate: 0.18 },
  },
].map(o => ModelAsset.fromJSON(o)), true, simConfigFromGlobals());
await chronometer_run(debtPortfolio);
const card = debtPortfolio.modelAssets.find(a => a.displayName === 'Card');

check('debt: a balance still owed keeps accruing interest', () => {
  const accrued = hist(card, Metric.GROWTH).reduce((s, v) => s + v, 0);
  assert.ok(accrued < -0.01,
    `debt must accrue interest while owed, got ${fmt(accrued)}`);
});

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
