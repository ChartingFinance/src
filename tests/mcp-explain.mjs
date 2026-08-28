/**
 * mcp-explain.mjs
 *
 * "Why did the engine do that?" — exposed over MCP.
 *
 * ── What actually needs guarding ─────────────────────────────────────
 *
 * A chain is a CAUSAL CLAIM. An empty one is a non-answer, which is merely
 * useless; a wrong one asserts that A caused B when it did not, which is worse
 * than saying nothing. So the assertions here are about the chain being RIGHT,
 * not about it being present:
 *
 *   - it names the obligation that actually caused the movement
 *   - it is rooted at the month, so the story has a beginning
 *   - the siblings account for the whole movement, not one leg of it
 *
 * ── The assertion the handle cache exists for ────────────────────────
 *
 * chronometer_run calls resetTraces() at the top of every run, so running a
 * second plan wipes the first one's scopes. A stateless server would resolve a
 * chain against whatever ran most recently and return something confident and
 * wrong. `a cached run can still explain itself after a LATER run` is the test
 * that makes the whole handle design load-bearing — mutation-checked below by
 * resolving from module state instead.
 *
 * ── Honesty about absent causes ──────────────────────────────────────
 *
 * Some findings have no event behind them: the RMD site returns without
 * recording when no account can receive the distribution. Explaining those
 * would mean inventing a chain. There is a test that they refuse to.
 *
 * Usage:  node src/tests/mcp-explain.mjs   (from repo root)
 */

import assert from 'node:assert/strict';

const store = {};
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

import {
  runProfile, runPlanCached, planFromProfile, getRun, clearRuns,
} from '../js/mcp/run-plan.js';
import {
  explainIssue, explainAt, explainIssueMarkdown, explainAtMarkdown, parseDate, ISSUE_EVENT_TYPE,
} from '../js/mcp/explain.js';
import { EventType } from '../js/sim-event.js';

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

/** A plan that fails: retiring at 58 on Mid Career balances cannot be funded. */
const broke = await runProfile('midCareer', { startAge: 57, retirementAge: 58, finishAge: 95 });
/** A plan that works, for the silence checks. */
const healthy = await runProfile('midCareer');

// ── The chain is right ───────────────────────────────────────────────
console.log('\n── The chain is a correct causal claim ──\n');

const exhaustion = explainIssue(broke, 'plan-exhaustion', { limit: 1 });

await check('the fixture actually produced the failure we mean to explain', () => {
  assert.ok(broke.issues.some(i => i.id === 'plan-exhaustion'),
    'fixture is solvent — it cannot demonstrate an unfunded chain');
  assert.equal(exhaustion.chains.length, 1);
});

await check('the chain is rooted at the month', () => {
  const [first] = exhaustion.chains[0].chain;
  assert.equal(first.depth, 0, 'chain does not start at a root');
  assert.match(first.label, /\b(19|20)\d{2}\b/, `root is not a month: "${first.label}"`);
});

await check('the chain names the obligation that caused the movement', () => {
  // NOT just "a chain exists" — that passes against a chain pointing at the
  // wrong parent. The unfunded event must trace back to paying an expense.
  assert.match(exhaustion.chains[0].chainLabel, /Pay Living Expenses/,
    `chain does not name the obligation: "${exhaustion.chains[0].chainLabel}"`);
});

await check('the chain deepens by one at each step', () => {
  const depths = exhaustion.chains[0].chain.map(s => s.depth);
  for (let i = 1; i < depths.length; i++) {
    assert.equal(depths[i], depths[i - 1] + 1, `depth jumped: ${depths.join(',')}`);
  }
});

await check('the siblings account for the whole movement, not one leg', () => {
  // The payoff: a lone unfunded amount looks arbitrary. Beside the transfer it
  // came from, it is obviously the remainder. Assert the transfer is there.
  const sibs = exhaustion.chains[0].siblings;
  assert.ok(sibs.length >= 2, `expected the rest of the movement, got ${sibs.length} siblings`);
  assert.ok(sibs.some(s => /Living Expenses/.test(s.asset) || /Living Expenses/.test(s.note)),
    'the obligation that drove this movement is not among the siblings');
});

// ── The reason handles exist ─────────────────────────────────────────
console.log('\n── A cached run explains itself, not the latest one ──\n');

await check('a cached run can still explain itself after a LATER run', async () => {
  // resetTraces() runs at the top of every chronometer_run, so `broke`'s scopes
  // are gone from module state by now — `healthy` ran after it, and so will
  // this. Resolution must use the run's OWN traceScopes.
  await runProfile('dualIncome');

  const again = explainIssue(broke, 'plan-exhaustion', { limit: 1 });
  assert.ok(again.chains[0].chainLabel,
    'an older run can no longer explain its own events — resolution is reading module state');
  assert.equal(again.chains[0].chainLabel, exhaustion.chains[0].chainLabel,
    'the same event explained differently before and after another run');
});

await check('a handle survives other runs and resolves to its own plan', async () => {
  clearRuns();
  const a = await runPlanCached(planFromProfile('midCareer', { startAge: 57, retirementAge: 58, finishAge: 95 }));
  await runPlanCached(planFromProfile('dualIncome'));

  const fromHandle = explainIssue(await getRun(a.handle), 'plan-exhaustion', { limit: 1 });
  assert.match(fromHandle.chains[0].chainLabel, /Pay /,
    'the handle resolved against the wrong run');
});

await check('an unknown handle names the known ones', async () => {
  await assert.rejects(() => getRun('plan_nope'), /No run "plan_nope"[\s\S]*Known handles:/);
});

await check('handles no longer expire — the opposite of what this used to assert', async () => {
  // This test used to require that the oldest of six runs had been EVICTED and
  // its handle was dead. Spec 9 step 7 inverted that: the server keeps the
  // plan spec rather than the finished Portfolio, so a handle goes cold rather
  // than dying and a miss costs a ~36ms re-run.
  //
  // Kept here, inverted, rather than deleted — a reader who remembers the old
  // behaviour should find the contradiction in the place they look for it.
  // tests/mcp-stateless.mjs carries the full argument.
  clearRuns();
  const handles = [];
  for (const key of ['midCareer', 'dualIncome', 'earlyCareer', 'retired', 'youngCouple', 'preRetirement']) {
    handles.push((await runPlanCached(planFromProfile(key))).handle);
  }
  assert.ok((await getRun(handles[0])).portfolio, 'the oldest handle died');
  assert.ok((await getRun(handles.at(-1))).portfolio, 'the newest handle died');
});

// ── Honesty about absent causes ──────────────────────────────────────
console.log('\n── Findings with no recorded cause say so ──\n');

await check('every detector id is mapped, so a new one cannot go unnoticed', () => {
  // Guards the seam: adding a detector without deciding whether it has a cause
  // should be a loud failure here, not a silent "no chain" at runtime.
  const seen = new Set([...broke.issues, ...healthy.issues].map(i => i.id));
  for (const id of seen) {
    assert.ok(id in ISSUE_EVENT_TYPE, `detector "${id}" is not mapped in ISSUE_EVENT_TYPE`);
  }
});

await check('a finding with no event returns no chain AND explains why', () => {
  const result = explainIssue(
    { portfolio: broke.portfolio, issues: [{ id: 'rmd-unsatisfied', assetName: 'X', scope: 'asset',
      headline: 'h', detail: 'd' }] },
    'rmd-unsatisfied');
  assert.equal(result.chains.length, 0, 'invented a chain for a finding with no recorded cause');
  assert.match(result.why, /not anchored on a recorded event/,
    'stayed silent instead of saying why there is no chain');
});

await check('an unmapped finding id throws rather than reporting "no cause"', () => {
  assert.throws(
    () => explainIssue({ portfolio: broke.portfolio,
      issues: [{ id: 'brand-new-detector', scope: 'plan', headline: 'h', detail: 'd' }] },
      'brand-new-detector'),
    /not mapped in ISSUE_EVENT_TYPE/);
});

await check('asking for a finding the run does not have lists the ones it does', () => {
  assert.throws(() => explainIssue(healthy, 'plan-exhaustion'),
    /No finding "plan-exhaustion"/);
});

// ── funding-ran-dry attributes to the depleted account ───────────────
console.log('\n── The flipped attribution is handled ──\n');

await check('funding-ran-dry finds the event by depleted name, not by asset', () => {
  // portfolio-issues.js deliberately flips this: the spillover memo lands on
  // the account that COVERED the shortfall while the issue belongs to the one
  // that ran dry. Matching on assetName finds nothing.
  const ranDry = broke.issues.find(i => i.id === 'funding-ran-dry');
  assert.ok(ranDry, 'fixture produced no funding-ran-dry finding');

  const result = explainIssue(broke, 'funding-ran-dry', { assetName: ranDry.assetName, limit: 1 });
  assert.equal(result.chains.length, 1,
    `no spillover event found for depleted account "${ranDry.assetName}"`);
  assert.equal(result.chains[0].type, EventType.SPILLOVER);
});

// ── explain_month ────────────────────────────────────────────────────
console.log('\n── Exploring a month ──\n');

await check('a date filter returns only that month', () => {
  const month = exhaustion.chains[0].date;           // e.g. 'August 2029'
  const [name, year] = month.split(' ');
  const mm = String(new Date(`${name} 1, ${year}`).getMonth() + 1).padStart(2, '0');
  const result = explainAt(broke, { date: `${year}-${mm}`, limit: 50 });
  assert.ok(result.chains.length > 0, `no events found in ${year}-${mm}`);
  for (const c of result.chains) {
    assert.equal(c.date, month, `event from ${c.date} leaked into a ${month} query`);
  }
});

await check('an event-type filter returns only that type', () => {
  const result = explainAt(broke, { eventType: EventType.UNFUNDED, limit: 5 });
  assert.ok(result.chains.length > 0, 'no unfunded events found in a failing plan');
  for (const c of result.chains) assert.equal(c.type, EventType.UNFUNDED);
});

await check('a bad date is refused with the format it wants', () => {
  assert.throws(() => explainAt(broke, { date: 'Nov 2051' }), /must look like "2051-11"/);
  assert.throws(() => explainAt(broke, { date: '2051-13' }), /Month out of range/);
});

await check('an unknown asset lists the ones that exist', () => {
  assert.throws(() => explainAt(broke, { assetName: 'Yacht' }), /No asset "Yacht"[\s\S]*Assets:/);
});

await check('an unknown event type lists the ones that exist', () => {
  assert.throws(() => explainAt(broke, { eventType: 'vibes' }), /Unknown event type "vibes"/);
});

await check('parseDate accepts both string and DateInt-shaped input', () => {
  assert.equal(parseDate('2051-11'), 205111);
  assert.equal(parseDate({ year: 2051, month: 11 }), 205111);
  assert.equal(parseDate(null), null);
});

// ── Rendering ────────────────────────────────────────────────────────
console.log('\n── The markdown is readable ──\n');

await check('the issue rendering leads with the chain, not the numbers', () => {
  const md = explainIssueMarkdown(exhaustion);
  assert.match(md, /# Why: The plan runs out of money/);
  assert.match(md, /Why it happened/);
  assert.match(md, /Pay Living Expenses/);
  assert.match(md, /Everything else in the same step/);
});

await check('an empty month query says how to widen it', () => {
  const md = explainAtMarkdown(explainAt(healthy, { date: '1970-01' }));
  assert.match(md, /No events matched/);
  assert.match(md, /Widen the query/);
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
