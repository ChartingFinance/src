/**
 * yearly-snapshot-boundary.mjs
 *
 * Guards the shape of portfolio.yearlySnapshots at the end of a plan.
 *
 * Bug: chronometer_run appended a "final year snapshot" after the main loop
 * unconditionally. On a plan ending in December the loop has already rolled
 * over New Year's Day — pushing that year's snapshot and calling yearlyChron,
 * which zeroes portfolio.yearly — so the append produced a DUPLICATE of the
 * same calendar year with annualExpense $0 and withdrawalRate 0%. Every
 * consumer that averages, counts years, or reads the last element saw a
 * phantom zero-spend year (Simulator.calculateFitness, the guardrails
 * withdrawal-step chart, the simulator modal's spending headline).
 *
 * Invariants:
 *   1. A December-ending plan yields exactly one snapshot per calendar year —
 *      no duplicate year, no zero-expense stub.
 *   2. A mid-year-ending plan still gets its trailing stub, carrying the real
 *      partial-year spend and flagged `partial` with a month count.
 *   3. A mid-year-STARTING plan flags its short first year the same way, so
 *      `partial` means "short year" everywhere rather than "last element".
 *   4. Snapshot years are contiguous and cover the plan's span.
 *
 * Zero growth, zero inflation, retirement pushed past the plan end so the
 * guardrail adjustments never fire — spend stays a flat $1,000/month and the
 * arithmetic below is exact.
 *
 * Usage:  node src/tests/yearly-snapshot-boundary.mjs   (from repo root)
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
import { ModelAsset } from '../js/model-asset.js';
import { Portfolio } from '../js/portfolio.js';
import { chronometer_run } from '../js/chronometer.js';
import { TaxTable } from '../js/taxes.js';
import { DateInt } from '../js/utils/date-int.js';
import {
  setActiveTaxTable,
  global_setInflationRate, global_getInflationRate,
  global_setUserStartAge, global_getUserStartAge,
  global_setFilingAs, global_getFilingAs,
} from '../js/globals.js';

global_setInflationRate(0); global_getInflationRate();
global_setUserStartAge(50); global_getUserStartAge();  // well under RMD age
global_setFilingAs('Single'); global_getFilingAs();

const MONTHLY_EXPENSE = 1000;

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

/**
 * A bank account drained by a flat monthly expense, over [start, finish].
 */
async function run(start, finish) {
  setActiveTaxTable(new TaxTable());
  const assetData = [
    {
      instrument: 'bank',
      displayName: 'Savings',
      startDateInt: start,
      finishDateInt: finish,
      startCurrency: { amount: 1000000 },
      startBasisCurrency: { amount: 0 },
      annualReturnRate: { rate: 0 },
    },
    {
      instrument: 'monthlyExpense',
      displayName: 'Living Expenses',
      startDateInt: start,
      finishDateInt: finish,
      startCurrency: { amount: -MONTHLY_EXPENSE },
      startBasisCurrency: { amount: 0 },
      annualReturnRate: { rate: 0 },
      fundTransfers: [
        { toDisplayName: 'Savings', monthlyMoveValue: 100, closeMoveValue: 0 },
      ],
    },
  ];

  const portfolio = new Portfolio(assetData.map(o => ModelAsset.fromJSON(o)), false);
  portfolio.guardrailsParams = {
    withdrawalRate: 4,
    preservation: 20,
    prosperity: 20,
    adjustment: 10,
    // Retirement after the plan ends: snapshots are recorded, but the
    // preservation/prosperity expense adjustments never fire.
    retirementDateInt: DateInt.from(finish.year + 10, 1),
  };
  await chronometer_run(portfolio);
  return portfolio;
}

const show = (snaps) => snaps
  .map(s => `${s.year}${s.partial ? `p${s.months}` : ''}=${fmt(s.annualExpense)}`)
  .join(', ');

/** Shared structural invariants, whatever the plan's boundaries. */
function assertWellFormed(snaps, firstYear, lastYear) {
  const years = snaps.map(s => s.year);
  assert.deepEqual(years, [...new Set(years)],
    `duplicate calendar year in snapshots: [${years.join(', ')}]`);
  assert.deepEqual(years, years.slice().sort((a, b) => a - b),
    `snapshot years out of order: [${years.join(', ')}]`);
  assert.deepEqual(
    years,
    Array.from({ length: lastYear - firstYear + 1 }, (_, i) => firstYear + i),
    `snapshot years [${years.join(', ')}] do not cover ${firstYear}..${lastYear} contiguously`);
  for (const s of snaps) {
    assert.ok(s.months >= 1 && s.months <= 12,
      `${s.year}: months = ${s.months}, expected 1..12`);
    assert.equal(s.partial, s.months < 12,
      `${s.year}: partial = ${s.partial} but months = ${s.months}`);
  }
}

// ── Scenario 1: plan ends in December — the reported bug ──────────────
console.log('\n── Jan 2026 – Dec 2028: December boundary ───────────────\n');
{
  const p = await run({ year: 2026, month: 1 }, { year: 2028, month: 12 });
  const snaps = p.yearlySnapshots;
  console.log(`  snapshots: ${show(snaps)}\n`);

  check('exactly one snapshot per calendar year (3 years, no duplicate)', () => {
    assert.equal(snaps.length, 3, `got ${snaps.length} snapshots: ${show(snaps)}`);
    assertWellFormed(snaps, 2026, 2028);
  });
  check('no zero-expense stub year', () => {
    const zeros = snaps.filter(s => s.annualExpense === 0);
    assert.equal(zeros.length, 0,
      `${zeros.length} zero-expense snapshot(s): ${show(zeros)}`);
  });
  check('every year is a full 12 months of spend', () => {
    for (const s of snaps) {
      assert.equal(s.partial, false, `${s.year} flagged partial`);
      assert.ok(near(s.annualExpense, 12 * MONTHLY_EXPENSE),
        `${s.year} spend ${fmt(s.annualExpense)}, expected ${fmt(12 * MONTHLY_EXPENSE)}`);
    }
  });
  check('the last snapshot carries a real withdrawal rate', () => {
    const last = snaps[snaps.length - 1];
    assert.equal(last.year, 2028, `last snapshot is ${last.year}, expected 2028`);
    assert.ok(last.withdrawalRate > 0,
      `last withdrawalRate = ${last.withdrawalRate}, expected > 0`);
    assert.ok(near(last.withdrawalRate, last.annualExpense / last.investableAssets, 1e-9),
      'withdrawalRate does not match annualExpense / investableAssets');
  });
}

// ── Scenario 2: plan ends mid-year — the stub is legitimate ───────────
console.log('\n── Jan 2026 – Jun 2028: mid-year end keeps its stub ─────\n');
{
  const p = await run({ year: 2026, month: 1 }, { year: 2028, month: 6 });
  const snaps = p.yearlySnapshots;
  console.log(`  snapshots: ${show(snaps)}\n`);

  check('three snapshots: 2026, 2027 full and a 2028 stub', () => {
    assert.equal(snaps.length, 3, `got ${snaps.length} snapshots: ${show(snaps)}`);
    assertWellFormed(snaps, 2026, 2028);
  });
  check('the 2028 stub is flagged partial with 6 months', () => {
    const last = snaps[snaps.length - 1];
    assert.equal(last.year, 2028, `last snapshot is ${last.year}, expected 2028`);
    assert.equal(last.partial, true, '2028 stub not flagged partial');
    assert.equal(last.months, 6, `2028 months = ${last.months}, expected 6`);
  });
  check('the stub carries the real partial-year spend, not $0', () => {
    const last = snaps[snaps.length - 1];
    assert.ok(near(last.annualExpense, 6 * MONTHLY_EXPENSE),
      `2028 spend ${fmt(last.annualExpense)}, expected ${fmt(6 * MONTHLY_EXPENSE)}`);
  });
}

// ── Scenario 3: plan starts mid-year — first year is short too ────────
console.log('\n── Jul 2026 – Dec 2028: mid-year start ──────────────────\n');
{
  const p = await run({ year: 2026, month: 7 }, { year: 2028, month: 12 });
  const snaps = p.yearlySnapshots;
  console.log(`  snapshots: ${show(snaps)}\n`);

  check('three snapshots, one per calendar year', () => {
    assert.equal(snaps.length, 3, `got ${snaps.length} snapshots: ${show(snaps)}`);
    assertWellFormed(snaps, 2026, 2028);
  });
  check('2026 is flagged partial with 6 months of spend', () => {
    const first = snaps[0];
    assert.equal(first.year, 2026, `first snapshot is ${first.year}, expected 2026`);
    assert.equal(first.partial, true, '2026 not flagged partial');
    assert.equal(first.months, 6, `2026 months = ${first.months}, expected 6`);
    assert.ok(near(first.annualExpense, 6 * MONTHLY_EXPENSE),
      `2026 spend ${fmt(first.annualExpense)}, expected ${fmt(6 * MONTHLY_EXPENSE)}`);
  });
  check('2027 and 2028 are full years', () => {
    for (const s of snaps.slice(1)) {
      assert.equal(s.partial, false, `${s.year} flagged partial`);
      assert.ok(near(s.annualExpense, 12 * MONTHLY_EXPENSE),
        `${s.year} spend ${fmt(s.annualExpense)}, expected ${fmt(12 * MONTHLY_EXPENSE)}`);
    }
  });
}

// ── Scenario 4: plan shorter than a calendar year ─────────────────────
console.log('\n── Mar 2026 – Aug 2026: sub-year plan ───────────────────\n');
{
  const p = await run({ year: 2026, month: 3 }, { year: 2026, month: 8 });
  const snaps = p.yearlySnapshots;
  console.log(`  snapshots: ${show(snaps)}\n`);

  check('one partial snapshot covering the whole plan', () => {
    assert.equal(snaps.length, 1, `got ${snaps.length} snapshots: ${show(snaps)}`);
    assertWellFormed(snaps, 2026, 2026);
    assert.equal(snaps[0].partial, true, '2026 not flagged partial');
    assert.equal(snaps[0].months, 6, `2026 months = ${snaps[0].months}, expected 6`);
    assert.ok(near(snaps[0].annualExpense, 6 * MONTHLY_EXPENSE),
      `2026 spend ${fmt(snaps[0].annualExpense)}, expected ${fmt(6 * MONTHLY_EXPENSE)}`);
  });
}

// ── Summary ───────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
