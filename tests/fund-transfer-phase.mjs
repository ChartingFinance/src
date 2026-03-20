/**
 * fund-transfer-phase.mjs
 *
 * Tests fund transfers across a phase transition (Accumulate → Retire).
 *
 * Scenario:
 *   - Accumulate phase (Jan–Jun 2026): Salary ($10K/mo), 20% net → 401K.
 *     Expenses ($3K/mo) funded by remaining net income.
 *   - Retire event (Jul 2026): closes Salary.
 *   - Retire phase (Jul–Dec 2026): No income. Expenses pull from Brokerage
 *     via implicit shortfall/gross-up.
 *
 * Validates:
 *   1. Income flowed during accumulate
 *   2. 401K received contributions
 *   3. Salary closed at retirement
 *   4. Brokerage debited after retirement (shortfall withdrawals)
 *   5. Expense asset stayed active through both phases
 *
 * Run: node tests/fund-transfer-phase.mjs
 */

import { Portfolio } from '../js/portfolio.js';
import { ModelAsset } from '../js/model-asset.js';
import { FundTransfer, Frequency } from '../js/fund-transfer.js';
import { Instrument } from '../js/instruments/instrument.js';
import { Currency } from '../js/utils/currency.js';
import { DateInt } from '../js/utils/date-int.js';
import { ARR } from '../js/utils/arr.js';
import { Metric } from '../js/metric.js';
import { TaxTable } from '../js/taxes.js';
import { setActiveTaxTable } from '../js/globals.js';
import { chronometer_run } from '../js/chronometer.js';
import { ModelLifeEvent, LifeEvent } from '../js/life-event.js';

// ── Setup ────────────────────────────────────────────────────────────

setActiveTaxTable(new TaxTable());

let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        passed++;
        console.log(`  PASS  ${label}`);
    } else {
        failed++;
        console.error(`  FAIL  ${label}`);
    }
}

// ── Build assets ─────────────────────────────────────────────────────

const salary = new ModelAsset({
    instrument: Instrument.WORKING_INCOME,
    displayName: 'Salary',
    startDateInt: DateInt.parse('2026-01'),
    finishDateInt: DateInt.parse('2027-12'),
    startCurrency: new Currency(10000),
    annualReturnRate: new ARR(0),
});

const four01k = new ModelAsset({
    instrument: Instrument.FOUR_01K,
    displayName: '401K',
    startDateInt: DateInt.parse('2026-01'),
    finishDateInt: DateInt.parse('2027-12'),
    startCurrency: new Currency(200000),
    annualReturnRate: new ARR(0),  // zero growth to isolate contribution flow
});

const brokerage = new ModelAsset({
    instrument: Instrument.TAXABLE_EQUITY,
    displayName: 'Brokerage',
    startDateInt: DateInt.parse('2026-01'),
    finishDateInt: DateInt.parse('2027-12'),
    startCurrency: new Currency(500000),
    startBasisCurrency: new Currency(300000),
    annualReturnRate: new ARR(0),  // zero growth to isolate withdrawal flow
});

const expenses = new ModelAsset({
    instrument: Instrument.MONTHLY_EXPENSE,
    displayName: 'Living',
    startDateInt: DateInt.parse('2026-01'),
    finishDateInt: DateInt.parse('2027-12'),
    startCurrency: new Currency(-3000),
    annualReturnRate: new ARR(0),
});

// Accumulate phase: 20% of net income → 401K
salary.fundTransfers = [
    new FundTransfer('401K', Frequency.MONTHLY, 20, 0),
];

// ── Build life events ────────────────────────────────────────────────

const accumulate = new ModelLifeEvent({
    type: LifeEvent.ACCUMULATE,
    displayName: 'Accumulate',
    triggerAge: 57,
    closes: [],
    phaseTransfers: {},
});

const retire = new ModelLifeEvent({
    type: LifeEvent.RETIRE,
    displayName: 'Retire',
    triggerAge: 57,     // overridden below
    closes: ['Salary'],
    phaseTransfers: {},
});

// Override triggerDateInt to fire at July 2026
Object.defineProperty(retire, 'triggerDateInt', {
    get() { return DateInt.parse('2026-07'); }
});

// ── Build portfolio and run ──────────────────────────────────────────

const portfolio = new Portfolio([salary, four01k, brokerage, expenses], false);
portfolio.lifeEvents = [accumulate, retire];
portfolio.firstDateInt = DateInt.parse('2026-01');
portfolio.lastDateInt = DateInt.parse('2026-12');

await chronometer_run(portfolio);

// ── Assertions ───────────────────────────────────────────────────────

const totalMonths = brokerage.getHistory(Metric.VALUE).length;
const retireMonthIdx = 6; // July = index 6

console.log(`\n  Fund Transfer Phase Transition Test (${totalMonths} months)\n`);

// 1. Salary earned income during accumulate months (Jan-Jun)
const salaryIncomeM1 = salary.getHistory(Metric.INCOME)?.[0];
assert(salaryIncomeM1 > 0,
    `1. Salary earned income in month 1: $${salaryIncomeM1?.toFixed?.(2) ?? salaryIncomeM1}`);

// 2. 401K received contributions during accumulate phase (tracked on destination 401K asset)
const four01kContribM1 = four01k.getHistory(Metric.FOUR_01K_CONTRIBUTION)?.[0];
assert(four01kContribM1 != null && four01kContribM1 > 0,
    `2. 401K contribution from salary in month 1: $${four01kContribM1?.toFixed?.(2) ?? four01kContribM1}`);

// 3. 401K value grew from contributions (zero return rate, so growth = contributions only)
const four01kValueStart = four01k.getHistory(Metric.VALUE)?.[0];
assert(four01kValueStart > 200000,
    `3. 401K value grew via contributions: $${four01kValueStart?.toFixed?.(2)}`);

// 4. Salary is closed after retirement
assert(salary.isClosed,
    '4. Salary is closed after retirement');

// 5. Salary income is zero after retirement (month 7+)
const salaryIncomeM7 = salary.getHistory(Metric.INCOME)?.[retireMonthIdx];
assert(salaryIncomeM7 == null || salaryIncomeM7 === 0,
    `5. Salary income is zero after retirement: $${salaryIncomeM7 ?? 0}`);

// 6. Brokerage was debited during retire phase (expenses pull via shortfall)
const brokerageValuePreRetire = brokerage.getHistory(Metric.VALUE)?.[retireMonthIdx - 1];
const brokerageValueEnd = brokerage.getHistory(Metric.VALUE)?.[totalMonths - 1];
assert(brokerageValueEnd < brokerageValuePreRetire,
    `6. Brokerage debited after retirement: $${brokerageValuePreRetire?.toFixed?.(2)} → $${brokerageValueEnd?.toFixed?.(2)}`);

// 7. Expenses ran through both phases
const expenseM1 = expenses.getHistory(Metric.VALUE)?.[0];
const expenseEnd = expenses.getHistory(Metric.VALUE)?.[totalMonths - 1];
assert(expenseM1 != null && expenseEnd != null,
    `7. Expense asset active in both phases: month 1 = $${expenseM1?.toFixed?.(2)}, month 12 = $${expenseEnd?.toFixed?.(2)}`);

// 8. Monthly packages recorded for double-entry testing
assert(portfolio.monthlyPackages.length === totalMonths,
    `8. Monthly packages recorded: ${portfolio.monthlyPackages.length} of ${totalMonths}`);

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);