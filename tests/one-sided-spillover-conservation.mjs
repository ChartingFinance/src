/**
 * one-sided-spillover-conservation.mjs
 *
 * Mortgage payments, property tax escrow and real-estate carrying costs are
 * not expense cards: they are funded from the asset's OWN fundTransfers, and
 * they settle by calling debit() directly rather than FundTransfer.execute().
 *
 * Bug (found 2026-07-25): that meant they never reached execute()'s spillover
 * handling. When the named funding account was tax-advantaged, #transact
 * clamped it at $0 and returned the shortfall as `spillover` — which these
 * three loops recorded and then DROPPED. The obligation was booked, the
 * mortgage amortized, the escrow cleared, and no cash ever left any account.
 * A Roth holding $1,000 "paid" a year of mortgage payments while $200,000 sat
 * untouched in the brokerage next to it.
 *
 * They also passed the FULL requested amount to FinancialPackage.recordTransfer,
 * booking phantom IRA/401K/Roth distributions for money the account never held
 * — the same double-booking the expense path fixed on 2026-06-12.
 *
 * Invariants (zero growth, zero inflation, no RMD age):
 *   1. Books === balances: the cash that leaves liquid accounts equals the
 *      obligation the engine booked, to the penny.
 *   2. The clamped account supplies exactly its balance and no more.
 *   3. The fallback supplies exactly the remainder.
 *   4. Distributions are booked against the account that ACTUALLY supplied the
 *      cash — household FP === the asset's own distribution metric.
 *
 * Scope note: this suite covers the SPILLOVER mechanics only — who supplies
 * the shortfall once a named funding account clamps at $0. Which accounts the
 * engine may draft in the first place is one shared policy now
 * (`FundTransfer.resolveFunding`); see funding-backstop.mjs.
 *
 * Usage:  node src/tests/one-sided-spillover-conservation.mjs   (from repo root)
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
import { simConfigFromGlobals } from '../js/globals.js';

// Age 50: well clear of RMDs, so a traditional IRA used as a funding source
// is drained only by the obligation under test.
global_setUserStartAge(50); global_getUserStartAge();
global_setInflationRate(0); global_getInflationRate();
global_setFilingAs('Single'); global_getFilingAs();

// 24-month plan, every assertion read at END OF MONTH 12 (history index 11),
// so close-date proceeds never pollute a balance.
const START = { year: 2026, month: 1 };
const FINISH = { year: 2027, month: 12 };
const M12 = 11;

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
const sum = (arr, upTo = Infinity) =>
  (arr ?? []).slice(0, upTo).reduce((s, v) => s + (v ?? 0), 0);

const LIQUID = ['bank', 'cash', 'taxableEquity', 'rothIRA', 'ira', '401K'];

async function run(assets) {
  setActiveTaxTable(new TaxTable());
  const modelAssets = assets.map(o => ModelAsset.fromJSON(o));
  const portfolio = new Portfolio(modelAssets, false, simConfigFromGlobals());
  await chronometer_run(portfolio);
  return portfolio;
}

const byName = (p, name) => p.modelAssets.find(a => a.displayName === name);
const at12 = (asset) => asset.monthlyValues[M12] ?? 0;
const delta12 = (asset) => at12(asset) - asset.startCurrency.amount;

/** Total cash that left every liquid account over the first 12 months. */
function liquidOutflow(p) {
  return -p.modelAssets
    .filter(a => LIQUID.includes(a.instrument))
    .reduce((s, a) => s + delta12(a), 0);
}

// ── Asset builders ────────────────────────────────────────────────────
const xfer = (to) => ({ toDisplayName: to, monthlyMoveValue: 100, closeMoveValue: 0 });

const account = (instrument, displayName, amount) => ({
  instrument, displayName,
  startDateInt: START, finishDateInt: FINISH,
  startCurrency: { amount }, startBasisCurrency: { amount },
  annualReturnRate: { rate: 0 },
});

const mortgage = (fundedBy) => ({
  instrument: 'mortgage', displayName: 'Mortgage',
  startDateInt: START, finishDateInt: FINISH,
  startCurrency: { amount: -200000 }, startBasisCurrency: { amount: 0 },
  annualReturnRate: { rate: 0.06 }, monthsRemaining: 240,
  fundTransfers: [xfer(fundedBy)],
});

const home = (fundedBy, { taxRate = 0, maint = 0, ins = 0 } = {}) => ({
  instrument: 'realEstate', displayName: 'Home',
  startDateInt: START, finishDateInt: FINISH,
  startCurrency: { amount: 400000 }, startBasisCurrency: { amount: 400000 },
  annualReturnRate: { rate: 0 },
  annualTaxRate: { rate: taxRate },
  annualMaintenanceRate: { rate: maint },
  annualInsuranceCost: { amount: ins },
  fundTransfers: [xfer(fundedBy)],
});

console.log('\n══ One-sided spillover conservation ══════════════════════\n');

// ══════════════════════════════════════════════════════════════════════
// Scenario A — Mortgage P+I funded from a Roth holding $5,000
// ══════════════════════════════════════════════════════════════════════
console.log('── A. Mortgage funded from a Roth that runs dry ──────────\n');
{
  const p = await run([
    account('rothIRA', 'Roth IRA', 5000),
    account('taxableEquity', 'Brokerage', 200000),
    mortgage('Roth IRA'),
  ]);

  const roth = byName(p, 'Roth IRA');
  const brokerage = byName(p, 'Brokerage');
  const mtg = byName(p, 'Mortgage');

  // The obligation the engine itself booked over 12 months.
  const payments = Math.abs(sum(mtg.getHistory(Metric.MORTGAGE_PAYMENT), 12));

  check('mortgage actually booked payments (sanity)', () => {
    assert.ok(payments > 17000 && payments < 17500,
      `12 months of P+I = ${fmt(payments)}, expected ≈ $17,194`);
  });

  check('books === balances: cash out equals the payments booked', () => {
    assert.ok(near(liquidOutflow(p), payments),
      `cash out ${fmt(liquidOutflow(p))} !== payments booked ${fmt(payments)}`);
  });

  check('Roth supplies exactly its $5,000 and clamps at $0', () => {
    assert.ok(near(at12(roth), 0), `Roth ended at ${fmt(at12(roth))}, expected $0.00`);
  });

  check('brokerage picks up exactly the remainder', () => {
    assert.ok(near(-delta12(brokerage), payments - 5000),
      `brokerage supplied ${fmt(-delta12(brokerage))}, expected ${fmt(payments - 5000)}`);
  });

  check('no phantom Roth distribution: FP books only the $5,000 it held', () => {
    assert.ok(near(p.total.rothIRADistribution.amount, 5000),
      `FP rothIRADistribution = ${fmt(p.total.rothIRADistribution.amount)}, expected $5,000.00`);
  });

  check('double entry: FP distribution === the asset distribution metric', () => {
    const metric = sum(roth.getHistory(Metric.ROTH_IRA_DISTRIBUTION));
    assert.ok(near(metric, p.total.rothIRADistribution.amount),
      `asset metric ${fmt(metric)} !== FP ${fmt(p.total.rothIRADistribution.amount)}`);
  });
}

// ══════════════════════════════════════════════════════════════════════
// Scenario B — Property tax escrow funded from an IRA holding $1,000
// ══════════════════════════════════════════════════════════════════════
console.log('\n── B. Property tax funded from an IRA that runs dry ──────\n');
{
  const p = await run([
    account('ira', 'IRA', 1000),
    account('taxableEquity', 'Brokerage', 200000),
    home('IRA', { taxRate: 0.012 }),
  ]);

  const ira = byName(p, 'IRA');
  const brokerage = byName(p, 'Brokerage');
  const hm = byName(p, 'Home');

  const escrowPaid = Math.abs(sum(hm.getHistory(Metric.PROPERTY_TAX), 12));

  check('property tax actually booked (sanity)', () => {
    assert.ok(escrowPaid > 0, `property tax booked ${fmt(escrowPaid)}, expected > $0`);
  });

  check('books === balances: cash out equals the escrow settled', () => {
    // The escrow settles one month in arrears, so compare against what was
    // actually debited rather than what accrued.
    assert.ok(near(liquidOutflow(p), 1000 + -delta12(brokerage)),
      `cash out ${fmt(liquidOutflow(p))} !== IRA $1,000.00 + brokerage ${fmt(-delta12(brokerage))}`);
  });

  check('IRA supplies exactly its $1,000 and clamps at $0', () => {
    assert.ok(near(at12(ira), 0), `IRA ended at ${fmt(at12(ira))}, expected $0.00`);
  });

  check('brokerage funds the escrow the IRA could not', () => {
    assert.ok(-delta12(brokerage) > 0,
      `brokerage supplied ${fmt(-delta12(brokerage))}, expected the shortfall`);
  });

  check('no phantom IRA distribution: FP books only the $1,000 it held', () => {
    assert.ok(near(p.total.tradIRADistribution.amount, 1000),
      `FP tradIRADistribution = ${fmt(p.total.tradIRADistribution.amount)}, expected $1,000.00`);
  });

  check('double entry: FP distribution === the asset distribution metric', () => {
    const metric = sum(ira.getHistory(Metric.TRAD_IRA_DISTRIBUTION));
    assert.ok(near(metric, p.total.tradIRADistribution.amount),
      `asset metric ${fmt(metric)} !== FP ${fmt(p.total.tradIRADistribution.amount)}`);
  });
}

// ══════════════════════════════════════════════════════════════════════
// Scenario C — Carrying costs funded from a Roth, with only a BANK behind it.
// Carrying costs resolve through the expensable priority list, so the
// spillover leg must reach the bank — no taxable account exists here.
// ══════════════════════════════════════════════════════════════════════
console.log('\n── C. Carrying costs funded from a Roth, bank behind it ──\n');
{
  const p = await run([
    account('bank', 'Savings', 300000),
    account('rothIRA', 'Roth IRA', 1000),
    home('Roth IRA', { maint: 0.01, ins: 2400 }),   // $4,000 + $2,400 per year
  ]);

  const savings = byName(p, 'Savings');
  const roth = byName(p, 'Roth IRA');
  const CARRYING_12MO = 4000 + 2400;

  check('books === balances: cash out equals maintenance + insurance', () => {
    assert.ok(near(liquidOutflow(p), CARRYING_12MO),
      `cash out ${fmt(liquidOutflow(p))} !== ${fmt(CARRYING_12MO)}`);
  });

  check('Roth supplies exactly its $1,000 and clamps at $0', () => {
    assert.ok(near(at12(roth), 0), `Roth ended at ${fmt(at12(roth))}, expected $0.00`);
  });

  check('bank picks up the remainder through the expensable fallback', () => {
    assert.ok(near(-delta12(savings), CARRYING_12MO - 1000),
      `bank supplied ${fmt(-delta12(savings))}, expected ${fmt(CARRYING_12MO - 1000)}`);
  });
}

// ══════════════════════════════════════════════════════════════════════
// Scenario D — No fallback reachable at all: must degrade quietly, not throw.
// (That the bank cannot fund a mortgage here is finding #1, still open.)
// ══════════════════════════════════════════════════════════════════════
console.log('\n── D. Clamped account with no reachable fallback ─────────\n');
{
  const p = await run([
    account('bank', 'Savings', 300000),
    account('rothIRA', 'Roth IRA', 5000),
    mortgage('Roth IRA'),
  ]);

  check('run completes and the Roth is drained, not overdrawn', () => {
    const roth = byName(p, 'Roth IRA');
    assert.ok(near(at12(roth), 0), `Roth ended at ${fmt(at12(roth))}, expected $0.00`);
  });
}

// ── Summary ───────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
