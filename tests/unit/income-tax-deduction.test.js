import { describe, it, expect } from 'vitest';
import { TaxTable } from '../../js/taxes.js';
import { Currency } from '../../js/utils/currency.js';

/**
 * `calculateYearlyIncomeTax(income, deduction)` never applied its deduction.
 *
 * It called `adjusted.subtract(deduction.amount)` — a number — and
 * `Currency.subtract` silently ignored anything that was not a Currency. So the
 * parameter had existed since it was written without ever subtracting
 * anything, and passing the standard deduction returned the UNDEDUCTED tax.
 *
 * Nothing broke visibly because the one caller that supplies a deduction
 * (`reconcileYearlyTax`) supplies `new Currency()` — zero — and every other
 * caller pre-subtracts. A dead parameter that looks live is a trap for whoever
 * reaches for it next; `build_plan` was about to.
 */
describe('TaxTable.calculateYearlyIncomeTax deduction', () => {
  const table = () => new TaxTable('Single', 40000);

  it('actually subtracts the deduction before walking the brackets', () => {
    const tt = table();
    const withDeduction = tt.calculateYearlyIncomeTax(
      new Currency(100000), new Currency(tt.activeStandardDeduction));
    const preSubtracted = tt.calculateYearlyIncomeTax(
      new Currency(100000 - tt.activeStandardDeduction));

    expect(withDeduction.amount).toBeCloseTo(preSubtracted.amount, 6);
    // The regression: this returned the undeducted figure, which is strictly
    // larger. An equality check alone would pass if BOTH became undeducted.
    const undeducted = tt.calculateYearlyIncomeTax(new Currency(100000));
    expect(withDeduction.amount).toBeLessThan(undeducted.amount);
  });

  it('is unchanged by a zero deduction — the only shape a caller passes today', () => {
    const tt = table();
    const zero = tt.calculateYearlyIncomeTax(new Currency(100000), new Currency());
    const none = tt.calculateYearlyIncomeTax(new Currency(100000));
    expect(zero.amount).toBe(none.amount);
  });

  it('omitting the deduction still means no deduction', () => {
    const tt = table();
    expect(tt.calculateYearlyIncomeTax(new Currency(50000)).amount)
      .toBeGreaterThan(0);
  });

  it('a deduction larger than income does not produce negative tax', () => {
    const tt = table();
    const tax = tt.calculateYearlyIncomeTax(new Currency(5000), new Currency(50000));
    expect(tax.amount).toBeGreaterThanOrEqual(0);
  });
});
