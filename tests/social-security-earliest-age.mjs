/**
 * social-security-earliest-age.mjs
 *
 * Social Security can't be claimed before 62 (42 U.S.C. §402(a)), so no plan
 * models it earlier.
 *
 *   THE ENGINE    a benefit dated before 62 pays nothing until January of the
 *                 year the user turns 62, then pays the amount entered, exactly
 *                 as if it had been dated then. It records one
 *                 SOCIAL_SECURITY_DEFERRED event in the month it was dated, and
 *                 What needs attention says so. A benefit dated at 62 or later
 *                 is untouched, and so is a pension dated as early: pensions
 *                 can start at any age.
 *
 *   THE BUILDERS  quick-start at any ages, the retirement-age move and
 *                 build_plan never date a benefit before 62.
 *
 * Usage:  node tests/social-security-earliest-age.mjs   (from src/)
 */

import assert from 'node:assert/strict';

import './tools/localstorage-polyfill.js';
import { ModelAsset } from '../js/model-asset.js';
import { Portfolio } from '../js/portfolio.js';
import { chronometer_run } from '../js/chronometer.js';
import { Metric } from '../js/metric.js';
import { EventType } from '../js/sim-event.js';
import { detectIssues } from '../js/portfolio-issues.js';
import { explainIssue } from '../js/mcp/explain.js';
import { quickStartProfiles, buildQuickStart } from '../js/quick-start.js';
import { editingConfigFor } from '../js/editing-env.js';
import { moveRetirement, describeRetirementMove } from '../js/retirement-move.js';
import { buildPlan, PlanRefusal } from '../js/mcp/build-plan.js';
import { LifeEvent } from '../js/life-event.js';
import { DateInt } from '../js/utils/date-int.js';
import {
    global_reset, global_setUserStartAge, global_getUserStartAge,
    global_setUserRetirementAge, global_getUserRetirementAge,
    global_setUserFinishAge, global_getUserFinishAge, global_setFilingAs,
    setActiveTaxTable, makeActiveTaxTable, simConfigFromGlobals,
} from '../js/globals.js';

let passed = 0, failed = 0;
async function check(label, fn) {
    try { await fn(); console.log(`  ✓ ${label}`); passed++; }
    catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

function setAges(start, retire, finish) {
    global_reset();
    global_setUserStartAge(start);       global_getUserStartAge();
    global_setUserRetirementAge(retire); global_getUserRetirementAge();
    global_setUserFinishAge(finish);     global_getUserFinishAge();
    setActiveTaxTable(makeActiveTaxTable());
}

// ── The engine ───────────────────────────────────────────────────────
//
// The household is 58 in January 2026, so it turns 62 in 2030: January 2030
// is month 48 of the run.

const PLAN_START = { year: 2026, month: 1 };
const AT_62 = 48;

const asset = (x) => ModelAsset.fromJSON({
    startDateInt: PLAN_START, startCurrency: { amount: 0 },
    startBasisCurrency: { amount: 0 }, annualReturnRate: { rate: 0 }, ...x });

const benefit = (instrument, startDateInt, name = 'Social Security') => asset({
    instrument, displayName: name, startDateInt,
    startCurrency: { amount: 2800 }, annualReturnRate: { rate: 0.025 },
    fundTransfers: [{ toDisplayName: 'Savings', monthlyMoveValue: 100, closeMoveValue: 0 }],
});

async function run(...assets) {
    setAges(58, 58, 66);
    const portfolio = new Portfolio(
        [...assets, asset({ instrument: 'bank', displayName: 'Savings', startCurrency: { amount: 100000 } })],
        false, simConfigFromGlobals());
    await chronometer_run(portfolio);
    return portfolio;
}

const named = (p, name) => p.modelAssets.find((a) => a.displayName === name);
const paid = (p, name) => named(p, name).getHistory(Metric.SOCIAL_SECURITY_INCOME);
const deferrals = (p) => p.modelAssets.flatMap((a) => a.events)
    .filter((e) => e.type === EventType.SOCIAL_SECURITY_DEFERRED);

console.log('\n-- The engine never pays Social Security before 62 --\n');

const early = await run(benefit('retirementIncome', PLAN_START));

await check('a benefit dated at 58 pays nothing until January of the year the user turns 62', () => {
    assert.equal(early.config.birthYear, 1968);
    const h = paid(early, 'Social Security');
    assert.ok(h.slice(0, AT_62).every((v) => v === 0),
        `paid before 62, first at month ${h.findIndex((v) => v !== 0)}`);
    assert.equal(h[AT_62], 2800);
});

await check('and the run is the one dated at 62, event for event', async () => {
    const dated62 = await run(benefit('retirementIncome', { year: 2030, month: 1 }));
    assert.deepEqual(paid(early, 'Social Security'), paid(dated62, 'Social Security'));
    assert.deepEqual(named(early, 'Savings').getHistory(Metric.VALUE),
        named(dated62, 'Savings').getHistory(Metric.VALUE));
    assert.deepEqual(named(early, 'Social Security').getHistory(Metric.VALUE),
        named(dated62, 'Social Security').getHistory(Metric.VALUE));
    // Everything but the report of the deferral itself.
    const ledger = (p) => p.modelAssets.flatMap((a) => a.events
        .filter((e) => e.type !== EventType.SOCIAL_SECURITY_DEFERRED)
        .map((e) => `${a.displayName} ${e.dateInt} ${e.type} ${e.amount.amount.toFixed(6)}`));
    assert.deepEqual(ledger(early), ledger(dated62));
    assert.equal(deferrals(dated62).length, 0, 'a benefit dated at 62 was reported as deferred');
});

await check('it records the deferral once, in the month it was dated', () => {
    const events = deferrals(early);
    assert.equal(events.length, 1);
    assert.equal(String(events[0].dateInt), '2026-01');
    assert.deepEqual(events[0].data, { age: 62, from: 202601, to: 203001 });
    assert.equal(events[0].amount.amount, 0);
});

await check('What needs attention says when it starts, and explain_issue finds why', () => {
    const issues = detectIssues(early);
    const issue = issues.find((i) => i.id === 'social-security-deferred');
    assert.ok(issue, `no finding, got [${issues.map((i) => i.id)}]`);
    assert.equal(issue.assetName, 'Social Security');
    assert.equal(String(issue.firstDateInt), '2030-01');
    assert.match(issue.detail, /January 2026/);
    assert.match(issue.detail, /January 2030/);
    const why = explainIssue({ portfolio: early, issues }, 'social-security-deferred');
    assert.equal(why.totalOccurrences, 1);
});

await check('one month early is still early', async () => {
    const p = await run(benefit('retirementIncome', { year: 2029, month: 12 }));
    assert.equal(paid(p, 'Social Security').findIndex((v) => v !== 0), AT_62);
    assert.equal(deferrals(p).length, 1);
});

await check('a pension can start at any age', async () => {
    const p = await run(benefit('pension', PLAN_START, 'Pension'));
    assert.ok(named(p, 'Pension').getHistory(Metric.PENSION_INCOME)[0] > 0, 'the pension was held back');
    assert.equal(deferrals(p).length, 0);
    assert.ok(!detectIssues(p).some((i) => i.id === 'social-security-deferred'));
});

// ── The builders ─────────────────────────────────────────────────────
//
// quick-start and build_plan date a plan from the clock, so pin it.

const RealDate = Date;
const PINNED = new RealDate(2026, 8, 15);   // September 2026
globalThis.Date = class extends RealDate {
    constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(PINNED); }
    static now() { return PINNED.getTime(); }
};
const NOW = DateInt.from(2026, 9);

const earliestFor = (startAge) => DateInt.from(2026 - startAge + 62, 1);
const socialSecurity = (assets) => assets.filter((a) => a.instrument === 'retirementIncome');

console.log('\n-- Quick start never dates it before 62, or before the plan --\n');

const AGES = [
    { startAge: 50, retirementAge: 55 }, { startAge: 58, retirementAge: 58 },
    { startAge: 60, retirementAge: 61 }, { startAge: 64, retirementAge: 64 },
    { startAge: 70, retirementAge: 65 }, { startAge: 45, retirementAge: 67 },
];

await check('every profile at every age', () => {
    let seen = 0;
    for (const profile of quickStartProfiles) {
        for (const ages of AGES) {
            setAges(ages.startAge, ages.retirementAge, 90);
            const { assets } = buildQuickStart(profile, ages);
            for (const ss of socialSecurity(assets)) {
                seen++;
                const where = `${profile.key} ${ages.startAge}/${ages.retirementAge} ${ss.displayName}`;
                assert.ok(!ss.startDateInt.isBefore(earliestFor(ages.startAge)),
                    `${where} starts ${ss.startDateInt}, before 62`);
                assert.ok(!ss.startDateInt.isBefore(NOW), `${where} starts ${ss.startDateInt}, before the plan`);
            }
        }
    }
    assert.ok(seen > 0, 'no profile has Social Security: this check would be vacuous');
});

await check('a retirement at 62 or later still claims at retirement', () => {
    const mid = quickStartProfiles.find((p) => p.key === 'midCareer');
    setAges(45, 67, 90);
    const [ss] = socialSecurity(buildQuickStart(mid, { startAge: 45, retirementAge: 67 }).assets);
    assert.equal(String(ss.startDateInt), String(DateInt.from(2026 - 45 + 67, 1)));
});

console.log('\n-- Moving retirement before 62 holds Social Security at 62 --\n');

function loaded(profile, retirementAge = profile.retirementAge) {
    setAges(profile.startAge, retirementAge, profile.finishAge);
    global_setFilingAs(profile.filingAs);
    const { assets, lifeEvents } = buildQuickStart(profile, { retirementAge });
    const config = editingConfigFor(assets);
    for (const a of assets) a.bindEnv(config);
    for (const e of lifeEvents) e.bindEnv(config);
    return { assets, lifeEvents };
}
const planJSON = ({ assets, lifeEvents }) => JSON.stringify({
    assets: assets.map((a) => a.toJSON()), phases: lifeEvents.map((e) => [e.type, e.triggerAge]) });

const PRE = quickStartProfiles.find((p) => p.key === 'preRetirement');   // 55, retiring at 65

await check('retiring at 58 ends the salary at 58 and starts Social Security at 62', () => {
    const plan = loaded(PRE);
    const result = moveRetirement(plan.assets, plan.lifeEvents, 58);
    const ss = plan.assets.find((a) => a.displayName === 'Social Security');
    const salary = plan.assets.find((a) => a.displayName === 'Salary');
    assert.equal(String(ss.startDateInt), String(earliestFor(55)));
    assert.equal(String(salary.finishDateInt), String(DateInt.from(2026 - 55 + 58, 1)));
    assert.equal(describeRetirementMove(result),
        `Moved Salary's end to Jan ${2026 - 55 + 58} with your retirement. `
        + `Moved Social Security's start to Jan ${2026 - 55 + 62}, at 62: Social Security can't be claimed earlier.`);
});

await check('and the move matches the profile built at 58', () => {
    const plan = loaded(PRE);
    moveRetirement(plan.assets, plan.lifeEvents, 58);
    assert.equal(planJSON(plan), planJSON(loaded(PRE, 58)));
});

await check('between two ages under 62, Social Security stays at 62 and is not reported', () => {
    const plan = loaded(PRE, 58);
    const result = moveRetirement(plan.assets, plan.lifeEvents, 60);
    const ss = plan.assets.find((a) => a.displayName === 'Social Security');
    assert.equal(String(ss.startDateInt), String(earliestFor(55)));
    assert.ok(!result.moved.some((m) => m.asset === ss));
});

await check('moving back to 65 takes it back to 65', () => {
    const plan = loaded(PRE);
    const before = planJSON(plan);
    moveRetirement(plan.assets, plan.lifeEvents, 58);
    moveRetirement(plan.assets, plan.lifeEvents, 65);
    assert.equal(planJSON(plan), before);
    assert.equal(plan.lifeEvents.find((e) => e.type === LifeEvent.RETIRE).triggerAge, 65);
});

console.log('\n-- build_plan refuses a benefit it would have to start before 62 --\n');

const SS_PLAN = (startAge) => ({
    horizonYears: 10, settingsOverrides: { startAge, retirementAge: startAge + 5 },
    income: [{ label: 'Social Security', annual: 24000, kind: 'socialSecurity' }],
    accounts: [{ label: 'Savings', startingBalance: 50000 }],
});

await check('at 50 it asks instead of building', () => {
    assert.throws(() => buildPlan(SS_PLAN(50)), (e) => {
        assert.ok(e instanceof PlanRefusal, `threw ${e.name}: ${e.message}`);
        assert.equal(e.field, 'Social Security');
        assert.match(e.reason, /can't be claimed before 62/);
        assert.ok(e.question, 'a refusal must say what to ask');
        return true;
    });
});

await check('at 62 it builds, starting now', () => {
    const { spec } = buildPlan(SS_PLAN(62));
    const ss = spec.modelAssets.find((a) => a.displayName === 'Social Security');
    assert.equal(`${ss.startDateInt.year}-${ss.startDateInt.month}`, `${NOW.year}-${NOW.month}`);
});

console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
