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
    // The wages are not decoration. Without ordinary income to absorb it, the
    // $16,100 standard deduction spills onto the gains under §63 and this
    // asserts 18,900 instead — a different rule than the one named here.
    const b = taxableBasis(pkg({
      employedIncome: 100000,
      longTermCapitalGains: 50000, qualifiedDividends: 5000, excludedCapitalGains: 20000,
    }), USER);
    expect(b.capitalGains.amount).toBeCloseTo(35000, 6);
  });

  it('floors at zero when the exclusion exceeds the gain', () => {
    const b = taxableBasis(
      pkg({ longTermCapitalGains: 10000, excludedCapitalGains: 25000 }), USER);
    expect(b.capitalGains.amount).toBe(0);
  });

  it('ignores ordinary income entirely — as long as it covers the deduction', () => {
    const b = taxableBasis(
      pkg({ employedIncome: 250000, longTermCapitalGains: 40000 }), USER);
    expect(b.capitalGains.amount).toBeCloseTo(40000, 6);
  });
});

/**
 * IRC §63 takes the deduction off TAXABLE INCOME, which includes capital gain;
 * §1(h) then counts the gain LAST. So the deduction lands on ordinary income
 * first and only what ordinary income cannot absorb reaches the gain. The
 * engine used to floor ordinary taxable income at zero and discard the
 * remainder, over-taxing exactly the early retiree living off a brokerage
 * account.
 *
 * Every figure below is hand-computed from the 2026 Single table (standard
 * deduction $16,100, 0% capital-gains band to $49,450) against the IRS
 * Qualified Dividends and Capital Gain Tax Worksheet, not read off the
 * implementation.
 */
describe('deduction overflow onto capital gains (§63 / §1(h))', () => {
  it('does not touch the gains when ordinary income covers the deduction', () => {
    // 20,000 wages > 16,100 deduction. Nothing spills.
    const b = taxableBasis(
      pkg({ employedIncome: 20000, longTermCapitalGains: 40000 }), USER);
    expect(b.ordinaryTaxable.amount).toBeCloseTo(3900, 6);
    expect(b.capitalGains.amount).toBeCloseTo(40000, 6);
    expect(b.unusedDeduction.amount).toBe(0);
  });

  it('spends exactly the overflow, not the whole deduction', () => {
    // 10,000 ordinary absorbs 10,000; 6,100 is left and lands on the gains.
    const b = taxableBasis(
      pkg({ interestIncome: 10000, longTermCapitalGains: 60000 }), USER);
    expect(b.ordinaryTaxable.amount).toBe(0);
    expect(b.capitalGains.amount).toBeCloseTo(53900, 6);
    expect(b.unusedDeduction.amount).toBe(0);
  });

  it('shelters the gain outright when there is no ordinary income', () => {
    // 60,000 − 16,100 = 43,900, which sits below the 49,450 top of the 0% band.
    const b = taxableBasis(pkg({ longTermCapitalGains: 60000 }), USER);
    expect(b.capitalGains.amount).toBeCloseTo(43900, 6);
  });

  it('reports the leftover when the deduction outruns income and gains both', () => {
    // 2,000 ordinary + 3,000 gains = 5,000 against a 16,100 deduction.
    const b = taxableBasis(
      pkg({ interestIncome: 2000, longTermCapitalGains: 3000 }), USER);
    expect(b.ordinaryTaxable.amount).toBe(0);
    expect(b.capitalGains.amount).toBe(0);
    expect(b.unusedDeduction.amount).toBeCloseTo(11100, 6);
  });

  it('counts an itemised deduction, not just the standard one', () => {
    // 25,000 interest + 8,000 property tax = 33,000 itemised, beating 16,100.
    // No ordinary income at all, so all 33,000 reaches the gains.
    const b = taxableBasis(pkg({
      mortgageInterest: -25000, propertyTaxes: -8000, longTermCapitalGains: 50000,
    }), USER);
    expect(b.capitalGains.amount).toBeCloseTo(17000, 6);
  });

  it('applies §121 before the deduction, so the two do not overlap', () => {
    // 30,000 gain less a 20,000 exclusion = 10,000, then the 16,100 deduction
    // wipes it out and 6,100 is still going spare.
    const b = taxableBasis(
      pkg({ longTermCapitalGains: 30000, excludedCapitalGains: 20000 }), USER);
    expect(b.capitalGains.amount).toBe(0);
    expect(b.unusedDeduction.amount).toBeCloseTo(6100, 6);
  });

  it('uses the MFJ deduction when filing jointly', () => {
    setFiling('MFJ');
    // 32,200 deduction, no ordinary income: 80,000 − 32,200.
    const b = taxableBasis(pkg({ longTermCapitalGains: 80000 }), USER);
    expect(b.capitalGains.amount).toBeCloseTo(47800, 6);
  });

  it('bills nothing on the sheltered gain — the tax, not just the base', () => {
    // The regression this rule exists for. 60,000 of gain, no ordinary income:
    // taxable income 43,900, entirely inside the 0% band. Was $1,582.50.
    const T = G.activeTaxTable;
    const b = taxableBasis(pkg({ longTermCapitalGains: 60000 }), USER);
    const tax = T.calculateYearlyLongTermCapitalGainsTax(b.ltcgStackBase, b.capitalGains);
    expect(tax.amount).toBe(0);
  });
});

/**
 * IRC §1411. Every figure hand-computed from the 2026 tables, not read off the
 * implementation.
 *
 * The two bases exist to be DIFFERENT. NII is investment income only; MAGI is
 * AGI, which includes wages and qualified-plan distributions and is measured
 * BEFORE the standard deduction. A test suite that only ever feeds them
 * packages where they agree proves nothing about either.
 */
describe('netInvestmentIncome', () => {
  it('excludes wages entirely', () => {
    const b = taxableBasis(pkg({ employedIncome: 250000, selfIncome: 50000 }), USER);
    expect(b.netInvestmentIncome.amount).toBe(0);
  });

  it('sums interest, both dividend kinds and both gain kinds', () => {
    // 5,000 + 2,000 + 3,000 + 4,000 + 10,000
    const b = taxableBasis(pkg({
      interestIncome: 5000, nonQualifiedDividends: 2000, qualifiedDividends: 3000,
      shortTermCapitalGains: 4000, longTermCapitalGains: 10000,
    }), USER);
    expect(b.netInvestmentIncome.amount).toBeCloseTo(24000, 6);
  });

  it('excludes Social Security, pensions and qualified-plan distributions', () => {
    // All four are ordinary income and none is investment income.
    const b = taxableBasis(pkg({
      socialSecurityIncome: 40000, pensionIncome: 30000,
      tradIRADistribution: 50000, four01KDistribution: 60000,
      rothIRADistribution: 25000,
    }), USER);
    expect(b.netInvestmentIncome.amount).toBe(0);
  });

  it('subtracts the §121 exclusion — excluded gain is out of NII too', () => {
    // 400,000 gain less a 250,000 exclusion.
    const b = taxableBasis(
      pkg({ longTermCapitalGains: 400000, excludedCapitalGains: 250000 }), USER);
    expect(b.netInvestmentIncome.amount).toBeCloseTo(150000, 6);
  });

  it('floors at zero when the exclusion exceeds the gain', () => {
    const b = taxableBasis(
      pkg({ longTermCapitalGains: 10000, excludedCapitalGains: 25000 }), USER);
    expect(b.netInvestmentIncome.amount).toBe(0);
  });

  it('is NOT reduced by the standard deduction', () => {
    // 30,000 of gain with no ordinary income. capitalGains gets the §63
    // overflow; NII must not — it sits above the deduction line.
    const b = taxableBasis(pkg({ longTermCapitalGains: 30000 }), USER);
    expect(b.capitalGains.amount).toBeCloseTo(13900, 6);
    expect(b.netInvestmentIncome.amount).toBeCloseTo(30000, 6);
  });
});

describe('magi', () => {
  it('is gross of the standard deduction — unlike ordinaryTaxable', () => {
    // The single most likely wrong assumption: MAGI is AGI (line 11), the
    // deduction is line 12. These must differ by exactly 16,100.
    const b = taxableBasis(pkg({ employedIncome: 100000 }), USER);
    expect(b.magi.amount).toBeCloseTo(100000, 6);
    expect(b.ordinaryTaxable.amount).toBeCloseTo(83900, 6);
    expect(b.magi.amount - b.ordinaryTaxable.amount).toBeCloseTo(16100, 6);
  });

  it('subtracts the deductible pre-tax contribution', () => {
    // 100,000 − 20,000 deferral. Contributions are above the line.
    const b = taxableBasis(
      pkg({ employedIncome: 100000, four01KContribution: 20000 }), USER);
    expect(b.magi.amount).toBeCloseTo(80000, 6);
  });

  it('caps that contribution at the annual limit, like the deduction does', () => {
    // 40,000 requested, capped to 24,500.
    const b = taxableBasis(
      pkg({ employedIncome: 200000, four01KContribution: 40000 }), USER);
    expect(b.magi.amount).toBeCloseTo(175500, 6);
  });

  it('counts Social Security at 85%', () => {
    const b = taxableBasis(pkg({ socialSecurityIncome: 40000 }), USER);
    expect(b.magi.amount).toBeCloseTo(34000, 6);
  });

  it('includes long-term gains and qualified dividends', () => {
    // 100,000 + 40,000 + 5,000
    const b = taxableBasis(pkg({
      employedIncome: 100000, longTermCapitalGains: 40000, qualifiedDividends: 5000,
    }), USER);
    expect(b.magi.amount).toBeCloseTo(145000, 6);
  });

  it('subtracts the §121 exclusion', () => {
    const b = taxableBasis(
      pkg({ longTermCapitalGains: 400000, excludedCapitalGains: 250000 }), USER);
    expect(b.magi.amount).toBeCloseTo(150000, 6);
  });

  it('ignores Roth distributions — they raise neither base', () => {
    const withRoth = taxableBasis(
      pkg({ employedIncome: 100000, rothIRADistribution: 80000 }), USER);
    const without = taxableBasis(pkg({ employedIncome: 100000 }), USER);
    expect(withRoth.magi.amount).toBeCloseTo(without.magi.amount, 6);
    expect(withRoth.netInvestmentIncome.amount).toBe(0);
  });
});

/**
 * The reason NIIT is worth modelling at all. A qualified-plan distribution can
 * never be taxed by NIIT itself, yet by raising MAGI it can drag OTHER
 * investment income over the threshold. An implementation that treats the two
 * bases as the same quantity loses this entirely, and it is the part a user
 * would actually plan around (Roth conversion sizing).
 */
describe('the §1411 asymmetry', () => {
  it('puts an IRA distribution in MAGI but not in NII', () => {
    const b = taxableBasis(pkg({ tradIRADistribution: 120000 }), USER);
    expect(b.magi.amount).toBeCloseTo(120000, 6);
    expect(b.netInvestmentIncome.amount).toBe(0);
  });

  it('puts a 401(k) distribution in MAGI but not in NII', () => {
    const b = taxableBasis(pkg({ four01KDistribution: 120000 }), USER);
    expect(b.magi.amount).toBeCloseTo(120000, 6);
    expect(b.netInvestmentIncome.amount).toBe(0);
  });

  it('lets a distribution carry gains over the threshold it cannot itself cross', () => {
    // 30,000 of gain is far below the 200,000 single threshold on its own.
    const gainsOnly = taxableBasis(pkg({ longTermCapitalGains: 30000 }), USER);
    expect(gainsOnly.magi.amount).toBeCloseTo(30000, 6);

    // Add a 250,000 conversion: MAGI clears the threshold, and the amount
    // exposed is the GAIN, not the conversion.
    const withDraw = taxableBasis(
      pkg({ longTermCapitalGains: 30000, tradIRADistribution: 250000 }), USER);
    expect(withDraw.magi.amount).toBeCloseTo(280000, 6);
    expect(withDraw.netInvestmentIncome.amount).toBeCloseTo(30000, 6);
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
    // Wages again carry the deduction, so this measures the ×12 and nothing else.
    const b = taxableBasis(
      pkg({ employedIncome: 10000, longTermCapitalGains: 1000 }), USER, { annualise: true });
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
