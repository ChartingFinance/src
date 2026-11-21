/**
 * backstop-failover.mjs
 *
 * Regression tests for multi-hop backstop spillover and last-resort post-59½
 * (age >= 60) Roth IRA failover:
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
 *   5. Last-resort Roth IRA failover at age >= 60: only drawn AFTER all
 *      everyday backstop accounts reach $0; books ROTH_IRA_DISTRIBUTION, adds
 *      zero taxable income, and never implicitly draws 401K/IRA.
 *   6. Age < 60 protection: Roth IRA is NOT drawn by failover before age 60.
 *   7. Deposits / tax refunds NEVER land in Roth IRA (resolveDeposit stays
 *      strictly everyday accounts).
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

// ── 5. Post-59½ (age >= 60) Roth IRA last-resort failover ────────────

console.log('\n── 5. Last-resort Roth IRA failover at age >= 60 ──\n');

{
    // Age 62: Savings ($2,000), Brokerage ($3,000), 401K ($500,000), Roth ($100,000).
    // Living ($10,000 in Jan 2026) routed to empty IRA ($0):
    //   - Drains Savings ($2,000) and Brokerage ($3,000) FIRST
    //   - Then draws $5,000 from Roth IRA as last resort
    //   - NEVER touches 401K!
    const spec = {
        name: 'roth-last-resort-age-62',
        settings: { filingAs: 'Single', startAge: 62, retirementAge: 62, finishAge: 63, inflationRate: 0 },
        lifeEvents: [],
        modelAssets: [
            asset({ instrument: Instrument.BANK, displayName: 'Savings', startCurrency: { amount: 2000 }, startBasisCurrency: { amount: 2000 } }),
            asset({ instrument: Instrument.TAXABLE_EQUITY, displayName: 'Brokerage', startCurrency: { amount: 3000 }, startBasisCurrency: { amount: 1500 } }),
            asset({ instrument: Instrument.IRA, displayName: 'IRA', startCurrency: { amount: 0 }, startBasisCurrency: { amount: 0 } }),
            asset({ instrument: Instrument.FOUR_01K, displayName: '401K', startCurrency: { amount: 500000 }, startBasisCurrency: { amount: 0 } }),
            asset({ instrument: Instrument.ROTH_IRA, displayName: 'Roth', startCurrency: { amount: 100000 }, startBasisCurrency: { amount: 100000 } }),
            asset({
                instrument: Instrument.MONTHLY_EXPENSE, displayName: 'Living',
                startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 1 },
                startCurrency: { amount: -10000 }, startBasisCurrency: { amount: 0 },
                fundTransfers: [{ toDisplayName: 'IRA', monthlyMoveValue: 100, closeMoveValue: 0 }],
            }),
        ],
    };

    const { portfolio: p, issues } = await runPlan(spec);

    await check('at age 62, everyday accounts drain first, Roth covers remaining $5,000 tax-free, 401K untouched', () => {
        assert.equal(planExhaustion(issues), null, 'Roth should cover shortfall with zero unfunded');
        const bal = (n) => p.modelAssets.find((a) => a.displayName === n).finishCurrency.amount;
        near(bal('Savings'), 0, 'Savings drained first');
        near(bal('Brokerage'), 0, 'Brokerage drained second');
        near(bal('Roth'), 95000, 'Roth drew exactly $5,000 as last resort');
        near(bal('401K'), 500000, '401K never implicitly drawn');
        near(p.total.rothIRADistribution.amount, 5000, 'total.rothIRADistribution');
        near(p.taxYears[0].federalTax, 0, 'Roth failover adds zero federal tax');
    });
}

// ── 6. Age < 60 protection: Roth IRA is NOT drawn before age 60 ──────

console.log('\n── 6. Roth IRA is protected before age 60 ──\n');

{
    const spec = {
        name: 'roth-protected-under-60',
        settings: { filingAs: 'Single', startAge: 55, retirementAge: 55, finishAge: 56, inflationRate: 0 },
        lifeEvents: [],
        modelAssets: [
            asset({ instrument: Instrument.BANK, displayName: 'Savings', startCurrency: { amount: 1000 }, startBasisCurrency: { amount: 1000 } }),
            asset({ instrument: Instrument.ROTH_IRA, displayName: 'Roth', startCurrency: { amount: 200000 }, startBasisCurrency: { amount: 200000 } }),
            asset({
                instrument: Instrument.MONTHLY_EXPENSE, displayName: 'Living',
                startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 1 },
                startCurrency: { amount: -5000 }, startBasisCurrency: { amount: 0 },
            }),
        ],
    };

    const { portfolio: p, issues } = await runPlan(spec);

    await check('at age 55, Roth is NOT used as failover and $4,000 shortfall is reported unfunded', () => {
        const exh = planExhaustion(issues);
        assert.ok(exh, 'expected exhaustion when everyday accounts empty under age 60');
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
