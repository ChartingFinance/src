/**
 * months-span.js
 *
 * Determines how to bucket monthly data for chart display based on
 * the total time span: monthly for ≤3yr, quarterly for 3-7yr,
 * semi-annual for 7-18yr, annual for 18yr+.
 */

import { DateInt } from './date-int.js';

export class MonthsSpan {
  /**
   * @param {number} totalMonths
   * @param {number} combineMonths   How many months per bucket
   * @param {number} offsetMonths    Align to quarter/semi-annual/annual boundaries
   */
  constructor(totalMonths, combineMonths, offsetMonths) {
    this.totalMonths   = totalMonths;
    this.combineMonths = combineMonths;
    this.offsetMonths  = offsetMonths;
  }

  static build(firstDateInt, lastDateInt) {
    const totalMonths = DateInt.diffMonths(firstDateInt, lastDateInt);
    let combineMonths = 1;
    let offsetMonths  = 0;

    if (totalMonths > 36 && totalMonths <= 84) {
      // Quarterly
      combineMonths = 3;
      const m = firstDateInt.month;
      if ([2, 5, 8, 11].includes(m))  offsetMonths = 2;
      else if ([3, 6, 9, 12].includes(m)) offsetMonths = 1;

    } else if (totalMonths > 84 && totalMonths <= 216) {
      // Semi-annual
      combineMonths = 6;
      const m = firstDateInt.month;
      if (m > 1 && m < 7)  offsetMonths = 7 - m;
      else if (m > 7 && m < 13) offsetMonths = 13 - m;

    } else if (totalMonths > 216) {
      // Annual
      combineMonths = 12;
      if (firstDateInt.month > 1) offsetMonths = 13 - firstDateInt.month;
    }

    return new MonthsSpan(totalMonths, combineMonths, offsetMonths);
  }
}
