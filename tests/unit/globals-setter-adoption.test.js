/**
 * globals-setter-adoption.test.js — a setter adopts what it sets.
 *
 * ── The bug this pins ────────────────────────────────────────────────
 *
 * Seven setters in globals.js wrote localStorage and nothing else. The exported
 * binding was updated by the matching `global_getX()` — a "getter" that returns
 * nothing and loads module state — so a caller that set a value without also
 * calling the getter stored the new value and kept running on the old one.
 *
 * Nothing failed when that happened. Storage was correct, the engine was
 * consistent, and every suite passed. It surfaced only as a user-visible
 * divergence: importing a share link built for ages 55/65/85 left localStorage
 * holding 55/65/85, the settings inputs showing the 50/67/87 defaults, and the
 * timeline reading "Sep 2026 · Age 50". `applyImportedPortfolio` was the one
 * call site out of twenty-five that did not pair the getter, and it was the only
 * one broken.
 *
 * ── Why assert it here rather than at the import ─────────────────────
 *
 * The import bug is one symptom. The defect is the convention: a rule that must
 * be remembered at every call site is a defect with a workaround, and the next
 * caller to forget it gets a different symptom somewhere else. So this asserts
 * the property directly, for every setter that has a binding — including the
 * ones that were always correct, so a regression in either half is caught.
 *
 * Each check uses a value that is NOT the default, and asserts against the
 * default first. Setting a binding to the value it already held would pass
 * against the bug.
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

/**
 * name, setter, getter, the binding's live value, a non-default value to set,
 * and what the binding should read afterwards.
 *
 * `read` is a function because an ES module binding cannot be captured by value
 * — reading `G.global_user_startAge` once would freeze it at import time and
 * every check would compare a number against itself.
 */
const SETTERS = [
  { name: 'userStartAge',        set: 'global_setUserStartAge',        get: 'global_getUserStartAge',        read: () => G.global_user_startAge,        value: 55,     expect: 55 },
  { name: 'userRetirementAge',   set: 'global_setUserRetirementAge',   get: 'global_getUserRetirementAge',   read: () => G.global_user_retirementAge,   value: 62,     expect: 62 },
  { name: 'userFinishAge',       set: 'global_setUserFinishAge',       get: 'global_getUserFinishAge',       read: () => G.global_user_finishAge,       value: 85,     expect: 85 },
  { name: 'inflationRate',       set: 'global_setInflationRate',       get: 'global_getInflationRate',       read: () => G.global_inflationRate,        value: 0.042,  expect: 0.042 },
  { name: 'filingAs',            set: 'global_setFilingAs',            get: 'global_getFilingAs',            read: () => G.global_filingAs,             value: 'MFJ',  expect: 'MFJ' },
  { name: 'backtestYear',        set: 'global_setBacktestYear',        get: 'global_getBacktestYear',        read: () => G.global_backtestYear,         value: '1999', expect: '1999' },
  { name: 'simDataMode',         set: 'global_setSimDataMode',         get: 'global_getSimDataMode',         read: () => G.global_simDataMode,          value: 'historical', expect: 'historical' },
  { name: 'guardrailWithdrawal', set: 'global_setGuardrailWithdrawalRate', get: 'global_getGuardrailWithdrawalRate', read: () => G.global_guardrail_withdrawalRate, value: 3.5, expect: 3.5 },
];

describe('a setter adopts what it sets', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    G.global_reset();
  });

  for (const s of SETTERS) {
    it(`${s.name}: the binding moves without a getter call`, () => {
      expect(s.read()).not.toBe(s.expect);   // the test is looking at something

      G[s.set](s.value);

      expect(s.read()).toBe(s.expect);
    });

    it(`${s.name}: storage and memory agree`, () => {
      G[s.set](s.value);
      const afterSet = s.read();

      // The getter re-loads from storage. If the setter assigned something the
      // getter would not read back — a different rounding, an unparsed string —
      // these disagree, and the two halves of the app drift apart in a way no
      // balance check would see.
      G[s.get]();
      expect(s.read()).toBe(afterSet);
    });
  }

  it('global_reset restores every default', () => {
    for (const s of SETTERS) G[s.set](s.value);
    G.global_reset();
    // reset does not cover backtestYear/simDataMode/guardrails; assert the ones
    // it claims, rather than asserting a sweep it never promised.
    expect(G.global_user_startAge).toBe(G.global_default_user_startAge);
    expect(G.global_user_retirementAge).toBe(G.global_default_user_retirementAge);
    expect(G.global_user_finishAge).toBe(G.global_default_user_finishAge);
    expect(G.global_inflationRate).toBe(G.global_default_inflationRate);
    expect(G.global_filingAs).toBe(G.global_default_filingAs);
  });

  it('an invalid filing status still throws rather than being adopted', () => {
    expect(() => G.global_setFilingAs('Married')).toThrow();
    expect(G.global_filingAs).toBe(G.global_default_filingAs);
  });
});
