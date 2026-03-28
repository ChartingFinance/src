/**
 * Windfall — a one-time lump sum (bonus, gift, inheritance) credited to an asset.
 *
 * Stored as an array on ModelAsset. Each entry fires once during simulation
 * when the chronometer reaches the matching dateInt.
 */

import { Currency } from './utils/currency.js';
import { DateInt } from './utils/date-int.js';

export class Windfall {

  constructor(dateInt, amount, note = '') {
    this.dateInt = dateInt;
    this.amount = amount instanceof Currency ? amount.copy() : new Currency(amount);
    this.note = note;
  }

  static fromJSON(obj) {
    return new Windfall(
      new DateInt(obj.dateInt.year * 100 + obj.dateInt.month),
      new Currency(parseFloat(obj.amount?.amount ?? obj.amount ?? 0)),
      obj.note ?? ''
    );
  }

  toJSON() {
    return { dateInt: this.dateInt, amount: this.amount, note: this.note };
  }
}
