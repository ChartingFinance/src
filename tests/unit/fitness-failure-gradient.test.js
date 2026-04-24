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

const { Simulator } = await import('../../js/simulator.js');

function mockPortfolio({ endingValue, cashFlow = 0, preservationEvents = 0, assets = [] }) {
  return {
    finishValue: () => ({ amount: endingValue }),
    yearlySnapshots: Array.from({ length: 30 }, () => ({ annualExpense: cashFlow / 30 })),
    guardrailEvents: Array.from({ length: preservationEvents }, () => ({ type: 'preservation' })),
    modelAssets: assets,
  };
}

// calculateFitness only reads `this.fitnessBalance`; no other state is touched.
function fitnessOf(portfolio, fitnessBalance = 0.5) {
  return Simulator.prototype.calculateFitness.call({ fitnessBalance }, portfolio);
}

describe('calculateFitness — failure gradient', () => {
  it('returns negative for failed portfolios', () => {
    const fit = fitnessOf(mockPortfolio({ endingValue: -1_000_000 }));
    expect(fit).toBeLessThan(0);
  });

  it('ranks deeper failures below shallower failures', () => {
    const shallow = fitnessOf(mockPortfolio({ endingValue: -100_000 }));
    const deep    = fitnessOf(mockPortfolio({ endingValue: -10_000_000 }));
    expect(shallow).toBeGreaterThan(deep);
  });

  it('ranks any success above any failure', () => {
    const worstFailure = fitnessOf(mockPortfolio({ endingValue: -1 }));
    const marginalWin  = fitnessOf(mockPortfolio({ endingValue: 1, cashFlow: 0 }));
    expect(marginalWin).toBeGreaterThan(worstFailure);
  });

  it('zero ending value counts as failure (hard constraint)', () => {
    const fit = fitnessOf(mockPortfolio({ endingValue: 0 }));
    expect(fit).toBeLessThan(0);
  });
});
