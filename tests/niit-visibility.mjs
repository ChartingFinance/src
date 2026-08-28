/**
 * niit-visibility.mjs — a tax that is collected must be VISIBLE.
 *
 * WHY THIS EXISTS
 *
 * Spec 8 shipped NIIT correctly as cash and incorrectly as information. The
 * engine debited the right accounts by the right amount, and then:
 *
 *   - `addToMetric(Metric.NIIT, ...)` was a silent no-op on every instrument,
 *     because no `relevantMetrics()` listed it. `MetricSet.get()` falls back to
 *     NULL_METRIC, whose `add()` does nothing, so the write SUCCEEDS and the
 *     value disappears. The charge still reached FEDERAL_TAXES through the
 *     rollup, so totals looked right and nothing failed.
 *   - `FinancialPackage` had no `niit` field at all, so `federalTaxes()` — the
 *     number the report view shows and `effectiveTaxRate()` divides by — simply
 *     omitted it. The per-asset ledger and the household package that is
 *     supposed to total it disagreed, and neither complained.
 *
 * Both are the same class of defect: a write that goes nowhere and reports
 * success. A totals-only check cannot see either, because the money genuinely
 * moved and every balance was right.
 *
 * So this suite asserts the LINKS, not the totals:
 *
 *   1. every NIIT_ASSESSED event left a stored Metric.NIIT on the asset it
 *      landed on — catches the NULL_METRIC no-op for any instrument, including
 *      one added later;
 *   2. the household package's niit equals the events that produced it;
 *   3. federalTaxes() actually contains it;
 *   4. a household that owes no NIIT reports none — silence is part of it.
 *
 * Run: node tests/niit-visibility.mjs
 */

import assert from 'node:assert/strict';
import { simConfigFromGlobals } from '../js/globals.js';
import { makeActiveTaxTable } from '../js/globals.js';

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

const G = await import('../js/globals.js');
const { Metric } = await import('../js/metric.js');
const { EventType } = await import('../js/sim-event.js');
const { Portfolio } = await import('../js/portfolio.js');
const { TaxTable } = await import('../js/taxes.js');
const { chronometer_run } = await import('../js/chronometer.js');
const { SNAPSHOT_FIXTURES } = await import('./tools/fixtures.mjs');

/**
 * Mirrors snapshot.mjs's applyConfig. Kept here rather than imported because
 * importing snapshot.mjs RUNS the whole snapshot as a side effect.
 */
async function buildFixture(fixture) {
  G.global_reset();
  G.global_setAllocateHouseholdTax(false);
  G.global_setBacktestYearDirect?.('current');
  const c = fixture.config ?? {};
  if (c.startAge != null) { G.global_setUserStartAge(c.startAge); G.global_getUserStartAge(); }
  if (c.retirementAge != null) { G.global_setUserRetirementAge(c.retirementAge); G.global_getUserRetirementAge(); }
  if (c.finishAge != null) { G.global_setUserFinishAge(c.finishAge); G.global_getUserFinishAge?.(); }
  if (c.filingAs != null) { G.global_setFilingAs(c.filingAs); G.global_getFilingAs(); }

  // A fresh table every fixture: TaxTable caches bracket state across years.
  G.setActiveTaxTable(makeActiveTaxTable());

  const built = fixture.build();
  const portfolio = new Portfolio(built.assets, false, simConfigFromGlobals());
  if (built.lifeEvents) portfolio.lifeEvents = built.lifeEvents;
  if (built.guardrails) portfolio.guardrailsParams = built.guardrails;
  await chronometer_run(portfolio);
  return portfolio;
}

const FIXTURES = SNAPSHOT_FIXTURES;

let checks = 0;
const check = (cond, msg) => { checks++; assert.ok(cond, msg); };

const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;
const fmt = (n) => `$${n.toFixed(2)}`;

/** Sum a metric history over the whole run. */
function metricTotal(asset, metric) {
  const h = asset.getHistory(metric);
  if (!Array.isArray(h)) return null;   // null = NOT TRACKED, distinct from 0
  return h.reduce((t, v) => t + (v ?? 0), 0);
}

const results = [];
for (const fixture of FIXTURES) {
  const portfolio = await buildFixture(fixture);
  const events = [];
  for (const asset of portfolio.modelAssets) {
    for (const e of (asset.events ?? [])) {
      if (e.type === EventType.NIIT_ASSESSED) events.push({ asset, event: e });
    }
  }
  results.push({ fixture, portfolio, events });
}

const charged = results.filter((r) => r.events.length > 0);
const silent = results.filter((r) => r.events.length === 0);

console.log(`\n  ${charged.length} fixture(s) owe NIIT, ${silent.length} owe none\n`);

// The suite is worthless if nothing exercises it — the exact trap spec 8 hit
// when 26 fixtures were bit-identical and the rule had no witness.
check(charged.length > 0,
  'NO fixture charges NIIT — this suite proves nothing. Add one that reaches it.');

// ── 1. Every event left a stored metric ───────────────────────────────
for (const { fixture, events } of charged) {
  for (const { asset, event } of events) {
    const total = metricTotal(asset, Metric.NIIT);
    check(total !== null,
      `${fixture.name}: ${asset.displayName} received a NIIT_ASSESSED event but does not `
      + `TRACK Metric.NIIT — relevantMetrics() for instrument "${asset.instrument}" is missing `
      + 'it, so addToMetric resolved to NULL_METRIC and the write vanished silently');
    check(Math.abs(total) > 0.005,
      `${fixture.name}: ${asset.displayName} tracks Metric.NIIT but it summed to zero against `
      + `a ${fmt(Math.abs(event.amount.amount))} charge — the write went nowhere`);
  }
  console.log(`  ok  ${fixture.name} — ${events.length} charge(s), each with a stored metric`);
}

// ── 2, 3. The household package agrees with its own events ────────────
for (const { fixture, portfolio, events } of charged) {
  const eventTotal = events.reduce((t, { event }) => t + Math.abs(event.amount.amount), 0);

  const pkgNIIT = Math.abs(portfolio.total?.niit?.amount ?? NaN);
  check(!Number.isNaN(pkgNIIT),
    `${fixture.name}: FinancialPackage has no niit field — federalTaxes() cannot include it`);

  // The last annual pass can fire past the end of the recorded window, so the
  // package may legitimately hold fewer charges than the ledger shows. It must
  // never hold MORE, and it must not be empty while events exist.
  check(pkgNIIT > 0,
    `${fixture.name}: ${events.length} NIIT event(s) totalling ${fmt(eventTotal)} but the `
    + 'package booked $0.00 — the charge is collected and reported nowhere');
  check(pkgNIIT <= eventTotal + 0.02,
    `${fixture.name}: package niit ${fmt(pkgNIIT)} exceeds the ${fmt(eventTotal)} actually `
    + 'charged — tax booked that no account paid');

  // federalTaxes() must CONTAIN it: remove niit and the total must fall by it.
  const fed = Math.abs(portfolio.total.federalTaxes().amount);
  const probe = portfolio.total.copy();
  probe.niit.zero();
  const fedWithout = Math.abs(probe.federalTaxes().amount);
  check(near(fed - fedWithout, pkgNIIT),
    `${fixture.name}: federalTaxes() did not move by the NIIT when it was removed `
    + `(${fmt(fed)} vs ${fmt(fedWithout)}, expected a ${fmt(pkgNIIT)} gap) — the report view `
    + 'and effectiveTaxRate() are understating the tax actually collected');

  console.log(`  ok  ${fixture.name} — package ${fmt(pkgNIIT)} inside federalTaxes ${fmt(fed)}`);
}

// ── 4. Silence ────────────────────────────────────────────────────────
for (const { fixture, portfolio } of silent) {
  const pkgNIIT = Math.abs(portfolio.total?.niit?.amount ?? 0);
  check(pkgNIIT < 0.005,
    `${fixture.name}: owes no NIIT — no NIIT_ASSESSED event was emitted — but the package `
    + `booked ${fmt(pkgNIIT)}. A tax reported without being charged is worse than one charged `
    + 'without being reported.');
}
console.log(`  ok  ${silent.length} fixture(s) owe none and report none`);

console.log(`\nPASS — ${checks} assertions\n`);
