/**
 * plan-diff.mjs — the comparison has to notice things.
 *
 * ── What this is guarding ────────────────────────────────────────────
 *
 * A diff that quietly reports "no changes" is worse than no diff at all: it is
 * an assertion that two plans agree, made by code that was not looking. Both
 * bugs in the round-trip notes were exactly that shape — two documents about
 * the same plan, differing by fifteen years of age, each looking fine on its
 * own because nothing put the numbers side by side.
 *
 * So every check here changes ONE thing and asserts it is found, and the
 * suite opens by asserting that an unchanged plan reports nothing. A diff that
 * always fires and a diff that never fires are both useless, and only testing
 * both directions tells them apart.
 *
 * Run: node tests/plan-diff.mjs
 */

import assert from 'node:assert/strict';

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

const { diffSpecs, diffOutcomes, diffMarkdown } = await import('../js/mcp/plan-diff.js');
const { planFromProfile, runPlan } = await import('../js/mcp/run-plan.js');

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const base = () => clone(planFromProfile('preRetirement'));

console.log('\n── Silence, when nothing moved ──\n');

await check('an unchanged plan reports no differences at all', () => {
  const d = diffSpecs(base(), base());
  assert.equal(d.identical, true, JSON.stringify(d));
  assert.equal(d.settings.length, 0);
  assert.equal(d.assets.added.length + d.assets.removed.length + d.assets.changed.length, 0);
  assert.equal(d.lifeEvents.changed, false);
});

console.log('\n── One change at a time, each one found ──\n');

await check('a changed setting is reported with both values', () => {
  const b = base(); b.settings.retirementAge = 62;
  const d = diffSpecs(base(), b);
  assert.equal(d.identical, false);
  const row = d.settings.find(s => s.key === 'retirementAge');
  assert.ok(row, 'the retirement age change was not found');
  assert.equal(row.from, 65);
  assert.equal(row.to, 62);
});

await check('a setting this file has never heard of is still compared', () => {
  // The alternative is a diff that silently ignores anything added to the app
  // later, which is the failure mode that matters most in a comparison tool.
  const b = base(); b.settings.backtestYear = '1999';
  const d = diffSpecs(base(), b);
  assert.ok(d.settings.some(s => s.key === 'backtestYear'), 'an unknown setting was dropped');
});

await check('an added asset is reported', () => {
  const b = base();
  b.modelAssets.push({ ...clone(b.modelAssets[0]), displayName: 'Second Brokerage' });
  const d = diffSpecs(base(), b);
  assert.deepEqual(d.assets.added, ['Second Brokerage']);
  assert.equal(d.assets.removed.length, 0);
});

await check('a removed asset is reported', () => {
  const a = base(), b = base();
  const gone = b.modelAssets.pop().displayName;
  const d = diffSpecs(a, b);
  assert.deepEqual(d.assets.removed, [gone]);
});

await check('a changed field inside an asset is reported, with the field named', () => {
  const b = base();
  b.modelAssets[0].startCurrency = { amount: 999 };
  const d = diffSpecs(base(), b);
  const c = d.assets.changed.find(x => x.name === b.modelAssets[0].displayName);
  assert.ok(c, 'the changed asset was not found');
  assert.ok(c.fields.some(f => f.key === 'startCurrency'), 'the changed field was not named');
});

await check('a rename reads as one removal and one addition, and says so', () => {
  // The known displayName-as-foreign-key limitation, surfaced honestly rather
  // than papered over by pairing two assets that may not be the same account.
  const b = base();
  const old = b.modelAssets[0].displayName;
  b.modelAssets[0].displayName = old + ' (renamed)';
  const d = diffSpecs(base(), b);
  assert.deepEqual(d.assets.removed, [old]);
  assert.deepEqual(d.assets.added, [old + ' (renamed)']);

  const md = diffMarkdown({
    handleA: 'plan_aaaaaaaaaa', handleB: 'plan_bbbbbbbbbb',
    spec: d,
    outcome: { rows: [] },
  });
  assert.match(md, /cannot tell a rename from a swap/);
});

await check('a life-event change is reported', () => {
  const b = base(); b.lifeEvents = (b.lifeEvents ?? []).slice(0, 1);
  const d = diffSpecs(base(), b);
  assert.equal(d.lifeEvents.changed, true);
  assert.equal(d.lifeEvents.countTo, 1);
});

console.log('\n── What it did to the numbers ──\n');

const runA = await runPlan(planFromProfile('preRetirement'));
const earlier = planFromProfile('preRetirement', { retirementAge: 62 });
const runB = await runPlan(earlier);

await check('outcome rows carry both values and the right direction', () => {
  const o = diffOutcomes(runA, runB);
  const nw = o.rows.find(r => r.label === 'Ending net worth');
  assert.ok(nw.from > 0 && nw.to > 0, 'a net worth came back empty');
  assert.ok(nw.to < nw.from,
    `retiring three years earlier did not reduce ending net worth (${nw.from} → ${nw.to})`);
});

await check('the rendered delta names the direction and the magnitude', () => {
  const md = diffMarkdown({
    handleA: 'plan_aaaaaaaaaa', handleB: 'plan_bbbbbbbbbb',
    spec: diffSpecs(planFromProfile('preRetirement'), earlier),
    outcome: diffOutcomes(runA, runB),
  });
  assert.match(md, /Ending net worth/);
  assert.match(md, /−\$/, 'a decrease was not rendered as a decrease');
  assert.match(md, /Retirement age/, 'the setting that caused it is not shown alongside');
});

console.log('\n── The two degenerate cases ──\n');

await check('the same handle twice is answered plainly, not with an empty table', () => {
  const md = diffMarkdown({
    handleA: 'plan_37511aab01', handleB: 'plan_37511aab01',
    spec: diffSpecs(base(), base()), outcome: { rows: [] },
  });
  assert.match(md, /the same plan/i);
  assert.ok(!md.includes('## What changed'), 'it walked through an empty comparison anyway');
});

await check('identical specs under different handles is called a bug, not a finding', () => {
  // Cannot be produced by the engine — it would mean the content address is not
  // a content address — so the renderer is exercised directly. If it ever does
  // happen, the report must not read as a statement about someone's money.
  const md = diffMarkdown({
    handleA: 'plan_aaaaaaaaaa', handleB: 'plan_bbbbbbbbbb',
    spec: diffSpecs(base(), base()),
    outcome: diffOutcomes(runA, runA),
  });
  assert.match(md, /should not happen|bug in the handle/i);
  assert.match(md, /not deterministic/i);
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);
process.exit(failed > 0 ? 1 : 0);
