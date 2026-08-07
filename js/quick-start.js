/**
 * quick-start.js — Demographic Quick Start portfolios for new users
 *
 * Four profiles targeting different life stages:
 *   - Early Career (30-40): Accumulation-heavy, long runway to retirement
 *   - Mid Career (40-50): Balanced accumulation and retirement planning
 *   - Pre-Retirement (50-60): Lighter accumulation, focus on retirement readiness
 *   - Retired (60+): Already retired, living off investments + Social Security
 *
 * All dates are computed dynamically from the profile's age settings.
 * Fund transfers are owned by life events (phases), not assets.
 */

import { ModelLifeEvent, LifeEvent } from './life-event.js';
import { ModelAsset } from './model-asset.js';

// ── Date anchors (computed from explicit ages) ──────────────

function dateAnchors(startAge, retirementAge, finishAge) {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const birthYear = currentYear - startAge;
    const retireYear = birthYear + retirementAge;
    const finishYear = birthYear + finishAge;

    return {
        now:    { year: currentYear, month: currentMonth },
        retire: { year: retireYear, month: 1 },
        finish: { year: finishYear, month: 1 },
        /** now + N years */
        plus(years) { return { year: currentYear + years, month: currentMonth }; },
    };
}

// ── Transfer shorthand ──────────────────────────────────────

const xfer = (to, monthly, close = 0) => ({
    toDisplayName: to, monthlyMoveValue: monthly, closeMoveValue: close,
});

// ══════════════════════════════════════════════════════════════
// Profile: Early Career (30-40)
// ══════════════════════════════════════════════════════════════

const EARLY_CAREER = {
    key:   'earlyCareer',
    label: 'Early Career',
    ages:  '30\u201340',
    tagline: 'Long runway to retirement with aggressive saving',
    emoji: '\uD83D\uDE80',
    filingAs: 'Single',
    startAge: 35, retirementAge: 67, finishAge: 90,

    assets(d) {
        return [
            { instrument: 'workingIncome', displayName: 'Salary',
              startDateInt: d.now, finishDateInt: d.retire,
              startCurrency: { amount: 5500 }, annualReturnRate: { rate: 0.03 } },
            { instrument: 'retirementIncome', displayName: 'Social Security',
              startDateInt: d.retire,
              startCurrency: { amount: 2200 }, annualReturnRate: { rate: 0.025 } },
            { instrument: '401K', displayName: '401K',
              startDateInt: d.now,
              startCurrency: { amount: 45000 }, annualReturnRate: { rate: 0.085 } },
            { instrument: 'rothIRA', displayName: 'Roth IRA',
              startDateInt: d.now,
              startCurrency: { amount: 15000 }, annualReturnRate: { rate: 0.085 } },
            { instrument: 'taxableEquity', displayName: 'Brokerage',
              startDateInt: d.now,
              startCurrency: { amount: 20000 }, startBasisCurrency: { amount: 12000 },
              annualReturnRate: { rate: 0.085 } },
            { instrument: 'realEstate', displayName: 'Home',
              startDateInt: d.now, finishDateInt: d.plus(25),
              startCurrency: { amount: 350000 }, startBasisCurrency: { amount: 350000 },
              annualReturnRate: { rate: 0.03 }, annualTaxRate: { rate: 0.012 } },
            { instrument: 'mortgage', displayName: 'Mortgage',
              startDateInt: d.now, finishDateInt: d.plus(25),
              startCurrency: { amount: -280000 }, annualReturnRate: { rate: 0.065 },
              monthsRemaining: 300 },
            { instrument: 'monthlyExpense', displayName: 'Rent',
              startDateInt: d.plus(25),
              startCurrency: { amount: -2500 } },
            { instrument: 'monthlyExpense', displayName: 'Living Expenses',
              startDateInt: d.now,
              startCurrency: { amount: -2500 } },
        ];
    },

    lifeEvents(ages) {
        const acc = ModelLifeEvent.createDefault(LifeEvent.ACCUMULATE, ages.startAge);
        acc.phaseTransfers = {
            'Salary': [xfer('401K', 8), xfer('Roth IRA', 4), xfer('Brokerage', 88)],
            'Home': [xfer('Brokerage', 100)],
            'Mortgage': [xfer('Brokerage', 100)],
            'Rent': [xfer('Brokerage', 100)],
            'Living Expenses': [xfer('Brokerage', 100)],
        };
        const ret = ModelLifeEvent.createDefault(LifeEvent.RETIRE, ages.retirementAge);
        ret.phaseTransfers = {
            'Social Security': [xfer('Brokerage', 100)],
            'Rent': [xfer('Brokerage', 100)],
            'Living Expenses': [xfer('Brokerage', 60), xfer('401K', 40)],
        };
        return [acc, ret];
    },
};

// ══════════════════════════════════════════════════════════════
// Profile: Mid Career (40-50)  — the original Quick Start
// ══════════════════════════════════════════════════════════════

const MID_CAREER = {
    key:   'midCareer',
    label: 'Mid Career',
    ages:  '40\u201350',
    tagline: 'Balanced saving with retirement on the horizon',
    emoji: '\u2696\uFE0F',
    filingAs: 'Single',
    startAge: 45, retirementAge: 67, finishAge: 90,

    assets(d) {
        return [
            { instrument: 'workingIncome', displayName: 'Salary',
              startDateInt: d.now, finishDateInt: d.retire,
              startCurrency: { amount: 6500 }, annualReturnRate: { rate: 0.025 } },
            { instrument: 'retirementIncome', displayName: 'Social Security',
              startDateInt: d.retire,
              startCurrency: { amount: 2500 }, annualReturnRate: { rate: 0.025 } },
            { instrument: '401K', displayName: '401K',
              startDateInt: d.now,
              startCurrency: { amount: 100000 }, annualReturnRate: { rate: 0.085 } },
            { instrument: 'rothIRA', displayName: 'Roth IRA',
              startDateInt: d.now,
              startCurrency: { amount: 50000 }, annualReturnRate: { rate: 0.085 } },
            { instrument: 'taxableEquity', displayName: 'Brokerage',
              startDateInt: d.now,
              startCurrency: { amount: 50000 }, startBasisCurrency: { amount: 25000 },
              annualReturnRate: { rate: 0.085 } },
            { instrument: 'realEstate', displayName: 'Home',
              startDateInt: d.now, finishDateInt: d.plus(10),
              startCurrency: { amount: 400000 }, startBasisCurrency: { amount: 400000 },
              annualReturnRate: { rate: 0.03 }, annualTaxRate: { rate: 0.012 } },
            { instrument: 'mortgage', displayName: 'Mortgage',
              startDateInt: d.now, finishDateInt: d.plus(10),
              startCurrency: { amount: -320000 }, annualReturnRate: { rate: 0.065 },
              monthsRemaining: 360 },
            { instrument: 'monthlyExpense', displayName: 'Rent',
              startDateInt: d.plus(10),
              startCurrency: { amount: -3000 } },
            { instrument: 'monthlyExpense', displayName: 'Living Expenses',
              startDateInt: d.now,
              startCurrency: { amount: -3000 } },
        ];
    },

    lifeEvents(ages) {
        const acc = ModelLifeEvent.createDefault(LifeEvent.ACCUMULATE, ages.startAge);
        acc.phaseTransfers = {
            'Salary': [xfer('401K', 5), xfer('Roth IRA', 2), xfer('Brokerage', 93)],
            'Home': [xfer('Brokerage', 100)],
            'Mortgage': [xfer('Brokerage', 100)],
            'Rent': [xfer('Brokerage', 100)],
            'Living Expenses': [xfer('Brokerage', 100)],
        };
        const ret = ModelLifeEvent.createDefault(LifeEvent.RETIRE, ages.retirementAge);
        ret.phaseTransfers = {
            'Social Security': [xfer('Brokerage', 100)],
            'Rent': [xfer('Roth IRA', 30), xfer('401K', 10), xfer('Brokerage', 60)],
            'Living Expenses': [xfer('401K', 40), xfer('Brokerage', 60)],
        };
        return [acc, ret];
    },
};

// ══════════════════════════════════════════════════════════════
// Profile: Pre-Retirement (50-60)
// ══════════════════════════════════════════════════════════════

const PRE_RETIREMENT = {
    key:   'preRetirement',
    label: 'Pre-Retirement',
    ages:  '50\u201360',
    tagline: 'Retirement is close \u2014 assess how your assets are performing',
    emoji: '\uD83C\uDFAF',
    filingAs: 'Single',
    startAge: 55, retirementAge: 65, finishAge: 90,

    assets(d) {
        return [
            { instrument: 'workingIncome', displayName: 'Salary',
              startDateInt: d.now, finishDateInt: d.retire,
              startCurrency: { amount: 7500 }, annualReturnRate: { rate: 0.02 } },
            { instrument: 'retirementIncome', displayName: 'Social Security',
              startDateInt: d.retire,
              startCurrency: { amount: 2800 }, annualReturnRate: { rate: 0.025 } },
            { instrument: '401K', displayName: '401K',
              startDateInt: d.now,
              startCurrency: { amount: 350000 }, annualReturnRate: { rate: 0.085 } },
            { instrument: 'ira', displayName: 'IRA',
              startDateInt: d.now,
              startCurrency: { amount: 120000 }, annualReturnRate: { rate: 0.085 } },
            { instrument: 'rothIRA', displayName: 'Roth IRA',
              startDateInt: d.now,
              startCurrency: { amount: 80000 }, annualReturnRate: { rate: 0.085 } },
            { instrument: 'taxableEquity', displayName: 'Brokerage',
              startDateInt: d.now,
              startCurrency: { amount: 100000 }, startBasisCurrency: { amount: 55000 },
              annualReturnRate: { rate: 0.085 } },
            { instrument: 'monthlyExpense', displayName: 'Living Expenses',
              startDateInt: d.now,
              startCurrency: { amount: -4000 } },
        ];
    },

    lifeEvents(ages) {
        const acc = ModelLifeEvent.createDefault(LifeEvent.ACCUMULATE, ages.startAge);
        acc.phaseTransfers = {
            'Salary': [xfer('401K', 10), xfer('Roth IRA', 3), xfer('Brokerage', 87)],
            'Living Expenses': [xfer('Brokerage', 100)],
        };
        const ret = ModelLifeEvent.createDefault(LifeEvent.RETIRE, ages.retirementAge);
        ret.phaseTransfers = {
            'Social Security': [xfer('Brokerage', 100)],
            'Living Expenses': [xfer('Brokerage', 50), xfer('401K', 30), xfer('Roth IRA', 20)],
        };
        return [acc, ret];
    },
};

// ══════════════════════════════════════════════════════════════
// Profile: Retired (60+)
// ══════════════════════════════════════════════════════════════

const RETIRED = {
    key:   'retired',
    label: 'Retired',
    ages:  '60+',
    tagline: 'Already retired \u2014 living off investments + Social Security',
    emoji: '\uD83C\uDF34',
    filingAs: 'Single',
    startAge: 67, retirementAge: 67, finishAge: 92,

    assets(d) {
        return [
            { instrument: 'retirementIncome', displayName: 'Social Security',
              startDateInt: d.now,
              startCurrency: { amount: 3000 }, annualReturnRate: { rate: 0.025 } },
            { instrument: 'pension', displayName: 'FERS Pension',
              startDateInt: d.now,
              startCurrency: { amount: 2200 }, annualReturnRate: { rate: 0.02 } },
            { instrument: '401K', displayName: '401K',
              startDateInt: d.now,
              startCurrency: { amount: 500000 }, annualReturnRate: { rate: 0.085 } },
            { instrument: 'ira', displayName: 'IRA',
              startDateInt: d.now,
              startCurrency: { amount: 200000 }, annualReturnRate: { rate: 0.085 } },
            { instrument: 'rothIRA', displayName: 'Roth IRA',
              startDateInt: d.now,
              startCurrency: { amount: 150000 }, annualReturnRate: { rate: 0.085 } },
            { instrument: 'taxableEquity', displayName: 'Brokerage',
              startDateInt: d.now,
              startCurrency: { amount: 200000 }, startBasisCurrency: { amount: 90000 },
              annualReturnRate: { rate: 0.085 } },
            { instrument: 'monthlyExpense', displayName: 'Living Expenses',
              startDateInt: d.now,
              startCurrency: { amount: -4500 } },
        ];
    },

    lifeEvents(ages) {
        const ret = ModelLifeEvent.createDefault(LifeEvent.RETIRE, ages.startAge);
        ret.phaseTransfers = {
            'Social Security': [xfer('Brokerage', 100)],
            'FERS Pension': [xfer('Brokerage', 100)],
            'Living Expenses': [xfer('Brokerage', 50), xfer('401K', 30), xfer('Roth IRA', 20)],
        };
        return [ret];
    },
};

// ══════════════════════════════════════════════════════════════
// Registry + exports
// ══════════════════════════════════════════════════════════════

/** Ordered list of all Quick Start profiles */
// ══════════════════════════════
// Profile: Dual Income Couple (40-50), filing jointly
//
// The first profile that is not one person. Two salaries, two 401(k)s and two
// Social Security benefits, filing jointly — the most common real household
// shape, and the only shipped profile that exercises MFJ at all.
//
// Incomes are deliberately ordinary. The extreme case, where both earners clear
// the Social Security wage base and the engine's single shared accumulator stops
// withholding early, belongs to the adversarial fixture mfj-two-earners; a
// shipped profile should look like a household someone recognises.
// ══════════════════════════════

const DUAL_INCOME = {
    key:   'dualIncome',
    label: 'Dual Income Couple',
    ages:  '40–50',
    tagline: 'Two incomes and two 401(k)s, filing jointly',
    emoji: '👫',
    filingAs: 'MFJ',
    startAge: 45, retirementAge: 67, finishAge: 90,

    assets(d) {
        return [
            { instrument: 'workingIncome', displayName: 'Salary A',
              startDateInt: d.now, finishDateInt: d.retire,
              startCurrency: { amount: 8000 }, annualReturnRate: { rate: 0.025 } },
            { instrument: 'workingIncome', displayName: 'Salary B',
              startDateInt: d.now, finishDateInt: d.retire,
              startCurrency: { amount: 6500 }, annualReturnRate: { rate: 0.025 } },
            { instrument: 'retirementIncome', displayName: 'Social Security A',
              startDateInt: d.retire,
              startCurrency: { amount: 2800 }, annualReturnRate: { rate: 0.025 } },
            { instrument: 'retirementIncome', displayName: 'Social Security B',
              startDateInt: d.retire,
              startCurrency: { amount: 2200 }, annualReturnRate: { rate: 0.025 } },
            { instrument: '401K', displayName: '401K A',
              startDateInt: d.now,
              startCurrency: { amount: 180000 }, annualReturnRate: { rate: 0.085 } },
            { instrument: '401K', displayName: '401K B',
              startDateInt: d.now,
              startCurrency: { amount: 120000 }, annualReturnRate: { rate: 0.085 } },
            { instrument: 'rothIRA', displayName: 'Roth IRA',
              startDateInt: d.now,
              startCurrency: { amount: 60000 }, annualReturnRate: { rate: 0.085 } },
            { instrument: 'taxableEquity', displayName: 'Brokerage',
              startDateInt: d.now,
              startCurrency: { amount: 80000 }, startBasisCurrency: { amount: 50000 },
              annualReturnRate: { rate: 0.085 } },
            { instrument: 'realEstate', displayName: 'Home',
              startDateInt: d.now,
              startCurrency: { amount: 550000 }, startBasisCurrency: { amount: 550000 },
              annualReturnRate: { rate: 0.03 }, annualTaxRate: { rate: 0.012 } },
            { instrument: 'mortgage', displayName: 'Mortgage',
              startDateInt: d.now,
              startCurrency: { amount: -380000 }, annualReturnRate: { rate: 0.062 },
              monthsRemaining: 300 },
            { instrument: 'monthlyExpense', displayName: 'Living Expenses',
              startDateInt: d.now,
              startCurrency: { amount: -4500 } },
        ];
    },

    lifeEvents(ages) {
        const acc = ModelLifeEvent.createDefault(LifeEvent.ACCUMULATE, ages.startAge);
        acc.phaseTransfers = {
            'Salary A': [xfer('401K A', 6), xfer('Roth IRA', 2), xfer('Brokerage', 92)],
            'Salary B': [xfer('401K B', 6), xfer('Brokerage', 94)],
            'Home': [xfer('Brokerage', 100)],
            'Mortgage': [xfer('Brokerage', 100)],
            'Living Expenses': [xfer('Brokerage', 100)],
        };
        const ret = ModelLifeEvent.createDefault(LifeEvent.RETIRE, ages.retirementAge);
        ret.phaseTransfers = {
            'Social Security A': [xfer('Brokerage', 100)],
            'Social Security B': [xfer('Brokerage', 100)],
            'Home': [xfer('Brokerage', 100)],
            'Mortgage': [xfer('Brokerage', 100)],
            'Living Expenses': [xfer('401K A', 25), xfer('401K B', 15), xfer('Brokerage', 60)],
        };
        return [acc, ret];
    },
};

export const quickStartProfiles = [EARLY_CAREER, MID_CAREER, DUAL_INCOME, PRE_RETIREMENT, RETIRED];

/**
 * Build assets + life events for a given profile.
 * @param {object} profile - one of the quickStartProfiles entries
 * @returns {{ assets: ModelAsset[], lifeEvents: ModelLifeEvent[], ages: {startAge, retirementAge, finishAge} }}
 */
export function buildQuickStart(profile) {
    const ages = { startAge: profile.startAge, retirementAge: profile.retirementAge, finishAge: profile.finishAge };
    const d = dateAnchors(ages.startAge, ages.retirementAge, ages.finishAge);
    return {
        assets: profile.assets(d).map(raw => ModelAsset.fromJSON(raw)),
        lifeEvents: profile.lifeEvents(ages),
        ages,
    };
}

// ── Legacy exports (default = Mid Career) ───────────────────

export function quickStartAssets() {
    return buildQuickStart(MID_CAREER).assets;
}

export function quickStartLifeEvents() {
    return buildQuickStart(MID_CAREER).lifeEvents;
}