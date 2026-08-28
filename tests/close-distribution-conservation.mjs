/**
 * close-distribution-conservation.mjs
 *
 * Every dollar that leaves a retirement account must be booked as a
 * distribution on that account's own ledger — whether it leaves monthly or all
 * at once when the account closes.
 *
 * The bug this guards (fixed 2026-07-28): distribution RECORDING rode on the
 * tax path. applyCapitalGainsTax returns early for tax-free instruments, which
 * is correct for tax — a Roth owes none — but that early return was also the
 * gate for the booking its tax-deferred siblings get from
 * applyDeferredCloseDistribution. So closing a Roth recorded nothing at all,
 * while the SAME account's monthly draws recorded normally: $91,459 drawn
 * monthly was booked, $208,541 taken at close was not.
 *
 * The asset ledger matters beyond display — ensureRMDs reads it, and any
 * distribution counts toward the RMD under IRS rules (see
 * ModelAsset.recordDistribution).
 *
 * Usage:  node src/tests/close-distribution-conservation.mjs   (from repo root)
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
import { Metric } from '../js/metric.js';
import { simConfigFromGlobals } from '../js/globals.js';

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

const TOL = 0.02;
const hv = (e) => (e == null ? 0 : (e.amount ?? Number(e) ?? 0));
const total = (asset, metric) => (asset.getHistory(metric) ?? []).reduce((s, v) => s + hv(v), 0);

const START = 300000;

/** One retirement account drawn down monthly AND closed part-way through. */
async function scenario(instrument, name) {
  setActiveTaxTable(new TaxTable());
  const p = new Portfolio([
    {
      instrument, displayName: name,
      startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2027, month: 6 },
      startCurrency: { amount: START }, startBasisCurrency: { amount: START },
      annualReturnRate: { rate: 0 },
      fundTransfers: [{ toDisplayName: 'Living', monthlyMoveValue: 2, closeMoveValue: 100 }],
    },
    {
      instrument: 'monthlyExpense', displayName: 'Living',
      startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2027, month: 12 },
      startCurrency: { amount: 4000 }, startBasisCurrency: { amount: 0 },
      annualReturnRate: { rate: 0 },
    },
    {
      instrument: 'bank', displayName: 'Savings',
      startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2027, month: 12 },
      startCurrency: { amount: 1000 }, startBasisCurrency: { amount: 1000 },
      annualReturnRate: { rate: 0 },
    },
  ].map(o => ModelAsset.fromJSON(o)), true, simConfigFromGlobals());
  await chronometer_run(p);
  return { portfolio: p, asset: p.modelAssets.find(a => a.displayName === name) };
}

const CASES = [
  ['rothIRA', 'Roth IRA', Metric.ROTH_IRA_DISTRIBUTION, 'tax-free'],
  ['ira',     'IRA',      Metric.TRAD_IRA_DISTRIBUTION, 'tax-deferred'],
  ['401K',    '401K',     Metric.FOUR_01K_DISTRIBUTION, 'tax-deferred'],
];

console.log('\n── Every dollar out is booked as a distribution ──\n');

for (const [instrument, name, metric, kind] of CASES) {
  const { asset } = await scenario(instrument, name);

  check(`${name} (${kind}): distributions account for every dollar that left`, () => {
    const finalBalance = hv((asset.getHistory(Metric.VALUE) ?? []).at(-1));
    const cashOut = START - finalBalance;
    const booked = total(asset, metric);
    // Tax-deferred closes withhold tax from the balance itself, so the account
    // drains by cashOut while booking the pre-tax distribution — booked must be
    // at least the cash that left, never less.
    assert.ok(booked + TOL >= cashOut,
      `${fmt(cashOut)} left the account but only ${fmt(booked)} was booked as a distribution ` +
      `(unbooked ${fmt(cashOut - booked)})`);
  });

  check(`${name}: the closing balance itself is booked, not just monthly draws`, () => {
    const booked = total(asset, metric);
    // The monthly transfers alone are ~$91k on this scenario; the close is the
    // larger half. Anything materially under START means the close was dropped.
    assert.ok(booked + TOL >= START,
      `expected the full ${fmt(START)} to be booked across monthly draws and the ` +
      `close, got ${fmt(booked)}`);
  });
}

console.log('\n── A tax-free close stays tax-free ──\n');

const { asset: roth, portfolio: rothPortfolio } = await scenario('rothIRA', 'Roth IRA');

check('Roth: booking the distribution creates no tax', () => {
  const tax = total(roth, Metric.TAXES);
  assert.ok(Math.abs(tax) < TOL, `Roth close generated ${fmt(tax)} of tax`);
});

check('Roth: taxable gross income is untouched by a tax-free distribution', () => {
  const taxable = rothPortfolio.monthlyPackages
    .reduce((s, pk) => s + pk.irsTaxableGrossIncome().amount, 0);
  assert.ok(Math.abs(taxable) < TOL,
    `a tax-free distribution must not enter taxable income, got ${fmt(taxable)}`);
});

check('Roth: the household package sees the distribution too', () => {
  const fp = rothPortfolio.monthlyPackages.reduce((s, pk) => s + pk.rothIRADistribution.amount, 0);
  assert.ok(fp + TOL >= START,
    `package booked ${fmt(fp)}, expected the full ${fmt(START)}`);
});

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
