/**
 * trace.js
 *
 * Causal scopes: WHY an event happened, not just that it did.
 *
 * ── The problem ──────────────────────────────────────────────────────
 *
 * "Why did $1,847 leave my brokerage in November 2051?" cannot be answered by a
 * list of events. Every fact is recorded, but nothing says they are the same
 * story:
 *
 *     Living Expenses due $5,000
 *     transfer Living Expenses -> IRA (monthly)
 *     IRA clamped at $0, spillover $1,847
 *     resolveFunding chose Brokerage
 *     debit Brokerage $1,847, realized gain $412
 *
 * A user reading that gets a log and has to do the stitching. The answer is the
 * CHAIN, and a chain needs edges.
 *
 * ── The mechanism ────────────────────────────────────────────────────
 *
 * An engine operation wraps itself in `withTrace(kind, label, dateInt, fn)`.
 * Scopes nest — a settlement inside an expense payment inside a month — and
 * every event recorded while a scope is open carries that scope's id.
 *
 * `recordEvent` reads the id from AMBIENT context here rather than taking it as
 * a parameter. That was a deliberate decision when SimEvent landed: it means
 * adding causality is a change to the scope-openers, not a second migration
 * across all 29 event write sites.
 *
 * ── Why a module-level stack is safe ─────────────────────────────────
 *
 * `chronometer_run` is async, but its per-month work is entirely synchronous —
 * verified, no `await` inside the month loop. So no two scopes can interleave
 * within a run, and a plain array behaves as a call stack. Monte Carlo and the
 * GA optimizer run in separate Worker contexts with their own module instance.
 *
 * If an `await` is ever introduced inside the month loop this assumption breaks
 * and scopes will attribute events to the wrong parent. `assertNoOpenScopes()`
 * exists so a leak is caught at the end of a run rather than silently
 * misattributing months of history.
 */

/** What kind of operation a scope represents. */
export const TraceKind = Object.freeze({
    MONTH:        'month',        // the month itself — root of most chains
    YEAR:         'year',         // the annual pass: income growth and the tax true-up
    PAYROLL:      'payroll',      // one income asset's paycheck
    EXPENSE:      'expense',      // paying one obligation
    MORTGAGE:     'mortgage',     // one mortgage payment
    CARRYING_COST:'carryingCost', // property tax / maintenance / insurance
    RMD:          'rmd',          // a required minimum distribution
    TRANSFER:     'transfer',     // one two-sided fund transfer
    SETTLEMENT:   'settlement',   // one one-sided draw on a funding account
    TAX_TRUE_UP:  'taxTrueUp',    // the annual reconciliation of withholding
    ASSET_CLOSE:  'assetClose',   // an asset reaching its finish date
});

let _stack = [];
let _scopes = [];
let _nextId = 0;

/**
 * Run `fn` inside a new causal scope. Every event recorded during it — at any
 * depth — is attributed to this scope.
 *
 * @param {string}  kind     TraceKind
 * @param {string}  label    human-readable, e.g. 'Pay Living Expenses'
 * @param {DateInt} dateInt
 * @param {Function} fn
 */
export function withTrace(kind, label, dateInt, fn) {
    const parent = _stack.length ? _stack[_stack.length - 1] : null;
    const scope = {
        id: ++_nextId,
        kind,
        label,
        dateInt: dateInt ?? parent?.dateInt ?? null,
        parentId: parent ? parent.id : null,
        depth: parent ? parent.depth + 1 : 0,
    };
    _scopes.push(scope);
    _stack.push(scope);
    try {
        return fn();
    } finally {
        // finally, not after: an engine that throws mid-settlement must not
        // leave a scope open and silently reparent the rest of the run.
        _stack.pop();
    }
}

/** The innermost open scope's id, or null. Read by ModelAsset.recordEvent. */
export function currentTraceId() {
    return _stack.length ? _stack[_stack.length - 1].id : null;
}

/** Every scope opened during this run, in creation order. */
export function traceScopes() {
    return _scopes;
}

/** Called by chronometer_run. Traces are run state, rebuilt every time. */
export function resetTraces() {
    _stack = [];
    _scopes = [];
    _nextId = 0;
}

/**
 * True when no scope is left open. Called at the end of a run: a leak means an
 * operation returned without unwinding, and every later event would be
 * attributed to the wrong parent.
 */
export function assertNoOpenScopes() {
    return _stack.length === 0;
}

// ── Reading the chain back ───────────────────────────────────────────
//
// READS TAKE THE SCOPE LIST EXPLICITLY. The ambient stack above exists so
// recording needs no plumbing, but resolution must NOT use module state: a
// second run calls resetTraces(), and any chain resolved afterwards would look
// up ids that no longer exist. `calculate()` re-runs on every edit, so that is
// the normal case, not an edge one. Pass `portfolio.traceScopes`.
//
// Found the hard way — a test that resolved a chain after a later run silently
// stopped finding it.

/** Scope by id within a given scope list, or null. */
export function scopeById(id, scopes) {
    if (id == null || !scopes) return null;
    return scopes.find(s => s.id === id) ?? null;
}

/**
 * The causal chain for a scope id: root first, the scope itself last.
 *
 * This is the answer to "why did this happen?" — each step is one operation the
 * engine chose to perform, and the list reads as a sentence.
 *
 * @param {number} traceId
 * @param {Array}  scopes   portfolio.traceScopes from the run that produced it
 */
export function chainFor(traceId, scopes) {
    const out = [];
    let cursor = scopeById(traceId, scopes);
    let guard = 0;
    while (cursor && guard++ < 64) {
        out.unshift(cursor);
        cursor = scopeById(cursor.parentId, scopes);
    }
    return out;
}

/**
 * Explain one recorded event: the chain that produced it, plus everything else
 * that happened in the same scope.
 *
 * "Everything else" matters as much as the chain. A brokerage debit on its own
 * looks arbitrary; seen beside the clamped IRA transfer and the realized gain in
 * the same scope, it is obviously the third step of one story.
 *
 * @param {SimEvent}     event
 * @param {ModelAsset[]} modelAssets  to gather siblings across accounts
 * @param {Array}        scopes       portfolio.traceScopes
 */
export function explainEvent(event, modelAssets = [], scopes = null) {
    const chain = chainFor(event?.traceId, scopes);
    const siblings = [];
    if (event?.traceId != null) {
        for (const asset of modelAssets) {
            for (const e of (asset.events ?? [])) {
                if (e.traceId === event.traceId) siblings.push({ asset: asset.displayName, event: e });
            }
        }
    }
    return { chain, siblings };
}

/** One-line rendering: "November 2051 > Pay Living Expenses > ...". */
export function chainLabel(traceId, scopes, separator = ' > ') {
    return chainFor(traceId, scopes).map(s => s.label).join(separator);
}
