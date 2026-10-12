/**
 * report-agi-rows.mjs — a yearly report shows the year's recorded AGI and MAGI.
 *
 * ── Why ──────────────────────────────────────────────────────────────
 *
 * Portfolio.taxYears records AGI and every MAGI once per settled year, and
 * Reports is where a person reads them. The rows are hardcoded in
 * report-view.js, like the rest of that table, so nothing connects them to the
 * record except this test. Three ways they can be wrong with every total right:
 * matching the report's dated year instead of the year it covers, reading the
 * wrong MagiPurpose, and showing a monthly figure that is not a year.
 *
 * ── What is asserted ─────────────────────────────────────────────────
 *
 *   EVERY YEAR     across the snapshot corpus, each yearly report shows the
 *                  record for the year it covers, and every report finds one.
 *   EACH PURPOSE   each row shows its own MagiPurpose. NIIT, IRMAA and the
 *                  senior deduction share a row, so they must be equal in every
 *                  year. The corpus must reach a year where each separate row
 *                  differs from AGI and from its neighbour, or reading the wrong
 *                  purpose would pass.
 *   YEARLY ONLY    a monthly report has none of the rows.
 *   NO RECORD      a yearly report with no record shows dashes, not $0.00.
 *
 * Run: node tests/report-agi-rows.mjs   (from src/)
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
const { MagiPurpose } = await import('../js/tax-basis.js');
const { formatCurrency } = await import('../js/utils/html.js');
const { runPlan } = await import('../js/mcp/run-plan.js');
const { reportRows } = await import('../js/components/report-view.js');
const { SNAPSHOT_FIXTURES } = await import('./tools/fixtures.mjs');

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

const AGI = 'Adjusted Gross Income (AGI)';
const SHARED = '  MAGI (NIIT, IRMAA, Senior Deduction)';
const IRA = '  MAGI (IRA Deduction)';
const ROTH = '  MAGI (Roth Contribution)';
const ACA = '  MAGI (ACA Premium Credit)';
const LABELS = [AGI, SHARED, IRA, ROTH, ACA];

const money = (n) => formatCurrency(n, { cents: true });

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

/** Years where a row's figure differs from AGI, or from its neighbour, by a cent or more. */
const reached = { ira: 0, roth: 0, rothVsIra: 0, aca: 0 };

async function checkPortfolio(name, p) {
  const yearly = p.generatedReports.filter((r) => r.type === 'yearly');
  const monthly = p.generatedReports.filter((r) => r.type === 'monthly');

  await check(`${name}: every yearly report covers a recorded year, and only those`, () => {
    assert.ok(yearly.length > 0, 'no yearly reports');
    assert.deepEqual(yearly.map((r) => r.coversYear), p.taxYears.map((t) => t.year));
  });

  await check(`${name}: each yearly report shows the record for the year it covers`, () => {
    for (const r of yearly) {
      const t = p.taxYears.find((x) => x.year === r.coversYear);
      const shown = new Map(reportRows(r, p.taxYears));
      const where = `${r.dateLabel} (covers ${r.coversYear})`;
      assert.equal(shown.get(AGI), money(t.agi), `${where} AGI`);
      assert.equal(shown.get(SHARED), money(t.magi[MagiPurpose.NIIT]), `${where} NIIT`);
      assert.equal(shown.get(IRA), money(t.magi[MagiPurpose.IRA_DEDUCTION]), `${where} IRA`);
      assert.equal(shown.get(ROTH), money(t.magi[MagiPurpose.ROTH_CONTRIBUTION]), `${where} Roth`);
      assert.equal(shown.get(ACA), money(t.magi[MagiPurpose.ACA]), `${where} ACA`);

      if (money(t.magi[MagiPurpose.IRA_DEDUCTION]) !== money(t.agi)) reached.ira++;
      if (money(t.magi[MagiPurpose.ROTH_CONTRIBUTION]) !== money(t.agi)) reached.roth++;
      if (money(t.magi[MagiPurpose.ROTH_CONTRIBUTION]) !== money(t.magi[MagiPurpose.IRA_DEDUCTION])) reached.rothVsIra++;
      if (money(t.magi[MagiPurpose.ACA]) !== money(t.agi)) reached.aca++;
    }
  });

  await check(`${name}: NIIT, IRMAA and the senior deduction are equal every year, so one row is right`, () => {
    for (const t of p.taxYears) {
      assert.equal(t.magi[MagiPurpose.IRMAA], t.magi[MagiPurpose.NIIT], `${t.year} IRMAA`);
      assert.equal(t.magi[MagiPurpose.SENIOR_DEDUCTION], t.magi[MagiPurpose.NIIT], `${t.year} senior deduction`);
    }
  });

  await check(`${name}: a monthly report has no AGI or MAGI rows`, () => {
    assert.ok(monthly.length > 0, 'no monthly reports');
    for (const r of monthly) {
      const labels = reportRows(r, p.taxYears).map(([label]) => label);
      for (const l of LABELS) assert.ok(!labels.includes(l), `${r.dateLabel} shows "${l.trim()}"`);
    }
  });
}

// ── Every yearly report, every fixture ───────────────────────────────

console.log('\n── Yearly reports show the recorded year, across the corpus ──\n');

for (const fixture of SNAPSHOT_FIXTURES) {
  await checkPortfolio(fixture.name, await runFixture(fixture));
}

// The corpus has no Roth conversion; this plan converts on both paths.
const START = { year: 2026, month: 1 };
const END = { year: 2028, month: 12 };
const asset = (x) => ({
  startDateInt: START, finishDateInt: END, annualReturnRate: { rate: 0 }, ...x,
});
const { portfolio: conv } = await runPlan({
  name: 'conversions',
  settings: { filingAs: 'Single', startAge: 66, retirementAge: 65, finishAge: 69 },
  lifeEvents: [],
  modelAssets: [
    asset({ instrument: 'ira', displayName: 'IRA',
      startCurrency: { amount: 200000 }, startBasisCurrency: { amount: 0 },
      fundTransfers: [{ toDisplayName: 'Roth IRA', monthlyMoveValue: 1, closeMoveValue: 0 }] }),
    asset({ instrument: 'rothIRA', displayName: 'Roth IRA',
      startCurrency: { amount: 1000 }, startBasisCurrency: { amount: 1000 } }),
    asset({ instrument: 'bank', displayName: 'Checking',
      startCurrency: { amount: 150000 }, startBasisCurrency: { amount: 150000 } }),
    asset({ instrument: 'monthlyExpense', displayName: 'Living',
      startCurrency: { amount: -3000 }, startBasisCurrency: { amount: 0 } }),
  ],
});
await checkPortfolio('conversions', conv);

await check('some year has an IRA deduction MAGI that differs from AGI', () => {
  assert.ok(reached.ira > 0, 'the IRA row would pass reading AGI');
});
await check('some year has a Roth MAGI that differs from AGI and from the IRA figure', () => {
  assert.ok(reached.roth > 0, 'the Roth row would pass reading AGI');
  assert.ok(reached.rothVsIra > 0, 'the Roth row would pass reading the IRA figure');
});
await check('some year has an ACA MAGI that differs from AGI', () => {
  assert.ok(reached.aca > 0, 'the ACA row would pass reading AGI');
});

// ── Placement and a missing record ───────────────────────────────────

console.log('\n── Placement and a missing record ──\n');

const sample = conv.generatedReports.find((r) => r.type === 'yearly');

await check('the rows sit between deductions and federal taxes', () => {
  const labels = reportRows(sample, conv.taxYears).map(([label]) => label);
  const at = labels.indexOf(AGI);
  assert.equal(labels[at - 1], '  Property Tax (Deductible)');
  assert.deepEqual(labels.slice(at, at + LABELS.length), LABELS);
  assert.equal(labels[at + LABELS.length], 'Federal Taxes');
});

await check('a yearly report with no record shows dashes, not $0.00', () => {
  const shown = new Map(reportRows(sample, []));
  for (const l of LABELS) assert.equal(shown.get(l), '—', `"${l.trim()}"`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
