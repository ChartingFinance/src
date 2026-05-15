/**
 * rebalance-engine.js
 *
 * Day 1 rebalancing transfers between capital/fundable assets.
 * Runs AFTER the payroll pipeline so income deposits and payroll
 * contributions are complete before rebalancing pulls from accounts.
 *
 * Handles:
 *  - Capital → Capital (e.g., savings → brokerage)
 *  - Capital → Mortgage/Debt (early payoff)
 *  - Capital → Retirement (contributions, subject to annual limits)
 *  - Retirement → Capital (distributions, tracked as taxable income)
 *  - Roth conversions (IRA/401K → Roth IRA)
 *
 * Tax consequences are handled by FundTransfer.execute() which calls
 * debit() → realizedGain, and the monthly tax true-up picks up gains.
 */

import { Currency } from '../utils/currency.js';
import { InstrumentType } from '../instruments/instrument.js';
import { Metric } from '../metric.js';
import { activeTaxTable } from '../globals.js';
import { logger, LogCategory } from '../utils/logger.js';

export class RebalanceEngine {

    constructor(modelAssets, monthly, yearly, activeUser) {
        this.modelAssets = modelAssets;
        this.monthly = monthly;
        this.yearly = yearly;
        this.activeUser = activeUser;
    }

    /**
     * Execute rebalancing transfers for a single asset.
     * Only processes fundable assets not handled by payroll or expense engines.
     */
    applyRebalanceTransfers(modelAsset, _currentDateInt) {

        const inst = modelAsset.instrument;

        // Skip instruments handled by other engines
        if (InstrumentType.isMonthlyIncome(inst)) return;
        if (InstrumentType.isMonthlyExpense(inst)) return;
        if (InstrumentType.isMortgage(inst)) return;
        if (InstrumentType.isRealEstate(inst)) return;
        if (!modelAsset.fundTransfers?.length) return;

        for (const ft of modelAsset.fundTransfers) {
            if (!ft.hasRecurring) continue;

            ft.bind(modelAsset, this.modelAssets);
            if (!ft.toModel || ft.toModel.isClosed) continue;

            // Calculate the transfer amount (percentage of source balance)
            delete ft.approvedAmount;
            let amount = ft.calculate();
            if (amount.amount <= 0) continue;

            // ── Contribution limits (target is tax-advantaged) ────────
            amount = this._enforceContributionLimits(ft, amount);
            if (amount.amount <= 0) continue;

            ft.approvedAmount = amount.copy();

            // ── Distribution tracking (source is tax-deferred) ───────
            this._trackDistribution(modelAsset, amount);

            // ── Execute ──────────────────────────────────────────────
            const result = ft.execute();

            // Record in monthly package so tax true-up sees the transfer
            const withdrawalAmount = result.toAssetChange?.copy().flipSign() ?? amount;
            this.monthly.recordTransfer(ft.toModel.instrument, withdrawalAmount, result.realizedGain);

            // Record contribution metric on target (for retirement accounts)
            this._trackContribution(ft.toModel, amount);

            logger.log(LogCategory.TRANSFER,
                `Rebalance: ${modelAsset.displayName} → ${ft.toModel.displayName} ${amount.toString()}`);
        }
    }

    /**
     * Enforce annual contribution limits when target is a tax-advantaged account.
     * Returns the (possibly capped) transfer amount.
     */
    _enforceContributionLimits(ft, amount) {
        const targetInst = ft.toModel.instrument;

        if (InstrumentType.is401K(targetInst)) {
            const limit = activeTaxTable.four01KContributionLimit(this.activeUser);
            const used = this.yearly.four01KContribution.amount + this.monthly.four01KContribution.amount;
            const remaining = limit.amount - used;
            if (remaining <= 0) return Currency.zero();
            if (amount.amount > remaining) return new Currency(remaining);
        }

        else if (InstrumentType.isIRA(targetInst) && !InstrumentType.isRothIRA(targetInst)) {
            const limit = activeTaxTable.iraContributionLimit(this.activeUser);
            const used = this.yearly.tradIRAContribution.amount + this.monthly.tradIRAContribution.amount;
            const remaining = limit.amount - used;
            if (remaining <= 0) return Currency.zero();
            if (amount.amount > remaining) return new Currency(remaining);
        }

        else if (InstrumentType.isRothIRA(targetInst)) {
            // Roth IRA shares the combined IRA limit with traditional IRA
            const limit = activeTaxTable.iraContributionLimit(this.activeUser);
            const used = this.yearly.tradIRAContribution.amount + this.yearly.rothIRAContribution.amount
                       + this.monthly.tradIRAContribution.amount + this.monthly.rothIRAContribution.amount;
            const remaining = limit.amount - used;
            if (remaining <= 0) return Currency.zero();
            if (amount.amount > remaining) return new Currency(remaining);
        }

        return amount;
    }

    /**
     * Track distribution metrics when money leaves a tax-deferred account.
     */
    _trackDistribution(sourceAsset, amount) {
        if (InstrumentType.isIRA(sourceAsset.instrument) && !InstrumentType.isRothIRA(sourceAsset.instrument)) {
            sourceAsset.addToMetric(Metric.TRAD_IRA_DISTRIBUTION, amount);
            this.monthly.tradIRADistribution.add(amount);
        }
        else if (InstrumentType.is401K(sourceAsset.instrument)) {
            sourceAsset.addToMetric(Metric.FOUR_01K_DISTRIBUTION, amount);
            this.monthly.four01KDistribution.add(amount);
        }
        else if (InstrumentType.isRothIRA(sourceAsset.instrument)) {
            sourceAsset.addToMetric(Metric.ROTH_IRA_DISTRIBUTION, amount);
            this.monthly.rothIRADistribution.add(amount);
        }
    }

    /**
     * Track contribution metrics when money enters a tax-advantaged account.
     */
    _trackContribution(targetAsset, amount) {
        if (InstrumentType.is401K(targetAsset.instrument)) {
            targetAsset.addToMetric(Metric.FOUR_01K_CONTRIBUTION, amount);
            this.monthly.four01KContribution.add(amount);
        }
        else if (InstrumentType.isIRA(targetAsset.instrument) && !InstrumentType.isRothIRA(targetAsset.instrument)) {
            targetAsset.addToMetric(Metric.TRAD_IRA_CONTRIBUTION, amount);
            this.monthly.tradIRAContribution.add(amount);
        }
        else if (InstrumentType.isRothIRA(targetAsset.instrument)) {
            targetAsset.addToMetric(Metric.ROTH_IRA_CONTRIBUTION, amount);
            this.monthly.rothIRAContribution.add(amount);
        }
    }
}
