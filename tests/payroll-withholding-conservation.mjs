/**
 * payroll-withholding-conservation.mjs
 *
 * A paycheck pays out exactly what it earns: FICA, then income-tax
 * withholding, then pre-tax deferrals from what is left, then take-home pay.
 *
 * It used to pay out more in two ways, and both created money:
 *
 *   withholding  Payroll sizes the household withholding from the month's
 *                income ×12. A 401(k) that closes mid-plan books its whole
 *                balance as income on day 1, before payroll runs, so in that
 *                month the estimate dwarfs the salary. Net pay was clamped to
 *                $0 but the full estimate stayed booked as withheld, and the
 *                true-ups refunded the uncollected part in cash: $140,383.19 on
 *                the cash-out plan below, exactly the amount the clamp hid.
 *   deferrals    The annual limit was a deferral's only cap, so one January
 *                paycheck could defer the whole year's limit and the 401(k) was
 *                credited money the paycheck never paid: $88,373.90 over five
 *                years at a 200% deferral, $23,222.56 even at 100%.
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
 * The cash-out scenarios vary what the paycheck has left once FICA and taxes
 * are out: a plain salary, one whose traditional IRA deferral the close month
 * displaces, a self-employed one (estimated tax, the sibling metric), and two
 * earners whose shares of the household tax are capped separately. One more
 * ends the salary before the close month: nothing to over-withhold from, so it
 * held before the fix, and it shows the measurement itself is sound.
 *
 * The deferral scenarios close nothing. Beyond conservation they check that a
 * cut delays the year's contributions rather than losing them, and that every
 * dollar a transfer asked for either arrived or is recorded as a cap.
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
import { EventType, PAY_LEFT_AFTER_TAXES } from '../js/sim-event.js';
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
  const { portfolio, issues } = await runPlan(spec);
  cap.stop();
  logger.disable(LogCategory.SANITY);
  return { portfolio, issues, sanity: cap.lines.map((l) => l.message) };
}

/** 'YYYY-MM' of the run's i-th month, as events print their dateInt. */
function monthAt(portfolio, i) {
  const month = portfolio.firstDateInt.year * 12 + (portfolio.firstDateInt.month - 1) + i;
  return `${Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, '0')}`;
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
      const label = monthAt(portfolio, i);
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
    // Paying the deferral first would conserve money too, so conservation
    // cannot tell the order apart. Real payroll withholds tax first.
    extra: (cash) => check('taxes come first: the close month displaces the IRA deferral', () => {
      const inMonth = (name, type) => cash.portfolio.modelAssets.find((a) => a.displayName === name)
        .events.filter((e) => e.type === type && String(e.dateInt) === '2027-07')
        .reduce((s, e) => s + e.amount.amount, 0);
      const deferred = inMonth('IRA', EventType.TRANSFER);
      assert.ok(Math.abs(deferred) < TOL, `the IRA received ${fmt(deferred)} in the close month`);
      const withheld = -inMonth('Salary', EventType.INCOME_TAX_WITHHOLDING);
      assert.ok(Math.abs(withheld - (6000 - 459)) < TOL,
        `withheld ${fmt(withheld)}; expected all pay after FICA, $5,541.00`);
    }),
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

  scenario.extra?.(cash);
}

// ── Deferrals larger than the paycheck ───────────────────────────────

/** The salary's 401(k) deferral, by percent of pay. Nothing closes. */
const deferring = (amount, pct) => plan({ cashOut: false, earners: [salary('Salary', amount, {
  fundTransfers: [{ toDisplayName: '401K', monthlyMoveValue: pct, closeMoveValue: 0 }] })] });

/** Money that reached the 401(k) from payroll, by month and by year. */
function deposits(portfolio) {
  const k = portfolio.modelAssets.find((a) => a.displayName === '401K');
  const byMonth = {};
  for (const e of k.events) {
    if (e.type !== EventType.TRANSFER || e.data?.from !== 'Salary') continue;
    byMonth[String(e.dateInt)] = (byMonth[String(e.dateInt)] ?? 0) + e.amount.amount;
  }
  const byYear = {};
  for (const [m, v] of Object.entries(byMonth)) byYear[m.slice(0, 4)] = (byYear[m.slice(0, 4)] ?? 0) + v;
  return { byMonth, byYear, caps: k.events.filter((e) => e.type === EventType.CONTRIBUTION_CAPPED) };
}

// A paycheck big enough to defer the whole limit at once: it caps only at the
// limit, so its yearly deposits are the limit.
const roomy = await run(deferring(100000, 200));

for (const pct of [200, 100]) {
  console.log(`\n── a 401(k) deferral of ${pct}% of a $10,000 salary ──\n`);
  const d = await run(deferring(10000, pct));

  check('every paycheck pays out exactly what it earned', () => {
    const gaps = paycheckGaps(d.portfolio);
    assert.ok(gaps.length === 0, gaps.slice(0, 3).join('; '));
  });

  check('ledger: Δbalances == wages + expenses + federal tax booked', () => {
    const r = ledgerResidual(d.portfolio);
    assert.ok(Math.abs(r) < TOL, `residual ${fmt(r)}: money appeared or vanished`);
  });

  check('the engine reports no net-pay clamp', () => {
    const found = clampFindings(d.sanity);
    assert.ok(found.length === 0, found.join('; '));
  });

  check('a cut delays the year\'s contributions; it does not lose them', () => {
    const got = deposits(d.portfolio).byYear;
    const limit = deposits(roomy.portfolio).byYear;
    for (const [year, v] of Object.entries(limit)) {
      assert.ok(Math.abs((got[year] ?? 0) - v) < TOL,
        `${year}: ${fmt(got[year] ?? 0)} deposited, the limit is ${fmt(v)}`);
    }
    const jan = deposits(d.portfolio).byMonth['2026-01'] ?? 0;
    assert.ok(jan < limit['2026'] - TOL,
      `January deposited ${fmt(jan)}, the whole limit: nothing was cut`);
  });

  check('every dollar asked for arrived or is recorded as a cap', () => {
    const { byMonth, caps } = deposits(d.portfolio);
    const salaryAsset = d.portfolio.modelAssets.find((a) => a.displayName === 'Salary');
    const gross = salaryAsset.getHistory(Metric.EMPLOYED_INCOME) ?? [];
    const off = [];
    for (let i = 0; i < gross.length; i++) {
      const m = monthAt(d.portfolio, i);
      const asked = gross[i] * pct / 100;
      const capped = caps.filter((e) => String(e.dateInt) === m).reduce((s, e) => s + e.amount.amount, 0);
      if (Math.abs(asked + capped - (byMonth[m] ?? 0)) > TOL) {
        off.push(`${m}: asked ${fmt(asked)}, capped ${fmt(capped)}, arrived ${fmt(byMonth[m] ?? 0)}`);
      }
    }
    assert.ok(off.length === 0, off.slice(0, 3).join('; '));
    assert.ok(caps.some((e) => e.data?.limitName === PAY_LEFT_AFTER_TAXES),
      'no cap names the pay left after taxes');
  });

  check('the issue panel names the paycheck as the reason', () => {
    const issue = d.issues.find((i) => i.id === 'contribution-capped' && i.assetName === '401K');
    assert.ok(issue, `no contribution-capped issue on the 401K, got [${d.issues.map((i) => i.id)}]`);
    assert.match(issue.detail, /pay left after taxes/, issue.detail);
  });
}

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
