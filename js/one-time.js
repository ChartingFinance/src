/**
 * OneTimeEvent — a one-time cash event (bonus, gift, wedding, tuition, etc.)
 * credited or debited from an asset on a specific date.
 *
 * Stored as an array on ModelAsset. Each entry fires once during simulation
 * when the chronometer reaches the matching dateInt.
 */

import { Currency } from './utils/currency.js';
import { DateInt } from './utils/date-int.js';

export class OneTimeEvent {

  constructor(dateInt, amount, note = '') {
    this.dateInt = dateInt;
    this.amount = amount instanceof Currency ? amount.copy() : new Currency(amount);
    this.note = note;
  }

  static fromJSON(obj) {
    return new OneTimeEvent(
      new DateInt(obj.dateInt.year * 100 + obj.dateInt.month),
      new Currency(parseFloat(obj.amount?.amount ?? obj.amount ?? 0)),
      obj.note ?? ''
    );
  }

  toJSON() {
    return { dateInt: this.dateInt, amount: this.amount, note: this.note };
  }
}
/**
 * What a row of the One-Time Events form holds, from its three inputs.
 *
 *   { event }    a date and an amount other than zero
 *   { empty }    no amount typed: nothing to save
 *   { problem }  an amount that cannot be an event, and why
 *
 * @param {{date: string, amount: string, note: string}} row  the inputs' values
 */
export function readOneTimeRow({ date, amount, note }) {
  const typed = String(amount ?? '').trim();
  if (typed === '') return { empty: true };
  const value = parseFloat(typed);
  if (Number.isNaN(value) || value === 0) {
    return { problem: 'Enter an amount other than 0: negative for money out, positive for money in.' };
  }
  if (!date) return { problem: 'Pick the month this happens.' };
  return { event: new OneTimeEvent(DateInt.parse(date), new Currency(value), String(note ?? '').trim()) };
}
