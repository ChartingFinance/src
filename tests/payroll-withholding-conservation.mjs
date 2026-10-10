/**
 * payroll-withholding-conservation.mjs
 *
 * A paycheck can only withhold what it pays.
 *
 * Payroll sizes the household's income-tax withholding from the month's
 * income ×12. A 401(k) that closes mid-plan books its whole balance as income
 * on day 1, before payroll runs, so in that month the estimate dwarfs the
 * salary. Net pay was clamped to $0, but the full estimate was still booked as
 * withheld. The true-ups then counted the uncollected part as paid and refunded
 * it in cash, so money was created: on the cash-out plan below, $140,383.19,
 * exactly the amount the clamp hid.
 *
 * Three views of the same law, from the inside out:
 *
 *   paycheck  each month, what a working-income asset paid out (FICA, pre-tax
 *             deferrals, income-tax withholding, take-home pay) equals what it
 *             earned. A clamp is a paycheck paying out more than it earned.
 *   ledger    over the whole run, the change in balances equals wages plus
 *             expenses plus every federal tax the books recorded.
 *   control   cashing out $400,000 of pre-tax money costs exactly the extra
 *             tax: (cash-out − control) balances + (cash-out − control)
 *             lifetime federal tax == $0.
 *
 * The scenarios vary what the paycheck has left once FICA and deferrals are
 * out: a plain salary, one with a traditional IRA deferral, a self-employed
 * one (estimated tax, the sibling metric), and two earners whose shares of the
 * household tax are capped separately. One more ends the salary before the
 * close month: nothing to over-withhold from, so it held before the fix, and it
 * shows the measurement itself is sound.
 *
 * Every rate is zero and every date explicit, so the numbers are exact and do
 * not depend on the day the suite runs.
 *
 * Usage:  node tests/payroll-withholding-conservation.mjs   (from src/)
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
const END = { year: 2030, month: 12 };
const CLOSE = { year: 2027, month: 6 };   // closes on 2027-07-01, mid-plan

const asset = (x) => ({
  startDateInt: START, finishDateInt: END, annualReturnRate: { rate: 0 }, ...x,
});
const salary = (displayName, amount, x = {}) => asset({
  instrument: 'workingIncome', displayName,
  startCurrency: { amount }, startBasisCurrency: { amount: 0 }, ...x });

/**
 * The plan that found it: a $400,000 401(k) cashed out to Checking while a
 * $6,000 salary is still paid. `cashOut: false` is the control, the same
 * household with the 401(k) left alone.
 */
function plan({ cashOut = true, filingAs = 'Single', earners = [salary('Salary', 6000)] } = {}) {
  return {
    name: cashOut ? 'cash-out' : 'control',
    settings: { filingAs, startAge: 60, retirementAge: 67, finishAge: 65 },
    modelAssets: [
      ...earners,
      asset({ instrument: 'bank', displayName: 'Checking',
        startCurrency: { amount: 400000 }, startBasisCurrency: { amount: 400000 } }),
      asset({ instrument: 'monthlyExpense', displayName: 'Living',
        startCurrency: { amount: -4000 }, startBasisCurrency: { amount: 0 } }),
      asset({ instrument: 'ira', displayName: 'IRA',
        startCurrency: { amount: 1000 }, startBasisCurrency: { amount: 0 } }),
      asset({ instrument: '401K', displayName: '401K',
        startCurrency: { amount: 400000 }, startBasisCurrency: { amount: 0 },
        ...(cashOut ? {
          finishDateInt: CLOSE,
          fundTransfers: [{ toDisplayName: 'Checking', monthlyMoveValue: 0, closeMoveValue: 100 }],
        } : {}) }),
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

// ── The three views ───────────────────────────────────────────────────

/**
 * Months in which a working-income asset paid out more or less than it
 * earned. Its events in a month are all outflows (FICA, withholding, the
 * pre-tax and take-home transfers), and gross pay is its income metric for
 * that month.
 */
function paycheckGaps(portfolio) {
  const gaps = [];
  for (const earner of portfolio.modelAssets) {
    if (!InstrumentType.isWorkingIncome(earner.instrument)) continue;
    const metric = earner.isSelfEmployed ? Metric.SELF_INCOME : Metric.EMPLOYED_INCOME;
    const gross = earner.getHistory(metric) ?? [];
    const months = portfolio.monthlyPackages.length;
    for (let i = 0; i < months; i++) {
      const month = portfolio.firstDateInt.year * 12 + (portfolio.firstDateInt.month - 1) + i;
      const label = `${Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, '0')}`;
      const paidOut = -earner.events
        .filter((e) => String(e.dateInt) === label)
        .reduce((s, e) => s + e.amount.amount, 0);
      const earned = gross[i] ?? 0;
      if (Math.abs(paidOut - earned) > TOL) {
        gaps.push(`${earner.displayName} ${label}: earned ${fmt(earned)}, paid out ${fmt(paidOut)}`);
      }
    }
  }
  return gaps;
}

/**
 * Δ(balance-sheet assets) − (wages + expenses + federal tax booked). Zero when
 * the books and the balances tell the same story. The last year's true-up runs
 * after the last monthly snapshot, so it is still in `portfolio.monthly`.
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

const balances = (p) => p.modelAssets
  .filter((a) => InstrumentType.isAsset(a.instrument))
  .reduce((s, a) => s + a.finishCurrency.amount, 0);

/** Federal tax paid over the plan, positive, from the yearly reports. */
const lifetimeTax = (p) => -p.generatedReports
  .filter((r) => r.type === 'yearly')
  .reduce((s, r) => s + r.pkg.federalTaxes().amount, 0);

const clampFindings = (sanity) => sanity.filter((m) => m.includes('clamped to $0'));

// ── Scenarios ─────────────────────────────────────────────────────────

const SCENARIOS = [
  {
    label: 'salary, cashed-out 401(k)',
    build: (cashOut) => plan({ cashOut }),
  },
  {
    label: 'salary with a 10% traditional IRA deferral, cashed-out 401(k)',
    build: (cashOut) => plan({ cashOut, earners: [salary('Salary', 6000, {
      fundTransfers: [{ toDisplayName: 'IRA', monthlyMoveValue: 10, closeMoveValue: 0 }] })] }),
  },
  {
    label: 'self-employed income, cashed-out 401(k)',
    build: (cashOut) => plan({ cashOut, earners: [salary('Consulting', 6000, { isSelfEmployed: true })] }),
  },
  {
    label: 'two earners (MFJ), cashed-out 401(k)',
    build: (cashOut) => plan({ cashOut, filingAs: 'MFJ',
      earners: [salary('Salary A', 6000), salary('Salary B', 1500)] }),
  },
  {
    label: 'salary ends before the close month (nothing to over-withhold)',
    build: (cashOut) => plan({ cashOut,
      earners: [salary('Salary', 6000, { finishDateInt: { year: 2027, month: 5 } })] }),
  },
];

for (const scenario of SCENARIOS) {
  console.log(`\n── ${scenario.label} ──\n`);

  const cash = await run(scenario.build(true));
  const ctrl = await run(scenario.build(false));

  check('every paycheck pays out exactly what it earned', () => {
    const gaps = paycheckGaps(cash.portfolio);
    assert.ok(gaps.length === 0, gaps.slice(0, 3).join('; '));
  });

  check('ledger: Δbalances == wages + expenses + federal tax booked', () => {
    const r = ledgerResidual(cash.portfolio);
    assert.ok(Math.abs(r) < TOL, `residual ${fmt(r)}: money appeared or vanished`);
  });

  check('control: cashing out costs exactly the extra tax', () => {
    const dBalances = balances(cash.portfolio) - balances(ctrl.portfolio);
    const dTax = lifetimeTax(cash.portfolio) - lifetimeTax(ctrl.portfolio);
    const r = dBalances + dTax;
    assert.ok(Math.abs(r) < TOL,
      `Δbalances ${fmt(dBalances)} + Δtax ${fmt(dTax)} = ${fmt(r)}, expected $0.00`);
  });

  check('the control plan conserves too', () => {
    const r = ledgerResidual(ctrl.portfolio);
    assert.ok(Math.abs(r) < TOL, `control residual ${fmt(r)}`);
  });

  check('the engine reports no net-pay clamp', () => {
    const found = clampFindings(cash.sanity);
    assert.ok(found.length === 0, found.join('; '));
  });
}

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
