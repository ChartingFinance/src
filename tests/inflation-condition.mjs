/**
 * inflation-condition.mjs — headless engine + MCP tests for the Test Bench's
 * 3rd stacking condition ("Higher inflation": As entered / +1% / +2%).
 *
 * Run: node tests/inflation-condition.mjs   (from src/)
 */

import assert from 'node:assert/strict';

import {
    INFLATION_SHIFTS, inflationShiftOf, inflationRateShift, inflationLabel,
    inflationChip, inflationClause, inflationLine, inflationNote,
} from '../js/inflation-condition.js';
import { lossYearsSummary } from '../js/loss-years.js';
import { planFromProfile, simConfigFromPlanSpec } from '../js/mcp/run-plan.js';
import { maxSpending, maxSpendingMarkdown } from '../js/mcp/max-spending.js';
import { computeMonteCarlo } from '../js/mc-compute.js';
import { ModelAsset } from '../js/model-asset.js';
import { ModelLifeEvent } from '../js/life-event.js';
import { Portfolio } from '../js/portfolio.js';
import { ageToDateIntFor } from '../js/plan-dates.js';
import { withSimConfig } from '../js/sim-config.js';

let passed = 0, failed = 0;
async function check(label, fn) {
    try { await fn(); passed++; console.log(`  ok   ${label}`); }
    catch (err) { failed++; console.log(`  FAIL ${label}\n       ${err.message}`); }
}

console.log('\n── inflation-condition.js helpers ──\n');

await check('accepts 0, 1, 2 and rejects invalid values', () => {
    assert.deepEqual(INFLATION_SHIFTS, [0, 1, 2]);
    assert.equal(inflationShiftOf(undefined), 0);
    assert.equal(inflationShiftOf(null), 0);
    assert.equal(inflationShiftOf(0), 0);
    assert.equal(inflationShiftOf(1), 1);
    assert.equal(inflationShiftOf(2), 2);
    assert.equal(inflationRateShift(0), 0);
    assert.equal(inflationRateShift(1), 0.01);
    assert.equal(inflationRateShift(2), 0.02);
    assert.throws(() => inflationShiftOf(3), /Unknown inflation shift/);
    assert.throws(() => inflationShiftOf(0.5), /Unknown inflation shift/);
    assert.throws(() => inflationShiftOf('1'), /Unknown inflation shift/);
});

await check('labels, chips, clauses, lines, and notes match neutral vs stressed', () => {
    assert.equal(inflationLabel(0), 'As entered');
    assert.equal(inflationLabel(1), '+1%');
    assert.equal(inflationLabel(2), '+2%');
    assert.equal(inflationChip(0), null);
    assert.equal(inflationChip(1), 'Inflation +1%');
    assert.equal(inflationClause(0), null);
    assert.equal(inflationClause(2), 'inflation 2% a year higher than you entered');
    assert.equal(inflationLine(0), "Plan's own rate");
    assert.match(inflationLine(1), /\+1%\/yr/);
    assert.equal(inflationNote(0), null);
    assert.match(inflationNote(2), /2% a year higher/);
});

await check('lossYearsSummary keeps compact text and puts 1970 scale note in tooltip', () => {
    const dates = { retirement: { year: 2031, month: 1 }, first: { year: 2026, month: 1 }, last: { year: 2060, month: 12 } };
    const none = lossYearsSummary({ count: 0, stocks: [], bonds: [] }, dates);
    assert.equal(none.scaleTip, null);
    assert.equal(none.text, '');

    const one = lossYearsSummary({ count: 1, stocks: [30], bonds: [0] }, dates);
    assert.match(one.text, /2031/);
    assert.match(one.scaleTip, /1970/);
    assert.ok(!one.text.includes('1970'), 'scale note moved out of inline text into scaleTip');
});

console.log('\n── Engine + MCP maxSpending under Higher inflation ──\n');

const spec = planFromProfile('midCareer');

await check('higher inflation monotonically lowers max monthly spending and preserves entered inflation in solvedSpec', async () => {
    const base = await maxSpending(spec);
    const plus1 = await maxSpending(spec, { inflationShiftPercent: 1 });
    const plus2 = await maxSpending(spec, { inflationShiftPercent: 2 });

    assert.ok(base.result.best && plus1.result.best && plus2.result.best);
    assert.ok(plus1.result.best.monthlySpending < base.result.best.monthlySpending,
        `+1% (${plus1.result.best.monthlySpending}) should be < base (${base.result.best.monthlySpending})`);
    assert.ok(plus2.result.best.monthlySpending < plus1.result.best.monthlySpending,
        `+2% (${plus2.result.best.monthlySpending}) should be < +1% (${plus1.result.best.monthlySpending})`);

    // Saved spec keeps the original entered inflation rate
    assert.equal(plus2.solvedSpec.settings?.inflationRate, spec.settings?.inflationRate);

    // Markdown reports the inflation condition, headline clause, and handle caveat
    const md = maxSpendingMarkdown(plus2, { handle: 'plan_test123' });
    assert.match(md, /\*\*Higher inflation:\*\* \+2%/);
    assert.match(md, /With inflation 2% a year higher than you entered/);
    assert.match(md, /keeps your entered inflation rate/);
});

await check('stacks cleanly with Pessimistic outlook and Loss years', async () => {
    const lossOnly = await maxSpending(spec, { marketOutlook: 'pessimistic', lossYearsPercent: [30] });
    const stacked = await maxSpending(spec, {
        marketOutlook: 'pessimistic',
        lossYearsPercent: [30],
        inflationShiftPercent: 2,
    });
    assert.ok(stacked.result.best.monthlySpending < lossOnly.result.best.monthlySpending,
        'adding +2% inflation on top of Pessimistic + Loss years lowers max spending further');
    const md = maxSpendingMarkdown(stacked, { handle: 'plan_stacked' });
    assert.match(md, /\*\*Market outlook:\*\* Pessimistic/);
    assert.match(md, /\*\*Loss years:\*\*/);
    assert.match(md, /\*\*Higher inflation:\*\* \+2%/);
    assert.match(md, /and inflation 2% a year higher than you entered/);
});

await check('Monte Carlo applies inflationShift in both calibrated and historical modes', async () => {
    const baseConfig = simConfigFromPlanSpec(spec);
    const stressedConfig = withSimConfig(baseConfig, { inflationRate: baseConfig.inflationRate + 0.02 });
    const assets = spec.modelAssets.map((a) => ModelAsset.fromJSON(a));
    const events = (spec.lifeEvents ?? []).map((e) => ModelLifeEvent.fromJSON(e));
    const placed = new Portfolio(ModelAsset.cloneArray(assets), false, baseConfig);
    const retDate = ageToDateIntFor(placed.config, placed.config.retirementAge);

    for (const dataMode of ['calibrated', 'historical']) {
        const mcBase = await computeMonteCarlo(assets, {
            numSimulations: 30,
            retirementDateInt: retDate,
            lifeEvents: events,
            dataMode,
            seed: 1,
            inflationShift: 0,
            config: baseConfig,
        });
        const mcStressed = await computeMonteCarlo(assets, {
            numSimulations: 30,
            retirementDateInt: retDate,
            lifeEvents: events,
            dataMode,
            seed: 1,
            inflationShift: 0.02,
            config: stressedConfig,
        });
        const endRealBase = mcBase.bandDataReal[2].at(-1);
        const endRealStressed = mcStressed.bandDataReal[2].at(-1);
        assert.ok(endRealStressed < endRealBase,
            `${dataMode}: median real ending balance under +2% inflation (${Math.round(endRealStressed)}) `
            + `should be lower than base (${Math.round(endRealBase)})`);
    }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
