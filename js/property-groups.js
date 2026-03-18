/**
 * property-groups.js
 *
 * Groups assets by financial action (what they DO) rather than instrument type.
 * An asset can appear in multiple property groups because it may generate income,
 * incur taxes, and hold capital simultaneously.
 *
 * Follows the same enum + meta + classify pattern as asset-groups.js.
 */

import { Metric, MetricLabel } from './model-asset.js';

// ── Property Group enum ─────────────────────────────────────────────
// Keys use 'prop_' prefix to avoid collision with AssetGroup keys
// when both coexist in the same expandedGroups Set.

export const PropertyGroup = Object.freeze({
  CAPITAL:      'prop_capital',
  INCOME:       'prop_income',
  TAX:          'prop_tax',
  EXPENSES:     'prop_expenses',
  RETIREMENT:   'prop_retirement',
  DEBT_SERVICE: 'prop_debtService',
  CASH_FLOW:    'prop_cashFlow',
});

// ── Display order ───────────────────────────────────────────────────

export const PROPERTY_DISPLAY_ORDER = [
  PropertyGroup.CAPITAL,
  PropertyGroup.INCOME,
  PropertyGroup.TAX,
  PropertyGroup.EXPENSES,
  PropertyGroup.RETIREMENT,
  PropertyGroup.DEBT_SERVICE,
  PropertyGroup.CASH_FLOW,
];

// ── Classification metrics per group ────────────────────────────────
// An asset belongs to a group if any of these metrics have non-zero history.

export const PropertyGroupMetrics = new Map([
  [PropertyGroup.CAPITAL, [
    Metric.VALUE, Metric.GROWTH,
  ]],
  [PropertyGroup.INCOME, [
    Metric.DIVIDEND, Metric.WORKING_INCOME, Metric.INTEREST_INCOME,
    Metric.SOCIAL_SECURITY_INCOME,
  ]],
  [PropertyGroup.TAX, [
    Metric.WITHHELD_FICA_TAX, Metric.INCOME_TAX, Metric.CAPITAL_GAIN_TAX,
    Metric.PROPERTY_TAX, Metric.ESTIMATED_INCOME_TAX,
  ]],
  [PropertyGroup.EXPENSES, [
    Metric.EXPENSE,
  ]],
  [PropertyGroup.RETIREMENT, [
    Metric.TRAD_IRA_CONTRIBUTION, Metric.ROTH_IRA_CONTRIBUTION,
    Metric.FOUR_01K_CONTRIBUTION, Metric.TRAD_IRA_DISTRIBUTION,
    Metric.ROTH_IRA_DISTRIBUTION, Metric.FOUR_01K_DISTRIBUTION,
    Metric.RMD,
  ]],
  [PropertyGroup.DEBT_SERVICE, [
    Metric.MORTGAGE_PAYMENT, Metric.MORTGAGE_INTEREST,
    Metric.MORTGAGE_PRINCIPAL, Metric.MORTGAGE_ESCROW,
  ]],
  [PropertyGroup.CASH_FLOW, [
    Metric.CASH_FLOW, Metric.CASH_FLOW_ACCUMULATED,
  ]],
]);

// ── Rollup metrics per group (for chart aggregation) ────────────────
// Uses top-level rollup metrics to avoid double-counting from MetricRollups.
// null means sum leaf metrics individually (Retirement).

export const PropertyGroupRollupMetrics = new Map([
  [PropertyGroup.CAPITAL,      [Metric.VALUE]],
  [PropertyGroup.INCOME,       [Metric.INCOME]],
  [PropertyGroup.TAX,          [Metric.INCOME_TAX, Metric.CAPITAL_GAIN_TAX]],
  [PropertyGroup.EXPENSES,     [Metric.EXPENSE]],
  [PropertyGroup.RETIREMENT,   [
    Metric.TRAD_IRA_CONTRIBUTION, Metric.ROTH_IRA_CONTRIBUTION,
    Metric.FOUR_01K_CONTRIBUTION, Metric.TRAD_IRA_DISTRIBUTION,
    Metric.ROTH_IRA_DISTRIBUTION, Metric.FOUR_01K_DISTRIBUTION,
    Metric.RMD,
  ]],
  [PropertyGroup.DEBT_SERVICE, [Metric.MORTGAGE_PAYMENT]],
  [PropertyGroup.CASH_FLOW,    [Metric.CASH_FLOW]],
]);

// ── Display metadata ────────────────────────────────────────────────

export const PropertyGroupMeta = new Map([
  [PropertyGroup.CAPITAL, {
    label: 'Capital',      groupEmoji: '📊',
    chartColor: '#7F77DD', chartColorFill: 'rgba(127, 119, 221, 0.10)',
    headerBg: '#EEEDFE',   headerFg: '#3C3489',
  }],
  [PropertyGroup.INCOME, {
    label: 'Income',       groupEmoji: '💰',
    chartColor: '#1D9E75', chartColorFill: 'rgba(29, 158, 117, 0.10)',
    headerBg: '#E1F5EE',   headerFg: '#085041',
  }],
  [PropertyGroup.TAX, {
    label: 'Tax',          groupEmoji: '🏛️',
    chartColor: '#B8963E', chartColorFill: 'rgba(184, 150, 62, 0.10)',
    headerBg: '#F8F2E0',   headerFg: '#633806',
  }],
  [PropertyGroup.EXPENSES, {
    label: 'Expenses',     groupEmoji: '💸',
    chartColor: '#E24B4A', chartColorFill: 'rgba(226, 75, 74, 0.10)',
    headerBg: '#FCEBEB',   headerFg: '#791F1F',
  }],
  [PropertyGroup.RETIREMENT, {
    label: 'Retirement',   groupEmoji: '🏖️',
    chartColor: '#378ADD', chartColorFill: 'rgba(55, 138, 221, 0.10)',
    headerBg: '#E6F1FB',   headerFg: '#0C447C',
  }],
  [PropertyGroup.DEBT_SERVICE, {
    label: 'Debt Service',  groupEmoji: '🏦',
    chartColor: '#D97706', chartColorFill: 'rgba(217, 119, 6, 0.10)',
    headerBg: '#FEF3C7',   headerFg: '#92400E',
  }],
  [PropertyGroup.CASH_FLOW, {
    label: 'Cash Flow',    groupEmoji: '💵',
    chartColor: '#059669', chartColorFill: 'rgba(5, 150, 105, 0.10)',
    headerBg: '#D1FAE5',   headerFg: '#065F46',
  }],
]);

// ── Classification function ─────────────────────────────────────────

/**
 * Classifies assets into property groups based on non-zero metric history.
 * An asset can appear in multiple groups.
 * @param {ModelAsset[]} modelAssets
 * @returns {Map<string, ModelAsset[]>}
 */
export function classifyAssetsByProperty(modelAssets) {
  const groups = new Map();

  for (const [groupKey, metricNames] of PropertyGroupMetrics) {
    const members = [];
    for (const asset of modelAssets) {
      if (_assetHasNonZeroMetrics(asset, metricNames)) {
        members.push(asset);
      }
    }
    if (members.length > 0) {
      groups.set(groupKey, members);
    }
  }
  return groups;
}

function _assetHasNonZeroMetrics(asset, metricNames) {
  for (const metricName of metricNames) {
    const history = asset.getHistory(metricName);
    if (history && history.length > 0 && history.some(v => v !== 0)) {
      return true;
    }
  }
  return false;
}

// ── Primary metric for asset card display ───────────────────────────

/**
 * Returns the first metric from the group's classification list
 * where the asset has non-zero data. Used for card display.
 */
export function getPrimaryMetric(asset, groupKey) {
  const metricNames = PropertyGroupMetrics.get(groupKey);
  if (!metricNames) return Metric.VALUE;

  for (const m of metricNames) {
    const history = asset.getHistory(m);
    if (history && history.length > 0 && history.some(v => v !== 0)) {
      return m;
    }
  }
  return metricNames[0]; // fallback
}

// ── Aggregation for charts ──────────────────────────────────────────

/**
 * Sums the rollup metric(s) across assets for a property group.
 * Returns a single array suitable for a collapsed macro chart dataset.
 */
export function sumPropertyDisplayHistories(assets, groupKey) {
  const rollupMetrics = PropertyGroupRollupMetrics.get(groupKey);
  if (!rollupMetrics) return [];

  let maxLen = 0;
  for (const asset of assets) {
    for (const m of rollupMetrics) {
      const h = asset.getDisplayHistory(m);
      if (h && h.length > maxLen) maxLen = h.length;
    }
  }

  const result = new Array(maxLen).fill(0);
  for (const asset of assets) {
    for (const m of rollupMetrics) {
      const h = asset.getDisplayHistory(m);
      if (!h) continue;
      for (let i = 0; i < h.length; i++) {
        result[i] += (h[i] ?? 0);
      }
    }
  }
  return result;
}

/**
 * Computes rollup total at a specific history index for a property group.
 * Used for group header display.
 */
export function computePropertyRollupAtIndex(assets, groupKey, historyIndex) {
  if (historyIndex < 0) return 0;
  const rollupMetrics = PropertyGroupRollupMetrics.get(groupKey);
  if (!rollupMetrics) return 0;

  let total = 0;
  for (const asset of assets) {
    for (const m of rollupMetrics) {
      const history = asset.getHistory(m);
      if (history && historyIndex < history.length) {
        total += (history[historyIndex] ?? 0);
      }
    }
  }
  return total;
}
