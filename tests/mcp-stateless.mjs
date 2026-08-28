/**
 * mcp-stateless.mjs
 *
 * A handle is a cache, not a session.
 *
 * ── What changed, and why this test is the proof ─────────────────────
 *
 * `js/mcp/run-plan.js` used to say a handle was "not an optimisation — it is a
 * CORRECTNESS requirement", because trace scopes are run state and a server
 * that re-ran the plan would resolve causal chains against a different run than
 * the one it was describing.
 *
 * That was true of an engine whose configuration lived in module state: a
 * second plan in the process changed what the first one meant. Spec 9 made the
 * configuration a value, so it stopped being true — and a claim that stops
 * being true silently is worse than one that was never made. This file is the
 * evidence for the new claim.
 *
 * The load-bearing assertion is the LAST one: a chain resolved from a re-run is
 * IDENTICAL to the chain resolved from the original run. Everything else here
 * is scaffolding for that.
 *
 * ── Why the old argument's second half was also wrong ────────────────
 *
 * It assumed `resetTraces()` wipes the previous run's scopes. It rebinds
 * `_scopes = []` rather than emptying the array, so a finished portfolio keeps
 * its own. Asserted below, because the distinction is one refactor away from
 * flipping and nothing else would notice.
 *
 * Usage:  node tests/mcp-stateless.mjs   (from src/)
 */

import assert from 'node:assert/strict';

import {
    runPlan, runPlanCached, getRun, clearRuns, evictMemo, planFromProfile,
} from '../js/mcp/run-plan.js';
import { explainAt, explainAtMarkdown } from '../js/mcp/explain.js';

let passed = 0, failed = 0;
async function check(label, fn) {
    // AWAITS fn. The sibling suites' check() is synchronous, which reports ✓ on
    // a rejected promise and then crashes after printing "0 failed".
    try { await fn(); console.log(`  ✓ ${label}`); passed++; }
    catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

const fingerprint = (portfolio) => {
    const rows = [];
    for (const asset of portfolio.modelAssets) {
        for (const e of asset.events ?? []) {
            rows.push([asset.displayName, e.dateInt, e.type, e.amount?.amount, e.traceId].join('|'));
        }
    }
    return rows.join('\n');
};

console.log('\n── A re-run is the same run ──\n');

await check('two runs of one spec are byte-identical, traceIds included', async () => {
    // The premise everything else rests on. If this ever fails, handles must go
    // back to holding the finished Portfolio.
    const spec = planFromProfile('midCareer');
    const a = await runPlan(spec);
    const b = await runPlan(spec);
    assert.equal(fingerprint(a.portfolio), fingerprint(b.portfolio));
});

await check('a finished run keeps its own scopes when another plan runs after it', async () => {
    // resetTraces() rebinds rather than empties. A refactor to `_scopes.length = 0`
    // would silently empty every finished portfolio's chain list.
    const first = await runPlan(planFromProfile('midCareer'));
    const before = first.portfolio.traceScopes.length;
    assert.ok(before > 0, 'the first run recorded no scopes at all');

    await runPlan(planFromProfile('dualIncome'));

    assert.equal(first.portfolio.traceScopes.length, before,
        'a later run emptied the earlier run\'s scope list');
});

console.log('\n── Handles are content-addressed ──\n');

await check('the same plan always yields the same handle', async () => {
    clearRuns();
    const one = await runPlanCached(planFromProfile('midCareer'));
    const two = await runPlanCached(planFromProfile('midCareer'));
    assert.equal(one.handle, two.handle);
});

await check('different plans yield different handles', async () => {
    clearRuns();
    const single = await runPlanCached(planFromProfile('midCareer'));
    const joint = await runPlanCached(planFromProfile('dualIncome'));
    assert.notEqual(single.handle, joint.handle);
});

await check('the same plan asked a different way yields a different handle', async () => {
    // opts are part of the identity: includeReconciliation changes the issue
    // list, so it must not collide with a run that omitted them.
    clearRuns();
    const plain = await runPlanCached(planFromProfile('midCareer'));
    const diag = await runPlanCached(planFromProfile('midCareer'),
        { includeReconciliation: true });
    assert.notEqual(plain.handle, diag.handle);
});

console.log('\n── A cold handle goes cold, not dead ──\n');

await check('a handle still resolves after its finished run is evicted', async () => {
    clearRuns();
    const { handle } = await runPlanCached(planFromProfile('midCareer'));
    evictMemo();
    const run = await getRun(handle);
    assert.ok(run.portfolio, 'the handle did not survive eviction');
});

await check('running other plans does not kill an older handle', async () => {
    // The old cache evicted at four and the handle was then dead. This asserts
    // the behaviour that replaced it.
    clearRuns();
    const { handle } = await runPlanCached(planFromProfile('midCareer'));
    for (const key of ['dualIncome', 'earlyCareer', 'retired', 'youngCouple']) {
        await runPlanCached(planFromProfile(key));
    }
    const run = await getRun(handle);
    assert.ok(run.portfolio, 'an older handle died when newer plans ran');
});

await check('an unknown handle still throws, and names what is known', async () => {
    clearRuns();
    await runPlanCached(planFromProfile('midCareer'));
    await assert.rejects(() => getRun('plan_nope'), /No run "plan_nope"[\s\S]*Known handles:/);
});

await check('an unknown handle with nothing run says so plainly', async () => {
    clearRuns();
    await assert.rejects(() => getRun('plan_nope'), /No plan has been run yet/);
});

console.log('\n── The point: a chain from a re-run is the same chain ──\n');

await check('explain over a re-run is identical to explain over the original', async () => {
    // THE assertion. The old design held the finished Portfolio because a
    // re-run would have described a different run. It does not any more, and
    // this compares the rendered causal chains character for character.
    clearRuns();
    const first = await runPlanCached(planFromProfile('midCareer'));

    // explainAt takes the RUN, not the portfolio — it reads portfolio.traceScopes
    // off it, which is the "reads take the scope list explicitly" rule.
    const original = explainAtMarkdown(
        explainAt(first, { date: '2040-06', limit: 8 }));

    evictMemo();                       // force the next getRun to re-run the plan
    const rerun = await getRun(first.handle);
    assert.notEqual(rerun.portfolio, first.portfolio, 'the memo was not actually evicted');

    const afterRerun = explainAtMarkdown(
        explainAt(rerun, { date: '2040-06', limit: 8 }));

    assert.ok(original.length > 200, 'the fixture explained nothing — assertion is vacuous');
    assert.equal(afterRerun, original);
});

await check('the re-run carries its own scopes, not the original run\'s', async () => {
    // The control for the above: if getRun handed back the memoised object the
    // comparison would pass without proving anything.
    clearRuns();
    const { handle, portfolio } = await runPlanCached(planFromProfile('midCareer'));
    evictMemo();
    const rerun = await getRun(handle);

    assert.notEqual(rerun.portfolio.traceScopes, portfolio.traceScopes,
        'the re-run shared the original scope array');
    assert.equal(rerun.portfolio.traceScopes.length, portfolio.traceScopes.length);
});

console.log('\n── Nothing is shared between plans ──\n');

await check('concurrent runs keep their configurations apart', async () => {
    const [single, joint] = await Promise.all([
        runPlan(planFromProfile('midCareer')),
        runPlan(planFromProfile('dualIncome')),
    ]);
    assert.equal(single.portfolio.config.filingAs, 'Single');
    assert.equal(joint.portfolio.config.filingAs, 'MFJ');
    assert.notEqual(single.portfolio.config.taxTable, joint.portfolio.config.taxTable);
    assert.equal(single.portfolio.config.taxTable.activeHomeSaleExclusion, 250000);
    assert.equal(joint.portfolio.config.taxTable.activeHomeSaleExclusion, 500000);
});

await check('concurrent runs match what running them one at a time produces', async () => {
    const sequentialSingle = await runPlan(planFromProfile('midCareer'));
    const sequentialJoint = await runPlan(planFromProfile('dualIncome'));

    const [single, joint] = await Promise.all([
        runPlan(planFromProfile('midCareer')),
        runPlan(planFromProfile('dualIncome')),
    ]);

    assert.equal(fingerprint(single.portfolio), fingerprint(sequentialSingle.portfolio));
    assert.equal(fingerprint(joint.portfolio), fingerprint(sequentialJoint.portfolio));
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
