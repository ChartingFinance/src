/**
 * routing-search.js
 *
 * "Is there a better way to route my money?"
 *
 * A plan's routing is its transfer rules: how each income is split across
 * accounts, and which accounts pay each expense, phase by phase. This module
 * searches over those percentages and nothing else.
 *
 * ── What may change (spec 15 §8.2) ───────────────────────────────────
 *
 *   - the split of each income across the accounts it can be paid into;
 *   - which accounts pay each monthly expense.
 *
 * What may not:
 *
 *   - home, mortgage and debt rules, and moves from one account to another;
 *   - a draw on a retirement account in a phase that starts before 60. The
 *     early-withdrawal penalty is not charged yet (spec 13), so the search
 *     would find those draws free. They stay at the value the user entered;
 *   - retirement income (a pension, Social Security) paid into a retirement
 *     account, which the law does not allow.
 *
 * Contribution limits are the engine's: payroll cuts a contribution at the
 * annual limit and deposits the rest as take-home pay, so a routing that asks
 * for too much is run as the law would run it.
 *
 * ── How a routing is ranked (§8.8) ───────────────────────────────────
 *
 * By what the plan can spend under it: the highest level of the spending
 * dial at which it never runs out and leaves the floor. No weights and no
 * constants. Ranking by what is left at the end was measured and dropped: it
 * moves money into retirement accounts, where a bill cannot reach it, and the
 * plan can then spend less (§8.7).
 *
 * ── How wide it looks (§8.8) ─────────────────────────────────────────
 *
 * The user sets a depth. Each depth is a list of searches (`searchesAt`), each
 * search is one call of `searchRouting`, and the result shown is all of them,
 * ranked (`rankSearches`).
 *
 * ── What it does not touch ───────────────────────────────────────────
 *
 * Headless and pure, like spending-solver.js: it builds its own portfolios
 * from the serialized plan, changes nothing it is given, and reads no global.
 * Every random number comes from a seed, so the same plan and seed give the
 * same result.
 */

import { ModelAsset } from './model-asset.js';
import { ModelLifeEvent } from './life-event.js';
import { Portfolio } from './portfolio.js';
import { chronometer_run } from './chronometer.js';
import { detectIssues, planExhaustion } from './portfolio-issues.js';
import { InstrumentType } from './instruments/instrument.js';
import { PriceIndex } from './utils/price-index.js';
import { withoutTracing } from './trace.js';
import { ageToDateIntFor, finishDateIntFor } from './plan-dates.js';
import { scaledAssets, solveSpending } from './spending-solver.js';

/** A phase that starts before this age holds its retirement-account draws. */
export const PENALTY_FREE_AGE = 60;

// ── The genes ───────────────────────────────────────────────────────

const isRetirementAccount = (instrument) =>
    InstrumentType.isTaxDeferred(instrument) || InstrumentType.isTaxFree(instrument);

/** The year an asset's own dates start and end in, as entered. */
const years = (asset) => ({
    from: asset.startDateInt?.year ?? -Infinity,
    to: asset.finishDateInt?.year ?? Infinity,
});

/**
 * The percentages the search may change.
 *
 * One group for each income or expense in each phase it is alive in. A group
 * holds its targets; each target is a gene (a whole percentage, 0 to 100) or
 * is locked at the entered value. A group's percentages never sum past 100.
 *
 * @param {object} plan  { modelAssets, lifeEvents, config }
 * @returns {{ groups: object[], genes: object[], entered: number[] }}
 *   `genes[i]` is `{ group, target }`, indexes into `groups`; `entered[i]` is
 *   the percentage the user entered for it (0 when there is no rule).
 */
export function routingGenes(plan) {
    const assets = plan.modelAssets;
    const events = plan.lifeEvents ?? [];
    // Ages become dates through the plan's birth year, which a Portfolio
    // derives from the plan's first month.
    const config = new Portfolio(assets.map((a) => ModelAsset.fromJSON(a)), false, plan.config).config;
    const lastYear = finishDateIntFor(config).year;

    const groups = [];
    const closed = new Set();
    // A phase that says nothing about a source leaves its rules as the last
    // phase that did set them. `inForce` is what each source runs on.
    const inForce = new Map();
    events.forEach((event, phaseIdx) => {
        for (const [name, rules] of Object.entries(event.phaseTransfers ?? {})) inForce.set(name, rules);
        for (const name of (event.closes ?? [])) closed.add(name);
        const fromYear = ageToDateIntFor(config, event.triggerAge).year;
        const next = events[phaseIdx + 1];
        const toYear = next ? ageToDateIntFor(config, next.triggerAge).year : lastYear;
        const alive = assets.filter((asset) => {
            if (closed.has(asset.displayName)) return false;
            const y = years(asset);
            return y.from <= toYear && y.to >= fromYear;
        });
        const early = event.triggerAge < PENALTY_FREE_AGE;

        for (const source of alive) {
            const income = InstrumentType.isMonthlyIncome(source.instrument);
            const expense = InstrumentType.isMonthlyExpense(source.instrument);
            if (!income && !expense) continue;

            const rules = inForce.get(source.displayName) ?? [];
            const inherited = !(source.displayName in (event.phaseTransfers ?? {}));
            const enteredFor = (name) => rules.find((r) => r.toDisplayName === name)?.monthlyMoveValue ?? 0;

            const targets = [];
            for (const target of alive) {
                if (target === source) continue;
                const t = target.instrument;
                const retirement = isRetirementAccount(t);
                let open;
                if (income) {
                    open = InstrumentType.isFundable(t) && !InstrumentType.isDebt(t)
                        && !(retirement && !InstrumentType.isWorkingIncome(source.instrument));
                } else {
                    open = InstrumentType.isExpensable(t) && !(retirement && early);
                }
                if (open) {
                    targets.push({ name: target.displayName, entered: enteredFor(target.displayName), locked: false });
                }
            }
            // Rules the search may not change still count toward the group's 100.
            for (const rule of rules) {
                if (targets.some((t) => t.name === rule.toDisplayName)) continue;
                targets.push({ name: rule.toDisplayName, entered: rule.monthlyMoveValue ?? 0, locked: true });
            }
            if (targets.some((t) => !t.locked)) {
                groups.push({
                    phaseIdx, phase: event.displayName, source: source.displayName,
                    kind: income ? 'income' : 'expense', targets,
                    // What the source runs on in this phase, and whether an
                    // earlier phase set it.
                    rules: JSON.parse(JSON.stringify(rules)), inherited,
                });
            }
        }
    });

    const genes = [];
    const entered = [];
    groups.forEach((group, g) => group.targets.forEach((target, t) => {
        if (target.locked) return;
        genes.push({ group: g, target: t });
        entered.push(target.entered);
    }));
    return { groups, genes, entered };
}

/**
 * Bring a routing inside its limits: whole percentages from 0 to 100 (or the
 * entered value), and no group over 100 with its locked rules counted. A group that is over is
 * scaled down, so its proportions are kept.
 */
export function repair(map, values) {
    // An entered value is kept as entered, fraction and all, so that the
    // entered routing is the plan as entered; any other is a whole number.
    const out = values.map((v, i) => (v === map.entered[i] ? v : Math.max(0, Math.min(100, Math.round(v)))));
    const byGroup = new Map();
    map.genes.forEach((gene, i) => {
        if (!byGroup.has(gene.group)) byGroup.set(gene.group, []);
        byGroup.get(gene.group).push(i);
    });
    for (const [g, indexes] of byGroup) {
        const locked = map.groups[g].targets.filter((t) => t.locked).reduce((s, t) => s + t.entered, 0);
        const room = Math.max(0, 100 - locked);
        const total = indexes.reduce((s, i) => s + out[i], 0);
        if (total <= room) continue;
        const scale = room / total;
        for (const i of indexes) out[i] = Math.floor(out[i] * scale);
    }
    return out;
}

/** The plan's life events, as plain objects, with a routing written in. */
export function applyRouting(plan, map, values) {
    const events = JSON.parse(JSON.stringify(plan.lifeEvents ?? []));
    const changed = new Set();
    map.genes.forEach((gene, i) => { if (values[i] !== map.entered[i]) changed.add(gene.group); });

    map.genes.forEach((gene, i) => {
        const group = map.groups[gene.group];
        // A source running on an earlier phase's rules keeps doing so unless
        // this phase changes one: writing a rule here replaces them all.
        if (group.inherited && !changed.has(gene.group)) return;
        const target = group.targets[gene.target];
        const event = events[group.phaseIdx];
        event.phaseTransfers ??= {};
        const rules = (event.phaseTransfers[group.source] ??= JSON.parse(JSON.stringify(group.rules)));
        const rule = rules.find((r) => r.toDisplayName === target.name);
        if (rule) rule.monthlyMoveValue = values[i];
        else if (values[i] > 0) rules.push({ toDisplayName: target.name, monthlyMoveValue: values[i], closeMoveValue: 0 });
    });
    return events;
}

// ── Ranking ─────────────────────────────────────────────────────────

/**
 * Run the plan under a routing and score it.
 *
 * @param {number} [factor=1]  spending level, as the spending solver's dial
 * @returns {{ unpaid: number, endingReal: number }}
 */
export function scoreRouting(plan, map, values, factor = 1) {
    const assets = scaledAssets(plan.modelAssets, factor).map((a) => ModelAsset.fromJSON(a));
    const portfolio = new Portfolio(assets, false, plan.config);
    portfolio.lifeEvents = applyRouting(plan, map, values).map((e) => ModelLifeEvent.fromJSON(e));
    // Ranked, never explained: no causal chain is recorded.
    withoutTracing(() => chronometer_run(portfolio));

    const index = portfolio.monthlyPriceIndex ?? [];
    const exhaustion = planExhaustion(detectIssues(portfolio));
    return {
        unpaid: exhaustion ? exhaustion.amount : 0,
        endingReal: PriceIndex.deflateAt(portfolio.finishValue().amount, index, index.length - 1),
    };
}

/** Two amounts closer than this, in dollars, count as the same. */
export const TIE = 1;

/** A seeded random source (mulberry32): the same seed gives the same stream. */
export function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ═══════════════════════════════════════════════════════════════════
// Ranked by what the plan can spend
// ═══════════════════════════════════════════════════════════════════
//
// A routing is ranked by the question the Test Bench asks, "how much can this
// plan spend?": the highest spending level at which it never runs out and
// leaves the floor.
//
// Finding that level takes about ten runs, too many for every candidate. The
// ranker instead holds a level just above the best routing so far. A
// candidate is run once at that level. If it pays every bill there it is the
// new best, and only then is its own level found. If it does not, the bills
// it leaves unpaid rank it against the other candidates.

/** The spending dial is not turned past this, as in the spending solver. */
const LEVEL_CAP = 8;
const LEVEL_FLOOR = 1 / 16;

/**
 * @param {object} [limits]
 * @param {number} [limits.floor=0]    least to leave at the end, today's dollars
 * @param {number} [limits.within=10]  two levels closer than this many dollars
 *                                     a month count as the same
 * @param {(runs: number, level: number) => void} [limits.onRun]  after each plan run
 * @param {Function} [limits.score]  what runs the plan: scoreRouting, unless a
 *                                   test supplies a landscape of its own
 */
export function makeRanker(plan, map, { floor = 0, within = 10, onRun = null, score = scoreRouting } = {}) {
    const seen = new Map();
    const ranker = { runs: 0 };

    /** What the routing falls short by at a spending level; 0 when it keeps the limits. */
    const shortAt = (values, factor) => {
        const key = factor + '|' + values.join(',');
        let short = seen.get(key);
        if (short === undefined) {
            const s = score(plan, map, values, factor);
            short = s.unpaid + Math.max(0, floor - s.endingReal);
            seen.set(key, short);
            ranker.runs++;
            onRun?.(ranker.runs, ranker.edge ?? 0);
        }
        return short;
    };
    const keeps = (values, factor) => shortAt(values, factor) <= TIE;

    /** The highest level a routing keeps the limits at, searching up from `from`, which it keeps. */
    const raise = (values, from, step) => {
        let lo = from, hi = from;
        for (let grow = 1.05; hi < LEVEL_CAP; grow *= grow) {
            hi = Math.min(lo * grow, LEVEL_CAP);
            if (!keeps(values, hi)) break;
            lo = hi;
        }
        if (lo === LEVEL_CAP) return lo;
        while (hi - lo > step) {
            const mid = (lo + hi) / 2;
            if (keeps(values, mid)) lo = mid; else hi = mid;
        }
        return lo;
    };

    const entered = repair(map, map.entered);
    // The entered plan's monthly spending sets how fine a level is.
    const monthly = scaledAssets(plan.modelAssets, 1)
        .filter((a) => InstrumentType.isMonthlyExpense(a.instrument))
        .reduce((sum, a) => sum + Math.abs(a.startCurrency?.amount ?? 0), 0);
    const step = within / Math.max(monthly, 1);

    /** A routing's own level: up from 1 when it is funded there, otherwise down until it is. */
    const levelOf = (values) => {
        let start = 1;
        while (!keeps(values, start) && start > LEVEL_FLOOR) start *= 0.8;
        return keeps(values, start) ? raise(values, start, step) : 0;
    };
    ranker.enteredLevel = levelOf(entered);

    ranker.entered = entered;
    ranker.values = entered;
    ranker.edge = ranker.enteredLevel;
    ranker.step = step;
    const level = () => (ranker.edge > 0 ? ranker.edge + step : LEVEL_FLOOR);

    /** A candidate's rank: what it falls short by just above the best so far. Lower is better. */
    ranker.short = (values) => shortAt(values, level());

    /**
     * Offer a candidate. It becomes the best so far when it keeps the limits
     * above the best's level (its own level is then found), or when it falls
     * short by less there while still keeping the best's level.
     *
     * @returns {'raised'|'closer'|false}
     */
    ranker.offer = (values) => {
        const at = level();
        const short = shortAt(values, at);
        if (short <= TIE) {
            ranker.edge = raise(values, at, step);
            ranker.values = values;
            return 'raised';
        }
        if (short < shortAt(ranker.values, at) - TIE
            && (ranker.edge === 0 || keeps(values, ranker.edge))) {
            ranker.values = values;
            return 'closer';
        }
        return false;
    };

    /** Begin again from another routing, as a restart does. The entered level is kept. */
    ranker.startFrom = (values) => {
        ranker.values = repair(map, values);
        ranker.edge = levelOf(ranker.values);
    };

    /** Whether a routing keeps the limits at the best's level less `slack`. */
    ranker.holds = (values, slack = 0) => ranker.edge > 0 && keeps(values, ranker.edge - slack);
    return ranker;
}

/** Step sizes a climb tries, largest first, in percentage points. */
export const CLIMB_STEPS = [20, 10, 5, 2, 1];

/** A genetic search's population and generations: 10,000 routings looked at. */
export const GENETIC_POPULATION = 50;
export const GENETIC_GENERATIONS = 200;

/**
 * Climb from the ranker's best: move one percentage up or down, or shift
 * points between two targets of a group, keeping each move the ranker takes.
 * Repeats at each step size until no move at that size helps, ending at one
 * point, so no single one-point move improves the result.
 */
export function climb(map, ranker, steps = CLIMB_STEPS) {
    const sameGroup = new Map();
    map.genes.forEach((gene, i) => {
        if (!sameGroup.has(gene.group)) sameGroup.set(gene.group, []);
        sameGroup.get(gene.group).push(i);
    });
    const attempt = (candidate) => {
        const fixed = repair(map, candidate);
        if (fixed.some((v, i) => v !== candidate[i])) return false;
        return !!ranker.offer(fixed);
    };
    for (const step of steps) {
        let improved = true;
        while (improved) {
            improved = false;
            for (let i = 0; i < map.genes.length; i++) {
                for (const delta of [step, -step]) {
                    const next = ranker.values.slice();
                    next[i] += delta;
                    if (next[i] < 0 || next[i] > 100) continue;
                    if (attempt(next)) improved = true;
                }
                for (const j of sameGroup.get(map.genes[i].group)) {
                    if (j === i || ranker.values[j] < step || ranker.values[i] + step > 100) continue;
                    const next = ranker.values.slice();
                    next[i] += step;
                    next[j] -= step;
                    if (attempt(next)) improved = true;
                }
            }
        }
    }
    return ranker.values;
}

/**
 * One genetic search, ranked by the ranker. The best so far is always in the
 * population, so a generation never loses it. It runs every generation: a
 * rule that stopped after 30 without a gain would have stopped some searches
 * at 90% of the level they went on to reach (§8.7).
 *
 * @param {object} options
 * @param {number} options.seed
 * @param {'plan'|'random'} [options.start='plan']  a first population of the
 *   ranker's best and near copies of it, or an entirely random one
 *
 * @returns {number} generations run
 */
export function geneticSearch(map, ranker, {
    seed, start = 'plan', population = GENETIC_POPULATION, generations = GENETIC_GENERATIONS,
    mutationRate = 0.15, onGeneration = null,
} = {}) {
    const random = seededRandom(seed);
    const n = map.genes.length;
    const randomValues = () => repair(map, Array.from({ length: n }, () => random() * 100));
    const near = (values) => repair(map, values.map((v) =>
        (random() < mutationRate ? v + (random() * 2 - 1) * 30 : v)));

    let pool = start === 'plan'
        ? [ranker.values, ...Array.from({ length: population - 1 }, () => near(ranker.values))]
        : Array.from({ length: population }, randomValues);

    let generation = 0;
    for (; generation < generations; generation++) {
        if (generation > 0 && generation % 50 === 0) {
            const ranked = pool.map((values) => ({ values, short: ranker.short(values) }))
                .sort((a, b) => a.short - b.short);
            pool = [...ranked.slice(0, 5).map((r) => r.values),
                    ...Array.from({ length: population - 5 }, randomValues)];
        }

        // Offered in rank order: the first to keep the limits raises the
        // level, and the rest are ranked against the new one next generation.
        let ranked = pool.map((values) => ({ values, short: ranker.short(values) }))
            .sort((a, b) => a.short - b.short);
        let gained = false;
        for (const candidate of ranked.slice(0, 5)) {
            const took = ranker.offer(candidate.values);
            if (took === 'raised') { gained = true; break; }
            if (took === 'closer') break;
        }
        if (gained) {
            ranked = pool.map((values) => ({ values, short: ranker.short(values) }))
                .sort((a, b) => a.short - b.short);
        }
        onGeneration?.(generation, ranker);

        const parents = ranked.slice(0, Math.floor(population / 2)).map((r) => r.values);
        const pick = () => parents[Math.floor(random() * parents.length)];
        const next = [ranker.values];
        while (next.length < population) {
            const a = pick(), b = pick();
            const cut = Math.floor(random() * n);
            for (const child of [a.slice(0, cut).concat(b.slice(cut)), b.slice(0, cut).concat(a.slice(cut))]) {
                next.push(repair(map, child.map((v) => (random() < mutationRate ? random() * 100 : v))));
            }
        }
        pool = next.slice(0, population);
    }
    return generation;
}

/**
 * Put changed percentages back to what the user entered wherever the routing
 * still keeps its level, less `share` of the gain. Groups first, then single
 * percentages.
 */
export function prune(map, ranker, share = 0.001) {
    const slack = Math.max(0, ranker.edge - ranker.enteredLevel) * share;
    let kept = ranker.values.slice();
    const tryBack = (indexes) => {
        if (indexes.every((i) => kept[i] === ranker.entered[i])) return;
        const candidate = kept.slice();
        for (const i of indexes) candidate[i] = ranker.entered[i];
        const fixed = repair(map, candidate);
        if (fixed.some((v, i) => v !== candidate[i])) return;
        if (ranker.holds(fixed, slack)) kept = fixed;
    };
    const byGroup = new Map();
    map.genes.forEach((gene, i) => {
        if (!byGroup.has(gene.group)) byGroup.set(gene.group, []);
        byGroup.get(gene.group).push(i);
    });
    for (const indexes of byGroup.values()) tryBack(indexes);
    for (let i = 0; i < kept.length; i++) tryBack([i]);
    return kept;
}

// ═══════════════════════════════════════════════════════════════════
// Depth: the searches a test runs
// ═══════════════════════════════════════════════════════════════════

/** The depths a user can pick, and the one the page starts on. */
export const DEPTHS = [1, 2, 3, 4];
export const DEFAULT_DEPTH = 3;

/** How far "near the plan" moves each percentage, in points either way. */
const NEAR = 30;

/**
 * The searches a depth runs. Each depth holds the one before it and adds to
 * it, and every seed is fixed, so the same plan and depth give the same list.
 *
 *   1  a climb from the plan as entered
 *   2  and four climbs from near the plan
 *   3  and five climbs from random routings
 *   4  and ten genetic searches, five from the plan and five from random
 *      routings, each followed by a climb
 *
 * @returns {Array<{ start: string, seed: number }>}
 */
export function searchesAt(depth) {
    const list = [{ start: 'plan', seed: 0 }];
    const add = (start, count) => {
        for (let seed = 1; seed <= count; seed++) list.push({ start, seed });
    };
    if (depth >= 2) add('near', 4);
    if (depth >= 3) add('random', 5);
    if (depth >= 4) { add('genetic-plan', 5); add('genetic-random', 5); }
    return list;
}

/**
 * About how many plan runs a search makes, for the page's estimate of the
 * time a depth takes. Fitted to the eight quick-start plans (§8.7): a climb
 * took 181 to 4,523 runs for 6 to 30 percentages. Rough by design.
 */
export function estimateRuns(genes, search) {
    const oneClimb = Math.max(250, 4 * genes * genes);
    return search.start.startsWith('genetic')
        ? GENETIC_POPULATION * GENETIC_GENERATIONS + oneClimb
        : oneClimb;
}

/**
 * One search, start to finish: begin where `start` says, climb (after a
 * genetic search, for the genetic starts), prune, and hand the routing to the
 * spending solver for its figures.
 *
 * @param {object} plan  { modelAssets, lifeEvents, config }
 * @param {object} [options]
 * @param {number} [options.floor=0]  least to leave at the end, today's dollars
 * @param {'plan'|'near'|'random'|'genetic-plan'|'genetic-random'} [options.start='plan']
 * @param {number} [options.seed=0]
 * @param {(progress: { runs: number, gain: number }) => void} [options.onProgress]
 *   every 25 plan runs; `gain` is the best level so far over the entered one, less 1
 * @returns {object}
 *   start, seed   as given
 *   genes         how many percentages the search could change
 *   values        the routing found, one percentage per gene
 *   changes       [{ phaseIdx, phase, source, kind, target, now, proposed }]
 *   lifeEvents    the plan's life events with the routing written in
 *   best          the spending solver's most-spending column for the routed
 *                 plan, or null when no level keeps the limits
 *   boundBy       what stops the routed plan from spending more
 *   runs          plan runs the search made
 */
export function searchRouting(plan, { floor = 0, start = 'plan', seed = 0, onProgress = null } = {}) {
    const map = routingGenes(plan);
    // Runs are made while the ranker is being built, before there is a level
    // to report against.
    let ranker = null;
    ranker = makeRanker(plan, map, {
        floor,
        onRun: onProgress && ((runs, level) => {
            if (!ranker || runs % 25 !== 0) return;
            onProgress({ runs, gain: ranker.enteredLevel > 0 ? level / ranker.enteredLevel - 1 : 0 });
        }),
    });

    if (map.genes.length > 0) {
        const random = seededRandom(seed);
        if (start === 'near') {
            ranker.startFrom(ranker.entered.map((v) => v + (random() * 2 - 1) * NEAR));
        } else if (start === 'random') {
            ranker.startFrom(map.genes.map(() => random() * 100));
        } else if (start === 'genetic-plan' || start === 'genetic-random') {
            geneticSearch(map, ranker, { seed, start: start === 'genetic-plan' ? 'plan' : 'random' });
        }
        climb(map, ranker);
    }
    const values = map.genes.length > 0 ? prune(map, ranker) : [];

    const changes = [];
    map.genes.forEach((gene, i) => {
        if (values[i] === ranker.entered[i]) return;
        const group = map.groups[gene.group];
        changes.push({
            phaseIdx: group.phaseIdx, phase: group.phase, source: group.source, kind: group.kind,
            target: group.targets[gene.target].name, now: ranker.entered[i], proposed: values[i],
        });
    });

    const lifeEvents = applyRouting(plan, map, values);
    const solved = solveSpending({ ...plan, lifeEvents }, { floor });
    return {
        start, seed, genes: map.genes.length, values, changes, lifeEvents,
        best: solved.best, boundBy: solved.boundBy, runs: ranker.runs + solved.runs,
    };
}

/** Two results within this share of the best count as agreeing with it. */
export const AGREEMENT = 0.01;

/**
 * The finished searches as the list the page shows: best first, searches that
 * found the same routing sharing a row.
 *
 * @param {object[]} results  searchRouting() outputs, in any order
 * @returns {{ rows: object[], searches: number, agreeing: number }}
 *   rows      [{ result, monthly, starts: [{ start, seed }] }], best first
 *   agreeing  how many searches came within 1% of the best, the best included
 */
export function rankSearches(results) {
    const monthly = (r) => r.best?.monthlySpending ?? 0;
    const order = searchesAt(DEPTHS[DEPTHS.length - 1]);
    const place = (r) => order.findIndex((s) => s.start === r.start && s.seed === r.seed);

    const rows = [];
    // Ties go to the earlier search in the depth table, so the list is the
    // same whatever order the workers finished in.
    for (const result of results.slice().sort((a, b) => monthly(b) - monthly(a) || place(a) - place(b))) {
        const key = result.values.join(',');
        const row = rows.find((r) => r.key === key);
        if (row) row.starts.push({ start: result.start, seed: result.seed });
        else rows.push({ key, result, monthly: monthly(result), starts: [{ start: result.start, seed: result.seed }] });
    }
    const top = rows.length ? rows[0].monthly : 0;
    const agreeing = results.filter((r) => top > 0 && monthly(r) >= top * (1 - AGREEMENT)).length;
    return { rows, searches: results.length, agreeing };
}
