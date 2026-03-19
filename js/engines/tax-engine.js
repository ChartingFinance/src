/**
 * tax-engine.js
 *
 * Tax payment scheduling and execution: records tax amounts to the
 * monthly package, pushes CreditMemos, and executes debits/credits.
 *
 * The companion TaxTable (taxes.js) owns the pure math — bracket walks,
 * rate calculations, contribution limits. TaxEngine is the "cashier"
 * that takes those computed amounts and moves money.
 */

import { Currency } from '../utils/currency.js';
import { InstrumentType } from '../instruments/instrument.js';
import { Metric } from '../metric.js';
import { FundTransferOneSided, FundTransfer } from '../fund-transfer.js';
import { MonthsSpan } from '../utils/months-span.js';
import { activeTaxTable } from '../globals.js';
import { logger, LogCategory } from '../utils/logger.js';

export class TaxEngine {

    constructor(modelAssets, monthly, yearly, activeUser) {
        this.modelAssets = modelAssets;
        this.monthly = monthly;
        this.yearly = yearly;
        this.activeUser = activeUser;
    }

    // ── Day 1: FICA Recording ─────────────────────────────────────────

    recordFICAWithholding(modelAsset, withholding) {

        withholding.flipSigns();
        modelAsset.medicareTaxCurrency.add(withholding.medicareTax);
        modelAsset.socialSecurityTaxCurrency.add(withholding.socialSecurityTax);
        this.monthly.addWithholdingResult(withholding);

        modelAsset.addCreditMemo(withholding.fica(), 'FICA withholding');

    }

    // ── Day 1: Income Tax Withholding Recording ───────────────────────

    recordIncomeTaxWithholding(modelAsset, assetTax) {

        const withheldTax = assetTax.copy().flipSign();
        this.monthly.incomeTax.add(withheldTax);
        modelAsset.addCreditMemo(withheldTax.copy(), 'Income tax withholding');

        logger.log(LogCategory.TRANSFER, `recordIncomeTaxWithholding: ${modelAsset.displayName} tax=${assetTax.toString()}`);

    }

    // ── Day 15: Property Tax Escrow ───────────────────────────────────

    applyPropertyTaxEscrow(modelAsset, currentDateInt) {

        if (!InstrumentType.isRealEstate(modelAsset.instrument)) return;

        if (modelAsset.annualTaxRate.rate != 0) {

            const escrow = modelAsset.applyMonthlyTaxEscrow();
            //this.monthly.propertyTaxes.subtract(escrow);
            modelAsset.addCreditMemo(escrow, 'Property tax escrow');            

            if (modelAsset.monthlyTaxEscrow.amount) {

                let preFlights = [];
                const payment = escrow.flipSign(); // escrow is negative, flip to positive for debit
                let remaining = payment.copy();

                for (const fundTransfer of modelAsset.fundTransfers) {

                    // so we don't blow up
                    if (!fundTransfer.isActiveForMonth(currentDateInt.month)) continue;
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

                // One-sided withdrawal: escrow already adjusted the home's balance.
                // Only debit the funding source (toModel).
                for (const oneSided of preFlights) {                
                    const memo = `${modelAsset.displayName} property tax`;
                    const result = oneSided.toModel.debit(oneSided.amount, memo);
                    this.monthly.recordTransfer(oneSided.toModel.instrument, oneSided.amount, result.realizedGain);
                    if (result.realizedGain && result.realizedGain.amount > 0) {
                        oneSided.toModel.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, result.realizedGain);
                        oneSided.toModel.addCreditMemo(result.realizedGain.copy(), 'Capital gains');
                    }
                }

                modelAsset.clearMonthlyTaxEscrow();

            }

        }
    }

    // ── On Close: Capital Gains Tax ───────────────────────────────────

    applyCapitalGainsTax(modelAsset) {
        if (InstrumentType.isTaxFree(modelAsset.instrument)) return;

        const capitalGains = new Currency(modelAsset.finishCurrency.amount - modelAsset.finishBasisCurrency.amount);
        logger.log(LogCategory.TAX, 'capital gains of ' + capitalGains.toString());

        const monthsSpan = MonthsSpan.build(modelAsset.startDateInt, modelAsset.effectiveFinishDateInt);
        const annualizedIncome = this.monthly.totalIncome().copy().multiply(12);
        const isRealEstate = InstrumentType.isRealEstate(modelAsset.instrument);
        const isPrimaryHome = isRealEstate && modelAsset.isPrimaryHome;

        const result = activeTaxTable.calculateCapitalGainsTax(
            capitalGains, monthsSpan.totalMonths, isPrimaryHome, annualizedIncome
        );

        let amountToTax = result.tax.copy();

        if (result.isLongTerm) {
            this.monthly.longTermCapitalGains.add(capitalGains);
            modelAsset.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, capitalGains);

            modelAsset.addCreditMemo(capitalGains.copy(), 'Capital gains');

            this.monthly.longTermCapitalGainsTax.add(amountToTax.flipSign());
            modelAsset.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN_TAX, amountToTax);

            if (amountToTax.amount !== 0) {
                modelAsset.addCreditMemo(amountToTax.copy(), 'Capital gains tax withholding');
            }
        } else {
            this.monthly.shortTermCapitalGains.add(capitalGains);
            modelAsset.addToMetric(Metric.SHORT_TERM_CAPITAL_GAIN, capitalGains);

            this.monthly.incomeTax.add(amountToTax.flipSign());
            modelAsset.addToMetric(Metric.SHORT_TERM_CAPITAL_GAIN_TAX, capitalGains);

            if (amountToTax.amount !== 0) {
                modelAsset.addCreditMemo(amountToTax.copy(), 'Income tax withholding');
            }
        }

        logger.log(LogCategory.TAX, 'applyCapitalGainsTax: ' + modelAsset.displayName + ' generated tax of ' + amountToTax.toString() + ' to deduct from closure');
        modelAsset.finishCurrency.add(amountToTax);
        modelAsset.monthlyValueChange.add(amountToTax);

        // Neutralize basis so subsequent close transfers don't re-trigger
        // realized gains — capital gains have already been taxed above.
        modelAsset.finishBasisCurrency = modelAsset.finishCurrency.copy();
    }

    // ── Day 30: Monthly Tax True-Up ───────────────────────────────────

    applyMonthlyTaxTrueUp() {

        // Compute total tax liability across ALL income (salary + capital gains + dividends + interest)
        let yearly = this.monthly.copy().multiply(12.0);
        yearly.limitDeductions(this.activeUser);
        let yearlyIncome = activeTaxTable.calculateYearlyTaxableIncome(yearly);
        let totalIncomeTax = activeTaxTable.calculateYearlyIncomeTax(yearlyIncome).divide(12.0).flipSign();

        // What was already withheld from payroll on Day 1? (negative value)
        const alreadyWithheld = this.monthly.incomeTax.copy();

        // Additional estimated tax = total liability - already withheld
        // Both values are negative, so if total is more negative, additionalTax is negative (owe more)
        const additionalTax = new Currency(totalIncomeTax.amount - alreadyWithheld.amount);

        if (additionalTax.amount < 0) {
            // Additional tax owed beyond payroll withholding (e.g., from capital gains, dividends)
            this.monthly.incomeTax.add(additionalTax);

            const liquidAsset = this.modelAssets.find(a => InstrumentType.isLiquid(a.instrument) && !a.isClosed);
            if (liquidAsset) {
                liquidAsset.estimatedIncomeTaxCurrency.add(additionalTax);
                liquidAsset.addCreditMemo(additionalTax.copy(), 'Income tax withholding');
            }
        }

    }

    // ── Month 12: Annual Tax True-Up ──────────────────────────────────
    // TODO: Not yet active — requires yearly accumulators (yearlyGrossIncome,
    // yearlyDeductions, yearlyCapitalGains, yearlyWithheldTaxes) to be
    // implemented on TaxEngine or passed in from Portfolio.

    applyAnnualTaxTrueUp(currentDateInt) {
        // Only run this once a year (e.g., end of December)
        if (currentDateInt.month !== 12) return;

        /*
        // 1. Calculate the EXACT tax liability based on the full 365-day reality
        const actualTaxableIncome = activeTaxTable.calculateYearlyTaxableIncome(
            this.yearlyGrossIncome.copy().subtract(this.yearlyDeductions)
        );

        // TODO: calculate the FICA liability for employedIncome and selfIncome

        const actualIncomeTax = activeTaxTable.calculateYearlyIncomeTax(actualTaxableIncome);
        const actualCapitalGainsTax = activeTaxTable.calculateYearlyLongTermCapitalGainsTax(
            actualTaxableIncome,
            this.yearlyCapitalGains
        );

        const totalActualTax = actualIncomeTax.copy().add(actualCapitalGainsTax);

        // 2. Compare Actual vs. Withheld
        const taxDifference = totalActualTax.amount - this.yearlyWithheldTaxes.amount;

        if (taxDifference > 0) {
            logger.log(LogCategory.TAX, `Annual True-Up: User owes ${taxDifference}. Debiting account.`);
            const taxBill = new Currency(taxDifference);
            this.router.debitFromExpensable(taxBill, 'Annual IRS Tax Bill Due');

        } else if (taxDifference < 0) {
            const refundAmount = Math.abs(taxDifference);
            logger.log(LogCategory.TAX, `Annual True-Up: User overpaid. Refunding ${refundAmount}.`);
            const taxRefund = new Currency(refundAmount);
            this.router.creditToExpensable(taxRefund, 'IRS Tax Refund');
        }

        // 3. Reset the annual accumulators for the next year
        this.resetAnnualAccumulators();
        */
    }

}
