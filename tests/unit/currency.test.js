import { describe, it, expect } from 'vitest';
import { Currency } from '../../js/utils/currency.js';

describe('Currency', () => {
  it('add and subtract mutate in place and chain', () => {
    const c = new Currency(100);
    c.add(new Currency(25)).subtract(new Currency(10));
    expect(c.amount).toBe(115);
  });

  // ── Strictness ────────────────────────────────────────────────
  //
  // These used to be `if (other instanceof Currency)` with no else, so a
  // non-Currency argument silently did nothing. That is the engine's failure
  // mode — numbers, never errors — at the type level, and it hid a real bug:
  // TaxTable.calculateYearlyIncomeTax passed `deduction.amount`, so its
  // deduction parameter never subtracted anything for any caller.

  it('add rejects a non-Currency instead of ignoring it', () => {
    expect(() => new Currency(100).add(25)).toThrow(TypeError);
    expect(() => new Currency(100).add(25)).toThrow(/expected a Currency/);
  });

  it('subtract rejects a non-Currency instead of ignoring it', () => {
    expect(() => new Currency(100).subtract(25)).toThrow(TypeError);
  });

  it('names the `.amount` slip, because that is how it always happens', () => {
    const other = new Currency(25);
    expect(() => new Currency(100).subtract(other.amount)).toThrow(/x\.amount/);
  });

  it('rejects null and undefined rather than treating them as zero', () => {
    expect(() => new Currency(100).add(null)).toThrow(TypeError);
    expect(() => new Currency(100).subtract(undefined)).toThrow(TypeError);
  });

  it('a bad argument leaves the value untouched', () => {
    const c = new Currency(100);
    try { c.subtract(25); } catch { /* expected */ }
    expect(c.amount).toBe(100);
  });

  it('plus and minus return new instances without mutating', () => {
    const a = new Currency(100);
    const b = new Currency(25);
    const sum = a.plus(b);
    expect(sum.amount).toBe(125);
    expect(a.amount).toBe(100);
    expect(b.amount).toBe(25);
    expect(sum).not.toBe(a);
  });

  it('stores full float precision (no constructor rounding)', () => {
    const c = new Currency(1.23456);
    expect(c.amount).toBe(1.23456);
  });

  it('toFixed rounds to cents only at output boundary', () => {
    const c = new Currency(1.236);
    expect(c.toFixed()).toBe(1.24);
    expect(c.amount).toBe(1.236);
  });

  it('accumulates 200 additions of 0.01 without drift when rounded at output', () => {
    const c = Currency.zero();
    for (let i = 0; i < 200; i++) c.add(new Currency(0.01));
    expect(c.toFixed()).toBe(2.00);
  });

  it('divide by zero throws RangeError', () => {
    const c = new Currency(100);
    expect(() => c.divide(0)).toThrow(RangeError);
  });

  it('dividedBy zero throws RangeError', () => {
    const c = new Currency(100);
    expect(() => c.dividedBy(0)).toThrow(RangeError);
  });

  it('parse handles dollar-formatted strings, commas, and plain numbers', () => {
    expect(Currency.parse('$1,234.56').amount).toBe(1234.56);
    expect(Currency.parse('1234.56').amount).toBe(1234.56);
    expect(Currency.parse('').amount).toBe(0);
    expect(Currency.parse('abc').amount).toBe(0);
  });

  it('flipSign negates in place', () => {
    const c = new Currency(50);
    c.flipSign();
    expect(c.amount).toBe(-50);
  });

  it('constructor rejects non-finite numbers', () => {
    expect(new Currency(NaN).amount).toBe(0);
    expect(new Currency(Infinity).amount).toBe(0);
  });
});
