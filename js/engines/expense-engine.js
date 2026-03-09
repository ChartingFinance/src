/**
 * expense-engine.js
 *
 * Day 15 property tax escrow and Day 30 expense pipeline:
 * expense fund transfers, shortfall gross-up, RMD enforcement,
 * and asset growth recognition.
 *
 * Extracted from Portfolio to separate expense/outflow concerns
 * from the simulation orchestrator.
 */

import { Currency } from '../utils/currency.js';
import { InstrumentType } from '../instruments/instrument.js';
import { Metric } from '../model-asset.js';
import { activeTaxTable } from '../globals.js';
import { logger, LogCategory } from '../utils/logger.js';

export class ExpenseEngine {

    constructor(modelAssets, monthly, activeUser, router) {
        this.modelAssets = modelAssets;
        this.monthly = monthly;
        this.activeUser = activeUser;
        this.router = router;
    }

    // ── Day 30: Expenses ─────────────────────────────────────────────

    applyExpenseTransfers(modelAsset, currentDateInt) {

        // Mortgage: execute fund transfers to pull payment from funding account
        if (InstrumentType.isMortgage(modelAsset.instrument)) {
            this.applyMortgageTransfers(modelAsset, currentDateInt);
            return;
        }

        if (!InstrumentType.isMonthlyExpense(modelAsset.instrument)) {
            return;
        }

        const modelAssetExpense = modelAsset.finishCurrency.copy();
        let runningExpenseAmount = new Currency(0.0);
        if (modelAsset.fundTransfers?.length > 0) {

            for (const fundTransfer of modelAsset.fundTransfers) {
                if (!fundTransfer.isActiveForMonth(currentDateInt.month)) continue;
                fundTransfer.bind(modelAsset, this.modelAssets);
                if (!fundTransfer.toModel) continue;
                const expenseAmount = fundTransfer.calculate();
                const fundTransferResult = fundTransfer.execute();

                this.handleExpenseGains(fundTransfer, fundTransferResult, modelAsset.displayName);
                runningExpenseAmount.add(expenseAmount);
            }

            // =========================================================================
            // INSERTION POINT 1: Expense Overflow (Partial Shortfall)
            // Replaces the old "const extraAmount = ..." logic
            // =========================================================================
            const netShortfall = new Currency(runningExpenseAmount.amount - modelAssetExpense.amount);
            if (netShortfall.amount > 0) {
                logger.log(LogCategory.TRANSFER, `ExpenseEngine.applyExpenseTransfers: ${modelAsset.displayName} expensing ${netShortfall.toString()} from taxable account (Grossed Up)`);

                const targetAsset = this.router.getFirstTaxable();
                if (targetAsset) {
                    const grossWithdrawal = this.calculateGrossWithdrawal(netShortfall, targetAsset);
                    const result = targetAsset.debit(grossWithdrawal, `Grossed-up expense overflow for ${modelAsset.displayName}`);

                    if (result && result.realizedGain && result.realizedGain.amount > 0) {
                        this.monthly.longTermCapitalGains.add(result.realizedGain);

                        // Isolate tax liability to prevent the death-spiral loop
                        const taxLiability = new Currency(grossWithdrawal.amount - netShortfall.amount);
                        this.monthly.estimatedTaxes.add(taxLiability);
                    }
                }
            }
        } else {
            // =========================================================================
            // INSERTION POINT 2: Full Expense (Total Shortfall)
            // Replaces the old "this.debitFromFirstTaxableAccount" fallback
            // =========================================================================
            const netShortfall = modelAssetExpense.copy().flipSign();
            logger.log(LogCategory.TRANSFER, `ExpenseEngine.applyExpenseTransfers: ${modelAsset.displayName} expensing ${netShortfall.toString()} from taxable account (Grossed Up)`);

            const targetAsset = this.router.getFirstTaxable();
            if (targetAsset) {
                const grossWithdrawal = this.calculateGrossWithdrawal(netShortfall, targetAsset);
                const result = targetAsset.debit(grossWithdrawal, `Grossed-up expense debit for ${modelAsset.displayName}`);

                if (result && result.realizedGain && result.realizedGain.amount > 0) {
                    this.monthly.longTermCapitalGains.add(result.realizedGain);

                    // Isolate tax liability to prevent the death-spiral loop
                    const taxLiability = new Currency(grossWithdrawal.amount - netShortfall.amount);
                    this.monthly.estimatedTaxes.add(taxLiability);
                }
            }
        }

    }

    applyMortgageTransfers(modelAsset, currentDateInt) {

        // The mortgage payment amount was already computed by MortgageBehavior.applyMonthly()
        const payment = modelAsset.mortgagePaymentCurrency.copy().flipSign(); // payment is negative, need positive for debit
        if (payment.amount <= 0) return;

        let funded = false;

        // Try explicit monthly fund transfers first
        if (modelAsset.fundTransfers?.length) {
            for (const fundTransfer of modelAsset.fundTransfers) {
                if (!fundTransfer.isActiveForMonth(currentDateInt.month)) continue;
                fundTransfer.bind(modelAsset, this.modelAssets);
                if (!fundTransfer.toModel) continue;

                const memo = fundTransfer.describe();
                fundTransfer.toModel.debit(payment, memo);
                funded = true;
                break; // one funding source per mortgage
            }
        }

        // Fallback: auto-debit from first taxable account (e.g., close-only or no fund transfers)
        if (!funded) {
            const taxable = this.router.getFirstTaxable();
            if (taxable) {
                const memo = `${modelAsset.displayName} → ${taxable.displayName} (mortgage payment)`;
                taxable.debit(payment, memo);
            }
        }

        // Principal and interest are already recorded on the monthly package
        // by addResult(MortgageResult) in payroll-engine day 1.
    }

    handleExpenseGains(fundTransfer, fundTransferResult, modelAssetName) {
        const targetInstrument = fundTransfer.toModel.instrument;
        const change = fundTransferResult.toAssetChange.copy();
        const realizedGain = fundTransferResult.realizedGain.copy();

        change.flipSign(); // flip sign because it's an expense

        if (change.amount === 0) return;

        if (InstrumentType.isTaxableAccount(targetInstrument)) {
            logger.log(LogCategory.TRANSFER, `ExpenseEngine.handleExpenseGains: ${modelAssetName} expensing ${fundTransfer.toModel.displayName} generated longTermCapitalGains of ${realizedGain.toString()}`);
            this.monthly.longTermCapitalGains.add(realizedGain);
        } else if (InstrumentType.isTaxDeferred(targetInstrument)) {
            logger.log(LogCategory.TRANSFER, `ExpenseEngine.handleExpenseGains: ${modelAssetName} expensing ${fundTransfer.toModel.displayName} generated ordinaryIncome of ${change.toString()}`);
            if (InstrumentType.isIRA(targetInstrument)) {
                this.monthly.tradIRADistribution.add(change);
            } else if (InstrumentType.is401K(targetInstrument)) {
                this.monthly.four01KDistribution.add(change);
            } else {
                logger.log(LogCategory.TRANSFER, `ExpenseEngine.handleExpenseGains: unhandled isTaxDeferred ${fundTransfer.toDisplayName}`);
            }
        } else if (InstrumentType.isTaxFree(targetInstrument)) {
            logger.log(LogCategory.TRANSFER, `ExpenseEngine.handleExpenseGains: ${modelAssetName} expensing ${fundTransfer.toModel.displayName} generated no tax impact`);
            this.monthly.rothIRADistribution.add(change);
        }
    }

    // ── Day 30: RMDs ─────────────────────────────────────────────────

    ensureRMDs(modelAsset) {

        if (!InstrumentType.isTaxDeferred(modelAsset.instrument))
            return;

        let rmd = modelAsset.rmdCurrency.copy();
        let distributions = new Currency();

        if (this.activeUser.rmdRequired()) {

            if (InstrumentType.isIRA(modelAsset.instrument))
                distributions = modelAsset.tradIRADistributionCurrency.copy();
            else if (InstrumentType.is401K(modelAsset.instrument))
                distributions = modelAsset.four01KDistributionCurrency.copy();
            else
                logger.log(LogCategory.SANITY, 'ExpenseEngine.ensureRMDs: should not be here!');

        }

        if (rmd.amount > distributions.amount) {

            let remains = new Currency(rmd.amount - distributions.amount);

            if (InstrumentType.isIRA(modelAsset.instrument)) {
                modelAsset.addToMetric(Metric.TRAD_IRA_DISTRIBUTION, remains);
                this.monthly.tradIRADistribution.add(remains);
            } else {
                modelAsset.addToMetric(Metric.FOUR_01K_DISTRIBUTION, remains);
                this.monthly.four01KDistribution.add(remains);
            }

            const rmdNote = `RMD distribution from ${modelAsset.displayName}`;
            modelAsset.debit(remains, rmdNote);
            this.router.creditToExpensable(remains, rmdNote);

        }

    }

    // ── Day 30: Asset Growth Recognition ─────────────────────────────

    applyAssetGrowth(modelAsset) {

        if (InstrumentType.isCapital(modelAsset.instrument) || InstrumentType.isIncomeAccount(modelAsset.instrument) || InstrumentType.isMonthlyExpense(modelAsset.instrument)) {
            let result = modelAsset.applyMonthly();
            this.monthly.addResult(result);

            /*
            // TODO: revisit and see if this is the best spot to log capital gains
            // Compute estimated tax for non-Home capital assets (Home property tax is handled on day 15)
            if (InstrumentType.isCapital(modelAsset.instrument) && !InstrumentType.isRealEstate(modelAsset.instrument) && modelAsset.annualTaxRate.rate !== 0) {
                const tax = new Currency(modelAsset.finishCurrency.amount * modelAsset.annualTaxRate.asMonthly()).flipSign();
                modelAsset.estimatedTaxCurrency.add(tax);
                modelAsset.addCreditMemo(tax, 'Estimated tax');
                this.monthly.estimatedTaxes.add(tax);
            }
            */
        }

    }

    // ── Helpers ──────────────────────────────────────────────────────

    calculateGrossWithdrawal(netShortfall, modelAsset) {
        // 1. Estimate current marginal LTCG bracket based strictly on base income (W-2, etc)
        const yearlyEstimate = this.monthly.copy().multiply(12.0);
        yearlyEstimate.limitDeductions(this.activeUser);
        const taxableIncome = activeTaxTable.calculateYearlyTaxableIncome(yearlyEstimate);

        // Quick heuristic for marginal LTCG rate (0%, 15%, 20%)
        const ltcgRate = activeTaxTable.getMarginalLTCGRate(taxableIncome);

        // 2. Get the asset's gain ratio (g)
        const gainRatio = modelAsset.getUnrealizedGainRatio();

        // 3. Apply the Gross-Up Formula: W = X / (1 - (t * g))
        const denominator = 1.0 - (ltcgRate * gainRatio);

        // Prevent division by zero or negative bounds
        if (denominator <= 0) return netShortfall.copy();

        return new Currency(netShortfall.amount / denominator);
    }

}
