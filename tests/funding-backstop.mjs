/**
 * funding-backstop.mjs
 *
 * When no explicit fund transfer covers an obligation, the engine picks a
 * funding account on the user's behalf. That pick used to be
 * `FundTransfer.resolveTaxable()` — TAXABLE_EQUITY only — at six money-moving
 * call sites, so a household whose money sat in savings, cash or bonds had
 * every implicit obligation booked with NO cash leaving ANY account:
 *
 *     bank $300,000 + $3,000/mo expense, no brokerage, 12 months
 *     before: expense booked -$36,000 → Savings $300,000 → $300,000   nothing paid
 *
 * Worse on a mortgage: principal fell, interest booked, net worth ROSE from
 * the paydown, and no account was debited (review_code_2026_07_25 finding #1).
 *
 * The replacement is ONE policy — `FundTransfer.resolveFunding()` — walking
 * the everyday accounts in order: cash → savings → brokerage → treasuries →
 * corporate bonds. Retirement accounts are deliberately NOT eligible: draining
 * an IRA has consequences (ordinary income, early-withdrawal penalties, Roth
 * ordering) the engine cannot choose for the user, so a plan that means to
 * spend retirement money says so with an explicit transfer. When the backstop
 * finds nothing, the obligation is reported as UNFUNDED rather than skipped.
 *
 * Invariants (zero growth, zero inflation, age 50 so RMDs never fire):
 *   1. Every everyday account type can fund an obligation, not just brokerage.
 *   2. The priority order is respected: cash before savings before brokerage.
 *   3. Retirement accounts are never drafted implicitly...
 *   4. ...but an explicit transfer to one still works — the user's routing wins.
 *   5. Nothing is silent: an unfundable obligation leaves an `Unfunded` memo.
 *   6. Funding from cash/savings/bonds is not grossed up for capital-gains tax
 *      that those accounts never owe.
 *
 * Usage:  node src/tests/funding-backstop.mjs   (from repo root)
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
import { Currency } from '../js/utils/currency.js';
import { FundTransfer } from '../js/fund-transfer.js';
import {
  setActiveTaxTable,
  global_setUserStartAge, global_getUserStartAge,
  global_setInflationRate, global_getInflationRate,
  global_setFilingAs, global_getFilingAs,
} from '../js/globals.js';
import { simConfigFromGlobals } from '../js/globals.js';

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

/** Total of the `Unfunded — ...` memos the engine wrote on an asset. */
const unfunded = (asset) => Math.abs((asset.creditMemos ?? [])
  .filter(m => m.note?.startsWith('Unfunded'))
  .reduce((s, m) => s + m.amount.amount, 0));

// ── Asset builders ────────────────────────────────────────────────────
const xfer = (to) => ({ toDisplayName: to, monthlyMoveValue: 100, closeMoveValue: 0 });

const account = (instrument, displayName, amount, basis = amount) => ({
  instrument, displayName,
  startDateInt: START, finishDateInt: FINISH,
  startCurrency: { amount }, startBasisCurrency: { amount: basis },
  annualReturnRate: { rate: 0 },
});

const expense = (monthly, fundedBy = null) => ({
  instrument: 'monthlyExpense', displayName: 'Living Expenses',
  startDateInt: START, finishDateInt: FINISH,
  startCurrency: { amount: -monthly }, startBasisCurrency: { amount: 0 },
  annualReturnRate: { rate: 0 },
  ...(fundedBy ? { fundTransfers: [xfer(fundedBy)] } : {}),
});

const mortgage = () => ({
  instrument: 'mortgage', displayName: 'Mortgage',
  startDateInt: START, finishDateInt: FINISH,
  startCurrency: { amount: -200000 }, startBasisCurrency: { amount: 0 },
  annualReturnRate: { rate: 0.06 }, monthsRemaining: 240,
});

console.log('\n══ Funding backstop ══════════════════════════════════════\n');

// ══════════════════════════════════════════════════════════════════════
// A — The review's repro: savings-only household, no brokerage anywhere
// ══════════════════════════════════════════════════════════════════════
console.log('── A. Expenses paid from savings when there is no brokerage ──\n');
{
  const p = await run([
    account('bank', 'Savings', 300000),
    expense(3000),
  ]);

  const savings = byName(p, 'Savings');
  const exp = byName(p, 'Living Expenses');
  const booked = Math.abs(sum(exp.getHistory(Metric.EXPENSE), 12));

  check('the expense was booked at all (sanity)', () => {
    assert.ok(near(booked, 36000), `booked ${fmt(booked)}, expected $36,000.00`);
  });

  check('savings actually paid it — the whole point of the fix', () => {
    assert.ok(near(-delta12(savings), 36000),
      `savings supplied ${fmt(-delta12(savings))}, expected ${fmt(36000)}`);
  });

  check('no gross-up: exactly the shortfall left the bank, not a penny more', () => {
    assert.ok(near(at12(savings), 264000),
      `savings ended ${fmt(at12(savings))}, expected $264,000.00`);
  });
}

// ══════════════════════════════════════════════════════════════════════
// B — Mortgage with no explicit routing, savings-only household
// ══════════════════════════════════════════════════════════════════════
console.log('\n── B. Mortgage P+I paid from savings, net worth does not rise ──\n');
{
  const p = await run([
    account('bank', 'Savings', 300000),
    mortgage(),
  ]);

  const savings = byName(p, 'Savings');
  const mtg = byName(p, 'Mortgage');
  const payments = Math.abs(sum(mtg.getHistory(Metric.MORTGAGE_PAYMENT), 12));

  check('mortgage booked 12 months of P+I (sanity)', () => {
    assert.ok(payments > 17000 && payments < 17500,
      `12 months of P+I = ${fmt(payments)}, expected ≈ $17,194`);
  });

  check('savings supplied every dollar of it', () => {
    assert.ok(near(-delta12(savings), payments),
      `savings supplied ${fmt(-delta12(savings))}, payments booked ${fmt(payments)}`);
  });

  check('net worth falls by the interest — no free paydown', () => {
    const interest = Math.abs(sum(mtg.getHistory(Metric.MORTGAGE_INTEREST), 12));
    const netWorthDelta = delta12(savings) + delta12(mtg);
    assert.ok(near(netWorthDelta, -interest),
      `net worth moved ${fmt(netWorthDelta)}, expected ${fmt(-interest)}`);
  });
}

// ══════════════════════════════════════════════════════════════════════
// C — Priority: cash before savings before brokerage
// ══════════════════════════════════════════════════════════════════════
console.log('\n── C. Priority order: cash → savings → brokerage ─────────\n');
{
  const p = await run([
    account('taxableEquity', 'Brokerage', 50000),
    account('bank', 'Savings', 50000),
    account('cash', 'Cash', 50000),
    expense(1000),
  ]);

  check('cash pays first even though it is listed last', () => {
    assert.ok(near(-delta12(byName(p, 'Cash')), 12000),
      `cash supplied ${fmt(-delta12(byName(p, 'Cash')))}, expected $12,000.00`);
  });

  check('savings untouched while cash lasts', () => {
    assert.ok(near(delta12(byName(p, 'Savings')), 0),
      `savings moved ${fmt(delta12(byName(p, 'Savings')))}`);
  });

  check('brokerage untouched while cash lasts', () => {
    assert.ok(near(delta12(byName(p, 'Brokerage')), 0),
      `brokerage moved ${fmt(delta12(byName(p, 'Brokerage')))}`);
  });
}

// ══════════════════════════════════════════════════════════════════════
// D — Bonds are eligible too
// ══════════════════════════════════════════════════════════════════════
console.log('\n── D. Treasuries fund when nothing more liquid exists ────\n');
{
  const p = await run([
    account('usBond', 'Treasuries', 100000),
    expense(1000),
  ]);

  check('treasuries supplied the expense', () => {
    assert.ok(near(-delta12(byName(p, 'Treasuries')), 12000),
      `treasuries supplied ${fmt(-delta12(byName(p, 'Treasuries')))}, expected $12,000.00`);
  });
}

// ══════════════════════════════════════════════════════════════════════
// E — Retirement accounts are not drafted, and the gap is not silent
// ══════════════════════════════════════════════════════════════════════
console.log('\n── E. An IRA is never the implicit backstop ──────────────\n');
{
  const p = await run([
    account('ira', 'IRA', 500000, 0),
    expense(1000),
  ]);

  const ira = byName(p, 'IRA');
  const exp = byName(p, 'Living Expenses');

  check('IRA untouched — the engine does not spend retirement money on its own', () => {
    assert.ok(near(delta12(ira), 0),
      `IRA moved ${fmt(delta12(ira))}, expected $0.00`);
  });

  check('the shortfall is REPORTED, not silently skipped', () => {
    assert.ok(unfunded(exp) > 0,
      'no "Unfunded" memo was written for an obligation nothing could pay');
  });

  check('the reported amount equals the unpaid expense', () => {
    assert.ok(near(unfunded(exp), 24000),
      `reported ${fmt(unfunded(exp))} unfunded over 24 months, expected $24,000.00`);
  });

  check('unfunded memos are info-kind — they move no cash and must not reconcile', () => {
    const kinds = new Set((exp.creditMemos ?? [])
      .filter(m => m.note?.startsWith('Unfunded')).map(m => m.kind));
    assert.deepEqual([...kinds], ['info'], `memo kinds were ${[...kinds]}`);
  });
}

// ══════════════════════════════════════════════════════════════════════
// F — The user's own routing still wins
// ══════════════════════════════════════════════════════════════════════
console.log('\n── F. An explicit transfer to an IRA still spends the IRA ──\n');
{
  const p = await run([
    account('ira', 'IRA', 500000, 0),
    account('bank', 'Savings', 100000),
    expense(1000, 'IRA'),
  ]);

  check('IRA pays the expense AND the withholding on it', () => {
    // $12,000 of expense, plus federal withholding at the source: the account
    // funds the obligation and the tax on the resulting gross distribution, so
    // it gives up 12,000 / (1 − 0.10) = $13,333.33 and $1,333.33 of that is
    // withheld. Before source withholding this expected a flat $12,000.
    assert.ok(near(-delta12(byName(p, 'IRA')), 13333.33),
      `IRA supplied ${fmt(-delta12(byName(p, 'IRA')))}, expected $13,333.33`);
  });

  check('the withholding is booked on the IRA, not guessed', () => {
    const withheld = Math.abs(byName(p, 'IRA').getHistory(Metric.WITHHELD_INCOME_TAX)
      .slice(0, 12).reduce((a, v) => a + (v ?? 0), 0));
    assert.ok(near(withheld, 1333.33),
      `IRA withheld ${fmt(withheld)}, expected $1,333.33 (10% of the $13,333.33 gross)`);
  });

  check('savings is left alone — routing beats the backstop', () => {
    // Any residual household tax still settles from the backstop, so allow
    // that, but the $12,000 expense itself must not appear here.
    const moved = -delta12(byName(p, 'Savings'));
    assert.ok(moved < 12000,
      `savings supplied ${fmt(moved)} — the expense leaked past the explicit transfer`);
  });
}

// ══════════════════════════════════════════════════════════════════════
// G — Gross-up applies to brokerage sales only
// ══════════════════════════════════════════════════════════════════════
console.log('\n── G. No capital-gains gross-up on accounts that owe none ──\n');
{
  const p = await run([
    account('bank', 'Savings', 300000),
    account('taxableEquity', 'Brokerage', 300000, 0),   // all gain
    expense(1000),
  ]);

  // Put the household in a paying LTCG bracket so a gross-up would be visible.
  p.monthly.employedIncome.add(new Currency(20000));    // $240,000/yr

  const need = new Currency(1000);
  const fromBank = p.expenses.calculateGrossWithdrawal(need, byName(p, 'Savings'));
  const fromBroker = p.expenses.calculateGrossWithdrawal(need, byName(p, 'Brokerage'));

  check('a $1,000 need withdraws exactly $1,000 from the bank', () => {
    assert.ok(near(fromBank.amount, 1000),
      `bank withdrawal grossed up to ${fmt(fromBank.amount)} for a tax it never owes`);
  });

  check('the brokerage is still grossed up for the gain it does realize', () => {
    assert.ok(fromBroker.amount > 1000,
      `brokerage withdrawal was ${fmt(fromBroker.amount)}, expected more than $1,000.00`);
  });
}

// ══════════════════════════════════════════════════════════════════════
// H — Resolver contract, direct
// ══════════════════════════════════════════════════════════════════════
console.log('\n── H. resolveFunding contract ───────────────────────────\n');
{
  // finishCurrency is the RUNNING balance and stays $0 until the asset's start
  // date, so set it directly — it is what the resolver reads.
  const mk = (instrument, displayName, amount) => {
    const a = ModelAsset.fromJSON(account(instrument, displayName, amount));
    a.finishCurrency = new Currency(amount);
    return a;
  };

  check('walks the priority list, not array order', () => {
    const picked = FundTransfer.resolveFunding([
      mk('corpBond', 'Corp', 1000), mk('taxableEquity', 'Brokerage', 1000),
      mk('bank', 'Savings', 1000), mk('cash', 'Cash', 1000),
    ]);
    assert.equal(picked.displayName, 'Cash');
  });

  check('skips accounts with nothing in them', () => {
    const picked = FundTransfer.resolveFunding([
      mk('cash', 'Cash', 0), mk('bank', 'Savings', 0), mk('taxableEquity', 'Brokerage', 1000),
    ]);
    assert.equal(picked.displayName, 'Brokerage');
  });

  check('returns null rather than reaching for a retirement account', () => {
    const picked = FundTransfer.resolveFunding([
      mk('401K', '401K', 500000), mk('ira', 'IRA', 500000), mk('rothIRA', 'Roth', 500000),
    ]);
    assert.equal(picked, null);
  });

  check('never offers a house or a mortgage as a funding source', () => {
    const picked = FundTransfer.resolveFunding([
      mk('realEstate', 'Home', 800000), mk('mortgage', 'Mortgage', -400000),
    ]);
    assert.equal(picked, null);
  });
}

console.log(`\n───────────────────────────────────────────────────────`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`───────────────────────────────────────────────────────\n`);
process.exit(failed ? 1 : 0);
