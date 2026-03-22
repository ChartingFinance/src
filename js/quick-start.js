/**
 * quick-start.js — Example portfolio for new users
 *
 * All dates are computed dynamically from the global age settings
 * (Current Age, Retirement Age, Finish Age) so the dataset adapts
 * to whatever the user has configured before clicking Quick Start.
 *
 * Fund transfers are owned by life events (phases), not assets.
 */

import { ModelLifeEvent, LifeEvent } from './life-event.js';
import { ModelAsset } from './model-asset.js';
import { global_user_startAge, global_user_retirementAge, global_user_finishAge } from './globals.js';

// ── Date anchors (computed fresh each call) ──────────────────────

function dateAnchors() {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const birthYear = currentYear - global_user_startAge;
    const retireYear = birthYear + global_user_retirementAge;
    const finishYear = birthYear + global_user_finishAge;

    return {
        now:    { year: currentYear, month: currentMonth },
        retire: { year: retireYear, month: 1 },
        finish: { year: finishYear, month: 1 },
        /** now + N years */
        plus(years) { return { year: currentYear + years, month: currentMonth }; },
    };
}

// ── Asset data ───────────────────────────────────────────────────

function buildQuickStartData() {
    const d = dateAnchors();
    const alreadyRetired = global_user_startAge >= global_user_retirementAge;

    return [
        {
            instrument: 'workingIncome',
            displayName: 'Salary',
            startDateInt: alreadyRetired ? d.retire : d.now,
            finishDateInt: d.retire,
            startCurrency: { amount: 6500 },
            annualReturnRate: { rate: 0.025 },
        },
        {
            instrument: 'retirementIncome',
            displayName: 'Social Security',
            startDateInt: alreadyRetired ? d.now : d.retire,
            startCurrency: { amount: 2500 },
            annualReturnRate: { rate: 0.025 },
        },
        {
            instrument: '401K',
            displayName: '401K',
            startDateInt: d.now,
            startCurrency: { amount: 100000 },
            annualReturnRate: { rate: 0.09 },
        },
        {
            instrument: 'rothIRA',
            displayName: 'Roth IRA',
            startDateInt: d.now,
            startCurrency: { amount: 50000 },
            annualReturnRate: { rate: 0.09 },
        },
        {
            instrument: 'taxableEquity',
            displayName: 'Brokerage',
            startDateInt: d.now,
            startCurrency: { amount: 50000 },
            startBasisCurrency: { amount: 25000 },
            annualReturnRate: { rate: 0.09 },
        },
        {
            instrument: 'realEstate',
            displayName: 'Home',
            startDateInt: d.now,
            finishDateInt: d.plus(5),
            startCurrency: { amount: 400000 },
            startBasisCurrency: { amount: 400000 },
            annualReturnRate: { rate: 0.03 },
            annualTaxRate: { rate: 0.012 },
        },
        {
            instrument: 'mortgage',
            displayName: 'Mortgage',
            startDateInt: d.now,
            finishDateInt: d.plus(5),
            startCurrency: { amount: -320000 },
            annualReturnRate: { rate: 0.065 },
            monthsRemaining: 360,
        },
        {
            instrument: 'monthlyExpense',
            displayName: 'Rent',
            startDateInt: d.plus(5),
            startCurrency: { amount: -3000 },
        },
        {
            instrument: 'monthlyExpense',
            displayName: 'Living Expenses',
            startDateInt: d.now,
            startCurrency: { amount: -3000 },
        },
    ];
}

// ── Exports ──────────────────────────────────────────────────────

export function quickStartAssets() {
    return buildQuickStartData().map(raw => ModelAsset.fromJSON(raw));
}

export function quickStartLifeEvents() {
    const alreadyRetired = global_user_startAge >= global_user_retirementAge;

    if (alreadyRetired) {
        const retire = ModelLifeEvent.createDefault(LifeEvent.RETIRE, global_user_startAge);
        retire.phaseTransfers = {
            'Social Security': [
                { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 100, closeMoveValue: 0 },
            ],
            'Home': [
                { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 100, closeMoveValue: 0 },
            ],
            'Mortgage': [
                { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 100, closeMoveValue: 0 },
            ],
            'Living Expenses': [
                { toDisplayName: '401K', frequency: 'monthly', monthlyMoveValue: 75, closeMoveValue: 0 },
                { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 25, closeMoveValue: 0 },
            ],
        };
        return [retire];
    }

    const accumulate = ModelLifeEvent.createDefault(LifeEvent.ACCUMULATE, global_user_startAge);
    accumulate.phaseTransfers = {
        'Salary': [
            { toDisplayName: '401K', frequency: 'monthly', monthlyMoveValue: 5, closeMoveValue: 0 },
            { toDisplayName: 'Roth IRA', frequency: 'monthly', monthlyMoveValue: 2, closeMoveValue: 0 },
            { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 93, closeMoveValue: 0 },
        ],
        'Home': [
            { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 100, closeMoveValue: 0 },
        ],
        'Mortgage': [
            { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 100, closeMoveValue: 0 },
        ],
        'Rent': [
            { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 100, closeMoveValue: 0 },
        ],
        'Living Expenses': [
            { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 100, closeMoveValue: 0 },
        ],
    };

    const retire = ModelLifeEvent.createDefault(LifeEvent.RETIRE, global_user_retirementAge);
    retire.phaseTransfers = {
        'Social Security': [
            { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 100, closeMoveValue: 0 },
        ],
        'Rent': [
            { toDisplayName: 'Roth IRA', frequency: 'monthly', monthlyMoveValue: 30, closeMoveValue: 0 },
            { toDisplayName: '401K', frequency: 'monthly', monthlyMoveValue: 10, closeMoveValue: 0 },
            { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 60, closeMoveValue: 0 },
        ],
        'Living Expenses': [
            { toDisplayName: '401K', frequency: 'monthly', monthlyMoveValue: 40, closeMoveValue: 0 },
            { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 60, closeMoveValue: 0 },
        ],
    };

    return [accumulate, retire];
}
