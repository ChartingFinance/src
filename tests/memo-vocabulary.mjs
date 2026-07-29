/**
 * memo-vocabulary.mjs
 *
 * An inventory lock on every credit-memo note the engine can write.
 *
 * WHY THIS EXISTS
 *
 * Credit-memo notes are prose, and three different systems read that prose:
 *
 *   1. `Portfolio.monthlySanityCheck` classifies memos via MEMO_RECONCILIATION
 *      to decide whether the engine's own books balance.
 *   2. `portfolio-issues.js` recovers user-facing alerts — including "your plan
 *      runs out of money in October 2029" — by regex over note text.
 *   3. `rule-notes.js` does the same for the asset View modal.
 *
 * None of that coupling is visible from a memo's write site. Verified
 * 2026-07-29: renaming 'Asset growth' to 'Asset Growth' — one capital letter,
 * two call sites — passed all 11 node suites and 162 assertions, including the
 * golden master, while silently emptying the growth bucket and corrupting the
 * transfer-conservation total. The classifier does not throw on an unknown
 * note; it quietly files it under "transfer".
 *
 * The other suites are coupled to prose too, but they use memo sums as terms in
 * an equation, so a rename makes them fail loudly. That protection is real but
 * it is per-string and accidental — it covers whichever literals a test happens
 * to name. This file makes it systematic: it asserts that EVERY note the engine
 * emits is one some consumer knows about.
 *
 * This is a guard, not a fix. The fix is a typed event stream where notes are
 * generated for display and never parsed back; see the CreditMemo → SimEvent
 * study. Until then, this fails loudly the moment the vocabulary drifts.
 *
 * WHEN THIS FAILS
 *
 * You renamed a memo, or added one. Do not just add the string here — check
 * whether monthlySanityCheck, portfolio-issues.js or rule-notes.js needed to
 * know about it, fix those, then record it below.
 *
 * Usage:  node src/tests/memo-vocabulary.mjs   (from repo root)
 */

import assert from 'node:assert/strict';

// ── Mock browser globals ──────────────────────────────────────────────
const store = {};
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

import { ModelAsset } from '../js/model-asset.js';
import { Portfolio, MEMO_RECONCILIATION } from '../js/portfolio.js';
import { chronometer_run } from '../js/chronometer.js';
import { TaxTable } from '../js/taxes.js';
import {
  setActiveTaxTable,
  global_setUserStartAge, global_getUserStartAge,
  global_setUserRetirementAge, global_getUserRetirementAge,
} from '../js/globals.js';
import { MEMO_PATTERNS } from '../js/portfolio-issues.js';

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${label}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}

/**
 * Notes that legitimately fall past MEMO_RECONCILIATION into the transfer /
 * engine-report bucket. Each entry names WHO depends on the wording, so a
 * rename lands in front of the consumer it would break.
 */
const PASS_THROUGH = [
  { id: 'transfer',            owner: 'monthlySanityCheck (transferNet)',  re: /^.+ → .+ \((monthly|on close|funding|maintenance|insurance)\)$/ },
  // Property tax settles through the same one-sided path as maintenance and
  // insurance but does NOT use the arrow format — tax-engine.js writes
  // `${home} property tax`. Same operation, different wording; worth
  // unifying when the event stream lands.
  { id: 'property-tax-settle', owner: 'monthlySanityCheck (transferNet)',  re: /^.+ property tax$/ },
  { id: 'grossed-up-debit',    owner: 'monthlySanityCheck (transferNet)',  re: /^Grossed-up expense (debit|overflow) for .+$/ },
  { id: 'spillover',           owner: 'portfolio-issues funding-ran-dry',  re: MEMO_PATTERNS.ranDry },
  // Covers the suffixed `… (account depleted, no backstop)` variant too:
  // reportUnfunded always prefixes, so that note is stored as
  // "Unfunded — X → Y (monthly) (account depleted, no backstop)".
  { id: 'unfunded',            owner: 'portfolio-issues + rule-notes',     re: MEMO_PATTERNS.unfunded },
  { id: 'contribution-capped', owner: 'portfolio-issues + rule-notes',     re: MEMO_PATTERNS.contributionCapped },
  { id: 'tax-true-up',         owner: 'payroll/transfer-tax-conservation', re: /^Annual tax true-up \((underpayment|refund)\)$/ },
  { id: 'escrow',              owner: 'info-only, no consumer',            re: /^Property tax escrow$/ },
  { id: 'maintenance',         owner: 'info-only, no consumer',            re: /^Maintenance$/ },
  { id: 'insurance',           owner: 'info-only, no consumer',            re: /^Insurance$/ },
  { id: 'one-time',            owner: 'monthlySanityCheck (transferNet)',  re: /^One-Time: .*$/ },
];

// NOT listed, deliberately: 'Estimated tax'. Its only write site
// (expense-engine.js, `addCreditMemo(tax, 'Estimated tax')`) sits inside a
// commented-out block behind a TODO, so the engine cannot emit it. A grep for
// call sites counts it; this test proved it dead.

// ── Scenarios: chosen to exercise as many memo sites as possible ──────

const S = { year: 2026, month: 1 };
const F = { year: 2031, month: 12 };
const base = (extra) => ({
  startDateInt: S, finishDateInt: F, annualReturnRate: { rate: 0 }, ...extra,
});

const SCENARIOS = {
  // Payroll: FICA, income tax withholding, contribution caps, true-ups.
  payroll: {
    ages: { start: 45, retire: 65 },
    assets: [
      base({ instrument: 'workingIncome', displayName: 'Salary',
             startCurrency: { amount: 20000 }, startBasisCurrency: { amount: 0 },
             fundTransfers: [{ toDisplayName: '401K', monthlyMoveValue: 60, closeMoveValue: 0 }] }),
      base({ instrument: '401K', displayName: '401K',
             startCurrency: { amount: 10000 }, startBasisCurrency: { amount: 0 } }),
      base({ instrument: 'bank', displayName: 'Savings',
             startCurrency: { amount: 90000 }, startBasisCurrency: { amount: 90000 } }),
    ],
  },

  // Housing: mortgage principal/interest, property tax + escrow, maintenance,
  // insurance, and a funding account that runs dry into a spillover.
  housing: {
    ages: { start: 50, retire: 65 },
    assets: [
      base({ instrument: 'realEstate', displayName: 'Home', isPrimaryHome: true,
             startCurrency: { amount: 500000 }, startBasisCurrency: { amount: 500000 },
             annualReturnRate: { rate: 0.03 },
             annualTaxRate: { rate: 0.012 },
             annualMaintenanceRate: { rate: 0.01 },
             annualInsuranceCost: { amount: 2400 } }),
      base({ instrument: 'mortgage', displayName: 'Mortgage',
             startCurrency: { amount: -300000 }, startBasisCurrency: { amount: 0 },
             annualReturnRate: { rate: 0.065 }, monthsRemaining: 360 }),
      base({ instrument: 'bank', displayName: 'Checking',
             startCurrency: { amount: 4000 }, startBasisCurrency: { amount: 4000 } }),
      base({ instrument: 'taxableEquity', displayName: 'Brokerage',
             startCurrency: { amount: 400000 }, startBasisCurrency: { amount: 200000 },
             annualReturnRate: { rate: 0.07 } }),
    ],
  },

  // Yield: qualified + non-qualified dividends, interest income, asset growth,
  // and a one-time event.
  yielding: {
    ages: { start: 50, retire: 65 },
    assets: [
      base({ instrument: 'taxableEquity', displayName: 'Equity',
             startCurrency: { amount: 300000 }, startBasisCurrency: { amount: 150000 },
             annualReturnRate: { rate: 0.06 },
             annualDividendRate: { rate: 0.02 }, dividendQualifiedRatio: 0.6,
             oneTimeEvents: [{ dateInt: { year: 2027, month: 4 }, amount: { amount: 25000 }, note: 'inheritance' }] }),
      base({ instrument: 'usBond', displayName: 'Bonds',
             startCurrency: { amount: 100000 }, startBasisCurrency: { amount: 100000 },
             annualReturnRate: { rate: 0.04 } }),
      base({ instrument: 'cash', displayName: 'Cash',
             startCurrency: { amount: 50000 }, startBasisCurrency: { amount: 50000 },
             annualReturnRate: { rate: 0.02 } }),
      base({ instrument: 'monthlyExpense', displayName: 'Living',
             startCurrency: { amount: -3000 }, startBasisCurrency: { amount: 0 } }),
    ],
  },

  // Nothing to pay with: the unfunded path.
  broke: {
    ages: { start: 50, retire: 65 },
    assets: [
      base({ instrument: 'monthlyExpense', displayName: 'Rent',
             startCurrency: { amount: -2500 }, startBasisCurrency: { amount: 0 } }),
    ],
  },

  // Retired: estimated tax on untaxed benefit income, RMDs, expense inflation.
  retired: {
    ages: { start: 75, retire: 65 },
    assets: [
      base({ instrument: 'retirementIncome', displayName: 'Social Security',
             startCurrency: { amount: 3000 }, startBasisCurrency: { amount: 0 },
             fundTransfers: [{ toDisplayName: 'Savings', monthlyMoveValue: 100, closeMoveValue: 0 }] }),
      base({ instrument: 'pension', displayName: 'Pension',
             startCurrency: { amount: 2500 }, startBasisCurrency: { amount: 0 },
             fundTransfers: [{ toDisplayName: 'Savings', monthlyMoveValue: 100, closeMoveValue: 0 }] }),
      base({ instrument: 'ira', displayName: 'IRA',
             startCurrency: { amount: 800000 }, startBasisCurrency: { amount: 0 } }),
      base({ instrument: 'bank', displayName: 'Savings',
             startCurrency: { amount: 200000 }, startBasisCurrency: { amount: 200000 } }),
      base({ instrument: 'monthlyExpense', displayName: 'Living',
             startCurrency: { amount: -5000 }, startBasisCurrency: { amount: 0 } }),
    ],
  },

  // An asset that closes mid-plan: capital gains recognition + close transfer.
  closing: {
    ages: { start: 50, retire: 65 },
    assets: [
      base({ instrument: 'taxableEquity', displayName: 'Sold Equity',
             finishDateInt: { year: 2027, month: 6 },
             startCurrency: { amount: 200000 }, startBasisCurrency: { amount: 100000 },
             annualReturnRate: { rate: 0.06 },
             fundTransfers: [{ toDisplayName: 'Savings', monthlyMoveValue: 0, closeMoveValue: 100 }] }),
      base({ instrument: 'bank', displayName: 'Savings',
             startCurrency: { amount: 50000 }, startBasisCurrency: { amount: 50000 } }),
    ],
  },
};

async function run(assets, ages) {
  setActiveTaxTable(new TaxTable());
  global_setUserStartAge(ages.start);
  global_getUserStartAge();
  global_setUserRetirementAge(ages.retire);
  global_getUserRetirementAge();
  const p = new Portfolio(assets.map(o => ModelAsset.fromJSON(o)), true);
  await chronometer_run(p);
  return p;
}

// ── Collect the emitted vocabulary ────────────────────────────────────

/** note -> { kinds:Set, scenarios:Set } */
const emitted = new Map();

for (const [name, { assets, ages }] of Object.entries(SCENARIOS)) {
  const portfolio = await run(assets, ages);
  for (const asset of portfolio.modelAssets) {
    for (const memo of (asset.creditMemos ?? [])) {
      const note = memo.note ?? '';
      if (!emitted.has(note)) emitted.set(note, { kinds: new Set(), scenarios: new Set() });
      emitted.get(note).kinds.add(memo.kind);
      emitted.get(note).scenarios.add(name);
    }
  }
}

const classify = (note) => {
  if (MEMO_RECONCILIATION[note]) return { how: 'reconciled', as: MEMO_RECONCILIATION[note] };
  const hit = PASS_THROUGH.find(p => p.re.test(note));
  return hit ? { how: 'pass-through', as: hit.id } : null;
};

// ══ The guard ════════════════════════════════════════════════════════
console.log('\n── Memo vocabulary ──\n');

check('the scenarios actually exercise the engine', () => {
  assert.ok(emitted.size >= 20,
    `only ${emitted.size} distinct notes emitted — scenarios have stopped covering the engine`);
});

check('EVERY note the engine writes is known to some consumer', () => {
  const orphans = [...emitted.entries()]
    .filter(([note]) => classify(note) === null)
    .map(([note, i]) => `  "${note}"  (kind=${[...i.kinds]}, from ${[...i.scenarios]})`);

  assert.equal(orphans.length, 0,
    `${orphans.length} memo note(s) match nothing in MEMO_RECONCILIATION or PASS_THROUGH.\n` +
    `A renamed or new memo silently falls into the transfer-conservation bucket,\n` +
    `and any alert keyed on the old wording goes quiet.\n\n${orphans.join('\n')}\n\n` +
    `Fix the consumer that needed to know, THEN record the note in this file.`);
});

check('no empty memo notes', () => {
  assert.ok(!emitted.has(''), 'a memo was written with no note at all');
});

check('every MEMO_RECONCILIATION key is still emitted by the engine', () => {
  // A key nobody writes any more is a rename that got half-applied: the
  // classifier keeps a bucket for prose the engine stopped producing.
  const stale = Object.keys(MEMO_RECONCILIATION).filter(k => !emitted.has(k));
  assert.deepEqual(stale, [],
    `MEMO_RECONCILIATION classifies notes the engine never writes: ${stale.map(s => `"${s}"`).join(', ')}`);
});

check('every PASS_THROUGH pattern still matches something', () => {
  const dead = PASS_THROUGH
    .filter(p => ![...emitted.keys()].some(n => p.re.test(n)))
    .map(p => `${p.id} (${p.owner})`);
  assert.deepEqual(dead, [],
    `PASS_THROUGH patterns match nothing the engine emits — stale or the scenario stopped covering them: ${dead.join(', ')}`);
});

check('the reconciled buckets are the ones monthlySanityCheck reads', () => {
  // Guards the map against a bucket name typo, which would leave a check
  // silently summing zero.
  const expected = new Set([
    'fica', 'incomeTax', 'capitalGains', 'capitalGainsTax',
    'mortgageInterest', 'mortgagePrincipal', 'propertyTax', 'excluded',
  ]);
  for (const bucket of Object.values(MEMO_RECONCILIATION)) {
    assert.ok(expected.has(bucket), `unknown reconciliation bucket "${bucket}"`);
  }
});

check('the issues surface patterns match live engine output', () => {
  const notes = [...emitted.keys()];
  for (const [id, re] of Object.entries(MEMO_PATTERNS)) {
    assert.ok(notes.some(n => re.test(n)),
      `MEMO_PATTERNS.${id} matches nothing the engine writes — the alert it powers is dead`);
  }
});

// ── Inventory ────────────────────────────────────────────────────────
console.log('\n── Inventory ──\n');
for (const [note, info] of [...emitted].sort((a, b) => a[0].localeCompare(b[0]))) {
  const c = classify(note);
  const tag = c ? `${c.how}:${c.as}` : 'ORPHAN';
  console.log(`  ${tag.padEnd(28)} ${[...info.kinds].join('/').padEnd(5)} "${note}"`);
}
console.log(`\n  ${emitted.size} distinct notes across ${Object.keys(SCENARIOS).length} scenarios`);

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
