/**
 * sim-event.js
 *
 * What the engine did, as structured data instead of prose.
 *
 * ── The rule ─────────────────────────────────────────────────────────
 *
 * A note is generated from an event for display, and never parsed back.
 * `renderNote()` is the one place prose is produced; code decides things from
 * the event's type and data, so rewording a note cannot change a result.
 * (portfolio-issues.js and rule-notes.js still match some note text — see
 * markdowns/code-issues-from-comments.md.)
 *
 * ── Sensors and collectors ───────────────────────────────────────────
 *
 * A SimEvent is a sensor reading: raw, high-volume, no judgement. It says an
 * account was debited, not that anything is wrong. Deciding what is actionable
 * belongs to a collector (`portfolio-issues.js`), which has the context to tell
 * a retiree drawing down as planned from a plan that has failed.
 *
 * ── Answering "why did the engine do that?" ──────────────────────────
 *
 * By a chain, not a single event: a brokerage withdrawal is the end of a story
 * that starts with an expense coming due. Two fields connect the story:
 *
 *   `metric`  — the Metric this event moved, if any, so "why is my
 *               capital-gains number $412?" becomes "show every event that
 *               wrote to that metric".
 *
 *   `traceId` — the enclosing causal scope (trace.js), read from ambient
 *               context inside recordEvent(), never passed by callers. Read
 *               chains back with `chainFor` / `explainEvent`, passing
 *               `portfolio.traceScopes`.
 *
 * Not yet recorded: why a decision was made at the moment it was made (which
 * account `resolveFunding` chose, and why). That has to be captured at the
 * decision site; it cannot be recovered afterwards.
 */

import { Currency } from './utils/currency.js';

/**
 * Every kind of thing the engine can record.
 *
 * Finer-grained than reconciliation buckets: ASSET_GROWTH, EXPENSE_INFLATION
 * and INCOME_GROWTH reconcile the same way but are different events.
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
    CAPITAL_GAIN_EXCLUDED:   'capitalGainExcluded',   // IRC §121 primary-home exclusion
    NIIT_ASSESSED:           'niitAssessed',      // IRC §1411; data: { nii, magi, threshold }

    // ── Movement ──
    TRANSFER:                'transfer',          // data: { from, to, cadence }
    SETTLEMENT:              'settlement',        // one-sided draw; data: { from, to, label }
    SPILLOVER:               'spillover',         // data: { depleted }
    GROSS_UP:                'grossUp',           // data: { forAsset, overflow: boolean }

    // The part of a GROSS_UP withdrawn to cover capital-gains tax rather than
    // the obligation. No cash moves for this event (it left under the
    // GROSS_UP); it names that portion so it can be reported. data: { forAsset }
    TAX_PROVISION:           'taxProvision',
    ONE_TIME:                'oneTime',           // data: { note }

    // ── Engine reports (no money moved) ──
    UNFUNDED:                'unfunded',          // data: { cause, origin }
    CONTRIBUTION_CAPPED:     'contributionCapped',// data: { limitName }
});

/**
 * Where a shortfall came from. SPILLOVER and UNFUNDED ("the part of a movement
 * one account could not supply") are emitted from both the two-sided
 * `execute()` path and the one-sided `settleOneSided` path, and only the
 * two-sided total nets to zero, so conservation needs to know which. (The
 * quick-start profiles never spill from a settlement; a home whose carrying
 * costs drain its funding account does.)
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
 * Which events moved money. A property of the event type, so two sites
 * emitting the same event cannot disagree.
 */
const INFO_TYPES = new Set([
    EventType.MORTGAGE_INTEREST,
    EventType.PROPERTY_TAX,
    EventType.PROPERTY_TAX_ESCROW,
    EventType.MAINTENANCE,
    EventType.INSURANCE,
    EventType.CAPITAL_GAIN_RECOGNIZED,
    EventType.CAPITAL_GAIN_EXCLUDED,
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
     * @param {number}   [opts.traceId]  enclosing causal scope; read from
     *                                   ambient context, never passed by callers
     */
    constructor(type, amount, dateInt, { metric = null, data = null, seq = 0, traceId = null } = {}) {
        this.type    = type;
        // A copy: several engines mutate an amount after recording it
        // (tax-engine flips the escrow's sign right after booking it).
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
 * The only place a credit-memo note is produced.
 *
 * The wording is locked by `tests/memo-vocabulary.mjs`, because some consumers
 * still match on it. Change wording in its own PR, once nothing parses it.
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
        case EventType.TAX_PROVISION:           return d.forAsset
            ? `Withheld for capital gains tax on the draw for ${d.forAsset}`
            : 'Withheld for capital gains tax on this draw';
        // Says which side of the min bound: too much investment income, or
        // too much total income. No currency helper — this module imports
        // nothing.
        case EventType.NIIT_ASSESSED:           return d.bound === 'nii'
            ? 'Net investment income tax (3.8% of net investment income)'
            : 'Net investment income tax (3.8% of MAGI over the threshold)';
        case EventType.CAPITAL_GAIN_RECOGNIZED: return d.spillover ? 'Capital gains (spillover)' : 'Capital gains';
        case EventType.CAPITAL_GAIN_EXCLUDED:   return 'Primary home gain excluded';

        // Property tax settles as "Home property tax" but maintenance as
        // "Home → Checking (maintenance)": two wordings for one operation,
        // kept because consumers still match them.
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
