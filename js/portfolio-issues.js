/**
 * portfolio-issues.js
 *
 * What went wrong with the plan, in the user's language.
 *
 * The same idiom as rule-notes.js (a descriptor with a detect()), except that
 * an issue carries its own asset and dates, because the panel that shows it
 * covers the whole run.
 *
 * ── Rules for issues ─────────────────────────────────────────────────
 *
 *  1. Derive, never recompute. Every issue is anchored on an event the engine
 *     recorded, not on a balance that looks suspicious.
 *
 *  2. Silence is part of the contract. A false "you could not pay your
 *     mortgage" is worse than none; every detector is tested for staying quiet.
 *
 *  3. Depletion is not an alarm. A retiree's accounts are meant to draw down;
 *     the failure is an obligation that could not be paid. Nothing fires on a
 *     zero balance alone.
 *
 *  4. Engine doubt is not a financial finding. `reconciliation` issues ("these
 *     numbers may not add up") are a separate category, hidden unless asked for.
 *
 * ── Exhaustion ───────────────────────────────────────────────────────
 *
 * The month the plan runs out of money is the first `Unfunded —` memo: a
 * recorded failure, not an inference from balances. Scanning balances would
 * need heuristics for accounts not yet open, months with nothing due, and
 * sweeps that empty an account every month; the recorded failure needs none.
 *
 * ── Known seam ───────────────────────────────────────────────────────
 *
 * The detectors find engine events by matching credit-memo text, so renaming
 * a memo would silently remove an alert (tests/memo-vocabulary.mjs guards the
 * wording). The patterns are kept here in one place; rule-notes.js has its own
 * copies of `Unfunded` and `Contribution capped`. Moving both to event types is
 * open (markdowns/code-issues-from-comments.md).
 *
 * The `reconciliation` category is empty: the engine's reconciliation findings
 * go to the logger (LogCategory.SANITY), not to events.
 */

import { Metric, aggregateMetric } from './metric.js';
import { InstrumentType } from './instruments/instrument.js';
import { DateInt, monthLabel } from './utils/date-int.js';
import { formatCurrency } from './utils/html.js';

export { monthLabel };

/** Memo prose the engine writes, in one place. See "Known seam" above. */
export const MEMO_PATTERNS = Object.freeze({
    // fund-transfer.js reportUnfunded: `Unfunded — ${what for}`
    unfunded: /^Unfunded\b/,
    // fund-transfer.js settleOneSided: `Spillover from depleted ${name}`
    ranDry: /^Spillover from depleted (.+)$/,
    // payroll-engine.js recordContributionCap: `Contribution capped — ${limit}`
    contributionCapped: /^Contribution capped\b/,
});

/** The text after the em dash — the engine's own reason, not one we invent. */
function reasonOf(note) {
    return note?.split('—')[1]?.trim() ?? null;
}

function asDateInt(raw) {
    if (!raw || raw.year == null) return null;
    return DateInt.from(raw.year, raw.month);
}

/**
 * Collapse many memos into one issue's worth of facts.
 *
 * Occurrences counts distinct months, not memos: three failures in one month
 * is one bad month.
 */
function summarize(memos) {
    let first = null;
    let last = null;
    let amount = 0;
    const months = new Set();
    const reasons = new Set();

    for (const m of memos) {
        const d = asDateInt(m.dateInt);
        amount += Math.abs(m.amount?.amount ?? 0);
        if (d) {
            months.add(d.toInt());
            if (!first || d.isBefore(first)) first = d;
            if (!last || d.isAfter(last)) last = d;
        }
        const r = reasonOf(m.note);
        if (r) reasons.add(r);
    }

    return { first, last, amount, occurrences: months.size || memos.length, reasons: [...reasons] };
}

/** Memos on one asset matching a pattern. */
function memosMatching(asset, pattern) {
    return (asset?.creditMemos ?? []).filter(m => pattern.test(m.note ?? ''));
}

/**
 * Build the detection context for a whole run.
 *
 * @param {Portfolio} portfolio  a portfolio that has already been run
 */
export function makeIssueContext(portfolio) {
    const modelAssets = portfolio?.modelAssets ?? [];

    const total = (metric, asset) => {
        const history = asset?.getHistory?.(metric);
        const len = history?.length ?? 0;
        if (!len) return 0;
        return aggregateMetric(history, metric, 0, len - 1);
    };

    const byName = (name) => modelAssets.find(a => a.displayName === name) ?? null;

    /** Every memo matching a pattern, paired with the asset carrying it. */
    const allMatching = (pattern) => modelAssets
        .map(asset => ({ asset, memos: memosMatching(asset, pattern) }))
        .filter(e => e.memos.length > 0);

    return { portfolio, modelAssets, total, byName, allMatching };
}

// ── Detectors ────────────────────────────────────────────────────────
//
// Order is declaration order, and suppression works exactly as it does in
// rule-notes: a specific finding silences a general one.

export const DETECTORS = [

    {
        // Checked first, and it suppresses the exhaustion headline: with no
        // funding account at all, every obligation is unfunded from month one,
        // and the real message is "you never said where your money is". The
        // per-asset marks stay.
        id: 'no-funding-accounts',
        scope: 'plan',
        category: 'configuration',
        severity: 'alert',
        suppresses: ['plan-exhaustion'],
        detect(ctx) {
            const hasBackstop = ctx.modelAssets.some(a => InstrumentType.isFundingBackstop(a.instrument));
            if (hasBackstop) return null;
            // Only worth saying if something actually needed paying.
            const owing = ctx.allMatching(MEMO_PATTERNS.unfunded);
            if (owing.length === 0) return null;

            return {
                headline: 'No account is set up to pay the bills',
                detail: 'Nothing in this plan is a cash, savings, brokerage or bond account, so there is nowhere for expenses, taxes and mortgage payments to draw from. Add one and the plan can be funded.',
            };
        },
    },

    {
        // The headline number. First recorded failure to pay, not a balance scan.
        id: 'plan-exhaustion',
        scope: 'plan',
        category: 'obligation',
        severity: 'alert',
        detect(ctx) {
            const owing = ctx.allMatching(MEMO_PATTERNS.unfunded);
            if (owing.length === 0) return null;

            const s = summarize(owing.flatMap(e => e.memos));
            if (!s.first) return null;

            return {
                firstDateInt: s.first,
                lastDateInt: s.last,
                occurrences: s.occurrences,
                amount: s.amount,
                headline: `The plan runs out of money in ${monthLabel(s.first)}`,
                // "$X of payments could not be made", not "you were short $X":
                // one expense funded by three transfers can fail three times,
                // and netting them would mean recomputing (rule 1).
                detail: `From ${monthLabel(s.first)} onward, no eligible account — cash, savings, brokerage or bonds — held a positive balance when a payment came due. ${formatCurrency(s.amount)} of payments could not be made across ${s.occurrences} ${s.occurrences === 1 ? 'month' : 'months'}.`,
            };
        },
    },

    {
        // Per-asset half of the same event. This is what puts ⚠️ on a card.
        id: 'unfunded-obligation',
        scope: 'asset',
        category: 'obligation',
        severity: 'alert',
        detect(ctx) {
            return ctx.allMatching(MEMO_PATTERNS.unfunded).map(({ asset, memos }) => {
                const s = summarize(memos);
                const months = `${s.occurrences} ${s.occurrences === 1 ? 'month' : 'months'}`;

                // Some unfunded events carry no amount; the headline leads with
                // money only when there is some.
                const headline = s.amount > 0.01
                    ? `${formatCurrency(s.amount)} could not be funded`
                    : `Payments could not be funded`;

                return {
                    assetName: asset.displayName,
                    firstDateInt: s.first,
                    lastDateInt: s.last,
                    occurrences: s.occurrences,
                    amount: s.amount,
                    headline,
                    detail: `Starting ${monthLabel(s.first)}, ${months} of payments from this asset could not be made. No eligible account held a positive balance, so the plan's books and its cash no longer agree.`,
                    // reportUnfunded covers two cases (an obligation nothing
                    // could pay, take-home pay with nowhere to go), so its own
                    // reason is carried as detail.
                    reasons: s.reasons,
                };
            });
        },
    },

    {
        // The leading indicator: an account clamped at $0 and the shortfall was
        // re-sourced. The memo is on the account that covered it and names the
        // one that ran dry; the issue is filed under the one that ran dry.
        id: 'funding-ran-dry',
        scope: 'asset',
        category: 'obligation',
        severity: 'notice',
        detect(ctx) {
            const byDepleted = new Map();

            for (const { asset: coverer, memos } of ctx.allMatching(MEMO_PATTERNS.ranDry)) {
                for (const m of memos) {
                    const name = MEMO_PATTERNS.ranDry.exec(m.note)?.[1]?.trim();
                    if (!name) continue;
                    if (!byDepleted.has(name)) byDepleted.set(name, { memos: [], coverers: new Set() });
                    const entry = byDepleted.get(name);
                    entry.memos.push(m);
                    entry.coverers.add(coverer.displayName);
                }
            }

            const out = [];
            for (const [name, { memos, coverers }] of byDepleted) {
                const s = summarize(memos);
                const who = coverers.size === 1 ? [...coverers][0] : 'other accounts';
                out.push({
                    assetName: name,
                    firstDateInt: s.first,
                    lastDateInt: s.last,
                    occurrences: s.occurrences,
                    amount: s.amount,
                    headline: `Ran dry in ${monthLabel(s.first)}`,
                    detail: `This account reached $0 with payments still due, and ${formatCurrency(s.amount)} was drawn from ${who} to cover the difference. The obligations were met — but the plan is now leaning on its next line of funding.`,
                });
            }
            return out;
        },
    },

    {
        id: 'contribution-capped',
        scope: 'asset',
        category: 'configuration',
        severity: 'notice',
        detect(ctx) {
            return ctx.allMatching(MEMO_PATTERNS.contributionCapped).map(({ asset, memos }) => {
                const s = summarize(memos);
                const which = s.reasons.length === 1 ? s.reasons[0] : 'the annual contribution limits';
                return {
                    assetName: asset.displayName,
                    firstDateInt: s.first,
                    lastDateInt: s.last,
                    occurrences: s.occurrences,
                    amount: s.amount,
                    headline: `${formatCurrency(s.amount)} of contributions hit the limit`,
                    detail: `Contributions were capped by the ${which}. That much of what your transfers asked for could not be contributed, and stayed in the source account instead.`,
                };
            });
        },
    },

    {
        // The RMD was missed. The cause is not recorded (expense-engine.js gives
        // up silently when no account can receive it), so none is guessed.
        id: 'rmd-unsatisfied',
        scope: 'asset',
        category: 'configuration',
        severity: 'notice',
        detect(ctx) {
            const out = [];
            for (const asset of ctx.modelAssets) {
                const required = Math.abs(ctx.total(Metric.RMD, asset));
                if (required === 0) continue;
                const distributed = Math.abs(ctx.total(Metric.TRAD_IRA_DISTRIBUTION, asset))
                                  + Math.abs(ctx.total(Metric.FOUR_01K_DISTRIBUTION, asset));
                if (distributed + 0.01 >= required) continue;

                out.push({
                    assetName: asset.displayName,
                    amount: required - distributed,
                    headline: 'Required minimum distribution not met',
                    detail: `${formatCurrency(required)} had to be withdrawn from this account, but only ${formatCurrency(distributed)} was. A shortfall is normally taxed as a penalty, which this plan does not model.`,
                });
            }
            return out;
        },
    },

];

const SEVERITY_RANK = { alert: 0, notice: 1 };

/**
 * Run every detector over a completed portfolio.
 *
 * @param {Portfolio} portfolio
 * @param {object}  [opts]
 * @param {boolean} [opts.includeReconciliation]  engine-internal doubt; off by
 *        default — see rule 4. Ships empty until the recording study lands.
 * @returns {Issue[]} alerts first, then by date
 */
export function detectIssues(portfolio, { includeReconciliation = false } = {}) {
    if (!portfolio?.modelAssets?.length) return [];
    const ctx = makeIssueContext(portfolio);

    const found = [];
    for (const d of DETECTORS) {
        if (d.category === 'reconciliation' && !includeReconciliation) continue;
        let result = null;
        try {
            result = d.detect(ctx);
        } catch {
            // A broken detector must never take the run report down with it.
            result = null;
        }
        if (!result) continue;
        for (const issue of [].concat(result)) {
            found.push({
                id: d.id,
                scope: d.scope,
                category: d.category,
                severity: d.severity,
                assetName: null,
                firstDateInt: null,
                lastDateInt: null,
                occurrences: 1,
                amount: null,
                reasons: [],
                ...issue,
                detector: d,
            });
        }
    }

    const silenced = new Set();
    for (const issue of found) {
        for (const id of (issue.detector.suppresses ?? [])) silenced.add(id);
    }

    return found
        .filter(i => !silenced.has(i.id))
        .map(({ detector, ...i }) => i)
        .sort((a, b) => {
            const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
            if (s !== 0) return s;
            const ad = a.firstDateInt?.toInt() ?? Infinity;
            const bd = b.firstDateInt?.toInt() ?? Infinity;
            return ad - bd;
        });
}

// ── Consumer helpers ─────────────────────────────────────────────────

/** The plan-level headline, or null. Feeds the post-run callout. */
export function planExhaustion(issues) {
    return issues.find(i => i.id === 'plan-exhaustion') ?? null;
}

/** Issues belonging to one asset — the View modal's list. */
export function issuesForAsset(issues, displayName) {
    return issues.filter(i => i.scope === 'asset' && i.assetName === displayName);
}

/**
 * Assets that earn the ⚠️ on their card: an ALERT only.
 *
 * Not depletion (rule 3): drawing an account down is the plan working.
 */
export function alertAssetNames(issues) {
    return new Set(
        issues.filter(i => i.scope === 'asset' && i.severity === 'alert' && i.assetName)
              .map(i => i.assetName)
    );
}

/** Badge counts for the portfolio heading. */
export function issueCounts(issues) {
    return {
        total: issues.length,
        alerts: issues.filter(i => i.severity === 'alert').length,
        notices: issues.filter(i => i.severity === 'notice').length,
    };
}
