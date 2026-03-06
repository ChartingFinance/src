/**
 * payroll-engine.js
 *
 * Day 1 income pipeline: FICA withholding, income tax withholding,
 * 401K/IRA contribution caps, Roth IRA limits, net income computation,
 * and pre/post-tax fund transfers.
 *
 * Extracted from Portfolio to separate payroll concerns from the
 * simulation orchestrator.
 */

import { Currency } from '../utils/currency.js';
import { InstrumentType } from '../instruments/instrument.js';
import { Metric } from '../model-asset.js';
import { activeTaxTable } from '../globals.js';

export class PayrollEngine {

    constructor(modelAssets, monthly, yearly, activeUser, router, taxEngine) {
        this.modelAssets = modelAssets;
        this.monthly = monthly;
        this.yearly = yearly;
        this.activeUser = activeUser;
        this.router = router;
        this.taxEngine = taxEngine;
    }

    applyPreTaxCalculations(modelAsset, currentDateInt) {

        if (InstrumentType.isMonthlyIncome(modelAsset.instrument)) {

            let result = modelAsset.applyMonthly();
            this.monthly.addResult(result);

            if (InstrumentType.isRetirementIncome(modelAsset.instrument)) {
                this.monthly.socialSecurity.add(modelAsset.incomeCurrency);
            } else {

                // it's self-employed or w2-employed
                this.applyPreTaxWithholding(modelAsset);

                // TODO: Can't do 401K on self income, but can do SEP (which is not an instrument right now)
                // so just allow this but plan for SEP instrument soon
                this.calculatePreTaxContributions(modelAsset);

            }

        }
        else if (InstrumentType.isMortgage(modelAsset.instrument)) {

            let result = modelAsset.applyMonthly();
            this.monthly.addResult(result);

        }
        else if (InstrumentType.isDebt(modelAsset.instrument)) {

            let result = modelAsset.applyMonthly();
            this.monthly.addResult(result);

        }

    }

    applyPreTaxWithholding(modelAsset) {

        if (InstrumentType.isMonthlyIncome(modelAsset.instrument)) {

            // TODO: make a test for selfEmployed or Employee
            if (InstrumentType.isWorkingIncome(modelAsset.instrument)) {

                let withholding = activeTaxTable.calculateFICATax(modelAsset.isSelfEmployed, modelAsset.incomeCurrency.copy());
                activeTaxTable.addYearlySocialSecurity(withholding.socialSecurity);

                this.taxEngine.recordFICAWithholding(modelAsset, withholding);

            }
        }

    }

    /**
     * Phase 1: Compute the household-level monthly income tax estimate once.
     * Must be called after all applyPreTaxCalculations have run so this.monthly
     * reflects the full aggregate across all income assets.
     *
     * @returns {{ householdTax: Currency, totalWorkingIncome: Currency }}
     */
    computeHouseholdIncomeTax() {
        let yearlyEstimate = this.monthly.copy().multiply(12.0);
        yearlyEstimate.limitDeductions(this.activeUser);
        let yearlyTaxableIncome = activeTaxTable.calculateYearlyTaxableIncome(yearlyEstimate);
        let householdTax = activeTaxTable.calculateYearlyIncomeTax(yearlyTaxableIncome).divide(12.0);

        // Sum working income across all active assets for proportional allocation
        let totalWorkingIncome = Currency.zero();
        for (const asset of this.modelAssets) {
            if (!asset.isClosed && InstrumentType.isWorkingIncome(asset.instrument)) {
                totalWorkingIncome.add(asset.incomeCurrency);
            }
        }

        return { householdTax, totalWorkingIncome };
    }

    /**
     * Phase 2: Apply proportional share of household income tax to one asset,
     * then compute its net income.
     */
    applyNetIncome(modelAsset, householdTax, totalWorkingIncome) {

        if (!InstrumentType.isWorkingIncome(modelAsset.instrument)) {
            return;
        }

        let netIncome = modelAsset.incomeCurrency.copy();

        // subtract per-asset FICA (Social Security + Medicare, stored as negative values on model asset)
        netIncome.add(modelAsset.socialSecurityCurrency);  // negative, so add subtracts
        netIncome.add(modelAsset.medicareCurrency);

        // subtract pre-tax 401K contributions (per-asset)
        let four01KContribution = modelAsset.four01KContributionCurrency;
        if (four01KContribution.amount > 0) {
            netIncome.subtract(four01KContribution);
        }

        // subtract traditional IRA contributions (per-asset)
        let iraContribution = modelAsset.tradIRAContributionCurrency;
        if (iraContribution.amount > 0) {
            netIncome.subtract(iraContribution);
        }

        // Proportional share of household income tax for this asset
        const proportion = totalWorkingIncome.amount > 0
            ? modelAsset.incomeCurrency.amount / totalWorkingIncome.amount
            : 0;
        const assetTax = new Currency(householdTax.amount * proportion);

        netIncome.subtract(assetTax);
        if (modelAsset.isSelfEmployed) {
            modelAsset.estimatedIncomeTaxCurrency = assetTax;
        } else {
            modelAsset.withheldIncomeTaxCurrency = assetTax;
        }

        modelAsset.incomeTaxCurrency = assetTax;
        modelAsset.netIncomeCurrency = netIncome;

        this.taxEngine.recordIncomeTaxWithholding(modelAsset, assetTax);

    }

    calculateRMDs(currentDateInt, modelAsset) {

        if (!InstrumentType.isTaxDeferred(modelAsset.instrument))
            return;

        if (this.activeUser.rmdRequired()) {
            // if the user is 73 or older, then they must take RMDs
            let rmd = activeTaxTable.calculateMonthlyRMD(currentDateInt, this.activeUser, modelAsset);
            modelAsset.addToMetric(Metric.RMD, rmd);
        }

    }

    calculatePreTaxContributions(modelAsset) {

        let total401KContribution = Currency.zero();
        let totalIRAContribution = Currency.zero();

        if (InstrumentType.isWorkingIncome(modelAsset.instrument)) {

            for (let fundTransfer of modelAsset.fundTransfers) {

                fundTransfer.bind(modelAsset, this.modelAssets);
                if (!fundTransfer.toModel) continue;

                let toModelInstrument = fundTransfer.toModel.instrument;
                let contribution = Currency.zero();

                if (InstrumentType.isTaxDeferred(toModelInstrument)) {

                    delete fundTransfer.approvedAmount;
                    fundTransfer.useGrossIncome = true;
                    contribution = fundTransfer.calculate();

                    if (InstrumentType.is401K(toModelInstrument)) {

                        let contributionLimit = activeTaxTable.four01KContributionLimit(this.activeUser);
                        if (this.yearly.four01KContribution.amount + this. monthly.four01KContribution.amount + total401KContribution.amount + contribution.amount > contributionLimit.amount) {
                            contribution = new Currency(contributionLimit.amount - this.yearly.four01KContribution.amount - this.monthly.four01KContribution.amount - total401KContribution.amount);
                        }

                        fundTransfer.fromModel.four01KContributionCurrency.add(contribution);
                        total401KContribution.add(contribution);

                    }

                    else if (InstrumentType.isIRA(toModelInstrument) && !InstrumentType.isRothIRA(toModelInstrument)) {

                        let contributionLimit = activeTaxTable.iraContributionLimit(this.activeUser);
                        if (this.yearly.tradIRAContribution.amount + this. monthly.tradIRAContribution.amount + totalIRAContribution.amount + contribution.amount > contributionLimit.amount) {
                            contribution = new Currency(totalIRAContributionLimit.amount - this.yearly.tradIRAContribution.amount - this.monthly.tradIRAContribution.amount - totalIRAContribution.amount);
                        }

                        fundTransfer.fromModel.tradIRAContributionCurrency.add(contribution);
                        totalIRAContribution.add(contribution);

                    }

                    // Set this because we know this is a tax deferred (pretax) approved amout. Don't want to approve an amount outside this lane!
                    fundTransfer.approvedAmount = contribution.copy();

                }
            }
        }

        this.monthly.four01KContribution.add(total401KContribution);
        this.monthly.tradIRAContribution.add(totalIRAContribution);

    }

    // Handle the Roth contribution specifically because it is a special case
    // The Roth contribution limit requires an account of traditional IRA contribution
    calculateRothIRAContribution(modelAsset) {

        if (InstrumentType.isWorkingIncome(modelAsset.instrument)) {

            let contributionLimit = activeTaxTable.iraContributionLimit(this.activeUser);
            let totalContribution = Currency.zero();

            for (let fundTransfer of modelAsset.fundTransfers) {

                fundTransfer.bind(modelAsset, this.modelAssets);
                if (!fundTransfer.toModel) continue;

                let toModelInstrument = fundTransfer.toModel.instrument;
                let contribution = Currency.zero();

                if (InstrumentType.isRothIRA(toModelInstrument)) {

                    delete fundTransfer.approvedAmount;
                    fundTransfer.useNetIncome = true;
                    contribution = fundTransfer.calculate();

                    if (this.yearly.tradIRAContribution.amount + this.yearly.rothIRAContribution.amount +
                        this.monthly.tradIRAContribution.amount + this.monthly.rothIRAContribution.amount +
                        totalContribution.amount + contribution.amount > contributionLimit.amount) {

                            contribution = new Currency(contributionLimit.amount -
                                this.yearly.tradIRAContribution.amount - this.yearly.rothIRAContribution.amount -
                                this.monthly.tradIRAContribution.amount - this.monthly.rothIRAContribution.amount -
                                totalContribution.amount - contribution.amount);
                            }

                    modelAsset.rothIRAContributionCurrency.add(contribution);
                    fundTransfer.approvedAmount = contribution.copy();

                    totalContribution.add(contribution);
                    this.monthly.rothIRAContribution.add(totalContribution);

                }
            }
        }

    }

    calculatePostTaxContributions(modelAsset) {

        if (!InstrumentType.isMonthlyIncome(modelAsset.instrument)) return;

        let totalContribution = Currency.zero();

        for (let fundTransfer of modelAsset.fundTransfers) {

            fundTransfer.bind(modelAsset, this.modelAssets);
            if (!fundTransfer.toModel) continue;

            let toModelInstrument = fundTransfer.toModel.instrument;
            let contribution = Currency.zero();

            if (!InstrumentType.isTaxDeferred(toModelInstrument)) {

                delete fundTransfer.approvedAmount;
                fundTransfer.useNetIncome = true;
                contribution = fundTransfer.calculate();

                if (totalContribution.amount + contribution.amount > modelAsset.netIncomeCurrency.amount) {

                    contribution = new Currency(modelAsset.netIncomeCurrency.amount - totalContribution.amount);
                    fundTransfer.fromModel.rothIRAContributionCurrency.add(contribution);
                    totalContribution.add(contribution);
                    fundTransfer.approvedAmount = contribution.copy();

                }

                totalContribution.add(contribution);
            }
        }

        console.assert(totalContribution.amount <= modelAsset.netIncomeCurrency.amount,
            `Post-tax contributions (${totalContribution.amount}) exceed net income (${modelAsset.netIncomeCurrency.amount}) for ${modelAsset.displayName}`);

    }

    applyPreTaxTransfers(modelAsset) {

        if (InstrumentType.isMonthlyIncome(modelAsset.instrument)) {

            if (modelAsset.fundTransfers?.length > 0) {

                let runningTransferAmount = Currency.zero();

                for (const fundTransfer of modelAsset.fundTransfers) {

                    fundTransfer.bind(modelAsset, this.modelAssets);
                    if (!fundTransfer.toModel) continue;

                    if (InstrumentType.isTaxDeferred(fundTransfer.toModel.instrument)) {

                        // should always be an approved amount?
                        if (fundTransfer.approvedAmount) {
                            runningTransferAmount.add(fundTransfer.approvedAmount);
                        } else {
                            runningTransferAmount.add(fundTransfer.calculate());
                        }

                        fundTransfer.execute();
                    }
                }

                this.monthly.preTaxContribution.add(runningTransferAmount);
            }
        }

        // no reconcilation at this point since we are pre-tax
    }

    applyPostTaxTransfers(modelAsset) {

        if (InstrumentType.isMonthlyIncome(modelAsset.instrument)) {

            let runningTransferAmount = Currency.zero();

            if (modelAsset.fundTransfers?.length > 0) {

                for (const fundTransfer of modelAsset.fundTransfers) {

                    fundTransfer.bind(modelAsset, this.modelAssets);
                    if (!fundTransfer.toModel) continue;

                    // This was handled by pre tax calculations and transfers
                    if (!InstrumentType.isTaxDeferred(fundTransfer.toModel.instrument)) {

                        // should always be an approved amount?
                        if (fundTransfer.approvedAmount) {
                            runningTransferAmount.add(fundTransfer.approvedAmount);
                        } else {
                            runningTransferAmount.add(fundTransfer.calculate());
                        }

                        fundTransfer.execute();
                    }

                }
            }

            if (runningTransferAmount.amount < modelAsset.netIncomeCurrency.amount) {
                let delta = new Currency(modelAsset.netIncomeCurrency.amount - runningTransferAmount.amount);
                const note = `Remaining income from ${modelAsset.displayName}`;
                modelAsset.debit(delta, note);
                this.router.creditToTaxable(delta, note);
            }

        }

        // no reconcilation at this point since we are pre-tax
    }

}
