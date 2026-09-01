/**
 * currency.js
 *
 * Immutable-friendly Currency value object.
 *
 * Rounding policy:
 *   The internal `amount` is stored at full float precision. Rounding to cents
 *   happens only at the output boundary via `toFixed()` / `toString()` / `toJSON()`.
 *   This avoids accumulated drift from repeated construction in hot paths (e.g.
 *   fractional capital-gains splits, monthly growth).
 */

/**
 * Reject anything that is not a Currency, loudly.
 *
 * ── Why this throws instead of ignoring ──────────────────────────────
 *
 * `add` and `subtract` used to read `if (other instanceof Currency)` and
 * silently do NOTHING otherwise. That is the engine's documented failure mode
 * — numbers, never errors — expressed at the type level: pass a number where a
 * Currency belongs and the arithmetic quietly does not happen, the value stays
 * plausible, and the report is clean.
 *
 * It hid a real one. `TaxTable.calculateYearlyIncomeTax(income, deduction)`
 * called `adjusted.subtract(deduction.amount)` — a number — so the deduction
 * parameter never subtracted anything for any caller since it was written.
 * Passing the standard deduction returned the UNDEDUCTED tax: $16,712 instead
 * of $13,170 on $100K.
 *
 * `divide` already throws on division by zero, so this is the class's own
 * precedent rather than a new policy. Measured before switching it on: across
 * five profiles there was exactly ONE call site passing a non-Currency, out of
 * 215 in js/, and no site anywhere passes a numeric literal.
 */
function assertCurrency(other, op) {
  if (!(other instanceof Currency)) {
    throw new TypeError(
      `Currency.${op}: expected a Currency, got ${typeof other} `
      + `(${String(other)}). Passing \`x.amount\` is the usual slip — pass \`x\`. `
      + 'This used to be ignored silently, which is how a tax deduction went '
      + 'unapplied for months.');
  }
}

export class Currency {
  /**
   * @param {number} [amount=0]
   */
  constructor(amount = 0) {
    this.amount = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
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
    assertCurrency(other, 'add');
    this.amount += other.amount;
    return this;
  }

  subtract(other) {
    assertCurrency(other, 'subtract');
    this.amount -= other.amount;
    return this;
  }

  multiply(factor) {
    this.amount *= factor;
    return this;
  }

  divide(divisor) {
    if (divisor === 0) {
      throw new RangeError('Currency.divide: division by zero');
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
  dividedBy(d)   {
    if (d === 0) throw new RangeError('Currency.dividedBy: division by zero');
    return new Currency(this.amount / d);
  }
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
