/**
 * fica-owner-seam.test.js — the Social Security wage base is per person.
 *
 * MFJ is modelled at the household level, so there is one User and the
 * accumulator has exactly ONE key. That makes the seam invisible to the snapshot
 * corpus: it was added under an empty baseline diff, which is also what a
 * cosmetic rename would produce.
 *
 * So the capability is asserted directly. Two owners must not share a base —
 * that is the whole reason the Map exists, and if it ever stops being true the
 * per-person spec inherits a seam that does not work.
 *
 * The bug this is a seam FOR: two spouses each get their own wage base
 * ($184,500 in 2026), and this engine gives them one between them. Visible in
 * the mfj-two-earners fixture, where a $216,000 earner stops paying SS tax in
 * June instead of month 11.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { makeActiveTaxTable } from '../../js/globals.js';

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

const G = await import('../../js/globals.js');
const { TaxTable, TaxOwner } = await import('../../js/taxes.js');
const { Currency } = await import('../../js/utils/currency.js');

// 2026 figures, un-inflated: a fresh TaxTable has not rolled a year.
const WAGE_BASE = 184500;
const SS_RATE = 0.062;
const SE_SS_RATE = 0.124;

let table;
beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  G.global_reset();
  table = makeActiveTaxTable();
});

describe('one owner', () => {
  it('caps at the wage base', () => {
    table.addYearlySocialSecurity(new Currency(WAGE_BASE), TaxOwner.PRIMARY);
    const more = table.calculateSocialSecurityTax(false, new Currency(10000), TaxOwner.PRIMARY);
    expect(more.amount).toBeCloseTo(0, 6);
  });

  it('taxes at the full rate below the base', () => {
    const tax = table.calculateSocialSecurityTax(false, new Currency(10000), TaxOwner.PRIMARY);
    expect(tax.amount).toBeCloseTo(10000 * SS_RATE, 6);
  });

  it('defaults to PRIMARY, so callers that omit an owner share one base', () => {
    table.addYearlySocialSecurity(new Currency(WAGE_BASE));
    expect(table.calculateSocialSecurityTax(false, new Currency(10000)).amount).toBeCloseTo(0, 6);
  });

  it('never returns negative SS tax on mixed self-employed + W-2 income (RED-4)', () => {
    // Accumulate $150k SE + $40k W-2 (past the $184,500 wage base)
    table.addYearlySocialSecurity(new Currency(150000), TaxOwner.PRIMARY);
    const partial = table.calculateSocialSecurityTax(false, new Currency(40000), TaxOwner.PRIMARY);
    expect(partial.amount).toBeCloseTo((WAGE_BASE - 150000) * SS_RATE, 6);
    table.addYearlySocialSecurity(new Currency(40000), TaxOwner.PRIMARY);

    // Once past the base, neither W-2 nor SE may go negative
    expect(table.calculateSocialSecurityTax(false, new Currency(5000), TaxOwner.PRIMARY).amount).toBe(0);
    expect(table.calculateSocialSecurityTax(true, new Currency(15000), TaxOwner.PRIMARY).amount).toBe(0);
  });

  it('taxes SE at 12.4% and W-2 at 6.2% against the shared covered-earnings cap (RED-4)', () => {
    // 12 months of $15,000 SE + $5,000 W-2 = $240,000/yr (> $184,500 base)
    let totalW2Tax = 0;
    let totalSETax = 0;
    for (let m = 0; m < 12; m++) {
      const seTax = table.calculateSocialSecurityTax(true, new Currency(15000), TaxOwner.PRIMARY).amount;
      expect(seTax).toBeGreaterThanOrEqual(0);
      table.addYearlySocialSecurity(new Currency(15000), TaxOwner.PRIMARY);
      totalSETax += seTax;

      const w2Tax = table.calculateSocialSecurityTax(false, new Currency(5000), TaxOwner.PRIMARY).amount;
      expect(w2Tax).toBeGreaterThanOrEqual(0);
      table.addYearlySocialSecurity(new Currency(5000), TaxOwner.PRIMARY);
      totalW2Tax += w2Tax;
    }
    // Months 1–9: $15k SE + $5k W-2 = $180k covered; Month 10: remaining $4,500 covered by SE
    expect(totalSETax).toBeCloseTo((9 * 15000 + 4500) * SE_SS_RATE, 6);
    expect(totalW2Tax).toBeCloseTo(9 * 5000 * SS_RATE, 6);
  });
});

describe('two owners — the capability the seam exists for', () => {
  const SPOUSE = 'spouse';   // not in TaxOwner yet; the Map takes any key

  it('do not share a wage base', () => {
    // Exhaust the primary earner's base entirely.
    table.addYearlySocialSecurity(new Currency(WAGE_BASE), TaxOwner.PRIMARY);
    expect(table.calculateSocialSecurityTax(false, new Currency(10000), TaxOwner.PRIMARY).amount)
      .toBeCloseTo(0, 6);

    // The second earner is untouched by that.
    expect(table.calculateSocialSecurityTax(false, new Currency(10000), SPOUSE).amount)
      .toBeCloseTo(620, 6);
  });

  it('accumulate independently', () => {
    table.addYearlySocialSecurity(new Currency(50000), TaxOwner.PRIMARY);
    table.addYearlySocialSecurity(new Currency(10000), SPOUSE);
    expect(table.yearlySocialSecurityByOwner.get(TaxOwner.PRIMARY).amount).toBeCloseTo(50000, 6);
    expect(table.yearlySocialSecurityByOwner.get(SPOUSE).amount).toBeCloseTo(10000, 6);
  });

  it('both reset on the same January', () => {
    table.addYearlySocialSecurity(new Currency(50000), TaxOwner.PRIMARY);
    table.addYearlySocialSecurity(new Currency(10000), SPOUSE);
    table.yearlyChron(0);   // no inflation, so only the reset is under test
    expect(table.yearlySocialSecurityByOwner.get(TaxOwner.PRIMARY).amount).toBe(0);
    expect(table.yearlySocialSecurityByOwner.get(SPOUSE).amount).toBe(0);
  });
});

describe('what the household scope still gets wrong', () => {
  it('ships with exactly one owner, which is why mfj-two-earners is wrong', () => {
    // Documents the limitation rather than asserting the bug is fixed: the
    // engine has one User, so payroll passes PRIMARY for every salary and two
    // earners really do share a base in a live run.
    expect(Object.values(TaxOwner)).toEqual(['primary']);
  });
});
