/**
 * annual-expenditure.js
 *
 * "I withdrew this much from my accounts to meet my obligations."
 *
 * ── Why not the EXPENSE metric, or the sum of debits ─────────────────
 *
 * `Metric.EXPENSE` is an accounting expense (living expense, mortgage interest,
 * maintenance, insurance). It leaves out mortgage principal and property tax,
 * which are real cash out, so on a mortgaged plan it understates what was paid.
 * Summing every debit is wrong the other way: money moves between the
 * household's own accounts (an RMD sweeps a 401(k) into a brokerage that then
 * pays an expense), so both legs would count.
 *
 * ── What it measures ─────────────────────────────────────────────────
 *
 * Every cash debit on a fundable account, classified by why it happened, from
 * the causal scopes trace.js records. A draw counts when its chain roots in an
 * obligation (an expense, a mortgage, a carrying cost, a tax), and not when the
 * household is moving its own money around. So:
 *
 *   Tax counts only when it was withdrawn. Payroll withholding never passes
 *   through an account, so a working year shows little tax drawn; in
 *   retirement nearly all tax is a withdrawal.
 *
 *   A failing plan reports what it could pay. The unpaid part is reported
 *   separately as unfunded; drawn + unfunded equals the obligation.
 *
 * ── The declaration table ────────────────────────────────────────────
 *
 * EXPENDITURE_TREATMENT declares every EventType, and classify() throws on an
 * unknown one, so a new EventType cannot quietly drop out of a total.
 */

import { EventType, EventKind } from './sim-event.js';
import { TraceKind, chainFor, bookedMonthIndex } from './trace.js';
import { InstrumentType } from './instruments/instrument.js';

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

    // A one-time debit is a one-off purchase. It has no obligation scope, so
    // 'byScope' would file it as internal; declared as spending directly.
    [EventType.ONE_TIME]:                'spending',

    // Tax that came out of an account.
    [EventType.FICA_WITHHOLDING]:        'tax',
    [EventType.INCOME_TAX_WITHHOLDING]:  'tax',
    [EventType.CAPITAL_GAINS_TAX]:       'tax',
    [EventType.TAX_TRUE_UP]:             'tax',
    [EventType.NIIT_ASSESSED]:           'tax',

    // Excluded: the cash already left under the GROSS_UP, which counts as
    // spending, so counting this too would double it.
    //
    // Known imprecision, kept by choice: the tax part of a grossed-up
    // withdrawal therefore lands in `spending`, not `tax`. The total is right;
    // only the split is off, and on a brokerage-funded retirement the tax line
    // can read far too low. Fixing it means splitting one debit across two
    // buckets. tests/annual-expenditure.mjs pins the current behaviour.
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

    // Engine reports. UNFUNDED — what the plan could not pay — is reported
    // separately rather than counted: it never left an account.
    [EventType.UNFUNDED]:                'excluded',
    [EventType.CONTRIBUTION_CAPPED]:     'excluded',
    [EventType.SOCIAL_SECURITY_DEFERRED]: 'excluded',
});

/** Scopes that mean "this draw was paying an obligation". */
const OBLIGATION_SCOPES = new Set([
    TraceKind.EXPENSE,
    TraceKind.MORTGAGE,
    TraceKind.CARRYING_COST,
]);

/** What a tax draw paid, named by the event type that drew it. */
const TAX_LABEL = Object.freeze({
    [EventType.FICA_WITHHOLDING]:       'FICA',
    [EventType.INCOME_TAX_WITHHOLDING]: 'Income tax',
    [EventType.CAPITAL_GAINS_TAX]:      'Capital gains tax',
    [EventType.TAX_TRUE_UP]:            'Annual tax true-up',
    [EventType.NIIT_ASSESSED]:          'Net investment income tax',
});

/**
 * Classify one event. Returns an Expenditure bucket, or null when the event is
 * not a draw at all.
 *
 * @param {SimEvent} event
 * @param {Array}    scopes  portfolio.traceScopes, passed explicitly: trace.js
 *                           module state is reset by the next run.
 * @param {Map}      [memo]  traceId -> obligation, for one pass over many events
 */
export function classify(event, scopes, memo = null) {
    return obligationOf(event, scopes, memo)?.bucket ?? null;
}

/**
 * classify(), plus the obligation the draw paid, for an itemised list: the
 * expense, mortgage or carrying cost its causal chain roots in ("Living
 * Expenses", "Home property tax"), or the kind of tax.
 *
 * @returns {{bucket: string, label: string|null} | null}  null when the event
 *          is not a draw; label is null for INTERNAL
 */
export function obligationOf(event, scopes, memo = null) {
    if (event.kind !== EventKind.CASH) return null;

    // Credits are not withdrawals, and are not netted against them: a tax
    // refund is money coming back, and netting it would let a refund hide an
    // earlier draw in the same window.
    if (event.amount.amount >= 0) return null;

    const treatment = EXPENDITURE_TREATMENT[event.type];
    if (!treatment) {
        throw new Error(
            `annual-expenditure: EventType "${event.type}" has no expenditure treatment. ` +
            `Add it to EXPENDITURE_TREATMENT — say whether a draw of this kind is ` +
            `spending, tax, decided by its causal scope, or excluded. ` +
            `Defaulting would leave money out of a total that claims to be complete.`);
    }

    if (treatment === 'tax')      return { bucket: Expenditure.TAX, label: TAX_LABEL[event.type] };
    if (treatment === 'spending') return { bucket: Expenditure.SPENDING, label: 'One-time purchases' };
    if (treatment === 'excluded') return null;

    // 'byScope'. The innermost obligation names it: a settlement inside
    // "Pay Living Expenses" paid Living Expenses.
    if (memo?.has(event.traceId)) return memo.get(event.traceId);
    const chain = chainFor(event.traceId, scopes);
    let obligation = null;
    for (const s of chain) if (OBLIGATION_SCOPES.has(s.kind)) obligation = s;
    const result = obligation
        ? { bucket: Expenditure.SPENDING, label: obligation.label.replace(/^Pay /, '') }
        : chain.some((s) => s.kind === TraceKind.TAX_TRUE_UP)
            ? { bucket: Expenditure.TAX, label: 'Annual tax settlement' }
            : { bucket: Expenditure.INTERNAL, label: null };
    memo?.set(event.traceId, result);
    return result;
}

/**
 * What the household withdrew over the inclusive month window
 * [fromIndex, toIndex], where index 0 is the plan's first month.
 *
 * Amounts are positive: this is a "how much went out" figure.
 *
 * @returns {{spending: number, tax: number, total: number,
 *            unfunded: number, months: number, complete: boolean,
 *            items: Array<{label: string, bucket: string, amount: number}>}}
 *          `complete` is false when the window ran off either end of the plan,
 *          so a caller can say "8 months" rather than implying a full year.
 *          `items` is the same total by obligation, largest first.
 */
export function expenditureOverWindow(portfolio, fromIndex, toIndex) {
    const empty = { spending: 0, tax: 0, total: 0, unfunded: 0, months: 0, complete: false, items: [] };
    if (!portfolio?.firstDateInt) return empty;

    const lastIndex = lastHistoryIndex(portfolio);
    if (lastIndex < 0) return empty;

    const from = Math.max(0, fromIndex);
    const to   = Math.min(toIndex, lastIndex);
    if (to < from) return empty;

    const first = portfolio.firstDateInt;
    const scopes = portfolio.traceScopes ?? [];
    const memo = new Map();

    let spending = 0, tax = 0, unfunded = 0;
    const items = new Map();

    for (const asset of portfolio.modelAssets) {
        const fundable = InstrumentType.isFundable(asset.instrument);
        for (const event of (asset.events ?? [])) {
            if (!event.dateInt) continue;
            // Counted in the month its chain began, as the figures book it: the
            // annual pass's events carry December's date and count in January.
            // An event counts at most a month after its own date; the cheap
            // test first.
            const own = (event.dateInt.year - first.year) * 12 + (event.dateInt.month - first.month);
            if (own < from - 1 || own > to) continue;
            const when = bookedMonthIndex(event, first, scopes);
            if (when < from || when > to) continue;

            // The obligations the plan could not meet. Reported, never counted:
            // a dollar that never left an account was never withdrawn.
            if (event.type === EventType.UNFUNDED) {
                unfunded += Math.abs(event.amount.amount);
                continue;
            }

            if (!fundable) continue;

            const o = obligationOf(event, scopes, memo);
            if (!o || o.bucket === Expenditure.INTERNAL) continue;
            const amount = -event.amount.amount;
            if (o.bucket === Expenditure.SPENDING) spending += amount;
            else tax += amount;

            const key = `${o.bucket}:${o.label}`;
            const item = items.get(key) ?? { label: o.label, bucket: o.bucket, amount: 0 };
            item.amount += amount;
            items.set(key, item);
        }
    }

    return {
        spending,
        tax,
        total: spending + tax,
        unfunded,
        months: to - from + 1,
        complete: (to - from + 1) === (toIndex - fromIndex + 1),
        items: [...items.values()].sort((a, b) => b.amount - a.amount),
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

// ── index helpers ────────────────────────────────────────────────────

function lastHistoryIndex(portfolio) {
    let last = -1;
    for (const asset of (portfolio.modelAssets ?? [])) {
        const h = asset.getHistory?.('value');
        if (h && h.length - 1 > last) last = h.length - 1;
    }
    return last;
}
