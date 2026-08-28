/**
 * sim-event-invariant.mjs
 *
 * Every credit memo is the rendering of exactly one SimEvent.
 *
 * `recordEvent()` appends a structured event and the memo rendered from it, in
 * that order, one for one. That pairing is load-bearing rather than tidy:
 * `monthlySanityCheck` scans memos incrementally from
 * `creditMemosCheckedIndex`, so anything that lets the two arrays drift —
 * a stray `creditMemos.push`, an event recorded without a memo, a reordered
 * append — could double-count or skip a month's reconciliation, and the
 * complaint would go to `logger.log()`, which is a no-op.
 *
 * This also proves the migration itself: as long as index i of one array
 * matches index i of the other on amount, date and rendered note, the ledger
 * the rest of the app reads is unchanged.
 *
 * Usage:  node src/tests/sim-event-invariant.mjs   (from repo root)
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
import { Portfolio } from '../js/portfolio.js';
import { chronometer_run } from '../js/chronometer.js';
import {
  setActiveTaxTable,
  global_setUserStartAge, global_getUserStartAge,
  global_setUserRetirementAge, global_getUserRetirementAge,
} from '../js/globals.js';
import { EventType, renderNote, kindOf } from '../js/sim-event.js';
import { InstrumentType } from '../js/instruments/instrument.js';
import { simConfigFromGlobals } from '../js/globals.js';
import { makeActiveTaxTable } from '../js/globals.js';

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

const S = { year: 2026, month: 1 };
const F = { year: 2031, month: 12 };
const base = (extra) => ({ startDateInt: S, finishDateInt: F, annualReturnRate: { rate: 0 }, ...extra });

// Same scenario set as memo-vocabulary.mjs: chosen to reach as many write
// sites as the engine has.
const SCENARIOS = {
  payroll: { ages: { start: 45, retire: 65 }, assets: [
    base({ instrument: 'workingIncome', displayName: 'Salary', startCurrency: { amount: 20000 }, startBasisCurrency: { amount: 0 },
           fundTransfers: [{ toDisplayName: '401K', monthlyMoveValue: 60, closeMoveValue: 0 }] }),
    base({ instrument: '401K', displayName: '401K', startCurrency: { amount: 10000 }, startBasisCurrency: { amount: 0 } }),
    base({ instrument: 'bank', displayName: 'Savings', startCurrency: { amount: 90000 }, startBasisCurrency: { amount: 90000 } }),
  ]},
  housing: { ages: { start: 50, retire: 65 }, assets: [
    base({ instrument: 'realEstate', displayName: 'Home', isPrimaryHome: true, startCurrency: { amount: 500000 }, startBasisCurrency: { amount: 500000 },
           annualReturnRate: { rate: 0.03 }, annualTaxRate: { rate: 0.012 }, annualMaintenanceRate: { rate: 0.01 }, annualInsuranceCost: { amount: 2400 } }),
    base({ instrument: 'mortgage', displayName: 'Mortgage', startCurrency: { amount: -300000 }, startBasisCurrency: { amount: 0 },
           annualReturnRate: { rate: 0.065 }, monthsRemaining: 360 }),
    base({ instrument: 'bank', displayName: 'Checking', startCurrency: { amount: 4000 }, startBasisCurrency: { amount: 4000 } }),
    base({ instrument: 'taxableEquity', displayName: 'Brokerage', startCurrency: { amount: 400000 }, startBasisCurrency: { amount: 200000 }, annualReturnRate: { rate: 0.07 } }),
  ]},
  yielding: { ages: { start: 50, retire: 65 }, assets: [
    base({ instrument: 'taxableEquity', displayName: 'Equity', startCurrency: { amount: 300000 }, startBasisCurrency: { amount: 150000 },
           annualReturnRate: { rate: 0.06 }, annualDividendRate: { rate: 0.02 }, dividendQualifiedRatio: 0.6,
           oneTimeEvents: [{ dateInt: { year: 2027, month: 4 }, amount: { amount: 25000 }, note: 'inheritance' }] }),
    base({ instrument: 'usBond', displayName: 'Bonds', startCurrency: { amount: 100000 }, startBasisCurrency: { amount: 100000 }, annualReturnRate: { rate: 0.04 } }),
    base({ instrument: 'cash', displayName: 'Cash', startCurrency: { amount: 50000 }, startBasisCurrency: { amount: 50000 }, annualReturnRate: { rate: 0.02 } }),
    base({ instrument: 'monthlyExpense', displayName: 'Living', startCurrency: { amount: -3000 }, startBasisCurrency: { amount: 0 } }),
  ]},
  broke: { ages: { start: 50, retire: 65 }, assets: [
    base({ instrument: 'monthlyExpense', displayName: 'Rent', startCurrency: { amount: -2500 }, startBasisCurrency: { amount: 0 } }),
  ]},
  retired: { ages: { start: 75, retire: 65 }, assets: [
    base({ instrument: 'retirementIncome', displayName: 'Social Security', startCurrency: { amount: 3000 }, startBasisCurrency: { amount: 0 },
           fundTransfers: [{ toDisplayName: 'Savings', monthlyMoveValue: 100, closeMoveValue: 0 }] }),
    base({ instrument: 'pension', displayName: 'Pension', startCurrency: { amount: 2500 }, startBasisCurrency: { amount: 0 },
           fundTransfers: [{ toDisplayName: 'Savings', monthlyMoveValue: 100, closeMoveValue: 0 }] }),
    base({ instrument: 'ira', displayName: 'IRA', startCurrency: { amount: 800000 }, startBasisCurrency: { amount: 0 } }),
    base({ instrument: 'bank', displayName: 'Savings', startCurrency: { amount: 200000 }, startBasisCurrency: { amount: 200000 } }),
    base({ instrument: 'monthlyExpense', displayName: 'Living', startCurrency: { amount: -5000 }, startBasisCurrency: { amount: 0 } }),
  ]},
  closing: { ages: { start: 50, retire: 65 }, assets: [
    base({ instrument: 'taxableEquity', displayName: 'Sold Equity', finishDateInt: { year: 2027, month: 6 },
           startCurrency: { amount: 200000 }, startBasisCurrency: { amount: 100000 }, annualReturnRate: { rate: 0.06 },
           fundTransfers: [{ toDisplayName: 'Savings', monthlyMoveValue: 0, closeMoveValue: 100 }] }),
    base({ instrument: 'bank', displayName: 'Savings', startCurrency: { amount: 50000 }, startBasisCurrency: { amount: 50000 } }),
  ]},
};

async function run(assets, ages) {
  setActiveTaxTable(makeActiveTaxTable());
  global_setUserStartAge(ages.start); global_getUserStartAge();
  global_setUserRetirementAge(ages.retire); global_getUserRetirementAge();
  const p = new Portfolio(assets.map(o => ModelAsset.fromJSON(o)), true, simConfigFromGlobals());
  await chronometer_run(p);
  return p;
}

const runs = [];
for (const [name, { assets, ages }] of Object.entries(SCENARIOS)) {
  runs.push([name, await run(assets, ages)]);
}

const eachAsset = (fn) => {
  for (const [scenario, portfolio] of runs) {
    for (const asset of portfolio.modelAssets) fn(asset, scenario);
  }
};

console.log('\n── SimEvent / CreditMemo pairing ──\n');

check('the scenarios actually record something', () => {
  let total = 0;
  eachAsset(a => { total += a.events.length; });
  assert.ok(total > 500, `only ${total} events recorded — scenarios stopped covering the engine`);
});

check('every asset has exactly as many events as memos', () => {
  eachAsset((a, s) => {
    assert.equal(a.events.length, a.creditMemos.length,
      `${s}/${a.displayName}: ${a.events.length} events vs ${a.creditMemos.length} memos — ` +
      `something wrote to one array without the other`);
  });
});

check('each memo is the rendering of the event at its own index', () => {
  eachAsset((a, s) => {
    for (let i = 0; i < a.events.length; i++) {
      const e = a.events[i];
      const m = a.creditMemos[i];
      assert.equal(m.note, renderNote(e),
        `${s}/${a.displayName}[${i}]: memo "${m.note}" is not the rendering of ${e.type}`);
      assert.equal(m.amount.amount, e.amount.amount,
        `${s}/${a.displayName}[${i}] (${e.type}): amount ${m.amount.amount} vs ${e.amount.amount}`);
      assert.equal(m.kind, e.kind,
        `${s}/${a.displayName}[${i}] (${e.type}): kind "${m.kind}" vs "${e.kind}"`);
      assert.equal(m.dateInt?.toInt?.() ?? null, e.dateInt?.toInt?.() ?? null,
        `${s}/${a.displayName}[${i}] (${e.type}): dates disagree`);
    }
  });
});

check('cash/info is decided by event type, not by the call site', () => {
  // Every site used to pass `kind` by hand, so two sites emitting the same
  // thing could disagree. It is now a property of the type.
  eachAsset((a, s) => {
    for (const e of a.events) {
      assert.equal(e.kind, kindOf(e.type),
        `${s}/${a.displayName}: ${e.type} recorded kind "${e.kind}", type says "${kindOf(e.type)}"`);
    }
  });
});

check('every event names a type the renderer knows', () => {
  const known = new Set(Object.values(EventType));
  eachAsset((a, s) => {
    for (const e of a.events) {
      assert.ok(known.has(e.type), `${s}/${a.displayName}: unknown event type "${e.type}"`);
    }
  });
});

check('seq is monotonic per asset', () => {
  eachAsset((a, s) => {
    for (let i = 0; i < a.events.length; i++) {
      assert.equal(a.events[i].seq, i, `${s}/${a.displayName}: seq ${a.events[i].seq} at index ${i}`);
    }
  });
});

check('events are chronologically ordered', () => {
  eachAsset((a, s) => {
    let prev = -Infinity;
    for (const e of a.events) {
      const t = e.dateInt?.toInt?.() ?? prev;
      assert.ok(t >= prev, `${s}/${a.displayName}: ${e.type} at ${t} follows ${prev}`);
      prev = t;
    }
  });
});

check('a balance-sheet asset\'s cash events account for its whole balance change', () => {
  // start + sum(cash events) === finish. This is the event log telling the
  // truth about the balance rather than merely being self-consistent, and it is
  // the strongest single statement available about whether the ledger can be
  // trusted.
  //
  // It failed before 2026-07-29: a clamped withdrawal recorded the FULL
  // requested amount, so a $5,000 Checking account's ledger claimed $8,010.33
  // had left it. The spillover was booked twice — once inside the overstated
  // debit, once as the fallback account's SPILLOVER event. #transact now
  // records what actually moved.
  //
  // BALANCE-SHEET ASSETS ONLY. On an income or expense, finishCurrency is the
  // recurring monthly amount — a rate, not a stock — and #transact deliberately
  // records the memo without touching it. A salary paying $20,000/month out for
  // six years books $1.44M of transfers against a balance that never leaves
  // $20,000, and that is correct, not a leak.
  eachAsset((a, s) => {
    if (!InstrumentType.isAsset(a.instrument)) return;
    const cash = a.events.filter(e => e.kind !== 'info');
    const sum = cash.reduce((acc, e) => acc + e.amount.amount, 0);
    const expected = a.startCurrency.amount + sum;
    assert.ok(Math.abs(a.finishCurrency.amount - expected) < 0.02,
      `${s}/${a.displayName}: start ${a.startCurrency.amount.toFixed(2)} + events ` +
      `${sum.toFixed(2)} = ${expected.toFixed(2)}, but balance is ` +
      `${a.finishCurrency.amount.toFixed(2)} (delta ${(a.finishCurrency.amount - expected).toFixed(2)})`);
  });
});

// An account deliberately too small for its obligations. Awaited here rather
// than inside check(), which is synchronous — a promise handed to it would make
// the assertion unfailable.
const clamped = await run([
  { instrument: 'monthlyExpense', displayName: 'Living', startDateInt: S, finishDateInt: F,
    startCurrency: { amount: -4000 }, startBasisCurrency: { amount: 0 }, annualReturnRate: { rate: 0 } },
  { instrument: 'bank', displayName: 'Checking', startDateInt: S, finishDateInt: F,
    startCurrency: { amount: 5000 }, startBasisCurrency: { amount: 5000 }, annualReturnRate: { rate: 0 } },
  { instrument: 'taxableEquity', displayName: 'Brokerage', startDateInt: S, finishDateInt: F,
    startCurrency: { amount: 300000 }, startBasisCurrency: { amount: 300000 }, annualReturnRate: { rate: 0 } },
], { start: 50, retire: 65 });

check('a clamped withdrawal records only what the account could supply', () => {
  const chk = clamped.modelAssets.find(a => a.displayName === 'Checking');
  assert.equal(chk.isDepleted, true, 'fixture is wrong: Checking should deplete');
  const out = chk.events.filter(e => e.kind !== 'info')
                        .reduce((s, e) => s + e.amount.amount, 0);
  assert.ok(Math.abs(out) <= 5000.01,
    `Checking only ever held $5,000 but its ledger says ${Math.abs(out).toFixed(2)} left it`);
});

check('run state is not serialized', () => {
  // Share links and worker payloads go through toJSON; carrying a full event
  // log would bloat both with data the receiver regenerates anyway.
  const [, portfolio] = runs[0];
  const asset = portfolio.modelAssets.find(a => a.events.length > 0);
  assert.ok(asset, 'no asset recorded any events');
  const json = JSON.parse(JSON.stringify(asset));
  assert.ok(!('events' in json), 'events leaked into toJSON()');
  assert.ok(!('creditMemos' in json), 'creditMemos leaked into toJSON()');
});

check('a re-run rebuilds the log rather than appending to it', () => {
  // initializeChron resets run state; without that, the GA optimizer's
  // thousands of re-runs would grow the log without bound.
  const [, portfolio] = runs[0];
  const before = portfolio.modelAssets.map(a => a.events.length);
  chronometer_run(portfolio);
  const after = portfolio.modelAssets.map(a => a.events.length);
  assert.deepEqual(after, before, 'event log grew across an identical re-run');
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
