/**
 * tracked-metric.js
 *
 * Eliminates the massive duplication in ModelAsset where 25+ fields
 * each follow the exact same lifecycle:
 *
 *   initializeChron()  →  this.xxxCurrency = new Currency();
 *                          this.monthlyXxxs = [];
 *
 *   monthlyChron()     →  this.monthlyXxxs.push(this.xxxCurrency.toCurrency());
 *                          this.xxxCurrency.zero();
 *
 *   addMonthlyXxx(amt) →  logger.log(...);
 *                          this.xxxCurrency.add(amt);
 *                          return this.xxxCurrency.copy();
 *
 * A TrackedMetric encapsulates one such pair, and a MetricSet manages
 * the collection, so initializeChron/monthlyChron become one-liners.
 */

import { Currency } from './currency.js';

export class TrackedMetric {
  /**
   * @param {string} name  Human-readable name for logging (e.g. "mortgageInterest")
   */
  constructor(name) {
    this.name = name;
    this.current = new Currency();
    this.history = [];
    this.displayHistory = [];
  }

  /** Reset for a new simulation run */
  initialize() {
    this.current = new Currency();
    this.history = [];
    this.displayHistory = [];
  }

  /** Snapshot current value to history, then zero the accumulator */
  snapshot() {
    this.history.push(this.current.toCurrency());
    this.current.zero();
  }

  /**
   * Snapshot WITHOUT zeroing (for values that carry forward, like finishCurrency).
   */
  snapshotKeep() {
    this.history.push(this.current.toCurrency());
  }

  /** Add an amount to the current accumulator */
  add(amount) {

    if (amount instanceof Currency) {
      this.current.add(amount);
    }
    return this.current.copy();

  }

  /** Subtract from the current accumulator */
  subtract(amount) {

    if (amount instanceof Currency) {
      this.current.subtract(amount);
    }
    return this.current.copy();

  }

  /** Direct access to the accumulated value */
  get amount() { return this.current.amount; }
  set amount(v) { this.current.amount = v; }

  copy() { return this.current.copy(); }
  zero() { this.current.zero(); return this; }
  toFixed() { return this.current.toFixed(); }
  toCurrency() { return this.current.toCurrency(); }

  /* Build a display name for this metric, e.g. "displayEarnings" for "earning". */
  displayName() {
    return 'display' + this.name.charAt(0).toUpperCase() + this.name.slice(1) + 's';
  }

  /** Build an array of display values for this metric, aligned to the given monthsSpan */
  buildDisplayHistory(monthsSpan) {
    this.displayHistory = [];
    for (let ii = monthsSpan.offsetMonths; ii < this.history.length; ii += monthsSpan.combineMonths) {      
        this.displayHistory.push(this.history[ii]);      
    }
    return this.displayHistory;
  }
}


/**
 * MetricSet: a named collection of TrackedMetrics.
 *
 * Usage in ModelAsset:
 *
 *   this.metrics = new MetricSet([
 *     'earning', 'income', 'afterTax', 'afterExpense',
 *     'shortTermCapitalGain', 'longTermCapitalGain',
 *     'mortgagePayment', 'mortgageInterest', ...
 *   ]);
 *
 *   // In initializeChron:
 *   this.metrics.initializeAll();
 *
 *   // In monthlyChron:
 *   this.metrics.snapshotAll();
 *
 *   // Access:
 *   this.metrics.get('earning').add(amount);
 */
export class MetricSet {
  /**
   * @param {string[]} names  Metric names to create
   */
  constructor(names) {
    /** @type {Map<string, TrackedMetric>} */
    this._map = new Map();
    for (const name of names) {
      this._map.set(name, new TrackedMetric(name));
    }
  }

  /** Get a metric by name */
  get(name) {
    const m = this._map.get(name);
    if (!m) throw new Error(`Unknown metric: "${name}"`);
    return m;
  }

  /** Check if a metric exists */
  has(name) {
    return this._map.has(name);
  }

  /** Initialize all metrics for a new simulation run */
  initializeAll() {
    for (const m of this._map.values()) m.initialize();
  }

  /**
   * Snapshot all metrics. By default zeros after snapshot.
   * Pass `keepNames` for metrics that should NOT be zeroed (e.g. 'finishValue').
   *
   * @param {Set<string>} [keepNames]  Names to snapshot without zeroing
   */
  snapshotAll(keepNames) {
    for (const [name, m] of this._map) {
      if (keepNames?.has(name)) {
        m.snapshotKeep();
      } else {
        m.snapshot();
      }
    }
  }

  /** Iterate all metrics */
  [Symbol.iterator]() {
    return this._map.values();
  }

  /** Get all entries as [name, TrackedMetric] pairs */
  entries() {
    return this._map.entries();
  }
}
