/**
 * cash-flow-uniform.mjs — Cash Flow means one thing everywhere.
 *
 * ── Why ──────────────────────────────────────────────────────────────
 *
 * Three places showed a "Cash Flow" and they disagreed. The per-account metric
 * (Projections, Spreadsheet, the timeline badge) had a rule per instrument and
 * left out the tax withheld on retirement withdrawals. Month & Year Details
 * counted those withdrawals as income, so a retiree drawing down savings showed
 * a large positive cash flow. Reports had the rule now used everywhere:
 *
 *     cash flow = income received − expenses − taxes
 *
 * Income received is money from outside the household's accounts (wages,
 * Social Security, pensions, interest, dividends). Expenses include the whole
 * mortgage payment. Taxes are every tax booked.
 *
 * ── What is asserted ─────────────────────────────────────────────────
 *
 *   EACH ACCOUNT   every month, each account's Cash Flow is that rule applied
 *                  to its own metrics, closing month included.
 *   THE HOUSEHOLD  every month, the accounts add up to the month's package
 *                  cash flow (Reports), and Month & Year Details shows it.
 *   EACH YEAR      a yearly report's Income Received, Expenses, Taxes and
 *                  Cash Flow are the section's year row, and its rows add up.
 *   NOT VACUOUS    the corpus reaches withdrawals counted in Income, mortgage
 *                  principal, and an account's flows in the month it closed.
 *
 * Run: node tests/cash-flow-uniform.mjs   (from src/)
 */

import assert from 'node:assert/strict';

// quick-start profiles date their assets from `new Date()`.
const RealDate = Date;
const PINNED = new RealDate(2026, 0, 15);
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(PINNED.getTime());
    else super(...args);
  }
  static now() { return PINNED.getTime(); }
};

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

const G = await import('../js/globals.js');
const { simConfigFromGlobals } = G;
const { Portfolio } = await import('../js/portfolio.js');
const { chronometer_run } = await import('../js/chronometer.js');
const { Metric } = await import('../js/metric.js');
const { RECEIVED_INCOME_METRICS } = await import('../js/instruments/instrument-behavior.js');
const { monthSummary, yearSummary } = await import('../js/month-summary.js');
const { reportRows } = await import('../js/components/report-view.js');
const { SNAPSHOT_FIXTURES } = await import('./tools/fixtures.mjs');

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

/** The snapshot harness's configuration for a fixture, then a run with reports on. */
async function runFixture(fixture) {
  G.global_reset();
  G.global_setAllocateHouseholdTax(false);
  G.global_setBacktestYearDirect?.('current');
  const c = fixture.config ?? {};
  if (c.startAge != null) { G.global_setUserStartAge(c.startAge); G.global_getUserStartAge(); }
  if (c.retirementAge != null) { G.global_setUserRetirementAge(c.retirementAge); G.global_getUserRetirementAge(); }
  if (c.finishAge != null) { G.global_setUserFinishAge(c.finishAge); G.global_getUserFinishAge?.(); }
  if (c.filingAs != null) { G.global_setFilingAs(c.filingAs); G.global_getFilingAs(); }

  const built = fixture.build();
  const portfolio = new Portfolio(built.assets, true, simConfigFromGlobals());
  if (built.lifeEvents) portfolio.lifeEvents = built.lifeEvents;
  if (built.guardrails) portfolio.guardrailsParams = built.guardrails;
  await chronometer_run(portfolio);
  return portfolio;
}

const at = (asset, metric, i) => (asset.getHistory(metric) ?? [])[i] ?? 0;
/** A formatted amount back to a number: "−$1,234.50" → -1234.5. */
const amountOf = (s) => Number(s.replace('−', '-').replace(/[$,]/g, ''));
const reached = { withdrawals: 0, principal: 0, closingMonth: 0 };

for (const fixture of SNAPSHOT_FIXTURES) {
  const p = await runFixture(fixture);
  const months = p.monthlyPackages.length;
  const first = p.firstDateInt;
  const dateAt = (i) => { const d = first.copy(); d.addMonths(i); return d; };

  await check(`${fixture.name}: each account's Cash Flow is the rule, every month`, () => {
    for (const a of p.modelAssets) {
      const len = (a.getHistory(Metric.VALUE) ?? []).length;
      for (let i = 0; i < len; i++) {
        let want = 0;
        for (const m of RECEIVED_INCOME_METRICS) want += at(a, m, i);
        want += at(a, Metric.EXPENSE, i) + at(a, Metric.MORTGAGE_PRINCIPAL, i) + at(a, Metric.TAXES, i);
        const got = at(a, Metric.CASH_FLOW, i);
        // Within cents: the history rounds the sum, the rule's parts are rounded too.
        assert.ok(Math.abs(got - want) < 0.015, `${a.displayName} month ${i}: ${got.toFixed(2)}, rule ${want.toFixed(2)}`);
        if (a.isClosed && a.finishDateInt && dateAt(i).equals(a.finishDateInt) && Math.abs(got) >= 1) reached.closingMonth++;
        if (Math.abs(at(a, Metric.MORTGAGE_PRINCIPAL, i)) >= 1) reached.principal++;
      }
    }
  });

  await check(`${fixture.name}: the accounts add up to the Reports' cash flow, and the section shows it`, () => {
    for (let i = 0; i < months; i++) {
      const pkg = p.monthlyPackages[i];
      let accounts = 0;
      for (const a of p.modelAssets) accounts += at(a, Metric.CASH_FLOW, i);
      const want = pkg.cashFlow().amount;
      assert.ok(Math.abs(accounts - want) < 0.05, `month ${i}: accounts ${accounts.toFixed(2)}, package ${want.toFixed(2)}`);

      const d = dateAt(i);
      const s = monthSummary(p, d.year, d.month);
      assert.ok(Math.abs(s.cashFlow - want) < 0.05, `month ${i}: section ${s.cashFlow.toFixed(2)}, package ${want.toFixed(2)}`);
      assert.ok(Math.abs(s.income - pkg.cashInFlow().amount) < 0.05, `month ${i}: income received`);
      assert.ok(Math.abs(s.expense - pkg.cashExpenses().amount) < 0.05, `month ${i}: expenses`);
      if (pkg.totalIncome().amount - pkg.cashInFlow().amount >= 1) reached.withdrawals++;
    }
  });

  await check(`${fixture.name}: each yearly report's cash-flow rows are the section's year, and add up`, () => {
    for (const r of p.generatedReports.filter((x) => x.type === 'yearly')) {
      const y = yearSummary(p, r.coversYear);
      const shown = new Map(reportRows(r, p.taxYears));
      const tol = 0.05 * y.months;
      const near = (label, want) => assert.ok(Math.abs(amountOf(shown.get(label)) - want) <= tol,
        `${r.coversYear} ${label.trim()}: report ${shown.get(label)}, section ${want.toFixed(2)}`);
      near('Cash Flow', y.cashFlow);
      near('  Income Received', y.income);
      near('    Taxes', y.taxes);
      near('    Expenses', y.expense);
      const sum = (...labels) => labels.reduce((t, l) => t + amountOf(shown.get(l)), 0);
      assert.ok(Math.abs(sum('  Income Received', '  Cash Out') - amountOf(shown.get('Cash Flow'))) <= 0.02, `${r.coversYear} cash flow rows`);
      assert.ok(Math.abs(sum('    Taxes', '    Expenses') - amountOf(shown.get('  Cash Out'))) <= 0.02, `${r.coversYear} cash out rows`);
    }
  });
}

await check('the corpus reaches withdrawals in Income, mortgage principal, and a closing month', () => {
  for (const [what, n] of Object.entries(reached)) assert.ok(n > 0, `nothing reaches ${what}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
