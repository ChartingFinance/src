/**
 * premium-credit-engine.js
 *
 * The ACA premium tax credit (IRC §36B) as a household receives it: an advance
 * each month toward its health-insurance cards' premiums, paid on an estimate of
 * the year's income, and the year's reconciliation on the return, from the
 * income the plan actually produced. premium-tax-credit.js owns the law; this
 * engine supplies the household's figures and moves the money.
 *
 * ── The cards ────────────────────────────────────────────────────────
 *
 * A card counts for a month when it is open, inside its dates, and has the
 * credit on. The household's premiums and benchmarks are summed across its
 * cards, as Form 8962 sums the household's 1095-A statements, and each card is
 * paid its share of the advance in proportion to its premium.
 *
 * ── The estimate ─────────────────────────────────────────────────────
 *
 * Each year's advance is paid on an estimate of that year's ACA MAGI:
 *
 *   - the previous year's recorded ACA MAGI, when the household had a card all
 *     twelve months of that year, as a renewing household reports it;
 *   - otherwise a card's estimated income, as a household joining the
 *     marketplace states it;
 *   - otherwise none, and nothing is advanced that year.
 *
 * An estimate from 100% to 400% of the poverty line is advanced; any other is
 * not, as the marketplace would not.
 *
 * ── The reconciliation ───────────────────────────────────────────────
 *
 * In the annual pass, after the true-up and NIIT, the credit is recomputed from
 * the settled year's ACA MAGI over the months covered. Excess advance is repaid
 * in full, with no cap from 2026 (P.L. 119-21), and credit still owed is paid
 * to the household. Both book in January, like the true-up.
 *
 * The plan's first year, when it starts after January, is reconciled against
 * the estimate instead: its record holds only the months inside the plan, and
 * the plan cannot see the ones before it began.
 */

import { Currency } from '../utils/currency.js';
import { InstrumentType } from '../instruments/instrument.js';
import { Metric } from '../metric.js';
import { FundTransferOneSided, FundTransfer } from '../fund-transfer.js';
import { logger, LogCategory } from '../utils/logger.js';
import { formatCurrency } from '../utils/html.js';
import { EventType, ShortfallOrigin } from '../sim-event.js';
import { withTrace, TraceKind } from '../trace.js';
import { MagiPurpose } from '../tax-basis.js';
import {
    ptcTableFor, povertyLine, fplPercent, applicableFigure, premiumTaxCredit,
    LAST_PUBLISHED_YEAR,
} from '../premium-tax-credit.js';

export class PremiumCreditEngine {

    /**
     * @param {ModelAsset[]} modelAssets
     * @param {FinancialPackage} monthly
     * @param {object} config  the run's SimConfig
     * @param {object} plan    what the engine reads from its portfolio
     * @param {object[]} plan.taxYears  the run's TaxYear records, appended as
     *                                  each year settles
     * @param {number} plan.firstYear   the plan's first calendar year
     * @param {(year: number) => number} plan.monthsInPlanYear
     */
    constructor(modelAssets, monthly, config, { taxYears, firstYear, monthsInPlanYear }) {
        this.modelAssets = modelAssets;
        this.monthly = monthly;
        this.config = config;
        this.taxYears = taxYears;
        this.firstYear = firstYear;
        this.monthsInPlanYear = monthsInPlanYear;

        // Coverage year → { table, size, estimate, advance, months, advanced }.
        // `advance` is null when nothing is advanced that year.
        this.years = new Map();
    }

    // ── Day 30: the advance ──────────────────────────────────────────

    /**
     * Set each card's advance credit for the month, before the month's bills
     * are paid, and record the month's coverage for the reconciliation.
     */
    applyMonthlyAdvance(currentDateInt) {
        let any = false;
        for (const modelAsset of this.modelAssets) {
            if (!InstrumentType.isHealthInsurance(modelAsset.instrument)) continue;
            modelAsset.monthlyAdvanceCredit = Currency.zero();
            modelAsset.monthlyAdvanceData = null;
            any = true;
        }
        if (!any) return;

        const cards = this.#coveringCards(currentDateInt);
        if (cards.length === 0) return;

        const record = this.#yearRecord(currentDateInt.year, cards);
        const premiums = cards.map((card) => Math.abs(card.finishCurrency.amount));
        const premium = premiums.reduce((sum, p) => sum + p, 0);
        const benchmark = cards.reduce((sum, card) => sum + card.benchmarkCurrency.amount, 0);
        record.months.push({ premium, benchmark });

        if (!record.advance || !(premium > 0)) return;

        const credit = Math.min(premium, Math.max(0, benchmark - record.advance.monthlyContribution));
        cards.forEach((card, i) => {
            const share = Math.min(1, Math.max(0, card.advanceCreditShare ?? 1));
            const amount = credit * (premiums[i] / premium) * share;
            if (!(amount > 0)) return;
            card.monthlyAdvanceCredit = new Currency(amount);
            card.monthlyAdvanceData = {
                estimate: record.estimate,
                percent: record.advance.percent,
                share,
            };
            record.advanced += amount;
        });
    }

    /** Health-insurance cards with the credit on that cover this month. */
    #coveringCards(currentDateInt) {
        return this.modelAssets.filter((a) =>
            InstrumentType.isHealthInsurance(a.instrument)
            && a.premiumTaxCreditEnabled !== false
            && !a.isClosed
            && a.inMonth(currentDateInt));
    }

    /** This coverage year's record, created with its table and estimate on its first month. */
    #yearRecord(year, cards) {
        const existing = this.years.get(year);
        if (existing) return existing;

        const table = this.#tableFor(year, cards);
        const size = this.#householdSize(cards);
        const estimate = this.#estimate(year, cards);

        let advance = null;
        if (estimate != null) {
            const line = povertyLine(table, size);
            if (estimate >= line && estimate <= table.cliff * line) {
                const percent = fplPercent(estimate, table, size);
                const applicable = applicableFigure(table, percent);
                const monthlyContribution = Math.round(Math.round(estimate * applicable) / 12);
                advance = { percent, monthlyContribution };
            }
        }

        const record = { year, table, size, estimate, advance, months: [], advanced: 0 };
        this.years.set(year, record);
        return record;
    }

    /** See "The estimate" in the module header. */
    #estimate(year, cards) {
        const prior = this.taxYears.find((t) => t.year === year - 1);
        if (prior && prior.months === 12 && this.years.get(year - 1)?.months.length === 12) {
            return prior.magi[MagiPurpose.ACA];
        }
        const card = cards.find((c) => c.estimatedAcaIncome != null);
        return card ? card.estimatedAcaIncome.amount : null;
    }

    /**
     * The household's size for the poverty line: the largest a card names, or
     * the tax household filing status implies.
     */
    #householdSize(cards) {
        const named = cards.map((c) => c.householdSize).filter((n) => Number.isFinite(n) && n >= 1);
        return named.length ? Math.max(...named) : this.config.taxTable.householdPersons;
    }

    /**
     * The year's parameters. Past the last published year the poverty line
     * follows the price level the run indexes the tax tables by, and the
     * percentages move with the first card's premium growth over plan
     * inflation (premium-tax-credit.js).
     */
    #tableFor(year, cards) {
        if (year <= LAST_PUBLISHED_YEAR) return ptcTableFor(year);
        const inflation = this.config.inflationRate;
        const excess = cards[0].premiumExcessOverInflation ?? 0;
        return ptcTableFor(year, {
            priceLevel: this.#priceLevel(year) / this.#priceLevel(LAST_PUBLISHED_YEAR),
            percentageGrowth: (1 + inflation + excess) / (1 + inflation),
        });
    }

    /**
     * The tax tables' price level in `year`, relative to the plan's first year.
     * Outside the years the run has indexed, extended at plan inflation.
     */
    #priceLevel(year) {
        const levels = this.config.taxTable.priceLevels ?? [1];
        const k = year - this.firstYear;
        const growth = 1 + this.config.inflationRate;
        if (k < 0) return Math.pow(growth, k);
        if (k < levels.length) return levels[k];
        return levels[levels.length - 1] * Math.pow(growth, k - (levels.length - 1));
    }

    // ── Annual pass: the reconciliation ──────────────────────────────

    /**
     * Settle the year's credit. Runs from the annual pass, after NIIT.
     *
     * @param {number} settledYear
     * @param {object} basis  taxableBasis() of the settled year's package
     * @returns {{ptc: number, aptc: number, fplPercent: number|null,
     *            eligibility: string, onEstimate: boolean}|null}
     *          null when no card covered the year; `onEstimate` when the
     *          plan's partial first year was settled against the estimate
     */
    reconcile(settledYear, basis) {
        const record = this.years.get(settledYear);
        if (!record || record.months.length === 0) return null;

        const partial = this.monthsInPlanYear(settledYear) < 12;
        const income = partial ? record.estimate : basis.magi[MagiPurpose.ACA].amount;

        const result = income == null
            ? { total: 0, percent: null, eligibility: null }
            : premiumTaxCredit({
                table: record.table,
                householdSize: record.size,
                householdIncome: income,
                months: record.months,
                advanceIncome: record.advance ? record.estimate : null,
            });

        const allowed = result.total;
        const net = allowed - record.advanced;
        const figures = {
            ptc: allowed, aptc: record.advanced,
            fplPercent: result.percent, eligibility: result.eligibility,
            onEstimate: partial,
        };

        // The same $1 gate as the true-up and NIIT, and checked before any trace
        // scope opens, so a year that settles nothing records no empty scope.
        if (Math.abs(net) < 1) return figures;

        const anchor = this.#unfundedAnchor();
        withTrace(TraceKind.TAX_TRUE_UP, 'Premium tax credit reconciliation',
            anchor?.currentDateInt ?? null,
            () => this.#bookReconciliation(net, {
                allowed, advanced: record.advanced, percent: result.percent,
            }, anchor));
        return figures;
    }

    #bookReconciliation(net, data, anchor) {

        if (net > 0) {
            // Credit still owed: a refundable credit on the return.
            const owed = new Currency(net);
            const target = FundTransfer.resolveDeposit(this.modelAssets);
            if (!target) {
                logger.log(LogCategory.SANITY,
                    () => `Premium tax credit of ${owed.toString()} could not be credited — `
                    + `the plan has no everyday account at all`);
                return;
            }
            target.credit(owed, { type: EventType.PTC_RECONCILIATION,
                data: { direction: 'credit', ...data } });
            target.addToMetric(Metric.PTC_RECONCILIATION, owed.copy());
            this.monthly.ptcReconciliation.add(owed);
            logger.log(LogCategory.TAX,
                () => `Premium tax credit: ${formatCurrency(data.allowed)} allowed, `
                + `${formatCurrency(data.advanced)} advanced; crediting ${target.displayName}.`);
            return;
        }

        // Excess advance: repaid in full.
        const repayment = new Currency(-net);
        const liquidAsset = FundTransfer.resolveFunding(this.modelAssets);
        if (!liquidAsset) {
            FundTransfer.reportUnfunded(anchor, repayment,
                'premium tax credit repayment', ShortfallOrigin.ONE_SIDED);
            return;
        }

        const oneSided = new FundTransferOneSided(null, repayment);
        oneSided.toModel = liquidAsset;
        const settled = FundTransfer.settleOneSided(oneSided,
            { type: EventType.PTC_RECONCILIATION, data: { direction: 'repayment', ...data } },
            this.modelAssets);

        liquidAsset.addToMetric(Metric.PTC_RECONCILIATION, settled.supplied.copy().flipSign());
        this.monthly.recordTransfer(liquidAsset.instrument, settled.supplied, settled.realizedGain);

        if (settled.spillover.amount > 0 && settled.spilloverInstrument) {
            this.monthly.recordTransfer(settled.spilloverInstrument, settled.spillover, settled.spilloverGain);
            // What the fallback paid, on the account that paid it. Asked again
            // after the draw, as the true-up does.
            const fallbackPaid = settled.paid.minus(settled.supplied);
            const payer = FundTransfer.resolveFunding(this.modelAssets);
            if (payer && fallbackPaid.amount > 0) {
                payer.addToMetric(Metric.PTC_RECONCILIATION, fallbackPaid.copy().flipSign());
            }
        }

        // What the accounts paid, less anything reported unfunded.
        if (settled.paid.amount > 0) this.monthly.ptcReconciliation.add(settled.paid.copy().flipSign());
        logger.log(LogCategory.TAX,
            () => `Premium tax credit: ${formatCurrency(data.allowed)} allowed, `
            + `${formatCurrency(data.advanced)} advanced; repaying ${repayment.toString()} `
            + `from ${liquidAsset.displayName}.`);
    }

    /**
     * Where an unpayable repayment is reported: the largest open balance, the
     * account the household would have to draw from (TaxEngine does the same).
     */
    #unfundedAnchor() {
        let best = null;
        for (const modelAsset of this.modelAssets) {
            if (modelAsset.isClosed) continue;
            if (!best || modelAsset.finishCurrency.amount > best.finishCurrency.amount) best = modelAsset;
        }
        return best ?? this.modelAssets[0] ?? null;
    }
}
