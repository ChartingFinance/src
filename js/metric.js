/**
 * metric.js
 *
 * Single source of truth for the Metric identity enum, display labels,
 * and the rollup DAG.  Both model-asset.js and instrument-behavior.js
 * import from here — no duplication, no circular dependencies.
 */

// ── Metric identity enum ─────────────────────────────────────────────

export const Metric = Object.freeze({
  VALUE:                        'value',
  GROWTH:                       'growth',
  QUALIFIED_DIVIDEND:           'qualifiedDividend',
  NON_QUALIFIED_DIVIDEND:       'nonQualifiedDividend',
  INTEREST_INCOME:              'interestIncome',
  ORDINARY_INCOME:              'ordinaryIncome',
  EMPLOYED_INCOME:              'employedIncome',
  SELF_INCOME:                  'selfIncome',
  INCOME:                       'income',
  WITHHELD_FICA_TAX:            'withheldFicaTax',
  ESTIMATED_FICA_TAX:           'estimatedFicaTax',       // reserved: future self-employment enhancement
  WITHHELD_INCOME_TAX:          'withheldIncomeTax',
  ESTIMATED_INCOME_TAX:         'estimatedIncomeTax',
  ESTIMATED_TAX:                'estimatedTax',            // reserved: future self-employment enhancement
  INCOME_TAX:                   'incomeTax',
  FEDERAL_TAXES:                'federalTaxes',
  SALT_TAXES:                   'saltTaxes',
  TAXES:                        'taxes',
  NET_INCOME:                   'netIncome',
  EXPENSE:                      'expense',
  CASH_FLOW:                    'cashFlow',
  CASH_FLOW_ACCUMULATED:        'cashFlowAccumulated',
  SHORT_TERM_CAPITAL_GAIN:      'shortTermCapitalGain',
  LONG_TERM_CAPITAL_GAIN:       'longTermCapitalGain',
  CAPITAL_GAIN:                 'capitalGain', // only long term
  RMD:                          'rmd',
  SOCIAL_SECURITY_TAX:          'socialSecurityTax',
  SOCIAL_SECURITY_INCOME:       'socialSecurityIncome',
  MEDICARE_TAX:                 'medicareTax',
  MORTGAGE_PAYMENT:             'mortgagePayment',
  MORTGAGE_INTEREST:            'mortgageInterest',
  MORTGAGE_PRINCIPAL:           'mortgagePrincipal',
  PROPERTY_TAX:                 'propertyTax',
  CONTRIBUTION:                 'contribution',
  PRETAX_CONTRIBUTION:          'preTaxContribution',
  POSTTAX_CONTRIBUTION:         'postTaxContribution',
  TRAD_IRA_CONTRIBUTION:        'tradIRAContribution',
  ROTH_IRA_CONTRIBUTION:        'rothIRAContribution',
  FOUR_01K_CONTRIBUTION:        'four01KContribution',
  TAX_FREE_DISTRIBUTION:        'taxFreeDistribution', // from roth IRA or post tax cash
  TAXABLE_DISTRIBUTION:         'taxableDistribution', // these are distributions from IRA and 401K accounts
  TRAD_IRA_DISTRIBUTION:        'tradIRADistribution',
  ROTH_IRA_DISTRIBUTION:        'rothIRADistribution',
  FOUR_01K_DISTRIBUTION:        'four01KDistribution',
  SHORT_TERM_CAPITAL_GAIN_TAX:  'shortTermCapitalGainTax',
  LONG_TERM_CAPITAL_GAIN_TAX:   'longTermCapitalGainTax',
  LIVING_EXPENSE:               'livingExpense',
  INTEREST_EXPENSE:             'interestExpense',
  MAINTENANCE:                  'maintenance',
  INSURANCE:                    'insurance',
  CREDIT:                       'credit',
});

export const METRIC_NAMES = Object.values(Metric);

// ── Display labels ───────────────────────────────────────────────────

export const MetricLabel = Object.freeze({
  [Metric.VALUE]:                       'Value',
  [Metric.GROWTH]:                      'Growth',
  [Metric.QUALIFIED_DIVIDEND]:          'Qualified Dividend',
  [Metric.NON_QUALIFIED_DIVIDEND]:      'Non-Qualified Dividend',
  [Metric.INTEREST_INCOME]:             'Interest Income',
  [Metric.ORDINARY_INCOME]:             'Ordinary Income',
  [Metric.EMPLOYED_INCOME]:             'Employed Income',
  [Metric.SELF_INCOME]:                 'Self-Employment Income',
  [Metric.INCOME]:                      'Income',
  [Metric.WITHHELD_FICA_TAX]:           'Withheld FICA / Medicare',
  [Metric.ESTIMATED_FICA_TAX]:          'Estimated FICA / Medicare',
  [Metric.WITHHELD_INCOME_TAX]:         'Withheld Income Tax',
  [Metric.ESTIMATED_INCOME_TAX]:        'Estimated Income Tax',
  [Metric.ESTIMATED_TAX]:               'Estimated Tax',
  [Metric.INCOME_TAX]:                  'Income Tax',
  [Metric.FEDERAL_TAXES]:               'Federal Taxes',
  [Metric.SALT_TAXES]:                  'State and Local Taxes',
  [Metric.TAXES]:                       'All Taxes',
  [Metric.NET_INCOME]:                  'Net Income',
  [Metric.EXPENSE]:                     'Expense',
  [Metric.CASH_FLOW]:                   'Cash Flow',
  [Metric.CASH_FLOW_ACCUMULATED]:       'Cash Flow Accumulated',
  [Metric.SHORT_TERM_CAPITAL_GAIN]:     'Short Term Capital Gain',
  [Metric.LONG_TERM_CAPITAL_GAIN]:      'Long Term Capital Gain',
  [Metric.CAPITAL_GAIN]:                'Capital Gain',
  [Metric.RMD]:                         'Required Min. Distribution',
  [Metric.SOCIAL_SECURITY_TAX]:         'Social Security Tax',
  [Metric.SOCIAL_SECURITY_INCOME]:      'Social Security Income',
  [Metric.MEDICARE_TAX]:                'Medicare Tax',
  [Metric.MORTGAGE_PAYMENT]:            'Mortgage Payment',
  [Metric.MORTGAGE_INTEREST]:           'Mortgage Interest',
  [Metric.MORTGAGE_PRINCIPAL]:          'Mortgage Principal',
  [Metric.CONTRIBUTION]:                'Contribution',
  [Metric.PRETAX_CONTRIBUTION]:         'Pre Tax Contribution',
  [Metric.POSTTAX_CONTRIBUTION]:        'Post Tax Contribution',
  [Metric.TRAD_IRA_CONTRIBUTION]:       'Traditional IRA Contribution',
  [Metric.ROTH_IRA_CONTRIBUTION]:       'Roth IRA Contribution',
  [Metric.FOUR_01K_CONTRIBUTION]:       '401K Contribution',
  [Metric.TAX_FREE_DISTRIBUTION]:       'Tax Free Distribution',
  [Metric.TAXABLE_DISTRIBUTION]:        'Taxable Distribution',
  [Metric.TRAD_IRA_DISTRIBUTION]:       'Traditional IRA Distribution',
  [Metric.ROTH_IRA_DISTRIBUTION]:       'Roth IRA Distribution',
  [Metric.FOUR_01K_DISTRIBUTION]:       '401K Distribution',
  [Metric.SHORT_TERM_CAPITAL_GAIN_TAX]: 'Short Term Capital Gain Tax',
  [Metric.LONG_TERM_CAPITAL_GAIN_TAX]:  'Long Term Capital Gain Tax',
  [Metric.LIVING_EXPENSE]:                'Living Expense',
  [Metric.INTEREST_EXPENSE]:             'Interest Expense',
  [Metric.MAINTENANCE]:                 'Maintenance',
  [Metric.INSURANCE]:                   'Insurance',
  [Metric.CREDIT]:                      'Credit',
});

// ── Rollup DAG ───────────────────────────────────────────────────────
// Child Metric -> Array of Parent Metrics.
// addToMetric(child, amount) automatically propagates up via these edges.

export const MetricRollups = {
    // --- FOUNDATIONAL INCOME TO ORDINARY INCOME ---
    [Metric.TRAD_IRA_DISTRIBUTION]:       [Metric.TAXABLE_DISTRIBUTION],
    [Metric.FOUR_01K_DISTRIBUTION]:       [Metric.TAXABLE_DISTRIBUTION],
    // RMD is informational only — no rollup. Income is captured by the distribution leaves.

    [Metric.TAXABLE_DISTRIBUTION]:        [Metric.ORDINARY_INCOME],
    [Metric.EMPLOYED_INCOME]:             [Metric.ORDINARY_INCOME],
    [Metric.SELF_INCOME]:                 [Metric.ORDINARY_INCOME],
    [Metric.INTEREST_INCOME]:             [Metric.ORDINARY_INCOME],
    [Metric.SOCIAL_SECURITY_INCOME]:      [Metric.ORDINARY_INCOME],
    [Metric.SHORT_TERM_CAPITAL_GAIN]:     [Metric.ORDINARY_INCOME], // Taxed at ordinary rates

    // --- FOUNDATIONAL GAINS TO CAPITAL GAINS ---
    [Metric.LONG_TERM_CAPITAL_GAIN]:      [Metric.CAPITAL_GAIN],

    // --- MASTER COMBINATIONS TO RETIREMENT PLANS ---
    [Metric.FOUR_01K_CONTRIBUTION]:       [Metric.PRETAX_CONTRIBUTION],
    [Metric.TRAD_IRA_CONTRIBUTION]:       [Metric.PRETAX_CONTRIBUTION],
    [Metric.ROTH_IRA_CONTRIBUTION]:       [Metric.POSTTAX_CONTRIBUTION],
    [Metric.PRETAX_CONTRIBUTION]:         [Metric.CONTRIBUTION],
    [Metric.POSTTAX_CONTRIBUTION]:        [Metric.CONTRIBUTION],

    // --- MASTER COMBINATIONS TO TOTAL INCOME ---
    [Metric.ORDINARY_INCOME]:             [Metric.INCOME],
    [Metric.CAPITAL_GAIN]:                [Metric.INCOME],
    [Metric.ROTH_IRA_DISTRIBUTION]:       [Metric.TAX_FREE_DISTRIBUTION], // Non-taxable, but still cash flow income
    [Metric.TAX_FREE_DISTRIBUTION]:       [Metric.INCOME],
    [Metric.NON_QUALIFIED_DIVIDEND]:      [Metric.ORDINARY_INCOME],
    [Metric.QUALIFIED_DIVIDEND]:          [Metric.INCOME],

    [Metric.MEDICARE_TAX]:                [Metric.WITHHELD_FICA_TAX],
    [Metric.SOCIAL_SECURITY_TAX]:         [Metric.WITHHELD_FICA_TAX],

    // --- TAX ROLLUPS ---
    [Metric.WITHHELD_FICA_TAX]:           [Metric.INCOME_TAX],
    [Metric.WITHHELD_INCOME_TAX]:         [Metric.INCOME_TAX],
    [Metric.ESTIMATED_INCOME_TAX]:        [Metric.INCOME_TAX],
    [Metric.SHORT_TERM_CAPITAL_GAIN_TAX]: [Metric.INCOME_TAX],

    [Metric.INCOME_TAX]:                  [Metric.FEDERAL_TAXES],
    [Metric.LONG_TERM_CAPITAL_GAIN_TAX]:  [Metric.FEDERAL_TAXES],

    // --- EXPENSE & DEBT ROLLUPS ---
    // MORTGAGE_PAYMENT and MORTGAGE_PRINCIPAL are informational only (like RMD) — no rollup.
    // Principal nets to zero via credit memos; payment is interest + principal for display.
    [Metric.LIVING_EXPENSE]:              [Metric.EXPENSE],
    [Metric.MORTGAGE_INTEREST]:           [Metric.INTEREST_EXPENSE],
    [Metric.INTEREST_EXPENSE]:            [Metric.EXPENSE],
    [Metric.MAINTENANCE]:                 [Metric.EXPENSE],
    [Metric.INSURANCE]:                   [Metric.EXPENSE],
    [Metric.PROPERTY_TAX]:                [Metric.SALT_TAXES],
    [Metric.FEDERAL_TAXES]:               [Metric.TAXES],
    [Metric.SALT_TAXES]:                  [Metric.TAXES],
};

// ── Derived sets ─────────────────────────────────────────────────────

/** Pinned metrics that always appear first in any dropdown. */
export const PINNED_METRICS = [Metric.VALUE, Metric.GROWTH, Metric.CASH_FLOW];

/**
 * Top-level metrics for the Macro projection dropdown.
 * DAG roots (parents that are never children) + standalone aggregates.
 * Ordered: pinned first, then DAG roots, then useful standalone.
 */
export const MACRO_METRICS = [
  ...PINNED_METRICS,
  Metric.INCOME, Metric.NET_INCOME, Metric.CONTRIBUTION,
  Metric.EXPENSE, Metric.TAXES,
  Metric.CREDIT,
];

/**
 * Returns true if a metric is a top-level / macro metric.
 * Used to partition group metrics into macro vs micro.
 */
const _macroSet = new Set(MACRO_METRICS);
export function isTopLevelMetric(m) { return _macroSet.has(m); }

/**
 * Parent metrics — metrics that have children rolling up to them in the DAG.
 * These must NEVER be written to directly; they are populated solely by
 * addToMetric() DAG propagation from leaf metrics.
 */
export const PARENT_METRICS = new Set(
  Object.values(MetricRollups).flat()
);

// ── TrackedMetric & MetricSet ─────────────────────────────────────────
// (merged from tracked-metric.js)
//
// TrackedMetric encapsulates one Currency accumulator + its history array.
// MetricSet manages the full collection so initializeChron/monthlyChron
// become one-liners in ModelAsset.

import { Currency } from './utils/currency.js';

export class TrackedMetric {
  constructor(name) {
    this.name = name;
    this.current = new Currency();
    this.history = [];
    this.displayHistory = [];
    this.trackHistory = true;
  }

  initialize() {
    this.current = new Currency();
    this.history = [];
    this.displayHistory = [];
  }

  snapshot() {
    if (this.trackHistory) this.history.push(this.current.toCurrency());
    this.current.zero();
  }

  snapshotKeep() {
    if (this.trackHistory) this.history.push(this.current.toCurrency());
  }

  add(amount) {
    if (amount instanceof Currency) {
      this.current.add(amount);
    }
    return this.current.copy();
  }

  subtract(amount) {
    if (amount instanceof Currency) {
      this.current.subtract(amount);
    }
    return this.current.copy();
  }

  get amount() { return this.current.amount; }
  set amount(v) { this.current.amount = v; }

  copy() { return this.current.copy(); }
  zero() { this.current.zero(); return this; }
  toFixed() { return this.current.toFixed(); }
  toCurrency() { return this.current.toCurrency(); }

  displayName() {
    return 'display' + this.name.charAt(0).toUpperCase() + this.name.slice(1) + 's';
  }

  buildDisplayHistory(monthsSpan) {
    this.displayHistory = [];
    for (let ii = monthsSpan.offsetMonths; ii < this.history.length; ii += monthsSpan.combineMonths) {
        this.displayHistory.push(this.history[ii]);
    }
    return this.displayHistory;
  }
}

const NULL_CURRENCY = Object.freeze({ amount: 0, add() {}, subtract() {}, copy() { return new Currency(); }, zero() {}, toCurrency() { return 0; }, toFixed() { return '0.00'; }, toHTML() { return '0.00'; }, toString() { return '$0.00'; } });
const EMPTY_ARRAY = Object.freeze([]);
const NULL_METRIC = Object.freeze({
  name: '_null',
  current: NULL_CURRENCY,
  history: EMPTY_ARRAY,
  displayHistory: EMPTY_ARRAY,
  initialize() {},
  snapshot() {},
  snapshotKeep() {},
  add() { return new Currency(); },
  subtract() { return new Currency(); },
  get amount() { return 0; },
  set amount(_v) {},
  copy() { return new Currency(); },
  zero() { return this; },
  toFixed() { return '0.00'; },
  toCurrency() { return 0; },
  displayName() { return '_null'; },
  buildDisplayHistory() { return EMPTY_ARRAY; },
});

export class MetricSet {
  constructor(names) {
    this._map = new Map();
    for (const name of names) {
      this._map.set(name, new TrackedMetric(name));
    }
  }

  get(name) {
    return this._map.get(name) || NULL_METRIC;
  }

  has(name) {
    return this._map.has(name);
  }

  initializeAll() {
    for (const m of this._map.values()) m.initialize();
  }

  setTrackHistory(enabled) {
    for (const m of this._map.values()) m.trackHistory = enabled;
  }

  snapshotAll(keepNames) {
    for (const [name, m] of this._map) {
      if (keepNames?.has(name)) {
        m.snapshotKeep();
      } else {
        m.snapshot();
      }
    }
  }

  [Symbol.iterator]() {
    return this._map.values();
  }

  entries() {
    return this._map.entries();
  }
}