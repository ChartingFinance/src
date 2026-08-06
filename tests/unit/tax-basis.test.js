/**
 * tax-basis.test.js — spec 6 post-test T1.
 *
 * Every expected value below is computed BY HAND from the 2026 tables in
 * taxes.js, not copied from what the implementation printed. A test written
 * from the output cannot falsify the output, and this module's whole purpose is
 * to become the one place nine call sites agree on — so if it is wrong, it will
 * be wrong everywhere at once and nothing that only compares sites to each
 * other will notice.
 *
 * 2026 Single: standard deduction $16,100.
 * 2026 MFJ:    standard deduction $32,200.
 * Property-tax deduction cap: $40,000. 401(k) limit under 50: $24,500.
 * A fresh TaxTable is un-inflated — inflateTaxes only runs on a year rollover.
 */

import { describe, it, expect, beforeEach } from 'vitest';

function mockLocalStorage() {
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}
mockLocalStorage();
globalThis.window = globalThis;

const G = await import('../../js/globals.js');
const { TaxTable } = await import('../../js/taxes.js');
const { FinancialPackage } = await import('../../js/financial-package.js');
const { taxableBasis } = await import('../../js/tax-basis.js');

/** Under 50, so no catch-up applies to the contribution limits. */
const USER = { age: 45 };

function setFiling(filingAs) {
  G.global_reset();
  G.global_setFilingAs(filingAs);
  G.global_getFilingAs();
  G.setActiveTaxTable(new TaxTable());
}

/** A package with only the named fields set. Expenses are negative, as in the engine. */
function pkg(fields) {
  const p = new FinancialPackage();
  for (const [k, v] of Object.entries(fields)) p[k].amount = v;
  return p;
}

beforeEach(() => setFiling('Single'));

describe('ordinaryTaxable', () => {
  it('subtracts the single standard deduction', () => {
    // 100,000 − 16,100
    const b = taxableBasis(pkg({ employedIncome: 100000 }), USER);
    expect(b.ordinaryTaxable.amount).toBeCloseTo(83900, 6);
  });

  it('subtracts the MFJ standard deduction when filing jointly', () => {
    setFiling('MFJ');
    // 100,000 − 32,200
    const b = taxableBasis(pkg({ employedIncome: 100000 }), USER);
    expect(b.ordinaryTaxable.amount).toBeCloseTo(67800, 6);
  });

  it('counts Social Security at 85%', () => {
    // 40,000 × 0.85 = 34,000, less 16,100
    const b = taxableBasis(pkg({ socialSecurityIncome: 40000 }), USER);
    expect(b.ordinaryTaxable.amount).toBeCloseTo(17900, 6);
  });

  it('floors at zero when the deduction exceeds income', () => {
    // 10,000 − 16,100 would be −6,100
    const b = taxableBasis(pkg({ employedIncome: 10000 }), USER);
    expect(b.ordinaryTaxable.amount).toBe(0);
  });

  it('subtracts a pre-tax 401(k) contribution', () => {
    // 100,000 − 16,100 − 20,000
    const b = taxableBasis(pkg({ employedIncome: 100000, four01KContribution: 20000 }), USER);
    expect(b.ordinaryTaxable.amount).toBeCloseTo(63900, 6);
  });

  it('caps the 401(k) deduction at the annual limit', () => {
    // 40,000 requested, capped to 24,500: 200,000 − 16,100 − 24,500
    const b = taxableBasis(pkg({ employedIncome: 200000, four01KContribution: 40000 }), USER);
    expect(b.ordinaryTaxable.amount).toBeCloseTo(159400, 6);
  });

  it('itemises when mortgage interest plus property tax beats the standard deduction', () => {
    // 25,000 interest + 8,000 property tax = 33,000 > 16,100 → 100,000 − 33,000
    const b = taxableBasis(
      pkg({ employedIncome: 100000, mortgageInterest: -25000, propertyTaxes: -8000 }), USER);
    expect(b.ordinaryTaxable.amount).toBeCloseTo(67000, 6);
  });

  it('caps the property-tax component of an itemised deduction', () => {
    // Property tax capped at 40,000, plus 25,000 interest = 65,000 → 200,000 − 65,000
    const b = taxableBasis(
      pkg({ employedIncome: 200000, mortgageInterest: -25000, propertyTaxes: -90000 }), USER);
    expect(b.ordinaryTaxable.amount).toBeCloseTo(135000, 6);
  });

  it('excludes long-term gains and qualified dividends — they have their own schedule', () => {
    const b = taxableBasis(
      pkg({ employedIncome: 100000, longTermCapitalGains: 500000, qualifiedDividends: 90000 }), USER);
    expect(b.ordinaryTaxable.amount).toBeCloseTo(83900, 6);
  });

  it('includes short-term gains, which ARE ordinary income', () => {
    // 100,000 + 30,000 − 16,100
    const b = taxableBasis(
      pkg({ employedIncome: 100000, shortTermCapitalGains: 30000 }), USER);
    expect(b.ordinaryTaxable.amount).toBeCloseTo(113900, 6);
  });
});

describe('capitalGains', () => {
  it('is long-term gains plus qualified dividends, less the §121 exclusion', () => {
    const b = taxableBasis(pkg({
      longTermCapitalGains: 50000, qualifiedDividends: 5000, excludedCapitalGains: 20000,
    }), USER);
    expect(b.capitalGains.amount).toBeCloseTo(35000, 6);
  });

  it('floors at zero when the exclusion exceeds the gain', () => {
    const b = taxableBasis(
      pkg({ longTermCapitalGains: 10000, excludedCapitalGains: 25000 }), USER);
    expect(b.capitalGains.amount).toBe(0);
  });

  it('ignores ordinary income entirely', () => {
    const b = taxableBasis(
      pkg({ employedIncome: 250000, longTermCapitalGains: 40000 }), USER);
    expect(b.capitalGains.amount).toBeCloseTo(40000, 6);
  });
});

describe('ltcgStackBase', () => {
  it('equals ordinaryTaxable — §1(h) measures the bands against taxable income', () => {
    const b = taxableBasis(
      pkg({ employedIncome: 100000, longTermCapitalGains: 40000 }), USER);
    expect(b.ltcgStackBase.amount).toBeCloseTo(b.ordinaryTaxable.amount, 6);
    expect(b.ltcgStackBase.amount).toBeCloseTo(83900, 6);
  });

  it('does NOT include the gains being stacked on it', () => {
    const withGains = taxableBasis(
      pkg({ employedIncome: 100000, longTermCapitalGains: 400000 }), USER);
    const without = taxableBasis(pkg({ employedIncome: 100000 }), USER);
    expect(withGains.ltcgStackBase.amount).toBeCloseTo(without.ltcgStackBase.amount, 6);
  });

  it('does NOT include tax-free Roth distributions', () => {
    const withRoth = taxableBasis(
      pkg({ employedIncome: 100000, rothIRADistribution: 200000 }), USER);
    const without = taxableBasis(pkg({ employedIncome: 100000 }), USER);
    expect(withRoth.ltcgStackBase.amount).toBeCloseTo(without.ltcgStackBase.amount, 6);
  });

  it('is a separate Currency from ordinaryTaxable', () => {
    const b = taxableBasis(pkg({ employedIncome: 100000 }), USER);
    b.ltcgStackBase.amount = 1;
    expect(b.ordinaryTaxable.amount).toBeCloseTo(83900, 6);
  });
});

describe('annualise', () => {
  it('multiplies a monthly package by twelve before deducting', () => {
    // 10,000 × 12 = 120,000 − 16,100. NOT (10,000 − 16,100) × 12.
    const b = taxableBasis(pkg({ employedIncome: 10000 }), USER, { annualise: true });
    expect(b.ordinaryTaxable.amount).toBeCloseTo(103900, 6);
  });

  it('caps contributions AFTER annualising, so twelve times the limit cannot pass', () => {
    // 4,000/mo × 12 = 48,000 requested, capped to 24,500: 240,000 − 16,100 − 24,500
    const b = taxableBasis(
      pkg({ employedIncome: 20000, four01KContribution: 4000 }), USER, { annualise: true });
    expect(b.ordinaryTaxable.amount).toBeCloseTo(199400, 6);
  });

  it('scales capital gains too', () => {
    const b = taxableBasis(pkg({ longTermCapitalGains: 1000 }), USER, { annualise: true });
    expect(b.capitalGains.amount).toBeCloseTo(12000, 6);
  });
});

describe('the caller\'s package', () => {
  it('is not mutated — limitDeductions and applyYearlyDeductions both mutate', () => {
    const p = pkg({ employedIncome: 200000, four01KContribution: 40000, propertyTaxes: -90000 });
    taxableBasis(p, USER, { annualise: true });
    expect(p.employedIncome.amount).toBe(200000);
    expect(p.four01KContribution.amount).toBe(40000);
    expect(p.propertyTaxes.amount).toBe(-90000);
  });
});
