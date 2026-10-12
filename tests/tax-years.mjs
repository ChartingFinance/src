/**
 * tax-years.mjs — every settled year records its tax basis, AGI and each MAGI.
 *
 * ── Why ──────────────────────────────────────────────────────────────
 *
 * The annual pass measures a year's MAGI whether or not anything is charged on
 * it. Before Portfolio.taxYears, the only place it was written down was the
 * NIIT_ASSESSED event, so a household that never owed NIIT (most retirees)
 * had no MAGI anywhere. Every MAGI rule is annual, so the record is one frozen
 * TaxYear per settled year, written from the package the annual passes read.
 *
 * ── What is asserted ─────────────────────────────────────────────────
 *
 *   EVERY YEAR       across the whole snapshot corpus: one record per settled
 *                    year, contiguous, with the plan's months and ages, charged
 *                    or not. A plan ending mid-year leaves its last months
 *                    unsettled, so they have no record.
 *   THE SAME FIGURE  each NIIT_ASSESSED event carries the MAGI and NII the
 *                    record shows for that year, so the record is what the
 *                    charge measured, not a second calculation that could
 *                    drift from it.
 *   CONVERSIONS      the Roth contribution MAGI leaves out exactly what arrived
 *                    in the Roth from a traditional account, on both paths
 *                    that move it: a monthly transfer and a close.
 *   RE-RUNS          a second run of one Portfolio starts a fresh list, and
 *                    copy() carries the list.
 *
 * Run: node tests/tax-years.mjs   (from src/)
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
const { EventType } = await import('../js/sim-event.js');
const { MagiPurpose } = await import('../js/tax-basis.js');
const { runPlan } = await import('../js/mcp/run-plan.js');
const { SNAPSHOT_FIXTURES } = await import('./tools/fixtures.mjs');

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

/** The snapshot harness's configuration for a fixture, then a run. */
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
  const portfolio = new Portfolio(built.assets, false, simConfigFromGlobals());
  if (built.lifeEvents) portfolio.lifeEvents = built.lifeEvents;
  if (built.guardrails) portfolio.guardrailsParams = built.guardrails;
  await chronometer_run(portfolio);
  return portfolio;
}

/** The calendar years the run settled: up to the last full December. */
function settledYears(portfolio) {
  const first = portfolio.firstDateInt.year;
  const last = portfolio.lastDateInt.month === 12
    ? portfolio.lastDateInt.year : portfolio.lastDateInt.year - 1;
  const years = [];
  for (let y = first; y <= last; y++) years.push(y);
  return years;
}

const near = (got, want, what, tol = 1e-6) =>
  assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want}`);

// ── Every settled year, every fixture ────────────────────────────────

console.log('\n── One record per settled year, across the corpus ──\n');

let niitEvents = 0;
let niitEventsWithUntaxedSS = 0;
let recordsWithoutNIIT = 0;

for (const fixture of SNAPSHOT_FIXTURES) {
  const p = await runFixture(fixture);

  await check(`${fixture.name}: a record for each settled year, in order`, () => {
    const want = settledYears(p);
    assert.deepEqual(p.taxYears.map((t) => t.year), want);
    p.taxYears.forEach((t, i) => {
      assert.equal(t.months, p.monthsInPlanYear(t.year), `${t.year} months`);
      assert.equal(t.age, p.startUserAge + i, `${t.year} age`);
      assert.ok(Object.isFrozen(t) && Object.isFrozen(t.magi), `${t.year} is not frozen`);
      assert.deepEqual(Object.keys(t.magi).sort(), Object.values(MagiPurpose).sort());
      for (const v of [t.agi, ...Object.values(t.magi), t.netInvestmentIncome,
                       t.taxableSocialSecurity, t.ordinaryTaxable, t.capitalGains]) {
        assert.ok(Number.isFinite(v), `${t.year} holds a non-number: ${v}`);
      }
    });
  });

  // The annual pass runs on January 1, before the assets step into the new
  // month, so its events carry December of the year they settle.
  const events = p.modelAssets.flatMap((a) => a.events)
    .filter((e) => e.type === EventType.NIIT_ASSESSED);
  const charged = new Set(events.map((e) => e.dateInt.year));
  recordsWithoutNIIT += p.taxYears.filter((t) => !charged.has(t.year)).length;

  if (events.length) {
    await check(`${fixture.name}: each NIIT charge measured the recorded MAGI and NII`, () => {
      for (const e of events) {
        assert.equal(e.dateInt.month, 12, `a NIIT charge dated ${e.dateInt.toString()}`);
        const t = p.taxYears.find((r) => r.year === e.dateInt.year);
        assert.ok(t, `no record for ${e.dateInt.year}, which NIIT was charged on`);
        assert.equal(e.data.magi, t.magi[MagiPurpose.NIIT], `${t.year} MAGI`);
        assert.equal(e.data.nii, t.netInvestmentIncome, `${t.year} NII`);
        niitEvents++;
        if (t.magi[MagiPurpose.ACA] > t.agi) niitEventsWithUntaxedSS++;
      }
    });
  }
}

await check('the corpus reaches NIIT, so the comparison above is not vacuous', () => {
  assert.ok(niitEvents > 0, 'no fixture charges NIIT');
});

await check('some NIIT year has untaxed Social Security, where MAGI purposes differ', () => {
  // Only there does reading the ACA figure instead of NIIT's change the charge.
  assert.ok(niitEventsWithUntaxedSS > 0,
    'every NIIT year has ACA MAGI == agi, so a charge reading the wrong purpose would pass');
});

await check('most settled years charge no NIIT, and they are recorded too', () => {
  assert.ok(recordsWithoutNIIT > 0, 'every recorded year was a NIIT year');
});

// ── Conversions, on both paths ───────────────────────────────────────

console.log('\n── The Roth MAGI leaves out exactly the converted dollars ──\n');

const START = { year: 2026, month: 1 };
const END = { year: 2028, month: 12 };
const asset = (x) => ({
  startDateInt: START, finishDateInt: END, annualReturnRate: { rate: 0 }, ...x,
});
const conversionPlan = {
  name: 'conversions',
  settings: { filingAs: 'Single', startAge: 66, retirementAge: 65, finishAge: 69 },
  lifeEvents: [],
  modelAssets: [
    // 1% a month to the Roth: the rebalance path.
    asset({ instrument: 'ira', displayName: 'IRA',
      startCurrency: { amount: 200000 }, startBasisCurrency: { amount: 0 },
      fundTransfers: [{ toDisplayName: 'Roth IRA', monthlyMoveValue: 1, closeMoveValue: 0 }] }),
    // Closes mid-plan and sends everything to the Roth: the close path.
    asset({ instrument: '401K', displayName: '401K', finishDateInt: { year: 2027, month: 6 },
      startCurrency: { amount: 50000 }, startBasisCurrency: { amount: 0 },
      fundTransfers: [{ toDisplayName: 'Roth IRA', monthlyMoveValue: 0, closeMoveValue: 100 }] }),
    asset({ instrument: 'rothIRA', displayName: 'Roth IRA',
      startCurrency: { amount: 1000 }, startBasisCurrency: { amount: 1000 } }),
    asset({ instrument: 'bank', displayName: 'Checking',
      startCurrency: { amount: 150000 }, startBasisCurrency: { amount: 150000 } }),
    asset({ instrument: 'monthlyExpense', displayName: 'Living',
      startCurrency: { amount: -3000 }, startBasisCurrency: { amount: 0 } }),
  ],
};

const { portfolio: conv } = await runPlan(conversionPlan);
const roth = conv.modelAssets.find((a) => a.displayName === 'Roth IRA');
const arrived = (cadence) => roth.events
  .filter((e) => e.type === EventType.TRANSFER && e.data?.cadence === cadence
    && (e.data?.from === 'IRA' || e.data?.from === '401K'));

await check('both paths moved money into the Roth', () => {
  assert.ok(arrived('monthly').length > 0, 'no monthly transfer reached the Roth');
  assert.ok(arrived('on close').length > 0, 'no close transfer reached the Roth');
});

for (const t of conv.taxYears) {
  await check(`${t.year}: Roth MAGI = agi less the conversions that arrived`, () => {
    const converted = [...arrived('monthly'), ...arrived('on close')]
      .filter((e) => e.dateInt.year === t.year)
      .reduce((sum, e) => sum + e.amount.amount, 0);
    assert.ok(converted > 0, `nothing converted in ${t.year}`);
    // No Social Security and no IRA deduction, so §219(g)'s figure is agi.
    assert.equal(t.magi[MagiPurpose.IRA_DEDUCTION], t.agi);
    near(t.agi - t.magi[MagiPurpose.ROTH_CONTRIBUTION], converted, `${t.year} conversions`);
    // A conversion is still income for every other purpose.
    assert.equal(t.magi[MagiPurpose.NIIT], t.agi);
    assert.ok(t.agi >= converted, `${t.year} agi ${t.agi} leaves out converted income`);
  });
}

// ── Re-runs and copies ───────────────────────────────────────────────

console.log('\n── Re-runs start fresh; copies carry the list ──\n');

await check('a second run of one Portfolio replaces the list, not appends to it', async () => {
  const first = conv.taxYears;
  await chronometer_run(conv);
  assert.equal(conv.taxYears.length, first.length);
  assert.notEqual(conv.taxYears, first, 'the list was not rebuilt');
  assert.deepEqual(conv.taxYears, first, 'a re-run of the same plan recorded different figures');
});

await check('copy() carries the records in a list of its own', () => {
  const copy = conv.copy();
  assert.deepEqual(copy.taxYears, conv.taxYears);
  assert.notEqual(copy.taxYears, conv.taxYears);
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);
process.exit(failed > 0 ? 1 : 0);
