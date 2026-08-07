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
 *  2. DON'T INVENT ALLOCATIONS. A split may only be shown if the engine booked
 *     it. When global_allocate_household_tax is on, the true-up IS split across
 *     the accounts that generated the income and each payer's share is a real
 *     booked amount on its own ledger — say that, and read it from the event
 *     rather than recomputing the proportion. When it is off, the whole bill
 *     lands on one account: name the counterparty and stop.
 *
 *     What stays unsayable either way is what any single asset "owes". Brackets
 *     are not additive, so a per-asset liability is not a number the engine
 *     has — the allocation is a share OF A HOUSEHOLD BILL, not a computation of
 *     that account's own tax. A note must not imply otherwise.
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
import { activeTaxTable } from './globals.js';
import { DateInt, monthLabel } from './utils/date-int.js';
import { formatCurrency } from './utils/html.js';
import { EventType } from './sim-event.js';

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

    /**
     * SimEvents on this asset inside the window.
     *
     * Same windowing as memos(), but reading the structured record rather than
     * the rendered note. Rules that need to tell two settlements apart — a
     * backstop draw from an allocated share, say — cannot do it from prose,
     * because both render identically.
     */
    const events = () => {
        const all = asset?.events ?? [];
        if (!firstDateInt) return all;
        const bound = (offset) => {
            const d = DateInt.from(firstDateInt.year, firstDateInt.month);
            d.addMonths(offset);
            return d.toInt();
        };
        const lo = bound(from);
        const hi = bound(to);
        return all.filter(e => {
            if (!e.dateInt) return false;
            const v = DateInt.from(e.dateInt.year, e.dateInt.month).toInt();
            return v >= lo && v <= hi;
        });
    };

    return { asset, modelAssets, firstDateInt, from, to, total, memos, events };
}

/** Tax settlements on this asset that were allocated by income share (spec 4a). */
function allocatedTaxLegs(ctx) {
    return ctx.events().filter(e =>
        e.data?.basis === 'proportional' && e.data?.direction !== 'refund');
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
                // Read from the tax table, not a global: the exclusion is
                // $250,000 filing single and $500,000 filing jointly, and this
                // note previously quoted the single figure to everyone — telling
                // an MFJ household the wrong number as well as taxing on it.
                text: `Primary home sold after more than two years — the first ${formatCurrency(activeTaxTable.activeHomeSaleExclusion)} of gain is excluded before capital gains tax.`,
                // A taxed gain still gets the explanation, but must not silence
                // the counterparty note, which is then describing a real tax.
                suppressOnly: ctx.total(Metric.TAXES) === 0,
            };
        },
    },

    {
        // Why a benefit pays out less than it is worth.
        //
        // Non-optional for a pension, so it MUST be visible: the household never
        // chose this and a smaller deposit with no explanation reads as a bug.
        // Before spec 4c a retirement-income asset showed no tax at all and the
        // tax-settled-elsewhere note below covered it; once the benefit withholds
        // its own, that note correctly stops applying and would leave silence.
        //
        // Rule 1 — the amount is read from what was booked, never recomputed
        // from the rate.
        id: 'retirement-income-withholding',
        suppresses: ['tax-settled-elsewhere'],
        evaluate(ctx) {
            const { asset } = ctx;
            if (!InstrumentType.isRetirementIncome(asset.instrument)) return null;
            const withheld = Math.abs(ctx.total(Metric.WITHHELD_INCOME_TAX));
            if (withheld === 0) return null;

            const isPension = InstrumentType.isPension(asset.instrument);
            return {
                emoji: '\u{1F4CB}',
                text: `${formatCurrency(withheld)} of federal tax was withheld from this ` +
                      `${isPension ? 'pension' : 'benefit'} before it was paid out, so the deposits ` +
                      'you see are net of tax. ' +
                      (isPension
                        ? 'Pensions withhold by default; the year-end true-up refunds any excess.'
                        : 'Social Security only withholds when you elect it, and the year-end true-up refunds any excess.'),
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
            // reportUnfunded covers two different events and the wording has to
            // follow: an obligation nothing could pay, and take-home pay with
            // nowhere to be deposited. Quote the engine's own reason rather than
            // asserting one story for both.
            const reasons = [...new Set(
                unfunded.map(m => m.note.split('—')[1]?.trim()).filter(Boolean)
            )];
            const why = reasons.length ? ` (${reasons.join('; ')})` : '';

            return {
                emoji: '\u{26A0}\u{FE0F}',
                tone: 'warn',
                text: `${formatCurrency(shortfall)} could not be funded${why}. No eligible account — cash, savings, brokerage or bonds — held a positive balance, so the plan's books and its cash no longer agree.`,
            };
        },
    },

    {
        // Why this account was billed for tax on income it earned.
        //
        // Without this an allocated payer is silent, and silence reads as a bug
        // — especially on an IRA, which the funding-backstop note below can
        // never explain because a retirement account is not in the backstop.
        //
        // Rule 2: the SHARE is read off the event, where the engine booked it.
        // It is a share of a HOUSEHOLD bill, and the wording must not suggest
        // the engine computed what this account alone owes — brackets are not
        // additive and that number does not exist.
        id: 'tax-allocated-by-income',
        suppresses: ['funding-backstop'],
        evaluate(ctx) {
            const legs = allocatedTaxLegs(ctx);
            if (legs.length === 0) return null;

            const paid = legs.reduce((s, e) => s + Math.abs(e.amount?.amount ?? 0), 0);
            if (paid === 0) return null;

            const shares = legs.map(e => e.data?.share).filter(s => typeof s === 'number');
            const avg = shares.length ? shares.reduce((s, v) => s + v, 0) / shares.length : null;
            const pct = avg == null ? null : `${(avg * 100).toFixed(avg < 0.1 ? 1 : 0)}%`;

            const deferred = InstrumentType.isTaxDeferred(ctx.asset.instrument);
            const because = pct
                ? `it generated about ${pct} of the household's taxable income`
                : 'it generated part of the household\'s taxable income';

            return {
                emoji: '\u{1F9FE}',
                text: `${formatCurrency(paid)} of the household's income tax was paid from here because ${because} over this period. ` +
                      (deferred
                        ? 'Withdrawing from a retirement account to pay tax is itself a taxable distribution, so it adds to next year\'s bill.'
                        : 'This is a share of one household bill, not this account\'s own tax — tax brackets apply to the household, not per account.'),
            };
        },
    },

    {
        // Why money leaves an account the user never wired up. A policy
        // statement, not a claim about an amount — which is what makes it safe
        // to show on every month the account actually settled something.
        //
        // Must NOT fire for an account that only paid an allocated share: that
        // account was chosen because it earned the income, not because it is the
        // household's default source, and calling it the automatic funding
        // account would describe a mechanism that did not run.
        id: 'funding-backstop',
        evaluate(ctx) {
            const { asset } = ctx;
            if (!InstrumentType.isFundingBackstop(asset.instrument)) return null;
            if (ctx.total(Metric.ESTIMATED_INCOME_TAX) === 0) return null;

            const settlements = ctx.events().filter(e =>
                e.type === EventType.INCOME_TAX_WITHHOLDING || e.type === EventType.TAX_TRUE_UP);
            const anyBackstopDraw = settlements.some(e => e.data?.basis !== 'proportional');
            if (settlements.length > 0 && !anyBackstopDraw) return null;

            return {
                emoji: '\u{1F3E6}',
                text: "This is the household's funding account: taxes, bills and mortgage payments draw from here automatically when no transfer covers them.",
            };
        },
    },

    {
        // Why a contribution came in under what the transfer asked for.
        // PayrollEngine.recordContributionCap writes the shortfall as an `info`
        // memo at the clamp site — before that the reduction left no trace, and
        // only "you reached the limit" was sayable, which cannot tell a cap
        // apart from a deliberate election of exactly the limit.
        id: 'contribution-capped',
        evaluate(ctx) {
            const capped = ctx.memos().filter(m => /^Contribution capped\b/.test(m.note ?? ''));
            if (capped.length === 0) return null;

            const shortfall = capped.reduce((s, m) => s + Math.abs(m.amount?.amount ?? 0), 0);
            // Every memo carries its limit's name; if they all agree, use it.
            const names = new Set(capped.map(m => m.note.split('—')[1]?.trim()).filter(Boolean));
            const which = names.size === 1 ? [...names][0] : 'the annual contribution limits';

            return {
                emoji: '\u{1F4CA}',
                text: `Contributions were capped by the ${which} — ${formatCurrency(shortfall)} of what your transfers asked for could not be contributed.`,
            };
        },
    },

    {
        // Where depletion went when it lost the ⚠️.
        //
        // The card icon used to mean isDepleted, which fires on every retiree
        // whose accounts draw down — i.e. on the exact scenario this tool
        // exists to model. The icon now means an unpayable obligation, and the
        // fact that an account emptied lives here, stated plainly and without
        // alarm.
        //
        // isDepleted is present state — true forever once set — so it cannot
        // date the event on its own (rule 3). The month comes from the VALUE
        // history, and the note stays silent unless that month falls inside
        // the window being viewed.
        id: 'account-depleted',
        evaluate(ctx) {
            const { asset } = ctx;
            if (!asset?.isDepleted) return null;

            const history = asset.getHistory?.(Metric.VALUE);
            if (!history?.length) return null;

            // First month the balance fell to nothing after holding something.
            let idx = -1;
            for (let i = 1; i < history.length; i++) {
                if (history[i - 1] > 0.01 && history[i] <= 0.01) { idx = i; break; }
            }
            if (idx < 0) return null;
            if (idx < ctx.from || idx > ctx.to) return null;

            let when = 'this plan';
            if (ctx.firstDateInt) {
                const d = DateInt.from(ctx.firstDateInt.year, ctx.firstDateInt.month);
                d.addMonths(idx);
                when = monthLabel(d);
            }

            return {
                emoji: '\u{1FAB9}',
                text: `This account reached $0 in ${when} and was held there — it cannot go negative. Drawing an account down is normal; what matters is whether anything went unpaid, which is reported separately.`,
            };
        },
    },

    {
        // Federal withholding at the source of a deferred distribution is
        // non-optional and has no UI, so without this note a user watching
        // their IRA shrink by more than they spent has no way to tell a policy
        // from a bug.
        //
        // Derived, never recomputed (rule 1): the withheld total is read from
        // WITHHELD_INCOME_TAX, which the engine booked. Recomputing it as
        // rate × distribution would keep reporting a number even if the writer
        // were deleted — the note would survive the feature.
        //
        // The rate is stated as booked, not read from the current constant
        // (rule 3): a window thirty years ago must not re-render at whatever
        // rate is configured today.
        id: 'retirement-withholding',
        evaluate(ctx) {
            if (!InstrumentType.isTaxDeferred(ctx.asset.instrument)) return null;

            const withheld = Math.abs(ctx.total(Metric.WITHHELD_INCOME_TAX));
            if (withheld === 0) return null;

            const distributed = Math.abs(ctx.total(Metric.TRAD_IRA_DISTRIBUTION))
                              + Math.abs(ctx.total(Metric.FOUR_01K_DISTRIBUTION));
            if (distributed === 0) return null;

            // Rate as it actually applied over this window, from the two booked
            // figures — so a window spanning a rate change reads as the blend
            // it was, not as either endpoint.
            const pct = Math.round((withheld / distributed) * 100);

            return {
                emoji: '\u{1F4E4}',
                text: `${formatCurrency(withheld)} of the ${formatCurrency(distributed)} distributed was withheld for federal income tax (${pct}%) and sent straight to the IRS — the same default a custodian applies when you make no election. Your annual true-up settles the difference either way, refunding any excess.`,
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
