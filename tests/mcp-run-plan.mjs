/**
 * mcp-run-plan.mjs
 *
 * The headless run seam — the one path every non-browser caller takes.
 *
 * ── Why these particular assertions ──────────────────────────────────
 *
 * The MCP server shipped for months producing a report that was confidently
 * wrong, and every defect was of the same kind: setup the app performs and the
 * server did not. None of them threw. All of them produced a plausible-looking
 * table of numbers, which is the worst possible failure mode for something an
 * agent will summarise as advice.
 *
 * So the assertions here are FIDELITY assertions, each pinned to one of the
 * three original defects:
 *
 *   1. Ages must reshape the plan. `startAge` was advertised and moved nothing,
 *      because asset dates are derived inside buildQuickStart and the server
 *      set globals afterwards. A test that only checks "a run completes" passes
 *      against that bug — so this asserts a DATE MOVED.
 *
 *   2. Life events must reach the portfolio. Dropping them still simulates:
 *      the funding backstop pays the bills and net worth climbs forever. The
 *      only visible symptom is that no phase transition happens, so this
 *      asserts the transition itself, not the absence of a crash.
 *
 *   3. Filing status must come from the plan. An MFJ profile run on Single
 *      tables produces smaller numbers, not an error. This asserts the TABLE,
 *      because that is where the wrongness actually lives.
 *
 * Plus the leak that a server (unlike the app) is uniquely exposed to: globals
 * are module state, so plan N+1 inherits plan N unless every run resets.
 *
 * Usage:  node src/tests/mcp-run-plan.mjs   (from repo root)
 */

import assert from 'node:assert/strict';

const store = {};
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

import { runPlan, runProfile, planFromProfile, listProfiles } from '../js/mcp/run-plan.js';
import { LifeEventType } from '../js/life-event.js';
import * as globals from '../js/globals.js';

let passed = 0, failed = 0;

/**
 * AWAITS fn. The sibling suites' check() is synchronous, which is fine there
 * because their fixtures are built up front. Half the assertions here are
 * necessarily async — a run is a promise — and a synchronous check() reports ✓
 * for a rejected one, then crashes the process on the unhandled rejection after
 * the summary has already printed "0 failed". Verified, not assumed.
 */
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

const salaryOf = (p) => p.modelAssets.find(a => a.displayName.startsWith('Salary'));
const finishInt = (a) => a.finishDateInt.year * 100 + a.finishDateInt.month;

// ── Runs at all ──────────────────────────────────────────────────────
console.log('\n── The seam runs ──\n');

const mid = await runProfile('midCareer');

await check('a profile runs to completion and produces history', () => {
  assert.ok(mid.portfolio.modelAssets.length > 0, 'no assets');
  assert.ok(mid.portfolio.traceScopes?.length > 0,
    'no trace scopes — the run did not go through chronometer_run');
});

await check('an unknown profile key names the ones that exist', () => {
  assert.throws(() => planFromProfile('nope'), /Known profiles:.*midCareer/);
});

await check('every listed profile key actually builds', () => {
  for (const p of listProfiles()) {
    const spec = planFromProfile(p.key);
    assert.ok(spec.modelAssets.length > 0, `${p.key} built no assets`);
  }
});

await check('a spec with no assets is refused rather than silently empty', async () => {
  await assert.rejects(() => runPlan({ modelAssets: [] }), /no modelAssets/);
});

// ── Defect 1: ages must reshape the plan ─────────────────────────────
console.log('\n── Ages are structural, not decorative ──\n');

const young = await runProfile('midCareer', { startAge: 35, retirementAge: 67, finishAge: 85 });
const older = await runProfile('midCareer', { startAge: 57, retirementAge: 67, finishAge: 85 });

await check('a different start age moves the salary finish date', () => {
  // The original bug: both of these returned 2048-01, because the profile's own
  // startAge (45) was used and the override never reached dateAnchors.
  const y = finishInt(salaryOf(young.portfolio));
  const o = finishInt(salaryOf(older.portfolio));
  assert.notEqual(y, o,
    `start age 35 and 57 produced the same salary finish (${y}) — the override is being ignored`);
});

await check('the salary ends the year the plan says retirement begins', () => {
  // 57 today, retiring at 67 → salary runs 10 more years. Derived, not asserted
  // against a literal, so this stays true as the calendar advances.
  const startYear = older.portfolio.firstDateInt.year;
  const expected = startYear + (67 - 57);
  assert.equal(salaryOf(older.portfolio).finishDateInt.year, expected,
    `salary should finish in ${expected}`);
});

const to85 = await runProfile('midCareer', { startAge: 45, retirementAge: 67, finishAge: 85 });
const to95 = await runProfile('midCareer', { startAge: 45, retirementAge: 67, finishAge: 95 });

await check('a later finish age extends the simulation by exactly that many years', () => {
  assert.equal(to95.portfolio.lastDateInt.year - to85.portfolio.lastDateInt.year, 10,
    'finish age did not extend the run');
});

// ── Defect 2: life events must reach the portfolio ───────────────────
console.log('\n── Life events reach the run ──\n');

await check('the portfolio carries the plan\'s life events', () => {
  assert.ok(mid.portfolio.lifeEvents.length >= 2,
    `expected accumulate + retire phases, got ${mid.portfolio.lifeEvents.length}`);
});

await check('both an accumulation and a retirement phase are present', () => {
  const types = mid.portfolio.lifeEvents.map(e => e.type);
  assert.ok(types.some(t => LifeEventType.isAccumulation(t)), 'no accumulation phase');
  assert.ok(types.length >= 2, 'no second phase to transition into');
});

const lifeEventScopes = (p) => (p.traceScopes ?? []).filter(s => /^Life event:/.test(s.label));

await check('the phase transition actually fires during the run', () => {
  // NOT "the salary closed" — the first draft asserted that and it was vacuous:
  // the salary carries a finishDateInt and closes on its own date whether or not
  // a phase ever triggers. Caught by the control below. portfolio.applyLifeEvents
  // opens a `Life event:` scope when one fires, so the scope IS the evidence that
  // the transition executed.
  assert.ok(lifeEventScopes(mid.portfolio).length > 0,
    'no life-event scope in the run — no phase ever transitioned');
});

await check('WITHOUT life events nothing transitions — the control case', async () => {
  // Pins the old server's behaviour, and keeps the assertion above honest.
  const spec = planFromProfile('midCareer');
  spec.lifeEvents = [];
  const { portfolio } = await runPlan(spec);
  assert.equal(portfolio.lifeEvents.length, 0, 'fixture did not actually drop the life events');
  assert.equal(lifeEventScopes(portfolio).length, 0,
    'a life-event scope fired with no life events — the test above proves nothing');
});

await check('dropping the life events changes the answer', async () => {
  // The consequence, in money. If phases made no difference to the outcome, the
  // whole fidelity argument would be academic.
  const spec = planFromProfile('midCareer');
  spec.lifeEvents = [];
  const { portfolio: without } = await runPlan(spec);

  const ending = (p) => p.modelAssets.reduce(
    (sum, a) => sum + (a.finishCurrency?.amount ?? 0), 0);

  assert.notEqual(Math.round(ending(without)), Math.round(ending(mid.portfolio)),
    'phases changed nothing about the outcome');
});

// ── Defect 3: filing status comes from the plan ──────────────────────
console.log('\n── Filing status selects the tables ──\n');

const joint = await runProfile('dualIncome');

await check('an MFJ profile sets MFJ, not the Single default', () => {
  assert.equal(globals.global_filingAs, 'MFJ',
    'a joint profile ran on Single — wrong brackets, limits and exclusion');
});

await check('the MFJ home-sale exclusion is the joint figure', () => {
  // $500,000 and never inflation-indexed, so this is a safe literal.
  assert.equal(globals.activeTaxTable.activeHomeSaleExclusion, 500000,
    'joint filers got the single $250,000 exclusion');
});

await check('a Single profile run AFTER a joint one is not still joint', async () => {
  // Every run sets filing status explicitly, so this passes with or without the
  // reset. It is here as a regression guard on the ORDERING — the TaxTable is
  // built after filingAs, and swapping those two lines pins the previous plan's
  // tables while leaving global_filingAs looking correct.
  await runProfile('midCareer');
  assert.equal(globals.global_filingAs, 'Single',
    'filing status leaked from the previous plan');
  assert.equal(globals.activeTaxTable.activeHomeSaleExclusion, 250000,
    'the tax table leaked from the previous plan');
});

await check('a setting the spec OMITS falls back to the default, not the last plan', async () => {
  // What global_reset() is actually for, and the only assertion that makes it
  // load-bearing. Filing status and inflation are re-set explicitly on every
  // run, so they survive without a reset; the AGES are set conditionally, so a
  // spec that omits one inherits the previous plan's value.
  //
  // Found by mutation: commenting out global_reset() left all 18 other
  // assertions green, which meant the reset was decoration. It fails this one.
  const explicit = planFromProfile('midCareer');
  explicit.settings.startAge = 61;
  await runPlan(explicit);
  assert.equal(globals.global_user_startAge, 61, 'fixture did not set the age it claims to');

  const silent = planFromProfile('midCareer');
  delete silent.settings.startAge;
  await runPlan(silent);

  assert.equal(globals.global_user_startAge, globals.global_default_user_startAge,
    'an omitted start age inherited the previous plan — globals leak between runs');
});

// ── Issues come back ─────────────────────────────────────────────────
console.log('\n── Findings are reported ──\n');

await check('detectIssues runs and returns an array', () => {
  assert.ok(Array.isArray(mid.issues), 'issues is not an array');
});

await check('engine diagnostics are excluded unless asked for', () => {
  assert.equal(mid.issues.filter(i => i.category === 'reconciliation').length, 0,
    'reconciliation findings leaked into the default report');
});

await check('a plan that cannot pay reports an obligation finding', () => {
  // Retiring at 57 on the Mid Career balances is not fundable; the engine
  // should say so rather than quietly drawing down forever.
  return runProfile('midCareer', { startAge: 57, retirementAge: 58, finishAge: 95 })
    .then(({ issues }) => {
      assert.ok(issues.some(i => i.category === 'obligation'),
        'an underfunded plan produced no obligation finding');
    });
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
