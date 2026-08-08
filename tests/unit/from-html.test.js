/**
 * from-html.test.js — the UI → domain boundary.
 *
 * ModelAsset.fromHTML turns what someone typed into a form into the object the
 * whole simulation runs on. It was, at cyclomatic complexity 16, the most
 * complex function in the engine with NO test of any kind: a mutation sweep on
 * 2026-08-07 stubbed it out entirely and the snapshot corpus, all 34 integration
 * suites and every unit test stayed green. FundTransfer.fromHTML (cx 8) was the
 * same.
 *
 * Nothing here needs a DOM. fromHTML reads `.name`, `.value`, `.type`,
 * `.checked` and `.getAttribute`, so plain objects are a truthful stand-in —
 * and a faster, clearer one than a headless browser.
 *
 * The bug this file was written around: an optional rate field that EXISTS but
 * is blank used to produce ARR(NaN), because the guard tested whether the
 * element was present rather than whether it had a value. NaN did not throw. It
 * silently removed the charge — a home with a NaN annualTaxRate pays no
 * property tax and the run completes clean. Measured over two years on one
 * portfolio: the backstop ended at $42,099 with a 1% rate, and at $50,000
 * untouched with NaN.
 */

import { describe, it, expect } from 'vitest';

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

const { ModelAsset } = await import('../../js/model-asset.js');
const { FundTransfer } = await import('../../js/fund-transfer.js');
const { ARR } = await import('../../js/utils/arr.js');
const { Currency } = await import('../../js/utils/currency.js');

/** A form input, duck-typed to what fromHTML actually reads. */
const el = (name, value, extra = {}) => ({
  name, value, getAttribute: () => null, ...extra,
});

/** The fields every asset form supplies. */
const REQUIRED = [
  el('instrument', 'taxableEquity'),
  el('displayName', 'Brokerage'),
  el('startDate', '2026-01'),
  el('startValue', '100000'),
  el('startBasisValue', '60000'),
];

const build = (extra = []) => ModelAsset.fromHTML([...REQUIRED, ...extra], null);

describe('the fields every form supplies', () => {
  it('maps instrument, name, date and money', () => {
    const a = build();
    expect(a.instrument).toBe('taxableEquity');
    expect(a.displayName).toBe('Brokerage');
    expect(a.startDateInt.year).toBe(2026);
    expect(a.startDateInt.month).toBe(1);
    expect(a.startCurrency.amount).toBe(100000);
    expect(a.startBasisCurrency.amount).toBe(60000);
  });

  it('strips currency formatting', () => {
    const a = build([el('startValue', '$1,234.56')]);
    expect(a.startCurrency.amount).toBeCloseTo(1234.56, 6);
  });

  it('reads an unparseable amount as zero, not NaN', () => {
    // Currency.parse guards with isNaN. Added after mutation testing showed
    // removing that guard left every other assertion here green: blank values
    // short-circuit on the !str check and never reach it, so only outright
    // garbage exercises it.
    expect(build([el('startValue', 'abc')]).startCurrency.amount).toBe(0);
    expect(build([el('startBasisValue', '--')]).startBasisCurrency.amount).toBe(0);
  });

  it('reads a percentage as a ratio', () => {
    expect(build([el('annualReturnRate', '7')]).annualReturnRate.annualReturnRate)
      .toBeCloseTo(0.07, 10);
    expect(build([el('annualReturnRate', '7%')]).annualReturnRate.annualReturnRate)
      .toBeCloseTo(0.07, 10);
  });

  it('leaves finishDate null when the field is empty', () => {
    expect(build([el('finishDate', '')]).finishDateInt).toBeNull();
    const f = build([el('finishDate', '2030-12')]).finishDateInt;
    expect([f.year, f.month]).toEqual([2030, 12]);
  });

  it('floors monthsRemaining at 0 rather than NaN', () => {
    expect(build([el('monthsRemaining', '360')]).monthsRemaining).toBe(360);
    expect(build([el('monthsRemaining', '')]).monthsRemaining).toBe(0);
    expect(build([el('monthsRemaining', 'nonsense')]).monthsRemaining).toBe(0);
  });
});

describe('a field that exists but was left blank', () => {
  // The regression this file exists for. Each of these used to be NaN, and NaN
  // does not announce itself — it removes the charge and the run looks fine.
  const BLANK = [
    el('annualReturnRate', ''),
    el('dividendRate', ''),
    el('dividendQualifiedRatio', ''),
    el('longTermRate', ''),
    el('annualTaxRate', ''),
    el('annualMaintenanceRate', ''),
    el('annualInsuranceCost', ''),
  ];

  it('never yields NaN', () => {
    const a = build(BLANK);
    const numbers = {
      annualReturnRate: a.annualReturnRate.annualReturnRate,
      annualDividendRate: a.annualDividendRate.annualReturnRate,
      dividendQualifiedRatio: a.dividendQualifiedRatio,
      longTermCapitalHoldingPercentage: a.longTermCapitalHoldingPercentage.annualReturnRate,
      annualTaxRate: a.annualTaxRate.annualReturnRate,
      annualMaintenanceRate: a.annualMaintenanceRate.annualReturnRate,
      annualInsuranceCost: a.annualInsuranceCost.amount,
    };
    for (const [field, value] of Object.entries(numbers)) {
      expect(Number.isFinite(value), `${field} is ${value}`).toBe(true);
    }
  });

  it('reads blank as zero for every rate', () => {
    const a = build(BLANK);
    expect(a.annualReturnRate.annualReturnRate).toBe(0);
    expect(a.annualDividendRate.annualReturnRate).toBe(0);
    expect(a.longTermCapitalHoldingPercentage.annualReturnRate).toBe(0);
    expect(a.annualTaxRate.annualReturnRate).toBe(0);
    expect(a.annualMaintenanceRate.annualReturnRate).toBe(0);
    expect(a.annualInsuranceCost.amount).toBe(0);
  });

  it('reads blank as "all qualified" for the dividend split', () => {
    // 1.0, not 0 — a blank split means the whole dividend is qualified, which
    // is the neutral reading. Zero would silently reclassify it all as
    // non-qualified and tax it as ordinary income.
    expect(build(BLANK).dividendQualifiedRatio).toBe(1.0);
  });

  it('reads garbage as the same fallback, not NaN', () => {
    const a = build([el('annualTaxRate', 'abc'), el('dividendQualifiedRatio', 'abc')]);
    expect(a.annualTaxRate.annualReturnRate).toBe(0);
    expect(a.dividendQualifiedRatio).toBe(1.0);
  });
});

describe('a field that is absent entirely', () => {
  it('defaults the rates to zero and the dividend split to all-qualified', () => {
    const a = build();
    expect(a.annualDividendRate.annualReturnRate).toBe(0);
    expect(a.dividendQualifiedRatio).toBe(1.0);
    expect(a.annualTaxRate.annualReturnRate).toBe(0);
  });

  it('defaults isPrimaryHome TRUE and isSelfEmployed FALSE', () => {
    // Deliberately asserted together, because the asymmetry is real and has
    // already cost this project: isPrimaryHome defaulting to true is why a
    // blast-radius scan on 2026-08-06 concluded the quick-start homes were not
    // primary residences when they are.
    const a = build();
    expect(a.isPrimaryHome).toBe(true);
    expect(a.isSelfEmployed).toBe(false);
  });
});

describe('checkboxes versus string values', () => {
  it('reads a checkbox by .checked', () => {
    expect(build([el('isSelfEmployed', '', { type: 'checkbox', checked: true })]).isSelfEmployed).toBe(true);
    expect(build([el('isSelfEmployed', '', { type: 'checkbox', checked: false })]).isSelfEmployed).toBe(false);
    expect(build([el('isPrimaryHome', '', { type: 'checkbox', checked: false })]).isPrimaryHome).toBe(false);
  });

  it('reads a non-checkbox by string, and the two use OPPOSITE tests', () => {
    // isSelfEmployed is true only when it says 'true'; isPrimaryHome is true
    // unless it says 'false'. Anything unexpected therefore lands on a
    // different default depending on the field.
    expect(build([el('isSelfEmployed', 'true')]).isSelfEmployed).toBe(true);
    expect(build([el('isSelfEmployed', 'yes')]).isSelfEmployed).toBe(false);
    expect(build([el('isPrimaryHome', 'false')]).isPrimaryHome).toBe(false);
    expect(build([el('isPrimaryHome', 'no')]).isPrimaryHome).toBe(true);
  });
});

describe('fund transfers, which arrive base64-encoded in a data attribute', () => {
  const withTransfers = (list) => build([
    { name: 'fundTransfers', value: '',
      getAttribute: (k) => (k === 'data-fundtransfers'
        ? Buffer.from(JSON.stringify(list), 'utf8').toString('base64')
        : null) },
  ]);

  it('decodes and rebuilds them', () => {
    const a = withTransfers([
      { toDisplayName: '401K', monthlyMoveValue: 10, closeMoveValue: 0 },
      { toDisplayName: 'Brokerage', monthlyMoveValue: 90, closeMoveValue: 100 },
    ]);
    expect(a.fundTransfers).toHaveLength(2);
    expect(a.fundTransfers[0].toDisplayName).toBe('401K');
    expect(a.fundTransfers[0].monthlyMoveValue).toBe(10);
    expect(a.fundTransfers[1].closeMoveValue).toBe(100);
  });

  it('yields none when the attribute is missing or empty', () => {
    expect(build().fundTransfers).toEqual([]);
    expect(withTransfers([]).fundTransfers).toEqual([]);
  });
});

describe('the value objects behind the boundary', () => {
  // The root cause, tested where it lives. Currency has always floored NaN in
  // its constructor; ARR stored whatever it was handed. That asymmetry is the
  // whole reason a blank rate field could reach the simulation as NaN while a
  // blank money field could not.
  it('ARR refuses NaN and infinity', () => {
    expect(new ARR(NaN).rate).toBe(0);
    expect(new ARR(Infinity).rate).toBe(0);
    expect(new ARR(undefined).rate).toBe(0);
    expect(new ARR(0.07).rate).toBeCloseTo(0.07, 10);
  });

  it('Currency refuses NaN and infinity', () => {
    expect(new Currency(NaN).amount).toBe(0);
    expect(new Currency(Infinity).amount).toBe(0);
    expect(new Currency(1234.56).amount).toBeCloseTo(1234.56, 6);
  });

  it('their parsers agree on garbage', () => {
    expect(ARR.parse('abc').rate).toBe(0);
    expect(Currency.parse('abc').amount).toBe(0);
    expect(ARR.parse('').rate).toBe(0);
    expect(Currency.parse('').amount).toBe(0);
  });
});

describe('FundTransfer.fromHTML', () => {
  it('reads a percentage pair, flooring blanks at 0', () => {
    const t = FundTransfer.fromHTML([
      el('toDisplayName', '401K'),
      el('monthlyMoveValue', '15'),
      el('closeMoveValue', ''),
    ]);
    expect(t.toDisplayName).toBe('401K');
    expect(t.monthlyMoveValue).toBe(15);
    expect(t.closeMoveValue).toBe(0);
  });

  it('is a PERCENTAGE of the source, not an amount', () => {
    // Worth pinning at the boundary: two fixture notes claimed these were
    // dollars and were wrong, which is how a predicted cap-removal failed to
    // happen on 2026-08-07.
    const t = FundTransfer.fromHTML([
      el('toDisplayName', 'Brokerage'),
      el('monthlyMoveValue', '100'),
    ]);
    expect(t.monthlyMoveValue).toBe(100);
  });
});
