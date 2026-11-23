/**
 * projections-view.js — pure headless data, KPI, marker, and chart-config
 * builders for the unified Projections section (Spec 19).
 *
 * Zero DOM or Chart.js runtime dependency so every calculation, bucket window,
 * deflator, tax breakdown, KPI tile, and inflection marker is directly
 * testable in Node (`tests/projections-view.mjs`).
 */

import { MonthsSpan } from './utils/months-span.js';
import { DateInt } from './utils/date-int.js';
import { PriceIndex } from './utils/price-index.js';
import { formatCompactCurrency, formatCurrency } from './utils/html.js';
import { Metric, MetricKind, MetricLabel, MACRO_METRICS, metricKind } from './metric.js';
import { Instrument, InstrumentType } from './instruments/instrument.js';
import { LifeEvent, LifeEventMeta } from './life-event.js';
import {
    AssetGroup, AssetGroupMeta,
    classifyAssetGroup, getAssetChartColor,
    GROUP_ORDER_ACCUMULATE,
} from './asset-groups.js';
import { detectIssues, planExhaustion, monthLabel } from './portfolio-issues.js';
import { FLOW_TREATMENT, FlowKind } from './money-flows.js';
import { EventKind } from './sim-event.js';
import { TraceKind, chainFor, bookedMonthIndex } from './trace.js';

/** SECURE 2.0 / IRS Uniform Lifetime Table RMD starting age (matches js/taxes.js). */
const RMD_START_AGE = 73;

export const ProjectionView = Object.freeze({
    NET_WORTH: 'networth',
    FUNDING:   'funding',
    TAXES:     'taxes',
    METRIC:    'metric',
});

export const DollarMode = Object.freeze({
    REAL:    'real',
    NOMINAL: 'nominal',
});

/** Metrics shown in the "More metrics" selector (excludes Net Worth & Taxes, which have top tabs). */
export const MORE_PROJECTION_METRICS = Object.freeze(
    MACRO_METRICS.filter((m) => m !== Metric.VALUE && m !== Metric.TAXES)
);

const TAX_SERIES_COLORS = Object.freeze({
    federalIncome: '#7C3AED',
    fica:          '#2563EB',
    capitalGains:  '#D97706',
    niit:          '#0D9488',
    propertyTax:   '#64748B',
});

/**
 * Ordered funding waterfall for "Where Spending Comes From" (Spec 19 §5).
 * Income & external inflows cover Spending + Net Taxes first; remaining need is
 * covered by net cash draws from household accounts in natural drawdown order.
 */
const FUNDING_SOURCES = Object.freeze([
    { key: 'salary',    label: 'Salary & Self-Employment', color: '#1D9E75' },
    { key: 'ss',        label: 'Social Security',          color: '#0EA5E9' },
    { key: 'pension',   label: 'Pension',                  color: '#14B8A6' },
    { key: 'yield',     label: 'Dividends & Interest',     color: '#6366F1' },
    { key: 'windfall',  label: 'Windfalls & Other',        color: '#EC4899' },
    { key: 'cash',      label: 'Bank & Cash',              color: '#94A3B8' },
    { key: 'brokerage', label: 'Brokerage & Bonds',        color: '#3B82F6' },
    { key: 'deferred',  label: '401(k) & IRA',             color: '#8B5CF6' },
    { key: 'roth',      label: 'Roth IRA',                 color: '#A855F7' },
    { key: 'other',     label: 'Home Sale & Other',        color: '#D97706' },
]);

const OBLIGATION_SCOPES = new Set([TraceKind.EXPENSE, TraceKind.MORTGAGE, TraceKind.CARRYING_COST]);

const LIABILITY_COLOR = '#E24B4A';
const NET_WORTH_LINE_COLOR = '#111827';
const REAL_COMPANION_COLOR = '#64748B';

// ── Time buckets ──────────────────────────────────────────────────

function bucketLabel(dateInt, combineMonths) {
    if (combineMonths === 3) {
        const q = Math.floor((dateInt.month - 1) / 3) + 1;
        return `Q${q} ${dateInt.year}`;
    }
    if (combineMonths === 6) {
        const h = dateInt.month <= 6 ? 1 : 2;
        return `H${h} ${dateInt.year}`;
    }
    if (combineMonths === 12) {
        return String(dateInt.year);
    }
    return dateInt.toString();
}

/**
 * Partition the portfolio's month range [0..numMonths-1] into contiguous,
 * non-overlapping display buckets aligned with MonthsSpan.
 *
 * When a plan starts mid-year/quarter (offsetMonths > 0), a leading partial
 * bucket [0..offsetMonths-1] is included so flow totals cover 100% of the
 * horizon and the final bucket always ends on `lastDateInt`.
 */
export function buildProjectionBuckets(portfolio) {
    if (!portfolio?.firstDateInt || !portfolio?.lastDateInt) return [];
    const totalMonths = DateInt.diffMonths(portfolio.firstDateInt, portfolio.lastDateInt) + 1;
    if (totalMonths <= 0) return [];

    const span = MonthsSpan.build(portfolio.firstDateInt, portfolio.lastDateInt);
    const birthYear = portfolio.config?.birthYear ?? null;
    const buckets = [];

    const pushBucket = (fromMonth, toMonth) => {
        const startDate = new DateInt(portfolio.firstDateInt.toInt());
        startDate.addMonths(fromMonth);
        const endDate = new DateInt(portfolio.firstDateInt.toInt());
        endDate.addMonths(toMonth);
        buckets.push({
            index: buckets.length,
            label: bucketLabel(startDate, span.combineMonths),
            fromMonth,
            toMonth,
            months: toMonth - fromMonth + 1,
            startDateInt: startDate,
            dateInt: endDate,
            year: endDate.year,
            month: endDate.month,
            age: birthYear != null ? endDate.year - birthYear : null,
        });
    };

    if (span.offsetMonths > 0) {
        pushBucket(0, Math.min(span.offsetMonths - 1, totalMonths - 1));
    }
    for (let m = span.offsetMonths; m < totalMonths; m += span.combineMonths) {
        pushBucket(m, Math.min(m + span.combineMonths - 1, totalMonths - 1));
    }

    return buckets;
}

/** Find the bucket index containing `dateInt`, or -1 if outside the plan horizon. */
export function dateIntToBucketIndex(dateInt, portfolio, buckets) {
    if (!dateInt || !portfolio?.firstDateInt || !buckets?.length) return -1;
    const monthIdx = DateInt.diffMonths(portfolio.firstDateInt, dateInt);
    if (monthIdx < 0) return -1;
    for (const b of buckets) {
        if (monthIdx >= b.fromMonth && monthIdx <= b.toMonth) return b.index;
    }
    return -1;
}

/** Resolve a clicked bucket index back to a DateInt inside [firstDateInt, lastDateInt]. */
export function bucketIndexToDateInt(buckets, index) {
    if (!buckets?.length || index < 0 || index >= buckets.length) return null;
    return buckets[index].dateInt;
}

// ── Metric series aggregation & deflation ─────────────────────────

/**
 * Aggregate one asset's monthly history across all buckets according to
 * `metricKind(metricName)`, optionally deflating into today's dollars via
 * `portfolio.monthlyPriceIndex`.
 */
function aggregateAssetBuckets(asset, metricName, buckets, priceIndex, real) {
    const deflate = (val, m) => (real ? PriceIndex.deflateAt(val, priceIndex, m) : val);

    if (metricName === Metric.NET_WORTH_CHANGE) {
        const valHist = asset.getHistory?.(Metric.VALUE) ?? [];
        return buckets.map((b, idx) => {
            const cur = deflate(valHist[b.toMonth] ?? 0, b.toMonth);
            if (idx === 0) {
                const startVal = deflate(valHist[b.fromMonth] ?? 0, b.fromMonth);
                return cur - startVal;
            }
            const prevMonth = buckets[idx - 1].toMonth;
            const prev = deflate(valHist[prevMonth] ?? 0, prevMonth);
            return cur - prev;
        });
    }

    const hist = asset.getHistory?.(metricName) ?? [];
    const kind = metricKind(metricName);

    return buckets.map((b) => {
        if (!hist.length) return 0;
        const last = hist.length - 1;
        const from = Math.max(0, Math.min(b.fromMonth, last));
        const to = Math.max(0, Math.min(b.toMonth, last));
        if (b.fromMonth > last) return 0;

        if (kind === MetricKind.LEVEL) {
            return deflate(hist[to] ?? 0, to);
        }
        if (kind === MetricKind.RUNNING) {
            const cur = deflate(hist[to] ?? 0, to);
            const prev = from > 0 ? deflate(hist[from - 1] ?? 0, from - 1) : 0;
            return cur - prev;
        }
        let sum = 0;
        for (let m = from; m <= to; m++) {
            sum += deflate(hist[m] ?? 0, m);
        }
        return sum;
    });
}

function sumArrays(arrays, length) {
    const out = new Array(length).fill(0);
    for (const arr of arrays) {
        for (let i = 0; i < length; i++) out[i] += arr[i] ?? 0;
    }
    return out;
}

function hasNonZero(values) {
    return values.some((v) => Math.abs(v) >= 0.5);
}

// ── Drill-down groups ─────────────────────────────────────────────

/**
 * Non-empty asset groups eligible for the inline drill-down pill bar.
 * Balance-sheet metrics (`VALUE`, `NET_WORTH_CHANGE`) exclude flow-only
 * instruments (`Income`, `Expenses`) so flow rates never mix with net worth.
 */
export function getAvailableDrillGroups(portfolio, view, metricName) {
    if (!portfolio?.modelAssets?.length || view === ProjectionView.TAXES || view === ProjectionView.FUNDING) return [];
    const effectiveMetric = view === ProjectionView.NET_WORTH ? Metric.VALUE : metricName;
    const assetsOnly = effectiveMetric === Metric.VALUE || effectiveMetric === Metric.NET_WORTH_CHANGE;

    const seen = new Set();
    for (const asset of portfolio.modelAssets) {
        if (assetsOnly && !InstrumentType.isAsset(asset.instrument)) continue;
        seen.add(classifyAssetGroup(asset.instrument));
    }

    const pills = [{ key: AssetGroup.ALL, label: 'All groups', color: null }];
    for (const groupKey of GROUP_ORDER_ACCUMULATE) {
        if (groupKey === AssetGroup.ALL || groupKey === AssetGroup.TAXES) continue;
        if (!seen.has(groupKey)) continue;
        const meta = AssetGroupMeta.get(groupKey);
        pills.push({
            key: groupKey,
            label: meta?.label ?? groupKey,
            color: meta?.chartColor ?? '#6B7280',
        });
    }
    return pills;
}

// ── Single-pass funding-sources ledger aggregator (Phase 2) ───────

const _fundingCache = new WeakMap();

function fundingCategoryOf(instrument) {
    if (instrument === Instrument.WORKING_INCOME) return 'salary';
    if (instrument === Instrument.RETIREMENT_INCOME) return 'ss';
    if (instrument === Instrument.PENSION) return 'pension';
    if (instrument === Instrument.BANK || instrument === Instrument.CASH) return 'cash';
    if (instrument === Instrument.TAXABLE_EQUITY
        || instrument === Instrument.US_BOND
        || instrument === Instrument.CORP_BOND) return 'brokerage';
    if (instrument === Instrument.FOUR_01K || instrument === Instrument.IRA) return 'deferred';
    if (instrument === Instrument.ROTH_IRA) return 'roth';
    return 'other';
}

function makeRawBucket() {
    return {
        cats: {
            salary: 0, ss: 0, pension: 0, yield: 0, windfall: 0,
            cash: 0, brokerage: 0, deferred: 0, roth: 0, other: 0,
        },
        spent: 0,
        tax: 0,
        refunds: 0,
        unpaid: 0,
    };
}

function finalizeFundingSlots(rawSlots) {
    const n = rawSlots.length;
    const bySource = Object.fromEntries(FUNDING_SOURCES.map((s) => [s.key, new Array(n).fill(0)]));
    const paid = new Array(n).fill(0);
    const unpaid = new Array(n).fill(0);
    const obligations = new Array(n).fill(0);

    for (let bi = 0; bi < n; bi++) {
        const slot = rawSlots[bi];
        // Net household cash outflow actually funded this period (gross spending + taxes - tax refunds).
        const paidNet = Math.max(0, slot.spent + slot.tax - slot.refunds);
        paid[bi] = paidNet;
        unpaid[bi] = slot.unpaid;
        obligations[bi] = paidNet + slot.unpaid;

        // Income-first waterfall: allocate paidNet across positive net cash sources.
        // Because internal account-to-account transfers cancel identically,
        // sum(slot.cats) === slot.spent + slot.tax - slot.refunds, so positive
        // contributors always cover paidNet to the exact cent.
        let remaining = paidNet;
        for (const { key } of FUNDING_SOURCES) {
            if (remaining <= 0) break;
            const avail = Math.max(0, slot.cats[key] ?? 0);
            if (avail <= 0) continue;
            const used = Math.min(avail, remaining);
            bySource[key][bi] = used;
            remaining -= used;
        }
    }

    return { bySource, paid, unpaid, obligations };
}

/**
 * Single-pass ledger scan computing both Nominal and Today's $ funding sources
 * across all projection buckets, memoized per Portfolio via WeakMap.
 *
 * Uses `FLOW_TREATMENT` from `money-flows.js` (throwing on any unknown
 * `EventType` so money can never quietly disappear).
 */
export function aggregateFundingLedger(portfolio, buckets) {
    if (!portfolio?.firstDateInt || !buckets?.length) {
        const empty = finalizeFundingSlots([]);
        return { nominal: empty, real: empty };
    }
    const cached = _fundingCache.get(portfolio);
    if (cached && cached.bucketCount === buckets.length) return cached;

    const first = portfolio.firstDateInt;
    const scopes = portfolio.traceScopes ?? [];
    const priceIndex = portfolio.monthlyPriceIndex ?? [];
    const lastMonth = buckets[buckets.length - 1].toMonth;
    const monthToBucket = new Int32Array(lastMonth + 1);
    for (const b of buckets) {
        for (let m = b.fromMonth; m <= b.toMonth; m++) monthToBucket[m] = b.index;
    }

    const nomSlots = buckets.map(makeRawBucket);
    const realSlots = buckets.map(makeRawBucket);
    const draws = new Map(); // traceId → FlowKind
    const spills = [];
    const unpaids = [];

    const addToBoth = (bi, m, fn) => {
        fn(nomSlots[bi], 1);
        const factor = priceIndex.length ? PriceIndex.deflateAt(1, priceIndex, m) : 1;
        fn(realSlots[bi], factor);
    };

    for (const asset of portfolio.modelAssets) {
        const cat = fundingCategoryOf(asset.instrument);
        for (const e of (asset.events ?? [])) {
            const treatment = FLOW_TREATMENT[e.type];
            if (!treatment) {
                throw new Error(
                    `projections-view: EventType "${e.type}" has no flow treatment in FLOW_TREATMENT.`);
            }
            if (treatment === 'excluded') continue;
            if (e.kind !== EventKind.CASH && treatment !== 'unpaid') continue;
            const amt = e.amount.amount;
            if (amt === 0 && treatment !== 'move' && treatment !== 'tax' && treatment !== 'oneTime') continue;

            const m = bookedMonthIndex(e, first, scopes);
            if (m < 0 || m > lastMonth) continue;
            const bi = monthToBucket[m];
            const chain = e.traceId != null ? chainFor(e.traceId, scopes) : [];
            const d = e.data ?? {};

            switch (treatment) {
                case 'move': {
                    let obligation = null;
                    for (const s of chain) if (OBLIGATION_SCOPES.has(s.kind)) obligation = s;
                    const propTax = d.label === 'property tax'
                        || (obligation?.kind === TraceKind.CARRYING_COST && / property tax$/.test(obligation.label));
                    const kind = propTax ? FlowKind.TAX : obligation ? FlowKind.SPENT : FlowKind.ACCOUNTS;
                    if (e.traceId != null && amt <= 0) draws.set(e.traceId, kind);

                    if (amt < 0) {
                        const mag = -amt;
                        addToBoth(bi, m, (slot, f) => {
                            const v = mag * f;
                            slot.cats[cat] += v;
                            if (kind === FlowKind.SPENT) slot.spent += v;
                            else if (kind === FlowKind.TAX) slot.tax += v;
                        });
                    } else if (amt > 0 && kind === FlowKind.ACCOUNTS) {
                        // Internal move credit into a household account (cancels debit on sender).
                        addToBoth(bi, m, (slot, f) => { slot.cats[cat] -= amt * f; });
                    }
                    break;
                }
                case 'spillover':
                    if (amt < 0) spills.push({ bi, m, cat, traceId: e.traceId, amt: -amt });
                    break;
                case 'provision':
                    // Reclassifies the capital-gains tax share of a gross-up from spent to tax.
                    addToBoth(bi, m, (slot, f) => {
                        slot.spent += amt * f; // amt is negative
                        slot.tax += -amt * f;
                    });
                    break;
                case 'tax':
                    if (amt > 0) {
                        // Tax refund credited to an account: offsets tax outflow and reduces net draw on that account.
                        addToBoth(bi, m, (slot, f) => {
                            const v = amt * f;
                            slot.refunds += v;
                            slot.cats[cat] -= v;
                        });
                    } else {
                        if (e.traceId != null) draws.set(e.traceId, FlowKind.TAX);
                        const mag = -amt;
                        addToBoth(bi, m, (slot, f) => {
                            const v = mag * f;
                            slot.cats[cat] += v;
                            slot.tax += v;
                        });
                    }
                    break;
                case 'yield':
                    // External dividend/interest arriving into an account.
                    addToBoth(bi, m, (slot, f) => {
                        const v = amt * f;
                        slot.cats.yield += v;
                        slot.cats[cat] -= v;
                    });
                    break;
                case 'oneTime':
                    if (amt > 0) {
                        addToBoth(bi, m, (slot, f) => {
                            const v = amt * f;
                            slot.cats.windfall += v;
                            slot.cats[cat] -= v;
                        });
                    } else {
                        if (e.traceId != null) draws.set(e.traceId, FlowKind.SPENT);
                        const mag = -amt;
                        addToBoth(bi, m, (slot, f) => {
                            const v = mag * f;
                            slot.cats[cat] += v;
                            slot.spent += v;
                        });
                    }
                    break;
                case 'unpaid':
                    unpaids.push({ bi, m, chain, traceId: e.traceId, amt: -amt });
                    break;
            }
        }
    }

    for (const sp of spills) {
        const kind = draws.get(sp.traceId);
        addToBoth(sp.bi, sp.m, (slot, f) => {
            const v = sp.amt * f;
            slot.cats[sp.cat] += v;
            if (kind === FlowKind.SPENT) slot.spent += v;
            else if (kind === FlowKind.TAX) slot.tax += v;
        });
    }

    for (const u of unpaids) {
        const drawKind = draws.get(u.traceId);
        const isObligation = u.chain.some((s) => s.kind === TraceKind.TAX_TRUE_UP || OBLIGATION_SCOPES.has(s.kind))
            || drawKind === FlowKind.SPENT
            || drawKind === FlowKind.TAX;
        if (!isObligation) continue;
        addToBoth(u.bi, u.m, (slot, f) => { slot.unpaid += u.amt * f; });
    }

    const result = {
        bucketCount: buckets.length,
        nominal: finalizeFundingSlots(nomSlots),
        real: finalizeFundingSlots(realSlots),
    };
    _fundingCache.set(portfolio, result);
    return result;
}

// ── Inflection-point markers ──────────────────────────────────────

/**
 * Build milestone and timeline-cursor vertical markers mapped onto `buckets`.
 * Milestones landing on the same bucket merge cleanly into one label.
 */
export function buildProjectionMarkers(portfolio, buckets, {
    lifeEvents = null,
    startAge = null,
    retirementAge = null,
    cursorDateInt = null,
    issues = null,
} = {}) {
    if (!portfolio?.firstDateInt || !buckets?.length) return [];
    const events = lifeEvents ?? portfolio.lifeEvents ?? [];
    const cfg = portfolio.config;
    const effectiveStartAge = startAge ?? cfg?.startAge ?? null;
    const effectiveRetireAge = retirementAge ?? cfg?.retirementAge ?? null;

    // Collect milestones by bucket index so co-located events merge labels cleanly.
    const byBucket = new Map();
    const addMilestone = (dateInt, label, color, priority = 1) => {
        const idx = dateIntToBucketIndex(dateInt, portfolio, buckets);
        if (idx < 0) return;
        // Skip milestones pinned to bucket 0 if it's already in effect from day 1
        // (except explicit Runs Out).
        if (idx === 0 && priority !== 0) return;
        const existing = byBucket.get(idx);
        if (!existing) {
            byBucket.set(idx, { index: idx, labels: [label], color, priority });
        } else {
            if (!existing.labels.includes(label)) existing.labels.push(label);
            if (priority < existing.priority) {
                existing.color = color;
                existing.priority = priority;
            }
        }
    };

    // 1. Retire life event
    for (const ev of events) {
        if (ev.type !== LifeEvent.RETIRE) continue;
        if (effectiveStartAge != null && effectiveRetireAge != null && effectiveStartAge >= effectiveRetireAge) continue;
        const meta = LifeEventMeta.get(ev.type);
        addMilestone(ev.triggerDateInt, 'Retire', meta?.colorAccent ?? '#534AB7', 1);
    }

    // 2. Medicare / Age 65 (only when a pre-65 marketplace health plan ends before plan end)
    const healthPlan = portfolio.modelAssets.find((a) => InstrumentType.isHealthInsurance(a.instrument));
    if (healthPlan?.effectiveFinishDateInt && healthPlan.effectiveFinishDateInt.toInt() < portfolio.lastDateInt.toInt()) {
        const medicareDate = new DateInt(healthPlan.effectiveFinishDateInt.toInt());
        medicareDate.addMonths(1);
        addMilestone(medicareDate, 'Medicare 65', '#0284C7', 2);
    }

    // 3. Earliest Social Security start (if after plan start)
    let earliestSS = null;
    for (const a of portfolio.modelAssets) {
        if (a.instrument !== Instrument.RETIREMENT_INCOME) continue;
        if (!earliestSS || a.startDateInt.toInt() < earliestSS.toInt()) earliestSS = a.startDateInt;
    }
    if (earliestSS && earliestSS.toInt() > portfolio.firstDateInt.toInt()) {
        addMilestone(earliestSS, 'SS', '#059669', 2);
    }

    // 4. RMDs start (age 73) — only if holding a tax-deferred IRA or 401(k)
    const hasTaxDeferred = portfolio.modelAssets.some((a) => InstrumentType.isTaxDeferred(a.instrument));
    if (hasTaxDeferred && cfg?.birthYear != null) {
        const rmdDate = DateInt.from(cfg.birthYear + RMD_START_AGE, 1);
        if (rmdDate.toInt() > portfolio.firstDateInt.toInt() && rmdDate.toInt() <= portfolio.lastDateInt.toInt()) {
            addMilestone(rmdDate, `RMDs ${RMD_START_AGE}`, '#D97706', 3);
        }
    }

    // 5. Runs Out (first exhaustion month, if any — same detector as Outcome strip)
    const foundIssues = issues ?? detectIssues(portfolio);
    const exhaustion = planExhaustion(foundIssues);
    if (exhaustion?.firstDateInt) {
        addMilestone(exhaustion.firstDateInt, 'Runs out', '#DC2626', 0);
    }

    const markers = [...byBucket.values()]
        .sort((a, b) => a.index - b.index)
        .map((m) => ({
            index: m.index,
            color: m.color,
            label: m.labels.join(' / '),
        }));

    // 6. Active timeline cursor (always drawn last so it stays prominent)
    if (cursorDateInt) {
        const idx = dateIntToBucketIndex(cursorDateInt, portfolio, buckets);
        if (idx >= 0) {
            markers.push({ index: idx, color: '#111827', label: '\u25BC', isCursor: true });
        }
    }

    return markers;
}

// ── KPI computation ───────────────────────────────────────────────

function findRetirementBucketIndex(portfolio, buckets, lifeEvents, retirementAge) {
    const events = lifeEvents ?? portfolio.lifeEvents ?? [];
    const retEv = events.find((e) => e.type === LifeEvent.RETIRE);
    if (retEv?.triggerDateInt) {
        const idx = dateIntToBucketIndex(retEv.triggerDateInt, portfolio, buckets);
        if (idx >= 0) return idx;
    }
    const birthYear = portfolio.config?.birthYear;
    const retAge = retirementAge ?? portfolio.config?.retirementAge;
    if (birthYear != null && retAge != null) {
        const idx = dateIntToBucketIndex(DateInt.from(birthYear + retAge, 1), portfolio, buckets);
        if (idx >= 0) return idx;
    }
    return 0;
}

/**
 * Compute Taxable / Tax-Deferred / Tax-Free investable mix at a target month index.
 * Excludes real estate and liabilities. Returns null if investable assets <= 0.
 */
export function computeInvestableTaxMix(portfolio, monthIndex) {
    let taxable = 0, deferred = 0, taxFree = 0;
    for (const a of portfolio.modelAssets) {
        const inst = a.instrument;
        if (!InstrumentType.isAsset(inst)) continue;
        if (inst === Instrument.REAL_ESTATE || inst === Instrument.MORTGAGE || inst === Instrument.DEBT) continue;
        const h = a.getHistory?.(Metric.VALUE) ?? [];
        const v = Math.max(0, h[Math.min(monthIndex, h.length - 1)] ?? 0);
        if (InstrumentType.isTaxDeferred(inst)) deferred += v;
        else if (InstrumentType.isTaxFree(inst)) taxFree += v;
        else taxable += v;
    }
    const total = taxable + deferred + taxFree;
    if (total <= 0) return null;
    const pctTaxable = Math.round((taxable / total) * 100);
    const pctDeferred = Math.round((deferred / total) * 100);
    const pctTaxFree = Math.max(0, 100 - pctTaxable - pctDeferred);
    return { pctTaxable, pctDeferred, pctTaxFree, total };
}

function peakOf(values, buckets) {
    let idx = 0, best = -Infinity;
    for (let i = 0; i < values.length; i++) {
        if (values[i] > best) { best = values[i]; idx = i; }
    }
    return { index: idx, value: best, bucket: buckets[idx] };
}

function fmtBucketSub(b) {
    if (!b) return '';
    return b.age != null ? `${b.year} · Age ${b.age}` : `${b.year}`;
}

function computeKPIs(portfolio, buckets, {
    view, metricName, drillGroup, dollarMode, totals, lifeEvents, retirementAge,
    fundingSlice = null, issues = null,
}) {
    if (!buckets.length) return [];
    const modeTag = dollarMode === DollarMode.REAL ? "today's $" : 'nominal';
    const retIdx = findRetirementBucketIndex(portfolio, buckets, lifeEvents, retirementAge);
    const retBucket = buckets[retIdx];
    const endBucket = buckets[buckets.length - 1];
    const peak = peakOf(totals, buckets);

    if (view === ProjectionView.NET_WORTH) {
        if (drillGroup !== AssetGroup.ALL) {
            const startVal = totals[0] ?? 0;
            const retVal = totals[retIdx] ?? 0;
            const endVal = totals[totals.length - 1] ?? 0;
            return [
                { label: `Start (${buckets[0].year})`, value: formatCompactCurrency(startVal), sub: modeTag },
                { label: retBucket.age != null ? `At Retirement (${retBucket.age})` : 'At Retirement', value: formatCompactCurrency(retVal), sub: modeTag },
                { label: 'Peak', value: formatCompactCurrency(peak.value), sub: fmtBucketSub(peak.bucket) },
                { label: endBucket.age != null ? `At End (Age ${endBucket.age})` : `At End (${endBucket.year})`, value: formatCompactCurrency(endVal), sub: modeTag },
            ];
        }
        const mix = computeInvestableTaxMix(portfolio, retBucket.toMonth);
        const mixTile = mix
            ? {
                label: retIdx === 0 ? 'Investable Tax Mix' : 'Retirement Tax Mix',
                value: `${mix.pctTaxable}% / ${mix.pctDeferred}% / ${mix.pctTaxFree}%`,
                sub: 'Taxable · Def · Roth',
            }
            : { label: 'Retirement Tax Mix', value: '—', sub: 'No investable assets' };

        return [
            { label: retBucket.age != null ? `At Retirement (${retBucket.age})` : 'At Retirement', value: formatCompactCurrency(totals[retIdx] ?? 0), sub: modeTag },
            { label: 'Peak Net Worth', value: formatCompactCurrency(peak.value), sub: fmtBucketSub(peak.bucket) },
            { label: endBucket.age != null ? `At End (Age ${endBucket.age})` : `At End (${endBucket.year})`, value: formatCompactCurrency(totals[totals.length - 1] ?? 0), sub: modeTag },
            mixTile,
        ];
    }

    if (view === ProjectionView.TAXES) {
        const lifetimeTaxes = totals.reduce((s, v) => s + v, 0);
        const retBuckets = buckets.slice(retIdx);
        const retMonths = retBuckets.reduce((s, b) => s + b.months, 0);
        const retTotal = totals.slice(retIdx).reduce((s, v) => s + v, 0);
        const retAnnualAvg = retMonths > 0 ? (retTotal * 12) / retMonths : 0;

        // Effective lifetime rate: total taxes paid / total household income (same dollar mode).
        const real = dollarMode === DollarMode.REAL;
        const priceIndex = portfolio.monthlyPriceIndex ?? [];
        const pkgs = portfolio.monthlyPackages ?? [];
        let lifetimeIncome = 0;
        for (let m = 0; m < pkgs.length; m++) {
            const inc = pkgs[m].totalIncome().amount;
            lifetimeIncome += real ? PriceIndex.deflateAt(inc, priceIndex, m) : inc;
        }
        const effRate = lifetimeIncome > 0 ? (lifetimeTaxes / lifetimeIncome) * 100 : null;

        return [
            { label: 'Lifetime Taxes', value: formatCompactCurrency(lifetimeTaxes), sub: modeTag },
            { label: 'Peak Tax Period', value: formatCompactCurrency(peak.value), sub: fmtBucketSub(peak.bucket) },
            { label: 'Retirement Avg', value: `${formatCompactCurrency(retAnnualAvg)}/yr`, sub: modeTag },
            { label: 'Effective Rate', value: effRate != null ? `${effRate.toFixed(1)}%` : '—', sub: 'Lifetime taxes ÷ income' },
        ];
    }

    if (view === ProjectionView.FUNDING && fundingSlice) {
        const { bySource, paid, unpaid, obligations } = fundingSlice;
        const retBuckets = buckets.slice(retIdx);
        const retMonths = retBuckets.reduce((s, b) => s + b.months, 0);
        const retObl = obligations.slice(retIdx).reduce((s, v) => s + v, 0);
        const avgRetOutflow = retMonths > 0 ? (retObl * 12) / retMonths : 0;

        // Guaranteed income share in retirement (Social Security + Pension)
        const retGuaranteed = bySource.ss.slice(retIdx).reduce((s, v) => s + v, 0)
            + bySource.pension.slice(retIdx).reduce((s, v) => s + v, 0);
        const guaranteedPct = retObl > 0 ? Math.round((retGuaranteed / retObl) * 100) : 0;

        // First RMD / tax-deferred draw at RMD age (or Peak Outflow if no tax-deferred account)
        const rmdBucketIdx = buckets.findIndex((b) => b.age != null && b.age >= RMD_START_AGE);
        const hasDeferred = portfolio.modelAssets.some((a) => InstrumentType.isTaxDeferred(a.instrument));
        const peakObl = peakOf(obligations, buckets);
        const thirdTile = hasDeferred && rmdBucketIdx >= 0 && (bySource.deferred[rmdBucketIdx] ?? 0) > 0.5
            ? {
                label: `Age ${RMD_START_AGE} IRA/401(k)`,
                value: formatCompactCurrency(bySource.deferred[rmdBucketIdx]),
                sub: fmtBucketSub(buckets[rmdBucketIdx]),
            }
            : {
                label: 'Peak Outflow',
                value: formatCompactCurrency(peakObl.value),
                sub: fmtBucketSub(peakObl.bucket),
            };

        const totalPaid = paid.reduce((s, v) => s + v, 0);
        const totalUnpaid = unpaid.reduce((s, v) => s + v, 0);
        const totalObl = totalPaid + totalUnpaid;
        const coveragePct = totalObl > 0 ? Math.floor((totalPaid / totalObl) * 100) : 100;
        const exhaustion = planExhaustion(issues ?? detectIssues(portfolio));
        const firstUnpaidIdx = unpaid.findIndex((v) => v >= 1);
        const coverageSub = totalUnpaid < 1
            ? 'never runs out'
            : exhaustion?.firstDateInt
                ? `shortfall from ${monthLabel(exhaustion.firstDateInt)}`
                : firstUnpaidIdx >= 0
                    ? `shortfall from ${buckets[firstUnpaidIdx].year}`
                    : 'has shortfall';

        return [
            { label: 'Avg Retire Outflow', value: `${formatCompactCurrency(avgRetOutflow)}/yr`, sub: modeTag },
            { label: 'Guaranteed Share', value: `${guaranteedPct}%`, sub: 'SS & Pension in retire' },
            thirdTile,
            { label: 'Coverage', value: totalUnpaid < 1 ? '100%' : `${coveragePct}%`, sub: coverageSub },
        ];
    }

    // Generic metric view (More metrics)
    const kind = metricKind(metricName);
    const label = MetricLabel[metricName] ?? metricName;
    if (kind === MetricKind.LEVEL) {
        return [
            { label: `Start (${buckets[0].year})`, value: formatCompactCurrency(totals[0] ?? 0), sub: modeTag },
            { label: retBucket.age != null ? `At Retirement (${retBucket.age})` : 'At Retirement', value: formatCompactCurrency(totals[retIdx] ?? 0), sub: modeTag },
            { label: `Peak ${label}`, value: formatCompactCurrency(peak.value), sub: fmtBucketSub(peak.bucket) },
            { label: endBucket.age != null ? `At End (Age ${endBucket.age})` : `At End (${endBucket.year})`, value: formatCompactCurrency(totals[totals.length - 1] ?? 0), sub: modeTag },
        ];
    }

    const lifetime = totals.reduce((s, v) => s + v, 0);
    const retMonths = buckets.slice(retIdx).reduce((s, b) => s + b.months, 0);
    const retTotal = totals.slice(retIdx).reduce((s, v) => s + v, 0);
    const retAnnualAvg = retMonths > 0 ? (retTotal * 12) / retMonths : 0;
    return [
        { label: `Lifetime ${label}`, value: formatCompactCurrency(lifetime), sub: modeTag },
        { label: 'Peak Period', value: formatCompactCurrency(peak.value), sub: fmtBucketSub(peak.bucket) },
        { label: 'Retirement Avg', value: `${formatCompactCurrency(retAnnualAvg)}/yr`, sub: modeTag },
        { label: endBucket.age != null ? `Final Period (${endBucket.age})` : `Final (${endBucket.year})`, value: formatCompactCurrency(totals[totals.length - 1] ?? 0), sub: modeTag },
    ];
}

// ── Main projection data builder ──────────────────────────────────

/**
 * Build the complete headless projection dataset, KPIs, drill-down pills, and
 * inflection markers for the unified Projections card.
 */
export function buildProjectionData(portfolio, {
    view = ProjectionView.NET_WORTH,
    metricName = Metric.VALUE,
    drillGroup = AssetGroup.ALL,
    dollarMode = DollarMode.REAL,
    lifeEvents = null,
    startAge = null,
    retirementAge = null,
    cursorDateInt = null,
    issues = null,
} = {}) {
    if (!portfolio?.firstDateInt || !portfolio?.modelAssets?.length) {
        return {
            empty: true,
            buckets: [],
            labels: [],
            datasets: [],
            totals: [],
            realTotals: null,
            obligations: null,
            unpaid: null,
            markers: [],
            kpis: [],
            drillGroups: [],
            view,
            metricName,
            drillGroup,
            dollarMode,
        };
    }

    const buckets = buildProjectionBuckets(portfolio);
    const labels = buckets.map((b) => b.label);
    const priceIndex = portfolio.monthlyPriceIndex ?? [];
    const real = dollarMode === DollarMode.REAL;
    const drillGroups = getAvailableDrillGroups(portfolio, view, metricName);
    const validDrill = drillGroups.some((g) => g.key === drillGroup) ? drillGroup : AssetGroup.ALL;

    const barDatasets = [];
    let overlayLine = null;
    let companionLine = null;
    let fundingSlice = null;

    if (view === ProjectionView.FUNDING) {
        const ledger = aggregateFundingLedger(portfolio, buckets);
        fundingSlice = real ? ledger.real : ledger.nominal;
        for (const src of FUNDING_SOURCES) {
            const data = fundingSlice.bySource[src.key];
            if (!hasNonZero(data)) continue;
            barDatasets.push({
                type: 'bar',
                label: src.label,
                data,
                backgroundColor: src.color,
                stack: 'bars',
                order: 2,
            });
        }
        overlayLine = {
            type: 'line',
            label: 'Spending + Taxes',
            data: fundingSlice.obligations,
            borderColor: NET_WORTH_LINE_COLOR,
            backgroundColor: NET_WORTH_LINE_COLOR,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0.15,
            fill: false,
            stack: 'overlay-obligations',
            order: 0,
            isOverlayLine: true,
        };
    } else if (view === ProjectionView.TAXES) {
        const pkgs = portfolio.monthlyPackages ?? [];
        const deflate = (val, m) => (real ? PriceIndex.deflateAt(val, priceIndex, m) : val);
        const defs = [
            {
                key: 'federalIncome',
                label: 'Federal Income',
                color: TAX_SERIES_COLORS.federalIncome,
                pick: (p) => -(p.incomeTax.amount + p.estimatedTaxes.amount + p.taxTrueUp.amount + p.ptcReconciliation.amount),
            },
            {
                key: 'fica',
                label: 'FICA / Medicare',
                color: TAX_SERIES_COLORS.fica,
                pick: (p) => -(p.socialSecurityTax.amount + p.medicareTax.amount),
            },
            {
                key: 'capitalGains',
                label: 'Capital Gains',
                color: TAX_SERIES_COLORS.capitalGains,
                pick: (p) => -p.longTermCapitalGainsTax.amount,
            },
            {
                key: 'niit',
                label: 'NIIT',
                color: TAX_SERIES_COLORS.niit,
                pick: (p) => -p.niit.amount,
            },
            {
                key: 'propertyTax',
                label: 'Property Tax',
                color: TAX_SERIES_COLORS.propertyTax,
                pick: (p) => -p.propertyTaxes.amount,
            },
        ];

        for (const def of defs) {
            const data = buckets.map((b) => {
                let sum = 0;
                const to = Math.min(b.toMonth, pkgs.length - 1);
                for (let m = b.fromMonth; m <= to; m++) {
                    sum += deflate(def.pick(pkgs[m]), m);
                }
                return sum;
            });
            if (hasNonZero(data)) {
                barDatasets.push({
                    type: 'bar',
                    label: def.label,
                    data,
                    backgroundColor: def.color,
                    stack: 'bars',
                    order: 2,
                });
            }
        }
    } else {
        const effectiveMetric = view === ProjectionView.NET_WORTH ? Metric.VALUE : metricName;
        const assetsOnly = effectiveMetric === Metric.VALUE || effectiveMetric === Metric.NET_WORTH_CHANGE;
        const eligibleAssets = portfolio.modelAssets.filter((a) => !assetsOnly || InstrumentType.isAsset(a.instrument));

        if (validDrill === AssetGroup.ALL) {
            if (view === ProjectionView.NET_WORTH) {
                // Separate positive asset groups from liabilities so mortgages/debts
                // plot cleanly below $0 instead of cancelling out Real Estate visually.
                const positiveByGroup = new Map();
                const liabilities = [];
                for (const asset of eligibleAssets) {
                    if (asset.instrument === Instrument.MORTGAGE || asset.instrument === Instrument.DEBT) {
                        liabilities.push(asset);
                        continue;
                    }
                    const gKey = classifyAssetGroup(asset.instrument);
                    if (!positiveByGroup.has(gKey)) positiveByGroup.set(gKey, []);
                    positiveByGroup.get(gKey).push(asset);
                }

                for (const groupKey of GROUP_ORDER_ACCUMULATE) {
                    if (groupKey === AssetGroup.ALL || groupKey === AssetGroup.TAXES) continue;
                    const assets = positiveByGroup.get(groupKey);
                    if (!assets?.length) continue;
                    const meta = AssetGroupMeta.get(groupKey);
                    const data = sumArrays(
                        assets.map((a) => aggregateAssetBuckets(a, Metric.VALUE, buckets, priceIndex, real)),
                        buckets.length
                    );
                    if (hasNonZero(data)) {
                        barDatasets.push({
                            type: 'bar',
                            label: meta?.label ?? groupKey,
                            data,
                            backgroundColor: meta?.chartColor ?? '#6B7280',
                            stack: 'bars',
                            order: 2,
                        });
                    }
                }

                if (liabilities.length) {
                    const data = sumArrays(
                        liabilities.map((a) => aggregateAssetBuckets(a, Metric.VALUE, buckets, priceIndex, real)),
                        buckets.length
                    );
                    if (hasNonZero(data)) {
                        barDatasets.push({
                            type: 'bar',
                            label: liabilities.length === 1 ? liabilities[0].displayName : 'Mortgage & Debt',
                            data,
                            backgroundColor: LIABILITY_COLOR,
                            stack: 'bars',
                            order: 2,
                        });
                    }
                }
            } else {
                const byGroup = new Map();
                for (const asset of eligibleAssets) {
                    const gKey = classifyAssetGroup(asset.instrument);
                    if (!byGroup.has(gKey)) byGroup.set(gKey, []);
                    byGroup.get(gKey).push(asset);
                }
                for (const groupKey of GROUP_ORDER_ACCUMULATE) {
                    if (groupKey === AssetGroup.ALL || groupKey === AssetGroup.TAXES) continue;
                    const assets = byGroup.get(groupKey);
                    if (!assets?.length) continue;
                    const meta = AssetGroupMeta.get(groupKey);
                    const data = sumArrays(
                        assets.map((a) => aggregateAssetBuckets(a, effectiveMetric, buckets, priceIndex, real)),
                        buckets.length
                    );
                    if (hasNonZero(data)) {
                        barDatasets.push({
                            type: 'bar',
                            label: meta?.label ?? groupKey,
                            data,
                            backgroundColor: meta?.chartColor ?? '#6B7280',
                            stack: 'bars',
                            order: 2,
                        });
                    }
                }
            }
        } else {
            // Drilled into one specific asset group → individual accounts
            const groupAssets = eligibleAssets.filter((a) => classifyAssetGroup(a.instrument) === validDrill);
            for (const asset of groupAssets) {
                const data = aggregateAssetBuckets(asset, effectiveMetric, buckets, priceIndex, real);
                if (!hasNonZero(data)) continue;
                const isLiability = asset.instrument === Instrument.MORTGAGE || asset.instrument === Instrument.DEBT;
                barDatasets.push({
                    type: 'bar',
                    label: asset.displayName,
                    data,
                    backgroundColor: isLiability ? LIABILITY_COLOR : getAssetChartColor(asset.instrument),
                    stack: 'bars',
                    order: 2,
                });
            }
        }
    }

    const totals = sumArrays(barDatasets.map((d) => d.data), buckets.length);
    let realTotals = null;

    if (view === ProjectionView.NET_WORTH && barDatasets.length > 0) {
        const hasNegativeBars = barDatasets.some((d) => d.data.some((v) => v < -0.5));
        if (validDrill === AssetGroup.ALL || hasNegativeBars) {
            overlayLine = {
                type: 'line',
                label: validDrill === AssetGroup.REAL_ESTATE ? 'Home Equity' : 'Net Worth',
                data: totals,
                borderColor: NET_WORTH_LINE_COLOR,
                backgroundColor: NET_WORTH_LINE_COLOR,
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                tension: 0.15,
                fill: false,
                stack: 'overlay-networth',
                order: 0,
                isOverlayLine: true,
            };
        }
        if (validDrill === AssetGroup.ALL && dollarMode === DollarMode.NOMINAL && priceIndex.length) {
            realTotals = totals.map((v, i) => PriceIndex.deflateAt(v, priceIndex, buckets[i].toMonth));
            companionLine = {
                type: 'line',
                label: "Today's $",
                data: realTotals,
                borderColor: REAL_COMPANION_COLOR,
                backgroundColor: REAL_COMPANION_COLOR,
                borderWidth: 1.75,
                borderDash: [5, 4],
                pointRadius: 0,
                pointHoverRadius: 3,
                tension: 0.15,
                fill: false,
                stack: 'overlay-real',
                order: 1,
                isOverlayLine: true,
            };
        }
    }

    const datasets = [...barDatasets];
    if (overlayLine) datasets.push(overlayLine);
    if (companionLine) datasets.push(companionLine);

    const markers = buildProjectionMarkers(portfolio, buckets, {
        lifeEvents, startAge, retirementAge, cursorDateInt, issues,
    });

    const kpis = computeKPIs(portfolio, buckets, {
        view, metricName, drillGroup: validDrill, dollarMode, totals, lifeEvents, retirementAge,
        fundingSlice, issues,
    });

    return {
        empty: false,
        buckets,
        labels,
        datasets,
        barDatasets,
        overlayLine,
        companionLine,
        totals,
        realTotals,
        obligations: fundingSlice?.obligations ?? null,
        unpaid: fundingSlice?.unpaid ?? null,
        markers,
        kpis,
        drillGroups,
        view,
        metricName,
        drillGroup: validDrill,
        dollarMode,
    };
}

// ── Chart.js config builder ───────────────────────────────────────

/**
 * Build the Chart.js configuration for a `buildProjectionData` result, with
 * index-mode stacked tooltips, total footer, and click-to-jump support.
 */
export function buildProjectionChartConfig(projData, { onBucketClick = null } = {}) {
    if (!projData || projData.empty || !projData.datasets.length) {
        return {
            type: 'bar',
            data: { labels: projData?.labels ?? [], datasets: [] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    title: {
                        display: true,
                        text: projData?.empty ? 'Add an asset to see data' : 'No data for this view',
                        color: '#9ca3af',
                        font: { size: 13, weight: 'normal' },
                    },
                    dateMarkers: { markers: projData?.markers ?? [] },
                },
                scales: { x: { stacked: true }, y: { stacked: true } },
            },
        };
    }

    const { buckets, labels, datasets, totals, realTotals, obligations, unpaid, markers, view, drillGroup, dollarMode } = projData;
    const totalLabel = view === ProjectionView.NET_WORTH
        ? (drillGroup === AssetGroup.REAL_ESTATE ? 'Home Equity' : 'Net Worth')
        : view === ProjectionView.FUNDING
            ? 'Spending + Taxes'
            : 'Total';

    return {
        type: 'bar',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { top: 26, right: 6, bottom: 0, left: 0 } },
            interaction: { mode: 'index', intersect: false },
            onClick: (_event, elements, chart) => {
                if (!onBucketClick) return;
                let idx = elements?.[0]?.index;
                if (idx == null && chart?.scales?.x && _event?.x != null) {
                    const candidate = chart.scales.x.getValueForPixel(_event.x);
                    if (Number.isInteger(candidate) && candidate >= 0 && candidate < buckets.length) {
                        idx = candidate;
                    }
                }
                if (idx != null && buckets[idx]) {
                    onBucketClick(buckets[idx], idx);
                }
            },
            plugins: {
                title: { display: false },
                legend: {
                    position: 'bottom',
                    labels: { boxWidth: 12, padding: 14, font: { size: 11 } },
                },
                dateMarkers: { markers },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    filter: (item) => {
                        if (item.dataset.isOverlayLine) return false;
                        return Math.abs(item.parsed.y ?? 0) >= 0.5;
                    },
                    itemSort: (a, b) => Math.abs(b.parsed.y ?? 0) - Math.abs(a.parsed.y ?? 0),
                    callbacks: {
                        title: (items) => {
                            const idx = items?.[0]?.dataIndex;
                            const b = idx != null ? buckets[idx] : null;
                            if (!b) return '';
                            return b.age != null ? `${b.label} · Age ${b.age}` : b.label;
                        },
                        label: (ctx) => `${ctx.dataset.label}: ${formatCurrency(ctx.parsed.y)}`,
                        footer: (items) => {
                            const idx = items?.[0]?.dataIndex;
                            if (idx == null) return '';
                            if (view === ProjectionView.FUNDING && unpaid && obligations) {
                                const gap = unpaid[idx] ?? 0;
                                if (gap >= 0.5) {
                                    return [
                                        `Funded: ${formatCurrency(totals[idx] ?? 0)}`,
                                        `Spending + Taxes: ${formatCurrency(obligations[idx] ?? 0)}`,
                                        `Unpaid shortfall: ${formatCurrency(gap)}`,
                                    ];
                                }
                                return [`Spending + Taxes: ${formatCurrency(obligations[idx] ?? 0)}`];
                            }
                            const lines = [`${totalLabel}: ${formatCurrency(totals[idx] ?? 0)}`];
                            if (view === ProjectionView.NET_WORTH && dollarMode === DollarMode.NOMINAL && realTotals) {
                                lines.push(`In today's $: ${formatCurrency(realTotals[idx] ?? 0)}`);
                            }
                            return lines;
                        },
                    },
                },
            },
            scales: {
                x: {
                    stacked: true,
                    grid: { display: false },
                },
                y: {
                    stacked: true,
                    ticks: { callback: (value) => formatCompactCurrency(value) },
                },
            },
        },
    };
}
