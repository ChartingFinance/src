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
const { Portfolio }  = await import('../../js/portfolio.js');
const { Instrument } = await import('../../js/instruments/instrument.js');

function makePortfolio() {
  const asset = new ModelAsset({
    instrument: Instrument.TAXABLE_EQUITY,
    displayName: 'Brokerage',
    startDateInt: DateInt.from(2026, 1),
    finishDateInt: DateInt.from(2040, 12),
    startCurrency: new Currency(1000),
    startBasisCurrency: new Currency(1000),
    annualReturnRate: new ARR(0),
  });
  return new Portfolio([asset], false);
}

describe('Portfolio.copy — snapshot of trace + summary fields', () => {
  it('copies guardrailEvents, yearlySnapshots, generatedReports', () => {
    const p = makePortfolio();
    p.guardrailEvents.push({ year: 2030, type: 'preservation', rate: 0.04, adjustedTo: 0.036 });
    p.yearlySnapshots.push({ year: 2030, investableAssets: 500_000, annualExpense: 40_000, withdrawalRate: 0.04 });
    p.generatedReports.push('# 2030 report');

    const c = p.copy();

    expect(c.guardrailEvents).toEqual(p.guardrailEvents);
    expect(c.yearlySnapshots).toEqual(p.yearlySnapshots);
    expect(c.generatedReports).toEqual(p.generatedReports);
  });

  it('copies guardrailsParams by value', () => {
    const p = makePortfolio();
    p.guardrailsParams = { withdrawalRate: 4, preservation: 20, prosperity: 20, adjustment: 10 };
    const c = p.copy();
    expect(c.guardrailsParams).toEqual(p.guardrailsParams);
    expect(c.guardrailsParams).not.toBe(p.guardrailsParams);
  });

  it('guardrailsParams stays null when source is null', () => {
    const p = makePortfolio();
    p.guardrailsParams = null;
    const c = p.copy();
    expect(c.guardrailsParams).toBeNull();
  });

  it('copies the monthly tax arrays', () => {
    const p = makePortfolio();
    p.monthlyPropertyTaxes.push(new Currency(100));
    p.monthlyIncomeTaxes.push(new Currency(200));
    p.monthlyCapitalGainsTaxes.push(new Currency(50));
    p.displayCapitalGainsTaxes.push(50);

    const c = p.copy();

    expect(c.monthlyPropertyTaxes).toHaveLength(1);
    expect(c.monthlyIncomeTaxes).toHaveLength(1);
    expect(c.monthlyCapitalGainsTaxes).toHaveLength(1);
    expect(c.displayCapitalGainsTaxes).toEqual([50]);
  });

  it('snapshot is independent — later mutations on source do not leak into copy', () => {
    const p = makePortfolio();
    p.guardrailEvents.push({ year: 2030, type: 'preservation' });
    const c = p.copy();

    // Simulate what the GA does between fitness evals: reassign to fresh array
    p.guardrailEvents = [];
    p.guardrailEvents.push({ year: 2031, type: 'prosperity' });

    expect(c.guardrailEvents).toHaveLength(1);
    expect(c.guardrailEvents[0].year).toBe(2030);
  });

  it('snapshot is independent — pushes to source arrays do not leak into copy', () => {
    const p = makePortfolio();
    p.yearlySnapshots.push({ year: 2030 });
    const c = p.copy();

    // Some arrays (e.g. monthly tax arrays) are not reassigned — just pushed to.
    // Verify we defended against that case too.
    p.yearlySnapshots.push({ year: 2031 });

    expect(c.yearlySnapshots).toHaveLength(1);
  });
});
