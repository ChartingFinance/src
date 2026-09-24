/**
 * expense-engine.js
 *
 * The day-30 expense pipeline: expense fund transfers, the shortfall
 * gross-up, RMD enforcement, and asset growth.
 */

import { Currency } from '../utils/currency.js';
import { InstrumentType } from '../instruments/instrument.js';
import { Metric } from '../metric.js';
import { FundTransferOneSided, FundTransfer } from '../fund-transfer.js';
import { logger, LogCategory } from '../utils/logger.js';
import { EventType, ShortfallOrigin } from '../sim-event.js';
import { withTrace, TraceKind } from '../trace.js';
import { taxableBasis } from '../tax-basis.js';

export class ExpenseEngine {

    constructor(modelAssets, monthly, activeUser, config) {
        this.modelAssets = modelAssets;
        this.config = config;   // Spec 9 step 2 — carries the run's tax table
        this.monthly = monthly;
        this.activeUser = activeUser;
    }

    // ── Day 30: Expenses ─────────────────────────────────────────────

    applyExpenseTransfers(modelAsset, currentDateInt) {
        // Root of an expense's causal chain: "Pay Living Expenses". Every
        // transfer, clamp, spillover and shortfall that follows hangs off this.
        return withTrace(TraceKind.EXPENSE, `Pay ${modelAsset.displayName}`, currentDateInt,
            () => this.#applyExpenseTransfersInScope(modelAsset, currentDateInt));
    }

    #applyExpenseTransfersInScope(modelAsset, currentDateInt) {

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

                // Book tax consequences against what each account actually
                // supplied. toAssetChange is the requested withdrawal; if the
                // funding account clamped at $0, execute() sourced the rest
                // from a fallback and reports that leg separately.
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

            // The transfers covered part of the expense: draw the rest from the
            // funding backstop, grossed up for the tax the draw realises.
            const netShortfall = new Currency(runningExpenseAmount.amount - modelAssetExpense.amount);
            if (netShortfall.amount > 0) {
                logger.log(LogCategory.TRANSFER, `ExpenseEngine.applyExpenseTransfers: ${modelAsset.displayName} expensing ${netShortfall.toString()} from the funding backstop (Grossed Up)`);

                const targetAsset = FundTransfer.resolveFunding(this.modelAssets);
                if (targetAsset) {
                    const grossWithdrawal = this.calculateGrossWithdrawal(netShortfall, targetAsset);
                    const settled = this.settleFromBackstop(
                        modelAsset, targetAsset, grossWithdrawal,
                        { type: EventType.GROSS_UP, data: { forAsset: modelAsset.displayName, overflow: true } });

                    this.#bookTaxProvision(targetAsset, modelAsset,
                        grossWithdrawal.amount - netShortfall.amount);
                } else {
                    FundTransfer.reportUnfunded(modelAsset, netShortfall, 'expense overflow', ShortfallOrigin.STANDALONE);
                }
            }
        } else {
            // No transfer covers the expense: draw all of it from the funding
            // backstop, grossed up.
            const netShortfall = modelAssetExpense.copy().flipSign();
            logger.log(LogCategory.TRANSFER, `ExpenseEngine.applyExpenseTransfers: ${modelAsset.displayName} expensing ${netShortfall.toString()} from the funding backstop (Grossed Up)`);

            const targetAsset = FundTransfer.resolveFunding(this.modelAssets);
            if (targetAsset) {
                const grossWithdrawal = this.calculateGrossWithdrawal(netShortfall, targetAsset);
                const settled = this.settleFromBackstop(
                    modelAsset, targetAsset, grossWithdrawal,
                    { type: EventType.GROSS_UP, data: { forAsset: modelAsset.displayName, overflow: false } });

                this.#bookTaxProvision(targetAsset, modelAsset,
                    grossWithdrawal.amount - netShortfall.amount);
            } else {
                FundTransfer.reportUnfunded(modelAsset, netShortfall, 'expense', ShortfallOrigin.STANDALONE);
            }
        }

    }

    applyMortgageTransfers(modelAsset, currentDateInt) {
        return withTrace(TraceKind.MORTGAGE, `Pay ${modelAsset.displayName}`, currentDateInt,
            () => this.#applyMortgageTransfersInScope(modelAsset, currentDateInt));
    }

    #applyMortgageTransfersInScope(modelAsset, currentDateInt) {

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

        // Backstop: whatever the user did not route explicitly
        if (remaining.amount > 0) {
            let fundingSource = FundTransfer.resolveFunding(this.modelAssets);
            if (fundingSource) {
                let preFlight = new FundTransferOneSided(null, remaining);
                preFlight.fromModel = modelAsset;
                preFlight.toModel = fundingSource;
                preFlights.push(preFlight);
            } else {
                FundTransfer.reportUnfunded(modelAsset, remaining, 'mortgage payment', ShortfallOrigin.STANDALONE);
            }
        }

        // One-sided withdrawal: MortgageBehavior already reduced the mortgage
        // balance (principal) and recorded interest. Only debit the funding source.
        for (const oneSided of preFlights) {
            const event = { type: EventType.SETTLEMENT, data: {
                from: modelAsset.displayName, to: oneSided.toModel.displayName, label: 'monthly' } };
            const settled = FundTransfer.settleOneSided(oneSided, event, this.modelAssets);
            this.monthly.recordTransfer(oneSided.toModel.instrument, settled.supplied, settled.realizedGain);
            if (settled.spillover.amount > 0 && settled.spilloverInstrument) {
                this.monthly.recordTransfer(settled.spilloverInstrument, settled.spillover, settled.spilloverGain);
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
        return withTrace(TraceKind.CARRYING_COST, `${modelAsset.displayName} ${label}`, currentDateInt,
            () => this.#debitCarryingCostInScope(modelAsset, cost, label, currentDateInt));
    }

    #debitCarryingCostInScope(modelAsset, cost, label, currentDateInt) {
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
            let fundingSource = FundTransfer.resolveFunding(this.modelAssets);
            if (fundingSource) {
                let preFlight = new FundTransferOneSided(null, remaining);
                preFlight.fromModel = modelAsset;
                preFlight.toModel = fundingSource;
                preFlights.push(preFlight);
            } else {
                FundTransfer.reportUnfunded(modelAsset, remaining, label, ShortfallOrigin.STANDALONE);
            }
        }

        for (const oneSided of preFlights) {
            const event = { type: EventType.SETTLEMENT, data: {
                from: modelAsset.displayName, to: oneSided.toModel.displayName, label } };
            const settled = FundTransfer.settleOneSided(oneSided, event, this.modelAssets);
            this.monthly.recordTransfer(oneSided.toModel.instrument, settled.supplied, settled.realizedGain);
            if (settled.spillover.amount > 0 && settled.spilloverInstrument) {
                this.monthly.recordTransfer(settled.spilloverInstrument, settled.spillover, settled.spilloverGain);
            }
        }
    }

    // ── Day 30: RMDs ─────────────────────────────────────────────────

    ensureRMDs(modelAsset) {
        return withTrace(TraceKind.RMD, `Required distribution from ${modelAsset.displayName}`,
            modelAsset.currentDateInt,
            () => this.#ensureRMDsInScope(modelAsset));
    }

    #ensureRMDsInScope(modelAsset) {

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

            // Execute first, then book what actually moved: the target may be
            // missing, and a spilled portion came from another account.
            const target = FundTransfer.resolveFunding(this.modelAssets);
            if (!target) {
                logger.log(LogCategory.SANITY,
                    `ExpenseEngine.ensureRMDs: no backstop account to receive ${modelAsset.displayName} RMD of ${remains.toString()}`);
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

        }

    }

    // ── Helpers ──────────────────────────────────────────────────────

    /**
     * Draw from a funding account through settleOneSided rather than a raw
     * debit.
     *
     * settleOneSided clamps the account at $0, re-sources the shortfall, reports
     * what nothing can cover, and books the realized gain itself — callers must
     * not book it again.
     *
     * @param {ModelAsset} owingAsset  the expense/obligation this pays for
     * @param {ModelAsset} fundingAsset the account being drawn
     */
    settleFromBackstop(owingAsset, fundingAsset, amount, event) {
        const oneSided = new FundTransferOneSided(null, amount);
        oneSided.fromModel = owingAsset;
        oneSided.toModel = fundingAsset;

        const settled = FundTransfer.settleOneSided(oneSided, event, this.modelAssets);

        this.monthly.recordTransfer(fundingAsset.instrument, settled.supplied, settled.realizedGain);
        if (settled.spillover.amount > 0 && settled.spilloverInstrument) {
            this.monthly.recordTransfer(settled.spilloverInstrument, settled.spillover, settled.spilloverGain);
        }
        return settled;
    }

    /**
     * Record the part of a gross-up that was withdrawn to cover tax.
     *
     * Booked negative, like every tax field; the annual true-up relies on the
     * sign (tests/tax-sign-convention.mjs). Recorded whenever the premium is
     * non-zero, gain or no gain — calculateGrossWithdrawal makes it zero when
     * nothing is realised.
     */
    #bookTaxProvision(fundingAsset, forAsset, premiumAmount) {
        if (!(premiumAmount > 0.005)) return;

        const provision = new Currency(premiumAmount).flipSign();
        this.monthly.estimatedTaxes.add(provision);
        fundingAsset.addToMetric(Metric.ESTIMATED_INCOME_TAX, provision.copy());
        fundingAsset.recordEvent(EventType.TAX_PROVISION, provision.copy(),
            { data: { forAsset: forAsset.displayName } });
    }

    calculateGrossWithdrawal(netShortfall, modelAsset) {
        // Only taxable accounts realize a gain on withdrawal (see ModelAsset.#transact).
        // Cash, savings and bonds have no basis to speak of, so getUnrealizedGainRatio()
        // reads 1.0 on them — grossing up against that would over-withdraw for a tax
        // that never comes due.
        if (!InstrumentType.isTaxableAccount(modelAsset.instrument)) return netShortfall.copy();

        // 1. Estimate current marginal LTCG bracket based strictly on base income (W-2, etc)
        const { ordinaryTaxable: taxableIncome } =
            taxableBasis(this.monthly, this.activeUser, { annualise: true, taxTable: this.config.taxTable });

        // Quick heuristic for marginal LTCG rate (0%, 15%, 20%)
        const ltcgRate = this.config.taxTable.getMarginalLTCGRate(taxableIncome);

        // 2. Solve for the withdrawal whose after-tax proceeds are the shortfall.
        //
        // The gain is taken from ModelAsset.planWithdrawal — the rule the draw
        // will actually apply (this month's deposits first, at zero gain) — not
        // from the account's overall gain ratio. gain(W) is linear once W
        // exceeds the fresh deposits, so two probes give it exactly: no
        // iteration, and no second copy of the rule.
        const atShortfall = modelAsset.planWithdrawal(netShortfall);
        if (atShortfall.realizedGain.amount <= 0) return netShortfall.copy();

        const probe = new Currency(netShortfall.amount + 1);
        const slope = modelAsset.planWithdrawal(probe).realizedGain.amount
                    - atShortfall.realizedGain.amount;
        const intercept = atShortfall.realizedGain.amount - slope * netShortfall.amount;

        // 3. W = X + t * gain(W), solved: W = (X + t*intercept) / (1 - t*slope)
        const denominator = 1.0 - (ltcgRate * slope);

        // A non-positive denominator means the marginal tax on the next dollar
        // withdrawn is a dollar or more, so no finite withdrawal nets the
        // shortfall. Ask for the shortfall itself and let the settlement's
        // spillover handle what the account cannot cover.
        if (denominator <= 0) return netShortfall.copy();

        const grossed = (netShortfall.amount + ltcgRate * intercept) / denominator;

        // Never less than the shortfall: the gross-up exists to withdraw MORE,
        // and a rounding artefact that returned less would silently underpay
        // the obligation this draw is settling.
        return new Currency(Math.max(grossed, netShortfall.amount));
    }

}
