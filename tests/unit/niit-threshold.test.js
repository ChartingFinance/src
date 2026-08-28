/**
 * niit-threshold.test.js — spec 8, the §1411 threshold and its non-indexing.
 *
 * The threshold is the whole rule. IRC §1411 fixed it at $200,000 single /
 * $250,000 MFJ in 2013 and has never indexed it, which is not an oversight in
 * the statute — standing still is how it reaches more households every year.
 *
 * `inflateTaxes()` indexes everything else in the table by default, so the
 * absence of one line there is the entire correctness of this rule over a
 * 30-year projection. An absence cannot be reviewed and cannot fail loudly, so
 * it is asserted here directly: inflate hard, then check the threshold did not
 * move while a neighbouring figure did.
 *
 * The rate is pinned for the same reason — 3.8% is statutory, not indexed, and
 * a table-driven rate is one careless edit from becoming a variable.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { makeActiveTaxTable } from '../../js/globals.js';

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

const G = await import('../../js/globals.js');
const { TaxTable, us_2025_taxtables, us_2026_taxtables } = await import('../../js/taxes.js');

function tableFor(filingAs) {
  G.global_reset();
  G.global_setFilingAs(filingAs);
  G.global_getFilingAs();
  const t = makeActiveTaxTable();
  G.setActiveTaxTable(t);
  return t;
}

beforeEach(() => { G.global_reset(); });

describe('the published figures', () => {
  it('is $200,000 filing single', () => {
    expect(tableFor('Single').activeNIITThreshold).toBe(200000);
  });

  it('is $250,000 filing jointly', () => {
    expect(tableFor('MFJ').activeNIITThreshold).toBe(250000);
  });

  it('charges 3.8%', () => {
    expect(tableFor('Single').niitRate).toBe(0.038);
    expect(tableFor('MFJ').niitRate).toBe(0.038);
  });

  it('carries the same figures in both year tables — neither is indexed', () => {
    for (const table of [us_2025_taxtables, us_2026_taxtables]) {
      expect(table.niit.single).toBe(200000);
      expect(table.niit.married).toBe(250000);
      expect(table.niit.rate).toBe(0.038);
    }
  });
});

describe('inflateTaxes leaves it alone', () => {
  it('does not move the threshold, while the standard deduction does move', () => {
    const t = tableFor('Single');
    const deductionBefore = t.activeStandardDeduction;

    t.inflateTaxes(0.05);

    expect(t.activeNIITThreshold).toBe(200000);
    // The control: if this did not move, inflateTaxes did nothing and the
    // assertion above would pass for the wrong reason.
    expect(t.activeStandardDeduction).toBeCloseTo(deductionBefore * 1.05, 6);
  });

  it('still does not move it after thirty years of compounding', () => {
    const t = tableFor('MFJ');
    for (let i = 0; i < 30; i++) t.inflateTaxes(0.031);
    expect(t.activeNIITThreshold).toBe(250000);
  });

  it('does not move the rate either', () => {
    const t = tableFor('Single');
    for (let i = 0; i < 10; i++) t.inflateTaxes(0.031);
    expect(t.niitRate).toBe(0.038);
  });

  it('leaves the §121 exclusion alone too — the existing non-indexed figure', () => {
    // Guards the neighbour this rule was modelled on, so a future edit to
    // inflateTaxes cannot quietly start indexing one of them.
    const t = tableFor('Single');
    t.inflateTaxes(0.05);
    expect(t.activeHomeSaleExclusion).toBe(250000);
  });
});

/**
 * The `min` is the rule. Each case below is hand-computed and states WHICH
 * argument binds, because an implementation that drops either one still passes
 * any test where they happen to agree.
 */
describe('calculateNIIT', () => {
  const C = (n) => ({ amount: n });

  it('charges nothing below the threshold, however much of it is investment income', () => {
    const t = tableFor('Single');
    // 150,000 MAGI, all of it NII. Under 200,000, so nothing is due.
    expect(t.calculateNIIT(C(150000), C(150000)).amount).toBe(0);
  });

  it('charges nothing above the threshold when there is no investment income', () => {
    const t = tableFor('MFJ');
    // 432,000 of wages, zero NII. The MAGI side alone would bill 6,916.
    expect(t.calculateNIIT(C(0), C(432000)).amount).toBe(0);
  });

  it('binds on the MAGI excess when that is the smaller', () => {
    const t = tableFor('Single');
    // MAGI 250,000 → 50,000 over. NII 80,000. min = 50,000 → 1,900.
    expect(t.calculateNIIT(C(80000), C(250000)).amount).toBeCloseTo(1900, 6);
  });

  it('binds on net investment income when that is the smaller', () => {
    const t = tableFor('Single');
    // MAGI 400,000 → 200,000 over. NII 30,000. min = 30,000 → 1,140.
    expect(t.calculateNIIT(C(30000), C(400000)).amount).toBeCloseTo(1140, 6);
  });

  it('charges nothing exactly at the threshold', () => {
    const t = tableFor('Single');
    expect(t.calculateNIIT(C(50000), C(200000)).amount).toBe(0);
  });

  it('uses the MFJ threshold when filing jointly', () => {
    const t = tableFor('MFJ');
    // 300,000 MAGI → 50,000 over the 250,000 joint threshold. NII 60,000.
    // min = 50,000 → 1,900. The single threshold would have billed 3,800.
    expect(t.calculateNIIT(C(60000), C(300000)).amount).toBeCloseTo(1900, 6);
  });

  it('never returns a negative tax on a MAGI far below the threshold', () => {
    const t = tableFor('Single');
    expect(t.calculateNIIT(C(0), C(10000)).amount).toBe(0);
  });
});
