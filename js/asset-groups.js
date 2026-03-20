/**
 * asset-groups.js
 *
 * Groups assets by financial category for the portfolio sidebar and chart.
 * Follows the same pattern as Instrument / InstrumentType / InstrumentMeta:
 *
 *  1. AssetGroup      — frozen enum of group keys
 *  2. AssetGroupMeta  — Map of display metadata, colors, asset-level shades
 *  3. classifyAssetGroup() / classifyAssets() — classification functions
 *  4. sumDisplayHistories() — aggregation for collapsed-group chart datasets
 *  5. getGroupLabel() — phase-aware label via LifeEventMeta.assetGroupLabels
 */

import { Instrument, InstrumentType } from './instruments/instrument.js';

// ── Group enum ──────────────────────────────────────────────────────

export const AssetGroup = Object.freeze({
  ALL:         'all',
  INCOME:      'income',
  REAL_ESTATE: 'realestate',
  CAPITAL:     'capital',
  RETIREMENT:  'retirement',
  OUTFLOWS:    'outflows',
  TAXES:       'taxes',
});

// ── Classification Sets ─────────────────────────────────────────────

const INCOME_SET = new Set([
  Instrument.WORKING_INCOME,
  Instrument.RETIREMENT_INCOME,
]);

const REAL_ESTATE_SET = new Set([
  Instrument.REAL_ESTATE,
  Instrument.MORTGAGE,
]);

const RETIREMENT_SET = new Set([
  Instrument.FOUR_01K,
  Instrument.IRA,
  Instrument.ROTH_IRA,
]);

const OUTFLOWS_SET = new Set([
  Instrument.MONTHLY_EXPENSE,
  Instrument.DEBT,
]);

// Everything not in the above four groups falls into CAPITAL.

// ── Display metadata ────────────────────────────────────────────────

export const AssetGroupMeta = new Map([
  [AssetGroup.ALL, {
    label:      'All',
    groupEmoji: '📋',
    chartColor: '#6B7280',
    chartColorFill: 'rgba(107, 114, 128, 0.10)',
    headerBg:   '#F3F4F6',
    headerFg:   '#374151',
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
  [AssetGroup.INCOME, {
    label:      'Income',
    groupEmoji: '💰',
    chartColor: '#1D9E75',
    chartColorFill: 'rgba(29, 158, 117, 0.10)',
    headerBg:   '#E1F5EE',
    headerFg:   '#085041',
    assetShades: new Map([
      [Instrument.WORKING_INCOME,    '#1D9E75'],
      [Instrument.RETIREMENT_INCOME, '#5DCAA5'],
    ]),
  }],
  [AssetGroup.REAL_ESTATE, {
    label:      'Real estate',
    groupEmoji: '🏠',
    chartColor: '#378ADD',
    chartColorFill: 'rgba(55, 138, 221, 0.10)',
    headerBg:   '#E6F1FB',
    headerFg:   '#0C447C',
    assetShades: new Map([
      [Instrument.REAL_ESTATE, '#378ADD'],
      [Instrument.MORTGAGE,    '#85B7EB'],
    ]),
  }],
  [AssetGroup.CAPITAL, {
    label:      'Capital',
    groupEmoji: '📊',
    chartColor: '#7F77DD',
    chartColorFill: 'rgba(127, 119, 221, 0.10)',
    headerBg:   '#EEEDFE',
    headerFg:   '#3C3489',
    assetShades: new Map([
      [Instrument.FOUR_01K,        '#7F77DD'],
      [Instrument.IRA,             '#6B63C7'],
      [Instrument.ROTH_IRA,        '#9B8FE8'],
      [Instrument.TAXABLE_EQUITY,  '#AFA9EC'],
      [Instrument.BANK,            '#B8B3F0'],
      [Instrument.US_BOND,         '#C5C1F4'],
      [Instrument.CORP_BOND,       '#D2CFF8'],
      [Instrument.CASH,            '#DFDCFC'],
    ]),
  }],
  [AssetGroup.RETIREMENT, {
    label:      'Retirement',
    groupEmoji: '🏖️',
    chartColor: '#8B5CF6',
    chartColorFill: 'rgba(139, 92, 246, 0.10)',
    headerBg:   '#EDE9FE',
    headerFg:   '#5B21B6',
    assetShades: new Map([
      [Instrument.FOUR_01K,  '#8B5CF6'],
      [Instrument.IRA,       '#A78BFA'],
      [Instrument.ROTH_IRA,  '#C4B5FD'],
    ]),
  }],
  [AssetGroup.OUTFLOWS, {
    label:      'Outflows',
    groupEmoji: '💸',
    chartColor: '#E24B4A',
    chartColorFill: 'rgba(226, 75, 74, 0.10)',
    headerBg:   '#FCEBEB',
    headerFg:   '#791F1F',
    assetShades: new Map([
      [Instrument.MONTHLY_EXPENSE, '#E24B4A'],
      [Instrument.DEBT,            '#F09595'],
    ]),
  }],
  [AssetGroup.TAXES, {
    label:      'Taxes',
    groupEmoji: '🏛️',
    chartColor: '#B8963E',
    chartColorFill: 'rgba(184, 150, 62, 0.10)',
    headerBg:   '#F8F2E0',
    headerFg:   '#633806',
    assetShades: new Map(),  // virtual group — no instrument-backed assets
  }],
]);

// ── Tax items (virtual — rendered from portfolio metrics) ───────────

export const TaxItem = Object.freeze({
  FICA:           'fica',
  INCOME_TAX:     'incomeTax',
  CAPITAL_GAINS:  'capitalGains',
  PROPERTY_TAX:   'propertyTax',
});

export const TaxItemMeta = new Map([
  [TaxItem.FICA,          { label: 'FICA / Medicare', emoji: '🏥' }],
  [TaxItem.INCOME_TAX,    { label: 'Income Tax',      emoji: '📄' }],
  [TaxItem.CAPITAL_GAINS, { label: 'Capital Gains',   emoji: '📉' }],
  [TaxItem.PROPERTY_TAX,  { label: 'Property Tax',    emoji: '🏘️' }],
]);

// ── Classification functions ────────────────────────────────────────

/**
 * Returns the AssetGroup key for a given instrument.
 * Does NOT check isClosed — caller should check that first.
 */
export function classifyAssetGroup(instrument) {
  if (INCOME_SET.has(instrument))      return AssetGroup.INCOME;
  if (REAL_ESTATE_SET.has(instrument)) return AssetGroup.REAL_ESTATE;
  if (RETIREMENT_SET.has(instrument))  return AssetGroup.RETIREMENT;
  if (OUTFLOWS_SET.has(instrument))    return AssetGroup.OUTFLOWS;
  return AssetGroup.CAPITAL;
}

/**
 * Classifies an array of ModelAssets into groups.
 * Returns Map<AssetGroup, ModelAsset[]> — only includes non-empty groups.
 * Assets stay in their natural instrument group.
 * Each asset gets a `_isClosedAtDate` flag so the UI can ghost closed assets.
 * ALL group contains every asset sorted alphabetically.
 * TAXES group is never populated here (it's rendered from portfolio metrics).
 *
 * @param {ModelAsset[]} modelAssets
 * @param {DateInt} [atDateInt] — if provided, determine closed state based on
 *   whether the asset's date range includes this date (not just final isClosed state)
 */
export function classifyAssets(modelAssets, atDateInt) {
  const groups = new Map();
  const atInt = atDateInt?.toInt?.();

  for (const asset of modelAssets) {
    if (atInt != null) {
      const start = asset.startDateInt.toInt();
      const finish = asset.effectiveFinishDateInt.toInt();
      const closedEarly = asset.closedDateInt && atInt >= asset.closedDateInt.toInt();
      asset._isClosedAtDate = atInt < start || atInt > finish || closedEarly;
    } else {
      asset._isClosedAtDate = asset.isClosed;
    }

    const groupKey = classifyAssetGroup(asset.instrument);

    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(asset);
  }

  // ALL group: every asset, sorted alphabetically
  const allSorted = [...modelAssets].sort((a, b) =>
    a.displayName.localeCompare(b.displayName)
  );
  groups.set(AssetGroup.ALL, allSorted);

  // Sort each instrument group by sortOrder
  for (const [key, assets] of groups) {
    if (key !== AssetGroup.ALL) {
      assets.sort((a, b) => InstrumentType.sortOrder(a.instrument) - InstrumentType.sortOrder(b.instrument));
    }
  }

  return groups;
}

/** Phase-aware display orders for groups in the sidebar and chart legend. */
export const GROUP_ORDER_ACCUMULATE = [
  AssetGroup.ALL,
  AssetGroup.INCOME,
  AssetGroup.REAL_ESTATE,
  AssetGroup.CAPITAL,
  AssetGroup.RETIREMENT,
  AssetGroup.OUTFLOWS,
  AssetGroup.TAXES,
];

export const GROUP_ORDER_RETIRE = [
  AssetGroup.ALL,
  AssetGroup.RETIREMENT,
  AssetGroup.CAPITAL,
  AssetGroup.REAL_ESTATE,
  AssetGroup.OUTFLOWS,
  AssetGroup.TAXES,
  AssetGroup.INCOME,
];

// Legacy export — defaults to accumulation order
export const GROUP_DISPLAY_ORDER = GROUP_ORDER_ACCUMULATE;

// ── Aggregation utilities ───────────────────────────────────────────

/**
 * Element-wise sum of getDisplayHistory() arrays for a set of assets.
 * Used to build a single collapsed-group dataset for the chart.
 */
export function sumDisplayHistories(assets, metricName) {
  if (assets.length === 0) return [];

  const histories = assets.map(a => a.getDisplayHistory(metricName));
  const maxLen = Math.max(...histories.map(h => h.length));
  const result = new Array(maxLen).fill(0);

  for (const h of histories) {
    for (let i = 0; i < h.length; i++) {
      result[i] += (h[i] ?? 0);
    }
  }
  return result;
}

// ── Phase-aware labels ──────────────────────────────────────────────

/**
 * Returns the display label for a group within a life event phase.
 * Falls back to the group's default label if the event doesn't define one.
 *
 * @param {string} assetGroupKey — e.g. AssetGroup.INCOME
 * @param {ModelLifeEvent|null} lifeEvent — current phase
 * @returns {string} — e.g. "Income" or "Distributions"
 */
export function getGroupLabel(assetGroupKey, lifeEvent) {
  const meta = AssetGroupMeta.get(assetGroupKey);
  if (!meta) return assetGroupKey;

  if (lifeEvent?.meta?.assetGroupLabels) {
    const phaseLabel = lifeEvent.meta.assetGroupLabels[assetGroupKey];
    if (phaseLabel) return phaseLabel;
  }

  return meta.label;
}

/**
 * Returns the stable chart color for an individual asset.
 * Looks up the instrument's shade within its group's color family.
 * Falls back to the group's primary chartColor.
 */
export function getAssetChartColor(instrument) {
  const groupKey = classifyAssetGroup(instrument);
  const groupMeta = AssetGroupMeta.get(groupKey);
  return groupMeta?.assetShades.get(instrument) ?? groupMeta?.chartColor ?? '#888780';
}
