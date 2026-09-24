import { Currency } from './utils/currency.js';
import { InstrumentType } from './instruments/instrument.js';
import { MonthsSpan } from './utils/months-span.js';
import { logger, LogCategory } from './utils/logger.js';
import { ModelLifeEvent } from './life-event.js';
import { User } from './user.js';
import { withSimConfig } from './sim-config.js';
import { FundTransfer } from './fund-transfer.js';
import { EventType, ShortfallOrigin } from './sim-event.js';
import { withTrace, TraceKind } from './trace.js';
import { monthLabel, DateInt } from './utils/date-int.js';
import { FinancialPackage } from './financial-package.js';
import { PayrollEngine } from './engines/payroll-engine.js';
import { ExpenseEngine } from './engines/expense-engine.js';
import { TaxEngine } from './engines/tax-engine.js';
import { RebalanceEngine } from './engines/rebalance-engine.js';

export { FinancialPackage, FINANCIAL_FIELDS } from './financial-package.js';

/**
 * How each kind of engine event takes part in monthly reconciliation.
 *
 * Keyed on EventType, not on memo text: a renamed type is an error at load
 * time rather than a wrong number at run time, and monthlySanityCheck throws on
 * a type missing from this table.
 *
 * The named buckets (`fica`, `incomeTax`, …) are compared with the matching
 * FinancialPackage field. The others:
 *
 *   `excluded`  events that move a balance without being a transfer (growth,
 *               dividends, interest), or that name cash already counted.
 *   `paired`    two-sided transfers, which must net to zero.
 *   `oneSided`  single-legged movements, not expected to net to zero. Only
 *               cash-kind events count; info-kind events land here so the kind
 *               check, not this table, is what excludes them.
 */
export const EVENT_RECONCILIATION = Object.freeze({
    [EventType.FICA_WITHHOLDING]:        'fica',
    [EventType.INCOME_TAX_WITHHOLDING]:  'incomeTax',
    [EventType.CAPITAL_GAIN_RECOGNIZED]: 'capitalGains',
    [EventType.CAPITAL_GAINS_TAX]:       'capitalGainsTax',
    [EventType.MORTGAGE_INTEREST]:       'mortgageInterest',
    [EventType.MORTGAGE_PRINCIPAL]:      'mortgagePrincipal',
    [EventType.PROPERTY_TAX]:            'propertyTax',

    // §121 removes gain from the tax base without moving cash or changing the
    // gain realised, so it stays out of the capitalGains bucket, which balances
    // against the gross monthly.longTermCapitalGains.
    [EventType.CAPITAL_GAIN_EXCLUDED]:   'excluded',

    [EventType.ASSET_GROWTH]:            'excluded',
    [EventType.EXPENSE_INFLATION]:       'excluded',
    [EventType.INCOME_GROWTH]:           'excluded',
    [EventType.DIVIDEND]:                'excluded',
    [EventType.INTEREST_INCOME]:         'excluded',

    // Two-sided: execute() debits one account and credits another by the same
    // amount, so these must net to zero, and a residue is a real defect.
    [EventType.TRANSFER]:                'paired',

    // Single-legged by design: settleOneSided debits the funding account and
    // books nothing on the obligation it pays; a windfall credits one account
    // with no counterparty; the annual true-up debits one account.
    [EventType.SETTLEMENT]:              'oneSided',
    [EventType.SPILLOVER]:               'oneSided',
    [EventType.GROSS_UP]:                'oneSided',
    [EventType.ONE_TIME]:                'oneSided',
    [EventType.TAX_TRUE_UP]:             'oneSided',

    // Names part of a GROSS_UP that already reconciled; counting it again would
    // book the same dollars twice.
    [EventType.TAX_PROVISION]:           'excluded',
    [EventType.NIIT_ASSESSED]:           'oneSided',

    // Info-kind: no money moved, so the kind check keeps them out of every
    // total.
    [EventType.PROPERTY_TAX_ESCROW]:     'oneSided',
    [EventType.MAINTENANCE]:             'oneSided',
    [EventType.INSURANCE]:               'oneSided',
    [EventType.UNFUNDED]:                'oneSided',
    [EventType.CONTRIBUTION_CAPPED]:     'oneSided',
});

/**
 * The old note→bucket map. The engine does not read it; tests/memo-vocabulary.mjs
 * uses it to lock the memo wording, which portfolio-issues and rule-notes still
 * match on. Delete it when they read event types instead.
 */
export const MEMO_RECONCILIATION = Object.freeze({
    'FICA withholding':              'fica',
    'Income tax withholding':        'incomeTax',
    'Capital gains':                 'capitalGains',
    'Capital gains (spillover)':     'capitalGains',
    'Capital gains tax withholding': 'capitalGainsTax',
    'Mortgage Interest':             'mortgageInterest',
    'Mortgage Principal':            'mortgagePrincipal',
    'Property tax':                  'propertyTax',

    'Qualified dividend':            'excluded',
    'Non-qualified dividend':        'excluded',
    'Interest income':               'excluded',
    'Asset growth':                  'excluded',
    'Expense inflation':             'excluded',
    'Annual income growth':          'excluded',
});

/**
 * Which reconciliation total an event belongs to, or null for none.
 *
 * Mostly a table lookup. SPILLOVER and UNFUNDED are the exception: both mean
 * "the part of a movement one account could not supply", and both come from the
 * two-sided execute() path and the one-sided settleOneSided path. Only the
 * two-sided total nets to zero, so each shortfall follows the movement that
 * produced it (`data.origin`).
 */
function conservationBucket(event, bucket) {
    // A shortfall completes whatever movement produced it. UNFUNDED is
    // info-kind (no cash moved) but still counts: it is the gap between what a
    // movement asked for and what it delivered.
    if (event.type === EventType.SPILLOVER || event.type === EventType.UNFUNDED) {
        // Except a spill that paid income tax. TaxEngine.#withholdInScope books
        // monthly.incomeTax for the spilled leg, and this SPILLOVER is its only
        // cash event, so it belongs to the income-tax total. `cause:
        // 'withholding'` is set in exactly one place, by the same block that
        // books the tax.
        if (event.type === EventType.SPILLOVER && event.data?.cause === 'withholding') {
            return 'incomeTax';
        }
        return event.data?.origin === ShortfallOrigin.PAIRED ? 'paired' : 'oneSided';
    }

    // Movement totals take cash only. Recognition and attribution moved no
    // money and are not a gap either, so they participate in nothing.
    if (bucket === 'paired' || bucket === 'oneSided') {
        return event.kind === 'info' ? null : bucket;
    }

    // The named tax/housing buckets take the event whatever its kind, because
    // mortgage interest, property tax and capital-gain recognition are all
    // info-kind and are precisely what those checks compare.
    return bucket;
}

export class Portfolio {
    constructor(modelAssets, reports, config) {
        this.modelAssets = this.sortModelAssets(modelAssets);
        this.reports = !!reports;

        /**
         * The run's configuration. Required, and frozen, so another plan in the
         * same process cannot change this run's settings. Callers build their
         * own: `simConfigFromGlobals()` in the app and tests,
         * `simConfigFromPlanSpec()` in the MCP server.
         */
        if (!config) {
            throw new Error(
                'Portfolio requires a SimConfig. Build one with '
                + 'simConfigFromGlobals() (app, tests) or simConfigFromPlanSpec() '
                + '(MCP). It used to default to a capture of the module globals; '
                + 'that default was removed in Spec 9 step 6.');
        }
        this.config = config;

        this.generatedReports = [];
        // Bind first: `lastDateInt()` below reads each asset's derived
        // `effectiveFinishDateInt`, which throws on an unbound asset.
        this.bindEnvironment();

        // ── The plan's anchor ────────────────────────────────────────
        //
        // The birth year every age↔date conversion uses, taken from the plan's
        // own first month and never from the clock, so a saved plan means the
        // same thing whenever it is run. Order matters: `firstDateInt` reads
        // only absolute start dates, while `lastDateInt` reads derived finish
        // dates that need the anchor — so the anchor is set in between.
        // `withSimConfig`, because the config is frozen.
        this.firstDateInt = firstDateInt(this.modelAssets);

        const birthYear = this.firstDateInt
            ? this.firstDateInt.year - this.config.startAge : undefined;
        if (birthYear !== undefined) {
            this.config = withSimConfig(this.config, { birthYear });
            // Rebind: the assets and life events are holding the pre-anchor
            // config, and every derived date getter reads it.
            this.bindEnvironment();
        }

        this.lastDateInt = lastDateInt(this.modelAssets);

        this.activeUser = new User(this.config.startAge, birthYear);

        // The starting age, restored by initializeChron. The chronometer ages
        // activeUser a year per simulated year, and the GA optimizer re-runs
        // one Portfolio thousands of times; each run must start at this age.
        this.startUserAge = this.activeUser.age;

        // Guardrails (Guyton-Klinger) — set before chronometer_run to activate
        this.guardrailsParams = null; // { withdrawalRate, preservation, prosperity, adjustment }
        this.guardrailEvents = [];    // [{ year, type, rate, adjustedTo }]
        this.yearlySnapshots = [];    // [{ year, months, partial, investableAssets, annualExpense, withdrawalRate }]

        // Life events timeline
        this.lifeEvents = [];

        this.monthly = new FinancialPackage();
        this.yearly = new FinancialPackage();
        this.total = new FinancialPackage();

        this.monthlyPackages = []; // FP copy per month — for double-entry testing

        // Cumulative price level per month, base 1.0 at the plan's first month.
        // Written by the simulation loop (chronometer_run / mc-compute runOnce);
        // consumers deflate nominal series with it. Derived state — never
        // serialised, rebuilt on every run.
        this.monthlyPriceIndex = [];

        this.monthlyPropertyTaxes = [];
        this.monthlyIncomeTaxes = [];
        this.monthlyCapitalGainsTaxes = [];

        this.displayCapitalGainsTaxes = [];

    }

    sortModelAssets(modelAssets) {
        // INIT, not GENERAL: this runs in every constructor, and Monte Carlo
        // builds a Portfolio per iteration.
        logger.log(LogCategory.INIT, 'Portfolio.sortModelAssets');
    
        modelAssets.sort(function (a, b) {
            if (a.sortIndex() < b.sortIndex())
                return -1;
            else if (b.sortIndex() < a.sortIndex())
                return 1;
            else
                return a.displayName.localeCompare(b.displayName);
        });
    
        return modelAssets;
    }

    copy() {

        let modelAssets = this.modelAssets.map(modelAsset => modelAsset.copy());
        // The same config as the source, never a fresh capture of the settings.
        let portfolio = new Portfolio(modelAssets, false, this.config);

        portfolio.monthly = this.monthly.copy();
        portfolio.yearly  = this.yearly.copy();
        portfolio.total   = this.total.copy();
        portfolio.lifeEvents = this.lifeEvents.map(e => e.copy());

        // Copies arrive unbound (see bindEnvironment), and their derived getters
        // would throw.
        portfolio.bindEnvironment();

        // Snapshot the trace/summary arrays so consumers of the copy observe
        // the state produced by the run being copied. Subsequent mutations on
        // the source portfolio (next chronometer run populating its own
        // guardrailEvents, yearlySnapshots, etc.) must not leak in.
        portfolio.guardrailEvents         = [...this.guardrailEvents];
        portfolio.yearlySnapshots         = [...this.yearlySnapshots];
        portfolio.generatedReports        = [...this.generatedReports];
        portfolio.monthlyPackages         = this.monthlyPackages.map(p => p.copy());
        portfolio.monthlyPriceIndex       = [...this.monthlyPriceIndex];
        portfolio.monthlyPropertyTaxes    = [...this.monthlyPropertyTaxes];
        portfolio.monthlyIncomeTaxes      = [...this.monthlyIncomeTaxes];
        portfolio.monthlyCapitalGainsTaxes = [...this.monthlyCapitalGainsTaxes];
        portfolio.displayCapitalGainsTaxes = [...this.displayCapitalGainsTaxes];
        portfolio.guardrailsParams        = this.guardrailsParams ? { ...this.guardrailsParams } : null;

        return portfolio;

    }

    zeroFundTransfersMonthlyMoveValues() {

        for (let modelAsset of this.modelAssets) {
            modelAsset.zeroFundTransfersMonthlyMoveValues();
        }

    }

    dnaFundTransfers() {

        let result = '';
        for (let modelAsset of this.modelAssets) {
            result += modelAsset.dnaFundTransfers();
        }
        return result;

    }

    /**
     * Hand every asset and life event this run's config.
     *
     * The Portfolio owns the one config; assets and life events borrow it. They
     * are plan data — serialised, stored, copied — while the config is run
     * state, and copies that each held their own could silently disagree.
     *
     * Idempotent. Called from the constructor, from initializeChron (every
     * run), and from copy(), because both collections copy unbound.
     */
    bindEnvironment() {
        for (const modelAsset of this.modelAssets) modelAsset.bindEnv(this.config);
        // `?? []` because the constructor calls this before lifeEvents is
        // assigned — see the call site there.
        for (const event of this.lifeEvents ?? []) event.bindEnv(this.config);
    }

    initializeChron() {

        // Reset the run's tax table with the rest of the run state, before the
        // engines are built.
        if (!this.config.taxTable) {
            throw new Error('Portfolio: the run config has no tax table.');
        }
        this.config.taxTable.initializeChron();

        // Rebind, so assets and life events hold the config this run uses.
        this.bindEnvironment();

        // Rewind the user to the starting age, or successive runs of one
        // Portfolio simulate different ages. Mutated in place: engines and
        // callers hold references to it.
        this.activeUser.setAge(this.startUserAge);
        this.activeUser.month = 0;

        this.monthly = new FinancialPackage();
        this.yearly = new FinancialPackage();
        this.total = new FinancialPackage();
        this.monthlyPackages = [];
        this.monthlyPriceIndex = [];

        for (let modelAsset of this.modelAssets) {
            modelAsset.initializeChron();
        }

        // Reset life event applied flags for re-simulation
        for (const event of this.lifeEvents) {
            event.applied = false;
        }

        // Load first phase's transfers onto assets
        if (this.lifeEvents.length > 0) {
            this.applyPhaseTransfers(this.lifeEvents[0]);
        }

        // The one place the engines are built.
        this.taxes = new TaxEngine(this.modelAssets, this.monthly, this.yearly, this.activeUser, this.config);
        this.payroll = new PayrollEngine(this.modelAssets, this.monthly, this.yearly, this.activeUser, this.taxes, this.config);
        this.expenses = new ExpenseEngine(this.modelAssets, this.monthly, this.activeUser, this.config);
        this.rebalance = new RebalanceEngine(this.modelAssets, this.monthly, this.yearly, this.activeUser, this.config);
    }

    /**
     * Apply any life events whose trigger falls in the current month. Called on
     * day 1 by the chronometer, before applyMonth.
     */
    applyLifeEvents(currentDateInt) {
        for (const event of this.lifeEvents) {
            if (event.applied) continue;
            const trigger = event.triggerDateInt;
            if (trigger.year === currentDateInt.year && trigger.month === currentDateInt.month) {
                // Its own causal root: life events fire before applyMonth
                // opens the month's scope.
                withTrace(TraceKind.MONTH, `Life event: ${event.displayName}`, currentDateInt,
                    () => event.apply(this, currentDateInt));
            }
        }
    }

    /**
     * Populate asset.fundTransfers from a life event's phaseTransfers map.
     * Called by initializeChron() for phase 0, and by ModelLifeEvent.apply() for subsequent phases.
     */
    applyPhaseTransfers(phaseEvent) {
        if (!phaseEvent?.phaseTransfers) return;
        for (const [assetName, transfersJSON] of Object.entries(phaseEvent.phaseTransfers)) {
            const asset = findByName(this.modelAssets, assetName);
            if (!asset || asset.isClosed) continue;
            asset.fundTransfers = transfersJSON.map(FundTransfer.fromJSON);
        }
    }

    /**
     * @param {DateInt} currentDateInt the month this pass runs on
     * @param {DateInt} [settledOverride] the month the unscanned events actually
     *   belong to. Only the trailing pass needs it — see finalSanityCheck.
     */
    monthlySanityCheck(currentDateInt, settledOverride = null) {
        const buckets = {};
        for (const b of Object.values(EVENT_RECONCILIATION)) buckets[b] = 0;

        for (const modelAsset of this.modelAssets) {
            const startIdx = modelAsset.eventsCheckedIndex || 0;
            for (let i = startIdx; i < modelAsset.events.length; i++) {
                const event = modelAsset.events[i];
                const bucket = EVENT_RECONCILIATION[event.type];

                // An unmapped type is a programming error: someone added an
                // event without saying how it reconciles.
                if (!bucket) {
                    throw new Error(
                        `monthlySanityCheck: event type "${event.type}" has no entry in ` +
                        `EVENT_RECONCILIATION — declare how it reconciles before emitting it`);
                }

                const target = conservationBucket(event, bucket);
                if (target) buckets[target] += event.amount.amount;
            }
            modelAsset.eventsCheckedIndex = modelAsset.events.length;
        }

        // Label findings with the month whose events are reconciled.
        // chronometer_run advances currentDateInt before monthlyChron, so the
        // raw value is a month ahead of the events.
        let settled = settledOverride;
        if (!settled) {
            settled = DateInt.from(currentDateInt.year, currentDateInt.month);
            settled.addMonths(-1);
        }

        const tolerance = 0.01;
        const check = (label, eventTotal, packageTotal) => {
            if (Math.abs(eventTotal - packageTotal) > tolerance) {
                logger.log(LogCategory.SANITY, `${settled} ${label}: events=${eventTotal.toFixed(2)}, package=${packageTotal.toFixed(2)}`);
            }
        };

        check('FICA', buckets.fica, this.monthly.fica().amount);
        check('Income tax', buckets.incomeTax, this.monthly.incomeTax.amount);
        check('Mortgage interest', buckets.mortgageInterest, this.monthly.mortgageInterest.amount);
        // Negated: the event tracks the mortgage balance moving toward zero
        // (positive), while the package tracks household cash going out
        // (negative). Both are right about different things.
        check('Mortgage principal', buckets.mortgagePrincipal, -this.monthly.mortgagePrincipal.amount);
        check('Property taxes', buckets.propertyTax, this.monthly.propertyTaxes.amount);
        check('Capital gains', buckets.capitalGains, this.monthly.longTermCapitalGains.amount);
        check('Capital gains tax', buckets.capitalGainsTax, this.monthly.longTermCapitalGainsTax.amount);

        // Two-sided conservation:
        //
        //     TRANSFER + SPILLOVER(paired) + UNFUNDED(paired) === 0
        //
        // A transfer's two legs cancel unless the debited account clamps at $0;
        // then the shortfall is either re-sourced (SPILLOVER) or not sourced at
        // all (UNFUNDED). A residue means money appeared or vanished.
        // One-sided settlements are not expected to balance and are excluded.
        //
        // This finding is labelled with currentDateInt, not `settled` like the
        // checks above, so it reads one month late.
        if (Math.abs(buckets.paired) > tolerance) {
            logger.log(LogCategory.SANITY, `${currentDateInt} Transfer conservation broken: ${buckets.paired.toFixed(2)}`);
        }
    }

    /**
     * Reconcile the events the loop left behind. Called once, after the last
     * iteration.
     *
     * chronometer_run calls applyYear after monthlyChron, so the annual
     * true-up's events always fall after the scan. Mid-run the next month's pass
     * picks them up, which is correct: monthlyChron zeroes this.monthly before
     * applyYear, so the true-up's package bookings land in that same next month.
     * The final year has no next pass, so its true-up events need this one —
     * including the check that throws on an undeclared event type.
     *
     * Not a scan after every applyYear: that consumes the true-up's events a
     * month before its package bookings are compared, and produces false
     * findings the following month.
     */
    finalSanityCheck(currentDateInt) {
        // The trailing events happened on currentDateInt itself, so they are
        // labelled with it rather than the month before.
        this.monthlySanityCheck(currentDateInt,
            DateInt.from(currentDateInt.year, currentDateInt.month));
    }

    monthlyChron(currentDateInt) {

        this.reportMonthly(currentDateInt);

        this.monthlySanityCheck(currentDateInt);

        this.computePerAssetCashFlow();

        // Snapshot portfolio value — sum of all asset balances
        for (const modelAsset of this.modelAssets) {
            this.monthly.value.add(modelAsset.finishCurrency);
        }

        this.monthlyPackages.push(this.monthly.copy());
        this.yearly.add(this.monthly);
        this.total.add(this.monthly);
        this.monthly.zero();

        for (let modelAsset of this.modelAssets) {
            modelAsset.monthlyChron(currentDateInt);
        }
    }

    computePerAssetCashFlow() {
        for (let modelAsset of this.modelAssets) {
            if (modelAsset.isClosed) {
                modelAsset.cashFlowCurrency = Currency.zero();
            } else {
                modelAsset.cashFlowCurrency = modelAsset.behavior.computeCashFlow(modelAsset);
            }
        }
    }

    yearlyChron(currentDateInt) {

        this.reportYearly(currentDateInt);
        this.yearly.zero();
        this.activeUser.addYears(1);

    }

    finalizeChron() {
        for (let modelAsset of this.modelAssets) {
            modelAsset.finalizeChron();
        }
    }
    
    sumAssetCurrency(property) {

        let amount = new Currency(0.0);
        for (let modelAsset of this.modelAssets) {
            if (InstrumentType.isAsset(modelAsset.instrument))
                amount.add(modelAsset[property]);
        }
        return amount;

    }

    startValue() {
        return this.sumAssetCurrency('startCurrency');
    }

    finishValue() {
        return this.sumAssetCurrency('finishCurrency');
    }

    accumulatedValue() {
        return this.sumAssetCurrency('cashFlowAccumulatedCurrency');
    }

    getTotalInvestableAssets() {
        let total = new Currency(0);
        for (const a of this.modelAssets) {
            if ((InstrumentType.isExpensable(a.instrument) || InstrumentType.isIncomeAccount(a.instrument)) && !a.isClosed) {
                total.add(a.finishCurrency);
            }
        }
        return total;
    }

    /**
     * How many months of the calendar `year` actually fall inside the plan.
     * The first and last years are short when the plan starts or ends
     * mid-year; every year between them is a full 12. Used to mark yearly
     * snapshots as partial so consumers do not read a stub year's spend as a
     * full year of spending.
     */
    monthsInPlanYear(year) {
        const startMonth = year === this.firstDateInt?.year ? this.firstDateInt.month : 1;
        const endMonth   = year === this.lastDateInt?.year  ? this.lastDateInt.month  : 12;
        return Math.max(0, endMonth - startMonth + 1);
    }

    applyGuardrails(currentDateInt) {
        if (!this.guardrailsParams) return;

        const investable = this.getTotalInvestableAssets().amount;
        if (investable <= 0) return;

        const annualExpense = Math.abs(this.yearly.expense.amount);
        const currentRate = annualExpense / investable;
        const snapshotYear = currentDateInt.year - 1;
        const monthsElapsed = this.monthsInPlanYear(snapshotYear);
        const initialRate = this.guardrailsParams.withdrawalRate / 100;
        const preservationThreshold = this.guardrailsParams.preservation / 100;
        const prosperityThreshold = this.guardrailsParams.prosperity / 100;
        const adjustmentPct = this.guardrailsParams.adjustment / 100;

        this.yearlySnapshots.push({
            year: snapshotYear,
            months: monthsElapsed,
            partial: monthsElapsed < 12,
            investableAssets: investable,
            annualExpense,
            withdrawalRate: currentRate,
        });

        // Only apply guardrail adjustments after retirement
        const retirementDate = this.guardrailsParams.retirementDateInt;
        if (retirementDate && currentDateInt.toInt() < retirementDate.toInt()) return;

        const upperGuardrail = initialRate * (1 + preservationThreshold);
        const lowerGuardrail = initialRate * (1 - prosperityThreshold);

        if (currentRate > upperGuardrail) {
            // Preservation: cut expenses
            for (const a of this.modelAssets) {
                if (InstrumentType.isMonthlyExpense(a.instrument) && !a.isClosed) {
                    a.finishCurrency.multiply(1 - adjustmentPct);
                }
            }
            this.guardrailEvents.push({
                year: currentDateInt.year - 1,
                type: 'preservation',
                rate: currentRate,
                adjustedTo: currentRate * (1 - adjustmentPct),
            });
        } else if (currentRate < lowerGuardrail) {
            // Prosperity: raise expenses
            for (const a of this.modelAssets) {
                if (InstrumentType.isMonthlyExpense(a.instrument) && !a.isClosed) {
                    a.finishCurrency.multiply(1 + adjustmentPct);
                }
            }
            this.guardrailEvents.push({
                year: currentDateInt.year - 1,
                type: 'prosperity',
                rate: currentRate,
                adjustedTo: currentRate * (1 + adjustmentPct),
            });
        }
    }
    
    applyMonth(currentDateInt) {
        // Root of every causal chain: the month. applyMonth runs on days 1, 15
        // and 30, so a month opens three roots with the same label; a chain
        // still reads "November 2051 > Pay Living Expenses > ...".
        return withTrace(TraceKind.MONTH, monthLabel(currentDateInt), currentDateInt,
            () => this.#applyMonthInScope(currentDateInt));
    }

    #applyMonthInScope(currentDateInt) {

        
        if (currentDateInt.day == 1) {

            this.applyFirstDayOfMonth(currentDateInt);
            return this.modelAssets.length; 

        }

        
        else if (currentDateInt.day == 15) {

            for (let modelAsset of this.modelAssets) {
                if (!modelAsset.inMonth(currentDateInt)) continue;
                this.taxes.applyPropertyTaxEscrow(modelAsset, currentDateInt);
            }

        }
        

        else if (currentDateInt.day == 30) {

            this.applyLastDayOfMonth(currentDateInt);            

        }

        return 0;

    }

    applyFirstDayOfMonth(currentDateInt) {

        // new month so update the modelAsset temporals
        for (let modelAsset of this.modelAssets) {
            modelAsset.handleCurrentDateInt(currentDateInt);
        }

        // close assets that are now past their finish date
        for (let modelAsset of this.modelAssets) {
            if (modelAsset.afterFinishDate && !modelAsset.isClosed) {
                this.closeAsset(modelAsset, currentDateInt);
            }
        }

        // Implicitly close mortgages/debts that are fully paid off
        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed && InstrumentType.isMortgage(modelAsset.instrument)
                && modelAsset.monthsRemainingDynamic <= 0) {
                this.closeAsset(modelAsset, currentDateInt);
            }
        }

        // let the model assets know its the first day of the month.
        for (let modelAsset of this.modelAssets) {

            if (!modelAsset.isClosed) {
                modelAsset.applyFirstDayOfMonth(currentDateInt);
            }

        }

        // One-time funding transfers for assets starting this month
        for (const modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed && modelAsset.onStartDate && modelAsset.fundingConfig) {
                this.applyAssetOpenFundTransfer(modelAsset);
            }
        }

        // Day 1 one-time event credits/debits
        for (const modelAsset of this.modelAssets) {
            if (modelAsset.isClosed || !modelAsset.oneTimeEvents?.length) continue;
            for (const event of modelAsset.oneTimeEvents) {
                if (event.dateInt.equals(currentDateInt)) {
                    const descriptor = { type: EventType.ONE_TIME, data: { note: event.note } };
                    if (event.amount.amount >= 0) {
                        modelAsset.credit(event.amount.copy(), descriptor);
                    } else {
                        modelAsset.debit(event.amount.copy().flipSign(), descriptor);
                    }
                }
            }
        }

        // TODO: You can either make contributions or take distributions. Not both.

        // Day 1 payroll pipeline
        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                this.payroll.applyPreTaxCalculations(modelAsset, currentDateInt);
            }
        }

        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                this.payroll.applyPreTaxTransfers(modelAsset);                
            }
        }

        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                this.payroll.calculateRMDs(currentDateInt, modelAsset);
            }
        }

        // Two-phase net income: compute household tax once, then allocate proportionally
        const { householdTax, totalWorkingIncome } = this.payroll.computeHouseholdIncomeTax();
        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                this.payroll.applyNetIncome(modelAsset, householdTax, totalWorkingIncome);
            }
        }

        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                if (InstrumentType.isWorkingIncome(modelAsset.instrument)) {
                    this.payroll.calculateRothIRAContribution(modelAsset);
                }
                this.payroll.calculatePostTaxContributions(modelAsset);
            }
        }

        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                this.payroll.applyPostTaxTransfers(modelAsset);
            }
        }

        // Capital/fundable rebalancing transfers (after payroll so deposits are available)
        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                this.rebalance.applyRebalanceTransfers(modelAsset, currentDateInt);
            }
        }

    }

    applyLastDayOfMonth(currentDateInt) {

        // apply expenses
        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                this.expenses.applyExpenseTransfers(modelAsset, currentDateInt);
            }
        }

        // Recognise asset growth after expenses are paid, so a month's
        // withdrawals do not earn that month's return.
        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                this.expenses.applyAssetGrowth(modelAsset, currentDateInt);
            }
        }

        // RMDs after growth: carrying-cost transfers inside applyAssetGrowth are
        // distributions too, and count toward the month's RMD before any top-up.
        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                this.expenses.ensureRMDs(modelAsset);
            }
        }

        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                modelAsset.applyLastDayOfMonth(currentDateInt);
            }
        }

        // Withhold at the source before the true-up, which collects liability
        // minus what was already withheld.
        this.taxes.withholdOnDeferredDistributions();

        this.taxes.applyMonthlyTaxTrueUp();

    }

    closeAsset(modelAsset, currentDateInt) {

        if (InstrumentType.isMonthlyIncome(modelAsset.instrument) ||
            InstrumentType.isMonthlyExpense(modelAsset.instrument)) {
            logger.log(LogCategory.TRANSFER, 'closing ' + modelAsset.displayName + ' with monthly income or expense, skipping fund transfers');
            modelAsset.close(currentDateInt);
            return;
        }

        const amountToTransfer = new Currency(modelAsset.finishCurrency.amount);
        logger.log(LogCategory.TRANSFER, 'close asset: ' + modelAsset.displayName + ' valued at ' + amountToTransfer.toString());

        if (InstrumentType.isCapital(modelAsset.instrument)) {

            this.taxes.applyCapitalGainsTax(modelAsset);

        }

        // Capture pre-transfer snapshots for display purposes
        modelAsset.closedValue = modelAsset.finishCurrency.copy();
        modelAsset.closedBasisValue = modelAsset.finishBasisCurrency.copy();

        this.applyAssetCloseFundTransfers(modelAsset);
        modelAsset.close(currentDateInt);

    }

    applyAssetCloseFundTransfers(modelAsset) {

        let modelAssetValue = modelAsset.finishCurrency.copy();

        // Filter to only transfers that have an on-close percentage
        const closeTransfers = (modelAsset.fundTransfers || []).filter(ft => ft.hasClose);

        if (closeTransfers.length > 0) {

            let runningTransferAmount = new Currency(0.0);
            for (let fundTransfer of closeTransfers) {
                fundTransfer.bind(modelAsset, this.modelAssets);
                if (!fundTransfer.toModel) continue;

                // can only send money to an expensable account
                if (!InstrumentType.isExpensable(fundTransfer.toModel.instrument)) {
                    logger.log(LogCategory.TRANSFER, 'Portfolio.applyAssetCloseFundTransfers: cannot transfer to ' + fundTransfer.toModel.displayName + ' because not an expensable account');
                    continue;
                }

                let transferAmount = fundTransfer.calculate({ useClosePercent: true });
                fundTransfer.execute({ useClosePercent: true });

                runningTransferAmount.add(transferAmount);
            }

            let extraAmount = new Currency(modelAssetValue.amount - runningTransferAmount.amount);
            if (extraAmount.amount > 0) {
                logger.log(LogCategory.TRANSFER, 'Portfolio.applyAssetCloseFundTransfers: ' + modelAsset.displayName + ' funding ' + extraAmount.toString() + ' to the funding backstop');

                const target = FundTransfer.resolveFunding(this.modelAssets);
                if (target) {
                    FundTransfer.system(modelAsset, target, extraAmount, this.modelAssets).execute();
                } else {
                    FundTransfer.reportUnfunded(modelAsset, extraAmount, 'sale proceeds (nowhere to deposit)', ShortfallOrigin.STANDALONE);
                }
            }

        }
        else {

            logger.log(LogCategory.TRANSFER, 'Portfolio.applyAssetCloseFundTransfers: ' + modelAsset.displayName + ' funding ' + modelAssetValue.toString() + ' to the funding backstop');

            const target = FundTransfer.resolveFunding(this.modelAssets);
            if (target) {
                FundTransfer.system(modelAsset, target, modelAssetValue, this.modelAssets).execute();
            } else {
                FundTransfer.reportUnfunded(modelAsset, modelAssetValue, 'sale proceeds (nowhere to deposit)', ShortfallOrigin.STANDALONE);
            }

        }

    }

    applyAssetOpenFundTransfer(modelAsset) {
        const config = modelAsset.fundingConfig;
        const source = findByName(this.modelAssets, config.sourceDisplayName);
        if (!source || source.isClosed) {
            logger.log(LogCategory.TRANSFER, 'Portfolio.applyAssetOpenFundTransfer: funding source "' + config.sourceDisplayName + '" not found or closed');
            return;
        }

        const percent = config.downPaymentPercent ?? 100;
        const amount = new Currency(modelAsset.startCurrency.amount * (percent / 100));
        const event = { type: EventType.TRANSFER, data: {
            from: source.displayName, to: modelAsset.displayName, cadence: 'funding' } };

        logger.log(LogCategory.TRANSFER, 'Portfolio.applyAssetOpenFundTransfer: ' + source.displayName + ' funding ' + amount.toString() + ' for ' + modelAsset.displayName);

        // Debit-only: real estate already has its value via finishCurrency = startCurrency.
        // A two-sided execute() would double-credit the real estate.
        source.debit(amount, event);
    }

    applyYear(currentDateInt) {
        // Its own causal root: the annual pass runs outside applyMonth.
        return withTrace(TraceKind.YEAR, `${currentDateInt.year} annual pass`, currentDateInt,
            () => this.#applyYearInScope(currentDateInt));
    }

    #applyYearInScope(currentDateInt) {

        for (let modelAsset of this.modelAssets) {
            if (modelAsset.inMonth(currentDateInt)) {
                if (InstrumentType.isMonthlyIncome(modelAsset.instrument))
                    withTrace(TraceKind.YEAR, `Annual growth: ${modelAsset.displayName}`,
                        currentDateInt, () => modelAsset.applyYearly());
            }
        }

        // Annual tax true-up. This pass runs on January 1, so it settles the
        // previous year; tax allocation needs that year's month count to size
        // its history window.
        const settledYear = currentDateInt.year - 1;
        withTrace(TraceKind.TAX_TRUE_UP, `${currentDateInt.year} tax true-up`, currentDateInt,
            () => this.taxes.applyAnnualTaxTrueUp(this.monthsInPlanYear(settledYear)));

        // NIIT is a separate pass after the true-up, not part of it:
        //  - the true-up reads what was withheld from this.yearly, so a NIIT
        //    charge booked first would shrink the April bill by its own amount;
        //  - the true-up has six early returns, which would skip NIIT on most
        //    paths.
        // Not wrapped in withTrace here: applyAnnualNIIT opens its scope only
        // when tax is due, so households that owe none get no empty scope.
        this.taxes.applyAnnualNIIT(this.monthsInPlanYear(settledYear));

    }

    modelMetricsToDisplayData(monthsSpan, modelAsset) {
        modelAsset.buildAllDisplayHistories(monthsSpan);
    }

    buildChartingDisplayData() {
        // Builds each asset's display histories for the charts.

        let monthsSpan = MonthsSpan.build(this.firstDateInt, this.lastDateInt);
        for (let modelAsset of this.modelAssets) {
            this.modelMetricsToDisplayData(monthsSpan, modelAsset);
        }

        this.assertions();

    }

    /**
     * The monthly dataset: one FinancialPackage per month, kept in
     * `generatedReports` beside the yearly ones, for when a year with an outlier
     * needs explaining.
     *
     * The logging is guarded separately: report() formats about thirty-five
     * strings per call as arguments, which costs the same whether or not the
     * logger then discards them.
     */
    reportMonthly(currentDateInt) {

        if (this.reports) {

            if (logger.isEnabled(LogCategory.MONTHLY)) {
                logger.log(LogCategory.MONTHLY, ' -------  Begin Monthly (' + currentDateInt.toString() + ' ) Report -------');
                this.monthly.report(LogCategory.MONTHLY);
                logger.log(LogCategory.MONTHLY, ' -------   End Monthly (' + currentDateInt.toString() + ' ) Report  -------');
            }

            this.generatedReports.push({ 
                type: 'monthly', 
                dateLabel: currentDateInt.toString(), 
                pkg: new FinancialPackage().add(this.monthly) 
            });

        }

    }

    /** The annual dataset — the default granularity of the markdown report. */
    reportYearly(currentDateInt) {

        if (this.reports) {

            if (logger.isEnabled(LogCategory.YEARLY)) {
                logger.log(LogCategory.YEARLY, ' -------  Begin Yearly (' + currentDateInt.toString() + ' ) Report -------');
                this.yearly.report(LogCategory.YEARLY);
                logger.log(LogCategory.YEARLY, ' -------   End Yearly  (' + currentDateInt.toString() + ' ) Report  -------');
            }

            // `dateLabel` is when the report fired and `coversYear` is the year
            // it describes; they always differ. yearlyChron runs on New Year's
            // Day, so the package pushed at 2027-01 holds 2026. A "Year" column
            // must use coversYear; report-view shows dated reports and uses
            // dateLabel.
            this.generatedReports.push({ 
                type: 'yearly', 
                dateLabel: currentDateInt.toString(), 
                coversYear: currentDateInt.year - 1,
                pkg: new FinancialPackage().add(this.yearly) 
            });

        }

    }

    reportHTML(currentDateInt) {
        let result = '';
        result += '<h3>Yearly Report for ' + currentDateInt.year + '</h3>\n';
        result += this.yearly.reportHTML(currentDateInt);
        return result;
    }

    sumDisplayData(displayArrayName) {
        let result = new Currency();
        if (this[displayArrayName] != null) {
            for (let ii = 0; ii < this[displayArrayName].length; ++ii)
                result.amount += this[displayArrayName][ii];
        }
        return result;
    }

    getHistoryCount() {
        if (!this.modelAssets) return 0;
        let total = 0;
        for (let modelAsset of this.modelAssets) {
            total += modelAsset.getHistoryCount();
        }
        return total;
    }

    assertions() {

    }

}

// ── Asset Queries ─────────────────────────────────────────────────────


export function firstDateInt(assets) {
  if (!assets?.length) return null;
  return assets.reduce((earliest, a) =>
    !earliest || a.startDateInt.isBefore(earliest) ? a.startDateInt : earliest,
    null
  );
}

export function lastDateInt(assets) {
  if (!assets?.length) return null;
  return assets.reduce((latest, a) =>
    !latest || a.effectiveFinishDateInt.isAfter(latest) ? a.effectiveFinishDateInt : latest,
    null
  );
}

export function findByName(assets, displayName) {
  return assets.find(a => a.displayName === displayName);
}

export function removeByName(assets, displayName) {
  const idx = assets.findIndex(a => a.displayName === displayName);
  return idx >= 0 ? assets.splice(idx, 1)[0] : undefined;
}

export function filterByInstrument(assets, instrument) {
  if (instrument === null) return [...assets];
  return assets.filter(a => a.instrument === instrument);
}

export function sortByInstrument(assets) {
  return [...assets].sort((a, b) => a.sortIndex() - b.sortIndex());
}