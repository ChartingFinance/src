/**
 * sim-event.js
 *
 * What the engine did, as structured data instead of prose.
 *
 * ── Why ──────────────────────────────────────────────────────────────
 *
 * Credit-memo notes were the engine's only record of its own reasoning, and
 * three systems read them by matching English: `monthlySanityCheck` decided
 * whether the books balanced with a `switch` over string literals,
 * `portfolio-issues.js` recovered user-facing alerts by regex, and
 * `rule-notes.js` did the same for the View modal. Renaming 'Asset growth' to
 * 'Asset Growth' — one capital letter — corrupted reconciliation and passed
 * every test in the suite.
 *
 * The rule that fixes it, and the only one that matters here:
 *
 *     A NOTE IS GENERATED FROM AN EVENT FOR DISPLAY, AND NEVER PARSED BACK.
 *
 * One direction. `renderNote()` below is the single place prose is produced.
 * Nothing downstream may read it to decide anything.
 *
 * ── Sensors and collectors ───────────────────────────────────────────
 *
 * A SimEvent is a sensor reading: raw, dumb, high-volume, no judgement. It
 * says an account was debited, not that anything is wrong. Deciding what is
 * *actionable* belongs to a collector — `portfolio-issues.js` — which reads
 * the bus with the surrounding context needed to tell a fault from normal
 * operation. An account hitting $0 is a reading; whether that is a retiree
 * drawing down as planned or a plan that has failed is a judgement, and the
 * two live in different files on purpose.
 *
 * ── Answering "why did the engine do that?" ──────────────────────────
 *
 * That question is answered by a CHAIN, not by a leaf. A $1,847 brokerage
 * withdrawal is the end of a story that starts with an expense coming due and
 * runs through a depleted IRA and a backstop policy choosing this account over
 * three others. Each of those is recorded; nothing yet says they are the same
 * story.
 *
 * Two fields anticipate that, and both are deliberately shaped so adding
 * causality later does NOT mean migrating every write site a second time:
 *
 *   `metric`  — which Metric this event moved, where there is one. Turns "why
 *               is my capital-gains number $412?" into "show every event that
 *               wrote to that metric". Nearly free to capture, because the
 *               engine already writes the metric and the memo side by side.
 *
 *   `traceId` — read from AMBIENT context inside recordEvent(), never passed
 *               by callers. Populated by nobody today. When causal grouping
 *               arrives it is a change to recordEvent() and a handful of
 *               scope-openers, not another 29-site migration. This is the one
 *               decision here that would be expensive to get wrong.
 *
 * Freeze frames — the decision context captured at the moment of a choice, the
 * way OBD-II stores sensor values with a fault code — are NOT here yet.
 * `resolveFunding` knows why it picked an account only while it is picking;
 * one line later that is unrecoverable. Recording it at the site is what makes
 * "why this account?" answerable without recomputing engine logic at render
 * time. That work belongs with the decision sites themselves.
 */

import { Currency } from './utils/currency.js';

/**
 * Every kind of thing the engine can record.
 *
 * Finer-grained than reconciliation buckets on purpose: ASSET_GROWTH,
 * EXPENSE_INFLATION and INCOME_GROWTH all reconcile the same way but are
 * different events, and collapsing them here would throw away the distinction
 * permanently to save a mapping.
 */
export const EventType = Object.freeze({
    // ── Growth and yield ──
    ASSET_GROWTH:            'assetGrowth',
    EXPENSE_INFLATION:       'expenseInflation',
    INCOME_GROWTH:           'incomeGrowth',
    DIVIDEND:                'dividend',          // data.qualified: boolean
    INTEREST_INCOME:         'interestIncome',

    // ── Housing ──
    MORTGAGE_PRINCIPAL:      'mortgagePrincipal',
    MORTGAGE_INTEREST:       'mortgageInterest',
    PROPERTY_TAX:            'propertyTax',
    PROPERTY_TAX_ESCROW:     'propertyTaxEscrow',
    MAINTENANCE:             'maintenance',
    INSURANCE:               'insurance',

    // ── Tax ──
    FICA_WITHHOLDING:        'ficaWithholding',
    INCOME_TAX_WITHHOLDING:  'incomeTaxWithholding',
    CAPITAL_GAINS_TAX:       'capitalGainsTax',
    TAX_TRUE_UP:             'taxTrueUp',         // data.direction: 'underpayment' | 'refund'
    CAPITAL_GAIN_RECOGNIZED: 'capitalGainRecognized', // data.spillover: boolean

    // ── Movement ──
    TRANSFER:                'transfer',          // data: { from, to, cadence }
    SETTLEMENT:              'settlement',        // one-sided draw; data: { from, to, label }
    SPILLOVER:               'spillover',         // data: { depleted }
    GROSS_UP:                'grossUp',           // data: { forAsset, overflow: boolean }
    ONE_TIME:                'oneTime',           // data: { note }

    // ── Engine reports (no money moved) ──
    UNFUNDED:                'unfunded',          // data: { cause, origin }
    CONTRIBUTION_CAPPED:     'contributionCapped',// data: { limitName }
});

/**
 * Where a shortfall came from. SPILLOVER and UNFUNDED are both "the part of a
 * movement that one account could not supply", and they are emitted from BOTH
 * the two-sided `execute()` path and the one-sided `settleOneSided` path.
 * Conservation has to know which, because only the two-sided total is expected
 * to net to zero.
 *
 * Learned the hard way: a probe over the four quick-start profiles showed
 * TRANSFER + SPILLOVER + UNFUNDED === 0 and that looked like a law. It is not —
 * those four profiles simply never spill from a settlement. Scenarios where a
 * home's carrying costs drain their funding account break the naive sum by up
 * to $2,265 a month.
 */
export const ShortfallOrigin = Object.freeze({
    /** Remainder of a two-sided transfer. Participates in conservation. */
    PAIRED: 'paired',
    /** Remainder of a one-sided settlement. Has no second leg to balance. */
    ONE_SIDED: 'oneSided',
    /** An obligation that never moved money at all — a pre-flight failure. */
    STANDALONE: 'standalone',
});

/** Cash moved on this asset, versus recognition/attribution only. */
export const EventKind = Object.freeze({
    CASH: 'cash',
    INFO: 'info',
});

/**
 * Which events moved money. Mirrors the `kind` argument every call site used
 * to pass by hand — now a property of the event type, so it cannot disagree
 * with itself between two sites emitting the same thing.
 */
const INFO_TYPES = new Set([
    EventType.MORTGAGE_INTEREST,
    EventType.PROPERTY_TAX,
    EventType.PROPERTY_TAX_ESCROW,
    EventType.MAINTENANCE,
    EventType.INSURANCE,
    EventType.CAPITAL_GAIN_RECOGNIZED,
    EventType.UNFUNDED,
    EventType.CONTRIBUTION_CAPPED,
]);

export function kindOf(type) {
    return INFO_TYPES.has(type) ? EventKind.INFO : EventKind.CASH;
}

export class SimEvent {
    /**
     * @param {string}   type      EventType key
     * @param {Currency} amount
     * @param {DateInt}  dateInt
     * @param {object}   [opts]
     * @param {string}   [opts.metric]   Metric this event moved, if any
     * @param {object}   [opts.data]     type-specific payload
     * @param {number}   [opts.seq]      monotonic within a run
     * @param {string}   [opts.traceId]  causal grouping; ambient, unused today
     */
    constructor(type, amount, dateInt, { metric = null, data = null, seq = 0, traceId = null } = {}) {
        this.type    = type;
        // COPY, do not hold the caller's Currency. Several engines mutate an
        // amount after recording it — tax-engine calls escrow.flipSign() one
        // line after booking the escrow — and a stored reference would let
        // that rewrite history after the fact. CreditMemo has always copied;
        // an event that did not would silently disagree with its own memo.
        this.amount  = amount instanceof Currency ? amount.copy() : new Currency(amount ?? 0);
        this.dateInt = dateInt;
        this.kind    = kindOf(type);
        this.metric  = metric;
        this.data    = data;
        this.seq     = seq;
        this.traceId = traceId;
    }
}

/**
 * The ONLY place a credit-memo note is produced.
 *
 * Every string below is byte-identical to what the engine wrote before this
 * module existed, because consumers still match on them and
 * `tests/memo-vocabulary.mjs` locks the whole vocabulary. Wording changes are
 * a separate, deliberate PR once nothing parses these any more — normalising
 * them here would hide a real regression inside a cosmetic diff.
 *
 * @param {SimEvent} event
 * @returns {string}
 */
export function renderNote(event) {
    const d = event.data ?? {};

    switch (event.type) {
        case EventType.ASSET_GROWTH:            return 'Asset growth';
        case EventType.EXPENSE_INFLATION:       return 'Expense inflation';
        case EventType.INCOME_GROWTH:           return 'Annual income growth';
        case EventType.DIVIDEND:                return d.qualified ? 'Qualified dividend' : 'Non-qualified dividend';
        case EventType.INTEREST_INCOME:         return 'Interest income';

        case EventType.MORTGAGE_PRINCIPAL:      return 'Mortgage Principal';
        case EventType.MORTGAGE_INTEREST:       return 'Mortgage Interest';
        case EventType.PROPERTY_TAX:            return 'Property tax';
        case EventType.PROPERTY_TAX_ESCROW:     return 'Property tax escrow';
        case EventType.MAINTENANCE:             return 'Maintenance';
        case EventType.INSURANCE:               return 'Insurance';

        case EventType.FICA_WITHHOLDING:        return 'FICA withholding';
        case EventType.INCOME_TAX_WITHHOLDING:  return 'Income tax withholding';
        case EventType.CAPITAL_GAINS_TAX:       return 'Capital gains tax withholding';
        case EventType.TAX_TRUE_UP:             return `Annual tax true-up (${d.direction})`;
        case EventType.CAPITAL_GAIN_RECOGNIZED: return d.spillover ? 'Capital gains (spillover)' : 'Capital gains';

        // Transfers and settlements share a shape but not a format: property
        // tax settles as "Home property tax" while maintenance settles as
        // "Home → Checking (maintenance)". Same operation, two wordings —
        // preserved verbatim here, worth unifying once nothing parses them.
        case EventType.TRANSFER:                return `${d.from} → ${d.to} (${d.cadence})`;
        case EventType.SETTLEMENT:              return d.label === 'property tax'
                                                    ? `${d.from} property tax`
                                                    : `${d.from} → ${d.to} (${d.label})`;
        case EventType.SPILLOVER:               return `Spillover from depleted ${d.depleted}`;
        case EventType.GROSS_UP:                return `Grossed-up expense ${d.overflow ? 'overflow' : 'debit'} for ${d.forAsset}`;
        case EventType.ONE_TIME:                return `One-Time: ${d.note || 'one-time event'}`;

        case EventType.UNFUNDED:                return `Unfunded — ${d.cause}`;
        case EventType.CONTRIBUTION_CAPPED:     return `Contribution capped — ${d.limitName}`;

        default:
            // An unrenderable event is a programming error, not a data
            // condition. Failing here beats writing "undefined" into a ledger.
            throw new Error(`renderNote: unknown event type "${event.type}"`);
    }
}
