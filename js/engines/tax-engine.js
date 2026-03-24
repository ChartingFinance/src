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
        modelAsset.addToMetric(Metric.MEDICARE_TAX, withholding.medicareTax);
        modelAsset.addToMetric(Metric.SOCIAL_SECURITY_TAX, withholding.socialSecurityTax);
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

            const liquidAsset = this.modelAssets.find(a => InstrumentType.isLiquid(a.instrument) && !a.isClosed && a.finishCurrency.amount > 0);
            if (liquidAsset) {
                liquidAsset.addToMetric(Metric.ESTIMATED_INCOME_TAX, additionalTax);
                liquidAsset.addCreditMemo(additionalTax.copy(), 'Income tax withholding');
            }
        }

    }

    // ── Year-End: Annual Tax True-Up ──────────────────────────────────
    // Compares exact yearly tax liability against total withheld/estimated
    // amounts accumulated in this.yearly. Debits underpayment or credits
    // overpayment to the first liquid account.

    applyAnnualTaxTrueUp() {

        // 1. Compute exact tax liability from the yearly accumulator
        const yearlySnapshot = this.yearly.copy();
        yearlySnapshot.limitDeductions(this.activeUser);

        const actualTaxableIncome = activeTaxTable.calculateYearlyTaxableIncome(yearlySnapshot);
        const actualIncomeTax = activeTaxTable.calculateYearlyIncomeTax(actualTaxableIncome);

        const yearlyCapitalGains = new Currency(
            yearlySnapshot.longTermCapitalGains.amount + yearlySnapshot.qualifiedDividends.amount
        );
        const actualCapitalGainsTax = activeTaxTable.calculateYearlyLongTermCapitalGainsTax(
            actualTaxableIncome, yearlyCapitalGains
        );

        // Total actual liability (positive = tax owed)
        const totalActualTax = actualIncomeTax.amount + actualCapitalGainsTax.amount;

        // 2. What was already withheld/estimated throughout the year?
        // These are stored as negative values (outflows), so negate to get positive totals.
        const totalWithheld = Math.abs(this.yearly.incomeTax.amount)
                            + Math.abs(this.yearly.estimatedTaxes.amount)
                            + Math.abs(this.yearly.longTermCapitalGainsTax.amount);

        // 3. Compute the difference
        const taxDifference = totalActualTax - totalWithheld;

        // Only act if the discrepancy is material (> $1)
        if (Math.abs(taxDifference) < 1) return;

        const liquidAsset = this.modelAssets.find(a => InstrumentType.isLiquid(a.instrument) && !a.isClosed && a.finishCurrency.amount > 0);
        if (!liquidAsset) return;

        if (taxDifference > 0) {
            // Underpaid — debit the shortfall (April tax bill)
            const taxBill = new Currency(taxDifference);
            logger.log(LogCategory.TAX, `Annual True-Up: Underpaid by $${taxDifference.toFixed(0)}. Debiting ${liquidAsset.displayName}.`);
            liquidAsset.debit(taxBill, 'Annual tax true-up (underpayment)');
            liquidAsset.addToMetric(Metric.ESTIMATED_INCOME_TAX, taxBill.copy().flipSign());
        } else {
            // Overpaid — credit the refund
            const taxRefund = new Currency(Math.abs(taxDifference));
            logger.log(LogCategory.TAX, `Annual True-Up: Overpaid by $${Math.abs(taxDifference).toFixed(0)}. Refunding to ${liquidAsset.displayName}.`);
            liquidAsset.credit(taxRefund, 'Annual tax true-up (refund)');
            liquidAsset.addToMetric(Metric.ESTIMATED_INCOME_TAX, taxRefund);
        }

    }

}
