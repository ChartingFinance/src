/**
 * portfolio-issues.mjs
 *
 * The issues surface tells someone their financial plan failed. Getting that
 * wrong in either direction is expensive: a missed alert hides an unpayable
 * mortgage, and a false one tells a person with a perfectly good plan that
 * they run out of money in 2049.
 *
 * So SILENCE is asserted as hard as firing, and two rules get their own
 * dedicated cases because they are the ones most likely to rot:
 *
 *   - DEPLETION IS NOT AN ALARM. An account that draws down to $0 is the
 *     scenario this tool models, not a fault. Scenario A below runs an account
 *     dry on purpose and asserts it earns a notice, never the ⚠️.
 *   - EXHAUSTION IS A RECORDED FAILURE, not a low balance. Scenario A also has
 *     a depleted account and must report NO exhaustion, because every
 *     obligation was actually met.
 *
 * Issues are asserted against REAL simulations rather than hand-built memo
 * fixtures, so a detector matching prose the engine no longer writes fails
 * here instead of going quiet in the UI.
 *
 * Usage:  node src/tests/portfolio-issues.mjs   (from repo root)
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
import { TaxTable } from '../js/taxes.js';
import {
  setActiveTaxTable,
  global_setUserStartAge, global_getUserStartAge,
  global_setUserRetirementAge, global_getUserRetirementAge,
} from '../js/globals.js';
import {
  detectIssues, DETECTORS, MEMO_PATTERNS, monthLabel,
  planExhaustion, issuesForAsset, alertAssetNames, issueCounts,
} from '../js/portfolio-issues.js';

// ── Helpers ───────────────────────────────────────────────────────────
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

async function run(data, ages) {
  setActiveTaxTable(new TaxTable());
  if (ages) {
    // set writes localStorage; get refreshes the module-level mutable var that
    // Portfolio actually reads — both halves are required (see globals.js).
    global_setUserStartAge(ages.start);
    global_getUserStartAge();
    global_setUserRetirementAge(ages.retire);
    global_getUserRetirementAge();
  }
  const p = new Portfolio(data.map(o => ModelAsset.fromJSON(o)), true);
  await chronometer_run(p);
  return p;
}

const ids = (issues) => issues.map(i => i.id);
const one = (issues, id) => issues.find(i => i.id === id);

const bank = (name, amount, finish = { year: 2029, month: 12 }) => ({
  instrument: 'bank', displayName: name,
  startDateInt: { year: 2026, month: 1 }, finishDateInt: finish,
  startCurrency: { amount }, startBasisCurrency: { amount }, annualReturnRate: { rate: 0 },
});

const expense = (name, amount, finish = { year: 2029, month: 12 }) => ({
  instrument: 'monthlyExpense', displayName: name,
  startDateInt: { year: 2026, month: 1 }, finishDateInt: finish,
  startCurrency: { amount: -Math.abs(amount) }, startBasisCurrency: { amount: 0 },
  annualReturnRate: { rate: 0 },
});

// ══ Structure ════════════════════════════════════════════════════════
console.log('\n── Structure ──\n');

check('every detector has a unique id and a detect function', () => {
  const all = DETECTORS.map(d => d.id);
  assert.equal(new Set(all).size, all.length, `duplicate ids: ${all.join(', ')}`);
  for (const d of DETECTORS) {
    assert.equal(typeof d.detect, 'function', `${d.id} has no detect()`);
    assert.ok(['asset', 'plan'].includes(d.scope), `${d.id} bad scope ${d.scope}`);
    assert.ok(['obligation', 'configuration', 'reconciliation'].includes(d.category),
      `${d.id} bad category ${d.category}`);
    assert.ok(['alert', 'notice'].includes(d.severity), `${d.id} bad severity ${d.severity}`);
  }
});

check('every suppresses target names a real detector', () => {
  const known = new Set(DETECTORS.map(d => d.id));
  for (const d of DETECTORS) {
    for (const t of (d.suppresses ?? [])) {
      assert.ok(known.has(t), `${d.id} suppresses unknown detector "${t}"`);
    }
  }
});

check('a detector that throws is swallowed, not propagated', () => {
  const saved = DETECTORS[0].detect;
  DETECTORS[0].detect = () => { throw new Error('boom'); };
  try {
    const out = detectIssues({ modelAssets: [{ displayName: 'X', creditMemos: [] }] });
    assert.ok(Array.isArray(out), 'expected an array despite the throwing detector');
  } finally {
    DETECTORS[0].detect = saved;
  }
});

check('an empty or missing portfolio produces nothing', () => {
  assert.deepEqual(detectIssues(null), []);
  assert.deepEqual(detectIssues({ modelAssets: [] }), []);
});

check('monthLabel speaks in months, never YYYYMM', () => {
  assert.equal(monthLabel({ year: 2049, month: 3 }), 'March 2049');
  assert.equal(monthLabel(null), 'an unknown month');
});

// ══ A solvent plan says nothing ══════════════════════════════════════
console.log('\n── SILENCE: a solvent plan ──\n');

const solvent = await run([
  { instrument: 'workingIncome', displayName: 'Salary',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2029, month: 12 },
    startCurrency: { amount: 9000 }, startBasisCurrency: { amount: 0 }, annualReturnRate: { rate: 0 },
    fundTransfers: [{ toDisplayName: 'Savings', monthlyMoveValue: 100, closeMoveValue: 0 }] },
  bank('Savings', 200000),
], { start: 45, retire: 65 });

check('a plan that pays its way reports no issues at all', () => {
  const issues = detectIssues(solvent);
  assert.deepEqual(ids(issues), [], `expected silence, got [${ids(issues)}]`);
});

check('SILENCE: no asset earns a warning icon on a solvent plan', () => {
  assert.equal(alertAssetNames(detectIssues(solvent)).size, 0);
});

check('SILENCE: no exhaustion date on a solvent plan', () => {
  assert.equal(planExhaustion(detectIssues(solvent)), null);
});

check('counts are all zero on a solvent plan', () => {
  assert.deepEqual(issueCounts(detectIssues(solvent)), { total: 0, alerts: 0, notices: 0 });
});

// ══ A: an account runs dry but every bill is still paid ══════════════
console.log('\n── Ran dry, but nothing went unpaid ──\n');

// Checking is too small for the mortgage; the shortfall re-sources from
// Brokerage. This is the PR #14 machinery working correctly.
const ranDry = await run([
  { instrument: 'realEstate', displayName: 'Home', isPrimaryHome: true,
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2029, month: 12 },
    startCurrency: { amount: 500000 }, startBasisCurrency: { amount: 500000 }, annualReturnRate: { rate: 0 } },
  { instrument: 'mortgage', displayName: 'Mortgage',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2029, month: 12 },
    startCurrency: { amount: -300000 }, startBasisCurrency: { amount: 0 },
    annualReturnRate: { rate: 0.065 }, monthsRemaining: 360 },
  bank('Checking', 4000),
  { instrument: 'taxableEquity', displayName: 'Brokerage',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2029, month: 12 },
    startCurrency: { amount: 400000 }, startBasisCurrency: { amount: 400000 }, annualReturnRate: { rate: 0 } },
], { start: 50, retire: 65 });

check('the account that ran dry is reported — not the one that covered it', () => {
  const issues = detectIssues(ranDry);
  const dry = one(issues, 'funding-ran-dry');
  assert.ok(dry, `expected funding-ran-dry, got [${ids(issues)}]`);
  assert.equal(dry.assetName, 'Checking',
    'the issue belongs to the depleted account, not the one that absorbed it');
  assert.match(dry.detail, /Brokerage/, `should name who covered it: "${dry.detail}"`);
});

check('running dry is a notice, and dates the month it happened', () => {
  const dry = one(detectIssues(ranDry), 'funding-ran-dry');
  assert.equal(dry.severity, 'notice');
  assert.equal(dry.category, 'obligation');
  assert.match(dry.headline, /March 2026/, `expected the real month: "${dry.headline}"`);
});

check('RULE 3 — a depleted account does NOT earn the warning icon', () => {
  const checking = ranDry.modelAssets.find(a => a.displayName === 'Checking');
  assert.equal(checking.isDepleted, true,
    'fixture is wrong: Checking was supposed to be depleted');
  assert.ok(!alertAssetNames(detectIssues(ranDry)).has('Checking'),
    'depletion is the modelled scenario, not an alarm — ⚠️ is for alerts only');
});

check('SILENCE: nothing went unpaid, so there is no exhaustion date', () => {
  const issues = detectIssues(ranDry);
  assert.equal(planExhaustion(issues), null,
    `a depleted account whose bills were still paid is not an exhausted plan — got [${ids(issues)}]`);
  assert.ok(!ids(issues).includes('unfunded-obligation'));
});

// ══ B: nowhere to draw from at all ═══════════════════════════════════
console.log('\n── No funding account configured ──\n');

const unconfigured = await run([
  expense('Rent', 2500, { year: 2026, month: 12 }),
], { start: 50, retire: 65 });

check('a plan with no cash-like account says so plainly', () => {
  const issues = detectIssues(unconfigured);
  const gap = one(issues, 'no-funding-accounts');
  assert.ok(gap, `expected no-funding-accounts, got [${ids(issues)}]`);
  assert.equal(gap.category, 'configuration',
    'this is a setup problem the user can fix, not insolvency');
});

check('SUPPRESSION: it is not reported as the plan running out of money', () => {
  const issues = detectIssues(unconfigured);
  assert.equal(planExhaustion(issues), null,
    `"you never said where your money is" must not render as "your plan failed in month one" — got [${ids(issues)}]`);
});

check('the per-asset marks survive suppression and point at the gap', () => {
  const issues = detectIssues(unconfigured);
  const rent = issuesForAsset(issues, 'Rent');
  assert.ok(rent.some(i => i.id === 'unfunded-obligation'),
    `Rent still could not be paid — got [${ids(rent)}]`);
  assert.ok(alertAssetNames(issues).has('Rent'), 'Rent should carry ⚠️');
});

// ══ C: the plan genuinely runs out ═══════════════════════════════════
console.log('\n── Plan exhaustion ──\n');

const exhausted = await run([
  expense('Living', 3000),
  bank('Savings', 20000),
], { start: 50, retire: 65 });

check('exhaustion is dated by the first recorded failure to pay', () => {
  const issues = detectIssues(exhausted);
  const ex = planExhaustion(issues);
  assert.ok(ex, `expected plan-exhaustion, got [${ids(issues)}]`);
  assert.equal(ex.severity, 'alert');
  assert.equal(ex.scope, 'plan');
  assert.match(ex.headline, /July 2026/, `expected the first failure month: "${ex.headline}"`);
});

check('exhaustion quantifies the shortfall and how many months it spans', () => {
  const ex = planExhaustion(detectIssues(exhausted));
  assert.ok(ex.amount > 0, 'shortfall should be quantified');
  assert.ok(ex.occurrences > 1, `expected a multi-month failure, got ${ex.occurrences}`);
  assert.match(ex.detail, /\$[\d,]+/, `should state an amount: "${ex.detail}"`);
});

check('SILENCE: a configured-but-empty account is not "no funding accounts"', () => {
  const issues = detectIssues(exhausted);
  assert.ok(!ids(issues).includes('no-funding-accounts'),
    'Savings exists — it just ran out, which is a different finding');
});

check('the owing asset carries the alert and the engine\'s own reason', () => {
  const issues = detectIssues(exhausted);
  const living = issuesForAsset(issues, 'Living');
  const unfunded = living.find(i => i.id === 'unfunded-obligation');
  assert.ok(unfunded, `expected unfunded-obligation on Living, got [${ids(living)}]`);
  // The reason is carried verbatim in its own field rather than folded into
  // the prose: it is raw engine text, and the panel renders it as a citation.
  assert.ok(unfunded.reasons.some(r => /expense/.test(r)),
    `should quote the engine's reason, not invent one: [${unfunded.reasons}]`);
});

check('an unfunded event with no amount does not headline "$0"', () => {
  // Expense overflow records the failure without a figure. A headline reading
  // "$0 could not be funded" is worse than not naming an amount at all.
  for (const p of [exhausted, unconfigured]) {
    for (const i of detectIssues(p)) {
      assert.ok(!/^\$0 /.test(i.headline), `zero-amount headline: "${i.headline}"`);
    }
  }
});

check('alerts sort ahead of notices', () => {
  const issues = detectIssues(exhausted);
  const firstNotice = issues.findIndex(i => i.severity === 'notice');
  const lastAlert = issues.map(i => i.severity).lastIndexOf('alert');
  if (firstNotice !== -1 && lastAlert !== -1) {
    assert.ok(lastAlert < firstNotice, `unsorted: [${issues.map(i => i.severity)}]`);
  }
});

// ══ D: RMD that could not be satisfied ═══════════════════════════════
console.log('\n── Required minimum distributions ──\n');

// Age 75, an IRA subject to RMDs and nowhere for the distribution to land.
const rmdStuck = await run([
  { instrument: 'ira', displayName: 'IRA',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2028, month: 12 },
    startCurrency: { amount: 800000 }, startBasisCurrency: { amount: 0 }, annualReturnRate: { rate: 0 } },
], { start: 75, retire: 65 });

check('an unmet RMD is reported with both numbers', () => {
  const issues = detectIssues(rmdStuck);
  const rmd = one(issues, 'rmd-unsatisfied');
  assert.ok(rmd, `expected rmd-unsatisfied, got [${ids(issues)}]`);
  assert.equal(rmd.assetName, 'IRA');
  assert.ok(rmd.amount > 0);
  assert.match(rmd.detail, /\$[\d,]+/);
});

// The same IRA with somewhere to put the money satisfies the requirement.
const rmdOk = await run([
  { instrument: 'ira', displayName: 'IRA',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2028, month: 12 },
    startCurrency: { amount: 800000 }, startBasisCurrency: { amount: 0 }, annualReturnRate: { rate: 0 } },
  expense('Living', 2000, { year: 2028, month: 12 }),
  bank('Savings', 300000, { year: 2028, month: 12 }),
], { start: 75, retire: 65 });

check('SILENCE: a satisfied RMD is not an issue', () => {
  const issues = detectIssues(rmdOk);
  assert.ok(!ids(issues).includes('rmd-unsatisfied'),
    `the requirement was met — got [${ids(issues)}]`);
});

check('SILENCE: an account with no RMD obligation says nothing about RMDs', () => {
  assert.ok(!ids(detectIssues(solvent)).includes('rmd-unsatisfied'));
});

// ══ Contribution caps ════════════════════════════════════════════════
console.log('\n── Contribution limits ──\n');

const capped = await run([
  { instrument: 'workingIncome', displayName: 'Salary',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2027, month: 12 },
    startCurrency: { amount: 20000 }, startBasisCurrency: { amount: 0 }, annualReturnRate: { rate: 0 },
    fundTransfers: [{ toDisplayName: '401K', monthlyMoveValue: 60, closeMoveValue: 0 }] },
  { instrument: '401K', displayName: '401K',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2027, month: 12 },
    startCurrency: { amount: 10000 }, startBasisCurrency: { amount: 0 }, annualReturnRate: { rate: 0 } },
  bank('Savings', 20000, { year: 2027, month: 12 }),
], { start: 45, retire: 65 });

check('a capped contribution is a notice naming the limit', () => {
  const issues = detectIssues(capped);
  const cap = one(issues, 'contribution-capped');
  assert.ok(cap, `expected contribution-capped, got [${ids(issues)}]`);
  assert.equal(cap.assetName, '401K');
  assert.equal(cap.severity, 'notice', 'hitting a limit is not a failure to pay');
  assert.match(cap.detail, /401\(k\) limit/, `should name the limit: "${cap.detail}"`);
});

check('SILENCE: a contribution under the limit is not reported as capped', () => {
  assert.ok(!ids(detectIssues(solvent)).includes('contribution-capped'));
});

check('a capped 401K does not earn the warning icon', () => {
  assert.ok(!alertAssetNames(detectIssues(capped)).has('401K'),
    'a notice must not render as an alert');
});

// ══ Shape and categories ═════════════════════════════════════════════
console.log('\n── Shape ──\n');

check('every emitted issue is fully formed', () => {
  for (const p of [unconfigured, exhausted, ranDry, capped, rmdStuck]) {
    for (const i of detectIssues(p)) {
      assert.ok(i.id && i.headline && i.detail, `malformed issue: ${JSON.stringify(i)}`);
      assert.ok(['asset', 'plan'].includes(i.scope), `${i.id} bad scope`);
      assert.ok(['alert', 'notice'].includes(i.severity), `${i.id} bad severity`);
      if (i.scope === 'asset') assert.ok(i.assetName, `${i.id} is asset-scoped with no asset`);
      if (i.scope === 'plan') assert.equal(i.assetName, null, `${i.id} is plan-scoped but names an asset`);
      assert.ok(!('detector' in i), 'the descriptor must not leak into the emitted issue');
    }
  }
});

check('RULE 4 — reconciliation issues are hidden unless asked for', () => {
  const plain = detectIssues(exhausted);
  assert.ok(plain.every(i => i.category !== 'reconciliation'),
    'engine-internal doubt must not appear beside financial findings by default');
  // The category ships empty until the recording study lands; asserting the
  // flag is plumbed matters more than the (currently zero) result.
  const advanced = detectIssues(exhausted, { includeReconciliation: true });
  assert.ok(advanced.length >= plain.length);
});

check('issuesForAsset never returns plan-scoped issues', () => {
  const issues = detectIssues(exhausted);
  for (const name of exhausted.modelAssets.map(a => a.displayName)) {
    for (const i of issuesForAsset(issues, name)) {
      assert.equal(i.scope, 'asset', `${i.id} leaked into an asset list`);
    }
  }
});

check('the memo patterns still match what the engine writes', () => {
  // If a memo string is renamed, this fails here rather than going quiet in
  // the UI. See the "Known seam" note in portfolio-issues.js.
  const notes = [];
  for (const p of [ranDry, exhausted, capped]) {
    for (const a of p.modelAssets) for (const m of (a.creditMemos ?? [])) notes.push(m.note ?? '');
  }
  assert.ok(notes.some(n => MEMO_PATTERNS.unfunded.test(n)), 'no Unfunded memo found');
  assert.ok(notes.some(n => MEMO_PATTERNS.ranDry.test(n)), 'no Spillover memo found');
  assert.ok(notes.some(n => MEMO_PATTERNS.contributionCapped.test(n)), 'no Contribution capped memo found');
});

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
