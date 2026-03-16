/**
 * quick-start.js — Example portfolio for new users
 *
 * Returns an array of ModelAsset instances representing a typical
 * American household portfolio. Edit the raw data below to adjust.
 *
 * Fund transfers are owned by life events (phases), not assets.
 */

import { ModelLifeEvent, LifeEvent } from './life-event.js';
import { ModelAsset } from './model-asset.js';

const QUICK_START_DATA = [
    {
        instrument: 'workingIncome',
        displayName: 'Salary',
        startDateInt: { year: 2026, month: 1 },
        finishDateInt: { year: 2036, month: 12 },
        startCurrency: { amount: 6500 },
        annualReturnRate: { rate: 0.025 },
    },
    {
        instrument: '401K',
        displayName: '401K',
        startDateInt: { year: 2026, month: 1 },
        startCurrency: { amount: 100000 },
        annualReturnRate: { rate: 0.09 },
    },
    {
        instrument: 'rothIRA',
        displayName: 'Roth IRA',
        startDateInt: { year: 2026, month: 1 },
        startCurrency: { amount: 50000 },
        annualReturnRate: { rate: 0.09 },
    },
    {
        instrument: 'taxableEquity',
        displayName: 'Brokerage',
        startDateInt: { year: 2026, month: 1 },
        startCurrency: { amount: 50000 },
        startBasisCurrency: { amount: 25000 },
        annualReturnRate: { rate: 0.09 },
    },
    {
        instrument: 'realEstate',
        displayName: 'Home',
        startDateInt: { year: 2026, month: 1 },
        finishDateInt: { year: 2036, month: 12 },
        startCurrency: { amount: 400000 },
        startBasisCurrency: { amount: 400000 },
        annualReturnRate: { rate: 0.03 },
        annualTaxRate: { rate: 0.012 },
    },
    {
        instrument: 'mortgage',
        displayName: 'Mortgage',
        startDateInt: { year: 2026, month: 1 },
        finishDateInt: { year: 2036, month: 12 },
        startCurrency: { amount: -320000 },
        annualReturnRate: { rate: 0.065 },
        monthsRemaining: 360,
    },
    {
        instrument: 'monthlyExpense',
        displayName: 'Living Expenses',
        startDateInt: { year: 2026, month: 1 },
        startCurrency: { amount: -3000 },
    },
];

export function quickStartAssets() {
    return QUICK_START_DATA.map(raw => ModelAsset.fromJSON(raw));
}

export function quickStartLifeEvents() {
    const accumulate = ModelLifeEvent.createDefault(LifeEvent.ACCUMULATE, 35);
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
        'Living Expenses': [
            { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 100, closeMoveValue: 0 },
        ],
    };

    const retire = ModelLifeEvent.createDefault(LifeEvent.RETIRE, 62);
    retire.phaseTransfers = {
        'Living Expenses': [
            { toDisplayName: '401K', frequency: 'monthly', monthlyMoveValue: 75, closeMoveValue: 0 },
            { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 25, closeMoveValue: 0 },
        ],
    };

    return [accumulate, retire];
}
