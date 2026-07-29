/**
 * reconciliation-types.mjs
 *
 * The engine's own books are classified by event TYPE, not by prose.
 *
 * `monthlySanityCheck` used to `switch (memo.note)` over English literals, with
 * a `default:` that swallowed anything unrecognised into the transfer total.
 * That is how renaming 'Asset growth' to 'Asset Growth' corrupted
 * reconciliation while passing every test in the suite. Keying on EventType
 * removes the failure mode instead of guarding it — but only as long as every
 * type stays declared, which is what this file enforces.
 *
 * The load-bearing assertion is COMPLETENESS: every EventType the engine can
 * emit must appear in EVENT_RECONCILIATION. An unmapped type now throws mid-run
 * rather than quietly landing in `transferNet`.
 *
 * Usage:  node src/tests/reconciliation-types.mjs   (from repo root)
 */

import assert from 'node:assert/strict';

const store = {};
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

import { ModelAsset } from '../js/model-asset.js';
import { Portfolio, EVENT_RECONCILIATION } from '../js/portfolio.js';
import { chronometer_run } from '../js/chronometer.js';
import { TaxTable } from '../js/taxes.js';
import {
  setActiveTaxTable,
  global_setUserStartAge, global_getUserStartAge,
  global_setUserRetirementAge, global_getUserRetirementAge,
} from '../js/globals.js';
import { EventType, kindOf, EventKind } from '../js/sim-event.js';

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

const BUCKETS = new Set([
  'fica', 'incomeTax', 'capitalGains', 'capitalGainsTax',
  'mortgageInterest', 'mortgagePrincipal', 'propertyTax',
  'excluded', 'passThrough',
]);

console.log('\n── Reconciliation keyed on event type ──\n');

check('EVERY event type declares how it reconciles', () => {
  const missing = Object.entries(EventType)
    .filter(([, v]) => !EVENT_RECONCILIATION[v])
    .map(([k]) => k);
  assert.deepEqual(missing, [],
    `these event types have no EVENT_RECONCILIATION entry, so emitting one would ` +
    `throw mid-run: ${missing.join(', ')}`);
});

check('no entry names a bucket monthlySanityCheck does not read', () => {
  for (const [type, bucket] of Object.entries(EVENT_RECONCILIATION)) {
    assert.ok(BUCKETS.has(bucket), `${type} maps to unknown bucket "${bucket}"`);
  }
});

check('EVENT_RECONCILIATION has no entries for types that do not exist', () => {
  const known = new Set(Object.values(EventType));
  const orphans = Object.keys(EVENT_RECONCILIATION).filter(t => !known.has(t));
  assert.deepEqual(orphans, [], `stale entries: ${orphans.join(', ')}`);
});

check('an unmapped event type throws instead of being swallowed', () => {
  // The whole point: the old default: branch made this case invisible.
  const portfolio = new Portfolio([], false);
  portfolio.modelAssets = [{
    eventsCheckedIndex: 0,
    events: [{ type: 'somethingNobodyDeclared', kind: 'cash', amount: { amount: 100 } }],
  }];
  assert.throws(() => portfolio.monthlySanityCheck({ toInt: () => 202601 }),
    /has no entry in EVENT_RECONCILIATION/,
    'an undeclared event type must stop the run, not join transferNet');
});

check('engine reports and recognition stay out of the transfer total', () => {
  // passThrough participates only when cash moved, so which types are `info`
  // decides what conservation sees. Lock the ones whose miscategorisation
  // would silently break it: an UNFUNDED counted as cash would report money
  // moving that never did.
  for (const t of [EventType.UNFUNDED, EventType.CONTRIBUTION_CAPPED,
                   EventType.MAINTENANCE, EventType.INSURANCE,
                   EventType.PROPERTY_TAX_ESCROW]) {
    assert.equal(EVENT_RECONCILIATION[t], 'passThrough', `${t} should be passThrough`);
    assert.equal(kindOf(t), EventKind.INFO,
      `${t} must be info — passThrough counts cash events, and no money moved here`);
  }
  // And the converse: real movement must NOT be info, or conservation would
  // stop seeing transfers at all.
  for (const t of [EventType.TRANSFER, EventType.SETTLEMENT,
                   EventType.SPILLOVER, EventType.ONE_TIME, EventType.TAX_TRUE_UP]) {
    assert.equal(kindOf(t), EventKind.CASH, `${t} moves money and must count as cash`);
  }
});

check('growth and dividends are excluded from transfer conservation', () => {
  // These move a balance without being a transfer. Before, they were four
  // separate accumulators nothing ever read.
  for (const t of [EventType.ASSET_GROWTH, EventType.EXPENSE_INFLATION,
                   EventType.INCOME_GROWTH, EventType.DIVIDEND, EventType.INTEREST_INCOME]) {
    assert.equal(EVENT_RECONCILIATION[t], 'excluded', `${t} should be excluded`);
    assert.equal(kindOf(t), EventKind.CASH,
      `${t} is cash — which is exactly why it needs an explicit exclusion`);
  }
});

// ── A real run still classifies everything ───────────────────────────
console.log('\n── On real simulations ──\n');

async function run(assets, ages) {
  setActiveTaxTable(new TaxTable());
  global_setUserStartAge(ages.start); global_getUserStartAge();
  global_setUserRetirementAge(ages.retire); global_getUserRetirementAge();
  const p = new Portfolio(assets.map(o => ModelAsset.fromJSON(o)), true);
  await chronometer_run(p);
  return p;
}

const S = { year: 2026, month: 1 }, F = { year: 2030, month: 12 };
const base = (x) => ({ startDateInt: S, finishDateInt: F, annualReturnRate: { rate: 0 }, ...x });

const scenarios = [
  ['housing', { start: 50, retire: 65 }, [
    base({ instrument: 'realEstate', displayName: 'Home', isPrimaryHome: true,
           startCurrency: { amount: 500000 }, startBasisCurrency: { amount: 500000 },
           annualReturnRate: { rate: 0.03 }, annualTaxRate: { rate: 0.012 },
           annualMaintenanceRate: { rate: 0.01 }, annualInsuranceCost: { amount: 2400 } }),
    base({ instrument: 'mortgage', displayName: 'Mortgage', startCurrency: { amount: -300000 },
           startBasisCurrency: { amount: 0 }, annualReturnRate: { rate: 0.065 }, monthsRemaining: 360 }),
    base({ instrument: 'bank', displayName: 'Checking', startCurrency: { amount: 4000 }, startBasisCurrency: { amount: 4000 } }),
    base({ instrument: 'taxableEquity', displayName: 'Brokerage', startCurrency: { amount: 400000 },
           startBasisCurrency: { amount: 200000 }, annualReturnRate: { rate: 0.07 } }),
  ]],
  ['retired', { start: 75, retire: 65 }, [
    base({ instrument: 'retirementIncome', displayName: 'Social Security', startCurrency: { amount: 3000 }, startBasisCurrency: { amount: 0 },
           fundTransfers: [{ toDisplayName: 'Savings', monthlyMoveValue: 100, closeMoveValue: 0 }] }),
    base({ instrument: 'ira', displayName: 'IRA', startCurrency: { amount: 800000 }, startBasisCurrency: { amount: 0 } }),
    base({ instrument: 'bank', displayName: 'Savings', startCurrency: { amount: 200000 }, startBasisCurrency: { amount: 200000 } }),
    base({ instrument: 'monthlyExpense', displayName: 'Living', startCurrency: { amount: -5000 }, startBasisCurrency: { amount: 0 } }),
  ]],
];

for (const [name, ages, assets] of scenarios) {
  const portfolio = await run(assets, ages);
  check(`${name}: every recorded event has a declared bucket`, () => {
    for (const a of portfolio.modelAssets) {
      for (const e of a.events) {
        assert.ok(EVENT_RECONCILIATION[e.type],
          `${a.displayName} emitted "${e.type}" with no reconciliation entry`);
      }
    }
  });
  check(`${name}: the scan index tracks events, not memos`, () => {
    for (const a of portfolio.modelAssets) {
      assert.equal(a.eventsCheckedIndex, a.events.length,
        `${a.displayName}: index ${a.eventsCheckedIndex} vs ${a.events.length} events`);
    }
  });
}

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
