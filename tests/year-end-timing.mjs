/**
 * year-end-timing.mjs
 *
 * Regression tests for RED-3 and YEL-2 (year-end settlement folding,
 * balance-sheet net worth filtering, and January 1 timing hazards):
 *
 *   RED-3 #1  Final-year applyYear() settlement (tax true-up, NIIT, PTC) is
 *             folded into portfolio.total, monthlyPackages[last], generatedReports,
 *             asset histories, and mc-compute baseline — never orphaned in
 *             portfolio.monthly after a December-ending plan finishes.
 *   RED-3 #2  Balance-sheet net worth excludes flow instruments (WorkingIncome,
 *             MonthlyExpense, etc.) across Portfolio.monthly.value, monthSummary,
 *             metricAtIndex, planOutcome, Macro charting, Test Bench, and MC.
 *   YEL-2 #1  monthlyCreditBalance resets at month-end (monthlyChron), not in
 *             applyFirstDayOfMonth:
 *               (a) Jan-1 tax refunds retain zero-gain credit balance through Jan.
 *               (b) Dec unspent deposits do NOT leak into Jan-1 applyYear() bills.
 *   YEL-2 #2  Jan-1 applyYear() IRA/401(k) draws (e.g. allocateHouseholdTax) are
 *             excluded from January's payroll ×12 annualization, so January
 *             withholding and 401(k) deferrals are not distorted.
 *   YEL-2 #3  Annual-pass events (TAX_TRUE_UP, NIIT_ASSESSED, PTC_RECONCILIATION)
 *             carry the month they book into: (Y+1)-01 mid-run, Y-12 on the
 *             final year.
 *   YEL-2 #4  applyGuardrails runs AFTER applyYear(), so guardrails see
 *             post-tax-settlement investable assets.
 *
 * Usage:  node tests/year-end-timing.mjs   (from src/)
 */

import assert from 'node:assert/strict';
import './tools/localstorage-polyfill.js';

import { Portfolio } from '../js/portfolio.js';
import { ModelAsset } from '../js/model-asset.js';
import { chronometer_run } from '../js/chronometer.js';
import { Metric } from '../js/metric.js';
import { EventType } from '../js/sim-event.js';
import { Instrument, InstrumentType } from '../js/instruments/instrument.js';
import { planOutcome } from '../js/outcome-summary.js';
import { metricAtIndex, lastHistoryIndex } from '../js/month-summary.js';
import { charting_buildGroupedMetric } from '../js/charting.js';
import { groupSeries } from '../js/test-bench-chart.js';
import { computeMonteCarlo } from '../js/mc-compute.js';
import { runPlan, simConfigFromPlanSpec } from '../js/mcp/run-plan.js';
import { membrane_rawDataToModelAssets } from '../js/membrane.js';

let passed = 0, failed = 0;
async function check(label, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${label}`); }
    catch (err) { failed++; console.log(`  ✗ ${label}\n    ${err.message}`); }
}

const near = (got, want, label, tol = 0.01) =>
    assert.ok(Math.abs(got - want) <= tol, `${label}: got ${got}, want ${want}`);

const asset = (overrides) => ({
    startDateInt: { year: 2026, month: 1 },
    finishDateInt: { year: 2027, month: 12 },
    annualReturnRate: { rate: 0 },
    ...overrides,
});

// ── RED-3 #1: Final-year settlement folded, never orphaned ──────────────

console.log('\n── RED-3 #1: final-year applyYear() settlement is folded ──\n');

{
    // A 2-year December-ending plan with high Brokerage capital gains & underwithheld
    // pension income so 2027 ends with both a large tax true-up bill and NIIT.
    const spec = {
        name: 'red3-final-year-settlement',
        settings: { filingAs: 'Single', startAge: 66, retirementAge: 65, finishAge: 67, inflationRate: 0 },
        lifeEvents: [],
        modelAssets: [
            asset({
                instrument: Instrument.PENSION, displayName: 'Pension',
                startCurrency: { amount: 25000 }, startBasisCurrency: { amount: 0 },
                fundTransfers: [{ toDisplayName: 'Checking', monthlyMoveValue: 100, closeMoveValue: 0 }],
            }),
            asset({
                instrument: Instrument.TAXABLE_EQUITY, displayName: 'Brokerage',
                startCurrency: { amount: 500000 }, startBasisCurrency: { amount: 50000 },
                annualReturnRate: { rate: 0 },
            }),
            asset({
                instrument: Instrument.BANK, displayName: 'Checking',
                startCurrency: { amount: 200000 }, startBasisCurrency: { amount: 200000 },
            }),
            asset({
                instrument: Instrument.MONTHLY_EXPENSE, displayName: 'Living',
                startCurrency: { amount: -10000 }, startBasisCurrency: { amount: 0 },
                fundTransfers: [{ toDisplayName: 'Brokerage', monthlyMoveValue: 100, closeMoveValue: 0 }],
            }),
        ],
    };

    const { portfolio: p, issues } = await runPlan(spec);
    const lastIdx = lastHistoryIndex(p);
    const lastTaxYear = p.taxYears[p.taxYears.length - 1];
    const lastPkg = p.monthlyPackages[lastIdx];

    await check('final year actually produced both a tax true-up bill and NIIT (non-vacuous)', () => {
        assert.equal(lastTaxYear.year, 2027);
        assert.ok(lastTaxYear.settledTrueUp < -1000, `expected bill, got ${lastTaxYear.settledTrueUp}`);
        assert.ok(lastTaxYear.settledNIIT < -100, `expected NIIT, got ${lastTaxYear.settledNIIT}`);
    });

    await check('portfolio.monthly is completely zero after chronometer_run (no orphaned settlement)', () => {
        assert.equal(p.monthly.federalTaxes().amount, 0);
        assert.equal(p.monthly.taxTrueUp.amount, 0);
        assert.equal(p.monthly.niit.amount, 0);
        assert.equal(p.monthly.longTermCapitalGains.amount, 0);
    });

    await check('final monthlyPackage and total include the final year settlement', () => {
        near(lastPkg.taxTrueUp.amount, lastTaxYear.settledTrueUp, 'lastPkg.taxTrueUp');
        near(lastPkg.niit.amount, lastTaxYear.settledNIIT, 'lastPkg.niit');

        const sumTaxYearsFed = p.taxYears.reduce((s, t) => s + t.federalTax, 0);
        near(-p.total.federalTaxes().amount, sumTaxYearsFed, 'total.federalTaxes vs sum(taxYears)', 1);

        const yearlyReportFed = -p.generatedReports
            .filter((r) => r.type === 'yearly')
            .reduce((s, r) => s + r.pkg.federalTaxes().amount, 0);
        near(yearlyReportFed, -p.total.federalTaxes().amount, 'yearly reports vs portfolio.total', 0.01);
    });

    await check('asset VALUE histories, planOutcome, and finishValue() all agree at the final month', () => {
        const historyNetWorth = p.modelAssets
            .filter((a) => InstrumentType.isAsset(a.instrument))
            .reduce((s, a) => s + a.getHistory(Metric.VALUE)[lastIdx], 0);
        near(historyNetWorth, p.finishValue().amount, 'history sum vs finishValue');
        near(lastPkg.value.amount, p.finishValue().amount, 'lastPkg.value vs finishValue');
        near(planOutcome(p, issues).end, p.finishValue().amount, 'planOutcome.end vs finishValue');
    });

    await check('mc-compute baseline flushes the final settlement and matches finishValue()', async () => {
        // Re-run with an explicit accumulate lifeEvent carrying the transfer rules,
        // matching how the app stores transfers for computeMonteCarlo.
        const mcSpec = {
            ...spec,
            lifeEvents: [{
                type: 'accumulate',
                displayName: 'Start',
                triggerAge: 66,
                phaseTransfers: {
                    Pension: [{ toDisplayName: 'Checking', monthlyMoveValue: 100, closeMoveValue: 0 }],
                    Living: [{ toDisplayName: 'Brokerage', monthlyMoveValue: 100, closeMoveValue: 0 }],
                },
            }],
        };
        const { portfolio: pmc } = await runPlan(mcSpec);
        const mc = await computeMonteCarlo(pmc.modelAssets, {
            config: pmc.config,
            numSimulations: 3,
            seed: 1,
            retirementDateInt: null,
            lifeEvents: pmc.lifeEvents,
        });
        const baselineEnd = mc.baselineData[mc.baselineData.length - 1];
        near(baselineEnd, pmc.finishValue().amount, 'mc baseline end vs finishValue', 0.05);
    });
}

// ── RED-3 #2: Balance-sheet net worth excludes flow instruments ────────

console.log('\n── RED-3 #2: net worth excludes flow instruments ──\n');

{
    // Large working income (+$20,000/mo) and expense (-$5,000/mo) create a
    // +$15,000 flow-rate sum that must NEVER pollute balance-sheet net worth.
    const spec = {
        name: 'red3-flow-exclusion',
        settings: { filingAs: 'Single', startAge: 40, retirementAge: 65, finishAge: 42, inflationRate: 0 },
        lifeEvents: [],
        modelAssets: [
            asset({
                instrument: Instrument.WORKING_INCOME, displayName: 'Salary',
                startCurrency: { amount: 20000 }, startBasisCurrency: { amount: 0 },
                fundTransfers: [{ toDisplayName: 'Checking', monthlyMoveValue: 100, closeMoveValue: 0 }],
            }),
            asset({
                instrument: Instrument.BANK, displayName: 'Checking',
                startCurrency: { amount: 100000 }, startBasisCurrency: { amount: 100000 },
            }),
            asset({
                instrument: Instrument.MONTHLY_EXPENSE, displayName: 'Living',
                startCurrency: { amount: -5000 }, startBasisCurrency: { amount: 0 },
                fundTransfers: [{ toDisplayName: 'Checking', monthlyMoveValue: 100, closeMoveValue: 0 }],
            }),
        ],
    };

    const { portfolio: p, issues } = await runPlan(spec);
    const lastIdx = lastHistoryIndex(p);
    const checking = p.modelAssets.find((a) => a.displayName === 'Checking');

    await check('monthlyPackages.value, metricAtIndex, and planOutcome exclude Salary and Living', () => {
        for (let i = 0; i <= lastIdx; i++) {
            near(p.monthlyPackages[i].value.amount, checking.getHistory(Metric.VALUE)[i], `month ${i} pkg.value`);
            near(metricAtIndex(p, Metric.VALUE, i), checking.getHistory(Metric.VALUE)[i], `month ${i} metricAtIndex`);
        }
        near(planOutcome(p, issues).end, p.finishValue().amount, 'planOutcome vs finishValue');
        near(p.finishValue().amount, checking.finishCurrency.amount, 'finishValue is Checking alone');
    });

    await check('Macro charting_buildGroupedMetric and Test Bench groupSeries exclude flow groups on VALUE', () => {
        p.buildChartingDisplayData();
        const macro = charting_buildGroupedMetric(p, Metric.VALUE, new Set());
        const bench = groupSeries(p);
        assert.deepEqual(macro.data.datasets.map((d) => d.label), ['Capital']);
        assert.deepEqual(bench.datasets.map((d) => d.label), ['Capital']);
        const macroLast = macro.data.datasets[0].data[macro.data.datasets[0].data.length - 1];
        const benchLast = bench.total[bench.total.length - 1];
        near(macroLast, p.finishValue().amount, 'macro last bar');
        near(benchLast, planOutcome(p, issues).endReal, 'bench last bar');
    });
}

// ── YEL-2 #1: monthlyCreditBalance across Dec -> Jan boundary ─────────

console.log('\n── YEL-2 #1: monthlyCreditBalance at the Dec → Jan boundary ──\n');

{
    // Direction A: Partial first year (Nov-Dec 2026) over-withholds salary tax ->
    // Jan 1, 2027 refund deposits into a 50%-gain Brokerage. Withdrawing less
    // than the refund in Jan 2027 must realize $0 LTCG.
    const spec = {
        name: 'yel2-refund-credit-balance',
        settings: { filingAs: 'Single', startAge: 50, retirementAge: 65, finishAge: 52, inflationRate: 0 },
        lifeEvents: [],
        modelAssets: [
            asset({
                instrument: Instrument.WORKING_INCOME, displayName: 'Salary',
                startDateInt: { year: 2026, month: 11 }, finishDateInt: { year: 2026, month: 12 },
                startCurrency: { amount: 10000 }, startBasisCurrency: { amount: 0 },
                fundTransfers: [{ toDisplayName: 'Brokerage', monthlyMoveValue: 100, closeMoveValue: 0 }],
            }),
            asset({
                instrument: Instrument.TAXABLE_EQUITY, displayName: 'Brokerage',
                startDateInt: { year: 2026, month: 11 }, finishDateInt: { year: 2027, month: 12 },
                startCurrency: { amount: 100000 }, startBasisCurrency: { amount: 50000 },
            }),
            asset({
                instrument: Instrument.MONTHLY_EXPENSE, displayName: 'JanExpense',
                startDateInt: { year: 2027, month: 1 }, finishDateInt: { year: 2027, month: 1 },
                startCurrency: { amount: -2000 }, startBasisCurrency: { amount: 0 },
                fundTransfers: [{ toDisplayName: 'Brokerage', monthlyMoveValue: 100, closeMoveValue: 0 }],
            }),
        ],
    };

    const { portfolio: p } = await runPlan(spec);
    const brok = p.modelAssets.find((a) => a.displayName === 'Brokerage');

    await check('(a) Jan-1 tax refund retains zero-gain monthlyCreditBalance through January', () => {
        const refund = brok.events.find((e) => e.type === EventType.TAX_TRUE_UP && e.dateInt.year === 2027 && e.dateInt.month === 1);
        assert.ok(refund && refund.amount.amount > 2000, `expected >$2,000 refund on 2027-01, got ${refund?.amount.amount}`);

        const janGains = brok.events
            .filter((e) => e.type === EventType.CAPITAL_GAIN_RECOGNIZED && e.dateInt.year === 2027 && e.dateInt.month === 1)
            .reduce((s, e) => s + e.amount.amount, 0);
        near(janGains, 0, 'Jan 2027 LTCG when spending <= refund', 0.01);
    });
}

{
    // Direction B: Unspent Dec 2026 deposit ($22.5k net pension) into a high-gain
    // Brokerage must NOT leak into Jan 1, 2027 applyYear() tax-bill withdrawal.
    // Living runs Jan-Nov 2026 so Dec 2026 leaves +$22.5k unspent in Brokerage;
    // under the old bug, Jan 1's ~$15k tax bill realized $0 LTCG from that stale
    // December credit balance.
    const spec = {
        name: 'yel2-dec-credit-does-not-leak',
        settings: { filingAs: 'Single', startAge: 66, retirementAge: 65, finishAge: 67, inflationRate: 0 },
        lifeEvents: [],
        modelAssets: [
            asset({
                instrument: Instrument.PENSION, displayName: 'Pension',
                startCurrency: { amount: 25000 }, startBasisCurrency: { amount: 0 },
                fundTransfers: [{ toDisplayName: 'Brokerage', monthlyMoveValue: 100, closeMoveValue: 0 }],
            }),
            asset({
                instrument: Instrument.TAXABLE_EQUITY, displayName: 'Brokerage',
                startCurrency: { amount: 500000 }, startBasisCurrency: { amount: 50000 },
            }),
            asset({
                instrument: Instrument.MONTHLY_EXPENSE, displayName: 'Living2026',
                startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 11 },
                startCurrency: { amount: -30000 }, startBasisCurrency: { amount: 0 },
                fundTransfers: [{ toDisplayName: 'Brokerage', monthlyMoveValue: 100, closeMoveValue: 0 }],
            }),
        ],
    };

    const { portfolio: p } = await runPlan(spec);
    const brok = p.modelAssets.find((a) => a.displayName === 'Brokerage');

    await check('(b) Dec unspent deposits are cleared before Jan-1 applyYear() tax bill sells vested shares', () => {
        const bill = brok.events.find((e) => e.type === EventType.TAX_TRUE_UP && e.dateInt.year === 2027 && e.dateInt.month === 1);
        assert.ok(bill && bill.amount.amount < -5000, `expected >$5k tax bill on 2027-01, got ${bill?.amount.amount}`);
        const janGain = brok.events
            .filter((e) => e.type === EventType.CAPITAL_GAIN_RECOGNIZED && e.dateInt.year === 2027 && e.dateInt.month === 1)
            .reduce((s, e) => s + e.amount.amount, 0);
        // Selling >$5k from a high-gain brokerage must realize LTCG (not $0 from Dec's credit balance).
        assert.ok(janGain > 2000, `expected >$2,000 LTCG on Jan-1 tax bill sale, got ${janGain}`);
    });
}

// ── YEL-2 #2: Jan-1 applyYear() draw does not distort Jan payroll ─────

console.log('\n── YEL-2 #2: Jan-1 applyYear() settlement excluded from Jan payroll ×12 ──\n');

{
    // With allocateHouseholdTax enabled, 2026 produces a large tax true-up bill
    // (from high Brokerage LTCG + IRA draws) allocated proportionally to the
    // IRA on Jan 1, 2027. That Jan-1 IRA distribution must NOT inflate Jan 2027
    // payroll withholding or cut the Jan 2027 401(k) deferral.
    const spec = {
        name: 'yel2-payroll-annualization',
        settings: { filingAs: 'Single', startAge: 62, retirementAge: 65, finishAge: 64, inflationRate: 0 },
        lifeEvents: [],
        modelAssets: [
            asset({
                instrument: Instrument.WORKING_INCOME, displayName: 'Salary',
                startCurrency: { amount: 10000 }, startBasisCurrency: { amount: 0 },
                fundTransfers: [
                    { toDisplayName: '401K', monthlyMoveValue: 15, closeMoveValue: 0 },
                    { toDisplayName: 'Checking', monthlyMoveValue: 85, closeMoveValue: 0 },
                ],
            }),
            asset({
                instrument: Instrument.FOUR_01K, displayName: '401K',
                startCurrency: { amount: 50000 }, startBasisCurrency: { amount: 0 },
            }),
            asset({
                instrument: Instrument.IRA, displayName: 'IRA',
                startCurrency: { amount: 400000 }, startBasisCurrency: { amount: 0 },
            }),
            asset({
                instrument: Instrument.TAXABLE_EQUITY, displayName: 'Brokerage',
                startCurrency: { amount: 500000 }, startBasisCurrency: { amount: 50000 },
            }),
            asset({
                instrument: Instrument.BANK, displayName: 'Checking',
                startCurrency: { amount: 100000 }, startBasisCurrency: { amount: 100000 },
            }),
            asset({
                instrument: Instrument.MONTHLY_EXPENSE, displayName: 'Draw2026',
                startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 12 },
                startCurrency: { amount: -20000 }, startBasisCurrency: { amount: 0 },
                fundTransfers: [
                    { toDisplayName: 'IRA', monthlyMoveValue: 50, closeMoveValue: 0 },
                    { toDisplayName: 'Brokerage', monthlyMoveValue: 50, closeMoveValue: 0 },
                ],
            }),
        ],
    };

    const cfg = { ...simConfigFromPlanSpec(spec), allocateHouseholdTax: true };
    const p = new Portfolio(membrane_rawDataToModelAssets(spec.modelAssets), false, cfg);
    await chronometer_run(p);
    const ira = p.modelAssets.find((a) => a.displayName === 'IRA');
    const salary = p.modelAssets.find((a) => a.displayName === 'Salary');
    const four01k = p.modelAssets.find((a) => a.displayName === '401K');

    await check('Jan 2027 payroll withholding and 401(k) deferral match Feb 2027 despite Jan-1 IRA true-up draw', () => {
        const janIraTrueUp = ira.events
            .filter((e) => e.type === EventType.TAX_TRUE_UP && e.dateInt.year === 2027 && e.dateInt.month === 1)
            .reduce((s, e) => s + e.amount.amount, 0);
        assert.ok(janIraTrueUp < -5000,
            `precondition: expected >$5k IRA true-up draw on 2027-01, got ${janIraTrueUp}`);

        const wh = (month) => salary.events
            .filter((e) => e.type === EventType.INCOME_TAX_WITHHOLDING && e.dateInt.year === 2027 && e.dateInt.month === month)
            .reduce((s, e) => s + Math.abs(e.amount.amount), 0);
        const contrib = (month) => four01k.events
            .filter((e) => e.type === EventType.TRANSFER && e.dateInt.year === 2027 && e.dateInt.month === month)
            .reduce((s, e) => s + e.amount.amount, 0);

        near(wh(1), wh(2), 'Jan vs Feb 2027 salary withholding', 0.01);
        near(contrib(1), contrib(2), 'Jan vs Feb 2027 401K deferral', 0.01);
        near(contrib(1), 1500, 'Jan 2027 401K deferral uncut ($1,500)', 0.01);
    });
}

// ── YEL-2 #3: Annual-pass event timestamps match booked month ─────────

console.log('\n── YEL-2 #3: annual-pass events carry their booked month ──\n');

{
    const spec = {
        name: 'yel2-event-dates',
        settings: { filingAs: 'Single', startAge: 66, retirementAge: 65, finishAge: 67, inflationRate: 0 },
        lifeEvents: [],
        modelAssets: [
            asset({
                instrument: Instrument.PENSION, displayName: 'Pension',
                startCurrency: { amount: 25000 }, startBasisCurrency: { amount: 0 },
                fundTransfers: [{ toDisplayName: 'Checking', monthlyMoveValue: 100, closeMoveValue: 0 }],
            }),
            asset({
                instrument: Instrument.TAXABLE_EQUITY, displayName: 'Brokerage',
                startCurrency: { amount: 500000 }, startBasisCurrency: { amount: 50000 },
            }),
            asset({
                instrument: Instrument.BANK, displayName: 'Checking',
                startCurrency: { amount: 200000 }, startBasisCurrency: { amount: 200000 },
            }),
            asset({
                instrument: Instrument.MONTHLY_EXPENSE, displayName: 'Living',
                startCurrency: { amount: -10000 }, startBasisCurrency: { amount: 0 },
                fundTransfers: [{ toDisplayName: 'Brokerage', monthlyMoveValue: 100, closeMoveValue: 0 }],
            }),
        ],
    };

    const { portfolio: p } = await runPlan(spec);

    await check('mid-run TAX_TRUE_UP and NIIT_ASSESSED carry 2027-01; final-year carry 2027-12', () => {
        const all = p.modelAssets.flatMap((a) => a.events);
        const trueUps = all.filter((e) => e.type === EventType.TAX_TRUE_UP);
        const niits = all.filter((e) => e.type === EventType.NIIT_ASSESSED);
        assert.deepEqual(trueUps.map((e) => e.dateInt.toString()), ['2027-01', '2027-12']);
        assert.deepEqual(niits.map((e) => e.dateInt.toString()), ['2027-01', '2027-12']);
    });
}

// ── YEL-2 #4: applyGuardrails sees post-applyYear() investable assets ─

console.log('\n── YEL-2 #4: applyGuardrails runs after applyYear() ──\n');

{
    // A retired plan with a big tax true-up + NIIT bill on Jan 1, 2027
    // ($20,304 from Pension + Brokerage LTCG). With guardrails enabled,
    // 2027's yearlySnapshot.investableAssets must reflect the balance AFTER
    // Jan 1's applyYear() tax bill was deducted.
    const spec = {
        name: 'yel2-guardrails-after-applyyear',
        settings: { filingAs: 'Single', startAge: 66, retirementAge: 65, finishAge: 68, inflationRate: 0 },
        lifeEvents: [],
        modelAssets: [
            asset({
                instrument: Instrument.PENSION, displayName: 'Pension',
                finishDateInt: { year: 2028, month: 12 },
                startCurrency: { amount: 25000 }, startBasisCurrency: { amount: 0 },
                fundTransfers: [{ toDisplayName: 'Checking', monthlyMoveValue: 100, closeMoveValue: 0 }],
            }),
            asset({
                instrument: Instrument.TAXABLE_EQUITY, displayName: 'Brokerage',
                finishDateInt: { year: 2028, month: 12 },
                startCurrency: { amount: 500000 }, startBasisCurrency: { amount: 50000 },
            }),
            asset({
                instrument: Instrument.BANK, displayName: 'Checking',
                finishDateInt: { year: 2028, month: 12 },
                startCurrency: { amount: 200000 }, startBasisCurrency: { amount: 200000 },
            }),
            asset({
                instrument: Instrument.MONTHLY_EXPENSE, displayName: 'Living',
                finishDateInt: { year: 2028, month: 12 },
                startCurrency: { amount: -10000 }, startBasisCurrency: { amount: 0 },
                fundTransfers: [{ toDisplayName: 'Brokerage', monthlyMoveValue: 100, closeMoveValue: 0 }],
            }),
        ],
    };

    const cfg = simConfigFromPlanSpec(spec);
    const p = new Portfolio(membrane_rawDataToModelAssets(spec.modelAssets), false, cfg);
    p.guardrailsParams = {
        initialRate: 0.05,
        preservationThreshold: 0.20,
        prosperityThreshold: 0.20,
        adjustmentSize: 0.10,
    };
    await chronometer_run(p);
    const checking = p.modelAssets.find((a) => a.displayName === 'Checking');
    const brok = p.modelAssets.find((a) => a.displayName === 'Brokerage');

    await check('2027-01 yearlySnapshot.investableAssets reflects post-applyYear() tax deduction', () => {
        const dec2026Investable = checking.getHistory(Metric.VALUE)[11] + brok.getHistory(Metric.VALUE)[11];
        const jan2027TaxSettlement = checking.events
            .filter((e) => (e.type === EventType.TAX_TRUE_UP || e.type === EventType.NIIT_ASSESSED)
                && e.dateInt.year === 2027 && e.dateInt.month === 1)
            .reduce((s, e) => s + e.amount.amount, 0);
        assert.ok(jan2027TaxSettlement < -15000,
            `precondition: expected >$15k bill on 2027-01, got ${jan2027TaxSettlement}`);

        // Snapshots record the year just completed (2026) at Jan 1, 2027.
        const snap2026 = p.yearlySnapshots.find((s) => s.year === 2026);
        assert.ok(snap2026, 'missing 2026 yearlySnapshot');
        near(snap2026.investableAssets, dec2026Investable + jan2027TaxSettlement,
            'snap2026.investableAssets vs post-applyYear balance', 0.05);
    });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
