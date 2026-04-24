import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  globalThis.window = globalThis;
});

const { Currency }   = await import('../../js/utils/currency.js');
const { DateInt }    = await import('../../js/utils/date-int.js');
const { ARR }        = await import('../../js/utils/arr.js');
const { ModelAsset } = await import('../../js/model-asset.js');
const { Instrument } = await import('../../js/instruments/instrument.js');

function makeAsset(instrument, { value = 0, basis = 0 } = {}) {
  const asset = new ModelAsset({
    instrument,
    displayName: `test-${instrument}`,
    startDateInt: DateInt.from(2026, 1),
    finishDateInt: DateInt.from(2040, 12),
    startCurrency: new Currency(value),
    startBasisCurrency: new Currency(basis),
    annualReturnRate: new ARR(0),
  });
  asset.initializeChron();
  asset.finishCurrency = new Currency(value);
  asset.finishBasisCurrency = new Currency(basis);
  return asset;
}

describe('ModelAsset.debit — taxable account', () => {
  it('partial withdrawal updates balance and basis proportionally, no spillover', () => {
    const asset = makeAsset(Instrument.TAXABLE_EQUITY, { value: 10000, basis: 6000 });
    const result = asset.debit(new Currency(2000));

    // fractionSold = 2000 / 10000 = 0.2
    // basisWithdrawn = 6000 * 0.2 = 1200
    // realizedGain = 2000 - 1200 = 800
    expect(result.realizedGain.amount).toBeCloseTo(800, 6);
    expect(result.spillover.amount).toBe(0);
    expect(asset.finishCurrency.amount).toBeCloseTo(8000, 6);
    expect(asset.finishBasisCurrency.amount).toBeCloseTo(4800, 6);
    expect(asset.isDepleted).toBe(false);
  });

  it('full liquidation zeros value and basis, realizes entire gain', () => {
    const asset = makeAsset(Instrument.TAXABLE_EQUITY, { value: 10000, basis: 6000 });
    const result = asset.debit(new Currency(10000));

    expect(result.realizedGain.amount).toBeCloseTo(4000, 6);
    expect(asset.finishCurrency.amount).toBe(0);
    expect(asset.finishBasisCurrency.amount).toBe(0);
  });
});

describe('ModelAsset.debit — tax-deferred account', () => {
  it('withdrawal within balance reduces finishCurrency without spillover', () => {
    const asset = makeAsset(Instrument.FOUR_01K, { value: 50000, basis: 0 });
    const result = asset.debit(new Currency(1000));

    expect(result.spillover.amount).toBe(0);
    expect(asset.finishCurrency.amount).toBe(49000);
    expect(asset.isDepleted).toBe(false);
  });

  it('overdraft raises spillover, clamps balance to zero, flags depleted', () => {
    const asset = makeAsset(Instrument.FOUR_01K, { value: 1000, basis: 0 });
    const result = asset.debit(new Currency(1500));

    expect(result.spillover.amount).toBe(500);
    expect(asset.finishCurrency.amount).toBe(0);
    expect(asset.finishBasisCurrency.amount).toBe(0);
    expect(asset.isDepleted).toBe(true);
    // No capital gain on tax-deferred withdrawal
    expect(result.realizedGain.amount).toBe(0);
  });
});

describe('ModelAsset.debit — conservation of balance', () => {
  it('credit then debit same amount leaves asset net zero change', () => {
    const asset = makeAsset(Instrument.TAXABLE_EQUITY, { value: 0, basis: 0 });
    asset.credit(new Currency(500));
    const before = asset.finishCurrency.amount;
    asset.debit(new Currency(500));
    expect(asset.finishCurrency.amount).toBe(before - 500);
    expect(asset.finishCurrency.amount).toBe(0);
  });
});
