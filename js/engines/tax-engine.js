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
import { EventType, ShortfallOrigin } from '../sim-event.js';

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

        modelAsset.recordEvent(EventType.FICA_WITHHOLDING, withholding.fica(), { metric: Metric.SOCIAL_SECURITY_TAX });

    }

    // ── Day 1: Income Tax Withholding Recording ───────────────────────

    recordIncomeTaxWithholding(modelAsset, assetTax) {

        const withheldTax = assetTax.copy().flipSign();
        this.monthly.incomeTax.add(withheldTax);
        modelAsset.recordEvent(EventType.INCOME_TAX_WITHHOLDING, withheldTax.copy(), { metric: Metric.WITHHELD_INCOME_TAX });

        logger.log(LogCategory.TRANSFER, `recordIncomeTaxWithholding: ${modelAsset.displayName} tax=${assetTax.toString()}`);

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

            modelAsset.recordEvent(EventType.CAPITAL_GAIN_RECOGNIZED, capitalGains.copy(), { metric: Metric.LONG_TERM_CAPITAL_GAIN, data: { spillover: false } });

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
        const annualizedIncome = this.monthly.totalIncome().copy().multiply(12);

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
        const taxWith = activeTaxTable.calculateYearlyIncomeTax(
            new Currency(annualizedIncome.amount + distribution.amount));
        const taxWithout = activeTaxTable.calculateYearlyIncomeTax(annualizedIncome.copy());
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
        const payment = additionalTax.copy().flipSign();
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

        const liquidAsset = FundTransfer.resolveFunding(this.modelAssets);
        if (!liquidAsset) return;

        if (taxDifference > 0) {
            // Underpaid — debit the shortfall (April tax bill)
            const taxBill = new Currency(taxDifference);
            logger.log(LogCategory.TAX, `Annual True-Up: Underpaid by $${taxDifference.toFixed(0)}. Debiting ${liquidAsset.displayName}.`);
            liquidAsset.debit(taxBill, { type: EventType.TAX_TRUE_UP, data: { direction: 'underpayment' } });
            liquidAsset.addToMetric(Metric.ESTIMATED_INCOME_TAX, taxBill.copy().flipSign());
        } else {
            // Overpaid — credit the refund
            const taxRefund = new Currency(Math.abs(taxDifference));
            logger.log(LogCategory.TAX, `Annual True-Up: Overpaid by $${Math.abs(taxDifference).toFixed(0)}. Refunding to ${liquidAsset.displayName}.`);
            liquidAsset.credit(taxRefund, { type: EventType.TAX_TRUE_UP, data: { direction: 'refund' } });
            liquidAsset.addToMetric(Metric.ESTIMATED_INCOME_TAX, taxRefund);
        }

    }

}
