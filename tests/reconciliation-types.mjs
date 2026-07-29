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
import { EventType, kindOf, EventKind, ShortfallOrigin } from '../js/sim-event.js';
import { FundTransfer } from '../js/fund-transfer.js';
import { logger } from '../js/utils/logger.js';

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

const BUCKETS = new Set([
  'fica', 'incomeTax', 'capitalGains', 'capitalGainsTax',
  'mortgageInterest', 'mortgagePrincipal', 'propertyTax',
  'excluded', 'paired', 'oneSided',
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

check('ONLY genuinely two-sided movement is expected to net to zero', () => {
  // The load-bearing distinction. execute() books both legs, so TRANSFER must
  // balance. Everything else is single-legged by design, and expecting it to
  // balance is what made this check fail every month on any plan with an
  // expense — 293 false findings across five healthy scenarios. Verified
  // empirically before being encoded: a probe summed every cash event type
  // over a full run and TRANSFER was the only one that came to zero.
  assert.equal(EVENT_RECONCILIATION[EventType.TRANSFER], 'paired');

  for (const t of [EventType.SETTLEMENT, EventType.SPILLOVER, EventType.GROSS_UP,
                   EventType.ONE_TIME, EventType.TAX_TRUE_UP]) {
    assert.equal(EVENT_RECONCILIATION[t], 'oneSided',
      `${t} books one leg only — asserting it nets to zero produces false alarms`);
  }
});

check('a shortfall must declare which movement it completes', () => {
  // SPILLOVER and UNFUNDED are emitted from BOTH the two-sided execute() path
  // and the one-sided settleOneSided path, and only the two-sided total is
  // expected to net to zero. Without provenance the sum breaks by up to $2,265
  // a month on a home whose carrying costs drain its funding account — which is
  // why reportUnfunded refuses to guess.
  assert.throws(() => FundTransfer.reportUnfunded(
    { recordEvent() {} }, { amount: 100, copy: () => ({ flipSign: () => ({}) }) }, 'x'),
    /origin must be a ShortfallOrigin/,
    'reportUnfunded must reject a missing origin rather than default it');
  assert.throws(() => FundTransfer.reportUnfunded(
    { recordEvent() {} }, { amount: 100, copy: () => ({ flipSign: () => ({}) }) }, 'x', 'nonsense'),
    /origin must be a ShortfallOrigin/);
});

check('engine reports and recognition stay out of both movement totals', () => {
  // Movement totals count cash only, so which types are `info` decides what
  // conservation sees. An UNFUNDED counted as cash would report money moving
  // that never did.
  for (const t of [EventType.UNFUNDED, EventType.CONTRIBUTION_CAPPED,
                   EventType.MAINTENANCE, EventType.INSURANCE,
                   EventType.PROPERTY_TAX_ESCROW]) {
    assert.equal(EVENT_RECONCILIATION[t], 'oneSided', `${t} should be oneSided`);
    assert.equal(kindOf(t), EventKind.INFO,
      `${t} must be info — movement totals count cash, and no money moved here`);
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

// ── Shortfalls must be attributable ──────────────────────────────────
// Chosen so shortfalls arise from BOTH paths: a home's carrying costs draining
// its funding account (one-sided settlement) and an expense transfer outrunning
// its only funding account (two-sided transfer).
console.log('\n── Shortfall provenance ──\n');

const shortfallScenarios = [
  ['settlement spills', { start: 50, retire: 65 }, [
    base({ instrument: 'realEstate', displayName: 'Home', isPrimaryHome: true,
           startCurrency: { amount: 600000 }, startBasisCurrency: { amount: 600000 },
           annualReturnRate: { rate: 0.03 }, annualTaxRate: { rate: 0.015 },
           annualMaintenanceRate: { rate: 0.02 }, annualInsuranceCost: { amount: 6000 } }),
    base({ instrument: 'bank', displayName: 'Checking', startCurrency: { amount: 3000 }, startBasisCurrency: { amount: 3000 } }),
    base({ instrument: 'taxableEquity', displayName: 'Brokerage', startCurrency: { amount: 900000 },
           startBasisCurrency: { amount: 600000 }, annualReturnRate: { rate: 0.06 } }),
  ]],
  // Settlement with NO fallback at all: exercises settleOneSided's UNFUNDED
  // branch, which the spill scenario above never reaches because it has a
  // Brokerage to fall back on. Without this case, mis-tagging that branch
  // passes every test in the suite (verified by mutation).
  ['settlement goes unfunded', { start: 50, retire: 65 }, [
    base({ instrument: 'realEstate', displayName: 'Home', isPrimaryHome: true,
           startCurrency: { amount: 600000 }, startBasisCurrency: { amount: 600000 },
           annualReturnRate: { rate: 0.03 }, annualTaxRate: { rate: 0.015 },
           annualMaintenanceRate: { rate: 0.02 }, annualInsuranceCost: { amount: 6000 } }),
    base({ instrument: 'bank', displayName: 'Checking', startCurrency: { amount: 3000 }, startBasisCurrency: { amount: 3000 } }),
  ]],
  // DOUBLE depletion: the funding account clamps AND the account it falls back
  // to clamps in the same draw, hitting settleOneSided's inner unfunded branch.
  // Needs an obligation large enough to exhaust both in one month, which is why
  // the carrying costs are deliberately punitive against tiny balances.
  ['settlement exhausts its fallback too', { start: 50, retire: 65 }, [
    base({ instrument: 'realEstate', displayName: 'Home', isPrimaryHome: true,
           startCurrency: { amount: 1200000 }, startBasisCurrency: { amount: 1200000 },
           annualReturnRate: { rate: 0.03 }, annualTaxRate: { rate: 0.02 },
           annualMaintenanceRate: { rate: 0.05 }, annualInsuranceCost: { amount: 24000 } }),
    base({ instrument: 'cash', displayName: 'Wallet', startCurrency: { amount: 1200 }, startBasisCurrency: { amount: 1200 } }),
    base({ instrument: 'taxableEquity', displayName: 'Brokerage', startCurrency: { amount: 2500 }, startBasisCurrency: { amount: 2500 } }),
  ]],
  ['transfer goes unfunded', { start: 50, retire: 65 }, [
    base({ instrument: 'monthlyExpense', displayName: 'Living', startCurrency: { amount: -6000 }, startBasisCurrency: { amount: 0 },
           fundTransfers: [{ toDisplayName: 'Brokerage', monthlyMoveValue: 100, closeMoveValue: 0 }] }),
    base({ instrument: 'taxableEquity', displayName: 'Brokerage', startCurrency: { amount: 40000 }, startBasisCurrency: { amount: 40000 } }),
  ]],
];

// Capture the engine's own conservation complaint. logger.log is a no-op in
// production, so this is the only way to observe monthlySanityCheck's verdict.
const complaints = [];
logger.log = (cat, msg) => {
  if (typeof msg === 'string' && msg.includes('Transfer conservation broken')) complaints.push(msg);
};

const seenOrigins = new Set();
for (const [name, ages, assets] of shortfallScenarios) {
  complaints.length = 0;
  const portfolio = await run(assets, ages);

  // THE assertion that catches a mis-tagged origin. The accumulation oracle
  // cannot: Early Career never spills from a settlement, so tagging that path
  // wrongly is invisible there. These scenarios exercise it directly.
  check(`${name}: conservation holds`, () => {
    assert.deepEqual(complaints, [],
      `${complaints.length} month(s) broke transfer conservation:\n      ` +
      complaints.slice(0, 3).join('\n      ') +
      `\n      A mis-tagged shortfall origin puts a term in the wrong total.`);
  });

  check(`${name}: every shortfall declares a valid origin`, () => {
    const valid = new Set(Object.values(ShortfallOrigin));
    let found = 0;
    for (const a of portfolio.modelAssets) {
      for (const e of a.events) {
        if (e.type !== EventType.SPILLOVER && e.type !== EventType.UNFUNDED) continue;
        found++;
        seenOrigins.add(e.data?.origin);
        assert.ok(valid.has(e.data?.origin),
          `${a.displayName}: ${e.type} recorded origin "${e.data?.origin}"`);
      }
    }
    assert.ok(found > 0, 'fixture produced no shortfalls — it is not testing anything');
  });
}

check('shortfalls are observed from more than one origin', () => {
  // If every shortfall in the suite shared one origin, the provenance split
  // would be untested however green it looked.
  assert.ok(seenOrigins.size >= 2,
    `only saw origins [${[...seenOrigins]}] — the paired/one-sided split is untested`);
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
