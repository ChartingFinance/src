/**
 * rule-notes.js
 *
 * Runtime confirmation that an engine rule fired.
 *
 * A rule that works silently is indistinguishable from a rule that never ran.
 * A Roth showing no tax looks identical to a bug; a pension showing no tax
 * looks identical to evasion; a home sale posting a six-figure gain against $0
 * of tax looks broken until you know about the exclusion. The engine is right
 * in all three cases — only the silence is wrong. These notes say which it is,
 * in the place the number is missing.
 *
 * ── Rules for rules ──────────────────────────────────────────────────
 *
 *  1. DERIVE, NEVER RECOMPUTE. A note may only describe an amount the engine
 *     actually booked. Reconstructing the engine's arithmetic to explain it is
 *     how a display change quietly becomes an unreviewed modelling change.
 *
 *  2. DON'T INVENT ALLOCATIONS. The household tax true-up is deliberately not
 *     split across the incomes that caused it — that number does not exist in
 *     the engine, and on screen people would treat it as real. Name the
 *     counterparty and stop.
 *
 *  3. RESOLVE FROM HISTORY, NOT PRESENT STATE. Asking resolveFunding() who the
 *     funding account is answers for TODAY, which is wrong for a month thirty
 *     years ago. Read what was recorded at the time instead.
 *
 *  4. SILENCE IS PART OF THE CONTRACT. A note that fires when it shouldn't is
 *     worse than no note at all — a false "unfunded" claim is alarming. Every
 *     rule is tested for when it stays quiet as well as when it speaks.
 *
 * Each rule is a descriptor:
 *   id         stable key, used by `suppresses` and by tests
 *   evaluate   (ctx) => ({ emoji, text }) | null
 *   suppresses ids whose notes must drop if this one fired — a specific
 *              explanation must beat a general one, or two notes offer
 *              competing reasons for the same zero
 */

import { Metric, aggregateMetric } from './metric.js';
import { InstrumentType } from './instruments/instrument.js';
import { global_home_sale_capital_gains_discount } from './globals.js';
import { DateInt } from './utils/date-int.js';
import { formatCurrency } from './utils/html.js';

/**
 * Build the evaluation context for one asset over one inclusive month window.
 *
 * @param {object} opts
 * @param {ModelAsset}   opts.asset
 * @param {ModelAsset[]} [opts.modelAssets]  siblings — needed to name counterparties
 * @param {DateInt}      [opts.firstDateInt] date of history index 0
 * @param {number}       opts.from           inclusive start index
 * @param {number}       opts.to             inclusive end index
 */
export function makeRuleContext({ asset, modelAssets = [], firstDateInt = null, from, to }) {
    const total = (metric, target = asset) =>
        aggregateMetric(target.getHistory?.(metric), metric, from, to);

    /**
     * Credit memos on this asset whose date falls inside the window.
     * addMonths() mutates, so each bound gets its own DateInt.
     */
    const memos = () => {
        const all = asset?.creditMemos ?? [];
        if (!firstDateInt) return all;
        const bound = (offset) => {
            const d = DateInt.from(firstDateInt.year, firstDateInt.month);
            d.addMonths(offset);
            return d.toInt();
        };
        const lo = bound(from);
        const hi = bound(to);
        return all.filter(m => {
            if (!m.dateInt) return false;
            const v = DateInt.from(m.dateInt.year, m.dateInt.month).toInt();
            return v >= lo && v <= hi;
        });
    };

    return { asset, modelAssets, firstDateInt, from, to, total, memos };
}

// ── Rules ────────────────────────────────────────────────────────────

/**
 * Assets that paid estimated income tax in this window. The monthly/annual
 * true-up debits the funding account and books ESTIMATED_INCOME_TAX there, so a
 * non-zero value IS the settlement — resolved per month rather than guessed
 * from today's account list (rule 3).
 */
function settlingAccounts(ctx) {
    const out = [];
    for (const a of ctx.modelAssets) {
        if (a === ctx.asset) continue;
        if (ctx.total(Metric.ESTIMATED_INCOME_TAX, a) !== 0) out.push(a);
    }
    return out;
}

export const RULES = [

    {
        // No tax is the feature, not an omission.
        id: 'roth-tax-free',
        suppresses: ['tax-settled-elsewhere'],
        evaluate(ctx) {
            if (!InstrumentType.isTaxFree(ctx.asset.instrument)) return null;
            if (ctx.total(Metric.INCOME) === 0) return null;
            return {
                emoji: '\u{1F6E1}\u{FE0F}',
                text: 'Qualified Roth withdrawals are tax-free — no income tax is due on this money, and none was charged.',
            };
        },
    },

    {
        // Only reachable after 24 months (taxes.js), and only visible once a
        // gain has actually been realised. It explains a MISSING tax only when
        // the gain fell entirely inside the exclusion — a larger gain is taxed,
        // and then the general note was never going to fire anyway.
        id: 'primary-home-exclusion',
        suppresses: ['tax-settled-elsewhere'],
        evaluate(ctx) {
            const { asset } = ctx;
            if (!InstrumentType.isRealEstate(asset.instrument) || !asset.isPrimaryHome) return null;
            if (ctx.total(Metric.LONG_TERM_CAPITAL_GAIN) === 0) return null;
            return {
                emoji: '\u{1F3E1}',
                text: `Primary home sold after more than two years — the first ${formatCurrency(global_home_sale_capital_gains_discount)} of gain is excluded before capital gains tax.`,
                // A taxed gain still gets the explanation, but must not silence
                // the counterparty note, which is then describing a real tax.
                suppressOnly: ctx.total(Metric.TAXES) === 0,
            };
        },
    },

    {
        // Income whose tax was settled somewhere else entirely.
        id: 'tax-settled-elsewhere',
        evaluate(ctx) {
            if (ctx.total(Metric.INCOME) === 0) return null;
            if (ctx.total(Metric.TAXES) !== 0) return null;
            const settlers = settlingAccounts(ctx);
            const where = settlers.length === 1 ? settlers[0].displayName
                        : settlers.length > 1 ? 'your funding accounts'
                        : null;
            return {
                emoji: '\u{1F9FE}',
                text: where
                    ? `Tax is not withheld from this income. The household's tax on it is settled from ${where}.`
                    : "Tax is not withheld from this income. The household's tax on it is settled at the annual true-up.",
            };
        },
    },

    {
        // The failure path already records itself: reportUnfunded writes an
        // 'info' memo on the asset that owes (fund-transfer.js). Surface it —
        // an obligation the plan could not pay is the single most important
        // thing this modal can tell anyone.
        id: 'unfunded-obligation',
        evaluate(ctx) {
            const unfunded = ctx.memos().filter(m => /^Unfunded\b/.test(m.note ?? ''));
            if (unfunded.length === 0) return null;
            const shortfall = unfunded.reduce((s, m) => s + Math.abs(m.amount?.amount ?? 0), 0);
            return {
                emoji: '\u{26A0}\u{FE0F}',
                tone: 'warn',
                text: `${formatCurrency(shortfall)} of this obligation went unpaid — no eligible funding account had a positive balance. The plan books the cost but no cash covers it.`,
            };
        },
    },

    {
        // Why money leaves an account the user never wired up. A policy
        // statement, not a claim about an amount — which is what makes it safe
        // to show on every month the account actually settled something.
        id: 'funding-backstop',
        evaluate(ctx) {
            const { asset } = ctx;
            if (!InstrumentType.isFundingBackstop(asset.instrument)) return null;
            if (ctx.total(Metric.ESTIMATED_INCOME_TAX) === 0) return null;
            return {
                emoji: '\u{1F3E6}',
                text: "This is the household's funding account: taxes, bills and mortgage payments draw from here automatically when no transfer covers them.",
            };
        },
    },

    {
        // RMD: required amount and what actually left are both recorded, so
        // both can be stated. Splitting "draws that counted" from "top-up" is
        // NOT available — the distribution metric already includes the top-up,
        // so decomposing would mean re-deriving the engine's arithmetic.
        id: 'rmd-satisfied',
        evaluate(ctx) {
            const required = Math.abs(ctx.total(Metric.RMD));
            if (required === 0) return null;
            const distributed = Math.abs(ctx.total(Metric.TRAD_IRA_DISTRIBUTION))
                              + Math.abs(ctx.total(Metric.FOUR_01K_DISTRIBUTION));
            if (distributed + 0.01 >= required) {
                return {
                    emoji: '\u{1F4E4}',
                    text: `Required minimum distribution of ${formatCurrency(required)} — ${formatCurrency(distributed)} was withdrawn, so the requirement is met.`,
                };
            }
            return {
                emoji: '\u{26A0}\u{FE0F}',
                tone: 'warn',
                text: `Required minimum distribution of ${formatCurrency(required)}, but only ${formatCurrency(distributed)} was withdrawn.`,
            };
        },
    },

];

/**
 * Evaluate every rule for one asset/window and return the notes that survive
 * suppression, in declaration order.
 */
export function ruleNotesFor(ctx) {
    if (!ctx?.asset) return [];

    const emitted = [];
    for (const rule of RULES) {
        let note = null;
        try {
            note = rule.evaluate(ctx);
        } catch {
            // A broken note must never take the modal down with it.
            note = null;
        }
        if (note) emitted.push({ id: rule.id, rule, note });
    }

    const silenced = new Set();
    for (const e of emitted) {
        // `suppressOnly: false` lets a rule fire its own note while declining to
        // silence others — see primary-home-exclusion on a gain that was taxed.
        if (e.note.suppressOnly === false) continue;
        for (const id of (e.rule.suppresses ?? [])) silenced.add(id);
    }

    return emitted
        .filter(e => !silenced.has(e.id))
        .map(e => ({ id: e.id, emoji: e.note.emoji, text: e.note.text, tone: e.note.tone ?? 'info' }));
}
