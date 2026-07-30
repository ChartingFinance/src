/**
 * trace-scopes.mjs
 *
 * "Why did the engine do that?" — answered by a chain, not a list.
 *
 * Every event already recorded WHAT happened. Nothing recorded that a brokerage
 * debit, a clamped IRA transfer and a realized gain were the same story. Causal
 * scopes supply the edges: an engine operation wraps itself in `withTrace`, and
 * every event recorded inside carries that scope's id.
 *
 * The load-bearing assertions here are structural, because a broken chain is
 * worse than no chain — it asserts a causal claim that is false:
 *
 *   - NO event may be left unattributed. An event with a null traceId is one
 *     the engine cannot explain.
 *   - No scope may be left open at the end of a run. A leak silently reparents
 *     every later event.
 *   - Chains must be acyclic and rooted, with depth increasing by one.
 *   - Traces are run state: a re-run rebuilds them rather than accumulating.
 *
 * Plus the actual payoff, asserted on a real simulation: a spillover on the
 * brokerage chains back through the transfer that clamped to the expense that
 * caused it, and the siblings in its scope account for the whole movement.
 *
 * Usage:  node src/tests/trace-scopes.mjs   (from repo root)
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
import { quickStartProfiles, buildQuickStart } from '../js/quick-start.js';
import { Portfolio } from '../js/portfolio.js';
import { chronometer_run } from '../js/chronometer.js';
import { TaxTable } from '../js/taxes.js';
import { renderNote, EventType } from '../js/sim-event.js';
import {
  withTrace, TraceKind, currentTraceId, traceScopes, resetTraces,
  assertNoOpenScopes, chainFor, chainLabel, explainEvent, scopeById,
} from '../js/trace.js';
import {
  setActiveTaxTable,
  global_setUserStartAge, global_getUserStartAge,
  global_setUserRetirementAge, global_getUserRetirementAge,
} from '../js/globals.js';

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

// ── The mechanism ────────────────────────────────────────────────────
console.log('\n── Scope mechanics ──\n');

check('a scope is ambient — nothing passes an id around', () => {
  resetTraces();
  assert.equal(currentTraceId(), null, 'an id exists with no scope open');
  withTrace(TraceKind.MONTH, 'January 2026', null, () => {
    const outer = currentTraceId();
    assert.ok(outer, 'no id inside a scope');
    withTrace(TraceKind.EXPENSE, 'Pay Rent', null, () => {
      assert.notEqual(currentTraceId(), outer, 'a nested scope reused its parent id');
      assert.equal(scopeById(currentTraceId(), traceScopes()).parentId, outer, 'nesting lost the parent link');
    });
    assert.equal(currentTraceId(), outer, 'the stack did not unwind');
  });
  assert.equal(currentTraceId(), null, 'the root did not unwind');
});

check('a throwing operation still unwinds its scope', () => {
  // Without `finally`, an engine that throws mid-settlement would leave a scope
  // open and reparent the rest of the run onto it.
  resetTraces();
  try {
    withTrace(TraceKind.SETTLEMENT, 'boom', null, () => { throw new Error('engine failed'); });
  } catch { /* expected */ }
  assert.equal(currentTraceId(), null, 'a throw leaked an open scope');
  assert.ok(assertNoOpenScopes());
});

check('resetTraces clears scopes and ids', () => {
  resetTraces();
  withTrace(TraceKind.MONTH, 'x', null, () => {});
  assert.ok(traceScopes().length > 0);
  resetTraces();
  assert.equal(traceScopes().length, 0);
  assert.equal(currentTraceId(), null);
});

// ── On a real simulation ─────────────────────────────────────────────

async function run(assets, ages) {
  setActiveTaxTable(new TaxTable());
  global_setUserStartAge(ages.start); global_getUserStartAge();
  global_setUserRetirementAge(ages.retire); global_getUserRetirementAge();
  const p = new Portfolio(assets.map(o => ModelAsset.fromJSON(o)), false);
  await chronometer_run(p);
  return p;
}

const S = { year: 2026, month: 1 }, F = { year: 2032, month: 12 };
const base = (x) => ({ startDateInt: S, finishDateInt: F, annualReturnRate: { rate: 0 }, ...x });

// An IRA funding an expense it cannot cover, with a brokerage behind it: the
// exact story the causal chain exists to explain.
const clamping = await run([
  base({ instrument: 'monthlyExpense', displayName: 'Living Expenses',
         startCurrency: { amount: -5000 }, startBasisCurrency: { amount: 0 },
         fundTransfers: [{ toDisplayName: 'IRA', monthlyMoveValue: 100, closeMoveValue: 0 }] }),
  base({ instrument: 'ira', displayName: 'IRA', startCurrency: { amount: 60000 }, startBasisCurrency: { amount: 0 } }),
  base({ instrument: 'taxableEquity', displayName: 'Brokerage', startCurrency: { amount: 400000 },
         startBasisCurrency: { amount: 250000 }, annualReturnRate: { rate: 0.06 } }),
], { start: 50, retire: 65 });

console.log('\n── Structural integrity ──\n');

check('the run opened scopes and left none open', () => {
  assert.ok(clamping.traceScopes.length > 100,
    `only ${clamping.traceScopes.length} scopes — the openers are not firing`);
  assert.ok(assertNoOpenScopes(), 'a scope was left open at end of run');
});

check('EVERY recorded event is attributed to a scope', () => {
  // An event with no traceId is one the engine cannot explain. Life events fire
  // outside applyMonth, so they carry their own root — without it, asset
  // closures would be the only unattributable events in the run.
  const orphans = [];
  for (const a of clamping.modelAssets) {
    for (const e of a.events) {
      if (e.traceId == null) orphans.push(`${a.displayName}: ${renderNote(e)}`);
    }
  }
  assert.deepEqual(orphans.slice(0, 5), [],
    `${orphans.length} event(s) have no causal scope`);
});

check('every chain is rooted, acyclic and depth-consistent', () => {
  for (const scope of clamping.traceScopes) {
    const chain = chainFor(scope.id, clamping.traceScopes);
    assert.ok(chain.length > 0, `scope ${scope.id} resolves to nothing`);
    assert.equal(chain[0].parentId, null, `chain for ${scope.id} is not rooted`);
    assert.equal(chain[chain.length - 1].id, scope.id, 'chain does not end at its own scope');
    chain.forEach((s, i) => assert.equal(s.depth, i, `depth ${s.depth} at position ${i}`));
    const ids = new Set(chain.map(s => s.id));
    assert.equal(ids.size, chain.length, `cycle in chain for ${scope.id}`);
  }
});

// Awaited OUT here, not inside check(), which is synchronous — a promise handed
// to it would make the assertion unfailable.
const scopesBeforeRerun = clamping.traceScopes.length;
await chronometer_run(clamping);
check('a re-run rebuilds traces rather than accumulating them', () => {
  assert.equal(clamping.traceScopes.length, scopesBeforeRerun,
    `scopes grew from ${scopesBeforeRerun} to ${clamping.traceScopes.length} across an identical re-run`);
});

// A profile WITH life events. The clamping fixture above has none, so without
// this the life-event scope could be deleted with every assertion still green
// (verified by mutation) — phase transitions close assets and fire close
// transfers, and those events are emitted OUTSIDE applyMonth.
const phased = await (async () => {
  const profile = quickStartProfiles.find(p => p.key === 'earlyCareer');
  const qs = buildQuickStart(profile);
  setActiveTaxTable(new TaxTable());
  global_setUserStartAge(qs.ages.startAge); global_getUserStartAge();
  global_setUserRetirementAge(qs.ages.retirementAge); global_getUserRetirementAge();
  const p = new Portfolio(qs.assets, false);
  p.lifeEvents = qs.lifeEvents.map(e => e.copy());
  await chronometer_run(p);
  return p;
})();

check('a phased plan opens life-event scopes', () => {
  const lifeScopes = phased.traceScopes.filter(s => /^Life event:/.test(s.label));
  assert.ok(lifeScopes.length > 0,
    'no life-event scopes — phase transitions are unattributable');
});

check('EVERY event in a phased plan is attributed, including asset closures', () => {
  const orphans = [];
  for (const a of phased.modelAssets) {
    for (const e of a.events) {
      if (e.traceId == null) orphans.push(`${a.displayName}: ${renderNote(e)}`);
    }
  }
  assert.deepEqual(orphans.slice(0, 5), [],
    `${orphans.length} event(s) have no causal scope in a plan with life events`);
});

check('annual events nest under the annual pass, not float as roots', () => {
  // "Every event has an id" cannot tell a properly parented event from an
  // orphan root: deleting an outer scope just promotes its children. So assert
  // the SHAPE. Verified by mutation — removing the annual-pass scope passes the
  // attribution check and fails this one.
  const annual = phased.modelAssets
    .flatMap(a => a.events)
    .find(e => e.type === EventType.INCOME_GROWTH || e.type === EventType.TAX_TRUE_UP);
  assert.ok(annual, 'fixture produced no annual event');
  const chain = chainFor(annual.traceId, phased.traceScopes);
  assert.ok(chain.length >= 2,
    `annual event is its own root — the annual pass scope is missing: "${chainLabel(annual.traceId, phased.traceScopes)}"`);
  assert.match(chain[0].label, /annual pass$/,
    `annual chain is not rooted at the annual pass: "${chainLabel(annual.traceId, phased.traceScopes)}"`);
});

// ── The payoff ───────────────────────────────────────────────────────
console.log('\n── Answering "why did that happen?" ──\n');

const brokerage = clamping.modelAssets.find(a => a.displayName === 'Brokerage');
const spillover = brokerage.events.find(e => e.type === EventType.SPILLOVER);

check('the fixture actually produced the story we mean to explain', () => {
  assert.ok(spillover, 'no spillover on the Brokerage — the fixture stopped clamping');
});

check('a brokerage spillover chains back to the expense that caused it', () => {
  const chain = chainFor(spillover.traceId, clamping.traceScopes);
  const kinds = chain.map(s => s.kind);
  assert.deepEqual(kinds, [TraceKind.MONTH, TraceKind.EXPENSE, TraceKind.TRANSFER],
    `expected month > expense > transfer, got [${kinds}]`);
  assert.match(chain[1].label, /Living Expenses/, 'the expense is not named in the chain');
  assert.match(chain[2].label, /IRA/, 'the transfer that clamped is not named');
});

check('the chain renders as a sentence a person can read', () => {
  const label = chainLabel(spillover.traceId, clamping.traceScopes);
  assert.match(label, /^\w+ \d{4} > Pay Living Expenses > Transfer Living Expenses/,
    `unreadable chain: "${label}"`);
});

check('the scope accounts for the WHOLE movement, not just one leg', () => {
  // A brokerage debit alone looks arbitrary. Beside the clamped IRA transfer and
  // the realized gain in the same scope it is obviously step three of one story.
  const { siblings } = explainEvent(spillover, clamping.modelAssets, clamping.traceScopes);
  const types = siblings.map(s => s.event.type);
  assert.ok(types.filter(t => t === EventType.TRANSFER).length >= 2,
    `expected both transfer legs in the scope, got [${types}]`);
  assert.ok(types.includes(EventType.SPILLOVER), 'the spillover is missing from its own scope');
  assert.ok(siblings.some(s => s.asset === 'IRA'), 'the depleted account is not in the scope');
  assert.ok(siblings.some(s => s.asset === 'Brokerage'), 'the covering account is not in the scope');
});

// Same mechanism, no fallback: the shortfall must still name its cause.
const broke = await run([
  base({ instrument: 'monthlyExpense', displayName: 'Rent', startCurrency: { amount: -3000 },
         startBasisCurrency: { amount: 0 },
         fundTransfers: [{ toDisplayName: 'IRA', monthlyMoveValue: 100, closeMoveValue: 0 }] }),
  base({ instrument: 'ira', displayName: 'IRA', startCurrency: { amount: 9000 }, startBasisCurrency: { amount: 0 } }),
], { start: 50, retire: 65 });

check('an unfunded shortfall is attributable too', () => {
  const unfunded = broke.modelAssets.flatMap(a => a.events).find(e => e.type === EventType.UNFUNDED);
  assert.ok(unfunded, 'fixture produced no unfunded event');
  assert.ok(unfunded.traceId != null, 'an unfunded obligation has no causal scope');
  assert.match(chainLabel(unfunded.traceId, broke.traceScopes), /Pay Rent/,
    `unfunded chain does not name the obligation: "${chainLabel(unfunded.traceId, broke.traceScopes)}"`);
});

check('a chain still resolves after a LATER run has reset module state', () => {
  // The flaw this catches: resolution originally used the ambient module scope
  // list, so a chain looked up after a second run silently found nothing.
  // calculate() re-runs on every edit, so that is the NORMAL case. Reads take
  // the run's own traceScopes; `phased` ran after `clamping`, and clamping must
  // still be able to explain its own events.
  const chain = chainFor(spillover.traceId, clamping.traceScopes);
  assert.ok(chain.length >= 3,
    'an older run can no longer explain its own events — resolution is reading module state');
  assert.match(chainLabel(spillover.traceId, clamping.traceScopes), /Pay Living Expenses/);
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
