/**
 * mcp-max-spending.mjs — the `max_spending` MCP tool (js/mcp/max-spending.js).
 *
 * ── What this guards ─────────────────────────────────────────────────
 *
 * The tool answers "how much can this plan spend?" for an agent that will
 * repeat the figure as advice. It is worth having only if three things hold:
 *
 *   - it is the app's answer. The same solver, the same limits and, with the
 *     simulated-markets limit, the same markets. An agent's figure that
 *     differs from the Test Bench's for the same plan is a defect in one of
 *     them, and nobody could tell which;
 *   - its first column is the plan `run_plan` runs, to the dollar. Every MCP
 *     defect so far was setup the app performs and the server did not
 *     (tests/mcp-run-plan.mjs), and none of them threw;
 *   - the plan it hands back is the answer: run on its own it spends what the
 *     tool said, keeps the limits, and differs from the plan given only in its
 *     monthly expense amounts.
 *
 * And the report must say what the answer does not cover. With the
 * simulated-markets limit off, the figure is for one fixed path of returns.
 *
 * The clock is pinned: quick-start and build_plan dates come from it.
 *
 * Usage:  node tests/mcp-max-spending.mjs   (from src/)
 */

import assert from 'node:assert/strict';
import './tools/localstorage-polyfill.js';
import { planFromProfile, runPlan, simConfigFromPlanSpec } from '../js/mcp/run-plan.js';
import { buildPlan } from '../js/mcp/build-plan.js';
import { maxSpending, maxSpendingMarkdown, MARKETS, MARKETS_SEED } from '../js/mcp/max-spending.js';
import { solveSpending, solvedAssets, isDialExpense } from '../js/spending-solver.js';
import { limitBySuccess, simulatedRate } from '../js/success-limit.js';
import { spendingHeadline } from '../js/spending-report.js';
import { planOutcome } from '../js/outcome-summary.js';
import { planExhaustion } from '../js/portfolio-issues.js';
import { CHECK_SIMULATIONS } from '../js/test-bench-run.js';
import { ModelAsset } from '../js/model-asset.js';
import { Portfolio } from '../js/portfolio.js';
import { ageToDateIntFor } from '../js/plan-dates.js';
import { outlookAssets } from '../js/market-outlook.js';

let passed = 0, failed = 0;
async function check(label, fn) {
    try { await fn(); passed++; console.log(`  ok   ${label}`); }
    catch (err) { failed++; console.log(`  FAIL ${label}\n       ${err.message}`); }
}

function at(iso, fn) {
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
        constructor(...args) { return args.length ? new RealDate(...args) : new RealDate(iso); }
        static now() { return new RealDate(iso).getTime(); }
    };
    try { return fn(); } finally { globalThis.Date = RealDate; }
}

const SPECS = at('2026-11-15T12:00:00Z', () => ({
    midCareer: planFromProfile('midCareer'),
    earlyCareer: planFromProfile('earlyCareer'),
    dualIncome: planFromProfile('dualIncome'),
    // A described plan, as build_plan compiles it: a retiree with a pension
    // and a marketplace health plan.
    retiree: buildPlan({
        settingsOverrides: { startAge: 60, retirementAge: 60, finishAge: 85 },
        income: [{ label: 'Pension', annual: 30000, kind: 'pension' }],
        accounts: [{ label: 'Checking', startingBalance: 30000 },
                   { label: 'Brokerage', startingBalance: 900000 },
                   { label: 'IRA', startingBalance: 600000, kind: 'ira' }],
        healthInsurance: [{ label: 'Marketplace Plan', premium: { monthly: 1000 },
            benchmark: { monthly: 950 }, estimatedIncome: 40000 }],
    }).spec,
}));
// "I'm 50, make $120K, retire at 60": build_plan sizes Living Expenses to all
// of take-home pay, so the plan runs out as entered, in its first months, and
// what it paid averages far below the answer it can afford.
const RUNS_OUT = at('2026-11-15T12:00:00Z', () => buildPlan({
    settingsOverrides: { startAge: 50, retirementAge: 60 },
    income: [{ label: 'Salary', annual: 120000 }],
    accounts: [{ label: 'Brokerage', startingBalance: 0 }],
}).spec);
const planOf = (spec) => ({ modelAssets: spec.modelAssets, lifeEvents: spec.lifeEvents ?? [], config: simConfigFromPlanSpec(spec) });

const SOLVED = {};
const solved = async (key) => (SOLVED[key] ??= await maxSpending(SPECS[key]));

console.log('mcp-max-spending');

// ── The app's answer ─────────────────────────────────────────────────

await check("the answer is the Test Bench solver's, plan for plan", async () => {
    for (const key of Object.keys(SPECS)) {
        const direct = solveSpending(planOf(SPECS[key]), { floor: 0 });
        const { result } = await solved(key);
        assert.equal(result.best.factor, direct.best.factor, key);
        assert.equal(result.best.monthlySpending, direct.best.monthlySpending, key);
        assert.deepEqual(result.boundBy, direct.boundBy, key);
        assert.equal('success' in result, false, `${key}: markets were run without being asked for`);
    }
});

await check("its first column is the plan run_plan runs, to the dollar", async () => {
    for (const key of Object.keys(SPECS)) {
        const run = await runPlan(SPECS[key]);
        const outcome = planOutcome(run.portfolio, run.issues);
        const { result } = await solved(key);
        assert.equal(result.asEntered.endingNominal, outcome.end, key);
        assert.equal(!!result.asEntered.runsOut, !!planExhaustion(run.issues), key);
    }
    // And the filing status is the plan's: a joint plan solved on Single
    // tables gives another figure, not an error.
    const single = await maxSpending({ ...SPECS.dualIncome, settings: { ...SPECS.dualIncome.settings, filingAs: 'Single' } });
    assert.notEqual(single.result.best.factor, (await solved('dualIncome')).result.best.factor);
});

await check('a plan that runs out as entered is answered below what was entered', async () => {
    const { result } = await solved('earlyCareer');
    assert.ok(result.asEntered.runsOut);
    assert.ok(result.best.factor < 1);
    assert.match(spendingHeadline(result),
        /^The expenses as entered cannot all be paid\. .* with every expense cut to \d+% of what you entered\.$/);
});

await check('a plan that runs out as entered is told its expenses were cut, even when it can spend more than it paid', async () => {
    const out = await maxSpending(RUNS_OUT);
    const { result } = out;
    // The case: as entered the plan paid less than the answer, while the
    // answer cuts every expense.
    assert.ok(result.asEntered.runsOut);
    assert.ok(result.best.factor < 0.5, `factor ${result.best.factor}`);
    assert.ok(result.best.monthlySpending > result.asEntered.monthlySpending + 1000);

    const share = Math.floor(result.best.factor * 100);
    const headline = spendingHeadline(result);
    assert.equal(headline, 'The expenses as entered cannot all be paid. The most this plan can spend is '
        + `$${Math.round(result.best.monthlySpending).toLocaleString('en-US')} a month, with every expense cut to `
        + `${share}% of what you entered.`);
    assert.ok(!/more than you entered/.test(headline));

    // Each expense in the report is at that share of what was entered.
    const md = maxSpendingMarkdown(out);
    assert.ok(md.includes(`**${headline}**`));
    const living = result.best.expenses.find((e) => e.displayName === 'Living Expenses');
    const entered = result.asEntered.expenses.find((e) => e.displayName === 'Living Expenses');
    assert.equal(Math.floor(living.monthly / entered.monthly * 100), share);

    // The As entered column's spending is what it paid, and says so.
    assert.match(md, /\| Monthly spending \| \$1,\d{3}\/mo paid \| \$3,\d{3}\/mo \|/);
    assert.match(md, /\| Lifetime spending \| \$\d+K paid \| \$[\d.]+M \|/);
});

await check('a plan that pays every bill as entered is compared with what it entered', async () => {
    const out = await solved('midCareer');
    assert.equal(out.result.asEntered.runsOut, null);
    assert.match(spendingHeadline(out.result),
        /^The most this plan can spend is \$5,\d{3} a month, \$\d+ a month more than you entered \(\+\d+%\)\.$/);
    assert.ok(!maxSpendingMarkdown(out).includes(' paid |'));
});

// ── The plan at the answer ───────────────────────────────────────────

await check('the plan handed back differs from the plan given only in its monthly expense amounts', async () => {
    for (const key of Object.keys(SPECS)) {
        const spec = SPECS[key];
        const before = JSON.stringify(spec);
        const { result, solvedSpec } = await maxSpending(spec);
        assert.equal(JSON.stringify(spec), before, `${key}: the plan given was changed`);

        assert.deepEqual(solvedSpec.modelAssets, solvedAssets(spec.modelAssets, result.best.factor), key);
        assert.deepEqual(solvedSpec.settings, spec.settings);
        assert.deepEqual(solvedSpec.lifeEvents, spec.lifeEvents);
        assert.equal(solvedSpec.name, `${spec.name ?? 'Plan'}: spend the most`);
        solvedSpec.modelAssets.forEach((asset, i) => {
            // As JSON: build_plan's spec holds live Currency and DateInt objects.
            const was = JSON.parse(JSON.stringify(spec.modelAssets[i]));
            if (isDialExpense(was.instrument)) {
                assert.notEqual(asset.startCurrency.amount, was.startCurrency.amount, `${key} ${was.displayName}`);
                assert.deepEqual({ ...asset, startCurrency: null }, { ...was, startCurrency: null });
            } else {
                assert.deepEqual(asset, was, `${key}: ${was.displayName} is not a monthly expense and changed`);
            }
        });
    }
});

await check('run on its own, that plan spends what the tool said and keeps the limits', async () => {
    for (const key of Object.keys(SPECS)) {
        const { result, solvedSpec } = await solved(key);
        const run = await runPlan(solvedSpec);
        assert.equal(planExhaustion(run.issues), null, `${key}: the plan at the answer runs out`);
        const own = (await maxSpending(solvedSpec)).result.asEntered;
        // Cut to the cent toward spending less, so within a dollar a month and never above.
        assert.ok(own.monthlySpending <= result.best.monthlySpending + 0.005, key);
        assert.ok(result.best.monthlySpending - own.monthlySpending < 1, key);
        assert.ok(own.endingReal >= 0);
    }
});

// ── The limits ───────────────────────────────────────────────────────

await check('leaveAtLeast is the floor: the answer leaves it, and spends less for it', async () => {
    const floor = 1_500_000;
    const { result, solvedSpec } = await maxSpending(SPECS.midCareer, { leaveAtLeast: floor });
    assert.equal(result.limits.floor, floor);
    assert.ok(result.best.endingReal >= floor);
    assert.ok(result.best.factor < (await solved('midCareer')).result.best.factor);
    assert.equal(result.boundBy.kind, 'floor');
    assert.deepEqual(solvedSpec.modelAssets, solvedAssets(SPECS.midCareer.modelAssets, result.best.factor));
});

await check('when no level keeps the limits there is no plan to hand back, and the report says so', async () => {
    const out = await maxSpending(SPECS.midCareer, { leaveAtLeast: 1e12 });
    assert.equal(out.result.best, null);
    assert.equal(out.solvedSpec, null);
    const md = maxSpendingMarkdown(out);
    assert.ok(md.includes('**No spending level tested keeps these limits.**'));
    assert.ok(!md.includes('## The expenses at that level'));
    assert.ok(!md.includes('The plan at this spending'));
});

await check('a spec with no assets is refused, not solved', async () => {
    await assert.rejects(() => maxSpending({ settings: {}, modelAssets: [] }), /nothing to solve/);
});

// ── The simulated-markets limit ──────────────────────────────────────

await check("the markets are the app's: 300 of them, seed 1", () => {
    assert.equal(MARKETS, CHECK_SIMULATIONS);
    assert.equal(MARKETS, 300);
    // test-bench-run.js SEED, which is the Simulations panel's.
    assert.equal(MARKETS_SEED, 1);
});

await check('with a share of markets asked for, the answer is limitBySuccess on those markets', async () => {
    const spec = SPECS.midCareer;
    const plan = planOf(spec);
    const bound = new Portfolio(spec.modelAssets.map((a) => ModelAsset.fromJSON(a)), false, simConfigFromPlanSpec(spec)).config;
    // Fewer markets than the tool runs, through its test seam, to keep this to half a minute.
    const sim = { markets: 60, seed: MARKETS_SEED, dataMode: plan.config.simDataMode, backtestFromYear: null,
                  retirementDateInt: ageToDateIntFor(bound, bound.retirementAge).toInt() };
    assert.equal(sim.dataMode, 'calibrated', 'the plan\'s data mode is no longer the app\'s default');
    const direct = await limitBySuccess(plan, solveSpending(plan, { floor: 0 }), {
        target: 0.9, markets: 60, rateAt: (f) => simulatedRate(plan, f, sim),
    });

    const out = await maxSpending(spec, { simulatedMarketsPercent: 90, markets: 60 });
    assert.equal(out.result.best.factor, direct.best.factor);
    assert.deepEqual(out.result.success.rates, direct.success.rates);
    assert.equal(out.result.limits.success, 0.9);
    assert.equal(out.result.boundBy.kind, 'success');
    assert.ok(out.result.best.factor < (await solved('midCareer')).result.best.factor);
    assert.deepEqual(out.solvedSpec.modelAssets, solvedAssets(spec.modelAssets, out.result.best.factor));

    const md = maxSpendingMarkdown(out);
    assert.ok(md.includes('**Limits:** never runs out · leaves at least $0 at the end · lasts in 90% of 60 simulated markets'));
    assert.match(md, /Across 60 simulated markets, as entered the plan lasts in \d+\.\d%, at the answer in 9\d\.\d%\./);
    assert.ok(md.includes('Lasting in 90% of simulated markets costs'));
    // The caveat for an answer on one path is not said of this one.
    assert.ok(!md.includes('one fixed path of returns'));

    // A rate is cut, never rounded up: 89.97% must not read as the 90% it missed.
    const best = out.result.best.factor;
    const near = maxSpendingMarkdown({ ...out, result: { ...out.result,
        success: { ...out.result.success, rates: [[1, 0.8997], [best, 0.9]] } } });
    assert.ok(near.includes('as entered the plan lasts in 89.9%, at the answer in 90.0%.'));
});

// ── The report ───────────────────────────────────────────────────────

await check('the report states the plan, the limits, the answer, what stops it and each expense', async () => {
    const out = await solved('midCareer');
    const md = maxSpendingMarkdown(out, { handle: 'plan_abc1234567' });
    const { result } = out;
    assert.ok(md.includes('**Plan:** Single · ages 45 → retires 67 → ends 90 · inflation 3.1%'));
    assert.ok(md.includes('**Limits:** never runs out · leaves at least $0 at the end\n'));
    assert.ok(md.includes(`**${spendingHeadline(result)}**`));
    assert.match(md, /\| Monthly spending \| \$5,\d{3}\/mo \| \$5,\d{3}\/mo \|/);
    assert.match(md, /\*\*What stops it:\*\* Spend more and bills go unpaid from \w+ 20\d\d, while the 401K holds/);

    // Each expense, as entered and at the answer, at its starting monthly amount.
    for (const asset of SPECS.midCareer.modelAssets.filter((a) => isDialExpense(a.instrument))) {
        const was = Math.abs(asset.startCurrency.amount);
        const now = was * result.best.factor;
        const money = (v) => `$${Math.round(v).toLocaleString('en-US')}/mo`;
        assert.ok(md.includes(`| ${asset.displayName} | ${money(was)} | ${money(now)} |`), `${asset.displayName} row`);
    }
    assert.ok(md.includes('**The plan at this spending:** `plan_abc1234567`.'));
    assert.ok(!maxSpendingMarkdown(out).includes('The plan at this spending'));
});

await check('with the markets limit off, the report says the answer is for one path and how to ask for more', async () => {
    const md = maxSpendingMarkdown(await solved('midCareer'));
    assert.ok(md.includes('**This answer is for one fixed path of returns**'));
    assert.ok(md.includes('it has no margin'));
    assert.ok(md.includes('pass `simulatedMarketsPercent: 90`'));
    assert.ok(md.includes('taxes are not in it'));
});

await check('a plan with a marketplace health plan shows spending before and from 65', async () => {
    const md = maxSpendingMarkdown(await solved('retiree'));
    assert.match(md, /\| Monthly spending before 65 \|/);
    assert.match(md, /\| Monthly spending from 65 \|/);
    assert.match(md, /\| Marketplace Plan \| \$1,000\/mo \| \$[\d,]+\/mo \|/);
});

await check('the headline says more, less, the same, a share for a plan that runs out, or that nothing keeps the limits', () => {
    const result = (entered, best) => ({ asEntered: { monthlySpending: entered }, best: best == null ? null : { monthlySpending: best } });
    assert.equal(spendingHeadline(result(5185, 5316)),
        'The most this plan can spend is $5,316 a month, $131 a month more than you entered (+3%).');
    assert.equal(spendingHeadline(result(5185, 4909)),
        'The most this plan can spend is $4,909 a month, $276 a month less than you entered (−5%).');
    assert.equal(spendingHeadline(result(5185, 5185.4)),
        'The most this plan can spend is $5,185 a month, the same as you entered.');
    assert.equal(spendingHeadline(result(5185, null)), 'No spending level tested keeps these limits.');

    // As entered the plan runs out: the answer is a share of what was
    // entered, cut to the whole percent, whatever the plan happened to pay.
    const out = (paid, best, factor) => ({ asEntered: { monthlySpending: paid, runsOut: { year: 2026, month: 12 } },
        best: best == null ? null : { monthlySpending: best, factor } });
    assert.equal(spendingHeadline(out(1891, 3369, 0.4347)),
        'The expenses as entered cannot all be paid. The most this plan can spend is $3,369 a month,'
        + ' with every expense cut to 43% of what you entered.');
    assert.equal(spendingHeadline(out(4000, 3000, 0.996)),
        'The expenses as entered cannot all be paid. The most this plan can spend is $3,000 a month,'
        + ' with every expense cut to 99% of what you entered.');
    assert.match(spendingHeadline(out(100, 20, 0.004)), /cut to less than 1% of what you entered\.$/);
    assert.equal(spendingHeadline(out(1891, null)), 'No spending level tested keeps these limits.');
});

// ── The market outlook (spec 17) ─────────────────────────────────────

const rateOf = (asset) => asset.annualReturnRate?.annualReturnRate ?? asset.annualReturnRate?.rate;
const OUTLOOK = {};
const underOutlook = async (o) => (OUTLOOK[o] ??= await maxSpending(SPECS.midCareer, { marketOutlook: o }));

await check("under an outlook the answer is the solver's on the moved copy, and moves with it", async () => {
    for (const o of ['pessimistic', 'optimistic']) {
        const spec = SPECS.midCareer;
        const direct = solveSpending(planOf({ ...spec, modelAssets: outlookAssets(spec.modelAssets, o) }), { floor: 0 });
        const { result } = await underOutlook(o);
        assert.equal(result.best.monthlySpending, direct.best.monthlySpending, o);
        assert.equal(result.outlook, o);
    }
    const moderate = (await solved('midCareer')).result;
    assert.equal(moderate.outlook, 'moderate');
    assert.ok((await underOutlook('pessimistic')).result.best.monthlySpending < moderate.best.monthlySpending);
    assert.ok((await underOutlook('optimistic')).result.best.monthlySpending > moderate.best.monthlySpending);
});

await check("the plan handed back under an outlook keeps the plan's own return rates", async () => {
    const { solvedSpec } = await underOutlook('optimistic');
    SPECS.midCareer.modelAssets.forEach((asset, i) => {
        assert.equal(rateOf(solvedSpec.modelAssets[i]), rateOf(asset), `${asset.displayName}: the rate entered`);
    });
});

await check('the report names the outlook and says the handle keeps the plan\'s own rates; Moderate says neither', async () => {
    const text = maxSpendingMarkdown(await underOutlook('pessimistic'), { handle: 'plan_abc' });
    assert.match(text, /\*\*Market outlook:\*\* Pessimistic \(\u22121%\)\. Every figure assumes stock and bond returns 1% a year lower than you entered\./);
    assert.match(text, /With stock and bond returns 1% a year lower than you entered/);
    assert.match(text, /That plan has your own return rates, not the outlook's/);
    const moderate = maxSpendingMarkdown(await solved('midCareer'), { handle: 'plan_abc' });
    assert.doesNotMatch(moderate, /Market outlook|outlook's|1% a year/);
});

await check('an outlook that is not one of the three is refused, not run as Moderate', async () => {
    await assert.rejects(() => maxSpending(SPECS.midCareer, { marketOutlook: 'rosy' }), /Unknown market outlook "rosy"/);
});

await check('with the markets limit on, the outlook reaches the markets too', async () => {
    const lo = await maxSpending(SPECS.midCareer, { marketOutlook: 'pessimistic', simulatedMarketsPercent: 90, markets: 24 });
    const mid = await maxSpending(SPECS.midCareer, { simulatedMarketsPercent: 90, markets: 24 });
    assert.ok(lo.result.success && mid.result.success, 'the limit ran');
    assert.ok(lo.result.best.monthlySpending <= mid.result.best.monthlySpending,
        `${lo.result.best.monthlySpending} vs ${mid.result.best.monthlySpending}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
