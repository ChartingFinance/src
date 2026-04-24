import { describe, it, expect } from 'vitest';
import { Currency } from '../../js/utils/currency.js';

describe('Currency', () => {
  it('add and subtract mutate in place and chain', () => {
    const c = new Currency(100);
    c.add(new Currency(25)).subtract(new Currency(10));
    expect(c.amount).toBe(115);
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
