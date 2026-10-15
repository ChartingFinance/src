/**
 * flow-phase-rules.mjs — the Flows view shows the rules in force at the month
 * it shows.
 *
 * ── Why ──────────────────────────────────────────────────────────────
 *
 * A run leaves each asset holding the LAST phase's transfer rules. The Flows
 * view read those, so a working-year month showed retirement rules: Mid Career
 * June 2030 listed "401K → Living Expenses 40%", a Retire rule, while the
 * Accumulate phase paid Living Expenses 100% from the Brokerage, which is what
 * happened. The portfolio now records the rules as each phase takes effect
 * (Portfolio.phaseRules) and the view reads the record.
 *
 * ── What is asserted ─────────────────────────────────────────────────
 *
 *   THE RECORD     one record per phase taking effect, from the plan's first
 *                  month and each life event's trigger month, in order.
 *   THE CASE       Mid Career, June 2030 and June 2060: each month shows its
 *                  own phase's rules.
 *   WHAT RAN       across the corpus, every January: each rule the view shows
 *                  as moving money was actually executed between those two
 *                  accounts that month. A rule from the wrong phase fails here.
 *                  January, because annual limits reset then: later in a year a
 *                  capped conversion is in force but moves nothing, which is a
 *                  settings-versus-results gap, not a wrong phase.
 *
 * Run: node tests/flow-phase-rules.mjs   (from src/)
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
const { DateInt } = await import('../js/utils/date-int.js');
const { chainFor } = await import('../js/trace.js');
const { buildPipelines, phaseRulesAt } = await import('../js/flow-pipelines.js');
const { SNAPSHOT_FIXTURES } = await import('./tools/fixtures.mjs');

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

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

const indexOf = (p, year, month) => DateInt.diffMonths(p.firstDateInt, DateInt.from(year, month));

/** The user rules the view shows as moving money, as "source → target". */
function movingRoutes(p, idx) {
  return buildPipelines(p, idx).flatMap((pl) => pl.routes)
    .filter((r) => r.type === 'user' && r.active && r.monthlyAmount >= 1 && r.percentage > 0)
    .map((r) => ({ source: r.sourceName, target: r.targetName, pct: r.percentage }));
}

/**
 * The pairs of accounts that money actually moved between in a month: a
 * transfer's from/to, or a draw whose causal chain pays the other account.
 */
function executedPairs(p, year, month) {
  const scopes = p.traceScopes ?? [];
  const pairs = new Set();
  const add = (a, b) => { pairs.add(`${a}|${b}`); pairs.add(`${b}|${a}`); };
  for (const asset of p.modelAssets) {
    for (const e of asset.events) {
      if (e.dateInt?.year !== year || e.dateInt?.month !== month) continue;
      if (e.data?.from && e.data?.to) add(e.data.from, e.data.to);
      for (const s of chainFor(e.traceId, scopes)) {
        const paid = /^Pay (.+)$/.exec(s.label ?? '');
        if (paid) add(asset.displayName, paid[1]);
      }
    }
  }
  return pairs;
}

// ── The record ───────────────────────────────────────────────────────

console.log('\n── The rules in force are recorded as each phase takes effect ──\n');

const mid = await runFixture(SNAPSHOT_FIXTURES.find((f) => f.name === 'quickstart-midCareer'));

await check('Mid Career records Accumulate from the start and Retire from its trigger month', () => {
  assert.deepEqual(mid.phaseRules.map((r) => [r.phase, r.fromIndex]),
    [['Accumulate', 0], ['Retire', indexOf(mid, 2048, 1)]]);
  for (const r of mid.phaseRules) {
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.transfers), `${r.phase} record is not frozen`);
  }
});

await check('a month before the plan has no record, and every month in it has one', () => {
  assert.equal(phaseRulesAt(mid, -1), null);
  assert.equal(phaseRulesAt(mid, 0).phase, 'Accumulate');
  assert.equal(phaseRulesAt(mid, indexOf(mid, 2047, 12)).phase, 'Accumulate');
  assert.equal(phaseRulesAt(mid, indexOf(mid, 2048, 1)).phase, 'Retire');
});

// ── The case that was wrong ──────────────────────────────────────────

console.log('\n── Mid Career shows each month its own phase ──\n');

const has = (routes, source, target, pct) =>
  routes.some((r) => r.source === source && r.target === target && (pct == null || r.pct === pct));

await check('June 2030 shows the Accumulate rules, not the Retire ones', () => {
  const routes = movingRoutes(mid, indexOf(mid, 2030, 6));
  assert.ok(has(routes, 'Brokerage', 'Living Expenses', 100), 'Living Expenses is not 100% from the Brokerage');
  assert.ok(!has(routes, '401K', 'Living Expenses'), 'a Retire rule, 401K → Living Expenses, is shown in 2030');
  assert.ok(has(routes, 'Salary', '401K', 5), 'the paycheck rules are missing');
});

await check('June 2060 shows the Retire rules', () => {
  const routes = movingRoutes(mid, indexOf(mid, 2060, 6));
  assert.ok(has(routes, '401K', 'Living Expenses', 40), '401K → Living Expenses 40% is missing');
  assert.ok(has(routes, 'Brokerage', 'Living Expenses', 60), 'Brokerage → Living Expenses 60% is missing');
});

// ── What ran ─────────────────────────────────────────────────────────

console.log('\n── Every rule shown as moving money moved money that January ──\n');

let checkedRoutes = 0, phased = 0;
for (const fixture of SNAPSHOT_FIXTURES) {
  const p = fixture.name === 'quickstart-midCareer' ? mid : await runFixture(fixture);
  if (p.phaseRules.length > 1) phased++;
  await check(`${fixture.name}: each January, the rules shown are the ones that ran`, () => {
    const first = p.firstDateInt, last = p.lastDateInt;
    for (let year = first.year; year <= last.year; year++) {
      const idx = indexOf(p, year, 1);
      if (idx < 0 || DateInt.from(year, 1).isAfter(last)) continue;
      const ran = executedPairs(p, year, 1);
      for (const r of movingRoutes(p, idx)) {
        checkedRoutes++;
        assert.ok(ran.has(`${r.source}|${r.target}`),
          `January ${year}: the view shows ${r.source} → ${r.target} ${r.pct}%, but nothing moved between them`);
      }
    }
  });
}

await check('the corpus has plans with more than one phase, and rules to check', () => {
  assert.ok(phased >= 3, `only ${phased} fixtures change phase`);
  assert.ok(checkedRoutes > 100, `only ${checkedRoutes} routes checked`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
