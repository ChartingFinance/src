/**
 * annual-expenditure.js
 *
 * "I withdrew this much from my accounts to meet my obligations."
 *
 * ── Why this is not the EXPENSE metric ───────────────────────────────
 *
 * `Metric.EXPENSE` is an ACCOUNTING expense: LIVING_EXPENSE + MORTGAGE_INTEREST
 * + MAINTENANCE + INSURANCE. It deliberately excludes mortgage principal (which
 * nets out through credit memos) and property tax (which rolls into SALT_TAXES).
 * Both of those are real cash leaving a real account, so on a mortgaged plan the
 * metric understates what the household actually paid out by 8-17%:
 *
 *     dualIncome 2026   EXPENSE $78,149   cash actually drawn $91,422
 *
 * Nor is it the sum of every debit. Money moves between a household's own
 * accounts constantly — an RMD sweeps 401K -> Brokerage before the brokerage
 * funds an expense — and both legs are debits on fundable accounts. Summing
 * them all reports roughly double:
 *
 *     preRetirement 2055   obligations $162,796   all debits $347,434
 *
 * ── What this measures instead ───────────────────────────────────────
 *
 * Every CASH debit on a FUNDABLE account, classified by WHY it happened, using
 * the causal scope trace.js already records. A draw counts when its chain roots
 * in an obligation — paying an expense, a mortgage, a carrying cost, a tax —
 * and does not when it is the household moving its own money around.
 *
 * Two properties fall out of measuring the funding side rather than the accrual
 * side, and both are the point:
 *
 *   TAXES ARE COUNTED ONLY WHEN THEY WERE ACTUALLY WITHDRAWN. Payroll
 *   withholding is deducted at source and never passes through an account, so a
 *   working year shows $0 of tax drawn even while $39,553 was paid. In
 *   retirement there is no paycheck to withhold from, so nearly all tax becomes
 *   a withdrawal. The number tracks that shift on its own; no deduction or
 *   bracket arithmetic enters into it. It counts dollars that left an account.
 *
 *   A FAILING PLAN REPORTS WHAT IT COULD PAY, NOT WHAT IT OWED. earlyCareer
 *   2060 accrues $127,396 of living expense against depleted accounts; the draw
 *   is $64,721 and the remaining $62,675 is recorded as UNFUNDED. The two sum
 *   back to the accrual exactly. An accrual-side figure would go on reporting
 *   $127k of spending that never happened.
 *
 * ── The declaration table ────────────────────────────────────────────
 *
 * EXPENDITURE_TREATMENT declares every EventType, and classify() THROWS on one
 * it has never heard of. That shape is borrowed from EVENT_RECONCILIATION in
 * portfolio.js for the same reason it was adopted there: the old default:
 * branch swallowed unmapped types into a bucket, which is how a rename
 * corrupted the books in silence. Adding an EventType should break this file
 * loudly rather than quietly leave money out of a total.
 */

import { EventType, EventKind } from './sim-event.js';
import { TraceKind, chainFor } from './trace.js';
import { InstrumentType } from './instruments/instrument.js';
import { DateInt } from './utils/date-int.js';

/** Which bucket a draw lands in. */
export const Expenditure = Object.freeze({
    /** Paying for something the plan said the household needs. */
    SPENDING: 'spending',
    /** Tax that actually left an account. */
    TAX:      'tax',
    /** The household moving its own money. Not expenditure. */
    INTERNAL: 'internal',
});

/**
 * How each EventType is treated when it appears as a cash debit on a fundable
 * account. Every type in the enum is listed; see the header for why.
 *
 *   'byScope'  — ask the causal chain. A transfer can be either an expense
 *                draw or an RMD sweep, and only the scope knows which.
 *   'tax'      — tax paid straight out of an account. These carry no obligation
 *                scope of their own (withholding at source opens a bare
 *                SETTLEMENT scope), and an INCOME_TAX_WITHHOLDING debit on an
 *                account is definitionally money withdrawn to pay tax.
 *   'excluded' — never a draw against an obligation: growth, accruals,
 *                recognition, and engine reports that move no cash.
 */
export const EXPENDITURE_TREATMENT = Object.freeze({
    // Movement — the scope decides.
    [EventType.TRANSFER]:                'byScope',
    [EventType.SETTLEMENT]:              'byScope',
    [EventType.SPILLOVER]:               'byScope',
    [EventType.GROSS_UP]:                'byScope',

    // A one-time debit on an account is a one-off purchase. It is applied in
    // the month scope with no obligation parent, so 'byScope' would file it as
    // internal — which would be wrong, and wrong in the direction that hides
    // spending. Declared directly.
    [EventType.ONE_TIME]:                'spending',

    // Tax that came out of an account.
    [EventType.FICA_WITHHOLDING]:        'tax',
    [EventType.INCOME_TAX_WITHHOLDING]:  'tax',
    [EventType.CAPITAL_GAINS_TAX]:       'tax',
    [EventType.TAX_TRUE_UP]:             'tax',
    [EventType.NIIT_ASSESSED]:           'tax',

    // Info-only, and it MUST be: the cash it describes already left under the
    // GROSS_UP that carried it, and that gross-up is counted as spending.
    // Counting this too would book the same dollars twice.
    //
    // KNOWN IMPRECISION: because of that, the tax portion of a grossed-up
    // withdrawal lands in `spending` rather than `tax`. The TOTAL is right
    // either way — it is the same withdrawal — only the split is slightly off.
    // Moving it would need a fixture that produces a material provision, and
    // none of the current corpus does (the largest across all eight profiles
    // rounds to $0), so the split is left unbuilt rather than built blind.
    [EventType.TAX_PROVISION]:           'excluded',

    // Growth and yield: credits, never draws.
    [EventType.ASSET_GROWTH]:            'excluded',
    [EventType.EXPENSE_INFLATION]:       'excluded',
    [EventType.INCOME_GROWTH]:           'excluded',
    [EventType.DIVIDEND]:                'excluded',
    [EventType.INTEREST_INCOME]:         'excluded',

    // Housing accruals. The DRAW that settles them is a SETTLEMENT under a
    // MORTGAGE or CARRYING_COST scope and is counted there; these name the
    // obligation, and counting them as well would double the housing line.
    [EventType.MORTGAGE_PRINCIPAL]:      'excluded',
    [EventType.MORTGAGE_INTEREST]:       'excluded',
    [EventType.PROPERTY_TAX]:            'excluded',
    [EventType.PROPERTY_TAX_ESCROW]:     'excluded',
    [EventType.MAINTENANCE]:             'excluded',
    [EventType.INSURANCE]:               'excluded',

    // Recognition, not cash.
    [EventType.CAPITAL_GAIN_RECOGNIZED]: 'excluded',
    [EventType.CAPITAL_GAIN_EXCLUDED]:   'excluded',

    // Engine reports. UNFUNDED is the obligation the plan could NOT pay — it is
    // reported separately by this module rather than counted, because a dollar
    // that never left an account was never withdrawn.
    [EventType.UNFUNDED]:                'excluded',
    [EventType.CONTRIBUTION_CAPPED]:     'excluded',
});

/** Scopes that mean "this draw was paying an obligation". */
const OBLIGATION_SCOPES = new Set([
    TraceKind.EXPENSE,
    TraceKind.MORTGAGE,
    TraceKind.CARRYING_COST,
]);

/**
 * Classify one event. Returns an Expenditure bucket, or null when the event is
 * not a draw at all.
 *
 * @param {SimEvent} event
 * @param {Array}    scopes  portfolio.traceScopes — passed EXPLICITLY. Resolving
 *                           from trace.js module state finds nothing after the
 *                           next calculate(), which is a silent wrong answer.
 * @param {Map}      [memo]  traceId -> bucket, for one pass over many events
 */
export function classify(event, scopes, memo = null) {
    if (event.kind !== EventKind.CASH) return null;

    // Credits are not withdrawals. This is GROSS, deliberately: the annual tax
    // true-up settles in both directions, and in a refund year it credits the
    // funding account. That refund is money coming back, not money drawn, so a
    // year that withheld nothing and got $1,610 back reports $0 of tax drawn —
    // which is the literal answer to "what did I have to take out". Netting it
    // would answer a different question, and would let a large refund mask a
    // large draw earlier in the same window.
    if (event.amount.amount >= 0) return null;

    const treatment = EXPENDITURE_TREATMENT[event.type];
    if (!treatment) {
        throw new Error(
            `annual-expenditure: EventType "${event.type}" has no expenditure treatment. ` +
            `Add it to EXPENDITURE_TREATMENT — say whether a draw of this kind is ` +
            `spending, tax, decided by its causal scope, or excluded. ` +
            `Defaulting would leave money out of a total that claims to be complete.`);
    }

    if (treatment === 'tax')      return Expenditure.TAX;
    if (treatment === 'spending') return Expenditure.SPENDING;
    if (treatment === 'excluded') return null;

    // 'byScope'
    if (memo?.has(event.traceId)) return memo.get(event.traceId);
    const chain = chainFor(event.traceId, scopes);
    const bucket = chain.some((s) => OBLIGATION_SCOPES.has(s.kind))
        ? Expenditure.SPENDING
        : chain.some((s) => s.kind === TraceKind.TAX_TRUE_UP)
            ? Expenditure.TAX
            : Expenditure.INTERNAL;
    memo?.set(event.traceId, bucket);
    return bucket;
}

/**
 * What the household withdrew over the inclusive month window
 * [fromIndex, toIndex], where index 0 is the plan's first month.
 *
 * Amounts come back POSITIVE — this is a "how much went out" figure, and a
 * caller rendering "$91,422 withdrawn" should not have to flip a sign first.
 *
 * @returns {{spending: number, tax: number, total: number,
 *            unfunded: number, months: number, complete: boolean}}
 *          `complete` is false when the window ran off either end of the plan,
 *          so a caller can say "8 months" rather than implying a full year.
 */
export function expenditureOverWindow(portfolio, fromIndex, toIndex) {
    const empty = { spending: 0, tax: 0, total: 0, unfunded: 0, months: 0, complete: false };
    if (!portfolio?.firstDateInt) return empty;

    const lastIndex = lastHistoryIndex(portfolio);
    if (lastIndex < 0) return empty;

    const from = Math.max(0, fromIndex);
    const to   = Math.min(toIndex, lastIndex);
    if (to < from) return empty;

    const start = dateIntAt(portfolio, from).toInt();
    const end   = dateIntAt(portfolio, to).toInt();

    const scopes = portfolio.traceScopes ?? [];
    const memo = new Map();

    let spending = 0, tax = 0, unfunded = 0;

    for (const asset of portfolio.modelAssets) {
        const fundable = InstrumentType.isFundable(asset.instrument);
        for (const event of (asset.events ?? [])) {
            const when = event.dateInt?.toInt();
            if (when == null || when < start || when > end) continue;

            // The obligations the plan could not meet. Reported, never counted:
            // a dollar that never left an account was never withdrawn.
            if (event.type === EventType.UNFUNDED) {
                unfunded += Math.abs(event.amount.amount);
                continue;
            }

            if (!fundable) continue;

            const bucket = classify(event, scopes, memo);
            if (bucket === Expenditure.SPENDING) spending += -event.amount.amount;
            else if (bucket === Expenditure.TAX)  tax      += -event.amount.amount;
        }
    }

    return {
        spending,
        tax,
        total: spending + tax,
        unfunded,
        months: to - from + 1,
        complete: (to - from + 1) === (toIndex - fromIndex + 1),
    };
}

/**
 * The trailing twelve months ending at (and including) `endIndex`.
 *
 * Trailing rather than calendar-year so the figure is always a full twelve
 * months wherever the cursor sits, instead of collapsing to a part-year every
 * January. Near the start of a plan it is necessarily short, and `months` /
 * `complete` say so.
 */
export function trailingYearExpenditure(portfolio, endIndex) {
    return expenditureOverWindow(portfolio, endIndex - 11, endIndex);
}

// ── index <-> date helpers ───────────────────────────────────────────

function dateIntAt(portfolio, index) {
    const d = new DateInt(portfolio.firstDateInt.toInt());
    d.addMonths(index);
    return d;
}

function lastHistoryIndex(portfolio) {
    let last = -1;
    for (const asset of (portfolio.modelAssets ?? [])) {
        const h = asset.getHistory?.('value');
        if (h && h.length - 1 > last) last = h.length - 1;
    }
    return last;
}
