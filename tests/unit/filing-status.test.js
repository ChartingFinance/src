/**
 * filing-status.test.js — one vocabulary, validated at the door.
 *
 * Filing status used to be a bare string with three spellings and a
 * `!= 'Single'` test as the only branch, so MFJ worked by falling through an
 * else. Anything unrecognised — a corrupted localStorage value, a future 'MFS'
 * option, a typo — filed the household jointly and changed the answer by up to
 * 49% without complaining.
 *
 * The contract now: code paths throw, untrusted input coerces.
 */

import { describe, it, expect, beforeEach } from 'vitest';

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

const G = await import('../../js/globals.js');
const { TaxTable } = await import('../../js/taxes.js');

beforeEach(() => { for (const k of Object.keys(store)) delete store[k]; G.global_reset(); });

describe('the domain', () => {
  it('is exactly Single and MFJ', () => {
    expect(G.FILING_STATUSES).toEqual(['Single', 'MFJ']);
  });

  it('matches the values the settings <select> emits', () => {
    // index.html offers option values "Single" and "MFJ". If either side moves
    // without the other, loading the app throws instead of filing jointly.
    expect(G.isFilingStatus('Single')).toBe(true);
    expect(G.isFilingStatus('MFJ')).toBe(true);
    expect(G.isFilingStatus('Married')).toBe(false);
    expect(G.isFilingStatus('married')).toBe(false);
    expect(G.isFilingStatus('mfj')).toBe(false);
  });
});

describe('global_setFilingAs — a code path, so it throws', () => {
  it('round-trips a known status', () => {
    G.global_setFilingAs('MFJ');
    G.global_getFilingAs();
    expect(G.global_filingAs).toBe('MFJ');
  });

  it('rejects an unknown status rather than defaulting', () => {
    expect(() => G.global_setFilingAs('Married')).toThrow(/not one of/);
    expect(() => G.global_setFilingAs('')).toThrow();
    expect(() => G.global_setFilingAs(undefined)).toThrow();
  });
});

describe('untrusted input — coerces, never throws', () => {
  it('falls back when localStorage holds a value an older version wrote', () => {
    store.filingAs = 'Married';
    G.global_getFilingAs();
    expect(G.global_filingAs).toBe('Single');
  });

  it('asFilingStatus passes known values through and floors the rest', () => {
    expect(G.asFilingStatus('MFJ')).toBe('MFJ');
    expect(G.asFilingStatus('Married')).toBe('Single');
    expect(G.asFilingStatus(null)).toBe('Single');
    expect(G.asFilingStatus('MFJ', 'Single')).toBe('MFJ');
  });
});

describe('TaxTable selects by key, not by falling through', () => {
  it('picks the single tables for Single', () => {
    G.global_setFilingAs('Single'); G.global_getFilingAs();
    const t = new TaxTable();
    expect(t.activeIncomeTable.filingType).toBe('single');
    expect(t.activeCapitalGainsTable.filingType).toBe('single');
    expect(t.activeStandardDeduction).toBe(16100);
    expect(t.activeHomeSaleExclusion).toBe(250000);
  });

  it('picks the married tables for MFJ', () => {
    G.global_setFilingAs('MFJ'); G.global_getFilingAs();
    const t = new TaxTable();
    expect(t.activeIncomeTable.filingType).toBe('married');
    expect(t.activeCapitalGainsTable.filingType).toBe('married');
    expect(t.activeStandardDeduction).toBe(32200);
    expect(t.activeHomeSaleExclusion).toBe(500000);
  });

  it('coerces a bad status arriving from a worker snapshot', () => {
    // global_applyWorkerSnapshot assigns the module variable DIRECTLY, so it is
    // the one path that reaches TaxTable without passing the setter. Workers
    // boot on defaults and take this payload; an unvalidated status would throw
    // inside a worker, where the failure is far harder to see.
    G.global_setFilingAs('MFJ'); G.global_getFilingAs();
    const snap = G.global_workerSnapshot();
    G.global_applyWorkerSnapshot({ ...snap, filingAs: 'Married' });
    expect(G.global_filingAs).toBe('Single');
    expect(() => new TaxTable()).not.toThrow();
  });

  it('still carries a valid status through a worker snapshot', () => {
    G.global_setFilingAs('MFJ'); G.global_getFilingAs();
    G.global_applyWorkerSnapshot(G.global_workerSnapshot());
    expect(G.global_filingAs).toBe('MFJ');
    expect(new TaxTable().activeIncomeTable.filingType).toBe('married');
  });
});
