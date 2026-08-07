/**
 * bracket-tiling.test.js — the bands must tile.
 *
 * Every bracket row's `fromAmount` has to equal the previous row's `toAmount`.
 * The IRS publishes them a dollar apart ("$12,401 to $50,400") and this file
 * used to copy that literally, which cost a dollar of base at every crossed
 * boundary and left the dollar in each gap taxed at no rate at all. Two
 * transcription errors were hiding in the same rows: a 31-dollar gap, and a
 * 99-dollar OVERLAP that was taxed at two rates simultaneously.
 *
 * That is the kind of defect a total is far too coarse to catch — it cost $0.37
 * on a $49,851 liability, found only by an independent hand calculation. So the
 * invariant is asserted on the data directly, where it is unambiguous.
 */

import { describe, it, expect } from 'vitest';

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

const { us_2025_taxtables, us_2026_taxtables } = await import('../../js/taxes.js');

const TABLES = [
  ['2025', us_2025_taxtables],
  ['2026', us_2026_taxtables],
];

for (const [year, tables] of TABLES) {
  for (const kind of ['income', 'capitalGains']) {
    for (const table of tables[kind].tables) {
      describe(`${year} ${kind} ${table.filingType}`, () => {
        const rows = table.taxRows;

        it('bands tile exactly — no gap, no overlap', () => {
          for (let i = 1; i < rows.length; i++) {
            expect(
              rows[i].fromAmount,
              `row ${i} (${rows[i].rate}) starts at ${rows[i].fromAmount} but row ${i - 1} ends at ${rows[i - 1].toAmount}`,
            ).toBe(rows[i - 1].toAmount);
          }
        });

        it('starts at zero and ends open', () => {
          expect(rows[0].fromAmount).toBe(0);
          expect(rows[rows.length - 1].toAmount).toBe(-1);
        });

        it('boundaries ascend and rates rise with them', () => {
          for (let i = 1; i < rows.length; i++) {
            expect(rows[i].fromAmount).toBeGreaterThan(rows[i - 1].fromAmount);
            expect(rows[i].rate).toBeGreaterThan(rows[i - 1].rate);
          }
        });
      });
    }
  }
}
