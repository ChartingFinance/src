/**
 * property-groups.js
 *
 * Groups assets by financial action (what they DO) rather than instrument type.
 * An asset can appear in multiple property groups because it may generate income,
 * incur taxes, and hold capital simultaneously.
 *
 * Classification is instrument-based (deterministic), not data-driven.
 * Display order is phase-aware: accumulation vs retirement priorities differ.
 *
 * Rollup metrics align with the Metric DAG in metric.js — each group's rollup
 * is the DAG root that captures all leaf activity for that financial action.
 *
 * Follows the same enum + meta + classify pattern as asset-groups.js.
 */

import { Metric } from './metric.js';
import { Instrument, InstrumentType } from './instruments/instrument.js';

// ── Property Group enum ─────────────────────────────────────────────
// Keys use 'prop_' prefix to avoid collision with AssetGroup keys
// when both coexist in the same expandedGroups Set.

export const PropertyGroup = Object.freeze({
  ALL:          'prop_all',
  INCOME:       'prop_income',
  TAX:          'prop_tax',
  EXPENSE:      'prop_expense',
  RETIREMENT:   'prop_retirement',
  CAPITAL:      'prop_capital',
  DEBT_SERVICE: 'prop_debtService',
  CASH_FLOW:    'prop_cashFlow',
  GROWTH:       'prop_growth',
});

// ── Phase-aware display order ────────────────────────────────────────

export const PROPERTY_ORDER_ACCUMULATE = [
  PropertyGroup.ALL,
  PropertyGroup.INCOME,
  PropertyGroup.CAPITAL,
  PropertyGroup.RETIREMENT,
  PropertyGroup.TAX,
  PropertyGroup.EXPENSE,
  PropertyGroup.DEBT_SERVICE,
  PropertyGroup.CASH_FLOW,
  PropertyGroup.GROWTH,
];

export const PROPERTY_ORDER_RETIRE = [
  PropertyGroup.ALL,
  PropertyGroup.RETIREMENT,
  PropertyGroup.INCOME,
  PropertyGroup.EXPENSE,
  PropertyGroup.TAX,
  PropertyGroup.CAPITAL,
  PropertyGroup.DEBT_SERVICE,
  PropertyGroup.CASH_FLOW,
  PropertyGroup.GROWTH,
];

// Legacy export — defaults to accumulation order
export const PROPERTY_DISPLAY_ORDER = PROPERTY_ORDER_ACCUMULATE;

// ── Instrument-based classification Sets ─────────────────────────────
// Deterministic: an instrument always belongs to the same groups.
// An asset appears in every group whose Set contains its instrument.

const INCOME_SET = new Set([
  Instrument.WORKING_INCOME,
  Instrument.RETIREMENT_INCOME,
  Instrument.TAXABLE_EQUITY,       // dividends
  Instrument.BANK,                 // interest income
  Instrument.US_BOND,              // interest income
  Instrument.CORP_BOND,            // interest income
]);

const TAX_SET = new Set([
  Instrument.WORKING_INCOME,       // FICA + income tax withholding
  Instrument.REAL_ESTATE,          // property tax + capital gains tax on sale
  Instrument.TAXABLE_EQUITY,       // capital gains tax, estimated income tax
  Instrument.FOUR_01K,             // tax on distributions
  Instrument.IRA,                  // tax on distributions
  Instrument.BANK,                 // estimated income tax (monthly true-up)
  Instrument.US_BOND,              // estimated income tax (monthly true-up)
  Instrument.CORP_BOND,            // estimated income tax (monthly true-up)
]);

const EXPENSE_SET = new Set([
  Instrument.MONTHLY_EXPENSE,      // direct expenses
  Instrument.REAL_ESTATE,          // maintenance, insurance, mortgage interest → expense
  Instrument.MORTGAGE,             // mortgage interest → interest expense → expense
  Instrument.DEBT,                 // interest expense
]);

const RETIREMENT_SET = new Set([
  Instrument.FOUR_01K,
  Instrument.IRA,
  Instrument.ROTH_IRA,
]);

const CAPITAL_SET = new Set([
  Instrument.REAL_ESTATE,
  Instrument.TAXABLE_EQUITY,
  Instrument.FOUR_01K,
  Instrument.IRA,
  Instrument.ROTH_IRA,
  Instrument.BANK,
  Instrument.US_BOND,
  Instrument.CORP_BOND,
  Instrument.CASH,
]);

const DEBT_SERVICE_SET = new Set([
  Instrument.MORTGAGE,
  Instrument.DEBT,
]);

// Map group → instrument Set (excludes ALL, CASH_FLOW, GROWTH which are special)
const GROUP_INSTRUMENT_SETS = new Map([
  [PropertyGroup.INCOME,       INCOME_SET],
  [PropertyGroup.TAX,          TAX_SET],
  [PropertyGroup.EXPENSE,      EXPENSE_SET],
  [PropertyGroup.RETIREMENT,   RETIREMENT_SET],
  [PropertyGroup.CAPITAL,      CAPITAL_SET],
  [PropertyGroup.DEBT_SERVICE, DEBT_SERVICE_SET],
]);

// ── Metrics per group (for card display & dropdown filtering) ────────
// These are the metrics available in the micro chart dropdown when
// a property group is expanded. Ordered from most-specific to rollup.

export const PropertyGroupMetrics = new Map([
  [PropertyGroup.ALL, [
    Metric.VALUE,
  ]],
  [PropertyGroup.INCOME, [
    Metric.INCOME, Metric.NET_INCOME,
    Metric.EMPLOYED_INCOME, Metric.SELF_INCOME,
    Metric.QUALIFIED_DIVIDEND, Metric.NON_QUALIFIED_DIVIDEND,
    Metric.INTEREST_INCOME, Metric.SOCIAL_SECURITY_INCOME,
    Metric.SHORT_TERM_CAPITAL_GAIN, Metric.LONG_TERM_CAPITAL_GAIN,
    Metric.ORDINARY_INCOME, Metric.CAPITAL_GAIN,
  ]],
  [PropertyGroup.TAX, [
    Metric.TAXES, Metric.FEDERAL_TAXES, Metric.SALT_TAXES,
    Metric.INCOME_TAX, Metric.WITHHELD_FICA_TAX,
    Metric.SOCIAL_SECURITY_TAX, Metric.MEDICARE_TAX,
    Metric.WITHHELD_INCOME_TAX, Metric.ESTIMATED_INCOME_TAX,
    Metric.SHORT_TERM_CAPITAL_GAIN_TAX, Metric.LONG_TERM_CAPITAL_GAIN_TAX,
    Metric.PROPERTY_TAX,
  ]],
  [PropertyGroup.EXPENSE, [
    Metric.EXPENSE,
    Metric.INTEREST_EXPENSE, Metric.MORTGAGE_INTEREST,
    Metric.MAINTENANCE, Metric.INSURANCE,
  ]],
  [PropertyGroup.RETIREMENT, [
    Metric.VALUE,
    Metric.CONTRIBUTION, Metric.PRETAX_CONTRIBUTION, Metric.POSTTAX_CONTRIBUTION,
    Metric.FOUR_01K_CONTRIBUTION, Metric.TRAD_IRA_CONTRIBUTION, Metric.ROTH_IRA_CONTRIBUTION,
    Metric.TAXABLE_DISTRIBUTION, Metric.TAX_FREE_DISTRIBUTION,
    Metric.FOUR_01K_DISTRIBUTION, Metric.TRAD_IRA_DISTRIBUTION, Metric.ROTH_IRA_DISTRIBUTION,
    Metric.RMD,
  ]],
  [PropertyGroup.CAPITAL, [
    Metric.VALUE, Metric.GROWTH,
    Metric.SHORT_TERM_CAPITAL_GAIN, Metric.LONG_TERM_CAPITAL_GAIN, Metric.CAPITAL_GAIN,
  ]],
  [PropertyGroup.DEBT_SERVICE, [
    Metric.MORTGAGE_PAYMENT, Metric.MORTGAGE_INTEREST, Metric.MORTGAGE_PRINCIPAL,
  ]],
  [PropertyGroup.CASH_FLOW, [
    Metric.CASH_FLOW, Metric.CASH_FLOW_ACCUMULATED,
  ]],
  [PropertyGroup.GROWTH, [
    Metric.GROWTH,
  ]],
]);

// ── Rollup metrics per group (for chart aggregation & header totals) ─
// Each entry is the DAG root(s) that capture all leaf activity for the group.
// Using DAG roots avoids double-counting and stays aligned with metric.js.

export const PropertyGroupRollupMetrics = new Map([
  [PropertyGroup.ALL,          [Metric.VALUE]],
  [PropertyGroup.INCOME,       [Metric.INCOME]],
  [PropertyGroup.TAX,          [Metric.TAXES]],
  [PropertyGroup.EXPENSE,      [Metric.EXPENSE]],
  [PropertyGroup.RETIREMENT,   [Metric.VALUE]],
  [PropertyGroup.CAPITAL,      [Metric.VALUE]],
  [PropertyGroup.DEBT_SERVICE, [Metric.MORTGAGE_PAYMENT]],
  [PropertyGroup.CASH_FLOW,    [Metric.CASH_FLOW]],
  [PropertyGroup.GROWTH,       [Metric.GROWTH]],
]);

// ── Display metadata ────────────────────────────────────────────────

export const PropertyGroupMeta = new Map([
  [PropertyGroup.ALL, {
    label: 'All',            groupEmoji: '📋',
    chartColor: '#6B7280', chartColorFill: 'rgba(107, 114, 128, 0.10)',
    headerBg: '#F3F4F6',   headerFg: '#374151',
    assetShades: new Map([
      [Instrument.WORKING_INCOME,    '#4B5563'],
      [Instrument.RETIREMENT_INCOME, '#6B7280'],
      [Instrument.REAL_ESTATE,       '#555E6B'],
      [Instrument.MORTGAGE,          '#7C8590'],
      [Instrument.TAXABLE_EQUITY,    '#5E6773'],
      [Instrument.FOUR_01K,          '#8B939D'],
      [Instrument.IRA,               '#68717C'],
      [Instrument.ROTH_IRA,          '#9BA2AB'],
      [Instrument.BANK,              '#727B85'],
      [Instrument.US_BOND,           '#A3AAB2'],
      [Instrument.CORP_BOND,         '#ACB3BA'],
      [Instrument.CASH,              '#B5BBC2'],
      [Instrument.MONTHLY_EXPENSE,   '#BEC4CA'],
      [Instrument.DEBT,              '#C7CCD1'],
    ]),
  }],
  [PropertyGroup.INCOME, {
    label: 'Income',       groupEmoji: '💰',
    chartColor: '#1D9E75', chartColorFill: 'rgba(29, 158, 117, 0.10)',
    headerBg: '#E1F5EE',   headerFg: '#085041',
    assetShades: new Map([
      [Instrument.WORKING_INCOME,    '#1D9E75'],
      [Instrument.RETIREMENT_INCOME, '#3DB890'],
      [Instrument.TAXABLE_EQUITY,    '#5DCAA5'],
      [Instrument.BANK,              '#7DD8B8'],
      [Instrument.US_BOND,           '#9DE5CB'],
      [Instrument.CORP_BOND,         '#BDF0DD'],
    ]),
  }],
  [PropertyGroup.TAX, {
    label: 'Tax',          groupEmoji: '🏛️',
    chartColor: '#B8963E', chartColorFill: 'rgba(184, 150, 62, 0.10)',
    headerBg: '#F8F2E0',   headerFg: '#633806',
    assetShades: new Map([
      [Instrument.WORKING_INCOME,    '#B8963E'],
      [Instrument.REAL_ESTATE,       '#C9AA5C'],
      [Instrument.TAXABLE_EQUITY,    '#D4BB75'],
      [Instrument.FOUR_01K,          '#DECC8E'],
      [Instrument.IRA,               '#E8DCA8'],
      [Instrument.BANK,              '#EEEAC0'],
      [Instrument.US_BOND,           '#F3F0D0'],
      [Instrument.CORP_BOND,         '#F8F5E0'],
    ]),
  }],
  [PropertyGroup.EXPENSE, {
    label: 'Expenses',     groupEmoji: '💸',
    chartColor: '#E24B4A', chartColorFill: 'rgba(226, 75, 74, 0.10)',
    headerBg: '#FCEBEB',   headerFg: '#791F1F',
    assetShades: new Map([
      [Instrument.MONTHLY_EXPENSE,   '#E24B4A'],
      [Instrument.REAL_ESTATE,       '#EB7575'],
      [Instrument.MORTGAGE,          '#F09595'],
      [Instrument.DEBT,              '#F5B0B0'],
    ]),
  }],
  [PropertyGroup.RETIREMENT, {
    label: 'Retirement',   groupEmoji: '🏖️',
    chartColor: '#8B5CF6', chartColorFill: 'rgba(139, 92, 246, 0.10)',
    headerBg: '#EDE9FE',   headerFg: '#5B21B6',
    assetShades: new Map([
      [Instrument.FOUR_01K,          '#8B5CF6'],
      [Instrument.IRA,               '#A78BFA'],
      [Instrument.ROTH_IRA,          '#C4B5FD'],
    ]),
  }],
  [PropertyGroup.CAPITAL, {
    label: 'Capital',      groupEmoji: '📊',
    chartColor: '#7F77DD', chartColorFill: 'rgba(127, 119, 221, 0.10)',
    headerBg: '#EEEDFE',   headerFg: '#3C3489',
    assetShades: new Map([
      [Instrument.REAL_ESTATE,       '#6B63C7'],
      [Instrument.TAXABLE_EQUITY,    '#7F77DD'],
      [Instrument.FOUR_01K,          '#9B8FE8'],
      [Instrument.IRA,               '#AFA9EC'],
      [Instrument.ROTH_IRA,          '#B8B3F0'],
      [Instrument.BANK,              '#C5C1F4'],
      [Instrument.US_BOND,           '#D2CFF8'],
      [Instrument.CORP_BOND,         '#DFDCFC'],
      [Instrument.CASH,              '#E8E5FE'],
    ]),
  }],
  [PropertyGroup.DEBT_SERVICE, {
    label: 'Debt Service',  groupEmoji: '🔑',
    chartColor: '#D97706', chartColorFill: 'rgba(217, 119, 6, 0.10)',
    headerBg: '#FEF3C7',   headerFg: '#92400E',
    assetShades: new Map([
      [Instrument.MORTGAGE,          '#D97706'],
      [Instrument.DEBT,              '#F59E0B'],
    ]),
  }],
  [PropertyGroup.CASH_FLOW, {
    label: 'Cash Flow',    groupEmoji: '💵',
    chartColor: '#059669', chartColorFill: 'rgba(5, 150, 105, 0.10)',
    headerBg: '#D1FAE5',   headerFg: '#065F46',
    assetShades: new Map(),
  }],
  [PropertyGroup.GROWTH, {
    label: 'Growth',       groupEmoji: '📈',
    chartColor: '#10B981', chartColorFill: 'rgba(16, 185, 129, 0.10)',
    headerBg: '#D1FAE5',   headerFg: '#065F46',
    assetShades: new Map(),
  }],
]);

// ── Special (asset-less) groups ─────────────────────────────────────
// These groups have no instrument members — they show aggregate metrics only.
// When expanded in Micro chart, all assets are shown.

export const ASSET_LESS_GROUPS = new Set([
  PropertyGroup.CASH_FLOW,
  PropertyGroup.GROWTH,
]);

// ── Classification function ─────────────────────────────────────────

/**
 * Classifies assets into property groups based on instrument type.
 * An asset can appear in multiple groups. Deterministic — no data scanning.
 * ALL group always contains all assets, sorted alphabetically.
 * CASH_FLOW and GROWTH are asset-less (handled separately by UI).
 *
 * @param {ModelAsset[]} modelAssets
 * @returns {Map<string, ModelAsset[]>}
 */
export function classifyAssetsByProperty(modelAssets) {
  const groups = new Map();

  // ALL group: every asset, sorted alphabetically
  const allSorted = [...modelAssets].sort((a, b) =>
    a.displayName.localeCompare(b.displayName)
  );
  groups.set(PropertyGroup.ALL, allSorted);

  // Instrument-based groups
  for (const [groupKey, instrumentSet] of GROUP_INSTRUMENT_SETS) {
    const members = modelAssets.filter(a => instrumentSet.has(a.instrument));
    if (members.length > 0) {
      // Sort by instrument sortOrder within each group
      members.sort((a, b) =>
        InstrumentType.sortOrder(a.instrument) - InstrumentType.sortOrder(b.instrument)
      );
      groups.set(groupKey, members);
    }
  }

  // CASH_FLOW and GROWTH are asset-less — no members, but included
  // in display order. UI renders them as rollup-only headers.

  return groups;
}

// ── Primary metric for asset card display ───────────────────────────

/**
 * Returns the primary metric to display for an asset within a property group.
 * Picks the first rollup metric that the asset actually tracks (has real history).
 */
export function getPrimaryMetric(asset, groupKey) {
  const rollups = PropertyGroupRollupMetrics.get(groupKey);
  if (!rollups) return Metric.VALUE;
  for (const m of rollups) {
    const h = asset.getHistory?.(m);
    if (h && h.length > 0) return m;
  }
  return rollups[0] ?? Metric.VALUE;
}

// ── Aggregation for charts ──────────────────────────────────────────

/**
 * Sums the rollup metric(s) across assets for a property group.
 * For asset-less groups (Cash Flow, Growth), sums across ALL provided assets.
 * Returns a single array suitable for a collapsed macro chart dataset.
 */
export function sumPropertyDisplayHistories(assets, groupKey, allAssets) {
  const rollupMetrics = PropertyGroupRollupMetrics.get(groupKey);
  if (!rollupMetrics) return [];

  // Asset-less groups sum across all assets
  const source = ASSET_LESS_GROUPS.has(groupKey) ? (allAssets || assets) : assets;

  let maxLen = 0;
  for (const asset of source) {
    for (const m of rollupMetrics) {
      const h = asset.getDisplayHistory(m);
      if (h && h.length > maxLen) maxLen = h.length;
    }
  }

  const result = new Array(maxLen).fill(0);
  for (const asset of source) {
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
 * For asset-less groups, pass allAssets to sum across the full portfolio.
 * Used for group header display.
 */
export function computePropertyRollupAtIndex(assets, groupKey, historyIndex, allAssets) {
  if (historyIndex < 0) return 0;
  const rollupMetrics = PropertyGroupRollupMetrics.get(groupKey);
  if (!rollupMetrics) return 0;

  const source = ASSET_LESS_GROUPS.has(groupKey) ? (allAssets || assets) : assets;

  let total = 0;
  for (const asset of source) {
    for (const m of rollupMetrics) {
      const history = asset.getHistory(m);
      if (history && historyIndex < history.length) {
        total += (history[historyIndex] ?? 0);
      }
    }
  }
  return total;
}