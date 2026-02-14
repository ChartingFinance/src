/**
 * currency.js
 *
 * Immutable-friendly Currency value object.
 *
 * Changes from original:
 *  - Constructor handles 0 correctly (old version treated 0 as falsy → defaulted to 0.0 anyway,
 *    but `add()` skipped when amount was 0 because of `if (currency && currency.amount)`)
 *  - `add` / `subtract` guard against null but not against zero (fixes silent-skip bug)
 *  - Added `plus()` / `minus()` immutable variants for functional pipelines
 *  - `toFixed()` rounding happens only on output, not on construction (avoids accumulated drift)
 */

export class Currency {
  /**
   * @param {number} [amount=0]
   */
  constructor(amount = 0) {
    this.amount = typeof amount === 'number' ? amount : 0;
  }

  // ── Parsing ──────────────────────────────────────────────────────

  /** Parse a dollar-formatted string like "$1,234.56" or plain "1234.56" */
  static parse(str) {
    if (!str) return new Currency(0);
    const cleaned = String(str).replace(/[$,]/g, '');
    const value = parseFloat(cleaned);
    return new Currency(isNaN(value) ? 0 : value);
  }

  static zero() {
    return new Currency(0);
  }

  // ── Mutating arithmetic (chainable, matches original API) ────────

  add(other) {
    if (other instanceof Currency) this.amount += other.amount;
    return this;
  }

  subtract(other) {
    if (other instanceof Currency) this.amount -= other.amount;
    return this;
  }

  multiply(factor) {
    this.amount *= factor;
    return this;
  }

  divide(divisor) {
    if (divisor === 0) {
      console.error('Currency.divide: division by zero');
      return this;
    }
    this.amount /= divisor;
    return this;
  }

  flipSign() {
    this.amount *= -1;
    return this;
  }

  zero() {
    this.amount = 0;
    return this;
  }

  // ── Immutable arithmetic (returns new Currency) ──────────────────

  plus(other)    { return new Currency(this.amount + (other?.amount ?? 0)); }
  minus(other)   { return new Currency(this.amount - (other?.amount ?? 0)); }
  times(factor)  { return new Currency(this.amount * factor); }
  dividedBy(d)   { return d === 0 ? Currency.zero() : new Currency(this.amount / d); }
  negated()      { return new Currency(-this.amount); }

  // ── Queries ──────────────────────────────────────────────────────

  isPositive() { return this.amount > 0; }
  isNegative() { return this.amount < 0; }
  isZero()     { return this.amount === 0; }

  // ── Copying & serialisation ──────────────────────────────────────

  copy() {
    return new Currency(this.amount);
  }

  /** Rounded to 2 decimal places — use for display / storage only */
  toFixed() {
    return parseFloat(this.amount.toFixed(2));
  }

  /** Backwards-compat alias used by monthlyChron push patterns */
  toCurrency() {
    return this.toFixed();
  }

  toString() {
    return `$${this.toFixed()}`;
  }

  /** For HTML input value attributes (no dollar sign) */
  toHTML() {
    return String(this.toFixed());
  }

  toJSON() {
    return { amount: this.toFixed() };
  }
}
