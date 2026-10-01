/**
 * outcome-summary.mjs
 *
 * The Outcome strip's three answers, and the stat cards that share them.
 *
 *   THE PLAN TILE   is the run's own last month: net worth summed the way
 *                   Month Details sums it, deflated by the run's own price
 *                   index, and "runs out" exactly when "What needs attention"
 *                   says so. A plan that fails must not read "never runs out".
 *
 *   THE SIMULATION TILES   read the results the stat cards read, so the
 *                   strip and the cards cannot show different numbers. The
 *                   tone thresholds are pinned at their edges.
 *
 *   NOTHING TO SHOW   no run, no tile, rather than a $0 answer.
 *
 * Run: node tests/outcome-summary.mjs   (from src/)
 */

import assert from 'node:assert/strict';

import './tools/localstorage-polyfill.js';
import { runPlan, planFromProfile } from '../js/mcp/run-plan.js';
import { planOutcome, simulationOutcome, guardrailsOutcome, successTone } from '../js/outcome-summary.js';
import { metricAtIndex, lastHistoryIndex } from '../js/month-summary.js';
import { planExhaustion, monthLabel } from '../js/portfolio-issues.js';
import { computeMonteCarlo } from '../js/mc-compute.js';
import { Metric } from '../js/metric.js';

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); failed++; }
}

// quick-start dates every asset from the clock; pin it (as mcp-explain.mjs does).
const RealDate = Date;
function frozenPlan(profileKey, ageOverrides = null) {
    const fixed = new RealDate('2026-08-31T12:00:00Z');
    globalThis.Date = class extends RealDate {
        constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(fixed); }
        static now() { return fixed.getTime(); }
    };
    try { return planFromProfile(profileKey, ageOverrides); }
    finally { globalThis.Date = RealDate; }
}

const healthy = await runPlan(frozenPlan('midCareer'));
/** Retiring at 58 on Mid Career balances cannot be funded (see mcp-explain.mjs). */
const broke = await runPlan(frozenPlan('midCareer', { startAge: 57, retirementAge: 58, finishAge: 95 }));

// ── the plan tile ────────────────────────────────────────────────────

console.log('\n── Plan as entered ──\n');

await test('the ending is the last month of net worth, summed as Month Details sums it', () => {
    const { portfolio, issues } = healthy;
    const out = planOutcome(portfolio, issues);
    const last = lastHistoryIndex(portfolio);
    const byHand = portfolio.modelAssets.reduce((s, a) => s + (a.getHistory(Metric.VALUE)[last] ?? 0), 0);
    assert.equal(out.end, metricAtIndex(portfolio, Metric.VALUE, last));
    assert.ok(Math.abs(out.end - byHand) < 0.005, `${out.end} vs ${byHand}`);
    assert.ok(out.end > 0);
});

await test("today's dollars use the run's own price index at the last month", () => {
    const { portfolio, issues } = healthy;
    const out = planOutcome(portfolio, issues);
    const last = lastHistoryIndex(portfolio);
    assert.ok(portfolio.monthlyPriceIndex.length > last, 'the run recorded no price index');
    assert.ok(Math.abs(out.endReal - out.end / portfolio.monthlyPriceIndex[last]) < 0.005);
    assert.ok(out.endReal < out.end, 'inflation should make the real ending smaller');
});

await test('a plan that pays every bill says "never runs out"', () => {
    const { portfolio, issues } = healthy;
    assert.equal(planExhaustion(issues), null, 'precondition: the healthy plan has no exhaustion finding');
    const out = planOutcome(portfolio, issues);
    assert.equal(out.exhaustion, null);
    assert.match(out.detail, /never runs out$/);
    assert.equal(out.tone, 'good');
});

await test('a plan that runs out says when, the same month "What needs attention" names', () => {
    const { portfolio, issues } = broke;
    const finding = planExhaustion(issues);
    assert.ok(finding, 'precondition: retiring at 58 should exhaust the plan');
    const out = planOutcome(portfolio, issues);
    assert.equal(out.exhaustion.toInt(), finding.firstDateInt.toInt());
    assert.ok(out.detail.endsWith(`runs out ${monthLabel(finding.firstDateInt)}`), out.detail);
    assert.ok(!out.detail.includes('never'), out.detail);
    assert.equal(out.tone, 'bad');
});

await test('no run, no tile', () => {
    assert.equal(planOutcome(null, []), null);
    assert.equal(planOutcome({ modelAssets: [], firstDateInt: null }, []), null);
});

// ── the simulation tiles ─────────────────────────────────────────────

console.log('\n── Simulated markets ──\n');

await test('success tone at its edges: 90 good, 89 and 70 warn, 69 bad', () => {
    assert.equal(successTone(90), 'good');
    assert.equal(successTone(89), 'warn');
    assert.equal(successTone(70), 'warn');
    assert.equal(successTone(69), 'bad');
});

await test('a real run: percent, median and bands read from its last month', async () => {
    const { portfolio } = healthy;
    const res = await computeMonteCarlo(portfolio.modelAssets.map((a) => a), {
        config: portfolio.config, numSimulations: 30, seed: 1,
        retirementDateInt: null, lifeEvents: portfolio.lifeEvents,
    });
    const out = simulationOutcome(res);
    const last = res.labels.length - 1;
    assert.equal(out.percent, Math.round(res.successRate * 100));
    assert.equal(out.value, `${out.percent}%`);
    assert.equal(out.median, res.bandData[2][last]);
    assert.equal(out.p10, res.bandData[0][last]);
    assert.equal(out.p90, res.bandData[4][last]);
    assert.equal(out.horizon, res.labels[last]);
    assert.equal(out.runs, 30);
    assert.match(out.detail, /^succeed · median \$/);
});

await test('guardrails: cuts are preservation events, the rest are raises', () => {
    const results = {
        portfolioValues: [100, 200, 4_250_000], withdrawalSteps: [0, 0, 180_000],
        labels: ['Jan 2026', 'Jan 2027', 'Jan 2028'],
        events: [{ type: 'preservation' }, { type: 'prosperity' }, { type: 'prosperity' }],
    };
    const out = guardrailsOutcome(results);
    assert.deepEqual([out.end, out.cuts, out.raises, out.finalWithdrawal], [4_250_000, 1, 2, 180_000]);
    assert.equal(out.value, '$4.3M');
    assert.equal(out.detail, '1 spending cut · 2 raises');
    assert.equal(out.tone, undefined);
});

await test('guardrails ending at or below $0 is bad', () => {
    const out = guardrailsOutcome({ portfolioValues: [5, 0], withdrawalSteps: [0, 0], labels: ['a', 'b'], events: [] });
    assert.equal(out.tone, 'bad');
    assert.equal(out.detail, '0 spending cuts · 0 raises');
});

await test('no results, no tile', () => {
    assert.equal(simulationOutcome(null), null);
    assert.equal(guardrailsOutcome(null), null);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
