import { Currency } from './utils/currency.js';
import { InstrumentType } from './instruments/instrument.js';
import { MonthsSpan } from './utils/months-span.js';
import { logger, LogCategory } from './utils/logger.js';
import { ModelLifeEvent } from './life-event.js';
import { User } from './user.js';
import { global_user_startAge } from './globals.js';
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
 * How each kind of engine event participates in monthly reconciliation.
 *
 * This was a `switch (memo.note)` over English prose, which meant the engine
 * decided whether its own books balanced by string-matching — and the switch's
 * `default:` swallowed anything unrecognised instead of rejecting it. Renaming
 * 'Asset growth' to 'Asset Growth' silently emptied the growth bucket,
 * corrupted the transfer total, and passed all 162 assertions (2026-07-29).
 *
 * Keying on EventType removes the failure mode rather than guarding it: the
 * types are enum constants, so a rename is a reference error at load time
 * instead of a wrong number at runtime.
 *
 * Two buckets are not accumulators:
 *
 *   `excluded`     — CASH events that must stay out of the transfer total.
 *                    Growth and dividends move a balance without being a
 *                    transfer. These were four separate accumulators that
 *                    nothing ever read: an exclusion list wearing the costume
 *                    of an accumulator.
 *
 *   `passThrough`  — transfers, settlements and engine reports, which count
 *                    toward the transfer total ONLY when they moved cash. The
 *                    `kind` check is deliberately kept rather than hardcoding
 *                    which of these are info, so the behaviour cannot drift if
 *                    an event's kind ever changes.
 *
 * MEMO_RECONCILIATION (the old note→bucket map) is retained below purely so
 * `tests/memo-vocabulary.mjs` can keep asserting that the rendered vocabulary
 * has not drifted. Nothing in the engine reads it.
 */
export const EVENT_RECONCILIATION = Object.freeze({
    [EventType.FICA_WITHHOLDING]:        'fica',
    [EventType.INCOME_TAX_WITHHOLDING]:  'incomeTax',
    [EventType.CAPITAL_GAIN_RECOGNIZED]: 'capitalGains',
    [EventType.CAPITAL_GAINS_TAX]:       'capitalGainsTax',
    [EventType.MORTGAGE_INTEREST]:       'mortgageInterest',
    [EventType.MORTGAGE_PRINCIPAL]:      'mortgagePrincipal',
    [EventType.PROPERTY_TAX]:            'propertyTax',

    [EventType.ASSET_GROWTH]:            'excluded',
    [EventType.EXPENSE_INFLATION]:       'excluded',
    [EventType.INCOME_GROWTH]:           'excluded',
    [EventType.DIVIDEND]:                'excluded',
    [EventType.INTEREST_INCOME]:         'excluded',

    // Genuinely two-sided: execute() debits one account and credits another by
    // the same amount, so these MUST net to zero and a residue is a real
    // defect. Determined empirically (2026-07-29), not assumed — a probe summed
    // every cash event type over a full run and TRANSFER was the only one that
    // came to zero.
    [EventType.TRANSFER]:                'paired',

    // Single-legged BY DESIGN. settleOneSided debits the funding account and
    // books nothing on the obligation it pays; a windfall credits one account
    // with no counterparty; the annual true-up debits one account. Expecting
    // these to net to zero is what made the transfer check fail every month on
    // any plan with an expense — the deltas were exactly the monthly expense.
    [EventType.SETTLEMENT]:              'oneSided',
    [EventType.SPILLOVER]:               'oneSided',
    [EventType.GROSS_UP]:                'oneSided',
    [EventType.ONE_TIME]:                'oneSided',
    [EventType.TAX_TRUE_UP]:             'oneSided',

    // Info-kind: no money moved, so they reach neither total. Routed here
    // rather than to `excluded` so the kind guard stays the thing that
    // excludes them, and behaviour cannot drift if a kind ever changes.
    [EventType.PROPERTY_TAX_ESCROW]:     'oneSided',
    [EventType.MAINTENANCE]:             'oneSided',
    [EventType.INSURANCE]:               'oneSided',
    [EventType.UNFUNDED]:                'oneSided',
    [EventType.CONTRIBUTION_CAPPED]:     'oneSided',
});

/**
 * Legacy note→bucket map. NOT read by the engine any more — kept only so
 * tests/memo-vocabulary.mjs can go on locking the rendered vocabulary against
 * drift while notes are still matched by portfolio-issues and rule-notes.
 * Delete this when those consumers move to event types.
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
 * Which reconciliation total an event belongs to, or null for "none".
 *
 * Most of this is a table lookup, but SPILLOVER and UNFUNDED cannot be
 * classified statically: both are "the part of a movement one account could not
 * supply", and both are emitted from the two-sided `execute()` path AND the
 * one-sided `settleOneSided` path. Only the two-sided total is expected to net
 * to zero, so the shortfall has to follow its PROVENANCE.
 *
 * Getting this wrong is not academic. A probe over the four quick-start
 * profiles showed TRANSFER + SPILLOVER + UNFUNDED === 0 and it looked like a
 * law; it is not. Those profiles simply never spill from a settlement. A home
 * whose carrying costs drain its funding account breaks that naive sum by up to
 * $2,265 a month (measured 2026-07-29).
 */
function conservationBucket(event, bucket) {
    // A shortfall completes whatever movement produced it.
    if (event.type === EventType.SPILLOVER || event.type === EventType.UNFUNDED) {
        // ...except a spill that PAID INCOME TAX, which belongs to the income-tax
        // total no matter which account ended up supplying it.
        //
        // TaxEngine.#withholdInScope books monthly.incomeTax for the spilled leg
        // — the tax was genuinely collected, just not from the account that owed
        // it — while the only cash event is this SPILLOVER. Filing it under
        // oneSided left the incomeTax bucket short by exactly the spill and the
        // package claiming tax no event backed: "2056-04 Income tax: events=0.00,
        // package=-431.81" on the reference portfolio, once an IRA was drained
        // hard enough for its withholding to spill.
        //
        // The alternatives were worse. A second INCOME_TAX_WITHHOLDING event on
        // the fallback would be a second CASH event for one movement and break
        // the `start + Σ cash events == finish` invariant, since `kind` is a
        // property of the type and cannot be info for one instance. Replacing the
        // SPILLOVER outright would discard the depleted/origin provenance. Both
        // change the engine to satisfy a check; this changes only the check, and
        // the event keeps saying which account ran dry.
        //
        // Safe because `cause: 'withholding'` is set in exactly one place, and
        // that same block is the only writer of monthly.incomeTax for a spill —
        // one event, one booking. oneSided is explicitly not asserted to balance,
        // so moving a term out of it cannot break a conservation law.
        if (event.type === EventType.SPILLOVER && event.data?.cause === 'withholding') {
            return 'incomeTax';
        }
        return event.data?.origin === ShortfallOrigin.PAIRED ? 'paired' : 'oneSided';
        // UNFUNDED is info-kind — no cash moved — but it IS a conservation
        // term: it is the acknowledged gap between what a movement asked for
        // and what it delivered. Excluding it is what left the transfer check
        // short by exactly the unpaid amount.
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
    constructor(modelAssets, reports) {
        this.modelAssets = this.sortModelAssets(modelAssets);
        this.reports = !!reports;
        this.generatedReports = [];
        this.firstDateInt = firstDateInt(this.modelAssets);
        this.lastDateInt = lastDateInt(this.modelAssets);

        const birthYear = this.firstDateInt ? this.firstDateInt.year - global_user_startAge : undefined;
        this.activeUser = new User(global_user_startAge, birthYear);

        // Construction-time age snapshot, restored by initializeChron. The
        // chronometer ages activeUser one year per simulated year, and the GA
        // optimizer re-runs the chronometer on this same Portfolio thousands
        // of times — without the reset, each fitness evaluation starts where
        // the previous one ended (run 3 of a 30-year sim starts at age 100),
        // flipping RMD and catch-up regimes mid-optimization.
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
        // INIT, not GENERAL: this runs in every Portfolio constructor, and Monte
        // Carlo builds one per iteration. As a GENERAL line carrying no
        // information it would put thousands of entries in the worker console
        // the moment the logger came back to life.
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
        let portfolio = new Portfolio(modelAssets);

        portfolio.monthly = this.monthly.copy();
        portfolio.yearly  = this.yearly.copy();
        portfolio.total   = this.total.copy();
        portfolio.lifeEvents = this.lifeEvents.map(e => e.copy());

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

    initializeChron() {

        // Rewind the user to their starting age. Every other piece of run
        // state is rebuilt below; the user must rewind too or successive
        // chronometer runs on the same Portfolio simulate different worlds
        // (fitness evaluations stop being comparable — same chromosome,
        // different RMD/contribution-limit regime). Mutate in place rather
        // than replacing the object: engines and callers hold references.
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

        this.taxes = new TaxEngine(this.modelAssets, this.monthly, this.yearly, this.activeUser);
        this.payroll = new PayrollEngine(this.modelAssets, this.monthly, this.yearly, this.activeUser, this.taxes);
        this.expenses = new ExpenseEngine(this.modelAssets, this.monthly, this.activeUser);
        this.rebalance = new RebalanceEngine(this.modelAssets, this.monthly, this.yearly, this.activeUser);
    }

    /**
     * Check and apply any life events whose triggerDateInt matches
    * the current simulation month. Called at day=1 of each month
    * by the chronometer, BEFORE applyMonth.
    */
    applyLifeEvents(currentDateInt) {
        for (const event of this.lifeEvents) {
            if (event.applied) continue;
            const trigger = event.triggerDateInt;
            if (trigger.year === currentDateInt.year && trigger.month === currentDateInt.month) {
                // Its own causal root. Life events fire from chronometer_run
                // BEFORE applyMonth, so without a scope here the asset closes
                // and close-transfers a phase triggers would be the only events
                // in the run with no attribution at all.
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

    monthlySanityCheck(currentDateInt) {
        const buckets = {};
        for (const b of Object.values(EVENT_RECONCILIATION)) buckets[b] = 0;

        for (const modelAsset of this.modelAssets) {
            const startIdx = modelAsset.eventsCheckedIndex || 0;
            for (let i = startIdx; i < modelAsset.events.length; i++) {
                const event = modelAsset.events[i];
                const bucket = EVENT_RECONCILIATION[event.type];

                // An unmapped type is a programming error — someone added an
                // event and did not say how it reconciles. The old default:
                // branch swallowed exactly this case into transferNet, which
                // is how a rename corrupted the books in silence.
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

        // Label the month whose events are being reconciled, not the date this
        // pass runs on. chronometer_run advances currentDateInt BEFORE calling
        // monthlyChron, so the raw value is one month ahead of the events in the
        // buckets — a finding reported as "2056-04" is about March's events.
        // Cost a full forensic pass on the wrong month before it was noticed.
        const settled = DateInt.from(currentDateInt.year, currentDateInt.month);
        settled.addMonths(-1);

        const tolerance = 0.01;
        const check = (label, eventTotal, packageTotal) => {
            if (Math.abs(eventTotal - packageTotal) > tolerance) {
                logger.log(LogCategory.SANITY, `${settled} ${label}: events=${eventTotal.toFixed(2)}, package=${packageTotal.toFixed(2)}`);
            }
        };

        check('FICA', buckets.fica, this.monthly.fica().amount);
        check('Income tax', buckets.incomeTax, this.monthly.incomeTax.amount);
        check('Mortgage interest', buckets.mortgageInterest, this.monthly.mortgageInterest.amount);
        // NEGATED, deliberately. The event tracks the mortgage BALANCE moving
        // toward zero — positive, because a mortgage is held as a negative
        // balance — while FinancialPackage.mortgagePrincipal tracks household
        // CASH GOING OUT, which is negative. Both are right about different
        // things, and comparing them raw reported a false mismatch every month
        // a mortgage was active (+271.20 against -271.20). Negating here fixes
        // the comparison without changing either number.
        check('Mortgage principal', buckets.mortgagePrincipal, -this.monthly.mortgagePrincipal.amount);
        check('Property taxes', buckets.propertyTax, this.monthly.propertyTaxes.amount);
        check('Capital gains', buckets.capitalGains, this.monthly.longTermCapitalGains.amount);
        check('Capital gains tax', buckets.capitalGainsTax, this.monthly.longTermCapitalGainsTax.amount);

        // Two-sided conservation, in full:
        //
        //     TRANSFER + SPILLOVER(paired) + UNFUNDED(paired) === 0
        //
        // execute() debits one account and credits another by the same amount,
        // so the two legs must cancel. They legitimately differ when the debited
        // account cannot supply what was asked and clamps at $0 — and the
        // difference is then carried by exactly one of two terms: the shortfall
        // was re-sourced from another account (SPILLOVER) or it could not be
        // sourced at all (UNFUNDED). Both are folded in above by provenance, so
        // a residue here means money genuinely appeared or vanished.
        //
        // One-sided settlements are excluded and are not expected to balance:
        // settleOneSided books the debit on the funding account and nothing on
        // the obligation it pays. Asserting they net to zero made this check
        // fail every month on any plan with an expense, by exactly the expense
        // amount.
        if (Math.abs(buckets.paired) > tolerance) {
            logger.log(LogCategory.SANITY, `${currentDateInt} Transfer conservation broken: ${buckets.paired.toFixed(2)}`);
        }
    }

    monthlyChron(currentDateInt) {

        this.reportMonthly(currentDateInt);

        this.monthlySanityCheck(currentDateInt);

        //this.monthlyPropertyTaxes.push(this.monthly.propertyTaxes.toCurrency());
        //this.monthlyIncomeTaxes.push(this.monthly.incomeTax.toCurrency());
        //this.monthlyCapitalGainsTaxes.push(this.monthly.longTermCapitalGainsTax.toCurrency());

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
        // Root of every causal chain: the month. applyMonth is called once per
        // day-tick (1, 15, 30), so a month opens three roots with the same
        // label — an implementation detail that does not surface, since a chain
        // renders as "November 2051 > Pay Living Expenses > ...".
        return withTrace(TraceKind.MONTH, monthLabel(currentDateInt), currentDateInt,
            () => this.#applyMonthInScope(currentDateInt));
    }

    #applyMonthInScope(currentDateInt) {

        /*
        leaving this in to test a specific test data case when selling a house
        if (currentDateInt.year == 2029 && currentDateInt.month == 7) {
            debugger;
        }
        */
        
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

        // recognize asset gains
        // Doing this after applying expenses is pessimistic
        // Maybe an optimistic option to do this prior to expenses?
        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                this.expenses.applyAssetGrowth(modelAsset, currentDateInt);
            }
        }

        // ensure RMDs are handled — after growth, because carrying-cost
        // transfers inside applyAssetGrowth are distributions too and must
        // be credited against the month's RMD before any top-up fires
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

        // Withhold at the source BEFORE the true-up: the true-up collects
        // liability minus what was already withheld, so a sweep running after
        // it would collect the same tax twice.
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
        // The annual pass runs OUTSIDE applyMonth, so without its own root the
        // events it emits — annual income growth and the tax true-up — are the
        // only ones in a run the engine cannot explain. Found by asserting that
        // every event is attributable: 73 orphans on the Early Career profile.
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

        // Annual tax true-up: reconcile exact liability vs. withheld amounts.
        // This pass runs on January 1, so the year being settled is the previous
        // one; its month count is what spec 4a's allocation needs to size the
        // history window it reads the income basis from.
        const settledYear = currentDateInt.year - 1;
        withTrace(TraceKind.TAX_TRUE_UP, `${currentDateInt.year} tax true-up`, currentDateInt,
            () => this.taxes.applyAnnualTaxTrueUp(this.monthsInPlanYear(settledYear)));

    }

    modelMetricsToDisplayData(monthsSpan, modelAsset) {
        modelAsset.buildAllDisplayHistories(monthsSpan);
    }

    buildChartingDisplayData() {
        // asset and cash flow data will be handled by charting
        // portfolio will coelsece cashflow data

        let monthsSpan = MonthsSpan.build(this.firstDateInt, this.lastDateInt);
        for (let modelAsset of this.modelAssets) {
            this.modelMetricsToDisplayData(monthsSpan, modelAsset);
        }

        this.assertions();

    }

    reportMonthly(currentDateInt) {

        if (this.reports) {

            logger.log(LogCategory.MONTHLY, ' -------  Begin Monthly (' + currentDateInt.toString() + ' ) Report -------');
            this.monthly.report(LogCategory.MONTHLY);
            logger.log(LogCategory.MONTHLY, ' -------   End Monthly (' + currentDateInt.toString() + ' ) Report  -------');

            // NEW: Push directly to internal array
            this.generatedReports.push({ 
                type: 'monthly', 
                dateLabel: currentDateInt.toString(), 
                pkg: new FinancialPackage().add(this.monthly) 
            });

        }

    }

    reportYearly(currentDateInt) {

        if (this.reports) {

            logger.log(LogCategory.YEARLY, ' -------  Begin Yearly (' + currentDateInt.toString() + ' ) Report -------');
            this.yearly.report(LogCategory.YEARLY);
            logger.log(LogCategory.YEARLY, ' -------   End Yearly  (' + currentDateInt.toString() + ' ) Report  -------');

            // NEW: Push directly to internal array
            this.generatedReports.push({ 
                type: 'yearly', 
                dateLabel: currentDateInt.toString(), 
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
// (merged from asset-queries.js)


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