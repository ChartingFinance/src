/**
 * charting.js
 *
 * Chart.js configuration and builders for portfolio projections:
 *   - Registers the Chart.js controllers, scales, and plugins used by the app
 *     along with shared currency formatting for axes and tooltips.
 *   - Registers the `dateMarkers` plugin for vertical dashed phase, asset, and
 *     timeline-cursor reference lines.
 *   - Builds stacked bar chart configs (grouped by asset class or per-asset)
 *     and time-bucketed x-axis labels from a simulated Portfolio.
 */

// Register only the Chart.js components the app uses (bar and line charts) to
// keep the bundle small. Adding a new chart type or plugin requires registering
// it here; missing registrations fail at runtime rather than build time.
import {
  Chart,
  BarController, BarElement,
  LineController, LineElement, PointElement,
  CategoryScale, LinearScale,
  Tooltip, Legend, Filler,
} from 'chart.js';
Chart.register(
  BarController, BarElement,
  LineController, LineElement, PointElement,
  CategoryScale, LinearScale,
  Tooltip, Legend, Filler,
);
// Every chart in the app plots dollars, so the value axis and the tooltip
// default to the shared money formats: compact on the axis, full in the
// tooltip. A chart can still set its own.
Chart.defaults.scales.linear.ticks.callback = (value) => formatCompactCurrency(value);
Chart.defaults.plugins.tooltip.callbacks.label = (ctx) => {
  const value = ctx.chart.options.indexAxis === 'y' ? ctx.parsed.x : ctx.parsed.y;
  return `${ctx.dataset.label ? ctx.dataset.label + ': ' : ''}${formatCurrency(value)}`;
};
import { MonthsSpan } from './utils/months-span.js';
import { DateInt } from './utils/date-int.js';
import {
    colorRange, positiveBackgroundColor, negativeBackgroundColor,
    formatCompactCurrency, formatCurrency,
} from './utils/html.js';
import { logger, LogCategory } from './utils/logger.js';
import { findById } from './portfolio.js';
import { Metric } from './metric.js';
import { InstrumentType } from './instruments/instrument.js';
import { LifeEvent, LifeEventMeta } from './life-event.js';
import {
    AssetGroup, AssetGroupMeta,
    classifyAssetGroup, sumDisplayHistories, getAssetChartColor,
    GROUP_DISPLAY_ORDER,
} from './asset-groups.js';

// ── Date marker plugin ────────────────────────────────────────────

/**
 * Chart.js plugin that draws vertical dashed reference lines (with optional top
 * labels) at specified x-axis indices — used for life-event phases, asset
 * start/end boundaries, and the active timeline cursor.
 */
const dateMarkerPlugin = {
    id: 'dateMarkers',
    afterDraw(chart) {
        const markers = chart.options?.plugins?.dateMarkers?.markers;
        if (!markers?.length) return;
        const { ctx, chartArea: { top, bottom, left, right }, scales: { x } } = chart;
        ctx.save();
        ctx.font = 'bold 10px sans-serif';
        const placedRows = [[], []]; // track [xMin, xMax] intervals on up to 2 label rows
        for (const marker of markers) {
            const xPos = x.getPixelForValue(marker.index);
            if (!Number.isFinite(xPos) || xPos < left - 1 || xPos > right + 1) continue;
            ctx.beginPath();
            ctx.setLineDash(marker.isCursor ? [] : (marker.label ? [5, 4] : [4, 4]));
            ctx.strokeStyle = marker.color;
            ctx.lineWidth = marker.isCursor ? 2 : (marker.label ? 1.5 : 1);
            ctx.moveTo(xPos, top);
            ctx.lineTo(xPos, bottom);
            ctx.stroke();
            if (marker.label) {
                ctx.setLineDash([]);
                ctx.fillStyle = marker.color;
                ctx.textAlign = 'center';
                const halfW = ctx.measureText(marker.label).width / 2 + 4;
                const clampedX = Math.max(left + halfW, Math.min(right - halfW, xPos));
                let row = 0;
                if (!marker.isCursor) {
                    const collides = (r) => placedRows[r].some(([a, b]) => !(clampedX + halfW < a || clampedX - halfW > b));
                    if (collides(0) && !collides(1)) row = 1;
                    placedRows[row].push([clampedX - halfW, clampedX + halfW]);
                }
                const yText = marker.isCursor ? top - 3 : top - 5 - row * 12;
                ctx.fillText(marker.label, clampedX, yText);
            }
        }
        ctx.restore();
    }
};

Chart.register(dateMarkerPlugin);

function dateIntToChartIndex(dateInt, firstDateInt, monthsSpan) {
    const totalMonthsFromStart = DateInt.diffMonths(firstDateInt, dateInt);
    const adjusted = totalMonthsFromStart - monthsSpan.offsetMonths;
    if (adjusted < 0) return -1;
    return Math.round(adjusted / monthsSpan.combineMonths);
}

/**
 * Build reference markers for every asset's start/finish dates plus each
 * subsequent life event (skipping the initial phase, which sits at index 0).
 */
export function charting_buildDateMarkers(portfolio) {
    if (!portfolio?.firstDateInt || !portfolio?.lastDateInt) return [];
    const monthsSpan = MonthsSpan.build(portfolio.firstDateInt, portfolio.lastDateInt);
    const markers = [];
    for (const modelAsset of portfolio.modelAssets) {
        const color = colorRange[modelAsset.colorId];
        const startIdx = dateIntToChartIndex(modelAsset.startDateInt, portfolio.firstDateInt, monthsSpan);
        const finishIdx = dateIntToChartIndex(modelAsset.effectiveFinishDateInt, portfolio.firstDateInt, monthsSpan);
        if (startIdx >= 0) markers.push({ index: startIdx, color });
        if (finishIdx >= 0) markers.push({ index: finishIdx, color });
    }
    // Life event markers (skip the first — Accumulate starts at simulation start)
    for (let i = 1; i < portfolio.lifeEvents.length; i++) {
        const ev = portfolio.lifeEvents[i];
        const idx = dateIntToChartIndex(ev.triggerDateInt, portfolio.firstDateInt, monthsSpan);
        if (idx >= 0) {
            const meta = LifeEventMeta.get(ev.type);
            markers.push({ index: idx, color: meta?.colorAccent ?? '#888780', label: ev.displayName });
        }
    }
    return markers;
}

/**
 * Build phase markers (Accumulate if visible, Retire) + a "you are here" cursor marker.
 * @param {Portfolio} portfolio
 * @param {ModelLifeEvent[]} lifeEvents - full life events array
 * @param {number} startAge - user's current age
 * @param {number} retirementAge
 * @param {DateInt} cursorDateInt - selected date from timeline
 * @returns {Object[]} marker objects for dateMarkerPlugin
 */
export function charting_buildPhaseMarkers(portfolio, lifeEvents, startAge, retirementAge, cursorDateInt) {
    if (!portfolio?.firstDateInt) return [];
    const monthsSpan = MonthsSpan.build(portfolio.firstDateInt, portfolio.lastDateInt);
    const markers = [];

    for (const ev of lifeEvents) {
        const isAccumulate = ev.type === LifeEvent.ACCUMULATE;
        const isRetire = ev.type === LifeEvent.RETIRE;
        if (!isAccumulate && !isRetire) continue;
        // Hide Accumulate if already retired
        if (isAccumulate && startAge >= retirementAge) continue;

        const idx = dateIntToChartIndex(ev.triggerDateInt, portfolio.firstDateInt, monthsSpan);
        if (idx >= 0) {
            const meta = LifeEventMeta.get(ev.type);
            markers.push({ index: idx, color: meta?.colorAccent ?? '#888780', label: ev.displayName });
        }
    }

    // "You are here" cursor
    if (cursorDateInt) {
        const idx = dateIntToChartIndex(cursorDateInt, portfolio.firstDateInt, monthsSpan);
        if (idx >= 0) {
            markers.push({ index: idx, color: '#111827', label: '\u25BC' });
        }
    }

    return markers;
}

// ── Highlight ─────────────────────────────────────────────────────

let highlightDisplayName = null;

export function charting_getHighlightDisplayName() {
    return highlightDisplayName;
}

export function charting_setHighlightDisplayName(value) {
    highlightDisplayName = value;
}

// ── Chart templates & module state ───────────────────────────────

const stackedBarChartConfig = {
    type: 'bar',
    data: null,
    options: {
      plugins: {
        title: {
          display: false,
          text: null
        },
      },
      responsive: true,
      scales: {
        x: {
          stacked: true,
        },
        y: {
          stacked: true
        }
      }
    }
  };

const stackedBarChartData = {
    labels: '',
    datasets: []
};

const stackedBarChartDataSet = {
    label: null,
    data: null
 };

const assetStackedBarChartExclusions = ['monthlyExpense', 'healthInsurance', 'workingIncome', 'retirementIncome', 'pension'];

const lineChartConfig = {
  type: 'line',
  data: null,
  options: {
    responsive: true,
    plugins: {
      legend: {
        position: 'top',
      },
      title: {
        display: true,
        text: ''
      }
    }
  },
};

const lineChartData = {
  labels: '',
  datasets: []
};

const lineChartDataSet = {
  label: '',
  data: []
};

const flowLineChartExclusions = ['realEstate','mortgage'];

export let charting_jsonMetric1ChartData = null;
export let charting_jsonRollupChartData = null;
export let charting_jsonSpreeadsheetData = null;
export let charting_jsonMetricChartConfigIndividual = null; // for individual model asset display, e.g. cash flow in fundsTransfer

const chartMetricConfigCache = new Map();

// ── X-axis labels & color assignment ─────────────────────────────

/**
 * Build time-bucketed x-axis labels spanning [firstDateInt, lastDateInt].
 * Uses `MonthsSpan` to automatically choose monthly, quarterly (Q1–Q4),
 * semi-annual (H1/H2), or annual labels based on the plan horizon.
 */
export function charting_buildDisplayLabels(firstDateInt, lastDateInt) {
  if (!firstDateInt || !lastDateInt) return [];
  let monthsSpan = MonthsSpan.build(firstDateInt, lastDateInt);
  let runnerDateInt = new DateInt(firstDateInt.toInt());
  runnerDateInt.addMonths(monthsSpan.offsetMonths);
  let labels = [];
  while (runnerDateInt.toInt() <= lastDateInt.toInt()) {
    let label = '';

    if (monthsSpan.combineMonths == 3) {
      if (runnerDateInt.month >= 1 && runnerDateInt.month < 4) {
        label = 'Q1 ';
      }
      else if (runnerDateInt.month >= 4 && runnerDateInt.month < 7) {
        label = 'Q2 ';
      }
      else if (runnerDateInt.month >= 7 && runnerDateInt.month < 10) {
        label = 'Q3 ';
      }
      else {
        label = 'Q4 ';
      }
      label += runnerDateInt.year.toString();
    }

    else if (monthsSpan.combineMonths == 6) {
      if (runnerDateInt.month >= 1 && runnerDateInt.month < 7) {
        label = 'H1 ';
      }
      else {
        label = 'H2 ';
      }
      label += runnerDateInt.year.toString();
    }

    else if (monthsSpan.combineMonths == 12) {
      label = runnerDateInt.year.toString();
    }

    else { // monthsSpan.combineMonths == 1
      console.assert(monthsSpan.combineMonths == 1, 'monthsSpan.combineMonths != 1 for Monthly');
      label = runnerDateInt.toString();
    }

    labels.push(label);

    runnerDateInt.addMonths(monthsSpan.combineMonths);
  }

  return labels;
}

export function setModelAssetColorIds(modelAssets) {
    let colorId = -1;
    for (let modelAsset of modelAssets) {
        ++colorId;
        modelAsset.colorId = colorId;
    }
}

// ── Chart builders ───────────────────────────────────────────────

// Returns a shallow copy of modelAssets in their original order so each
// asset's positional colorId stays consistent across chart views.
export function charting_reducedModelAssetsForMetric(modelAssets, metricName) {
  let results = [];
  for (const modelAsset of modelAssets) {
          results.push(modelAsset);
  }
  return results;
}

export function charting_buildModelAssetMetric(modelAsset, metricName) {
  
  let chartingMetricDataSet = JSON.parse(JSON.stringify(stackedBarChartDataSet));
  chartingMetricDataSet.label = modelAsset.displayName;
  chartingMetricDataSet.data = modelAsset.getDisplayHistory(metricName);
  return chartingMetricDataSet;

}

export function charting_buildPortfolioMetric(portfolio, metricName, buildNewDataSet) {

  let chartingMetricConfig = null;
  let chartingMetricData = null;

  let cachedConfig = chartMetricConfigCache.get(metricName);

  if (!buildNewDataSet && cachedConfig == null) {
    logger.log(LogCategory.CHARTING, () => 'charting_buildPortfolioMetric - attempting to reuse null config for ' + metricName + '. Building new data set.');
    buildNewDataSet = true;
  }

  if (buildNewDataSet) {
    chartingMetricConfig = JSON.parse(JSON.stringify(stackedBarChartConfig));
    chartingMetricData = JSON.parse(JSON.stringify(stackedBarChartData));

    let labels = charting_buildDisplayLabels(portfolio.firstDateInt, portfolio.lastDateInt);
    chartingMetricData.labels = labels;
  }
  else {
    chartingMetricConfig = cachedConfig;
    chartingMetricData = chartingMetricConfig.data;
  }

  let reducedModelAssets = charting_reducedModelAssetsForMetric(portfolio.modelAssets, metricName);
  let dataIndex = -1;

  for (const modelAsset of reducedModelAssets) {

    if (modelAsset == null)
        continue;

    ++dataIndex;

    let chartingMetricDataSet = null;

    if (buildNewDataSet) {
      chartingMetricDataSet = charting_buildModelAssetMetric(modelAsset, metricName);
    }
    else
      chartingMetricDataSet = chartingMetricData.datasets[dataIndex];

    if (highlightDisplayName != null) {
        if (highlightDisplayName == modelAsset.displayName)
            chartingMetricDataSet.backgroundColor = colorRange[modelAsset.colorId];
        else
            chartingMetricDataSet.backgroundColor = 'whitesmoke';
    }
    else {
      chartingMetricDataSet.backgroundColor = colorRange[modelAsset.colorId];
    }

    if (buildNewDataSet)
      chartingMetricData.datasets.push(chartingMetricDataSet);
  }

  chartingMetricConfig.data = chartingMetricData;
  chartMetricConfigCache.set(metricName, chartingMetricConfig);
  return chartingMetricConfig;
}

/**
 * Builds a stacked bar chart config with grouped datasets and stable colors.
 * Collapsed groups → single dataset (summed values) in group color.
 * Expanded groups → individual datasets per asset in shade colors.
 */
export function charting_buildGroupedMetric(portfolio, metricName, expandedGroups, groupOrder) {
  if (!portfolio?.firstDateInt) return { type: 'bar', data: { labels: [], datasets: [] }, options: {} };
  const labels = charting_buildDisplayLabels(portfolio.firstDateInt, portfolio.lastDateInt);

  // Classify by instrument (ignore isClosed) so charts show full history.
  // Balance-sheet metrics exclude flow instruments (monthly income/expenses)
  // whose VALUE history holds monthly flow rate rather than net worth.
  const assetsOnly = metricName === Metric.VALUE || metricName === Metric.NET_WORTH_CHANGE;
  const groups = new Map();
  for (const asset of portfolio.modelAssets) {
    if (assetsOnly && !InstrumentType.isAsset(asset.instrument)) continue;
    const groupKey = classifyAssetGroup(asset.instrument);
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(asset);
  }

  const datasets = [];

  for (const groupKey of (groupOrder || GROUP_DISPLAY_ORDER)) {
    if (groupKey === AssetGroup.TAXES || groupKey === AssetGroup.ALL) continue;
    const assets = groups.get(groupKey);
    if (!assets || assets.length === 0) continue;

    const groupMeta = AssetGroupMeta.get(groupKey);

    if (expandedGroups?.has(groupKey)) {
      // Expanded: one bar dataset per asset, using stable shade colors
      for (const asset of assets) {
        const color = getAssetChartColor(asset.instrument);
        datasets.push({
          label: asset.displayName,
          data: asset.getDisplayHistory(metricName),
          backgroundColor: color,
        });
      }
    } else {
      // Collapsed: single bar dataset (summed), using group color
      datasets.push({
        label: groupMeta.label,
        data: sumDisplayHistories(assets, metricName),
        backgroundColor: groupMeta.chartColor,
      });
    }
  }

  return {
    type: 'bar',
    data: { labels, datasets },
    options: {
      plugins: {
        title: { display: false, text: null },
      },
      responsive: true,
      scales: {
        x: { stacked: true },
        y: { stacked: true },
      },
    },
  };
}

export function charting_buildFromPortfolio(portfolio, buildNewDataSet, metric1Name, expandedGroups) {
  if (portfolio == null || portfolio.modelAssets == null || portfolio.modelAssets.length == 0) {

    logger.log(LogCategory.CHARTING, 'charting_buildFromPortfolio - null or zero length array provided');
    charting_jsonMetric1ChartData = null;
    charting_jsonRollupChartData = null;
    charting_jsonSpreeadsheetData = null;
    chartMetricConfigCache.clear();

  }
  else {

    setModelAssetColorIds(portfolio.modelAssets);

    // Use grouped chart when expandedGroups is provided, else legacy stacked bar
    if (expandedGroups) {
      charting_jsonMetric1ChartData = charting_buildGroupedMetric(portfolio, metric1Name, expandedGroups);
    } else {
      charting_jsonMetric1ChartData = charting_buildPortfolioMetric(portfolio, metric1Name, buildNewDataSet);
    }
    charting_jsonRollupChartData = charting_buildPortfolioMetric(portfolio, "cashFlow", buildNewDataSet);

    const markers = charting_buildDateMarkers(portfolio);
    charting_jsonMetric1ChartData.options.plugins.dateMarkers = { markers };
    charting_jsonRollupChartData.options.plugins.dateMarkers = { markers };

  }
}

/** Builds a standalone stacked bar chart config for a single asset (looked up by ID). */
export function charting_buildFromModelAsset(portfolio, modelAssetId, metricName = Metric.CASH_FLOW) {

    if (!portfolio?.firstDateInt) return;
    setModelAssetColorIds(portfolio.modelAssets);
    let modelAsset = findById(portfolio.modelAssets, modelAssetId);
    if (!modelAsset) return;

    let config = JSON.parse(JSON.stringify(stackedBarChartConfig));
    let data = JSON.parse(JSON.stringify(stackedBarChartData));
    data.labels = charting_buildDisplayLabels(portfolio.firstDateInt, portfolio.lastDateInt);

    let dataSet = charting_buildModelAssetMetric(modelAsset, metricName);
    dataSet.backgroundColor = colorRange[modelAsset.colorId];
    data.datasets.push(dataSet);

    config.data = data;
    charting_jsonMetricChartConfigIndividual = config;

}

