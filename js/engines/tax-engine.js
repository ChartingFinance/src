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
import { global_retirement_withholding_rate, global_allocate_household_tax } from '../globals.js';
import { basisThisMonth, basisOverMonths, isAllocationEligible, planAllocation, NII_BASIS_METRICS } from '../tax-allocation.js';
import { logger, LogCategory } from '../utils/logger.js';
import { EventType, ShortfallOrigin } from '../sim-event.js';
import { withTrace, TraceKind } from '../trace.js';
import { taxableBasis } from '../tax-basis.js';

export class TaxEngine {

    constructor(modelAssets, monthly, yearly, activeUser, config) {
        this.modelAssets = modelAssets;
        this.config = config;   // Spec 9 step 2 — carries the run's tax table
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
     * Withhold federal tax at the SOURCE of every traditional IRA / 401(K)
     * distribution taken this month.
     *
     * WHY THIS IS A MONTHLY SWEEP AND NOT A PER-DRAW HOOK
     * ---------------------------------------------------
     * Six code paths book a deferred distribution: expense fund transfers,
     * the RMD top-up, rebalancing, close distributions, settleOneSided, and
     * its spillover leg. Hanging a withholding call off each one means the
     * rule is correct only while all six are remembered — and a missed site
     * fails SILENTLY, booking a distribution with no tax. That is the same
     * shape as the provenance-tag bug that shipped with a green suite.
     *
     * Reading the distribution METRIC instead makes the sweep total by
     * construction: every path already writes it (recordDistribution and the
     * two direct addToMetric sites), so a path added later is covered without
     * anyone remembering this file exists.
     *
     * THE GROSS-UP
     * ------------
     * `distributed` is what the account paid out NET of tax. Withholding is
     * `net × r/(1−r)`, not `net × r`, so that the withheld amount is r of the
     * GROSS: at 10%, a $9,000 net draw withholds $1,000 against a $10,000
     * gross. The withheld amount is itself a distribution — it left the
     * account and is ordinary income — so it is added to both the asset metric
     * and the household package, exactly as the net draw was.
     *
     * Because the rate is flat rather than a function of the liability, there
     * is no iteration and no feedback loop; next month's true-up settles the
     * difference either way.
     *
     * NOT APPLIED ON CLOSE. applyDeferredCloseDistribution already withholds
     * the incremental marginal tax on a full distribution, which is strictly
     * better than a flat 10%. It books ESTIMATED_INCOME_TAX and adds to
     * monthly.incomeTax itself. This sweep would double-withhold, so the close
     * path zeroes finishCurrency before month end and is excluded by the
     * isClosed check below.
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
                // `cause` distinguishes this from every other one-sided spill.
                // Without it a withholding spill is indistinguishable in the
                // ledger from a property-tax or expense settlement spill, which
                // made a $796 tax payment look like an uncollected gap during
                // reconciliation (probed 2026-08-03).
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
            //this.monthly.propertyTaxes.subtract(escrow);
            modelAsset.recordEvent(EventType.PROPERTY_TAX_ESCROW, escrow);

            if (modelAsset.monthlyTaxEscrow.amount) {

                let preFlights = [];
                const payment = escrow.flipSign(); // escrow is negative, flip to positive for debit
                let remaining = payment.copy();

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

                modelAsset.clearMonthlyTaxEscrow();

            }

        }
    }

    // ── On Close: Capital Gains Tax ───────────────────────────────────

    applyCapitalGainsTax(modelAsset) {
        // A Roth owes no tax on close — but distribution RECORDING used to ride
        // on this early return, so closing one booked nothing at all while the
        // same account's monthly draws booked normally. Book first, then leave.
        if (InstrumentType.isTaxFree(modelAsset.instrument)) {
            this.applyTaxFreeCloseDistribution(modelAsset);
            return;
        }

        // Closing a traditional IRA/401K is a FULL DISTRIBUTION: the entire
        // balance is ordinary income — inside the deferred wrapper there is
        // no basis and no capital-gains treatment. Falling through to the
        // LTCG path below (the old behavior) taxed only finish − basis at
        // capital-gains rates, understating the tax on a large close by
        // tens of thousands of dollars.
        if (InstrumentType.isTaxDeferred(modelAsset.instrument)) {
            this.applyDeferredCloseDistribution(modelAsset);
            return;
        }

        const capitalGains = new Currency(modelAsset.finishCurrency.amount - modelAsset.finishBasisCurrency.amount);
        logger.log(LogCategory.TAX, 'capital gains of ' + capitalGains.toString());

        const monthsSpan = MonthsSpan.build(modelAsset.startDateInt, modelAsset.effectiveFinishDateInt);
        // The band a gain lands in is measured against TAXABLE income with the
        // gain stacked last (IRC §1(h)). This used to pass totalIncome() × 12 —
        // a gross rollup that already contained the gains being taxed, plus
        // tax-free Roth distributions, with no deduction removed — so gains
        // were pushed into a higher band than they belong in, and the annual
        // true-up disagreed with this site about the same liability.
        // Deliberately does NOT apply `basis.unusedDeduction`, though the §63
        // overflow rule is real and the annual true-up does apply it. Measured
        // 2026-08-18: this package is ONE MONTH annualised, and at close time it
        // reads as roughly zero ordinary income, so the whole (inflated)
        // standard deduction looks unused — to a household earning $108k in the
        // single-home-sale fixture and far more in mfj-high-earner-ltcg. Wiring
        // it in cut withholding here by exactly what December then billed back
        // (2,646.63 and 7,057.68, equal to the cent in both directions), which
        // buys no accuracy and enlarges the true-up that unfundable-tax-bill
        // exists to watch.
        //
        // This is the same ×12 gap tax-basis.js documents, not a disagreement
        // about the RULE — withholding is allowed to differ from liability;
        // that is what a true-up is for. Revisit when the close path gets a
        // stack base worth trusting: it currently stacks from $0 income, which
        // the 2026-07-25 review already has open.
        const { ltcgStackBase } = taxableBasis(this.monthly, this.activeUser, { annualise: true });
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

            // §121 removed some of that gain from the tax base. Record it so
            // applyAnnualTaxTrueUp can subtract it; without this the true-up
            // recomputes the year from the gross gain, finds more tax than was
            // withheld, and bills the difference — handing the exclusion back.
            // The gain itself stays gross above: the household really did
            // realise it, and reconciliation balances the recognised event
            // against monthly.longTermCapitalGains on both sides.
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

            // flipSign() mutates, so amountToTax is negative from here on — the
            // sign the metric wants, and the sign line 178 needs to deduct the
            // tax from the closing balance. This used to pass `capitalGains`,
            // putting the GAIN in a tax metric: positive, many times the size of
            // the tax, and counted a second time in INCOME via
            // SHORT_TERM_CAPITAL_GAIN. The long-term branch above never had it.
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
     * Closing a Roth is a full distribution like closing any other retirement
     * account — it simply isn't taxable. It still has to be BOOKED: the cash
     * leaves via the close fund transfers either way, and if nothing records it
     * the account's own ledger shows a balance vanishing with no distribution
     * and no income, while the household's totalIncome() silently drops the
     * same amount.
     *
     * The asymmetry this removes was visible inside a single account: a Roth
     * that drew $91,459 monthly and closed with $208,541 booked only the first
     * — the monthly path records distributions (expense-engine, settleOneSided)
     * and the close path did not.
     *
     * Recording only. No tax arises, and none is deducted from the balance:
     * taxFreeDistribution is not part of ordinaryIncome() or
     * irsTaxableGrossIncome(), so taxable income cannot move.
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

        // Baseline income BEFORE the distribution is booked, so the
        // marginal computation below doesn't count it twice. (At close time
        // this.monthly is usually freshly zeroed — the same weak baseline
        // the capital-gains close path uses; the annual true-up settles the
        // exact liability since ordinaryIncome() includes distributions.)
        // Ordinary tax must be measured against ORDINARY taxable income. This
        // used to pass totalIncome() × 12, a rollup carrying long-term gains,
        // qualified dividends and tax-free Roth distributions — none of which
        // belong in an ordinary-rate calculation — and carrying no deduction.
        // Captured BEFORE the distribution is booked below, so the marginal
        // computation does not count it twice.
        const { ordinaryTaxable: annualizedIncome } =
            taxableBasis(this.monthly, this.activeUser, { annualise: true });

        // Book the full balance as a taxable distribution, classified by the
        // source instrument (recordTransfer routes IRA vs 401K), plus the
        // per-asset display metric.
        this.monthly.recordTransfer(modelAsset.instrument, distribution, Currency.zero());
        if (InstrumentType.isIRA(modelAsset.instrument)) {
            modelAsset.addToMetric(Metric.TRAD_IRA_DISTRIBUTION, distribution);
        } else {
            modelAsset.addToMetric(Metric.FOUR_01K_DISTRIBUTION, distribution);
        }

        // Withhold the INCREMENTAL ordinary tax: tax(income + distribution)
        // − tax(income). A standalone tax(distribution) would walk the
        // brackets from $0 and understate the marginal cost whenever other
        // income exists — the same flaw the short-term-gains path has.
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

        // Collect the withholding from the closing balance itself (book-and-
        // collect stay atomic), so the close fund transfers move the post-tax
        // remainder. Basis tracks the post-tax value for the same reason as
        // the capital-gains path: close transfers must not re-realize.
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
        const { ordinaryTaxable } = taxableBasis(this.monthly, this.activeUser, { annualise: true });
        let totalIncomeTax = this.config.taxTable.calculateYearlyIncomeTax(ordinaryTaxable).divide(12.0).flipSign();

        // What was already withheld from payroll on Day 1? (negative value)
        const alreadyWithheld = this.monthly.incomeTax.copy();

        // Additional estimated tax = total liability - already withheld
        // Both values are negative, so if total is more negative, additionalTax is negative (owe more)
        const additionalTax = new Currency(totalIncomeTax.amount - alreadyWithheld.amount);

        if (additionalTax.amount >= 0) return;

        // Additional tax owed beyond payroll withholding (e.g., interest,
        // dividends, IRA/401K distributions, pensions).
        //
        // Book-and-collect must be atomic. monthly.incomeTax rolls up into
        // yearly.incomeTax, which the annual true-up treats as cash already
        // collected (totalWithheld). Booking the liability without debiting an
        // account would therefore make the year-end settlement believe the tax
        // was paid, and it would never be collected from any balance. So: no
        // funding account, no booking — the annual true-up then sees the full
        // shortfall and collects it in its April settlement instead.
        const payment = additionalTax.copy().flipSign();

        // Who generated the income this tax is on? Empty when the feature is
        // off, or when nothing eligible earned anything this month — both fall
        // through to the single backstop draw below.
        const legs = this.#planTaxAllocation(payment, (asset) => basisThisMonth(asset));

        if (legs.length > 0) {
            // Book what the accounts ACTUALLY supplied, not what they were
            // billed. An allocated leg is sized by income share, so an account
            // that earned a lot this month but holds little cash is billed more
            // than it can pay; settleOneSided then supplies what it has and
            // spills the rest, and the spilled leg books a SPILLOVER event which
            // reconciliation counts in a different bucket.
            //
            // Adding the full bill here instead made the package claim income
            // tax that no incomeTax event backed — probed 2026-08-05 on the
            // reference portfolio, "2056-04 Income tax: events=0.00,
            // package=-431.79", an account billed $431.79 with nothing left to
            // pay it. Same book-and-collect rule the comment above states; the
            // difference is that the single-backstop path is billed only what
            // one already-chosen liquid account can cover, so it rarely trips.
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

        // Route through settleOneSided rather than a raw debit: it clamps the
        // account at $0, re-sources the remainder from the next backstop, and
        // reports whatever nothing can cover. A raw debit books the tax as paid
        // no matter what the account actually held. It also books the realized
        // gain — paying tax from a brokerage sells shares — so that must NOT be
        // duplicated here. recordTransfer is a no-op for CASH/BANK sources.
        //
        // No single asset "owes" household tax, so fromModel stays null and
        // reportUnfunded falls back to naming the account that could not pay.
        const oneSided = new FundTransferOneSided(null, payment);
        oneSided.toModel = liquidAsset;
        const settled = FundTransfer.settleOneSided(oneSided, { type: EventType.INCOME_TAX_WITHHOLDING }, this.modelAssets);

        this.monthly.recordTransfer(liquidAsset.instrument, settled.supplied, settled.realizedGain);
        if (settled.spillover.amount > 0 && settled.spilloverInstrument) {
            this.monthly.recordTransfer(settled.spilloverInstrument, settled.spillover, settled.spilloverGain);
        }

    }

    // ── Spec 4a: billing the tax to the income that caused it ─────────

    /**
     * Split `payment` across the accounts that generated this period's taxable
     * income. Returns [] when the feature is off or nothing qualifies, and the
     * caller then takes the single-backstop path unchanged — which is what makes
     * the flag a true no-op rather than a different code path that happens to
     * agree.
     *
     * `basisOf` differs between the two true-up sites: the monthly one reads
     * live accumulators, the annual one reads history. See tax-allocation.js.
     *
     * @param {Currency} payment positive
     * @param {(asset) => number} basisOf
     */
    #planTaxAllocation(payment, basisOf) {
        if (!global_allocate_household_tax) return [];
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
     * Collect one allocated leg from the account that earned the income.
     *
     * Deliberately the same settleOneSided path the single backstop draw uses,
     * so a leg inherits the $0 clamp, the spillover re-sourcing and the unfunded
     * report without restating any of it. An account billed for more than it
     * holds pays what it has and the rest spills — the same outcome as today,
     * just starting from a different account.
     *
     * NO GROSS-UP on a tax-deferred leg. settleOneSided already calls
     * recordDistribution (fund-transfer.js), and recordTransfer below books the
     * household half, so the draw is ordinary income by the same machinery every
     * other deferred withdrawal uses. The annual true-up charges tax on it
     * through this.yearly. Grossing up here would tax it twice. See
     * markdowns/tax-allocation-spec.md section 3.2.1.
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

                // Each payer carries its own share on its own ledger. Booking the
                // whole bill against one account is the thing this spec exists to
                // stop, and it would also make the rule note lie about who paid.
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
     *   plan, for the same history window spec 4a's allocation uses.
     */
    applyAnnualNIIT(settledYearMonths) {

        const { netInvestmentIncome, magi } = taxableBasis(this.yearly, this.activeUser);
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

        // Spec 4a window — identical to applyAnnualTaxTrueUp's, because this
        // pass runs immediately after it on the same January 1.
        const referenceHistory = this.modelAssets[0]?.getHistory(Metric.VALUE) ?? [];
        const hiIndex = referenceHistory.length - 1;
        const loIndex = hiIndex - (Math.max(1, settledYearMonths ?? 12) - 1);
        const niiBasis = (asset) =>
            basisOverMonths(asset, loIndex, hiIndex, NII_BASIS_METRICS);

        const legs = this.#planTaxAllocation(niit, niiBasis);
        if (legs.length > 0) {
            logger.log(LogCategory.TAX,
                `NIIT: allocating ${niit.toString()} across ${legs.length} account(s) by NII share.`);
            // Book what the accounts ACTUALLY supplied, not what they were
            // billed — the same rule applyMonthlyTaxTrueUp follows. An account
            // billed more than it holds spills, and the spilled leg is counted
            // through settled.spillover; adding the full bill here would make
            // the package claim tax no balance ever paid.
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
    // Compares exact yearly tax liability against total withheld/estimated
    // amounts accumulated in this.yearly. Debits underpayment or credits
    // overpayment to the first liquid account.

    /**
     * @param {number} settledYearMonths How many months of the year being
     *   settled fell inside the plan. Needed only by spec 4a's allocation, which
     *   reads per-asset history rather than the live accumulators: this pass
     *   runs on January 1 of the FOLLOWING year, by which point every month of
     *   the settled year — December included — has been snapshotted and zeroed.
     *   Portfolio.monthsInPlanYear() owns the short first/last year arithmetic.
     */
    applyAnnualTaxTrueUp(settledYearMonths) {

        // 1. Compute exact tax liability from the yearly accumulator
        const yearlySnapshot = this.yearly.copy();
        yearlySnapshot.limitDeductions(this.activeUser, this.config.taxTable);

        // Both bases from ONE call. This site used to recompute the gains base
        // inline — gross gains less §121, clamped — which was a correct copy of
        // taxableBasis on the day it was written and a tenth disagreeing
        // definition the moment the §63 deduction overflow was added to one and
        // not the other. Subtracting §121 rather than reducing
        // longTermCapitalGains at the source keeps the recognised gain honest (a
        // household that sold a home for a $488,452 gain should see $488,452 in
        // its ledger) and leaves the capitalGains reconciliation bucket
        // balancing against an untouched accumulator; taxableBasis does it the
        // same way.
        const { ordinaryTaxable: actualTaxableIncome, capitalGains: yearlyCapitalGains } =
            taxableBasis(this.yearly, this.activeUser);
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

        // 2. What was already withheld/estimated throughout the year?
        // These are stored as negative values (outflows), so negate to get positive totals.
        const totalWithheld = Math.abs(this.yearly.incomeTax.amount)
                            + Math.abs(this.yearly.estimatedTaxes.amount)
                            + Math.abs(this.yearly.longTermCapitalGainsTax.amount);

        // 3. Compute the difference
        const taxDifference = totalActualTax - totalWithheld;

        // Only act if the discrepancy is material (> $1)
        if (Math.abs(taxDifference) < 1) return;

        // Spec 4a basis window. VALUE is in COMMON_METRICS so every instrument
        // tracks it, and every asset is snapshotted every month, so all
        // histories share a length and an index origin. December of the settled
        // year is therefore the last entry.
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
                    this.#settleAllocatedLeg(leg, EventType.TAX_TRUE_UP,
                        Metric.ESTIMATED_INCOME_TAX, { direction: 'underpayment' });
                }
                return;
            }
        } else {
            const refund = new Currency(Math.abs(taxDifference));
            const legs = this.#planTaxAllocation(refund, yearBasis);
            if (legs.length > 0) {
                // Refunds follow the same basis as collections. Sending every
                // refund to the backstop while billing the earners would ratchet
                // cash out of the income generators over repeated over/under
                // cycles — a slow version of the bug this spec exists to fix.
                // credit() adds a taxable deposit to finishBasisCurrency, so this
                // manufactures no untaxed future gain.
                logger.log(LogCategory.TAX, `Annual True-Up: Overpaid by $${refund.amount.toFixed(0)}. Refunding across ${legs.length} account(s) by income share.`);
                for (const leg of legs) {
                    const credit = new Currency(leg.amount);
                    leg.modelAsset.credit(credit, {
                        type: EventType.TAX_TRUE_UP,
                        data: { direction: 'refund', basis: 'proportional', share: leg.share },
                    });
                    leg.modelAsset.addToMetric(Metric.ESTIMATED_INCOME_TAX, credit);
                }
                return;
            }
        }

        if (!liquidAsset) {
            // NOTHING everyday can pay this. Report it — never return in
            // silence, which books no tax, moves no cash and raises no issue,
            // so a plan that cannot pay its April bill looks identical to one
            // that has none. resolveFunding's own contract says as much: an
            // obligation with no funding account is an UNFUNDED obligation,
            // "never a silent skip".
            //
            // This is the LAST line of defence. applyMonthlyTaxTrueUp may also
            // find no backstop, but it logs and defers here; this site has
            // nowhere left to defer to.
            //
            // Note that "no liquid asset" is not the same as "no money".
            // resolveFunding considers everyday accounts only, by deliberate
            // policy — the engine will not raid a 401(k) implicitly — so a
            // household with a large deferred balance and an empty current
            // account lands here too. The obligation is just as real, and the
            // user is the one who decides which account pays it.
            if (taxDifference > 0) {
                FundTransfer.reportUnfunded(this.#unfundedTaxAnchor(),
                    new Currency(taxDifference), 'annual tax true-up',
                    ShortfallOrigin.ONE_SIDED);
            } else {
                // A refund is money owed TO the household, so it is not an
                // unfunded obligation — but dropping it is the same defect
                // wearing the other hat, and it fires on a SHIPPED profile:
                // Early Career is owed $2,018.62 across six refunds it never
                // received.
                //
                // resolveFunding said no only because every everyday account
                // was empty, and emptiness is a reason to RECEIVE a refund, not
                // a reason to refuse one. resolveDeposit drops that filter.
                const refund = new Currency(Math.abs(taxDifference));
                const target = FundTransfer.resolveDeposit(this.modelAssets);
                if (target) {
                    target.credit(refund, {
                        type: EventType.TAX_TRUE_UP,
                        data: { direction: 'refund', basis: 'backstop' },
                    });
                    target.addToMetric(Metric.ESTIMATED_INCOME_TAX, refund);
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
            // Underpaid — collect the shortfall (April tax bill).
            //
            // Routed through settleOneSided rather than a raw debit, for the
            // same reason applyMonthlyTaxTrueUp is: a raw debit CLAMPS at $0 and
            // returns the overshoot in `spillover`, which this site used to
            // discard — booking ESTIMATED_INCOME_TAX for the full bill while
            // that cash never left any account. Probed 2026-08-03: the April
            // 2029 bill asked Savings for $3,462.57 against a $791.98 balance
            // and silently "collected" the missing $2,670.59.
            //
            // settleOneSided re-sources the remainder from the next backstop and
            // reports what nothing can cover, so the books only ever claim tax
            // that a balance actually paid. Each leg is booked against the
            // account that really supplied it.
            const taxBill = new Currency(taxDifference);
            logger.log(LogCategory.TAX, `Annual True-Up: Underpaid by $${taxDifference.toFixed(0)}. Debiting ${liquidAsset.displayName}.`);

            const oneSided = new FundTransferOneSided(null, taxBill);
            oneSided.toModel = liquidAsset;
            const settled = FundTransfer.settleOneSided(oneSided,
                { type: EventType.TAX_TRUE_UP, data: { direction: 'underpayment' } },
                this.modelAssets);

            liquidAsset.addToMetric(Metric.ESTIMATED_INCOME_TAX, settled.supplied.copy().flipSign());
            this.monthly.recordTransfer(liquidAsset.instrument, settled.supplied, settled.realizedGain);

            if (settled.spillover.amount > 0 && settled.spilloverInstrument) {
                this.monthly.recordTransfer(settled.spilloverInstrument, settled.spillover, settled.spilloverGain);
                // The account that actually supplied the spilled leg carries its
                // tax on its own ledger; booking it all against liquidAsset
                // would show a depleted account paying tax it never held.
                const payer = FundTransfer.resolveFunding(this.modelAssets);
                if (payer) payer.addToMetric(Metric.ESTIMATED_INCOME_TAX, settled.spillover.copy().flipSign());
            }
        } else {
            // Overpaid — credit the refund
            const taxRefund = new Currency(Math.abs(taxDifference));
            logger.log(LogCategory.TAX, `Annual True-Up: Overpaid by $${Math.abs(taxDifference).toFixed(0)}. Refunding to ${liquidAsset.displayName}.`);
            liquidAsset.credit(taxRefund, { type: EventType.TAX_TRUE_UP, data: { direction: 'refund' } });
            liquidAsset.addToMetric(Metric.ESTIMATED_INCOME_TAX, taxRefund);
        }

    }

}
