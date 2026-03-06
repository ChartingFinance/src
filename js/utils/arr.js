/**
 * arr.js — Annual Return Rate value object
 *
 * Stores rate as a decimal internally (e.g. 0.07 for 7%).
 * Handles parsing from percentage strings and HTML inputs.
 */

export class ARR {
  /**
   * @param {number} rate  Decimal rate, e.g. 0.07 for 7%
   */
  constructor(rate = 0) {
    this.rate = rate;
  }

  // ── Backwards-compat alias (used throughout the codebase) ────────
  get annualReturnRate() { return this.rate; }
  set annualReturnRate(v) { this.rate = v; }

  // ── Parsing ──────────────────────────────────────────────────────

  /** Parse a percentage string like "7" or "7%" → 0.07 */
  static parse(str) {
    const cleaned = String(str).replace('%', '');
    return new ARR(parseFloat(cleaned) / 100);
  }

  /** Build from a percentage number: ARR.fromPercent(7) → 0.07 */
  static fromPercent(pct) {
    return new ARR(pct / 100);
  }

  // ── Queries ──────────────────────────────────────────────────────

  asMonthly() {
    return this.rate / 12;
  }

  hasMonthly() {
    return this.rate !== 0;
  }

  hasMonthlyAmount() {
    return false;
  }

  asPercent() {
    return this.rate * 100;
  }

  // ── Formatting ───────────────────────────────────────────────────

  toString() {
    return `${this.asPercent()}%`;
  }

  /** For HTML input value (no % sign) */
  toHTML() {
    return String(this.asPercent());
  }

  copy() {
    return new ARR(this.rate);
  }

  toJSON() {
    return { annualReturnRate: this.rate };
  }
}
