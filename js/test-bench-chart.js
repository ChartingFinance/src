/**
 * test-bench-chart.js — the Test Bench's chart: what each part of the plan
 * holds over the years, for one column of the result table.
 *
 * ── Where the run comes from ─────────────────────────────────────────
 *
 * The bench's workers report an answer as a recipe, not as a run: a factor on
 * every monthly expense, and for a routing the plan's life events with the
 * routing written in. So the chart runs that one plan again, here, from the
 * plan the test ran on (portfolioAt, the solver's own run), untraced. A run
 * takes about 30 ms.
 *
 * ── What it draws ─────────────────────────────────────────────────────
 *
 * Macro Projection's bars at its Value metric: one bar per period, one segment
 * per top-level group, with Macro's groups, labels, colours and periods
 * (asset-groups.js, charting_buildDisplayLabels). Two things differ, both so
 * the chart agrees with the table above it:
 *
 *   - It is in today's dollars, as everything else on the bench is.
 *   - Each bar is the LAST month of its period, where Macro's is the first. So
 *     the last bar is the plan's last month, and its total is the table's
 *     "Left at the end" for that column. Macro's last bar is January of the
 *     last year: in today's dollars it misses that figure by up to 4% on the
 *     quick-starts.
 *
 * Income and expense groups hold what they pay in a month, as on Macro, so
 * beside the balances they are thin.
 *
 * Every column is drawn on one y-axis (stackedRange), so switching from one
 * to another shows the difference instead of rescaling it away.
 */

import { portfolioAt } from './spending-solver.js';
import { withoutTracing } from './trace.js';
import { charting_buildDisplayLabels, charting_buildPhaseMarkers } from './charting.js';
import { AssetGroup, AssetGroupMeta, classifyAssetGroup, GROUP_DISPLAY_ORDER } from './asset-groups.js';
import { lastHistoryIndex } from './month-summary.js';
import { MonthsSpan } from './utils/months-span.js';
import { PriceIndex } from './utils/price-index.js';
import { Metric } from './metric.js';
import { InstrumentType } from './instruments/instrument.js';
import { formatCurrency } from './utils/html.js';

/** The result table's columns, by the names the page shows. */
export const CHART_COLUMNS = Object.freeze([
    Object.freeze({ id: 'entered', label: 'As entered' }),
    Object.freeze({ id: 'best',    label: 'Spend the most' }),
    Object.freeze({ id: 'routed',  label: 'With this routing' }),
]);

/**
 * One column of the result table, run and grouped for the chart.
 *
 * @param {object}   plan    as the solver takes it: { modelAssets, lifeEvents, config }.
 *                           Not changed.
 * @param {number}   factor  the column's spending level, the solver's dial
 * @param {object}   [options]
 * @param {object[]} [options.lifeEvents]  the column's life events, when a routing
 *                                         replaces the plan's
 * @param {{ startAge: number, retirementAge: number }} [options.ages]  for the phase
 *                                         markers, as Macro draws them
 * @returns {object} groupSeries(), with `markers` for charting.js's dateMarkers plugin
 */
export function columnSeries(plan, factor, { lifeEvents = null, ages = null } = {}) {
    const run = lifeEvents ? { ...plan, lifeEvents } : plan;
    const portfolio = withoutTracing(() => portfolioAt(run, factor));
    const series = groupSeries(portfolio);
    series.markers = ages
        ? charting_buildPhaseMarkers(portfolio, portfolio.lifeEvents, ages.startAge, ages.retirementAge, null)
        : [];
    return series;
}

/**
 * What each top-level group of a finished run holds at the end of each period,
 * in today's dollars.
 *
 * @param {Portfolio} portfolio  after chronometer_run
 * @returns {{ labels: string[], months: number[], total: number[], periodMonths: number,
 *             datasets: Array<{ label: string, backgroundColor: string, data: number[] }> }}
 *   `months` is the month of the run each bar shows; `total` is each bar's
 *   segments summed, which is the plan's net worth then; `periodMonths` is
 *   how many months a bar stands for (periodWord)
 */
export function groupSeries(portfolio) {
    if (!portfolio?.firstDateInt) return { labels: [], months: [], total: [], periodMonths: 12, datasets: [] };
    const labels = charting_buildDisplayLabels(portfolio.firstDateInt, portfolio.lastDateInt);
    const span = MonthsSpan.build(portfolio.firstDateInt, portfolio.lastDateInt);
    const last = lastHistoryIndex(portfolio);
    const index = portfolio.monthlyPriceIndex ?? [];
    const months = labels.map((_, k) => Math.min(span.offsetMonths + (k + 1) * span.combineMonths - 1, last));

    const groups = new Map();
    for (const asset of portfolio.modelAssets) {
        if (!InstrumentType.isAsset(asset.instrument)) continue;
        const key = classifyAssetGroup(asset.instrument);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(asset);
    }

    // Macro's order, and Macro's exclusions (charting_buildGroupedMetric).
    const datasets = [];
    for (const key of GROUP_DISPLAY_ORDER) {
        if (key === AssetGroup.TAXES || key === AssetGroup.ALL) continue;
        const assets = groups.get(key);
        if (!assets?.length) continue;
        const meta = AssetGroupMeta.get(key);
        const histories = assets.map((a) => a.getHistory(Metric.VALUE) ?? []);
        datasets.push({
            label: meta.label,
            backgroundColor: meta.chartColor,
            data: months.map((m) => PriceIndex.deflateAt(
                histories.reduce((sum, h) => sum + (h[m] ?? 0), 0), index, m)),
        });
    }
    const total = months.map((_, k) => datasets.reduce((sum, d) => sum + d.data[k], 0));
    return { labels, months, total, periodMonths: span.combineMonths, datasets };
}

/** What one bar stands for, in words: MonthsSpan's periods. */
export function periodWord(periodMonths) {
    return { 1: 'month', 3: 'quarter', 6: 'half-year' }[periodMonths] ?? 'year';
}

/**
 * The y-axis that holds every series stacked, as Chart.js stacks them: the
 * positive segments of a bar upward from $0, the negative ones downward.
 *
 * @param {Array<{ labels: string[], datasets: Array<{ data: number[] }> }>} seriesList
 * @returns {{ min: number, max: number }}
 */
export function stackedRange(seriesList) {
    let min = 0, max = 0;
    for (const series of seriesList) {
        for (let k = 0; k < series.labels.length; k++) {
            let up = 0, down = 0;
            for (const d of series.datasets) {
                const v = d.data[k] ?? 0;
                if (v > 0) up += v; else down += v;
            }
            max = Math.max(max, up);
            min = Math.min(min, down);
        }
    }
    return { min, max };
}

/**
 * A Chart.js config for one series on a shared axis.
 *
 * The axis is suggested, not fixed: Chart.js still rounds it to whole ticks,
 * and since no series on the bench reaches past the range, every one gets the
 * same axis.
 *
 * @param {object} series  columnSeries()
 * @param {{ min: number, max: number }} range  stackedRange() of every column on offer
 */
export function chartConfig(series, range) {
    return {
        type: 'bar',
        data: {
            labels: [...series.labels],
            datasets: series.datasets.map((d) => ({ ...d, data: [...d.data] })),
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 250 },
            interaction: { mode: 'index', intersect: false },
            plugins: {
                title: { display: false },
                dateMarkers: { markers: series.markers ?? [] },
                tooltip: {
                    callbacks: {
                        title: (items) => (items.length ? `End of ${items[0].label}` : ''),
                        footer: (items) => `Total: ${formatCurrency(items.reduce((sum, i) => sum + i.parsed.y, 0))}`,
                    },
                },
            },
            scales: {
                x: { stacked: true },
                y: { stacked: true, suggestedMin: range.min, suggestedMax: range.max },
            },
        },
    };
}
