/**
 * backstop-failover.mjs
 *
 * Regression tests for multi-hop backstop spillover and post-59½
 * (age >= 60) retirement failover (IRA → 401K → Roth IRA last resort):
 *
 *   1. Multi-hop two-sided spillover (FundTransfer.execute): drains
 *      Cash → Savings → Brokerage → US Bond → Corp Bond in a single draw.
 *   2. Recurring deposits into Savings (e.g. Social Security) do NOT block
 *      spillover from continuing to Brokerage when IRA is exhausted.
 *   3. Multi-hop one-sided settlement (settleOneSided): mortgage payments and
 *      annual tax bills drain across multiple backstop accounts in one draw
 *      with accurate per-leg LTCG and tax metric attribution.
 *   4. Multi-hop retirement withholding (#withholdInScope): withholding on a
 *      final IRA draw drains across Savings → Brokerage.
 *   5. Post-59½ retirement failover at age >= 60: drains everyday accounts
 *      first, then tax-deferred (IRA → 401K), then Roth IRA strictly as last
 *      resort; books exact per-leg distribution metrics and conservation.
 *   6. Age < 60 protection: IRA, 401K, and Roth IRA are NOT drawn by failover
 *      before age 60.
 *   7. Deposits / tax refunds NEVER land in retirement accounts (resolveDeposit
 *      stays strictly everyday accounts).
 *
 * Usage:  node tests/backstop-failover.mjs   (from src/)
 */

import assert from 'node:assert/strict';
import './tools/localstorage-polyfill.js';

import { Portfolio } from '../js/portfolio.js';
import { chronometer_run } from '../js/chronometer.js';
import { Metric } from '../js/metric.js';
import { EventType } from '../js/sim-event.js';
import { Instrument } from '../js/instruments/instrument.js';
import { planExhaustion } from '../js/portfolio-issues.js';
import { runPlan, simConfigFromPlanSpec } from '../js/mcp/run-plan.js';
import { membrane_rawDataToModelAssets } from '../js/membrane.js';

let passed = 0, failed = 0;
async function check(label, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${label}`); }
    catch (err) { failed++; console.log(`  ✗ ${label}\n    ${err.message}`); }
}

const near = (got, want, label, tol = 0.05) =>
    assert.ok(Math.abs(got - want) <= tol, `${label}: got ${got}, want ${want}`);

const asset = (overrides) => ({
    startDateInt: { year: 2026, month: 1 },
    finishDateInt: { year: 2026, month: 12 },
    annualReturnRate: { rate: 0 },
    ...overrides,
});

// ── 1. Multi-hop two-sided spillover across 4 backstop tiers ─────────

console.log('\n── 1. Multi-hop two-sided spillover (Cash → Savings → Brokerage → US Bond) ──\n');

{
    // Living ($10,000/mo) routed 100% to empty IRA ($0).
    // Month 1 must drain Cash ($500) → Savings ($1,500) → Brokerage ($2,000,
    // 50% gain) → US Bond ($6,000 of $200,000) in a SINGLE draw with zero unfunded!
    const spec = {
        name: 'multi-hop-4-tiers',
        settings: { filingAs: 'Single', startAge: 50, retirementAge: 50, finishAge: 51, inflationRate: 0 },
        lifeEvents: [],
        modelAssets: [
            asset({ instrument: Instrument.CASH, displayName: 'Cash', startCurrency: { amount: 500 }, startBasisCurrency: { amount: 500 } }),
            asset({ instrument: Instrument.BANK, displayName: 'Savings', startCurrency: { amount: 1500 }, startBasisCurrency: { amount: 1500 } }),
            asset({ instrument: Instrument.TAXABLE_EQUITY, displayName: 'Brokerage', startCurrency: { amount: 2000 }, startBasisCurrency: { amount: 1000 } }),
            asset({ instrument: Instrument.US_BOND, displayName: 'Treasuries', startCurrency: { amount: 200000 }, startBasisCurrency: { amount: 200000 } }),
            asset({ instrument: Instrument.IRA, displayName: 'IRA', startCurrency: { amount: 0 }, startBasisCurrency: { amount: 0 } }),
            asset({
                instrument: Instrument.MONTHLY_EXPENSE, displayName: 'Living',
                startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 1 },
                startCurrency: { amount: -10000 }, startBasisCurrency: { amount: 0 },
                fundTransfers: [{ toDisplayName: 'IRA', monthlyMoveValue: 100, closeMoveValue: 0 }],
            }),
        ],
    };

    const { portfolio: p, issues } = await runPlan(spec);

    await check('single $10k draw drains Cash ($500), Savings ($1,500), Brokerage ($2,000), and Treasuries ($6,000) with zero unfunded', () => {
        assert.equal(planExhaustion(issues), null, 'plan should not report exhaustion');
        const bal = (n) => p.modelAssets.find((a) => a.displayName === n).finishCurrency.amount;
        near(bal('Cash'), 0, 'Cash');
        near(bal('Savings'), 0, 'Savings');
        near(bal('Brokerage'), 0, 'Brokerage');
        near(bal('Treasuries'), 194000, 'Treasuries');
        // Brokerage realized $1,000 LTCG (50% gain on $2,000 sold)
        near(p.total.longTermCapitalGains.amount, 1000, 'Brokerage spillover LTCG');
    });
}

// ── 2. Recurring deposits to Savings do NOT block Brokerage ──────────

console.log('\n── 2. Recurring deposits into Savings do not block Brokerage failover ──\n');

{
    // Exact user scenario: IRA runs dry, Social Security deposits $3,000/mo into
    // Savings every month, Living Expenses ($8,000/mo) routes 100% IRA, Brokerage
    // holds $1.5M, Roth holds $500k.
    const spec = {
        name: 'ss-to-savings-does-not-block-brokerage',
        settings: { filingAs: 'Single', startAge: 62, retirementAge: 62, finishAge: 70, inflationRate: 0 },
        lifeEvents: [],
        modelAssets: [
            asset({
                instrument: Instrument.RETIREMENT_INCOME, displayName: 'Social Security',
                finishDateInt: { year: 2033, month: 12 },
                startCurrency: { amount: 3000 }, startBasisCurrency: { amount: 0 },
                fundTransfers: [{ toDisplayName: 'Savings', monthlyMoveValue: 100, closeMoveValue: 0 }],
            }),
            asset({
                instrument: Instrument.BANK, displayName: 'Savings',
                finishDateInt: { year: 2033, month: 12 },
                startCurrency: { amount: 5000 }, startBasisCurrency: { amount: 5000 },
            }),
            asset({
                instrument: Instrument.TAXABLE_EQUITY, displayName: 'Brokerage',
                finishDateInt: { year: 2033, month: 12 },
                startCurrency: { amount: 1500000 }, startBasisCurrency: { amount: 750000 },
            }),
            asset({
                instrument: Instrument.IRA, displayName: 'IRA',
                finishDateInt: { year: 2033, month: 12 },
                startCurrency: { amount: 50000 }, startBasisCurrency: { amount: 0 },
            }),
            asset({
                instrument: Instrument.ROTH_IRA, displayName: 'Roth',
                finishDateInt: { year: 2033, month: 12 },
                startCurrency: { amount: 500000 }, startBasisCurrency: { amount: 500000 },
            }),
            asset({
                instrument: Instrument.MONTHLY_EXPENSE, displayName: 'Living Expenses',
                finishDateInt: { year: 2033, month: 12 },
                startCurrency: { amount: -8000 }, startBasisCurrency: { amount: 0 },
                fundTransfers: [{ toDisplayName: 'IRA', monthlyMoveValue: 100, closeMoveValue: 0 }],
            }),
        ],
    };

    const { portfolio: p, issues } = await runPlan(spec);

    await check('once IRA empties, Savings + Brokerage jointly cover every month with zero unfunded and Roth untouched', () => {
        assert.equal(planExhaustion(issues), null, 'plan must stay funded');
        const brok = p.modelAssets.find((a) => a.displayName === 'Brokerage');
        const roth = p.modelAssets.find((a) => a.displayName === 'Roth');
        assert.ok(brok.finishCurrency.amount < 1200000, `Brokerage should have been drawn down, got ${brok.finishCurrency.amount}`);
        assert.ok(brok.finishCurrency.amount > 500000, `Brokerage should still have healthy balance, got ${brok.finishCurrency.amount}`);
        near(roth.finishCurrency.amount, 500000, 'Roth untouched while Brokerage has funds');
    });
}

// ── 3. Multi-hop one-sided settlement (mortgage + tax true-up) ───────

console.log('\n── 3. Multi-hop one-sided settlement (settleOneSided) ──\n');

{
    // Mortgage payment ($5,000+) routed to empty IRA spills across Cash ($400) →
    // Savings ($600) → Brokerage ($100,000, 50% gain) in one draw.
    const spec = {
        name: 'multi-hop-one-sided-mortgage',
        settings: { filingAs: 'Single', startAge: 50, retirementAge: 50, finishAge: 51, inflationRate: 0 },
        lifeEvents: [],
        modelAssets: [
            asset({ instrument: Instrument.CASH, displayName: 'Cash', startCurrency: { amount: 400 }, startBasisCurrency: { amount: 400 } }),
            asset({ instrument: Instrument.BANK, displayName: 'Savings', startCurrency: { amount: 600 }, startBasisCurrency: { amount: 600 } }),
            asset({ instrument: Instrument.TAXABLE_EQUITY, displayName: 'Brokerage', startCurrency: { amount: 100000 }, startBasisCurrency: { amount: 50000 } }),
            asset({ instrument: Instrument.IRA, displayName: 'IRA', startCurrency: { amount: 0 }, startBasisCurrency: { amount: 0 } }),
            asset({
                instrument: Instrument.MORTGAGE, displayName: 'Mortgage',
                startCurrency: { amount: -300000 }, annualReturnRate: { rate: 0.06 },
                monthsRemaining: 120,
                fundTransfers: [{ toDisplayName: 'IRA', monthlyMoveValue: 100, closeMoveValue: 0 }],
            }),
        ],
    };

    const { portfolio: p, issues } = await runPlan(spec);

    await check('mortgage payment spills across Cash → Savings → Brokerage with zero unfunded and Brokerage LTCG booked', () => {
        assert.equal(planExhaustion(issues), null, 'mortgage should never go unfunded');
        const bal = (n) => p.modelAssets.find((a) => a.displayName === n).finishCurrency.amount;
        near(bal('Cash'), 0, 'Cash');
        near(bal('Savings'), 0, 'Savings');
        assert.ok(bal('Brokerage') < 90000, `Brokerage should cover remainder, got ${bal('Brokerage')}`);
        assert.ok(p.total.longTermCapitalGains.amount > 10000, `expected Brokerage LTCG > $10k, got ${p.total.longTermCapitalGains.amount}`);
    });
}

// ── 4. Multi-hop retirement distribution withholding ─────────────────

console.log('\n── 4. Multi-hop withholding when IRA drains completely ──\n');

{
    // IRA starts with $10,000, Living draws $10,000 in Jan 2026 -> IRA hits $0.
    // 10% withholding ($1,111.11) spills across Savings ($300) → Brokerage ($50,000).
    const spec = {
        name: 'multi-hop-withholding',
        settings: { filingAs: 'Single', startAge: 62, retirementAge: 62, finishAge: 63, inflationRate: 0 },
        lifeEvents: [],
        modelAssets: [
            asset({ instrument: Instrument.BANK, displayName: 'Savings', startCurrency: { amount: 300 }, startBasisCurrency: { amount: 300 } }),
            asset({ instrument: Instrument.TAXABLE_EQUITY, displayName: 'Brokerage', startCurrency: { amount: 50000 }, startBasisCurrency: { amount: 25000 } }),
            asset({ instrument: Instrument.IRA, displayName: 'IRA', startCurrency: { amount: 10000 }, startBasisCurrency: { amount: 0 } }),
            asset({
                instrument: Instrument.MONTHLY_EXPENSE, displayName: 'Living',
                startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 1 },
                startCurrency: { amount: -10000 }, startBasisCurrency: { amount: 0 },
                fundTransfers: [{ toDisplayName: 'IRA', monthlyMoveValue: 100, closeMoveValue: 0 }],
            }),
        ],
    };

    const { portfolio: p, issues } = await runPlan(spec);

    await check('withholding on final IRA draw drains Savings ($300) and spills remainder ($811.11) to Brokerage', () => {
        assert.equal(planExhaustion(issues), null, 'withholding must not go unfunded');
        const sav = p.modelAssets.find((a) => a.displayName === 'Savings');
        const brok = p.modelAssets.find((a) => a.displayName === 'Brokerage');
        const janSpills = [sav, brok].flatMap((a) => a.events.filter((e) => e.type === EventType.SPILLOVER && e.data?.cause === 'withholding'));
        assert.equal(janSpills.length, 2, `expected 2 withholding spillover events, got ${janSpills.length}`);
        const totalSpilled = janSpills.reduce((s, e) => s + Math.abs(e.amount.amount), 0);
        near(totalSpilled, 10000 * 0.1 / 0.9, 'total withholding across Savings + Brokerage', 0.05);
        // Brokerage realized 50% gain on its $811.11 withholding spillover share
        const brokSpillGain = brok.events
            .filter((e) => e.type === EventType.CAPITAL_GAIN_RECOGNIZED && e.data?.spillover === true)
            .reduce((s, e) => s + e.amount.amount, 0);
        near(brokSpillGain, (10000 * 0.1 / 0.9 - 300) * 0.5, 'Brokerage withholding spillover LTCG', 0.5);
    });
}

// ── 5. Post-59½ (age >= 60) retirement failover: IRA → 401K → Roth ───

console.log('\n── 5. Post-59½ retirement failover (everyday → IRA → 401K → Roth last resort) ──\n');

{
    // Age 62: Savings ($2,000), Brokerage ($3,000), IRA ($4,000), 401K ($5,000), Roth ($100,000).
    // Living ($18,000 in Jan 2026) routed to empty Checking ($0):
    //   1. Everyday accounts drain first: Savings ($2,000) + Brokerage ($3,000) = $5,000
    //   2. Tax-deferred retirement next: IRA ($4,000) + 401K ($5,000) = $9,000
    //   3. Roth IRA strictly last resort: $4,000 (+ $1,000 withholding on IRA+401K draws)
    const spec = {
        name: 'retirement-failover-order-age-62',
        settings: { filingAs: 'Single', startAge: 62, retirementAge: 62, finishAge: 63, inflationRate: 0 },
        lifeEvents: [],
        modelAssets: [
            asset({ instrument: Instrument.BANK, displayName: 'Checking', startCurrency: { amount: 0 }, startBasisCurrency: { amount: 0 } }),
            asset({ instrument: Instrument.BANK, displayName: 'Savings', startCurrency: { amount: 2000 }, startBasisCurrency: { amount: 2000 } }),
            asset({ instrument: Instrument.TAXABLE_EQUITY, displayName: 'Brokerage', startCurrency: { amount: 3000 }, startBasisCurrency: { amount: 1500 } }),
            asset({ instrument: Instrument.IRA, displayName: 'IRA', startCurrency: { amount: 4000 }, startBasisCurrency: { amount: 0 } }),
            asset({ instrument: Instrument.FOUR_01K, displayName: '401K', startCurrency: { amount: 5000 }, startBasisCurrency: { amount: 0 } }),
            asset({ instrument: Instrument.ROTH_IRA, displayName: 'Roth', startCurrency: { amount: 100000 }, startBasisCurrency: { amount: 100000 } }),
            asset({
                instrument: Instrument.MONTHLY_EXPENSE, displayName: 'Living',
                startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 1 },
                startCurrency: { amount: -18000 }, startBasisCurrency: { amount: 0 },
                fundTransfers: [{ toDisplayName: 'Checking', monthlyMoveValue: 100, closeMoveValue: 0 }],
            }),
        ],
    };

    const { portfolio: p, issues } = await runPlan(spec);

    await check('at age 62, failover drains Savings → Brokerage → IRA → 401K before touching Roth last', () => {
        assert.equal(planExhaustion(issues), null, 'retirement failover should cover shortfall with zero unfunded');
        const assetBy = (n) => p.modelAssets.find((a) => a.displayName === n);
        const bal = (n) => assetBy(n).finishCurrency.amount;
        const pairedSpill = (n) => assetBy(n).events
            .filter((e) => e.type === EventType.SPILLOVER && e.data?.origin === 'paired')
            .reduce((s, e) => s + Math.abs(e.amount.amount), 0);
        // Exact Jan 2026 expense spillover order: Savings ($2k) → Brokerage ($3k) → IRA ($4k) → 401K ($5k) → Roth ($4k)
        near(pairedSpill('Savings'), 2000, 'Savings paired spillover');
        near(pairedSpill('Brokerage'), 3000, 'Brokerage paired spillover');
        near(pairedSpill('IRA'), 4000, 'IRA paired spillover');
        near(pairedSpill('401K'), 5000, '401K paired spillover');
        near(pairedSpill('Roth'), 4000, 'Roth paired spillover (last resort)');
        near(bal('Savings'), 0, 'Savings drained first');
        near(bal('Brokerage'), 0, 'Brokerage drained second');
        near(bal('IRA'), 0, 'IRA drained third');
        near(bal('401K'), 0, '401K drained fourth');
        // Roth also covered $1,000 withholding + Jan monthly true-up, which annual true-up
        // refunded to Checking (never to Roth/IRA). Total wealth = $114,000 - $18,000 = $96,000.
        near(bal('Checking') + bal('Roth'), 96000, 'exact dollar conservation ($114k - $18k)', 0.1);
        assert.ok(bal('Checking') > 1000, `annual tax refund should land in Checking, got ${bal('Checking')}`);
        near(p.total.tradIRADistribution.amount, 4000, 'total.tradIRADistribution');
        near(p.total.four01KDistribution.amount, 5000, 'total.four01KDistribution');
        assert.ok(p.total.rothIRADistribution.amount >= 5000, `expected Roth distribution >= $5k, got ${p.total.rothIRADistribution.amount}`);
    });

    // Separate check: when IRA alone can cover the shortfall, Roth is completely untouched.
    const spec2 = {
        name: 'ira-before-roth-age-62',
        settings: { filingAs: 'Single', startAge: 62, retirementAge: 62, finishAge: 63, inflationRate: 0 },
        lifeEvents: [],
        modelAssets: [
            asset({ instrument: Instrument.BANK, displayName: 'Savings', startCurrency: { amount: 1000 }, startBasisCurrency: { amount: 1000 } }),
            asset({ instrument: Instrument.IRA, displayName: 'IRA', startCurrency: { amount: 50000 }, startBasisCurrency: { amount: 0 } }),
            asset({ instrument: Instrument.ROTH_IRA, displayName: 'Roth', startCurrency: { amount: 100000 }, startBasisCurrency: { amount: 100000 } }),
            asset({
                instrument: Instrument.MONTHLY_EXPENSE, displayName: 'Living',
                startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 1 },
                startCurrency: { amount: -6000 }, startBasisCurrency: { amount: 0 },
            }),
        ],
    };

    const { portfolio: p2, issues: issues2 } = await runPlan(spec2);

    await check('when IRA has funds after everyday accounts empty, IRA pays and Roth stays untouched', () => {
        assert.equal(planExhaustion(issues2), null);
        const bal = (n) => p2.modelAssets.find((a) => a.displayName === n).finishCurrency.amount;
        // Jan 2026 drains Savings ($1k) + IRA ($5k + $555.56 withholding); Jan 2027 refunds $555.56 to Savings.
        near(bal('Savings'), 5000 * 0.1 / 0.9, 'Savings drained in Jan 2026 and received annual tax refund', 0.1);
        near(bal('IRA'), 50000 - 5000 / 0.9, 'IRA paid $5,000 expense + 10% withholding', 0.1);
        near(bal('Roth'), 100000, 'Roth untouched while IRA has funds');
    });
}

// ── 6. Age < 60 protection: no retirement account drawn before age 60 ─

console.log('\n── 6. Retirement accounts (IRA, 401K, Roth) are protected before age 60 ──\n');

{
    const spec = {
        name: 'retirement-protected-under-60',
        settings: { filingAs: 'Single', startAge: 55, retirementAge: 55, finishAge: 56, inflationRate: 0 },
        lifeEvents: [],
        modelAssets: [
            asset({ instrument: Instrument.BANK, displayName: 'Savings', startCurrency: { amount: 1000 }, startBasisCurrency: { amount: 1000 } }),
            asset({ instrument: Instrument.IRA, displayName: 'IRA', startCurrency: { amount: 150000 }, startBasisCurrency: { amount: 0 } }),
            asset({ instrument: Instrument.FOUR_01K, displayName: '401K', startCurrency: { amount: 150000 }, startBasisCurrency: { amount: 0 } }),
            asset({ instrument: Instrument.ROTH_IRA, displayName: 'Roth', startCurrency: { amount: 200000 }, startBasisCurrency: { amount: 200000 } }),
            asset({
                instrument: Instrument.MONTHLY_EXPENSE, displayName: 'Living',
                startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 1 },
                startCurrency: { amount: -5000 }, startBasisCurrency: { amount: 0 },
            }),
        ],
    };

    const { portfolio: p, issues } = await runPlan(spec);

    await check('at age 55, IRA, 401K, and Roth are NOT used as failover and $4,000 shortfall is unfunded', () => {
        const exh = planExhaustion(issues);
        assert.ok(exh, 'expected exhaustion when everyday accounts empty under age 60');
        near(p.modelAssets.find((a) => a.displayName === 'IRA').finishCurrency.amount, 150000, 'IRA untouched under 60');
        near(p.modelAssets.find((a) => a.displayName === '401K').finishCurrency.amount, 150000, '401K untouched under 60');
        near(p.modelAssets.find((a) => a.displayName === 'Roth').finishCurrency.amount, 200000, 'Roth untouched under 60');
        near(exh.amount, 4000, 'unfunded amount');
    });
}

// ── 7. Tax refunds NEVER deposit into Roth IRA ───────────────────────

console.log('\n── 7. Tax refunds never deposit into Roth IRA ──\n');

{
    // Age 65: Savings starts at $0, Roth has $100,000, Nov-Dec 2026 salary over-withholds
    // so Jan 1, 2027 generates a >$2,000 tax refund. Refund must land in Savings, NOT Roth!
    const spec = {
        name: 'refund-never-enters-roth',
        settings: { filingAs: 'Single', startAge: 65, retirementAge: 66, finishAge: 67, inflationRate: 0 },
        lifeEvents: [],
        modelAssets: [
            asset({
                instrument: Instrument.WORKING_INCOME, displayName: 'Salary',
                startDateInt: { year: 2026, month: 11 }, finishDateInt: { year: 2026, month: 12 },
                startCurrency: { amount: 10000 }, startBasisCurrency: { amount: 0 },
                fundTransfers: [{ toDisplayName: 'Savings', monthlyMoveValue: 100, closeMoveValue: 0 }],
            }),
            asset({
                instrument: Instrument.BANK, displayName: 'Savings',
                startDateInt: { year: 2026, month: 11 }, finishDateInt: { year: 2027, month: 12 },
                startCurrency: { amount: 0 }, startBasisCurrency: { amount: 0 },
            }),
            asset({
                instrument: Instrument.MONTHLY_EXPENSE, displayName: 'DrainSavings',
                startDateInt: { year: 2026, month: 11 }, finishDateInt: { year: 2026, month: 12 },
                startCurrency: { amount: -9000 }, startBasisCurrency: { amount: 0 },
                fundTransfers: [{ toDisplayName: 'Savings', monthlyMoveValue: 100, closeMoveValue: 0 }],
            }),
            asset({
                instrument: Instrument.ROTH_IRA, displayName: 'Roth',
                startDateInt: { year: 2026, month: 11 }, finishDateInt: { year: 2027, month: 12 },
                startCurrency: { amount: 100000 }, startBasisCurrency: { amount: 100000 },
            }),
        ],
    };

    const { portfolio: p } = await runPlan(spec);
    const sav = p.modelAssets.find((a) => a.displayName === 'Savings');
    const roth = p.modelAssets.find((a) => a.displayName === 'Roth');

    await check('annual tax refund deposits into Savings (even when $0), never Roth IRA', () => {
        const rothRefunds = roth.events.filter((e) => e.type === EventType.TAX_TRUE_UP && e.amount.amount > 0);
        assert.equal(rothRefunds.length, 0, 'Roth must never receive a tax refund deposit');
        const savRefund = sav.events.find((e) => e.type === EventType.TAX_TRUE_UP && e.amount.amount > 0);
        assert.ok(savRefund && savRefund.amount.amount > 2000, `expected >$2k refund in Savings, got ${savRefund?.amount.amount}`);
    });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
