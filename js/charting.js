import { MonthsSpan } from './months-span.js';
import { DateInt } from './date-int.js';
import { colorRange, positiveBackgroundColor, negativeBackgroundColor } from './html.js';
import { logger, LogCategory } from './logger.js';
import { findByName } from './asset-queries.js';
import { Metric } from './model-asset.js';

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
            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = marker.color;
            ctx.lineWidth = 1;
            ctx.moveTo(xPos, top);
            ctx.lineTo(xPos, bottom);
            ctx.stroke();
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

function charting_buildDateMarkers(portfolio) {
    const monthsSpan = MonthsSpan.build(portfolio.firstDateInt, portfolio.lastDateInt);
    const markers = [];
    for (const modelAsset of portfolio.modelAssets) {
        const color = colorRange[modelAsset.colorId];
        const startIdx = dateIntToChartIndex(modelAsset.startDateInt, portfolio.firstDateInt, monthsSpan);
        const finishIdx = dateIntToChartIndex(modelAsset.finishDateInt, portfolio.firstDateInt, monthsSpan);
        if (startIdx >= 0) markers.push({ index: startIdx, color });
        if (finishIdx >= 0) markers.push({ index: finishIdx, color });
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

const assetStackedBarChartExclusions = ['monthlyExpense', 'monthlySalary', 'monthlySocialSecurity'];

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

const flowLineChartExclusions = ['home','mortgage'];

export let charting_jsonMetric1ChartData = null;
export let charting_jsonMetric2ChartData = null;
export let charting_jsonRollupChartData = null;
export let charting_jsonSpreeadsheetData = null;
export let charting_jsonMetricChartConfigIndividual = null; // for individual model asset display, e.g. earnings in fundsTransfer

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
  chartingMetricDataSet.data = modelAsset.getMetric(metricName).displayHistory;
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
      chartingAssetDataSet.data = modelAsset.getMetric(predefinedName).displayHistory;
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

// The reduction keeps the modelAssets positionally in the array. This is so the colorId value is consistent across chart views.
export function charting_reducedModelAssetsForEarnings(modelAssets) {
  let results = [];
  for (const modelAsset of modelAssets) {
      //if (flowLineChartExclusions.includes(modelAsset.instrument))
      //    results.push(null);
      //else
          results.push(modelAsset);
  }
  return results;
}
*/

export function charting_buildDisplayEarningsFromModelAssets(firstDateInt, lastDateInt, modelAssets, buildNewDataSet) {
  if (firstDateInt == null) {
    logger.log(LogCategory.CHARTING, 'charting_buildDisplayEarningsFromModelAssets - null firstDateInt provided');
    return null;
  }
  else if (lastDateInt == null) {
    logger.log(LogCategory.CHARTING, 'charting_buildDisplayEarningsFromModelAssets - null lastDateInt provided');
    return null;
  }

  let chartingEarningsConfig = null;
  let chartingEarningsData = null;

  let cachedConfig = chartMetricConfigCache.get('earningsMulti');

  if (!buildNewDataSet && cachedConfig == null) {
    logger.log(LogCategory.CHARTING, 'charting_buildDisplayEarningsFromModelAssets - attempting to reuse null config. Building new data set.');
    buildNewDataSet = true;
  }

  if (buildNewDataSet) {
    chartingEarningsConfig = JSON.parse(JSON.stringify(lineChartConfig));
    chartingEarningsData = JSON.parse(JSON.stringify(lineChartData));
    let labels = charting_buildDisplayLabels(firstDateInt, lastDateInt);
    chartingEarningsData.labels = labels;
  }
  else {
    chartingEarningsConfig = cachedConfig;
    chartingEarningsData = chartingEarningsConfig.data;
  }

  let reducedModelAssets = charting_reducedModelAssetsForEarnings(modelAssets);
  let dataIndex = -1;

  for (const modelAsset of reducedModelAssets) {

    if (modelAsset == null)
      continue;

    ++dataIndex;

    let chartingEarningsDataSet = null;

    if (buildNewDataSet) {
      chartingEarningsDataSet = JSON.parse(JSON.stringify(lineChartDataSet));
      chartingEarningsDataSet.label = modelAsset.displayName;
      chartingEarningsDataSet.data = modelAsset.displayEarningData;
    }
    else
      chartingEarningsDataSet = chartingEarningsData.datasets[dataIndex];

    if (highlightDisplayName != null) {
      if (highlightDisplayName == modelAsset.displayName)
        chartingEarningsDataSet.backgroundColor = colorRange[modelAsset.colorId];
      else
        chartingEarningsDataSet.backgroundColor = 'whitesmoke';
    }
    else {
      chartingEarningsDataSet.backgroundColor = colorRange[modelAsset.colorId];
    }

    if (buildNewDataSet)
      chartingEarningsData.datasets.push(chartingEarningsDataSet);
  }

  chartingEarningsConfig.data = chartingEarningsData;
  return chartingEarningsConfig;
}

export function charting_buildDisplayEarningsFromModelAsset(firstDateInt, lastDateInt, modelAsset, buildNewDataSet) {
  if (firstDateInt == null) {
    logger.log(LogCategory.CHARTING, 'charting_buildDisplayEarningsFromModelAssets - null firstDateInt provided');
    return null;
  }
  else if (lastDateInt == null) {
    logger.log(LogCategory.CHARTING, 'charting_buildDisplayEarningsFromModelAssets - null lastDateInt provided');
    return null;
  }

  let chartingEarningsConfig = null;
  let chartingEarningsData = null;

  let cachedConfig = chartMetricConfigCache.get('earningsIndividual');

  if (!buildNewDataSet && cachedConfig == null) {
    logger.log(LogCategory.CHARTING, 'charting_buildDisplayEarningsFromModelAsset - attempting to reuse null config. Building new data set.');
    buildNewDataSet = true;
  }

  if (buildNewDataSet) {
    chartingEarningsConfig = JSON.parse(JSON.stringify(lineChartConfig));
    chartingEarningsData = JSON.parse(JSON.stringify(lineChartData));
    let labels = charting_buildDisplayLabels(firstDateInt, lastDateInt);
    chartingEarningsData.labels = labels;
  }
  else {
    chartingEarningsConfig = cachedConfig;
    chartingEarningsData = chartingEarningsConfig.data;
  }

  let chartingEarningsDataSet = null;

  if (buildNewDataSet) {
    chartingEarningsDataSet = JSON.parse(JSON.stringify(lineChartDataSet));
    chartingEarningsDataSet.label = modelAsset.displayName;
    chartingEarningsDataSet.data = modelAsset.displayEarningData;
  }
  else
    chartingEarningsDataSet = chartingEarningsData.datasets[dataIndex];

  chartingEarningsDataSet.backgroundColor = colorRange[modelAsset.colorId];

  if (buildNewDataSet)
    chartingEarningsData.datasets.push(chartingEarningsDataSet);

  chartingEarningsConfig.data = chartingEarningsData;
  return chartingEarningsConfig;
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

    let displayHistoryData = modelAsset.getMetric(Metric.EARNING).displayHistory;

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

  //let reducedModelAssets = charting_reducedModelAssetsForEarnings(portfolio.modelAssets);
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

export function charting_buildFromPortfolio(portfolio, buildNewDataSet, metric1Name, metric2Name) {
  if (portfolio == null || portfolio.modelAssets == null || portfolio.modelAssets.length == 0) {

    logger.log(LogCategory.CHARTING, 'charting_buildFromPortfolio - null or zero length array provided');
    charting_jsonMetric1ChartData = null;
    charting_jsonMetric2ChartData = null;
    charting_jsonRollupChartData = null;
    charting_jsonSpreeadsheetData = null;
    chartMetricConfigCache.clear();

  }
  else {

    setModelAssetColorIds(portfolio.modelAssets);
    charting_jsonMetric1ChartData = charting_buildPortfolioMetric(portfolio, metric1Name, buildNewDataSet);
    charting_jsonMetric2ChartData = charting_buildPortfolioMetric(portfolio, metric2Name, buildNewDataSet);
    charting_jsonRollupChartData = charting_buildPortfolioRollup(portfolio, "cashFlow", buildNewDataSet);

    const markers = charting_buildDateMarkers(portfolio);
    charting_jsonMetric1ChartData.options.plugins.dateMarkers = { markers };
    charting_jsonMetric2ChartData.options.plugins.dateMarkers = { markers };

  }
}

export function charting_buildFromModelAsset(portfolio, modelDisplayName) {

    setModelAssetColorIds(portfolio.modelAssets);
    let modelAsset = findByName(portfolio.modelAssets, modelDisplayName);
    charting_jsonMetricChartConfigIndividual = charting_buildDisplayEarningsFromModelAsset(portfolio.firstDateInt, portfolio.lastDateInt, modelAsset, true);

}

