import { MonthsSpan } from './utils/months-span.js';
import { DateInt } from './utils/date-int.js';
import { colorRange, positiveBackgroundColor, negativeBackgroundColor } from './utils/html.js';
import { logger, LogCategory } from './utils/logger.js';
import { findByName } from './portfolio.js';
import { Metric } from './metric.js';
import { LifeEvent, LifeEventMeta } from './life-event.js';
import {
    AssetGroup, AssetGroupMeta,
    classifyAssetGroup, sumDisplayHistories, getAssetChartColor,
    GROUP_DISPLAY_ORDER,
} from './asset-groups.js';

// ── Date marker plugin ────────────────────────────────────────────

const dateMarkerPlugin = {
    id: 'dateMarkers',
    afterDraw(chart) {
        const markers = chart.options?.plugins?.dateMarkers?.markers;
        if (!markers?.length) return;
        const { ctx, chartArea: { top, bottom }, scales: { x } } = chart;
        ctx.save();
        for (const marker of markers) {
            const xPos = x.getPixelForValue(marker.index);
            ctx.beginPath();
            ctx.setLineDash(marker.label ? [6, 4] : [4, 4]);
            ctx.strokeStyle = marker.color;
            ctx.lineWidth = marker.label ? 2 : 1;
            ctx.moveTo(xPos, top);
            ctx.lineTo(xPos, bottom);
            ctx.stroke();
            if (marker.label) {
                ctx.setLineDash([]);
                ctx.fillStyle = marker.color;
                ctx.font = 'bold 10px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(marker.label, xPos, top - 5);
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

export function charting_buildDateMarkers(portfolio) {
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

const assetStackedBarChartExclusions = ['monthlyExpense', 'workingIncome', 'retirementIncome'];

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

export function charting_buildDisplayLabels(firstDateInt, lastDateInt) {
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

// The reduction keeps the modelAssets positionally in the array. This is so the colorId value is consistent across chart views.
export function charting_reducedModelAssetsForMetric(modelAssets, metricName) {
  let results = [];
  for (const modelAsset of modelAssets) {
      //if (assetStackedBarChartExclusions.includes(modelAsset.instrument))
      //    results.push(null);
      //else
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
    logger.log(LogCategory.CHARTING, 'charting_buildPortfolioMetric - attempting to reuse null config for ' + metricName + '. Building new data set.');
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

/*
export function charting_buildPortfolioRollup(portfolio, predefinedName, buildNewDataSet) {

  let chartingAssetConfig = null;
  let chartingAssetData = null;

  if (!buildNewDataSet && charting_jsonMetric1ChartData == null) {
    logger.log(LogCategory.CHARTING, 'charting_buildPortfolioRollup - attempting to reuse null charting_jsonMetricRollupData. Building new data set.');
    buildNewDataSet = true;
  }

  if (buildNewDataSet) {
    chartingAssetConfig = JSON.parse(JSON.stringify(stackedBarChartConfig));
    chartingAssetData = JSON.parse(JSON.stringify(stackedBarChartData));

    let labels = charting_buildDisplayLabels(portfolio.firstDateInt, portfolio.lastDateInt);
    chartingAssetData.labels = labels;
  }
  else {
    chartingAssetConfig = charting_jsonMetric1ChartData;
    chartingAssetData = chartingAssetConfig.data;
  }

  let reducedModelAssets = charting_reducedModelAssetsForMetric(portfolio.modelAssets);
  let dataIndex = -1;

  for (const modelAsset of reducedModelAssets) {

    if (modelAsset == null)
        continue;

    ++dataIndex;

    let chartingAssetDataSet = null;

    if (buildNewDataSet) {
      chartingAssetDataSet = JSON.parse(JSON.stringify(stackedBarChartDataSet));
      chartingAssetDataSet.label = modelAsset.displayName;
      chartingAssetDataSet.data = modelAsset.getDisplayHistory(predefinedName);
    }
    else
      chartingAssetDataSet = chartingAssetData.datasets[dataIndex];

    if (highlightDisplayName != null) {
        if (highlightDisplayName == modelAsset.displayName)
            chartingAssetDataSet.backgroundColor = colorRange[modelAsset.colorId];
        else
            chartingAssetDataSet.backgroundColor = 'whitesmoke';
    }
    else {
      chartingAssetDataSet.backgroundColor = colorRange[modelAsset.colorId];
    }

    if (buildNewDataSet)
      chartingAssetData.datasets.push(chartingAssetDataSet);
  }

  chartingAssetConfig.data = chartingAssetData;
  return chartingAssetConfig;
}

export function charting_buildCashFlowDataSet(modelAssets, label, sign) {
  let cashFlowDataSet = JSON.parse(JSON.stringify(lineChartDataSet));
  cashFlowDataSet.label = label;

  let firstModelAsset = true;
  for (const modelAsset of modelAssets) {
    if (modelAsset == null)
      continue;
    //else if (flowLineChartExclusions.includes(modelAsset.instrument))
    //  continue;

    let displayHistoryData = modelAsset.getDisplayHistory(Metric.CASH_FLOW);

    for (let ii = 0; ii < displayHistoryData.length; ii++) {

      if (firstModelAsset)
        cashFlowDataSet.data.push(0.0);

      let displayData = displayHistoryData[ii];
      if (displayData == null)
        displayData = 0.0;

      if (sign > 0 && displayData > 0.0)
        cashFlowDataSet.data[ii] += displayData;
      else if (sign < 0 && displayData < 0.0)
        cashFlowDataSet.data[ii] += displayData;
      else if (sign == 0)
        cashFlowDataSet.data[ii] += displayData;
    }

    firstModelAsset = false;
  }

  if (sign > 0)
    cashFlowDataSet.backgroundColor = positiveBackgroundColor;
  else if (sign < 0)
    cashFlowDataSet.backgroundColor = negativeBackgroundColor;
  else
    cashFlowDataSet.backgroundColor = '#000';

  return cashFlowDataSet;
}

export function charting_buildCashFlowDataSet_rmds(portfolio) {

  let cashFlowDataSet = JSON.parse(JSON.stringify(lineChartDataSet));
  cashFlowDataSet.label = 'RMDs';
  cashFlowDataSet.data = portfolio.displayRMDs;
  cashFlowDataSet.backgroundColor = '#0000ff';
  return cashFlowDataSet;

}

export function charting_buildCashFlowDataSet_fica(portfolio) {

  let cashFlowDataSet = JSON.parse(JSON.stringify(lineChartDataSet));
  cashFlowDataSet.label = 'FICA';
  cashFlowDataSet.data = portfolio.displayFICA;
  cashFlowDataSet.backgroundColor = '#00ff00';
  return cashFlowDataSet;

}

export function charting_buildCashFlowDataSet_taxes(portfolio) {

  let displayAllTaxes = [];

  for (let ii = 0; ii < portfolio.displayIncomeTaxes.length; ++ii)
    displayAllTaxes.push(portfolio.displayIncomeTaxes[ii] + portfolio.displayFICAs[ii] + portfolio.displayCapitalGainsTaxes[ii]);

  let cashFlowDataSet = JSON.parse(JSON.stringify(lineChartDataSet));
  cashFlowDataSet.label = 'Federal Taxes';
  cashFlowDataSet.data = displayAllTaxes;
  cashFlowDataSet.backgroundColor = '#ffff00';
  return cashFlowDataSet;

}

export function charting_applyTaxesToCashFlowDataSet(cashFlowDataSet, taxDataSet) {
  for (let ii = 0; ii < cashFlowDataSet.data.length; ii++) {
    let taxData = taxDataSet.data[ii];
    cashFlowDataSet.data[ii] += taxData;
  }
}

export function charting_buildDisplayCashFlowFromPortfolio(portfolio) {

  //let reducedModelAssets = portfolio.modelAssets; // was charting_reducedModelAssetsForEarnings
  let reducedModelAssets = portfolio.modelAssets;

  let chartingCashFlowDataSet_credits = charting_buildCashFlowDataSet(reducedModelAssets, 'Credits', 1);
  let chartingCashFlowDataSet_debits = charting_buildCashFlowDataSet(reducedModelAssets, 'Debits', -1);
  let chartingCashFlowDataSet_cash = charting_buildCashFlowDataSet(reducedModelAssets, 'Growth', 0);
  //let chartingCashFlowDataSet_fica = charting_buildCashFlowDataSet_fica(portfolio);
  //let chartingCashFlowDataSet_rmds = charting_buildCashFlowDataSet_rmds(portfolio);
  //let chartingCashFlowDataSet_taxes = charting_buildCashFlowDataSet_taxes(portfolio);

  //charting_applyTaxesToCashFlowDataSet(chartingCashFlowDataSet_cash, chartingCashFlowDataSet_taxes);

  //chartingCashFlowData.datasets.push(chartingCashFlowDataSet_credits);
  //chartingCashFlowData.datasets.push(chartingCashFlowDataSet_debits);
  //chartingCashFlowData.datasets.push(chartingCashFlowDataSet_cash);
  //chartingCashFlowData.datasets.push(chartingCashFlowDataSet_fica);
  //chartingCashFlowData.datasets.push(chartingCashFlowDataSet_rmds);
  //chartingCashFlowData.datasets.push(chartingCashFlowDataSet_taxes);

  return null; chartingCashFlowData;

}

export function charting_buildPortfolioRollup(portfolio, predefinedName, buildNewDataSet) {

  let chartingRollupConfig = JSON.parse(JSON.stringify(lineChartConfig));
  let chartingRollupData = JSON.parse(JSON.stringify(lineChartData));
  chartingRollupData.labels = charting_buildDisplayLabels(portfolio.firstDateInt, portfolio.lastDateInt);

  if (predefinedName == 'cashFlow') {
     chartingRollupConfig.data = charting_buildDisplayCashFlowFromPortfolio(portfolio)
  }

  return chartingRollupConfig;

}

/*
export function charting_buildDisplaySpreadsheetFromPortfolio(portfolio, buildNewDataSet) {
  // Spreadsheet data is built during portfolio calculation. Here we just return the data structure.
}
*/

/**
 * Builds a stacked bar chart config with grouped datasets and stable colors.
 * Collapsed groups → single dataset (summed values) in group color.
 * Expanded groups → individual datasets per asset in shade colors.
 * Same chart type as the legacy charting_buildPortfolioMetric, just with
 * group-aware colors and collapse/expand support.
 */
export function charting_buildGroupedMetric(portfolio, metricName, expandedGroups, groupOrder) {
  const labels = charting_buildDisplayLabels(portfolio.firstDateInt, portfolio.lastDateInt);

  // Classify by instrument (ignore isClosed) so charts show full history
  const groups = new Map();
  for (const asset of portfolio.modelAssets) {
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

export function charting_buildFromModelAsset(portfolio, modelDisplayName, metricName = Metric.CASH_FLOW) {

    setModelAssetColorIds(portfolio.modelAssets);
    let modelAsset = findByName(portfolio.modelAssets, modelDisplayName);

    let config = JSON.parse(JSON.stringify(stackedBarChartConfig));
    let data = JSON.parse(JSON.stringify(stackedBarChartData));
    data.labels = charting_buildDisplayLabels(portfolio.firstDateInt, portfolio.lastDateInt);

    let dataSet = charting_buildModelAssetMetric(modelAsset, metricName);
    dataSet.backgroundColor = colorRange[modelAsset.colorId];
    data.datasets.push(dataSet);

    config.data = data;
    charting_jsonMetricChartConfigIndividual = config;

}

