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
import { Metric } from '../metric.js';
import { FundTransfer } from '../fund-transfer.js';
import { logger, LogCategory } from '../utils/logger.js';
import { EventType, ShortfallOrigin } from '../sim-event.js';
import { withTrace, TraceKind } from '../trace.js';
import { taxableBasis } from '../tax-basis.js';
import { ContributionKind, TaxOwner } from '../taxes.js';

export class PayrollEngine {

    constructor(modelAssets, monthly, yearly, activeUser, taxEngine, config) {
        this.modelAssets = modelAssets;
        this.config = config;   // Spec 9 step 2 — carries the run's tax table
        this.monthly = monthly;
        this.yearly = yearly;
        this.activeUser = activeUser;
        this.taxEngine = taxEngine;

        // Per-income-asset pre-tax payroll deductions (401K + trad IRA) for the
        // current Day-1 pass, written by calculatePreTaxContributions and
        // consumed (deleted) by applyNetIncome. This is engine working state,
        // not an asset metric: contribution metrics live on the DESTINATION
        // account only, so reading them off a WORKING_INCOME asset resolves to
        // NULL_METRIC's frozen zero. Keyed by ModelAsset identity.
        this.preTaxDeductions = new Map();
    }

    applyPreTaxCalculations(modelAsset, currentDateInt) {
        // FICA and the pre-tax contribution clamps land here, so this is the
        // scope that makes "why was my 401K contribution capped?" answerable.
        // NOTE: payroll is a pipeline of passes over ALL assets rather than a
        // per-asset sequence (household tax needs every income first), so an
        // income asset opens several PAYROLL scopes per month rather than one.
        return withTrace(TraceKind.PAYROLL, `Payroll: ${modelAsset.displayName}`, currentDateInt,
            () => this.#applyPreTaxCalculationsInScope(modelAsset, currentDateInt));
    }

    #applyPreTaxCalculationsInScope(modelAsset, currentDateInt) {

        if (InstrumentType.isMonthlyIncome(modelAsset.instrument)) {

            // Booking happens once, in addResult: wages route to
            // selfIncome/employedIncome, benefits to socialSecurityIncome/
            // pensionIncome via their RetirementIncomeResult.
            let result = modelAsset.applyMonthly();
            this.monthly.addResult(result);

            if (!InstrumentType.isRetirementIncome(modelAsset.instrument)) {

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

                // Owner is explicit at both sites so the per-person spec adds a
                // second identity rather than rewriting this call.
                const owner = TaxOwner.PRIMARY;
                let withholding = this.config.taxTable.calculateFICATax(modelAsset.isSelfEmployed, modelAsset.incomeCurrency.copy(), owner);
                this.config.taxTable.addYearlySocialSecurity(withholding.socialSecurityTax, owner);

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
        const { ordinaryTaxable } = taxableBasis(this.monthly, this.activeUser, { annualise: true });
        let householdTax = this.config.taxTable.calculateYearlyIncomeTax(ordinaryTaxable).divide(12.0);

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
        return withTrace(TraceKind.PAYROLL, `Withholding: ${modelAsset.displayName}`,
            modelAsset.currentDateInt,
            () => this.#applyNetIncomeInScope(modelAsset, householdTax, totalWorkingIncome));
    }

    /**
     * Withhold federal tax ON ARRIVAL from Social Security or a pension.
     *
     * WHY ON ARRIVAL, AND NOT THE 4b SHAPE
     * ------------------------------------
     * IRA/401(K) withholding debits the account after the fact. That cannot work
     * here: these are FLOWS, and ModelAsset#transact short-circuits for flow
     * instruments — it records the event, changes no balance, and returns
     * spillover ZERO, so the caller is told the money was collected when nothing
     * moved. Reducing what lands is the only shape that actually withholds, and
     * it is what payroll already does for a salary a few lines below.
     *
     * NO GROSS-UP. A balance grossed up because the withheld dollars are
     * themselves a distribution; a flow's benefit is already gross. Adding to it
     * would inflate taxable income and RAISE the household's bill — the failure
     * this spec's predictions are built to catch. SOCIAL_SECURITY_INCOME and
     * PENSION_INCOME are booked by the behavior and are not touched here.
     *
     * RATES DIFFER BY INSTRUMENT ON PURPOSE. A pension mirrors Form W-4P, whose
     * default is to withhold. Social Security mirrors Form W-4V, which is
     * elective with NO default and which most recipients never file — so its
     * rate is 0 unless someone chooses otherwise, and SS stays unattributed by
     * default. Modelling a withholding the household never elected would be
     * inventing policy.
     */
    #withholdOnRetirementIncome(modelAsset) {

        const isPension = InstrumentType.isPension(modelAsset.instrument);
        const rate = isPension
            ? this.config.pensionWithholdingRate
            : this.config.socialSecurityWithholdingRate;

        if (!(rate > 0)) return;

        // The month's GROSS benefit, read from the metric the behavior just
        // booked rather than from netIncomeCurrency — which other passes may
        // already have drawn against.
        const gross = isPension
            ? modelAsset.getMetricAmount(Metric.PENSION_INCOME)
            : modelAsset.getMetricAmount(Metric.SOCIAL_SECURITY_INCOME);
        if (!(gross > 0)) return;

        const withheld = new Currency(gross * rate);

        // Less arrives. netIncomeCurrency is what applyPostTaxTransfers sweeps to
        // the backstop, so this is the whole behavioural change.
        modelAsset.netIncomeCurrency.subtract(withheld);

        // Negative on the asset's own ledger, the convention every tax metric
        // follows. INCOME_TAX → FEDERAL_TAXES → TAXES populate by DAG, and those
        // metrics had to be registered on these behaviors first — before that
        // they resolved to NULL_METRIC and this write was a silent no-op.
        modelAsset.addToMetric(Metric.WITHHELD_INCOME_TAX, withheld.copy().flipSign());

        // Household books, plus the INCOME_TAX_WITHHOLDING event. Counted as
        // already collected so the monthly true-up does not charge it twice.
        this.taxEngine.recordIncomeTaxWithholding(modelAsset, withheld);

        logger.log(LogCategory.TAX,
            `withholdOnRetirementIncome: ${modelAsset.displayName} gross ${gross.toFixed(2)} ` +
            `at ${(rate * 100).toFixed(0)}% withheld ${withheld.toString()}`);
    }

    #applyNetIncomeInScope(modelAsset, householdTax, totalWorkingIncome) {

        if (InstrumentType.isRetirementIncome(modelAsset.instrument)) {
            return this.#withholdOnRetirementIncome(modelAsset);
        }

        if (!InstrumentType.isWorkingIncome(modelAsset.instrument)) {
            return;
        }

        let netIncome = modelAsset.incomeCurrency.copy();

        // subtract per-asset FICA (Social Security + Medicare, stored as negative values on model asset)
        netIncome.add(modelAsset.socialSecurityTaxCurrency);  // negative, so add subtracts
        netIncome.add(modelAsset.medicareTaxCurrency);

        // Subtract this asset's pre-tax 401K/trad-IRA deferrals, computed and
        // capped earlier in calculatePreTaxContributions. Deliberately NOT read
        // from modelAsset.four01KContributionCurrency: contribution metrics are
        // only registered on the destination account's behavior, so on a
        // WORKING_INCOME asset those getters return NULL_METRIC's frozen zero —
        // a silent no-op that previously let the full unreduced paycheck flow
        // downstream while the 401K was also credited.
        const preTaxDeduction = this.preTaxDeductions.get(modelAsset);
        this.preTaxDeductions.delete(modelAsset); // consume — never reuse across months
        if (preTaxDeduction && preTaxDeduction.amount > 0) {
            netIncome.subtract(preTaxDeduction);
        }

        // Proportional share of household income tax for this asset
        const proportion = totalWorkingIncome.amount > 0
            ? modelAsset.incomeCurrency.amount / totalWorkingIncome.amount
            : 0;
        const assetTax = new Currency(householdTax.amount * proportion);

        netIncome.subtract(assetTax);

        // Negative == money out, the convention every other tax metric follows
        // (recordFICAWithholding flips in place before its metric write). This
        // site used to record the raw positive amount, so once the DAG landed
        // the two signs cancelled inside INCOME_TAX and a worker withholding
        // $1,636 reported +$412 of tax. assetTax must stay positive for the
        // netIncome arithmetic above and for recordIncomeTaxWithholding below,
        // so flip a copy.
        const taxMetric = modelAsset.isSelfEmployed
            ? Metric.ESTIMATED_INCOME_TAX
            : Metric.WITHHELD_INCOME_TAX;
        modelAsset.addToMetric(taxMetric, assetTax.copy().flipSign());

        // Deferrals exceeding after-tax pay are a configuration problem the
        // pipeline can't fully honor: the 401K/IRA transfers have already
        // executed for the full amount. Clamp to zero so downstream post-tax
        // clamps can't compute negative contributions (which would execute
        // reverse transfers), and surface the gap rather than hiding it.
        if (netIncome.amount < 0) {
            logger.log(LogCategory.SANITY,
                `applyNetIncome: ${modelAsset.displayName} pre-tax deferrals exceed after-tax pay by ${netIncome.copy().flipSign().toString()}; net income clamped to $0`);
            netIncome.zero();
        }

        // INCOME_TAX populated by DAG: WITHHELD/ESTIMATED_INCOME_TAX → INCOME_TAX
        modelAsset.netIncomeCurrency = netIncome;

        this.taxEngine.recordIncomeTaxWithholding(modelAsset, assetTax);

    }

    calculateRMDs(currentDateInt, modelAsset) {

        if (!InstrumentType.isTaxDeferred(modelAsset.instrument))
            return;

        if (this.activeUser.rmdRequired()) {
            // if the user is 73 or older, then they must take RMDs
            let rmd = this.config.taxTable.calculateMonthlyRMD(currentDateInt, this.activeUser, modelAsset);
            modelAsset.addToMetric(Metric.RMD, rmd);
        }

    }

    /**
     * Record that an IRS annual limit reduced a contribution below what the
     * user's transfer asked for.
     *
     * Without this the clamp leaves no trace at all: the books show a smaller
     * contribution and nothing anywhere says why, so "my 15% election only put
     * in $8,000" is unanswerable. The absence of money IS the event, so this is
     * an `info` memo — no cash moved that otherwise would have, and it must stay
     * out of reconciliation. Same shape and reasoning as
     * FundTransfer.reportUnfunded.
     *
     * Lands on the DESTINATION account, where the contribution metrics live and
     * where someone reading a too-small balance goes looking.
     *
     * @param {ModelAsset} toModel   destination account
     * @param {Currency}   requested what the transfer computed before the clamp
     * @param {Currency}   allowed   what the limit left room for (may be <= 0)
     * @param {string}     limitName human-readable limit, e.g. 'annual 401(k) limit'
     */
    recordContributionCap(toModel, requested, allowed, limitName) {
        if (!toModel || !requested) return;
        // A negative `allowed` means the limit was already exhausted; nothing was
        // granted, so the whole request is the shortfall.
        const granted = Math.max(0, allowed?.amount ?? 0);
        const shortfall = requested.amount - granted;
        if (shortfall <= 0.01) return;

        logger.log(LogCategory.SANITY,
            `Contribution capped: ${toModel.displayName} requested ${requested.toString()}, ` +
            `${limitName} allowed ${granted.toFixed(2)}`);
        toModel.recordEvent(EventType.CONTRIBUTION_CAPPED, new Currency(-shortfall), { data: { limitName } });
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

                        let contributionLimit = this.config.taxTable.limitFor(ContributionKind.FOUR01K, this.activeUser);
                        if (this.yearly.four01KContribution.amount + this. monthly.four01KContribution.amount + total401KContribution.amount + contribution.amount > contributionLimit.amount) {
                            const requested = contribution.copy();
                            contribution = new Currency(contributionLimit.amount - this.yearly.four01KContribution.amount - this.monthly.four01KContribution.amount - total401KContribution.amount);
                            this.recordContributionCap(fundTransfer.toModel, requested, contribution, 'annual 401(k) limit');
                        }

                        total401KContribution.add(contribution);

                    }

                    else if (InstrumentType.isIRA(toModelInstrument) && !InstrumentType.isRothIRA(toModelInstrument)) {

                        let contributionLimit = this.config.taxTable.limitFor(ContributionKind.IRA, this.activeUser);
                        if (this.yearly.tradIRAContribution.amount + this. monthly.tradIRAContribution.amount + totalIRAContribution.amount + contribution.amount > contributionLimit.amount) {
                            const requested = contribution.copy();
                            contribution = new Currency(contributionLimit.amount - this.yearly.tradIRAContribution.amount - this.monthly.tradIRAContribution.amount - totalIRAContribution.amount);
                            this.recordContributionCap(fundTransfer.toModel, requested, contribution, 'annual IRA limit');
                        }

                        totalIRAContribution.add(contribution);

                    }

                    // Set this because we know this is a tax deferred (pretax) approved amout. Don't want to approve an amount outside this lane!
                    fundTransfer.approvedAmount = contribution.copy();

                }
            }

            // Hand this asset's total payroll deduction to applyNetIncome.
            // The transfers themselves execute in applyPreTaxTransfers, which
            // credits the destination accounts — the paycheck must shrink by
            // the same total or every deferral is double-counted (401K funded
            // AND full net income swept to savings).
            this.preTaxDeductions.set(modelAsset,
                new Currency(total401KContribution.amount + totalIRAContribution.amount));
        }

        this.monthly.four01KContribution.add(total401KContribution);
        this.monthly.tradIRAContribution.add(totalIRAContribution);

    }

    // Handle the Roth contribution specifically because it is a special case:
    // Roth shares the combined annual IRA limit with traditional IRA, so the
    // clamp must account for both types across the year, the month, and
    // earlier transfers in this loop.
    calculateRothIRAContribution(modelAsset) {

        if (!InstrumentType.isWorkingIncome(modelAsset.instrument)) return;

        const contributionLimit = this.config.taxTable.limitFor(ContributionKind.IRA, this.activeUser);
        let totalContribution = Currency.zero();

        for (let fundTransfer of modelAsset.fundTransfers) {

            fundTransfer.bind(modelAsset, this.modelAssets);
            if (!fundTransfer.toModel) continue;
            if (!InstrumentType.isRothIRA(fundTransfer.toModel.instrument)) continue;

            delete fundTransfer.approvedAmount;
            fundTransfer.useNetIncome = true;
            let contribution = fundTransfer.calculate();

            // Headroom under the shared IRA limit. The PROPOSED contribution is
            // not part of "used" — subtracting it here (the old formula) made
            // the clamp negative every time it triggered, approving a reverse
            // transfer instead of a capped one.
            const used = this.yearly.tradIRAContribution.amount + this.yearly.rothIRAContribution.amount
                       + this.monthly.tradIRAContribution.amount + this.monthly.rothIRAContribution.amount
                       + totalContribution.amount;
            const remaining = Math.max(0, contributionLimit.amount - used);
            if (contribution.amount > remaining) {
                const requested = contribution.copy();
                contribution = new Currency(remaining);
                this.recordContributionCap(fundTransfer.toModel, requested, contribution,
                    'shared annual IRA limit');
            }

            // The clamp is only real if it survives to execution:
            // applyPostTaxTransfers executes approvedAmount verbatim, and
            // calculatePostTaxContributions must not recalculate this transfer.
            fundTransfer.approvedAmount = contribution.copy();
            totalContribution.add(contribution);
        }

        // Book the month's Roth contributions once, after the loop. Adding the
        // RUNNING total per iteration (the old code) booked earlier transfers
        // again for every later one.
        this.monthly.rothIRAContribution.add(totalContribution);

    }

    calculatePostTaxContributions(modelAsset) {

        if (!InstrumentType.isMonthlyIncome(modelAsset.instrument)) return;

        let totalContribution = Currency.zero();

        for (let fundTransfer of modelAsset.fundTransfers) {

            fundTransfer.bind(modelAsset, this.modelAssets);
            if (!fundTransfer.toModel) continue;

            const toModelInstrument = fundTransfer.toModel.instrument;

            // Pre-tax lane: computed against gross income in
            // calculatePreTaxContributions; not part of the net-income budget.
            if (InstrumentType.isTaxDeferred(toModelInstrument)) continue;

            // IRS: retirement income cannot contribute to tax-advantaged
            // accounts. applyPostTaxTransfers skips these at execution; clear
            // any leftover approval so it can't leak into other calculations.
            if (InstrumentType.isRetirementIncome(modelAsset.instrument) &&
                InstrumentType.isTaxFree(toModelInstrument)) {
                delete fundTransfer.approvedAmount;
                continue;
            }

            let contribution;
            if (InstrumentType.isRothIRA(toModelInstrument)) {
                // Roth transfers arrive here already computed AND capped
                // against the shared IRA annual limit by
                // calculateRothIRAContribution. Recalculating from scratch
                // (the old `delete approvedAmount` + calculate()) silently
                // discarded that cap — the limit was enforced in the books but
                // never on the executed cash flows.
                contribution = fundTransfer.approvedAmount?.copy() ?? fundTransfer.calculate();
            } else {
                delete fundTransfer.approvedAmount;
                fundTransfer.useNetIncome = true;
                contribution = fundTransfer.calculate();
            }

            // Net income is a shared budget consumed sequentially: each
            // transfer gets at most what the earlier ones left behind. Floor
            // at zero — the old unfloored shortfall math produced NEGATIVE
            // approved amounts, which execute() happily ran as reverse
            // transfers pulling money back OUT of the target accounts.
            const remainingNetIncome = modelAsset.netIncomeCurrency.amount - totalContribution.amount;
            if (contribution.amount > remainingNetIncome) {
                const clamped = new Currency(Math.max(0, remainingNetIncome));
                if (InstrumentType.isRothIRA(toModelInstrument)) {
                    // The Roth booking happened at the pre-clamp amount in
                    // calculateRothIRAContribution — shrink the books by the
                    // same amount the cash flow shrank.
                    this.monthly.rothIRAContribution.subtract(contribution.minus(clamped));
                }
                contribution = clamped;
                fundTransfer.approvedAmount = contribution.copy();
            }

            // Exactly one add per transfer. The old shortfall branch added the
            // clamped amount AND fell through to the unconditional add,
            // double-counting it — every transfer after a clamp then saw a
            // budget that was already (incorrectly) exhausted.
            totalContribution.add(contribution);
        }

    }

    applyPreTaxTransfers(modelAsset) {

        if (InstrumentType.isMonthlyIncome(modelAsset.instrument)) {

            if (modelAsset.fundTransfers?.length > 0) {

                let runningTransferAmount = Currency.zero();

                for (const fundTransfer of modelAsset.fundTransfers) {

                    fundTransfer.bind(modelAsset, this.modelAssets);
                    if (!fundTransfer.toModel) continue;

                    if (InstrumentType.isTaxDeferred(fundTransfer.toModel.instrument)) {

                        const contribution = fundTransfer.approvedAmount || fundTransfer.calculate();
                        runningTransferAmount.add(contribution);

                        fundTransfer.execute();

                        // Record contribution on the destination (capital) asset
                        if (InstrumentType.is401K(fundTransfer.toModel.instrument)) {
                            fundTransfer.toModel.addToMetric(Metric.FOUR_01K_CONTRIBUTION, contribution);
                        } else if (InstrumentType.isIRA(fundTransfer.toModel.instrument)) {
                            fundTransfer.toModel.addToMetric(Metric.TRAD_IRA_CONTRIBUTION, contribution);
                        }
                    }
                }

                // preTaxContribution is now a rollup method on FP (derived from leaves)
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

                        // IRS: retirement income cannot contribute to Roth IRA (or any tax-advantaged account)
                        if (InstrumentType.isRetirementIncome(modelAsset.instrument) &&
                            InstrumentType.isTaxFree(fundTransfer.toModel.instrument)) {
                            continue;
                        }

                        const contribution = fundTransfer.approvedAmount || fundTransfer.calculate();
                        runningTransferAmount.add(contribution);

                        fundTransfer.execute();

                        // Record contribution on the destination (capital) asset
                        if (InstrumentType.isRothIRA(fundTransfer.toModel.instrument)) {
                            fundTransfer.toModel.addToMetric(Metric.ROTH_IRA_CONTRIBUTION, contribution);
                        }
                    }

                }
            }

            if (runningTransferAmount.amount < modelAsset.netIncomeCurrency.amount) {
                let delta = new Currency(modelAsset.netIncomeCurrency.amount - runningTransferAmount.amount);
                const target = FundTransfer.resolveFunding(this.modelAssets);
                if (target) {
                    FundTransfer.system(modelAsset, target, delta).execute();
                } else {
                    FundTransfer.reportUnfunded(modelAsset, delta, 'unallocated take-home pay (nowhere to deposit)', ShortfallOrigin.STANDALONE);
                }
            }

        }

        // no reconcilation at this point since we are pre-tax
    }

}
