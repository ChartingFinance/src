/**
 * form-helpers.test.js — the small rules behind four forms.
 *
 * Each of these was a defect found by reading a component (review 2026-11-11),
 * and each sat in an event handler nothing could test. The rule now lives in a
 * function, and the handler calls it.
 *
 *   assetNameProblem        the asset form took a blank name, and a name another
 *                           asset already had
 *   readOneTimeRow          "Save Changes" in the One-Time Events modal dropped
 *                           the row that was still being typed
 *   downPaymentPercentFrom  a typed 150% asked for a mortgage of minus half the
 *                           price
 *   csvCell                 an asset called "Savings, joint" shifted every
 *                           column of the CSV after it
 */

import { describe, it, expect } from 'vitest';

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

const { assetNameProblem } = await import('../../js/asset-edit.js');
const { readOneTimeRow, OneTimeEvent } = await import('../../js/one-time.js');
const { downPaymentPercentFrom } = await import('../../js/components/funding-modal.js');
const { csvCell } = await import('../../js/components/spreadsheet-view.js');

describe('assetNameProblem', () => {
  const others = ['Savings', 'Salary'];

  it('takes a name no other asset has', () => {
    expect(assetNameProblem('Brokerage', others)).toBeNull();
    expect(assetNameProblem('Savings 2', others)).toBeNull();
    expect(assetNameProblem('Anything', [])).toBeNull();
    expect(assetNameProblem('Anything')).toBeNull();
  });

  it('refuses a blank name', () => {
    expect(assetNameProblem('', others)).toMatch(/name/);
    expect(assetNameProblem('   ', others)).toMatch(/name/);
    expect(assetNameProblem(undefined, others)).toMatch(/name/);
  });

  it('refuses a name another asset has, whatever its case or outer spaces', () => {
    expect(assetNameProblem('Savings', others)).toMatch(/already called "Savings"/);
    expect(assetNameProblem('savings', others)).toMatch(/already called "Savings"/);
    expect(assetNameProblem('  SAVINGS ', others)).toMatch(/already called "Savings"/);
  });
});

describe('readOneTimeRow', () => {
  it('reads a date and an amount as an event', () => {
    const { event } = readOneTimeRow({ date: '2031-04', amount: '-5000', note: ' Roof ' });
    expect(event).toBeInstanceOf(OneTimeEvent);
    expect(event.amount.amount).toBe(-5000);
    expect(event.dateInt.toHTML()).toBe('2031-04');
    expect(event.note).toBe('Roof');
  });

  it('reads a row with no amount as empty, not as a mistake', () => {
    expect(readOneTimeRow({ date: '2031-04', amount: '', note: '' })).toEqual({ empty: true });
    expect(readOneTimeRow({ date: '2031-04', amount: '  ', note: 'typed a note only' })).toEqual({ empty: true });
  });

  it('says what is wrong with an amount that cannot be an event', () => {
    expect(readOneTimeRow({ date: '2031-04', amount: '0', note: '' }).problem).toMatch(/other than 0/);
    expect(readOneTimeRow({ date: '2031-04', amount: 'abc', note: '' }).problem).toMatch(/other than 0/);
    expect(readOneTimeRow({ date: '', amount: '500', note: '' }).problem).toMatch(/month/);
  });
});

describe('downPaymentPercentFrom', () => {
  it('keeps a percentage from 1 to 99', () => {
    expect(downPaymentPercentFrom('20')).toBe(20);
    expect(downPaymentPercentFrom('1')).toBe(1);
    expect(downPaymentPercentFrom('99')).toBe(99);
  });

  it('clamps what is outside it', () => {
    expect(downPaymentPercentFrom('150')).toBe(99);
    expect(downPaymentPercentFrom('100')).toBe(99);
    expect(downPaymentPercentFrom('0')).toBe(1);
    expect(downPaymentPercentFrom('-5')).toBe(1);
  });

  it('gives null for text that is not a number', () => {
    expect(downPaymentPercentFrom('')).toBeNull();
    expect(downPaymentPercentFrom('abc')).toBeNull();
  });
});

describe('csvCell', () => {
  it('leaves a plain cell alone', () => {
    expect(csvCell('Savings')).toBe('Savings');
    expect(csvCell('401K Contrib')).toBe('401K Contrib');
    expect(csvCell('')).toBe('');
  });

  it('quotes a comma, a quote or a line break, doubling quotes', () => {
    expect(csvCell('Savings, joint')).toBe('"Savings, joint"');
    expect(csvCell('The "big" one')).toBe('"The ""big"" one"');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });
});

describe('<spreadsheet-view>.toCSV', () => {
  it('keeps an asset name with a comma in one cell', async () => {
    const { DateInt } = await import('../../js/utils/date-int.js');
    // Lit's Node build defines the element without a document.
    const view = new (customElements.get('spreadsheet-view'))();
    view.portfolio = {
      firstDateInt: DateInt.from(2026, 1),
      lastDateInt: DateInt.from(2026, 2),
      modelAssets: [{ displayName: 'Savings, joint', monthlyValues: [100, 250.5] }],
    };
    const [names, labels, ...rows] = view.toCSV().split('\n');
    expect(names).toBe('Date,"Savings, joint"');
    expect(labels.split(',')).toHaveLength(2);
    expect(rows).toEqual(['2026-01,100.00', '2026-02,250.50']);
  });
});
