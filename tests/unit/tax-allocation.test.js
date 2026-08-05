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

const { planAllocation, isAllocationEligible, basisThisMonth, basisOverMonths, BASIS_METRICS } =
  await import('../../js/tax-allocation.js');
const { Metric } = await import('../../js/metric.js');
const { Instrument } = await import('../../js/instruments/instrument.js');

// Minimal stand-in: only what the module actually touches.
function fakeAsset({ instrument, balance = 1000, closed = false, current = {}, history = {} }) {
  return {
    instrument,
    isClosed: closed,
    finishCurrency: { amount: balance },
    getMetricAmount: (m) => current[m] ?? 0,
    getHistory: (m) => history[m],
  };
}

describe('BASIS_METRICS', () => {
  it('excludes Metric.INCOME, which would pull in tax-free distributions', () => {
    expect(BASIS_METRICS).not.toContain(Metric.INCOME);
    expect(BASIS_METRICS).not.toContain(Metric.TAX_FREE_DISTRIBUTION);
    expect(BASIS_METRICS).not.toContain(Metric.ROTH_IRA_DISTRIBUTION);
  });

  it('is the three disjoint taxable-income parents', () => {
    expect([...BASIS_METRICS].sort()).toEqual(
      [Metric.ORDINARY_INCOME, Metric.CAPITAL_GAIN, Metric.QUALIFIED_DIVIDEND].sort());
  });
});

describe('basisThisMonth', () => {
  it('sums the three basis metrics', () => {
    const a = fakeAsset({
      instrument: Instrument.TAXABLE_EQUITY,
      current: { [Metric.ORDINARY_INCOME]: 100, [Metric.CAPITAL_GAIN]: 250, [Metric.QUALIFIED_DIVIDEND]: 50 },
    });
    expect(basisThisMonth(a)).toBe(400);
  });

  it('ignores tax-free distributions entirely', () => {
    const roth = fakeAsset({
      instrument: Instrument.ROTH_IRA,
      current: { [Metric.TAX_FREE_DISTRIBUTION]: 40000, [Metric.ROTH_IRA_DISTRIBUTION]: 40000 },
    });
    expect(basisThisMonth(roth)).toBe(0);
  });
});

describe('basisOverMonths', () => {
  const a = fakeAsset({
    instrument: Instrument.TAXABLE_EQUITY,
    history: {
      [Metric.ORDINARY_INCOME]: [1, 2, 3, 4, 5, 6],
      [Metric.CAPITAL_GAIN]: [10, 20, 30, 40, 50, 60],
    },
  });

  it('sums an inclusive index range across metrics', () => {
    expect(basisOverMonths(a, 1, 3)).toBe((2 + 3 + 4) + (20 + 30 + 40));
  });

  it('clamps past the end of history instead of adding undefined', () => {
    expect(basisOverMonths(a, 4, 99)).toBe((5 + 6) + (50 + 60));
  });

  it('clamps a negative low index', () => {
    expect(basisOverMonths(a, -5, 0)).toBe(1 + 10);
  });

  it('returns 0 for an untracked metric rather than throwing', () => {
    const bare = fakeAsset({ instrument: Instrument.BANK, history: {} });
    expect(basisOverMonths(bare, 0, 10)).toBe(0);
  });
});

describe('isAllocationEligible', () => {
  const AGE = 60;

  it('accepts everyday backstop accounts at any age', () => {
    for (const inst of [Instrument.CASH, Instrument.BANK, Instrument.TAXABLE_EQUITY,
                        Instrument.US_BOND, Instrument.CORP_BOND]) {
      expect(isAllocationEligible(fakeAsset({ instrument: inst }), 25)).toBe(true);
    }
  });

  it('rejects tax-deferred accounts below the threshold', () => {
    for (const inst of [Instrument.IRA, Instrument.FOUR_01K]) {
      expect(isAllocationEligible(fakeAsset({ instrument: inst }), AGE - 1)).toBe(false);
    }
  });

  it('accepts tax-deferred accounts at and above the threshold', () => {
    for (const inst of [Instrument.IRA, Instrument.FOUR_01K]) {
      expect(isAllocationEligible(fakeAsset({ instrument: inst }), AGE)).toBe(true);
      expect(isAllocationEligible(fakeAsset({ instrument: inst }), AGE + 20)).toBe(true);
    }
  });

  it('NEVER accepts Roth, at any age', () => {
    for (const age of [25, 59, 60, 61, 90]) {
      expect(isAllocationEligible(fakeAsset({ instrument: Instrument.ROTH_IRA }), age)).toBe(false);
    }
  });

  it('rejects real estate and mortgages — you cannot pay tax with part of a house', () => {
    expect(isAllocationEligible(fakeAsset({ instrument: Instrument.REAL_ESTATE }), 70)).toBe(false);
    expect(isAllocationEligible(fakeAsset({ instrument: Instrument.MORTGAGE, balance: -1 }), 70)).toBe(false);
  });

  it('rejects income flows — no balance to debit', () => {
    for (const inst of [Instrument.RETIREMENT_INCOME, Instrument.PENSION, Instrument.WORKING_INCOME]) {
      expect(isAllocationEligible(fakeAsset({ instrument: inst }), 70)).toBe(false);
    }
  });

  it('rejects a closed or empty account', () => {
    expect(isAllocationEligible(fakeAsset({ instrument: Instrument.BANK, closed: true }), 70)).toBe(false);
    expect(isAllocationEligible(fakeAsset({ instrument: Instrument.BANK, balance: 0 }), 70)).toBe(false);
    expect(isAllocationEligible(fakeAsset({ instrument: Instrument.BANK, balance: -5 }), 70)).toBe(false);
  });
});

describe('planAllocation', () => {
  const A = fakeAsset({ instrument: Instrument.TAXABLE_EQUITY });
  const B = fakeAsset({ instrument: Instrument.US_BOND });
  const C = fakeAsset({ instrument: Instrument.BANK });
  const sum = (legs) => legs.reduce((s, l) => s + l.amount, 0);

  it('splits in proportion to basis', () => {
    const legs = planAllocation(1000, [{ modelAsset: A, basis: 750 }, { modelAsset: B, basis: 250 }]);
    expect(legs.map(l => l.amount)).toEqual([750, 250]);
  });

  it('sums to the bill EXACTLY on a ratio that does not divide evenly', () => {
    // 1/3 each of a penny-odd bill is the classic largest-remainder trap.
    const legs = planAllocation(100.01, [
      { modelAsset: A, basis: 1 }, { modelAsset: B, basis: 1 }, { modelAsset: C, basis: 1 },
    ]);
    expect(Math.round(sum(legs) * 100)).toBe(10001);
  });

  it('sums to the bill exactly across many awkward ratios', () => {
    for (const bill of [0.03, 1.01, 99.99, 1234.56, 7777.77]) {
      for (const bases of [[1, 2], [1, 1, 1], [7, 11, 13], [999999, 1], [1, 1, 1, 1, 1, 1, 1]]) {
        const legs = planAllocation(bill, bases.map((b, i) =>
          ({ modelAsset: [A, B, C, A, B, C, A][i], basis: b })));
        expect(Math.round(sum(legs) * 100), `bill ${bill} bases ${bases}`).toBe(Math.round(bill * 100));
      }
    }
  });

  it('reports each leg its share of the basis', () => {
    const legs = planAllocation(100, [{ modelAsset: A, basis: 3 }, { modelAsset: B, basis: 1 }]);
    expect(legs[0].share).toBeCloseTo(0.75, 10);
    expect(legs[1].share).toBeCloseTo(0.25, 10);
  });

  it('drops non-positive bases rather than booking $0 legs', () => {
    const legs = planAllocation(100, [
      { modelAsset: A, basis: 100 }, { modelAsset: B, basis: 0 }, { modelAsset: C, basis: -5 },
    ]);
    expect(legs).toHaveLength(1);
    expect(legs[0].amount).toBe(100);
  });

  it('returns nothing when there is no eligible basis, so the caller falls back', () => {
    expect(planAllocation(100, [])).toEqual([]);
    expect(planAllocation(100, [{ modelAsset: A, basis: 0 }])).toEqual([]);
    expect(planAllocation(0, [{ modelAsset: A, basis: 100 }])).toEqual([]);
    expect(planAllocation(-50, [{ modelAsset: A, basis: 100 }])).toEqual([]);
  });

  it('does not emit a leg smaller than a cent', () => {
    const legs = planAllocation(0.01, [{ modelAsset: A, basis: 1e9 }, { modelAsset: B, basis: 1 }]);
    expect(legs).toHaveLength(1);
    expect(legs[0].amount).toBe(0.01);
  });
});
