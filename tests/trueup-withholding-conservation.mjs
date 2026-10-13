/**
 * trueup-withholding-conservation.mjs
 *
 * The monthly tax true-up books as withheld only what the accounts paid.
 *
 * The true-up asks the funding account for the month's tax beyond what was
 * withheld at source. When the everyday accounts cannot pay all of it, the
 * rest is reported unfunded. It must not also be booked as withheld:
 * monthly.incomeTax rolls into the annual true-up's "already paid" figure, so
 * a dollar booked but never collected comes back as a cash refund, and money
 * is created.
 *
 * The plans close a $300,000 401(k) to a Roth. That month's income is the
 * whole balance, and the true-up sizes its tax from that month x12, so it asks
 * for far more than the close withheld and far more than the everyday accounts
 * hold. Across the year the close over-withholds, so the household is owed a
 * refund either way; the question is how big.
 *
 *   ledger    Δbalances == federal tax booked. A residual is money created
 *             (or destroyed).
 *   month     each month, the income tax booked equals what the accounts
 *             paid: the income-tax withholding debits plus any spill that
 *             paid one. The engine's own SANITY check compares the same two.
 *   accounts  the accounts' estimated-income-tax metrics add up to the
 *             household's income tax and settlement, month by month.
 *   refund    the year's refund is what was paid minus what was owed.
 *   shortfall what the accounts could not pay is still reported unfunded.
 *
 * Two plans cannot pay the draw (no fallback; a fallback that clamps too).
 * Two can (a fallback that covers the spill; one account that covers it all).
 * Those held before the fix as well, so they show the measurement is sound.
 *
 * Every rate is zero and every date explicit, so the numbers are exact and do
 * not depend on the day the suite runs. The snapshot fixture
 * trueup-draw-unfunded is the second plan.
 *
 * Usage:  node tests/trueup-withholding-conservation.mjs   (from src/)
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
import { runPlan } from '../js/mcp/run-plan.js';
import { InstrumentType } from '../js/instruments/instrument.js';
import { Metric } from '../js/metric.js';
import { EventType } from '../js/sim-event.js';
import { logger, LogCategory } from '../js/utils/logger.js';

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

const TOL = 0.01;

// ── Plans ─────────────────────────────────────────────────────────────

const START = { year: 2026, month: 1 };
const END = { year: 2027, month: 12 };
const CLOSE = { year: 2026, month: 6 };   // closes on 2026-07-01

const asset = (x) => ({
  startDateInt: START, finishDateInt: END, annualReturnRate: { rate: 0 }, ...x,
});
const everyday = (instrument, displayName, amount) => asset({
  instrument, displayName, startCurrency: { amount }, startBasisCurrency: { amount } });

function plan(accounts) {
  return {
    name: 'true-up',
    settings: { filingAs: 'Single', startAge: 62, retirementAge: 60, finishAge: 64 },
    modelAssets: [
      asset({ instrument: '401K', displayName: '401K',
        startCurrency: { amount: 300000 }, startBasisCurrency: { amount: 0 },
        finishDateInt: CLOSE,
        fundTransfers: [{ toDisplayName: 'Roth IRA', monthlyMoveValue: 0, closeMoveValue: 100 }] }),
      asset({ instrument: 'rothIRA', displayName: 'Roth IRA',
        startCurrency: { amount: 1000 }, startBasisCurrency: { amount: 0 } }),
      ...accounts,
    ],
    lifeEvents: [],
    guardrailParams: null,
  };
}

/** Run through the headless seam, keeping the engine's own SANITY verdict. */
async function run(spec) {
  logger.enable(LogCategory.SANITY);
  const cap = logger.capture(LogCategory.SANITY);
  const { portfolio } = await runPlan(spec);
  cap.stop();
  logger.disable(LogCategory.SANITY);
  return { portfolio, sanity: cap.lines.map((l) => l.message) };
}

/** 'YYYY-MM' of the run's i-th month, as events print their dateInt. */
function monthAt(portfolio, i) {
  const month = portfolio.firstDateInt.year * 12 + (portfolio.firstDateInt.month - 1) + i;
  return `${Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, '0')}`;
}

const allEvents = (portfolio) => portfolio.modelAssets.flatMap((a) => a.events);

// ── The views ─────────────────────────────────────────────────────────

/**
 * Δ(balance-sheet assets) − federal tax booked. The plans have no wages and
 * no expenses, so tax is the only flow. The last year's true-up runs after
 * the last monthly snapshot, so it is still in `portfolio.monthly`.
 */
function ledgerResidual(portfolio) {
  const delta = portfolio.modelAssets
    .filter((a) => InstrumentType.isAsset(a.instrument))
    .reduce((s, a) => s + a.finishCurrency.amount - a.startCurrency.amount, 0);
  const t = portfolio.total;
  const flows = t.employedIncome.amount + t.selfIncome.amount + t.expense.amount
    + t.federalTaxes().amount + portfolio.monthly.federalTaxes().amount;
  return delta - flows;
}

/** A cash event that paid income tax: a withholding debit, or a spill that paid one. */
const paidIncomeTax = (e) => e.type === EventType.INCOME_TAX_WITHHOLDING
  || (e.type === EventType.SPILLOVER && e.data?.cause === EventType.INCOME_TAX_WITHHOLDING);

/** Months whose booked income tax differs from what the accounts paid. */
function bookedVersusPaid(portfolio) {
  const events = allEvents(portfolio);
  const gaps = [];
  portfolio.monthlyPackages.forEach((pkg, i) => {
    const label = monthAt(portfolio, i);
    const paid = events.filter((e) => paidIncomeTax(e) && String(e.dateInt) === label)
      .reduce((s, e) => s + e.amount.amount, 0);
    if (Math.abs(paid - pkg.incomeTax.amount) > TOL) {
      gaps.push(`${label}: booked ${fmt(pkg.incomeTax.amount)}, paid ${fmt(paid)}`);
    }
  });
  return gaps;
}

/**
 * Months whose accounts' ESTIMATED_INCOME_TAX does not add up to the
 * household's income tax plus settlement. History is rounded to the cent, so
 * the tolerance allows one cent per account.
 */
function accountsVersusHousehold(portfolio) {
  const gaps = [];
  portfolio.monthlyPackages.forEach((pkg, i) => {
    const accounts = portfolio.modelAssets
      .reduce((s, a) => s + ((a.getHistory(Metric.ESTIMATED_INCOME_TAX) ?? [])[i] ?? 0), 0);
    const household = pkg.incomeTax.amount + pkg.taxTrueUp.amount;
    if (Math.abs(accounts - household) > TOL * portfolio.modelAssets.length) {
      gaps.push(`${monthAt(portfolio, i)}: accounts ${fmt(accounts)}, household ${fmt(household)}`);
    }
  });
  return gaps;
}

const unfundedTax = (portfolio) => -allEvents(portfolio)
  .filter((e) => e.type === EventType.UNFUNDED && e.data?.cause === 'Income tax withholding')
  .reduce((s, e) => s + e.amount.amount, 0);

const incomeTaxFindings = (sanity) => sanity.filter((m) => m.includes(' Income tax: events='));

// ── Scenarios ─────────────────────────────────────────────────────────

// The 2026 liability on $300,000 of ordinary income, Single: tax on $283,900
// after the standard deduction. The close withholds $73,769.25 from
// the 401(k) itself; the everyday accounts pay the rest of what they can.
const OWED_2026 = 68134.25;
const CLOSE_WITHHELD = 73769.25;

const SCENARIOS = [
  {
    label: 'Checking alone, too small to pay the draw',
    accounts: [everyday('bank', 'Checking', 2000)],
    paid: 2000,
    unfunded: 31064.10,
  },
  {
    label: 'Wallet, then Checking: the fallback clamps too',
    accounts: [everyday('cash', 'Wallet', 1000), everyday('bank', 'Checking', 2000)],
    paid: 3000,
    unfunded: 30064.10,
  },
  {
    label: 'Wallet, then Checking: the fallback covers the spill',
    accounts: [everyday('cash', 'Wallet', 1000), everyday('bank', 'Checking', 100000)],
    paid: 33064.10,
    unfunded: 0,
  },
  {
    label: 'Checking covers the draw',
    accounts: [everyday('bank', 'Checking', 100000)],
    paid: 33064.10,
    unfunded: 0,
  },
];

for (const scenario of SCENARIOS) {
  console.log(`\n── ${scenario.label} ──\n`);

  const { portfolio, sanity } = await run(plan(scenario.accounts));

  check('ledger: Δbalances == federal tax booked (no money created)', () => {
    const r = ledgerResidual(portfolio);
    assert.ok(Math.abs(r) < TOL, `residual ${fmt(r)}: money appeared or vanished`);
  });

  check('each month books the income tax the accounts paid', () => {
    const gaps = bookedVersusPaid(portfolio);
    assert.ok(gaps.length === 0, gaps.slice(0, 3).join('; '));
  });

  check('the engine reports no income-tax mismatch', () => {
    const found = incomeTaxFindings(sanity);
    assert.ok(found.length === 0, found.join('; '));
  });

  check('the accounts\' tax metrics add up to the household\'s', () => {
    const gaps = accountsVersusHousehold(portfolio);
    assert.ok(gaps.length === 0, gaps.slice(0, 3).join('; '));
  });

  check('the shortfall is still reported unfunded', () => {
    const u = unfundedTax(portfolio);
    assert.ok(Math.abs(u - scenario.unfunded) < TOL,
      `unfunded ${fmt(u)}, expected ${fmt(scenario.unfunded)}`);
  });

  check('the 2026 refund is what was paid minus what was owed', () => {
    const year = portfolio.taxYears.find((y) => y.year === 2026);
    assert.ok(Math.abs(year.incomeTax - OWED_2026) < TOL,
      `owed ${fmt(year.incomeTax)}, expected ${fmt(OWED_2026)}`);
    const expected = CLOSE_WITHHELD + scenario.paid - OWED_2026;
    assert.ok(Math.abs(year.settledTrueUp - expected) < TOL,
      `refunded ${fmt(year.settledTrueUp)}, expected ${fmt(expected)}`);
  });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
