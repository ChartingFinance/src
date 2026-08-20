/**
 * render-note.test.js — every EventType must render.
 *
 * `renderNote` is a switch over EventType, and it is only ever exercised for
 * types that a fixture actually emits. So a new case can carry a plain
 * ReferenceError and stay invisible: the suite is green because nothing in it
 * produces that event yet, and the failure waits for the first real plan that
 * does.
 *
 * That is not hypothetical. Added 2026-08-18 after the NIIT_ASSESSED case was
 * written with `formatCurrency(...)` in its template — a helper this module does
 * not import, because sim-event.js imports NOTHING at all. 280 tests passed
 * over it.
 *
 * `renderNote(event)` reads `event.data`, so every type is rendered twice: once
 * with the data it expects, and once with NOTHING, since an event may be built
 * without a payload and a note that throws takes the asset modal down with it.
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

const { EventType, renderNote } = await import('../../js/sim-event.js');

/**
 * A representative payload per type. Only types whose note branches on data
 * need an entry; the rest render from the type alone.
 */
const DATA = {
  [EventType.DIVIDEND]:                { qualified: true },
  [EventType.TAX_TRUE_UP]:             { direction: 'underpayment' },
  [EventType.NIIT_ASSESSED]:           { bound: 'nii', taxedBase: 30000 },
  [EventType.CAPITAL_GAIN_RECOGNIZED]: { spillover: false },
  [EventType.TRANSFER]:                { from: 'Brokerage', to: 'Checking', cadence: 'monthly' },
  [EventType.SETTLEMENT]:              { from: 'Checking', to: 'Living', label: 'Living' },
  [EventType.SPILLOVER]:               { depleted: 'Checking' },
  [EventType.GROSS_UP]:                { forAsset: 'IRA', overflow: false },
  [EventType.ONE_TIME]:                { note: 'Windfall' },
  [EventType.UNFUNDED]:                { cause: 'Living', origin: 'oneSided' },
  [EventType.CONTRIBUTION_CAPPED]:     { limitName: '401(k)' },
};

const ALL_TYPES = Object.values(EventType);

describe('renderNote covers every EventType', () => {
  it('has at least one type to check', () => {
    expect(ALL_TYPES.length).toBeGreaterThan(0);
  });

  it.each(ALL_TYPES)('renders %s with its expected payload', (type) => {
    const note = renderNote({ type, data: DATA[type] ?? {} });
    expect(typeof note).toBe('string');
    expect(note.length).toBeGreaterThan(0);
    // A template that interpolated an undefined helper or field would land here.
    expect(note).not.toMatch(/undefined|NaN|\[object/);
  });

  it.each(ALL_TYPES)('renders %s with no data at all', (type) => {
    // Must not throw. Missing fields may read as empty, but a note that throws
    // takes the asset View modal down with it.
    const note = renderNote({ type });
    expect(typeof note).toBe('string');
    expect(note.length).toBeGreaterThan(0);
  });
});
