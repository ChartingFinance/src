/**
 * spending-solver.js
 *
 * "How much can this plan spend?"
 *
 * Turns one dial, a factor on every monthly expense, and finds the highest
 * setting at which the plan still keeps its limits:
 *
 *   - it never runs out: no month has an unpaid bill, as the Outcome card and
 *     "What needs attention" define it (the plan-exhaustion issue);
 *   - it leaves at least `floor` at the end, in today's dollars.
 *
 * ── Why it scans ──────────────────────────────────────────────────────
 *
 * Usually the money left at the end falls as spending rises, and halving an
 * interval would find the answer. It does not always: at lower spending a
 * surplus can sit idle in a low-return account, and a plan can end with less
 * than it would have by spending more. So the solver runs the whole range of
 * spending levels, takes the highest level that keeps every limit, and only
 * then refines between that level and the failing one above it. When the
 * curve does rise it says so, and names the account that holds the difference.
 *
 * Past the first unpaid bill the ending figure is no guide at all: a bill that
 * was not paid was not spent. "Never runs out" is tested before anything else.
 *
 * ── What it does not touch ───────────────────────────────────────────
 *
 * It builds its own portfolios from the serialized plan and changes nothing it
 * is given. It reads no global and uses no random numbers: the same plan and
 * limits give the same result.
 *
 * A marketplace health plan is turned with the other expenses, which models a
 * dearer or cheaper plan. Its benchmark premium is the market's, not the
 * household's, and is left alone: the engine reads it from the entered
 * benchmark and the premium's own growth, so scaling the premium does not
 * move it.
 */

import { ModelAsset } from './model-asset.js';
import { ModelLifeEvent } from './life-event.js';
import { Portfolio } from './portfolio.js';
import { chronometer_run } from './chronometer.js';
import { detectIssues, planExhaustion } from './portfolio-issues.js';
import { planOutcome } from './outcome-summary.js';
import { InstrumentType } from './instruments/instrument.js';
import { PriceIndex } from './utils/price-index.js';
import { bookedMonthIndex } from './trace.js';
import { obligationOf, Expenditure } from './annual-expenditure.js';

/** Spending levels run across the range. They are also the curve. */
export const SCAN_LEVELS = 40;
/** The scan starts at this share of what was entered. */
export const SCAN_FROM = 0.5;
/** The dial is not turned past this. A plan still funded here is reported as such. */
export const FACTOR_CAP = 8;
/** Below this the dial is not turned down further when looking for a funded level. */
export const FACTOR_FLOOR = 1 / 16;
/** Refining stops when the gap is narrower than this many dollars a month. */
export const REFINE_TO_DOLLARS = 10;
/** Halvings spent closing in on the level where the plan first runs out. */
const EDGE_STEPS = 6;
/** A rise in the curve smaller than this share of the ending value is not reported. */
const RISE_TOLERANCE = 0.001;

/** Whether the dial turns this account. */
export function isDialExpense(instrument) {
    return InstrumentType.isMonthlyExpense(instrument);
}

/** The plan's assets as plain objects, with every dial expense scaled by `factor`. */
export function scaledAssets(modelAssets, factor) {
    return modelAssets.map((asset) => {
        const plain = JSON.parse(JSON.stringify(asset));
        if (isDialExpense(plain.instrument) && plain.startCurrency) {
            plain.startCurrency.amount *= factor;
        }
        return plain;
    });
}

/**
 * The plan's assets at a solved level, as a scenario keeps them: each dial
 * expense scaled by `factor` and cut to the cent, toward spending less, so the
 * saved plan never spends more than the level that was tested.
 */
export function solvedAssets(modelAssets, factor) {
    return scaledAssets(modelAssets, factor).map((plain) => {
        if (isDialExpense(plain.instrument) && plain.startCurrency) {
            plain.startCurrency.amount = Math.trunc(plain.startCurrency.amount * 100) / 100;
        }
        return plain;
    });
}

/**
 * Run the plan with its expenses scaled by `factor`, and measure it.
 *
 * @returns {object} one measured run; see `measure`
 */
export function runAt(plan, factor) {
    const assets = scaledAssets(plan.modelAssets, factor).map((a) => ModelAsset.fromJSON(a));
    const portfolio = new Portfolio(assets, false, plan.config);
    portfolio.lifeEvents = (plan.lifeEvents ?? []).map((e) => ModelLifeEvent.fromJSON(e));
    chronometer_run(portfolio);
    return measure(portfolio, factor);
}

/** The figures the solver and the result table read from one finished run. */
function measure(portfolio, factor) {
    // The Outcome card's own reading of the run, so the first column of the
    // result is the card's figure and the two cannot drift apart.
    const issues = detectIssues(portfolio);
    const outcome = planOutcome(portfolio, issues);
    const endingNominal = outcome?.end ?? 0;
    const endingReal = outcome?.endReal ?? endingNominal;
    const exhaustion = planExhaustion(issues);

    const spendingByMonth = realSpendingByMonth(portfolio);
    const lifetimeSpending = spendingByMonth.reduce((sum, v) => sum + v, 0);

    const balances = {};
    for (const asset of portfolio.modelAssets) {
        balances[asset.displayName] = asset.finishCurrency.amount;
    }

    return {
        factor,
        endingNominal,
        endingReal,
        runsOut: exhaustion ? {
            year: exhaustion.firstDateInt.year,
            month: exhaustion.firstDateInt.month,
            headline: exhaustion.headline,
            unpaid: exhaustion.amount,
        } : null,
        lifetimeSpending,
        monthlySpending: spendingByMonth.length ? lifetimeSpending / spendingByMonth.length : 0,
        spendingByMonth,
        balances,
        portfolio,
    };
}

/**
 * What the household withdrew to spend, month by month, in today's dollars.
 *
 * The same reading as annual-expenditure.js (a draw counts when its chain
 * roots in an obligation, and tax is not spending), in one pass so that every
 * level of the scan can afford it.
 */
function realSpendingByMonth(portfolio) {
    const first = portfolio.firstDateInt;
    const index = portfolio.monthlyPriceIndex ?? [];
    const months = new Array(index.length).fill(0);
    if (!first) return months;

    const scopes = portfolio.traceScopes ?? [];
    const memo = new Map();
    for (const asset of portfolio.modelAssets) {
        if (!InstrumentType.isFundable(asset.instrument)) continue;
        for (const event of (asset.events ?? [])) {
            if (!event.dateInt) continue;
            const o = obligationOf(event, scopes, memo);
            if (!o || o.bucket !== Expenditure.SPENDING) continue;
            const when = bookedMonthIndex(event, first, scopes);
            if (when < 0 || when >= months.length) continue;
            months[when] += PriceIndex.deflateAt(-event.amount.amount, index, when);
        }
    }
    return months;
}

/** Whether a run keeps every limit. */
function keeps(run, limits) {
    return !run.runsOut && run.endingReal >= limits.floor;
}

/**
 * The level where the plan first runs out, found by doubling from what was
 * entered (or, when the entered plan already runs out, by halving down to a
 * funded level). `capped` is true when the plan is still funded at the cap.
 */
function findEdge(asEntered, run) {
    // A funded level and a level that runs out, with the edge between them.
    let funded, out;
    if (!asEntered.runsOut) {
        funded = 1;
        out = 1;
        while (out < FACTOR_CAP) {
            out = Math.min(out * 2, FACTOR_CAP);
            if (run(out).runsOut) break;
            funded = out;
        }
        if (funded === FACTOR_CAP) return { factor: FACTOR_CAP, from: SCAN_FROM, capped: true };
    } else {
        out = 1;
        funded = SCAN_FROM;
        while (funded > FACTOR_FLOOR && run(funded).runsOut) { out = funded; funded /= 2; }
        if (run(funded).runsOut) return { factor: out, from: funded, capped: false };
    }
    // Close in, so the scan spends its levels on the funded range.
    for (let i = 0; i < EDGE_STEPS; i++) {
        const mid = (funded + out) / 2;
        if (run(mid).runsOut) out = mid; else funded = mid;
    }
    return { factor: out, from: Math.min(SCAN_FROM, funded / 2), capped: false };
}

/**
 * Solve "spend the most that keeps these limits".
 *
 * @param {object}   plan
 * @param {object[]} plan.modelAssets  serialized assets (ModelAsset JSON)
 * @param {object[]} plan.lifeEvents   serialized life events
 * @param {object}   plan.config       a SimConfig
 * @param {object}   [limits]
 * @param {number}   [limits.floor=0]  least to leave at the end, today's dollars
 * @returns {object} see the end of this function
 */
export function solveSpending(plan, limits = {}) {
    const want = { floor: Math.max(0, Number(limits.floor) || 0) };

    const runs = new Map();
    const run = (factor) => {
        if (!runs.has(factor)) runs.set(factor, runAt(plan, factor));
        return runs.get(factor);
    };

    const asEntered = run(1);
    const edge = findEdge(asEntered, run);

    // The scan, from well below what was entered up to the edge. Its last
    // level is the first that runs out, so the curve ends where the plan does.
    const from = edge.from;
    const levels = [];
    for (let i = 0; i < SCAN_LEVELS; i++) {
        levels.push(from + (edge.factor - from) * i / (SCAN_LEVELS - 1));
    }
    const scan = levels.map(run);

    // The highest level that keeps every limit, then the gap above it.
    let pick = -1;
    for (let i = scan.length - 1; i >= 0; i--) {
        if (keeps(scan[i], want)) { pick = i; break; }
    }

    let best = null;
    let failing = null;
    if (pick >= 0) {
        best = scan[pick];
        failing = scan[pick + 1] ?? null;
        if (failing) {
            const dollarsPerUnit = Math.max(asEntered.monthlySpending, 1);
            let lo = best.factor, hi = failing.factor;
            for (let i = 0; i < 24 && (hi - lo) * dollarsPerUnit > REFINE_TO_DOLLARS; i++) {
                const mid = (lo + hi) / 2;
                const r = run(mid);
                if (keeps(r, want)) { lo = mid; best = r; } else { hi = mid; failing = r; }
            }
        }
    } else {
        failing = scan[0];
    }

    return {
        limits: want,
        asEntered: column(asEntered, plan),
        best: best ? column(best, plan) : null,
        boundBy: boundBy(best, failing, want, edge),
        curve: scan.map((r) => ({
            factor: r.factor,
            monthlySpending: r.monthlySpending,
            endingReal: r.endingReal,
            runsOut: !!r.runsOut,
        })),
        rise: findRise(scan),
        healthNote: healthNote(asEntered.portfolio),
        runs: runs.size,
    };
}

/** One column of the result table. */
function column(run, plan) {
    const split = healthSplit(run.portfolio);
    const out = {
        factor: run.factor,
        expenses: plan.modelAssets
            .filter((a) => isDialExpense(a.instrument))
            .map((a) => ({
                displayName: a.displayName,
                monthly: Math.abs(a.startCurrency?.amount ?? 0) * run.factor,
            })),
        monthlySpending: run.monthlySpending,
        lifetimeSpending: run.lifetimeSpending,
        endingReal: run.endingReal,
        endingNominal: run.endingNominal,
        runsOut: run.runsOut,
    };
    if (split != null) {
        const before = run.spendingByMonth.slice(0, split);
        const after = run.spendingByMonth.slice(split);
        const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
        out.monthlySpendingBefore65 = mean(before);
        out.monthlySpendingFrom65 = mean(after);
        out.premiumTaxCredit = (run.portfolio.taxYears ?? [])
            .reduce((sum, y) => sum + (y.ptc ?? 0), 0);
    }
    return out;
}

/**
 * The index of the first month after the marketplace health plan ends, when
 * the plan has one that ends before the plan does; otherwise null.
 */
function healthSplit(portfolio) {
    const card = portfolio.modelAssets.find((a) => InstrumentType.isHealthInsurance(a.instrument));
    if (!card) return null;
    const first = portfolio.firstDateInt;
    const end = card.effectiveFinishDateInt;
    const split = (end.year - first.year) * 12 + (end.month - first.month) + 1;
    const total = (portfolio.monthlyPriceIndex ?? []).length;
    return split > 0 && split < total ? split : null;
}

/**
 * True when the plan has a marketplace health plan and no expense that starts
 * within a year of its end: nothing in it pays for health cover from 65, and
 * the result must not read the gap as room to spend.
 */
function healthNote(portfolio) {
    if (healthSplit(portfolio) == null) return false;
    const card = portfolio.modelAssets.find((a) => InstrumentType.isHealthInsurance(a.instrument));
    const end = card.effectiveFinishDateInt;
    const monthsAfter = (d) => (d.year - end.year) * 12 + (d.month - end.month);
    return !portfolio.modelAssets.some((a) =>
        a !== card
        && InstrumentType.isMonthlyExpense(a.instrument)
        && a.startDateInt
        && monthsAfter(a.startDateInt) >= 0
        && monthsAfter(a.startDateInt) <= 12);
}

/** Which limit stopped spending from going higher, and where. */
function boundBy(best, failing, limits, edge) {
    if (!failing) {
        return { kind: 'cap', factor: edge.factor };
    }
    if (failing.runsOut) {
        return {
            kind: 'runsOut',
            year: failing.runsOut.year,
            month: failing.runsOut.month,
            headline: failing.runsOut.headline,
            unpaid: failing.runsOut.unpaid,
            untouched: untouchedAt(failing),
            noLevelPasses: !best,
        };
    }
    return { kind: 'floor', floor: limits.floor, endingReal: failing.endingReal, noLevelPasses: !best };
}

/**
 * Retirement accounts that still held money in the month the plan ran out.
 * The backstop never spends them, so they explain a plan that runs out with
 * wealth left.
 */
function untouchedAt(run) {
    const p = run.portfolio;
    const first = p.firstDateInt;
    const at = (run.runsOut.year - first.year) * 12 + (run.runsOut.month - first.month);
    const held = [];
    for (const asset of p.modelAssets) {
        const i = asset.instrument;
        if (!InstrumentType.isTaxDeferred(i) && !InstrumentType.isTaxFree(i)) continue;
        const history = asset.getHistory?.('value') ?? [];
        const balance = history[Math.min(at, history.length - 1)];
        const amount = balance?.amount ?? balance ?? 0;
        if (amount > 0) held.push({ displayName: asset.displayName, amount });
    }
    return held.sort((a, b) => b.amount - a.amount);
}

/**
 * The largest rise in the funded part of the curve, or null. A rise means a
 * lower level of spending leaves money idle; the account whose ending balance
 * is most above its value on the far side is the one that holds it.
 */
function findRise(scan) {
    let found = null;
    for (let i = 0; i + 1 < scan.length; i++) {
        const lower = scan[i], higher = scan[i + 1];
        if (lower.runsOut || higher.runsOut) continue;
        const gain = higher.endingReal - lower.endingReal;
        if (gain <= Math.abs(lower.endingReal) * RISE_TOLERANCE) continue;
        if (found && gain <= found.gain) continue;

        let account = null;
        for (const [name, amount] of Object.entries(lower.balances)) {
            const excess = amount - (higher.balances[name] ?? 0);
            if (excess > 0 && (!account || excess > account.amount)) {
                account = { displayName: name, amount: excess, balance: amount };
            }
        }
        found = { fromFactor: lower.factor, toFactor: higher.factor, gain, account };
    }
    return found;
}
