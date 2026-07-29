/**
 * portfolio-issues.js
 *
 * What went wrong with the plan, in the user's language.
 *
 * Companion to rule-notes.js, and the same idiom — a descriptor with a
 * detect() — with one structural difference. A rule note answers *for one
 * asset over one window*, because the modal that shows it already knows both.
 * An issue has to carry its own asset and its own dates, because the surface
 * that shows it is portfolio-wide and spans the whole run.
 *
 * ── Rules for issues ─────────────────────────────────────────────────
 *
 *  1. DERIVE, NEVER RECOMPUTE. Same contract as rule-notes. Every issue here
 *     is anchored on an event the engine actually recorded — not on a balance
 *     that looks suspicious. See §Exhaustion below for why that matters.
 *
 *  2. SILENCE IS THE CONTRACT. A false "you could not pay your mortgage" is
 *     far worse than no surface at all. Every detector is tested for when it
 *     stays quiet.
 *
 *  3. DEPLETION IS NOT AN ALARM. A retiree's accounts are *supposed* to draw
 *     down; that is the scenario being modelled, not a fault. The failure is
 *     an obligation that could not be paid. Nothing here fires on a zero
 *     balance alone.
 *
 *  4. ENGINE DOUBT IS NOT A FINANCIAL FINDING. `reconciliation` issues say
 *     "these numbers may not add up", which is a real signal but reads as
 *     self-doubt printed beside a projection. They are a separate category,
 *     hidden unless the caller asks for them.
 *
 * ── Exhaustion ───────────────────────────────────────────────────────
 *
 * The date the plan runs out of money is arguably the headline number of the
 * whole projection, and it is tempting to compute it by scanning balances for
 * the first month where no funding account holds anything. Don't. That needs
 * heuristics for accounts that have not started yet, for months where nothing
 * was due, and for a sweep-to-savings that legitimately empties an account
 * every single month.
 *
 * All of it is unnecessary. `FundTransfer.resolveFunding` returns null exactly
 * when no open backstop account has a positive balance, and every caller of
 * that null path calls `reportUnfunded`. So exhaustion is simply the first
 * `Unfunded —` memo: a recorded failure rather than an inference. Accounts
 * that are closed or not yet started are already excluded by resolveFunding, a
 * month with nothing due cannot false-fire because there was no failure, and a
 * sweep cannot trigger it because `monthlyMoveValue` is a percentage of source
 * value — it moves only what is there and can never overdraw.
 *
 * ── Known seam ───────────────────────────────────────────────────────
 *
 * Every engine event below is recovered by matching prose in a credit memo.
 * Renaming a memo string silently kills a user-facing alert. That fragility is
 * the subject of a parked study into the overlap between CreditMemo and this
 * feedback surface — `info` memos already mean "no money moved", so CreditMemo
 * is doing two jobs. The patterns live here, in one place, so that study has a
 * single seam to cut. (rule-notes.js still carries its own copies of the
 * `Unfunded` and `Contribution capped` patterns; unifying them is part of it.)
 *
 * Three of the seven LogCategory.SANITY sites cannot be detected at all yet —
 * they compute their answer and discard it, and `logger.log()` is currently a
 * no-op — so the `reconciliation` category ships empty by design. Those land
 * when the study does.
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
 * Occurrences counts DISTINCT MONTHS, not memos: three failures in one month
 * is one bad month, and "in 14 months" is a sentence a person can act on.
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
        // Checked first, and it suppresses the exhaustion headline. With no
        // backstop account configured anywhere, resolveFunding returns null on
        // month one and every obligation in the plan reports unfunded — which
        // renders as "your plan failed immediately" when the truth is "you
        // never said where your money is". The per-asset marks stay: they are
        // accurate, and they point straight at the gap.
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
                // "$X of payments could not be made" and NOT "you were short
                // $X". One month can fail several payments — a single expense
                // funded by three transfers fails three times — so the total is
                // a count of failed payments, not a net shortfall. Netting them
                // would mean reconstructing what the plan "really" needed,
                // which is exactly the recomputation rule 1 forbids.
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

                // Some unfunded events carry no amount — an expense overflow
                // records the failure without a figure. "$0 could not be
                // funded" is worse than saying nothing about the amount, so
                // the headline only leads with money when there is money.
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
                    // reportUnfunded covers two different events — an obligation
                    // nothing could pay, and take-home pay with nowhere to land
                    // — so the engine's own reason is carried verbatim rather
                    // than one story being asserted for both. It is raw engine
                    // prose, so the panel renders it as subordinate detail.
                    reasons: s.reasons,
                };
            });
        },
    },

    {
        // The leading indicator: an account clamped at $0 and the shortfall was
        // re-sourced (the PR #14 machinery). The memo lands on the account that
        // COVERED the shortfall and names the one that ran dry, so attribution
        // is deliberately flipped — the issue belongs to the depleted account.
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
        // The requirement was missed. WHY is not available: the site that gives
        // up when no account can receive the distribution (expense-engine.js)
        // returns without recording anything, so this states the shortfall and
        // stops rather than guessing a cause.
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
 * Not depletion — see rule 3. Drawing an account down is the plan working, and
 * marking it would cry wolf on the exact scenario this tool exists to model.
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
