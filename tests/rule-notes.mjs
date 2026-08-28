/**
 * rule-notes.mjs
 *
 * Every runtime rule note must fire when its rule fired AND stay silent when it
 * did not. The silence half matters more: a false "unfunded" claim tells someone
 * their plan is broken when it isn't, and a false "tax settled elsewhere" hides
 * a tax that was actually withheld here.
 *
 * Notes are asserted against REAL simulations, not hand-built fixtures, so a
 * rule that reads a metric the engine stopped writing fails here rather than
 * going quiet in the UI.
 *
 * Usage:  node src/tests/rule-notes.mjs   (from repo root)
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
import { makeRuleContext, ruleNotesFor, RULES } from '../js/rule-notes.js';
import { simConfigFromGlobals } from '../js/globals.js';

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

/** Note ids for one asset over the whole plan, or over an explicit window. */
function idsFor(portfolio, name, from = 0, to = null) {
  const asset = portfolio.modelAssets.find(a => a.displayName === name);
  assert.ok(asset, `no asset named ${name}`);
  const len = asset.getHistory('value')?.length ?? 0;
  return ruleNotesFor(makeRuleContext({
    asset,
    modelAssets: portfolio.modelAssets,
    firstDateInt: portfolio.firstDateInt,
    from,
    to: to == null ? len - 1 : to,
  })).map(n => n.id);
}

function notesFor(portfolio, name, from = 0, to = null) {
  const asset = portfolio.modelAssets.find(a => a.displayName === name);
  const len = asset.getHistory('value')?.length ?? 0;
  return ruleNotesFor(makeRuleContext({
    asset,
    modelAssets: portfolio.modelAssets,
    firstDateInt: portfolio.firstDateInt,
    from,
    to: to == null ? len - 1 : to,
  }));
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
  const p = new Portfolio(data.map(o => ModelAsset.fromJSON(o)), true, simConfigFromGlobals());
  await chronometer_run(p);
  return p;
}

const bank = (name, amount, finish = { year: 2028, month: 12 }) => ({
  instrument: 'bank', displayName: name,
  startDateInt: { year: 2026, month: 1 }, finishDateInt: finish,
  startCurrency: { amount }, startBasisCurrency: { amount }, annualReturnRate: { rate: 0 },
});

// ══ Structural ═══════════════════════════════════════════════════════
console.log('\n── Structure ──\n');

check('every rule has a unique id and an evaluate function', () => {
  const ids = RULES.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate rule ids: ${ids.join(', ')}`);
  for (const r of RULES) {
    assert.equal(typeof r.evaluate, 'function', `${r.id} has no evaluate()`);
  }
});

check('every suppresses target names a real rule', () => {
  const ids = new Set(RULES.map(r => r.id));
  for (const r of RULES) {
    for (const target of (r.suppresses ?? [])) {
      assert.ok(ids.has(target), `${r.id} suppresses unknown rule "${target}"`);
    }
  }
});

check('a rule that throws is swallowed, not propagated', () => {
  const saved = RULES[0].evaluate;
  RULES[0].evaluate = () => { throw new Error('boom'); };
  try {
    const out = ruleNotesFor(makeRuleContext({ asset: { instrument: 'bank', getHistory: () => [] }, from: 0, to: 0 }));
    assert.ok(Array.isArray(out), 'expected an array despite the throwing rule');
  } finally {
    RULES[0].evaluate = saved;
  }
});

check('no asset means no notes', () => {
  assert.deepEqual(ruleNotesFor(makeRuleContext({ asset: null, from: 0, to: 0 })), []);
});

// ══ Retirement household: tax settled elsewhere ══════════════════════
console.log('\n── Retirement income: tax is settled somewhere else ──\n');

const retirement = await run([
  { instrument: 'pension', displayName: 'Pension',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2028, month: 12 },
    startCurrency: { amount: 5000 }, startBasisCurrency: { amount: 0 }, annualReturnRate: { rate: 0 },
    fundTransfers: [{ toDisplayName: 'Savings', monthlyMoveValue: 100, closeMoveValue: 0 }] },
  { instrument: 'retirementIncome', displayName: 'Social Security',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2028, month: 12 },
    startCurrency: { amount: 2500 }, startBasisCurrency: { amount: 0 }, annualReturnRate: { rate: 0 },
    fundTransfers: [{ toDisplayName: 'Savings', monthlyMoveValue: 100, closeMoveValue: 0 }] },
  bank('Savings', 50000),
]);

// Spec 4c: a pension withholds its own tax on arrival at the W-4P default rate,
// so "settled somewhere else" no longer describes it. The note it gets instead
// must explain the smaller deposit — non-optional withholding the household
// never chose is exactly the case where silence reads as a bug.
check('pension explains its own withholding', () => {
  const notes = notesFor(retirement, 'Pension');
  const note = notes.find(n => n.id === 'retirement-income-withholding');
  assert.ok(note, `expected retirement-income-withholding, got [${notes.map(n => n.id)}]`);
  assert.match(note.text, /withheld/, `should say tax was withheld: "${note.text}"`);
  assert.ok(!notes.some(n => n.id === 'tax-settled-elsewhere'),
    'a pension that withholds its own tax must not also claim it was settled elsewhere');
});

// Social Security's W-4V default is no withholding, so its tax IS settled
// elsewhere and the original note still applies. The two instruments diverging
// here is the policy, asserted as behaviour.
check('social security still names the account that settled its tax', () => {
  const notes = notesFor(retirement, 'Social Security');
  const note = notes.find(n => n.id === 'tax-settled-elsewhere');
  assert.ok(note, `expected tax-settled-elsewhere, got [${notes.map(n => n.id)}]`);
  assert.match(note.text, /Savings/, `should name Savings: "${note.text}"`);
  assert.ok(!notes.some(n => n.id === 'retirement-income-withholding'),
    'Social Security withholds nothing by default and must not claim otherwise');
});

check('the funding account explains why money leaves it', () => {
  assert.ok(idsFor(retirement, 'Savings').includes('funding-backstop'));
});

check('SILENCE: the funding account does not claim its own tax was settled elsewhere', () => {
  assert.ok(!idsFor(retirement, 'Savings').includes('tax-settled-elsewhere'));
});

// ══ Salary: withholding at source, so silence ════════════════════════
console.log('\n── Salary: withheld at source ──\n');

const employed = await run([
  { instrument: 'workingIncome', displayName: 'Salary',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2028, month: 12 },
    startCurrency: { amount: 9000 }, startBasisCurrency: { amount: 0 }, annualReturnRate: { rate: 0 },
    fundTransfers: [{ toDisplayName: 'Savings', monthlyMoveValue: 100, closeMoveValue: 0 }] },
  bank('Savings', 20000),
]);

check('SILENCE: a salary that withholds says nothing about settlement elsewhere', () => {
  const ids = idsFor(employed, 'Salary');
  assert.ok(!ids.includes('tax-settled-elsewhere'),
    `salary withholds at source, should be silent — got [${ids}]`);
});

check('SILENCE: no unfunded warning on a solvent plan', () => {
  for (const a of employed.modelAssets) {
    assert.ok(!idsFor(employed, a.displayName).includes('unfunded-obligation'),
      `${a.displayName} reported unfunded on a solvent plan`);
  }
});

// ══ Roth: tax-free is the feature ════════════════════════════════════
console.log('\n── Roth: tax-free by design ──\n');

// The Roth must actually DISTRIBUTE for the note to be meaningful: a close
// transfer books no distribution (applyCapitalGainsTax returns early on
// tax-free instruments), so the Roth funds a monthly expense instead.
const roth = await run([
  { instrument: 'rothIRA', displayName: 'Roth IRA',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2028, month: 12 },
    startCurrency: { amount: 200000 }, startBasisCurrency: { amount: 200000 }, annualReturnRate: { rate: 0 },
    fundTransfers: [{ toDisplayName: 'Living', monthlyMoveValue: 5, closeMoveValue: 0 }] },
  { instrument: 'monthlyExpense', displayName: 'Living',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2028, month: 12 },
    startCurrency: { amount: 3000 }, startBasisCurrency: { amount: 0 }, annualReturnRate: { rate: 0 } },
]);

check('Roth reports its own exemption', () => {
  assert.ok(idsFor(roth, 'Roth IRA').includes('roth-tax-free'));
});

check('SUPPRESSION: Roth does not also claim tax was settled elsewhere', () => {
  const ids = idsFor(roth, 'Roth IRA');
  assert.ok(!ids.includes('tax-settled-elsewhere'),
    `roth-tax-free must suppress the general note — got [${ids}]`);
});

// ══ Unfunded: the plan cannot pay ════════════════════════════════════
console.log('\n── Unfunded obligation ──\n');

// An expense with no funding account anywhere: reportUnfunded must fire.
const broke = await run([
  { instrument: 'monthlyExpense', displayName: 'Rent',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 12 },
    startCurrency: { amount: 2500 }, startBasisCurrency: { amount: 0 }, annualReturnRate: { rate: 0 } },
]);

check('an obligation the plan could not pay is reported', () => {
  const notes = notesFor(broke, 'Rent');
  const note = notes.find(n => n.id === 'unfunded-obligation');
  assert.ok(note, `expected unfunded-obligation, got [${notes.map(n => n.id)}]`);
  assert.equal(note.tone, 'warn', 'an unpaid obligation must read as a warning');
});

// ══ RMD ══════════════════════════════════════════════════════════════
console.log('\n── Required minimum distributions ──\n');

// Age 75 at plan start, so rmdRequired() is true from month one.
const rmd = await run([
  { instrument: 'ira', displayName: 'IRA',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2028, month: 12 },
    startCurrency: { amount: 800000 }, startBasisCurrency: { amount: 0 }, annualReturnRate: { rate: 0 } },
  { instrument: 'monthlyExpense', displayName: 'Living',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2028, month: 12 },
    startCurrency: { amount: 2000 }, startBasisCurrency: { amount: 0 }, annualReturnRate: { rate: 0 } },
  bank('Savings', 300000),
], { start: 75, retire: 65 });

check('an IRA subject to RMDs reports the requirement met', () => {
  const notes = notesFor(rmd, 'IRA');
  const note = notes.find(n => n.id === 'rmd-satisfied');
  assert.ok(note, `expected rmd-satisfied, got [${notes.map(n => n.id)}]`);
  assert.equal(note.tone, 'info', `a met requirement is not a warning: "${note.text}"`);
  assert.match(note.text, /requirement is met/);
});

check('SILENCE: an account with no RMD obligation says nothing about RMDs', () => {
  assert.ok(!idsFor(rmd, 'Savings').includes('rmd-satisfied'));
  assert.ok(!idsFor(retirement, 'Pension').includes('rmd-satisfied'));
});

// ══ Depletion: demoted from the card icon to a note ══════════════════
console.log('\n── Account depleted ──\n');

// Checking is too small for the mortgage and clamps at $0; Brokerage covers
// the rest. The card no longer marks this with ⚠️ — the fact lives here.
const drained = await run([
  { instrument: 'realEstate', displayName: 'Home', isPrimaryHome: true,
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2029, month: 12 },
    startCurrency: { amount: 500000 }, startBasisCurrency: { amount: 500000 }, annualReturnRate: { rate: 0 } },
  { instrument: 'mortgage', displayName: 'Mortgage',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2029, month: 12 },
    startCurrency: { amount: -300000 }, startBasisCurrency: { amount: 0 },
    annualReturnRate: { rate: 0.065 }, monthsRemaining: 360 },
  { instrument: 'bank', displayName: 'Checking',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2029, month: 12 },
    startCurrency: { amount: 4000 }, startBasisCurrency: { amount: 4000 }, annualReturnRate: { rate: 0 } },
  { instrument: 'taxableEquity', displayName: 'Brokerage',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2029, month: 12 },
    startCurrency: { amount: 400000 }, startBasisCurrency: { amount: 400000 }, annualReturnRate: { rate: 0 } },
], { start: 50, retire: 65 });

check('a depleted account says so, and dates it', () => {
  const notes = notesFor(drained, 'Checking');
  const note = notes.find(n => n.id === 'account-depleted');
  assert.ok(note, `expected account-depleted, got [${notes.map(n => n.id)}]`);
  assert.match(note.text, /\w+ 20\d\d/, `should name the month: "${note.text}"`);
});

check('depletion is stated without alarm — it is the modelled scenario', () => {
  const note = notesFor(drained, 'Checking').find(n => n.id === 'account-depleted');
  assert.equal(note.tone, 'info',
    'drawing an account down is normal; only an unpaid obligation is a warning');
});

check('WINDOWING: the note is silent in months before the account ran dry', () => {
  // Month 0 — the account still held its opening balance.
  const asset = drained.modelAssets.find(a => a.displayName === 'Checking');
  const out = ruleNotesFor(makeRuleContext({
    asset, modelAssets: drained.modelAssets,
    firstDateInt: drained.firstDateInt, from: 0, to: 0,
  }));
  assert.ok(!out.map(n => n.id).includes('account-depleted'),
    `isDepleted is present state — the note must not claim it happened in month one; got [${out.map(n => n.id)}]`);
});

check('SILENCE: an account that never ran dry says nothing about depletion', () => {
  assert.ok(!idsFor(drained, 'Brokerage').includes('account-depleted'));
  assert.ok(!idsFor(employed, 'Savings').includes('account-depleted'));
});

// ══ Contribution caps ════════════════════════════════════════════════
console.log('\n── Contribution limits ──\n');

// 100% of a large salary aimed at a 401K — the annual limit must bite.
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

check('a 401K capped by the annual limit says so, with the shortfall', () => {
  const notes = notesFor(capped, '401K');
  const note = notes.find(n => n.id === 'contribution-capped');
  assert.ok(note, `expected contribution-capped, got [${notes.map(n => n.id)}]`);
  assert.match(note.text, /401\(k\) limit/, `should name the limit: "${note.text}"`);
  assert.match(note.text, /\$[\d,]+/, `should quantify the shortfall: "${note.text}"`);
});

check('SILENCE: a contribution under the limit is not reported as capped', () => {
  // 1% of the same salary stays far below the annual limit.
  const ids = idsFor(employed, 'Savings');
  assert.ok(!ids.includes('contribution-capped'), `got [${ids}]`);
});

check('the cap memo is info-kind, so it stays out of cash reconciliation', () => {
  const k = capped.modelAssets.find(a => a.displayName === '401K');
  const memos = k.creditMemos.filter(m => /^Contribution capped/.test(m.note));
  assert.ok(memos.length > 0, 'no cap memos recorded');
  for (const m of memos) {
    assert.equal(m.kind, 'info', `cap memo must be info, got "${m.kind}"`);
    assert.ok(m.amount.amount < 0, 'shortfall should be negative — money that did NOT arrive');
  }
});

// ══ Windowing ════════════════════════════════════════════════════════
console.log('\n── Windowing ──\n');

check('notes respect the window: a month before any income is silent', () => {
  // Month 0 of the retirement plan has income; a window entirely before the
  // plan starts must produce nothing at all.
  const asset = retirement.modelAssets.find(a => a.displayName === 'Pension');
  const out = ruleNotesFor(makeRuleContext({
    asset, modelAssets: retirement.modelAssets,
    firstDateInt: retirement.firstDateInt, from: -10, to: -1,
  }));
  assert.deepEqual(out.map(n => n.id), [], `expected silence, got [${out.map(n => n.id)}]`);
});

check('every emitted note has an id, emoji, text and tone', () => {
  for (const n of notesFor(retirement, 'Pension')) {
    assert.ok(n.id && n.emoji && n.text, `malformed note: ${JSON.stringify(n)}`);
    assert.ok(['info', 'warn'].includes(n.tone), `bad tone ${n.tone}`);
  }
});

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
