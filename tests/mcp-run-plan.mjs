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
import { generatePortfolioMarkdown } from '../js/generators/finplan-ai.js';
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

await check('an MFJ profile runs on MFJ, not the Single default', () => {
  // Asserted on the RUN'S OWN CONFIG since Spec 9 step 5b, not on
  // global_filingAs. run-plan no longer writes a module global — that is the
  // point of the step — so the old assertion would have been reading a value
  // nothing sets, and passing or failing for reasons unrelated to the plan.
  // This is also the stronger claim: the run used MFJ, rather than the process
  // happened to hold MFJ.
  assert.equal(joint.portfolio.config.filingAs, 'MFJ',
    'a joint profile ran on Single — wrong brackets, limits and exclusion');
});

await check('the MFJ home-sale exclusion is the joint figure', () => {
  // $500,000 and never inflation-indexed, so this is a safe literal.
  assert.equal(joint.portfolio.config.taxTable.activeHomeSaleExclusion, 500000,
    'joint filers got the single $250,000 exclusion');
});

await check('a Single profile run AFTER a joint one is not still joint', async () => {
  // Still a regression guard on the ORDERING: the TaxTable is built FROM the
  // resolved filing status inside simConfigFromPlanSpec, so handing it the
  // wrong one pins the previous plan's tables. Under the old globals sequence
  // the two lines could be swapped; now they are one expression, and this
  // asserts the result.
  const single = await runProfile('midCareer');
  assert.equal(single.portfolio.config.filingAs, 'Single',
    'filing status leaked from the previous plan');
  assert.equal(single.portfolio.config.taxTable.activeHomeSaleExclusion, 250000,
    'the tax table leaked from the previous plan');

  // The two runs held DIFFERENT tables — the sharpest statement that a config
  // is per-run rather than ambient. Under the old design both read one module
  // global, so this could not have been asserted at all.
  assert.notEqual(single.portfolio.config.taxTable,
                  joint.portfolio.config.taxTable,
                  'both runs shared one tax table');
});

await check('a setting the spec OMITS falls back to the default, not the last plan', async () => {
  // What global_reset() used to be for. It is now structural: every run builds
  // its own config from its own spec, so there is no channel through which the
  // previous plan could reach this one. The assertion survives the mechanism
  // change because what it protects — an omitted age must not inherit — is a
  // property of the result, not of the implementation.
  const explicit = planFromProfile('midCareer');
  explicit.settings.startAge = 61;
  const explicitRun = await runPlan(explicit);
  assert.equal(explicitRun.portfolio.config.startAge, 61,
    'fixture did not set the age it claims to');

  const silent = planFromProfile('midCareer');
  delete silent.settings.startAge;
  const silentRun = await runPlan(silent);

  assert.equal(silentRun.portfolio.config.startAge, globals.global_default_user_startAge,
    'an omitted start age inherited the previous plan');
});

await check('running a plan writes NOTHING to the module globals', async () => {
  // The migration's actual claim, and it could not be made before. Two plans in
  // one process no longer share a configuration, which is why the run-handle
  // cache stops being a correctness requirement.
  const before = globals.global_workerSnapshot();
  await runProfile('dualIncome');          // MFJ, different ages from the default
  const after = globals.global_workerSnapshot();
  assert.deepEqual(after, before,
    'runPlan mutated module state: ' + JSON.stringify({ before, after }));
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

// ── Granularity ──────────────────────────────────────────────────────
//
// The seam constructs the Portfolio, and the second constructor argument
// decides whether the run records anything between "lifetime" and "one event".
// It was false here from this file's first commit, so every report this server
// produced skipped the Annual Cash Flow table silently — the generator emits
// the section only when yearly reports exist, and no test built a portfolio
// through runPlan to notice. These assert the datasets, then the surface.
console.log('\n── Annual and monthly datasets ──\n');

await check('a run records the ANNUAL dataset', () => {
  const yearly = mid.portfolio.generatedReports.filter(r => r.type === 'yearly');
  assert.ok(yearly.length > 1,
    `runPlan produced ${yearly.length} yearly report(s) — the Annual Cash Flow table `
    + 'is generated from these, so the report has no annual granularity at all');
});

await check('a run records the MONTHLY dataset alongside it', () => {
  const monthly = mid.portfolio.generatedReports.filter(r => r.type === 'monthly');
  const yearly = mid.portfolio.generatedReports.filter(r => r.type === 'yearly');
  // The count first: `>= yearly * 11` alone is satisfied by 0 >= 0, which is
  // exactly the state this is meant to catch. Verified by mutation — with the
  // flag off it passed while its two siblings failed.
  assert.ok(monthly.length > 12, `only ${monthly.length} monthly package(s) recorded`);
  assert.ok(monthly.length >= yearly.length * 11,
    `${monthly.length} monthly package(s) against ${yearly.length} yearly — the finer `
    + 'dataset the report points readers at is not being recorded');
});

await check('the report actually renders the Annual Cash Flow table', () => {
  const md = generatePortfolioMarkdown(mid.portfolio);
  assert.ok(md.includes('## Annual Cash Flow'), 'no Annual Cash Flow section');
  assert.ok(!md.includes('_Not recorded for this run'),
    'the section rendered its empty-state placeholder — generatedReports was empty');
  assert.ok(/\n\| 20\d{2} \|/.test(md), 'the Annual Cash Flow table has no year rows');
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
