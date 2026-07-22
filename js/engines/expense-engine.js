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
import { Metric } from '../metric.js';
import { FundTransferOneSided, FundTransfer } from '../fund-transfer.js';
import { activeTaxTable } from '../globals.js';
import { logger, LogCategory } from '../utils/logger.js';

export class ExpenseEngine {

    constructor(modelAssets, monthly, activeUser) {
        this.modelAssets = modelAssets;
        this.monthly = monthly;
        this.activeUser = activeUser;
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
                if (!fundTransfer.hasRecurring) continue;
                fundTransfer.bind(modelAsset, this.modelAssets);
                if (!fundTransfer.toModel) continue;
                const expenseAmount = fundTransfer.calculate();
                const fundTransferResult = fundTransfer.execute();

                // Book tax consequences against what each account ACTUALLY
                // supplied. toAssetChange is the REQUESTED withdrawal; if the
                // funding account was clamped at $0 (tax-advantaged accounts
                // can't go negative), execute() sourced the remainder from a
                // taxable fallback and reports that leg separately. Booking
                // the full request against the funding account (the old code)
                // recorded phantom IRA distributions for money the IRA never
                // held.
                const withdrawalAmount = fundTransferResult.toAssetChange.copy().flipSign();
                withdrawalAmount.subtract(fundTransferResult.spillover);
                this.monthly.recordTransfer(fundTransfer.toModel.instrument, withdrawalAmount, fundTransferResult.realizedGain);
                fundTransfer.toModel.recordDistribution(withdrawalAmount);
                if (fundTransferResult.spillover.amount > 0 && fundTransferResult.spilloverInstrument) {
                    this.monthly.recordTransfer(fundTransferResult.spilloverInstrument,
                        fundTransferResult.spillover, fundTransferResult.spilloverGain);
                }
                runningExpenseAmount.add(expenseAmount);
            }

            // =========================================================================
            // INSERTION POINT 1: Expense Overflow (Partial Shortfall)
            // Replaces the old "const extraAmount = ..." logic
            // =========================================================================
            const netShortfall = new Currency(runningExpenseAmount.amount - modelAssetExpense.amount);
            if (netShortfall.amount > 0) {
                logger.log(LogCategory.TRANSFER, `ExpenseEngine.applyExpenseTransfers: ${modelAsset.displayName} expensing ${netShortfall.toString()} from taxable account (Grossed Up)`);

                const targetAsset = FundTransfer.resolveTaxable(this.modelAssets);
                if (targetAsset) {
                    const grossWithdrawal = this.calculateGrossWithdrawal(netShortfall, targetAsset);
                    const result = targetAsset.debit(grossWithdrawal, `Grossed-up expense overflow for ${modelAsset.displayName}`);
                    this.monthly.recordTransfer(targetAsset.instrument, grossWithdrawal, result.realizedGain);

                    if (result && result.realizedGain && result.realizedGain.amount > 0) {
                        targetAsset.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, result.realizedGain);
                        targetAsset.addCreditMemo(result.realizedGain.copy(), 'Capital gains', 'info');
                        // Isolate tax liability to prevent the death-spiral loop
                        const taxLiability = new Currency(grossWithdrawal.amount - netShortfall.amount);
                        this.monthly.estimatedTaxes.add(taxLiability);
                        targetAsset.addToMetric(Metric.ESTIMATED_INCOME_TAX, taxLiability.copy().flipSign());
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

            const targetAsset = FundTransfer.resolveTaxable(this.modelAssets);
            if (targetAsset) {
                const grossWithdrawal = this.calculateGrossWithdrawal(netShortfall, targetAsset);
                const result = targetAsset.debit(grossWithdrawal, `Grossed-up expense debit for ${modelAsset.displayName}`);
                this.monthly.recordTransfer(targetAsset.instrument, grossWithdrawal, result.realizedGain);

                if (result && result.realizedGain && result.realizedGain.amount > 0) {
                    targetAsset.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, result.realizedGain);
                    targetAsset.addCreditMemo(result.realizedGain.copy(), 'Capital gains', 'info');
                    // Isolate tax liability to prevent the death-spiral loop
                    const taxLiability = new Currency(grossWithdrawal.amount - netShortfall.amount);
                    this.monthly.estimatedTaxes.add(taxLiability);
                    targetAsset.addToMetric(Metric.ESTIMATED_INCOME_TAX, taxLiability.copy().flipSign());
                }
            }
        }

    }

    applyMortgageTransfers(modelAsset, currentDateInt) {

        // The mortgage payment amount was already computed by MortgageBehavior.applyMonthly()
        const payment = modelAsset.mortgagePaymentCurrency.copy().flipSign(); // payment is negative, need positive for debit
        if (payment.amount <= 0) return;

        let preFlights = [];
        let remaining = payment.copy();

        // Try explicit fund transfers first
        if (modelAsset.fundTransfers?.length) {
            for (const fundTransfer of modelAsset.fundTransfers) {

                // so we don't blow up
                if (!fundTransfer.hasRecurring) continue;
                fundTransfer.bind(modelAsset, this.modelAssets);
                if (!fundTransfer.toModel) continue;
                if (remaining.amount == 0) break;
                                    
                // passed the tests so load into the array
                let preFlight = new FundTransferOneSided(fundTransfer, payment);
                remaining.subtract(preFlight.amount);
                if (remaining.amount < 0) {
                    // last minute patch
                    preFlight.amount.add(remaining);
                    remaining.zero();
                }                    
                preFlights.push(preFlight);

            }
        }

        // Fallback: first taxable account
        if (remaining.amount > 0) {
            let fundingSource = FundTransfer.resolveTaxable(this.modelAssets);
            if (fundingSource) {
                let preFlight = new FundTransferOneSided(null, remaining);
                preFlight.fromModel = modelAsset;
                preFlight.toModel = fundingSource;
                preFlights.push(preFlight);
            }
        }

        // One-sided withdrawal: MortgageBehavior already reduced the mortgage
        // balance (principal) and recorded interest. Only debit the funding source.
        for (const oneSided of preFlights) {
            const memo = `${modelAsset.displayName} → ${oneSided.toModel.displayName} (monthly)`;
            const result = oneSided.toModel.debit(oneSided.amount, memo);
            this.monthly.recordTransfer(oneSided.toModel.instrument, oneSided.amount, result.realizedGain);
            oneSided.toModel.recordDistribution(oneSided.amount.minus(result.spillover));
            if (result.realizedGain && result.realizedGain.amount > 0) {
                oneSided.toModel.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, result.realizedGain);
                oneSided.toModel.addCreditMemo(result.realizedGain.copy(), 'Capital gains', 'info');
            }
        }

    }

    // ── Day 30: Real Estate Carrying Costs (Maintenance + Insurance) ──

    applyCarryingCostTransfers(modelAsset, currentDateInt) {
        const maint = modelAsset.maintenanceCurrency.copy().flipSign();
        const ins   = modelAsset.insuranceCurrency.copy().flipSign();

        if (maint.amount > 0) this._debitCarryingCost(modelAsset, maint, 'maintenance', currentDateInt);
        if (ins.amount > 0)   this._debitCarryingCost(modelAsset, ins, 'insurance', currentDateInt);
    }

    _debitCarryingCost(modelAsset, cost, label, currentDateInt) {
        let preFlights = [];
        let remaining = cost.copy();

        if (modelAsset.fundTransfers?.length) {
            for (const fundTransfer of modelAsset.fundTransfers) {
                if (!fundTransfer.hasRecurring) continue;
                fundTransfer.bind(modelAsset, this.modelAssets);
                if (!fundTransfer.toModel) continue;
                if (remaining.amount == 0) break;

                let preFlight = new FundTransferOneSided(fundTransfer, cost);
                remaining.subtract(preFlight.amount);
                if (remaining.amount < 0) {
                    preFlight.amount.add(remaining);
                    remaining.zero();
                }
                preFlights.push(preFlight);
            }
        }

        if (remaining.amount > 0) {
            let fundingSource = FundTransfer.resolveExpensable(this.modelAssets);
            if (fundingSource) {
                let preFlight = new FundTransferOneSided(null, remaining);
                preFlight.fromModel = modelAsset;
                preFlight.toModel = fundingSource;
                preFlights.push(preFlight);
            }
        }

        for (const oneSided of preFlights) {
            const memo = `${modelAsset.displayName} → ${oneSided.toModel.displayName} (${label})`;
            const result = oneSided.toModel.debit(oneSided.amount, memo);
            this.monthly.recordTransfer(oneSided.toModel.instrument, oneSided.amount, result.realizedGain);
            oneSided.toModel.recordDistribution(oneSided.amount.minus(result.spillover));
            if (result.realizedGain && result.realizedGain.amount > 0) {
                oneSided.toModel.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, result.realizedGain);
                oneSided.toModel.addCreditMemo(result.realizedGain.copy(), 'Capital gains', 'info');
            }
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

            // Execute first, book after — book what actually moved, not what
            // was requested. The old order booked `remains` as a distribution
            // before (and regardless of) the transfer: with no expensable
            // target the income was recorded but no cash ever left the IRA,
            // and when the IRA held less than the RMD the spillover portion
            // (sourced from a taxable account) was booked as IRA income too.
            const target = FundTransfer.resolveExpensable(this.modelAssets);
            if (!target) {
                logger.log(LogCategory.SANITY,
                    `ExpenseEngine.ensureRMDs: no expensable target for ${modelAsset.displayName} RMD of ${remains.toString()}`);
                return;
            }

            const result = FundTransfer.system(modelAsset, target, remains, this.modelAssets).execute();

            // Only the portion the IRA/401K itself supplied is a taxable
            // distribution; the spillover leg is a taxable-account withdrawal
            // whose consequence is its realized gain.
            const actual = remains.minus(result.spillover);
            if (actual.amount > 0) {
                if (InstrumentType.isIRA(modelAsset.instrument)) {
                    modelAsset.addToMetric(Metric.TRAD_IRA_DISTRIBUTION, actual);
                    this.monthly.tradIRADistribution.add(actual);
                } else {
                    modelAsset.addToMetric(Metric.FOUR_01K_DISTRIBUTION, actual);
                    this.monthly.four01KDistribution.add(actual);
                }
            }
            if (result.spillover.amount > 0 && result.spilloverInstrument) {
                this.monthly.recordTransfer(result.spilloverInstrument, result.spillover, result.spilloverGain);
            }

        }

    }

    // ── Day 30: Asset Growth Recognition ─────────────────────────────

    applyAssetGrowth(modelAsset, currentDateInt) {

        if (InstrumentType.isCapital(modelAsset.instrument) || InstrumentType.isIncomeAccount(modelAsset.instrument) || InstrumentType.isMonthlyExpense(modelAsset.instrument)) {
            let result = modelAsset.applyMonthly();
            this.monthly.addResult(result);

            // Real estate carrying costs → FP
            if (InstrumentType.isRealEstate(modelAsset.instrument)) {
                this.monthly.maintenance.add(modelAsset.maintenanceCurrency);
                this.monthly.insurance.add(modelAsset.insuranceCurrency);
                this.applyCarryingCostTransfers(modelAsset, currentDateInt);
            }

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
