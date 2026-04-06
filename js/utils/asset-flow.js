/**
 * asset-flow.js
 *
 * Computes monthly inflow / growth / outflow for an asset at a given history index.
 * Used by asset-card to render the flow row (↗ ↑ ↙).
 */

import { InstrumentType } from '../instruments/instrument.js';
import { Metric } from '../metric.js';

/**
 * Read a metric history value at the given index.
 * Returns a number (0 if missing/null).
 */
function atIdx(asset, metricName, idx) {
    const h = asset.getHistory?.(metricName);
    return (h && idx >= 0 && idx < h.length) ? (h[idx] ?? 0) : 0;
}

/**
 * Compute monthly inflow, growth, and outflow for an asset.
 * All returned values are non-negative magnitudes.
 *
 * @param {ModelAsset} asset
 * @param {number} historyIndex
 * @returns {{ inflow: number, growth: number, outflow: number }}
 */
export function computeAssetFlows(asset, historyIndex) {
    if (historyIndex < 0) return { inflow: 0, growth: 0, outflow: 0 };

    const i = asset.instrument;
    const idx = historyIndex;

    // ── Income ──────────────────────────────────────────────
    if (InstrumentType.isMonthlyIncome(i)) {
        const income = Math.abs(atIdx(asset, Metric.INCOME, idx));
        const fica = Math.abs(atIdx(asset, Metric.WITHHELD_FICA_TAX, idx));
        const incomeTax = Math.abs(atIdx(asset, Metric.WITHHELD_INCOME_TAX, idx));
        return {
            inflow: income,
            growth: 0,
            outflow: fica + incomeTax,
        };
    }

    // ── Real Estate ─────────────────────────────────────────
    if (InstrumentType.isRealEstate(i)) {
        const growth = Math.abs(atIdx(asset, Metric.GROWTH, idx));
        const propTax = Math.abs(atIdx(asset, Metric.PROPERTY_TAX, idx));
        const maint = Math.abs(atIdx(asset, Metric.MAINTENANCE, idx));
        const ins = Math.abs(atIdx(asset, Metric.INSURANCE, idx));
        return {
            inflow: 0,
            growth,
            outflow: propTax + maint + ins,
        };
    }

    // ── Mortgage ────────────────────────────────────────────
    if (InstrumentType.isMortgage(i)) {
        const principal = Math.abs(atIdx(asset, Metric.MORTGAGE_PRINCIPAL, idx));
        const interest = Math.abs(atIdx(asset, Metric.MORTGAGE_INTEREST, idx));
        return {
            inflow: principal,
            growth: 0,
            outflow: interest,
        };
    }

    // ── Expenses ────────────────────────────────────────────
    if (InstrumentType.isMonthlyExpense(i)) {
        const expense = Math.abs(atIdx(asset, Metric.LIVING_EXPENSE, idx));
        return {
            inflow: 0,
            growth: 0,
            outflow: expense,
        };
    }

    // ── Debt ────────────────────────────────────────────────
    if (InstrumentType.isDebt(i)) {
        const credit = Math.abs(atIdx(asset, Metric.CREDIT, idx));
        const interest = Math.abs(atIdx(asset, Metric.INTEREST_EXPENSE, idx));
        return {
            inflow: credit,
            growth: 0,
            outflow: interest,
        };
    }

    // ── Retirement accounts (IRA, 401K, Roth) ───────────────
    if (InstrumentType.isTaxDeferred(i) || InstrumentType.isTaxFree(i)) {
        const contribution = Math.abs(atIdx(asset, Metric.CONTRIBUTION, idx));
        const growth = Math.abs(atIdx(asset, Metric.GROWTH, idx));
        let distribution = 0;
        if (InstrumentType.isIRA(i)) distribution = Math.abs(atIdx(asset, Metric.TRAD_IRA_DISTRIBUTION, idx));
        else if (InstrumentType.is401K(i)) distribution = Math.abs(atIdx(asset, Metric.FOUR_01K_DISTRIBUTION, idx));
        else if (InstrumentType.isRothIRA(i)) distribution = Math.abs(atIdx(asset, Metric.ROTH_IRA_DISTRIBUTION, idx));
        return {
            inflow: contribution,
            growth,
            outflow: distribution,
        };
    }

    // ── Capital (taxable equity, bank, bonds, cash) ─────────
    const credit = Math.abs(atIdx(asset, Metric.CREDIT, idx));
    const contribution = Math.abs(atIdx(asset, Metric.CONTRIBUTION, idx));
    const growth = Math.abs(atIdx(asset, Metric.GROWTH, idx));
    const qualDiv = Math.abs(atIdx(asset, Metric.QUALIFIED_DIVIDEND, idx));
    const nonQualDiv = Math.abs(atIdx(asset, Metric.NON_QUALIFIED_DIVIDEND, idx));
    const interestIncome = Math.abs(atIdx(asset, Metric.INTEREST_INCOME, idx));
    const taxableDist = Math.abs(atIdx(asset, Metric.TAXABLE_DISTRIBUTION, idx));
    const taxFreeDist = Math.abs(atIdx(asset, Metric.TAX_FREE_DISTRIBUTION, idx));

    return {
        inflow: credit + contribution,
        growth: growth + qualDiv + nonQualDiv + interestIncome,
        outflow: taxableDist + taxFreeDist,
    };
}
