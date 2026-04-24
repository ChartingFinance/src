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

const { partialGeneBounds, PARTIAL_FLEX_FLOOR } = await import('../../js/simulator.js');

describe('partialGeneBounds — flex floor lets 0-seed genes explore', () => {
  it('applies the multiplicative rule when original × mutability exceeds the floor', () => {
    // original=80, mutability=0.25 → ±20, bigger than floor=10
    const { lo, hi } = partialGeneBounds(80, 0.25);
    expect(lo).toBe(60);
    expect(hi).toBe(100);
  });

  it('applies the floor when original × mutability is smaller than the floor', () => {
    // original=20, mutability=0.25 → ±5, floor=10 wins
    const { lo, hi } = partialGeneBounds(20, 0.25);
    expect(lo).toBe(10);
    expect(hi).toBe(30);
  });

  it('unlocks a 0-seeded gene to explore [0, FLOOR]', () => {
    const { lo, hi } = partialGeneBounds(0, 0.25);
    expect(lo).toBe(0);
    expect(hi).toBe(PARTIAL_FLEX_FLOOR);
  });

  it('clamps the upper bound at 100', () => {
    const { lo, hi } = partialGeneBounds(95, 0.25);
    expect(hi).toBe(100);
    // 95 × 0.25 = 23.75, floor is 10, so effective flex = 23.75; lo = 71.25
    expect(lo).toBeCloseTo(71.25, 6);
  });

  it('clamps the lower bound at 0', () => {
    const { lo, hi } = partialGeneBounds(5, 0.25);
    expect(lo).toBe(0);
    // floor wins (5×0.25=1.25 < 10), so hi = 5 + 10 = 15
    expect(hi).toBe(15);
  });
});
