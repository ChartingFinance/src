/**
 * date-int.js
 *
 * A compact year-month date encoded as an integer (YYYYMM).
 *
 * Changes from original:
 *  - `diffMonths()` added (replaces the loose `util_totalMonths` loop)
 *  - `addMonths()` uses arithmetic instead of a while-loop
 *  - `equals()`, `isBefore()`, `isAfter()` for clearer comparisons
 *  - `next()` / `prev()` day-stepping logic preserved for chronometer compatibility
 */

export class DateInt {
  /**
   * @param {number} yyyyMM  e.g. 202501 for January 2025
   */
  constructor(yyyyMM) {
    this.year  = Math.floor(yyyyMM / 100);
    this.month = yyyyMM % 100;
    this.day   = 1;
  }

  // ── Parsing ──────────────────────────────────────────────────────

  /** Parse "YYYY-MM" string (from HTML month inputs) */
  static parse(str) {
    const [y, m] = str.split('-').map(Number);
    return new DateInt(y * 100 + m);
  }

  /** Build from year + month */
  static from(year, month) {
    return new DateInt(year * 100 + month);
  }

  static today() {
    const date = new Date();
    const formattedDate = date.toISOString().split('T')[0];
    const segments = formattedDate.split('-');
    const resultDate = segments[0] + '-' + segments[1];
    return DateInt.parse(resultDate);
  }

  // ── Integer representation ───────────────────────────────────────

  toInt() {
    return this.year * 100 + this.month;
  }

  // ── Comparison ───────────────────────────────────────────────────

  equals(other)   { return this.toInt() === other.toInt(); }
  isBefore(other) { return this.toInt() < other.toInt(); }
  isAfter(other)  { return this.toInt() > other.toInt(); }

  /** Inclusive: true when this date falls within [start, finish] */
  isBetween(start, finish) {
    const v = this.toInt();
    return v >= start.toInt() && v <= finish.toInt();
  }

  // ── Arithmetic ───────────────────────────────────────────────────

  /**
   * Absolute month count between two DateInts.
   * Replaces the old `util_totalMonths` while-loop.
   */
  static diffMonths(start, finish) {
    if (!start || !finish) return 0;
    return (finish.year - start.year) * 12 + (finish.month - start.month);
  }

  /** Mutating: advance to next month */
  nextMonth() {
    if (++this.month > 12) { this.month = 1; ++this.year; }
  }

  /** Mutating: go back one month */
  prevMonth() {
    if (--this.month < 1) { this.month = 12; --this.year; }
  }

  /** Mutating: advance by N months (non-looping) */
  addMonths(n) {
    const totalMonths = this.year * 12 + (this.month - 1) + n;
    this.year  = Math.floor(totalMonths / 12);
    this.month = (totalMonths % 12) + 1;
  }

  /**
   * Sub-month stepping used by the chronometer.
   * The original alternates day between 1→5→1→5 to model two "ticks" per month.
   */
  next() {
    this.day = this.day === 1 ? 5 : this.day + 5;
    if (this.day > 30) { this.day = 1; this.nextMonth(); }
  }

  prev() {
    this.day = this.day === 5 ? 1 : this.day - 5;
    if (this.day < 1) { this.day = 30; this.prevMonth(); }
  }

  isNewYearsDay() {
    return this.month === 1 && this.day === 1;
  }

  // ── Formatting ───────────────────────────────────────────────────

  /** "01" .. "12" */
  #twoDigitMonth() {
    return String(this.month).padStart(2, '0');
  }

  /** Last calendar day of this month */
  lastDayOfMonth() {
    return new Date(this.year, this.month, 0).getDate();
  }

  /** "YYYY-MM" for HTML month inputs */
  toHTML() {
    return `${this.year}-${this.#twoDigitMonth()}`;
  }

  toString() {
    return this.toHTML();
  }

  /** ISO date string: "YYYY-MM-01" or "YYYY-MM-{last}" */
  toISOString(endOfMonth = false) {
    const day = endOfMonth ? this.lastDayOfMonth() : 1;
    return `${this.year}-${this.#twoDigitMonth()}-${String(day).padStart(2, '0')}`;
  }

  copy() {
    const d = new DateInt(this.toInt());
    d.day = this.day;
    return d;
  }

  toJSON() {
    return { year: this.year, month: this.month };
  }
}
