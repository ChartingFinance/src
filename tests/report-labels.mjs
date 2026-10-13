/**
 * report-labels.mjs — each report is labelled and found by the period it holds.
 *
 * ── Why ──────────────────────────────────────────────────────────────
 *
 * monthlyChron runs after the clock steps, so a monthly report's `dateLabel`
 * is the first of the FOLLOWING month. The Reports panel showed that label and
 * matched the timeline cursor against it, so selecting March opened February's
 * report and the plan's first month opened nothing.
 *
 * ── What is asserted ─────────────────────────────────────────────────
 *
 *   EVERY MONTH    across the snapshot corpus, the monthly reports cover the
 *                  plan's months in order, starting at its first month.
 *   SAME CONTENT   the report covering a month holds that month's income, as
 *                  the month's metric history (what Month Details and the
 *                  spreadsheet show) records it. The corpus must reach a month
 *                  whose income differs from the month before, or a label one
 *                  month off would pass.
 *   THE CURSOR     monthlyReportIndex finds the report covering the month asked
 *                  for, and nothing for a month outside the plan.
 *   HEADINGS       a report is headed by the month or year it covers.
 *
 * Run: node tests/report-labels.mjs   (from src/)
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
const { metricAtIndex } = await import('../js/month-summary.js');
const { DateInt } = await import('../js/utils/date-int.js');
const { coverLabel, monthlyReportIndex } = await import('../js/components/report-view.js');
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

const monthAt = (first, i) => { const d = first.copy(); d.addMonths(i); return d.toString(); };

let incomeChanges = 0;

console.log('\n── Monthly reports are labelled by the month they hold ──\n');

for (const fixture of SNAPSHOT_FIXTURES) {
  const p = await runFixture(fixture);
  const first = DateInt.from(p.firstDateInt.year, p.firstDateInt.month);
  const monthly = p.generatedReports.filter((r) => r.type === 'monthly');

  await check(`${fixture.name}: monthly reports cover the plan's months in order`, () => {
    assert.ok(monthly.length > 0, 'no monthly reports');
    monthly.forEach((r, i) => assert.equal(r.coversMonth, monthAt(first, i), `report ${i}`));
  });

  await check(`${fixture.name}: the report covering a month holds that month's income`, () => {
    monthly.forEach((r, i) => {
      const recorded = metricAtIndex(p, Metric.INCOME, i);
      // Within cents: the history sums per-asset figures each rounded to the cent.
      assert.ok(Math.abs(r.pkg.totalIncome().amount - recorded) < 0.05,
        `${r.coversMonth}: report ${r.pkg.totalIncome().amount.toFixed(2)}, history ${recorded.toFixed(2)}`);
      if (i > 0 && Math.abs(recorded - metricAtIndex(p, Metric.INCOME, i - 1)) >= 1) incomeChanges++;
    });
  });

  await check(`${fixture.name}: the cursor finds the report for its month, and only that one`, () => {
    monthly.forEach((r, i) => {
      const d = DateInt.parse(monthAt(first, i));
      const found = p.generatedReports[monthlyReportIndex(p.generatedReports, d.year, d.month)];
      assert.equal(found, r, `${d.toString()} found ${found?.coversMonth}`);
    });
    const before = first.copy(); before.prevMonth();
    assert.equal(monthlyReportIndex(p.generatedReports, before.year, before.month), -1,
      `${before.toString()} is before the plan`);
  });

  await check(`${fixture.name}: each report is headed by the period it covers`, () => {
    for (const r of p.generatedReports) {
      assert.equal(coverLabel(r), r.type === 'yearly' ? String(r.coversYear) : r.coversMonth);
    }
  });
}

await check('some month\'s income differs from the month before, so the content check can fail', () => {
  assert.ok(incomeChanges > 0, 'income never changes month to month across the corpus');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
