/**
 * price-index.js — cumulative price level, for converting nominal
 * simulation output into real ("today's dollars") output.
 *
 * CONVENTION, and it is not negotiable: the engine compounds every annual
 * rate as simple `rate / 12` per month (`ARR.asMonthly()`), and expenses
 * inflate that way in instrument-behavior.js. This index MUST use the same
 * step or the real line drifts out of step with the engine's own cost of
 * living, and the error compounds across a 30-year plan. Do not "fix" this
 * to (1 + rate)^(1/12).
 *
 * BASE: the plan's first month, before any month has elapsed — so index 1.0
 * is the value of a dollar on the plan's start date. History is recorded on
 * the same tick as the VALUE metric, which is written AFTER a month of
 * growth has been applied. So history[i] covers i+1 elapsed months and lines
 * up index-for-index with every asset metric history.
 */

export class PriceIndex {

  /** @param {number} annualRate  decimal, e.g. 0.031 */
  constructor(annualRate = 0) {
    this.annualRate = annualRate;
    this.level = 1.0;
    this.history = [];
  }

  /** Change the prevailing annual rate (call at a year boundary). */
  setAnnualRate(annualRate) {
    this.annualRate = annualRate ?? 0;
  }

  /**
   * Advance one month and record the new level. Call from the same branch
   * that calls portfolio.monthlyChron(), so the arrays stay aligned.
   */
  stepAndRecord() {
    this.level *= (1 + this.annualRate / 12);
    this.history.push(this.level);
    return this.level;
  }

  /**
   * Convert a nominal series to real (base-month) dollars.
   * Extra trailing entries are divided by the last known level rather than
   * dropped, so a caller never silently loses months.
   */
  static deflate(series, indexHistory) {
    if (!series) return [];
    if (!indexHistory?.length) return series.slice();
    const last = indexHistory[indexHistory.length - 1];
    return series.map((v, i) => {
      if (v == null) return v;
      return v / (indexHistory[i] ?? last);
    });
  }

  /** Real value of a single entry. */
  static deflateAt(value, indexHistory, i) {
    if (value == null) return value;
    if (!indexHistory?.length) return value;
    const level = indexHistory[i] ?? indexHistory[indexHistory.length - 1];
    return value / level;
  }
}
