/**
 * life-event-dating.mjs — what a life event does is recorded in its trigger
 * month.
 *
 * ── Why ──────────────────────────────────────────────────────────────
 *
 * Life events fire on the first tick of their trigger month, before
 * applyFirstDayOfMonth moves each asset's clock (handleCurrentDateInt). An
 * asset a life event closed recorded its sale with the clock it had: last
 * month's. retirement-sells-a-rental's Retire, in January 2028, recorded the
 * rental's capital-gains tax and its proceeds in December 2027, while the
 * metrics booked them in January. A reader that dates events by their own
 * month put the sale in the wrong month, and in January the wrong year.
 *
 * ── What is asserted ─────────────────────────────────────────────────
 *
 *   THE CASE     the rental's sale carries January 2028, the month its tax is
 *                booked in.
 *   THE CORPUS   every event a life event records carries its trigger month,
 *                read from the life event, not the chain's scope.
 *
 * Run: node tests/life-event-dating.mjs   (from src/)
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
const { Metric } = await import('../js/metric.js');
const { chainFor } = await import('../js/trace.js');
const { DateInt } = await import('../js/utils/date-int.js');
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

const ym = (d) => `${d.year}-${String(d.month).padStart(2, '0')}`;

// ── The case ─────────────────────────────────────────────────────────

console.log('\n── A sale a life event makes is recorded in its trigger month ──\n');

const rentalPlan = await runFixture(SNAPSHOT_FIXTURES.find((f) => f.name === 'retirement-sells-a-rental'));

await check('the rental\'s capital-gains tax and proceeds carry January 2028', () => {
  const rental = rentalPlan.modelAssets.find((a) => a.displayName === 'Rental');
  assert.equal(ym(rental.closedDateInt), '2028-01');
  const sale = rental.events.filter((e) => e.type === EventType.CAPITAL_GAINS_TAX || e.type === EventType.TRANSFER);
  assert.ok(sale.length >= 2, `the sale recorded ${sale.length} events`);
  for (const e of sale) assert.equal(ym(e.dateInt), '2028-01', `${e.type} dated ${ym(e.dateInt)}`);
  const proceeds = rentalPlan.modelAssets.find((a) => a.displayName === 'Checking').events
    .filter((e) => e.type === EventType.TRANSFER && e.data?.from === 'Rental');
  assert.equal(proceeds.length, 1);
  assert.equal(ym(proceeds[0].dateInt), '2028-01');
});

await check('...which is the month the tax is booked in', () => {
  const rental = rentalPlan.modelAssets.find((a) => a.displayName === 'Rental');
  const booked = rental.getHistory(Metric.LONG_TERM_CAPITAL_GAIN_TAX).findIndex((v) => v !== 0);
  assert.equal(booked, DateInt.diffMonths(rentalPlan.firstDateInt, DateInt.from(2028, 1)));
});

// ── The corpus ───────────────────────────────────────────────────────

console.log('\n── Every event a life event records carries its trigger month ──\n');

const ROOT = 'Life event: ';
let lifeEventEvents = 0;
for (const fixture of SNAPSHOT_FIXTURES) {
  const p = fixture.name === 'retirement-sells-a-rental' ? rentalPlan : await runFixture(fixture);
  await check(`${fixture.name}: each life event's events carry its trigger month`, () => {
    for (const asset of p.modelAssets) {
      for (const e of asset.events) {
        const root = chainFor(e.traceId, p.traceScopes)[0];
        if (!root?.label?.startsWith(ROOT)) continue;
        const event = p.lifeEvents.find((le) => le.displayName === root.label.slice(ROOT.length));
        assert.ok(event, `no life event named by "${root.label}"`);
        assert.equal(ym(e.dateInt), ym(event.triggerDateInt),
          `${asset.displayName} ${e.type} from "${root.label}"`);
        lifeEventEvents++;
      }
    }
  });
}

await check('the corpus has life events that record something', () => {
  assert.ok(lifeEventEvents > 0, 'no event in the corpus was recorded by a life event');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
