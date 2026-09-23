/**
 * tax-engine.js
 *
 * Tax payment scheduling and execution: records tax amounts in the monthly
 * package, records the events, and moves the cash.
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
// A fixed policy constant, not a setting, so it is imported rather than read
// from the run's config.
import { global_retirement_withholding_rate } from '../policy-constants.js';
import { basisThisMonth, basisOverMonths, isAllocationEligible, planAllocation, NII_BASIS_METRICS } from '../tax-allocation.js';
import { logger, LogCategory } from '../utils/logger.js';
import { EventType, ShortfallOrigin } from '../sim-event.js';
import { withTrace, TraceKind } from '../trace.js';
import { taxableBasis } from '../tax-basis.js';

export class TaxEngine {

    constructor(modelAssets, monthly, yearly, activeUser, config) {
        this.modelAssets = modelAssets;
        this.config = config;   // carries the run's tax table
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

        modelAsset.recordEvent(EventType.FICA_WITHHOLDING, withholding.fica(), { metric: Metric.SOCIAL_SECURITY_TAX });

    }

    // ── Day 1: Income Tax Withholding Recording ───────────────────────

    recordIncomeTaxWithholding(modelAsset, assetTax) {

        const withheldTax = assetTax.copy().flipSign();
        this.monthly.incomeTax.add(withheldTax);
        modelAsset.recordEvent(EventType.INCOME_TAX_WITHHOLDING, withheldTax.copy(), { metric: Metric.WITHHELD_INCOME_TAX });

        logger.log(LogCategory.TRANSFER, `recordIncomeTaxWithholding: ${modelAsset.displayName} tax=${assetTax.toString()}`);

    }

    // ── Last day of month: withholding on deferred distributions ──────

    /**
     * Withhold federal tax at the source of every traditional IRA / 401(k)
     * distribution taken this month.
     *
     * A monthly sweep over the distribution metric, not a hook on each draw.
     * Six code paths book deferred distributions, and a hook missed on any one
     * of them would skip the tax without an error. Every path writes the metric,
     * so the sweep also covers paths added later.
     *
     * `distributed` is net of tax, so the withholding is `net × r/(1−r)`: at 10%,
     * a $9,000 net draw withholds $1,000 of a $10,000 gross. The withheld amount
     * is itself a distribution, so it is booked as one on the asset and in the
     * household package. The rate is flat, so there is no feedback loop; the
     * true-up settles any difference.
     *
     * Not applied on close: applyDeferredCloseDistribution withholds the
     * marginal tax on the whole balance itself, and closed accounts are skipped
     * below.
     */
    withholdOnDeferredDistributions() {

        for (const modelAsset of this.modelAssets) {

            if (!InstrumentType.isTaxDeferred(modelAsset.instrument)) continue;

            // Consume the month's conversion total whether or not this asset
            // goes on to withhold — leaving it would carry into next month and
            // suppress withholding on an unrelated draw.
            const sheltered = modelAsset.monthlyShelteredDistribution.copy();
            modelAsset.monthlyShelteredDistribution.zero();

            if (modelAsset.isClosed) continue;

            const metric = InstrumentType.isIRA(modelAsset.instrument)
                ? Metric.TRAD_IRA_DISTRIBUTION
                : Metric.FOUR_01K_DISTRIBUTION;

            const distributed = InstrumentType.isIRA(modelAsset.instrument)
                ? modelAsset.tradIRADistributionCurrency
                : modelAsset.four01KDistributionCurrency;

            if (!distributed || distributed.amount <= 0) continue;

            // Only the portion that actually left the shelter is withheld.
            const eligible = new Currency(distributed.amount - sheltered.amount);
            if (eligible.amount <= 0) continue;

            const rate = global_retirement_withholding_rate;
            const withheld = new Currency(eligible.amount * rate / (1 - rate));
            if (withheld.amount <= 0) continue;

            withTrace(TraceKind.SETTLEMENT,
                `Federal withholding: ${modelAsset.displayName}`,
                modelAsset.currentDateInt,
                () => this.#withholdInScope(modelAsset, metric, withheld, rate));
        }
    }

    #withholdInScope(modelAsset, metric, withheld, rate) {

        // The account funds its own withholding first. debit() clamps at $0 and
        // reports the overshoot rather than going negative.
        const result = modelAsset.debit(withheld, {
            type: EventType.INCOME_TAX_WITHHOLDING,
            data: { rate, source: 'distribution' },
        });

        const supplied = withheld.minus(result.spillover);

        if (supplied.amount > 0) {
            // The withheld dollars left the account, so they are a distribution
            // too — on the asset's ledger and in the household package. Skipping
            // either half understates ordinary income by exactly the withholding.
            modelAsset.addToMetric(metric, supplied);
            this.monthly.recordTransfer(modelAsset.instrument, supplied, Currency.zero());

            modelAsset.addToMetric(Metric.WITHHELD_INCOME_TAX, supplied.copy().flipSign());
            this.monthly.incomeTax.add(supplied.copy().flipSign());
        }

        // A depleted account still owes the tax. Re-source from the backstop —
        // that leg is NOT a deferred distribution (the cash came from a taxable
        // account), so it books the tax but not the distribution metrics.
        if (result.spillover.amount > 0) {
            const fallback = FundTransfer.resolveFunding(this.modelAssets);
            if (fallback) {
                // `cause` marks this spill as a tax payment, so reconciliation
                // counts it as income tax rather than as an unpaid settlement.
                const spillResult = fallback.debit(result.spillover,
                    { type: EventType.SPILLOVER,
                      data: { depleted: modelAsset.displayName,
                              origin: ShortfallOrigin.ONE_SIDED,
                              cause: 'withholding' } });

                const spilled = result.spillover.minus(spillResult.spillover);
                this.monthly.recordTransfer(fallback.instrument, spilled,
                    spillResult.realizedGain ?? Currency.zero());

                if (spillResult.realizedGain?.amount > 0) {
                    fallback.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, spillResult.realizedGain);
                    fallback.recordEvent(EventType.CAPITAL_GAIN_RECOGNIZED,
                        spillResult.realizedGain.copy(),
                        { metric: Metric.LONG_TERM_CAPITAL_GAIN, data: { spillover: true } });
                }

                fallback.addToMetric(Metric.WITHHELD_INCOME_TAX, spilled.copy().flipSign());
                this.monthly.incomeTax.add(spilled.copy().flipSign());
            } else {
                FundTransfer.reportUnfunded(modelAsset, result.spillover,
                    'federal withholding', ShortfallOrigin.ONE_SIDED);
            }
        }
    }

    // ── Day 15: Property Tax Escrow ───────────────────────────────────

    applyPropertyTaxEscrow(modelAsset, _currentDateInt) {

        if (!InstrumentType.isRealEstate(modelAsset.instrument)) return;

        if (modelAsset.annualTaxRate.rate != 0) {

            const escrow = modelAsset.applyMonthlyTaxEscrow();
            modelAsset.recordEvent(EventType.PROPERTY_TAX_ESCROW, escrow);

            if (modelAsset.monthlyTaxEscrow.amount) {

                // The causal scope for the escrow draw, as every other obligation
                // payer opens one, so the settlement traces back to the property
                // tax. Scoped at the draw, not the accrual: PROPERTY_TAX_ESCROW
                // above stays outside, the same as maintenance and insurance.
                withTrace(TraceKind.CARRYING_COST, `${modelAsset.displayName} property tax`, _currentDateInt,
                    () => this.#drawPropertyTaxEscrow(modelAsset, escrow));

                modelAsset.clearMonthlyTaxEscrow();

            }

        }
    }

    #drawPropertyTaxEscrow(modelAsset, escrow) {

        let preFlights = [];
        const payment = escrow.flipSign(); // escrow is negative, flip to positive for debit
        let remaining = payment.copy();

        for (const fundTransfer of modelAsset.fundTransfers) {

            // Only recurring transfers with a resolvable target pay escrow.
            if (!fundTransfer.hasRecurring) continue;
            fundTransfer.bind(modelAsset, this.modelAssets);
            if (!fundTransfer.toModel) continue;
            if (remaining.amount == 0) break;
            
            let preFlight = new FundTransferOneSided(fundTransfer, payment);
            remaining.subtract(preFlight.amount);
            if (remaining.amount < 0) {
                // The last source pays only what remains.
                preFlight.amount.add(remaining);
                remaining.zero();
            }                    
            preFlights.push(preFlight);

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
                FundTransfer.reportUnfunded(modelAsset, remaining, 'property tax', ShortfallOrigin.STANDALONE);
            }
        }

        // One-sided withdrawal: escrow already adjusted the home's balance.
        // Only debit the funding source (toModel).
        for (const oneSided of preFlights) {
            const event = { type: EventType.SETTLEMENT, data: {
                from: modelAsset.displayName, to: oneSided.toModel.displayName, label: 'property tax' } };
            const settled = FundTransfer.settleOneSided(oneSided, event, this.modelAssets);
            this.monthly.recordTransfer(oneSided.toModel.instrument, settled.supplied, settled.realizedGain);
            if (settled.spillover.amount > 0 && settled.spilloverInstrument) {
                this.monthly.recordTransfer(settled.spilloverInstrument, settled.spillover, settled.spilloverGain);
            }
        }
    }

    // ── On Close: Capital Gains Tax ───────────────────────────────────

    applyCapitalGainsTax(modelAsset) {
        // A Roth owes no tax on close, but the distribution must still be booked.
        if (InstrumentType.isTaxFree(modelAsset.instrument)) {
            this.applyTaxFreeCloseDistribution(modelAsset);
            return;
        }

        // Closing a traditional IRA/401(k) distributes the whole balance as
        // ordinary income: inside the wrapper there is no basis and no
        // capital-gains treatment.
        if (InstrumentType.isTaxDeferred(modelAsset.instrument)) {
            this.applyDeferredCloseDistribution(modelAsset);
            return;
        }

        const capitalGains = new Currency(modelAsset.finishCurrency.amount - modelAsset.finishBasisCurrency.amount);
        logger.log(LogCategory.TAX, 'capital gains of ' + capitalGains.toString());

        const monthsSpan = MonthsSpan.build(modelAsset.startDateInt, modelAsset.effectiveFinishDateInt);
        // The gain is stacked on taxable income to find its band (IRC §1(h)).
        // At close this package is one month annualised and usually holds
        // almost no ordinary income, so the stack base is near $0 and the
        // withholding here runs low; the annual true-up settles the real
        // liability. unusedDeduction is deliberately not applied: on a nearly
        // empty month the whole deduction looks unused, and applying it only
        // moves tax from here to the December bill.
        const { ltcgStackBase } = taxableBasis(this.monthly, this.activeUser, { annualise: true, taxTable: this.config.taxTable });
        const isRealEstate = InstrumentType.isRealEstate(modelAsset.instrument);
        const isPrimaryHome = isRealEstate && modelAsset.isPrimaryHome;

        const result = this.config.taxTable.calculateCapitalGainsTax(
            capitalGains, monthsSpan.totalMonths, isPrimaryHome, ltcgStackBase
        );

        let amountToTax = result.tax.copy();

        if (result.isLongTerm) {
            this.monthly.longTermCapitalGains.add(capitalGains);
            modelAsset.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, capitalGains);

            modelAsset.recordEvent(EventType.CAPITAL_GAIN_RECOGNIZED, capitalGains.copy(), { metric: Metric.LONG_TERM_CAPITAL_GAIN, data: { spillover: false } });

            // Record the §121 exclusion so the annual true-up subtracts it;
            // otherwise it recomputes the year from the gross gain and bills the
            // exclusion back. The gain itself stays gross: the household did
            // realise it, and reconciliation balances against that figure.
            if (result.excluded > 0) {
                const excluded = new Currency(result.excluded);
                this.monthly.excludedCapitalGains.add(excluded);
                modelAsset.recordEvent(EventType.CAPITAL_GAIN_EXCLUDED, excluded.copy());
            }

            this.monthly.longTermCapitalGainsTax.add(amountToTax.flipSign());
            modelAsset.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN_TAX, amountToTax);

            if (amountToTax.amount !== 0) {
                modelAsset.recordEvent(EventType.CAPITAL_GAINS_TAX, amountToTax.copy(), { metric: Metric.LONG_TERM_CAPITAL_GAIN_TAX });
            }
        } else {
            this.monthly.shortTermCapitalGains.add(capitalGains);
            modelAsset.addToMetric(Metric.SHORT_TERM_CAPITAL_GAIN, capitalGains);

            // Short-term gains are taxed at ordinary rates, and
            // calculateCapitalGainsTax walks the brackets from $0 for them — as
            // if the gain were the year's only income. The true-up settles the
            // real liability.
            //
            // flipSign() mutates: amountToTax is negative from here on, the
            // sign both the metric and the closing-balance deduction below need.
            this.monthly.incomeTax.add(amountToTax.flipSign());
            modelAsset.addToMetric(Metric.SHORT_TERM_CAPITAL_GAIN_TAX, amountToTax);

            if (amountToTax.amount !== 0) {
                modelAsset.recordEvent(EventType.INCOME_TAX_WITHHOLDING, amountToTax.copy(), { metric: Metric.SHORT_TERM_CAPITAL_GAIN_TAX });
            }
        }

        logger.log(LogCategory.TAX, 'applyCapitalGainsTax: ' + modelAsset.displayName + ' generated tax of ' + amountToTax.toString() + ' to deduct from closure');
        modelAsset.finishCurrency.add(amountToTax);
        modelAsset.monthlyValueChange.add(amountToTax);

        // Neutralize basis so subsequent close transfers don't re-trigger
        // realized gains — capital gains have already been taxed above.
        modelAsset.finishBasisCurrency = modelAsset.finishCurrency.copy();
    }

    // ── On Close: Tax-Free Full Distribution ──────────────────────────

    /**
     * Closing a Roth is a full distribution that isn't taxable. Book it anyway,
     * so the account's ledger and the household's income both show where the
     * balance went. No tax results: taxFreeDistribution is outside
     * ordinaryIncome() and irsTaxableGrossIncome().
     */
    applyTaxFreeCloseDistribution(modelAsset) {

        const distribution = modelAsset.finishCurrency.copy();
        if (distribution.amount <= 0) return;

        // Household books (routes tax-free sources to rothIRADistribution)…
        this.monthly.recordTransfer(modelAsset.instrument, distribution, Currency.zero());
        // …and the asset's own ledger, which recordDistribution routes by
        // instrument. Both halves are required — see its docstring.
        modelAsset.recordDistribution(distribution);

        logger.log(LogCategory.TAX, 'applyTaxFreeCloseDistribution: ' + modelAsset.displayName
            + ' distributed ' + distribution.toString() + ' tax-free');
    }

    // ── On Close: Tax-Deferred Full Distribution ──────────────────────

    applyDeferredCloseDistribution(modelAsset) {

        const distribution = modelAsset.finishCurrency.copy();
        if (distribution.amount <= 0) return;

        // Ordinary taxable income BEFORE the distribution is booked, so the
        // marginal tax below does not count it twice. At close this package is
        // usually nearly empty — the same weak baseline as the capital-gains
        // path — and the annual true-up settles the exact liability.
        const { ordinaryTaxable: annualizedIncome } =
            taxableBasis(this.monthly, this.activeUser, { annualise: true, taxTable: this.config.taxTable });

        // Book the full balance as a taxable distribution, classified by the
        // source instrument (recordTransfer routes IRA vs 401K), plus the
        // per-asset display metric.
        this.monthly.recordTransfer(modelAsset.instrument, distribution, Currency.zero());
        if (InstrumentType.isIRA(modelAsset.instrument)) {
            modelAsset.addToMetric(Metric.TRAD_IRA_DISTRIBUTION, distribution);
        } else {
            modelAsset.addToMetric(Metric.FOUR_01K_DISTRIBUTION, distribution);
        }

        // Withhold the incremental tax: tax(income + distribution) − tax(income).
        // Taxing the distribution alone would walk the brackets from $0.
        const taxWith = this.config.taxTable.calculateYearlyIncomeTax(
            new Currency(annualizedIncome.amount + distribution.amount));
        const taxWithout = this.config.taxTable.calculateYearlyIncomeTax(annualizedIncome.copy());
        const amountToTax = new Currency(-(taxWith.amount - taxWithout.amount));

        if (amountToTax.amount !== 0) {
            this.monthly.incomeTax.add(amountToTax);
            modelAsset.addToMetric(Metric.ESTIMATED_INCOME_TAX, amountToTax);
            modelAsset.recordEvent(EventType.INCOME_TAX_WITHHOLDING, amountToTax.copy(), { metric: Metric.ESTIMATED_INCOME_TAX });
        }

        logger.log(LogCategory.TAX, 'applyDeferredCloseDistribution: ' + modelAsset.displayName
            + ' distributed ' + distribution.toString() + ', withholding ' + amountToTax.toString());

        // Collect the withholding from the closing balance itself, so booking
        // and collecting happen together and the close transfers move the
        // post-tax remainder. Basis follows the post-tax value so the close
        // transfers do not realise a gain again.
        modelAsset.finishCurrency.add(amountToTax);
        modelAsset.monthlyValueChange.add(amountToTax);
        modelAsset.finishBasisCurrency = modelAsset.finishCurrency.copy();

    }

    /**
     * Which asset an unpayable household tax bill is reported against.
     *
     * The bill belongs to the household, not to any one account, but an event
     * has to live somewhere and portfolio-issues groups by asset. The largest
     * remaining balance is the most useful anchor: in the case that matters —
     * money sitting in a 401(k) that the backstop policy will not touch — it
     * puts the warning on exactly the account the user would have to draw from.
     */
    #unfundedTaxAnchor() {
        let best = null;
        for (const modelAsset of this.modelAssets) {
            if (modelAsset.isClosed) continue;
            if (!best || modelAsset.finishCurrency.amount > best.finishCurrency.amount) {
                best = modelAsset;
            }
        }
        return best ?? this.modelAssets[0] ?? null;
    }

    // ── Day 30: Monthly Tax True-Up ───────────────────────────────────

    applyMonthlyTaxTrueUp() {

        // Compute total tax liability across ALL income (salary + capital gains + dividends + interest)
        const { ordinaryTaxable } = taxableBasis(this.monthly, this.activeUser, { annualise: true, taxTable: this.config.taxTable });
        let totalIncomeTax = this.config.taxTable.calculateYearlyIncomeTax(ordinaryTaxable).divide(12.0).flipSign();

        // What was already withheld from payroll on Day 1? (negative value)
        const alreadyWithheld = this.monthly.incomeTax.copy();

        // Additional estimated tax = total liability - already withheld
        // Both values are negative, so if total is more negative, additionalTax is negative (owe more)
        const additionalTax = new Currency(totalIncomeTax.amount - alreadyWithheld.amount);

        if (additionalTax.amount >= 0) return;

        // Tax owed beyond what payroll withheld (interest, dividends,
        // distributions, pensions).
        //
        // Booking and collecting must happen together. monthly.incomeTax rolls
        // into the annual true-up's "already collected" figure, so tax booked
        // without debiting an account would never be collected. With no funding
        // account nothing is booked, and the annual true-up collects the whole
        // shortfall instead.
        const payment = additionalTax.copy().flipSign();

        // Who generated the income this tax is on? Empty when the feature is
        // off, or when nothing eligible earned anything this month — both fall
        // through to the single backstop draw below.
        const legs = this.#planTaxAllocation(payment, (asset) => basisThisMonth(asset));

        if (legs.length > 0) {
            // Book what the accounts actually supplied, not what they were
            // billed. A leg is sized by income share, so an account can be
            // billed more than it holds; the unpaid part spills to the backstop
            // and is counted through settled.spillover.
            let collected = Currency.zero();
            for (const leg of legs) {
                const settled = this.#settleAllocatedLeg(leg, EventType.INCOME_TAX_WITHHOLDING,
                    Metric.ESTIMATED_INCOME_TAX);
                collected.add(settled.supplied);
                collected.add(settled.spillover);
            }
            if (collected.amount > 0) this.monthly.incomeTax.add(collected.copy().flipSign());
            return;
        }

        const liquidAsset = FundTransfer.resolveFunding(this.modelAssets);
        if (!liquidAsset) {
            logger.log(LogCategory.TAX, `Monthly True-Up: no backstop account to pay ${additionalTax.toString()}; deferring to annual true-up`);
            return;
        }

        this.monthly.incomeTax.add(additionalTax);
        liquidAsset.addToMetric(Metric.ESTIMATED_INCOME_TAX, additionalTax);

        // settleOneSided, not a raw debit: it clamps the account at $0,
        // re-sources the rest from the next backstop, and reports what nothing
        // can cover. It also books the realized gain (paying tax from a
        // brokerage sells shares), so that is not repeated here.
        // recordTransfer is a no-op for cash and bank sources.
        //
        // The full bill is booked above, before the draw. If part of it goes
        // unfunded, the package still counts it as collected.
        //
        // No single asset owes household tax, so fromModel stays null and
        // reportUnfunded names the account that could not pay.
        const oneSided = new FundTransferOneSided(null, payment);
        oneSided.toModel = liquidAsset;
        const settled = FundTransfer.settleOneSided(oneSided, { type: EventType.INCOME_TAX_WITHHOLDING }, this.modelAssets);

        this.monthly.recordTransfer(liquidAsset.instrument, settled.supplied, settled.realizedGain);
        if (settled.spillover.amount > 0 && settled.spilloverInstrument) {
            this.monthly.recordTransfer(settled.spilloverInstrument, settled.spillover, settled.spilloverGain);
        }

    }

    // ── Tax allocation: billing tax to the income that caused it ──────

    /**
     * Split `payment` across the accounts that generated this period's taxable
     * income. Returns [] when the feature is off or nothing qualifies, and the
     * caller then takes the single-backstop path unchanged, so turning the flag
     * off really is a no-op.
     *
     * `basisOf` differs between the two true-up sites: the monthly one reads
     * live accumulators, the annual one reads history. See tax-allocation.js.
     *
     * @param {Currency} payment positive
     * @param {(asset) => number} basisOf
     */
    #planTaxAllocation(payment, basisOf) {
        if (!this.config.allocateHouseholdTax) return [];
        if (!payment || payment.amount <= 0) return [];

        const age = this.activeUser?.age ?? 0;
        const candidates = [];
        for (const modelAsset of this.modelAssets) {
            if (!isAllocationEligible(modelAsset, age)) continue;
            const basis = basisOf(modelAsset);
            if (basis > 0) candidates.push({ modelAsset, basis });
        }
        return planAllocation(payment.amount, candidates);
    }

    /**
     * Record in the household package what the annual settlement did: negative
     * when the household paid, positive when it was refunded. Every settlement
     * site goes through here, so federalTaxes() reflects the true-up.
     */
    #bookTrueUp(amount, direction) {
        if (!(Math.abs(amount?.amount ?? 0) > 0.005)) return;
        const signed = new Currency(Math.abs(amount.amount));
        if (direction === 'underpayment') signed.flipSign();
        this.monthly.taxTrueUp.add(signed);
    }

    /**
     * Collect one allocated leg from the account that earned the income.
     *
     * Uses the same settleOneSided path as the single backstop draw, so a leg
     * gets the $0 clamp, spillover re-sourcing and unfunded reporting.
     *
     * No gross-up on a tax-deferred leg: settleOneSided already books the draw
     * as a distribution, and the annual true-up taxes it. Grossing up here would
     * tax it twice. See markdowns/tax-allocation-spec.md §3.2.1.
     */
    #settleAllocatedLeg(leg, eventType, metric, extraData = {}) {
        const { modelAsset, amount, share } = leg;
        const draw = new Currency(amount);

        return withTrace(TraceKind.SETTLEMENT,
            `Tax allocated to ${modelAsset.displayName}`,
            modelAsset.currentDateInt,
            () => {
                const oneSided = new FundTransferOneSided(null, draw);
                oneSided.toModel = modelAsset;
                const settled = FundTransfer.settleOneSided(oneSided,
                    { type: eventType, data: { ...extraData, basis: 'proportional', share } },
                    this.modelAssets);

                // Each payer carries its own share on its own ledger; the rule
                // note reads it from there to say who paid.
                modelAsset.addToMetric(metric, settled.supplied.copy().flipSign());
                this.monthly.recordTransfer(modelAsset.instrument, settled.supplied, settled.realizedGain);

                if (settled.spillover.amount > 0 && settled.spilloverInstrument) {
                    this.monthly.recordTransfer(settled.spilloverInstrument, settled.spillover, settled.spilloverGain);
                    const payer = FundTransfer.resolveFunding(this.modelAssets);
                    if (payer) payer.addToMetric(metric, settled.spillover.copy().flipSign());
                }
                return settled;
            });
    }

    /**
     * IRC §1411 net investment income tax — 3.8% on the LESSER of net
     * investment income and the amount by which MAGI exceeds a fixed threshold.
     *
     * Runs once a year, from the annual pass, AFTER applyAnnualTaxTrueUp. It is
     * a separate pass rather than a branch inside that method; portfolio.js
     * records why at the call site.
     *
     * There is no monthly counterpart, deliberately. Every monthly tax site
     * annualises a single month by twelve, and for a THRESHOLD rule that is not
     * a rounding error but a step function: one windfall month would annualise
     * over $200,000 and charge 3.8% to a household that never crosses it. NIIT
     * is not withheld at source in reality either — it is settled on the return.
     *
     * @param {number} settledYearMonths months of the settled year inside the
     *   plan, for the allocation's history window.
     */
    applyAnnualNIIT(settledYearMonths) {

        const { netInvestmentIncome, magi } = taxableBasis(this.yearly, this.activeUser, { taxTable: this.config.taxTable });
        const niit = this.config.taxTable.calculateNIIT(netInvestmentIncome, magi);

        // Same $1 materiality gate the true-up uses. Returns BEFORE any trace
        // scope is opened — see the note at the call site in portfolio.js.
        if (niit.amount < 1) return;

        return withTrace(TraceKind.TAX_TRUE_UP, 'Net investment income tax',
            this.#unfundedTaxAnchor()?.currentDateInt ?? null,
            () => this.#applyAnnualNIITInScope(niit, netInvestmentIncome, magi, settledYearMonths));

    }

    #applyAnnualNIITInScope(niit, netInvestmentIncome, magi, settledYearMonths) {

        logger.log(LogCategory.TAX,
            `NIIT: ${niit.toString()} on NII ${netInvestmentIncome.toString()}, `
            + `MAGI ${magi.toString()} vs threshold $${this.config.taxTable.activeNIITThreshold}`);

        // What the 3.8% was actually charged on — the binding side of the min.
        // Derived here and carried on the event so the ledger can say which
        // constraint bound without recomputing it.
        const taxedBase = niit.amount / this.config.taxTable.niitRate;
        const eventData = {
            taxedBase,
            nii: netInvestmentIncome.amount,
            magi: magi.amount,
            threshold: this.config.taxTable.activeNIITThreshold,
            bound: netInvestmentIncome.amount <= (magi.amount - this.config.taxTable.activeNIITThreshold)
                ? 'nii' : 'magi',
        };

        // The allocation window, identical to applyAnnualTaxTrueUp's: this pass
        // runs right after it, on the same January 1.
        const referenceHistory = this.modelAssets[0]?.getHistory(Metric.VALUE) ?? [];
        const hiIndex = referenceHistory.length - 1;
        const loIndex = hiIndex - (Math.max(1, settledYearMonths ?? 12) - 1);
        const niiBasis = (asset) =>
            basisOverMonths(asset, loIndex, hiIndex, NII_BASIS_METRICS);

        const legs = this.#planTaxAllocation(niit, niiBasis);
        if (legs.length > 0) {
            logger.log(LogCategory.TAX,
                `NIIT: allocating ${niit.toString()} across ${legs.length} account(s) by NII share.`);
            // Book what the accounts actually supplied, not what they were
            // billed; the spilled part is counted through settled.spillover.
            const collected = Currency.zero();
            for (const leg of legs) {
                const settled = this.#settleAllocatedLeg(
                    leg, EventType.NIIT_ASSESSED, Metric.NIIT, eventData);
                collected.add(settled.supplied);
                collected.add(settled.spillover);
            }
            if (collected.amount > 0) this.monthly.niit.add(collected.copy().flipSign());
            return;
        }

        const liquidAsset = FundTransfer.resolveFunding(this.modelAssets);
        if (!liquidAsset) {
            // Never a silent skip — the same contract the true-up follows. A
            // household that cannot pay its NIIT must look different from one
            // that owes none.
            FundTransfer.reportUnfunded(this.#unfundedTaxAnchor(), niit.copy(),
                'net investment income tax', ShortfallOrigin.ONE_SIDED);
            return;
        }

        // settleOneSided rather than a raw debit, for the reason the true-up
        // spells out: a raw debit clamps at $0 and returns the overshoot in
        // `spillover`, which books tax that no balance ever paid.
        const oneSided = new FundTransferOneSided(null, niit.copy());
        oneSided.toModel = liquidAsset;
        const settled = FundTransfer.settleOneSided(oneSided,
            { type: EventType.NIIT_ASSESSED, data: eventData }, this.modelAssets);

        liquidAsset.addToMetric(Metric.NIIT, settled.supplied.copy().flipSign());
        this.monthly.recordTransfer(liquidAsset.instrument, settled.supplied, settled.realizedGain);

        const collected = settled.supplied.copy();

        if (settled.spillover.amount > 0 && settled.spilloverInstrument) {
            this.monthly.recordTransfer(settled.spilloverInstrument, settled.spillover, settled.spilloverGain);
            const payer = FundTransfer.resolveFunding(this.modelAssets);
            if (payer) payer.addToMetric(Metric.NIIT, settled.spillover.copy().flipSign());
            collected.add(settled.spillover);
        }

        // The household ledger, so federalTaxes() and effectiveTaxRate() see it.
        if (collected.amount > 0) this.monthly.niit.add(collected.flipSign());

    }

    // ── Year-End: Annual Tax True-Up ──────────────────────────────────
    // Compares the year's exact liability with what was withheld or
    // provisioned during it, then collects an underpayment or refunds an
    // overpayment.

    /**
     * @param {number} settledYearMonths How many months of the settled year fell
     *   inside the plan. Used only by tax allocation, which reads per-asset
     *   history: this pass runs on January 1 of the following year, when every
     *   month of the settled year has already been snapshotted and zeroed.
     *   Portfolio.monthsInPlanYear() computes it.
     */
    applyAnnualTaxTrueUp(settledYearMonths) {

        // 1. Compute exact tax liability from the yearly accumulator
        const yearlySnapshot = this.yearly.copy();
        yearlySnapshot.limitDeductions(this.activeUser, this.config.taxTable);

        // Both bases from one taxableBasis() call, so this site cannot drift from
        // the others. §121 is subtracted there rather than taken off
        // longTermCapitalGains, so the ledger still shows the gain the household
        // actually realised.
        const { ordinaryTaxable: actualTaxableIncome, capitalGains: yearlyCapitalGains } =
            taxableBasis(this.yearly, this.activeUser, { taxTable: this.config.taxTable });
        const actualIncomeTax = this.config.taxTable.calculateYearlyIncomeTax(actualTaxableIncome);

        // The exclusion can never exceed the gains it came from, so a zero base
        // against nonzero gains means the two accumulators may have drifted
        // apart. taxableBasis clamps silently; say so here, because a wrong
        // number is easier to find than a quiet one.
        if (yearlySnapshot.longTermCapitalGains.amount + yearlySnapshot.qualifiedDividends.amount
            < yearlySnapshot.excludedCapitalGains.amount) {
            logger.log(LogCategory.TAX,
                'applyAnnualTaxTrueUp: excluded gains exceed realised gains — clamped to 0');
        }
        const actualCapitalGainsTax = this.config.taxTable.calculateYearlyLongTermCapitalGainsTax(
            actualTaxableIncome, yearlyCapitalGains
        );

        // Total actual liability (positive = tax owed)
        const totalActualTax = actualIncomeTax.amount + actualCapitalGainsTax.amount;

        // 2. What was already withheld or provisioned during the year?
        //
        // The sum is negated, never Math.abs()'d per field: every field here is
        // stored negative, so a field with the wrong sign produces a wrong number
        // instead of being silently absorbed. tests/tax-sign-convention.mjs
        // guards this.
        //
        // taxTrueUp is not in the sum: it is the result of this calculation, and
        // including it would make each year depend on the last.
        const totalWithheld = -(this.yearly.incomeTax.amount
                              + this.yearly.estimatedTaxes.amount
                              + this.yearly.longTermCapitalGainsTax.amount);

        // 3. Compute the difference
        const taxDifference = totalActualTax - totalWithheld;

        // Only act if the discrepancy is material (> $1)
        if (Math.abs(taxDifference) < 1) return;

        // Allocation window. Every asset tracks VALUE and is snapshotted every
        // month, so all histories share one length; the settled December is the
        // last entry.
        const referenceHistory = this.modelAssets[0]?.getHistory(Metric.VALUE) ?? [];
        const hiIndex = referenceHistory.length - 1;
        const loIndex = hiIndex - (Math.max(1, settledYearMonths ?? 12) - 1);
        const yearBasis = (asset) => basisOverMonths(asset, loIndex, hiIndex);

        const liquidAsset = FundTransfer.resolveFunding(this.modelAssets);

        if (taxDifference > 0) {
            const legs = this.#planTaxAllocation(new Currency(taxDifference), yearBasis);
            if (legs.length > 0) {
                logger.log(LogCategory.TAX, `Annual True-Up: Underpaid by $${taxDifference.toFixed(0)}. Allocating across ${legs.length} account(s) by income share.`);
                for (const leg of legs) {
                    const settled = this.#settleAllocatedLeg(leg, EventType.TAX_TRUE_UP,
                        Metric.ESTIMATED_INCOME_TAX, { direction: 'underpayment' });
                    // Book what the account actually supplied, and the spilled
                    // part only if a fallback account actually paid it.
                    this.#bookTrueUp(settled.supplied, 'underpayment');
                    if (settled.spilloverInstrument) {
                        this.#bookTrueUp(settled.spillover, 'underpayment');
                    }
                }
                return;
            }
        } else {
            const refund = new Currency(Math.abs(taxDifference));
            const legs = this.#planTaxAllocation(refund, yearBasis);
            if (legs.length > 0) {
                // Refunds follow the same shares as collections. Sending every
                // refund to the backstop would slowly move cash out of the
                // accounts that earn the income. credit() adds basis, so no
                // untaxed gain is created.
                logger.log(LogCategory.TAX, `Annual True-Up: Overpaid by $${refund.amount.toFixed(0)}. Refunding across ${legs.length} account(s) by income share.`);
                for (const leg of legs) {
                    const credit = new Currency(leg.amount);
                    leg.modelAsset.credit(credit, {
                        type: EventType.TAX_TRUE_UP,
                        data: { direction: 'refund', basis: 'proportional', share: leg.share },
                    });
                    leg.modelAsset.addToMetric(Metric.ESTIMATED_INCOME_TAX, credit);
                    this.#bookTrueUp(credit, 'refund');
                }
                return;
            }
        }

        if (!liquidAsset) {
            // No everyday account can pay. Report it rather than return
            // silently, or a plan that cannot pay its April bill looks like one
            // that owes nothing. This is the last line of defence: the monthly
            // true-up defers to here.
            //
            // "No everyday account" is not "no money". The engine never draws a
            // 401(k) implicitly, so a household with a large deferred balance
            // can land here; the user decides which account pays.
            if (taxDifference > 0) {
                FundTransfer.reportUnfunded(this.#unfundedTaxAnchor(),
                    new Currency(taxDifference), 'annual tax true-up',
                    ShortfallOrigin.ONE_SIDED);
            } else {
                // A refund owed to the household must not be dropped either.
                // Empty accounts are a reason to receive a refund, not to refuse
                // one, so resolveDeposit skips the positive-balance filter.
                const refund = new Currency(Math.abs(taxDifference));
                const target = FundTransfer.resolveDeposit(this.modelAssets);
                if (target) {
                    target.credit(refund, {
                        type: EventType.TAX_TRUE_UP,
                        data: { direction: 'refund', basis: 'backstop' },
                    });
                    target.addToMetric(Metric.ESTIMATED_INCOME_TAX, refund);
                    this.#bookTrueUp(refund, 'refund');
                    logger.log(LogCategory.TAX,
                        `Annual True-Up: Overpaid by $${refund.amount.toFixed(0)}. `
                        + `Crediting ${target.displayName}.`);
                } else {
                    logger.log(LogCategory.SANITY,
                        `Annual True-Up: refund of ${refund.toString()} could not be `
                        + `credited — the plan has no everyday account at all`);
                }
            }
            return;
        }

        if (taxDifference > 0) {
            // Underpaid: collect the shortfall (the April bill) through
            // settleOneSided, so a clamped account's shortfall is re-sourced or
            // reported and the books claim only tax a balance actually paid.
            const taxBill = new Currency(taxDifference);
            logger.log(LogCategory.TAX, `Annual True-Up: Underpaid by $${taxDifference.toFixed(0)}. Debiting ${liquidAsset.displayName}.`);

            const oneSided = new FundTransferOneSided(null, taxBill);
            oneSided.toModel = liquidAsset;
            const settled = FundTransfer.settleOneSided(oneSided,
                { type: EventType.TAX_TRUE_UP, data: { direction: 'underpayment' } },
                this.modelAssets);

            liquidAsset.addToMetric(Metric.ESTIMATED_INCOME_TAX, settled.supplied.copy().flipSign());
            this.#bookTrueUp(settled.supplied, 'underpayment');
            if (settled.spilloverInstrument) this.#bookTrueUp(settled.spillover, 'underpayment');
            this.monthly.recordTransfer(liquidAsset.instrument, settled.supplied, settled.realizedGain);

            if (settled.spillover.amount > 0 && settled.spilloverInstrument) {
                this.monthly.recordTransfer(settled.spilloverInstrument, settled.spillover, settled.spilloverGain);
                // Attribute the spilled leg's tax to the backstop account rather
                // than to the depleted one. resolveFunding is asked again AFTER
                // the draw, so if the draw emptied the fallback this names the
                // next account instead.
                const payer = FundTransfer.resolveFunding(this.modelAssets);
                if (payer) payer.addToMetric(Metric.ESTIMATED_INCOME_TAX, settled.spillover.copy().flipSign());
            }
        } else {
            // Overpaid — credit the refund
            const taxRefund = new Currency(Math.abs(taxDifference));
            logger.log(LogCategory.TAX, `Annual True-Up: Overpaid by $${Math.abs(taxDifference).toFixed(0)}. Refunding to ${liquidAsset.displayName}.`);
            liquidAsset.credit(taxRefund, { type: EventType.TAX_TRUE_UP, data: { direction: 'refund' } });
            liquidAsset.addToMetric(Metric.ESTIMATED_INCOME_TAX, taxRefund);
            this.#bookTrueUp(taxRefund, 'refund');
        }

    }

}
