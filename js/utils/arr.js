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
    // NaN-safe, matching Currency. ARR used to store whatever it was handed,
    // and that asymmetry is why a blank rate field could reach the simulation
    // as NaN while a blank money field could not: Currency guards here, ARR did
    // not. A NaN rate does not throw — it silently removes the charge, so an
    // asset with a NaN annualTaxRate pays no property tax and the run looks
    // clean.
    this.rate = typeof rate === 'number' && Number.isFinite(rate) ? rate : 0;
  }

  // ── Backwards-compat alias (used throughout the codebase) ────────
  get annualReturnRate() { return this.rate; }
  set annualReturnRate(v) { this.rate = v; }

  // ── Parsing ──────────────────────────────────────────────────────

  /**
   * Parse a percentage string like "7" or "7%" → 0.07.
   *
   * Anything unparseable becomes 0, matching Currency.parse. This used to
   * return ARR(NaN), and the failure was silent rather than loud: an asset
   * whose annualTaxRate is NaN is charged NO property tax at all, and the run
   * completes without a warning. Measured on a 2-year plan — the same
   * portfolio ended with the backstop at $42,099 with a 1% rate and at $50,000
   * untouched with NaN.
   *
   * The only caller is ModelAsset.fromHTML, where an optional rate field that
   * exists but was left blank is exactly the case that produced it.
   */
  static parse(str) {
    const cleaned = String(str).replace('%', '');
    const value = parseFloat(cleaned) / 100;
    return new ARR(Number.isFinite(value) ? value : 0);
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
