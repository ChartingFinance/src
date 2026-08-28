/**
 * inflation-deflator.mjs
 *
 * Guards the real-dollar ("today's dollars") deflator that backs the
 * inflation-adjusted plot lines.
 *
 * Three things here are easy to get wrong, and each has a test that fails
 * loudly when it happens:
 *
 *   1. THE MONTHLY CONVENTION. The engine compounds every annual rate as
 *      simple `rate / 12` per month. A deflator using (1+r)^(1/12) looks more
 *      correct and is wrong here — it drifts out of step with the engine's own
 *      expense inflation and compounds over a 30-year plan.
 *
 *   2. BACKTEST DATA RUNNING OUT. CPI covers 1970-2025. A long plan backtested
 *      from a recent year runs off the end, where the engine restores the
 *      assets' configured rates — so the deflator must fall back to the general
 *      inflation rate, not flatten to zero.
 *
 *   3. MONTE CARLO PERCENTILE ORDER. Every run samples its own CPI sequence, so
 *      every run has its own deflator. Deflating the finished bands by any
 *      single index is the tempting shortcut and it is wrong: percentiles of
 *      deflated values are not deflated percentiles.
 *
 * Usage:  node src/tests/inflation-deflator.mjs   (from repo root)
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
import { computeMonteCarlo } from '../js/mc-compute.js';
import { PriceIndex } from '../js/utils/price-index.js';
import { TaxTable } from '../js/taxes.js';
import {
  setActiveTaxTable,
  global_cpi_annual_inflation,
  global_setUserStartAge, global_getUserStartAge,
  global_setInflationRate, global_getInflationRate,
  global_setBacktestYear, global_getBacktestYear,
} from '../js/globals.js';
import { simConfigFromGlobals } from '../js/globals.js';

global_setUserStartAge(50); global_getUserStartAge();

// ── Harness ───────────────────────────────────────────────────────────
const fmt = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const START = { year: 2026, month: 1 };
const finishAfter = (years) => ({ year: 2026 + years - 1, month: 12 });

function assets(finish) {
  return [
    { instrument: 'bank', displayName: 'Savings',
      startDateInt: START, finishDateInt: finish,
      startCurrency: { amount: 500000 }, annualReturnRate: { rate: 0 } },
    { instrument: 'monthlyExpense', displayName: 'Living Expenses',
      startDateInt: START, finishDateInt: finish,
      startCurrency: { amount: -2000 }, annualReturnRate: { rate: 0 } },
  ].map(o => ModelAsset.fromJSON(o));
}

async function run({ inflation = 0.031, backtestYear = 'current', years = 3 } = {}) {
  global_setInflationRate(inflation); global_getInflationRate();
  global_setBacktestYear(backtestYear); global_getBacktestYear();
  setActiveTaxTable(new TaxTable());
  const portfolio = new Portfolio(assets(finishAfter(years)), false, simConfigFromGlobals());
  await chronometer_run(portfolio);
  return portfolio;
}

console.log('\n══ Real-dollar deflator ═══════════════════════════════════\n');

// ══════════════════════════════════════════════════════════════════════
// 1. The monthly convention — simple rate/12, matching ARR.asMonthly()
// ══════════════════════════════════════════════════════════════════════
console.log('── 1. Monthly convention ────────────────────────────────\n');
{
  const RATE = 0.031;
  const p = await run({ inflation: RATE, years: 3 });
  const idx = p.monthlyPriceIndex;

  check('index recorded once per simulated month', () => {
    const valueHistory = p.modelAssets[0].monthlyValues;
    assert.equal(idx.length, valueHistory.length,
      `index has ${idx.length} entries, VALUE history has ${valueHistory.length}`);
  });

  check('index[i] === (1 + rate/12)^(i+1) — simple rate/12, NOT (1+r)^(1/12)', () => {
    for (let i = 0; i < idx.length; i++) {
      const expected = Math.pow(1 + RATE / 12, i + 1);
      assert.ok(near(idx[i], expected, 1e-12),
        `index[${i}] = ${idx[i]}, expected ${expected}`);
    }
  });

  check('the wrong convention would be visibly different by year 3', () => {
    const wrong = Math.pow(Math.pow(1 + RATE, 1 / 12), idx.length);
    const right = idx[idx.length - 1];
    assert.ok(Math.abs(wrong - right) > 1e-4,
      `conventions agree to ${Math.abs(wrong - right)} — this test cannot detect the bug`);
  });

  check('deflating 36 months of $500,000 gives the expected real value', () => {
    const real = PriceIndex.deflate([500000], idx);
    assert.ok(near(real[0], 500000 / idx[0], 1e-6),
      `deflated ${fmt(real[0])}, expected ${fmt(500000 / idx[0])}`);
  });
}

// ══════════════════════════════════════════════════════════════════════
// 2. Zero inflation — real must equal nominal everywhere
// ══════════════════════════════════════════════════════════════════════
console.log('\n── 2. Zero inflation ────────────────────────────────────\n');
{
  const p = await run({ inflation: 0, years: 3 });
  check('every index entry is exactly 1.0', () => {
    for (let i = 0; i < p.monthlyPriceIndex.length; i++) {
      assert.equal(p.monthlyPriceIndex[i], 1, `index[${i}] = ${p.monthlyPriceIndex[i]}`);
    }
  });
  check('deflate() is the identity', () => {
    const series = p.modelAssets[0].monthlyValues;
    const real = PriceIndex.deflate(series, p.monthlyPriceIndex);
    for (let i = 0; i < series.length; i++) {
      assert.equal(real[i], series[i], `month ${i}: ${real[i]} !== ${series[i]}`);
    }
  });
}

// ══════════════════════════════════════════════════════════════════════
// 3. Backtest — the index must track the SAME historical CPI years the
//    engine fed to the assets and the tax tables
// ══════════════════════════════════════════════════════════════════════
console.log('\n── 3. Backtest tracks historical CPI ────────────────────\n');
{
  const FROM = 1974;   // 1974: 11.0%, 1975: 9.1%, 1976: 5.8%
  const p = await run({ backtestYear: String(FROM), years: 3 });
  const idx = p.monthlyPriceIndex;

  check('year one compounds at the 1974 CPI, not the general rate', () => {
    const rate = global_cpi_annual_inflation[FROM] / 100;
    const expected = Math.pow(1 + rate / 12, 12);
    assert.ok(near(idx[11], expected, 1e-12),
      `index after 12 months = ${idx[11]}, expected ${expected} (CPI ${(rate * 100).toFixed(1)}%)`);
  });

  check('each subsequent year advances to the next historical CPI year', () => {
    let level = 1;
    for (let y = 0; y < 3; y++) {
      const rate = global_cpi_annual_inflation[FROM + y] / 100;
      for (let m = 0; m < 12; m++) {
        level *= (1 + rate / 12);
        const i = y * 12 + m;
        assert.ok(near(idx[i], level, 1e-12),
          `index[${i}] (sim year ${y + 1}, CPI ${FROM + y}) = ${idx[i]}, expected ${level}`);
      }
    }
  });

  check('high-inflation backtest deflates much harder than the 3.1% default', () => {
    assert.ok(idx[35] > Math.pow(1 + 0.031 / 12, 36) * 1.15,
      `1974-76 index ${idx[35]} is not meaningfully above the default-rate index`);
  });
}

// ══════════════════════════════════════════════════════════════════════
// 4. Backtest past the end of the CPI data — fall back, don't flatten
// ══════════════════════════════════════════════════════════════════════
console.log('\n── 4. Backtest running off the end of the data ──────────\n');
{
  // CPI ends 2025. Starting at 2024 gives two data years, then nothing.
  const FROM = 2024;
  const GENERAL = 0.04;
  const p = await run({ inflation: GENERAL, backtestYear: String(FROM), years: 4 });
  const idx = p.monthlyPriceIndex;

  check('sanity: the data really does run out inside this plan', () => {
    assert.equal(global_cpi_annual_inflation[2026], undefined,
      'CPI 2026 exists — pick a later start year for this test');
  });

  check('years past the data compound at the general rate, not zero', () => {
    // Year 3 (index 24..35) has no CPI data → general rate.
    const growthYear3 = idx[35] / idx[23];
    const expected = Math.pow(1 + GENERAL / 12, 12);
    assert.ok(near(growthYear3, expected, 1e-9),
      `year 3 grew ${growthYear3}, expected ${expected} (the general ${GENERAL * 100}%)`);
  });

  check('the real line does not flatten (index keeps climbing)', () => {
    assert.ok(idx[47] > idx[23],
      `index ended at ${idx[47]} vs ${idx[23]} mid-plan — it flattened`);
  });
}

// ══════════════════════════════════════════════════════════════════════
// 5. Monte Carlo — real bands are taken over deflated RUNS
// ══════════════════════════════════════════════════════════════════════
console.log('\n── 5. Monte Carlo per-run deflation ─────────────────────\n');
{
  global_setInflationRate(0.031); global_getInflationRate();
  global_setBacktestYear('current'); global_getBacktestYear();
  setActiveTaxTable(new TaxTable());

  const mc = await computeMonteCarlo(assets(finishAfter(10)), {
    numSimulations: 120, dataMode: 'historical', retirementDateInt: null,
  });
  const last = mc.labels.length - 1;

  check('results carry real bands and a real baseline', () => {
    assert.ok(Array.isArray(mc.bandDataReal) && mc.bandDataReal.length === mc.bands.length,
      'bandDataReal missing or wrong shape');
    assert.ok(Array.isArray(mc.baselineDataReal) && mc.baselineDataReal.length === mc.baselineData.length,
      'baselineDataReal missing or wrong shape');
  });

  check('real median is below nominal median at the horizon', () => {
    assert.ok(mc.bandDataReal[2][last] < mc.bandData[2][last],
      `real ${fmt(mc.bandDataReal[2][last])} !< nominal ${fmt(mc.bandData[2][last])}`);
  });

  check('real bands stay ordered P10 < P50 < P90', () => {
    assert.ok(mc.bandDataReal[0][last] <= mc.bandDataReal[2][last], 'P10 > P50');
    assert.ok(mc.bandDataReal[2][last] <= mc.bandDataReal[4][last], 'P50 > P90');
  });

  // The shortcut under test: deflate the finished NOMINAL band by a single
  // average index. Because each run carries its own CPI path, the run at the
  // nominal 50th percentile is generally not the run at the real 50th, so the
  // shortcut lands somewhere else. If these ever agree to the penny, someone
  // has replaced the per-run deflation with a post-hoc divide.
  check('per-run deflation ≠ deflating the nominal band by one average index', () => {
    const impliedIndex = mc.baselineData[last] / mc.baselineDataReal[last];
    const shortcut = mc.bandData[2][last] / impliedIndex;
    const actual = mc.bandDataReal[2][last];
    const relDiff = Math.abs(shortcut - actual) / Math.abs(actual);
    assert.ok(relDiff > 1e-6,
      `real median ${fmt(actual)} matches the shortcut ${fmt(shortcut)} exactly — ` +
      `bands are being deflated after the fact instead of per run`);
  });

  check('baseline real is a clean deflation of baseline nominal', () => {
    // The baseline is a single deterministic run, so ONE index applies and the
    // ratio must be monotonically increasing month over month.
    let prev = 0;
    for (let i = 0; i <= last; i += 12) {
      const ratio = mc.baselineData[i] / mc.baselineDataReal[i];
      assert.ok(ratio >= prev, `implied index fell at month ${i}: ${ratio} < ${prev}`);
      prev = ratio;
    }
  });
}

// ── Summary ───────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
