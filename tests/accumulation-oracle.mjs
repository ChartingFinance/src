/**
 * accumulation-oracle.mjs
 *
 * External-validity check for the ACCUMULATION half of the engine, using the
 * Early Career quick-start profile (age 35 -> 67 -> 90). Companion to
 * decumulation-oracle.mjs, which does the same job for a retiree drawdown.
 *
 * Early Career is the profile that historically breaks first: it is the one
 * that drove its Brokerage to -$13.4M before the overdraft fix, and the only
 * one of the four whose transfer conservation still fails (158 months).
 * It had no oracle. It does now.
 *
 * ── Scope, stated honestly ───────────────────────────────────────────
 *
 * The decumulation oracle models federal tax law in full, because that
 * dataset's whole risk was tax collection. Accumulation's risks are different:
 * amortization, compounding, contribution caps, routing, and whether the books
 * balance while money is flowing IN. So this oracle models the DETERMINISTIC
 * subsystems independently and bands them tightly, rather than reimplementing
 * the tax engine and banding everything loosely:
 *
 *   Layer A — clean-room law, tight bands. Mortgage amortization, home
 *             compounding, property-tax accrual, Social Security COLA,
 *             expense/rent inflation, and the contribution routing laws.
 *             Every one is computable from the profile config alone.
 *   Layer B — frozen engine values. Balances are tax-coupled, so they are
 *             pinned for stability rather than derived. Any formula change
 *             moves them BY DESIGN; regenerate with --print-actual and review.
 *   Layer C — CONSERVATION. The reason this file exists now.
 *
 * ── Layer C: the three-term conservation law ─────────────────────────
 *
 * A two-sided transfer's two legs can legitimately differ, and the difference
 * is always accounted for by exactly two things:
 *
 *     TRANSFER + SPILLOVER + UNFUNDED === 0
 *
 * When an account cannot supply what a transfer asked for it clamps at $0, and
 * the shortfall either re-sources from another account (SPILLOVER) or cannot be
 * sourced at all (UNFUNDED). Verified 2026-07-29 to hold to the cent on all
 * four quick-start profiles.
 *
 * This matters because `monthlySanityCheck` currently asserts only that
 * TRANSFER nets to zero, which fails 158 months on Early Career and 2 on
 * Retired. Those failures are REAL but they are not money going missing — the
 * check is missing two terms. This file asserts the true law (which passes) and
 * separately freezes the count of months the narrower check trips, so that when
 * the engine adopts the three-term law the improvement is visible rather than
 * asserted into existence.
 *
 * THE CLOCK IS PINNED to 2026-07-15: quick-start dates derive from `new Date()`
 * via dateAnchors(), so without pinning every value here would rot monthly.
 *
 * Usage:  node src/tests/accumulation-oracle.mjs                (assert)
 *         node src/tests/accumulation-oracle.mjs --print-actual (regen B)
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

// ── Pin the clock ─────────────────────────────────────────────────────
const RealDate = Date;
const PINNED = new RealDate(2026, 6, 15);
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(PINNED.getTime());
    else super(...args);
  }
  static now() { return PINNED.getTime(); }
};

const PRINT_MODE = process.argv.includes('--print-actual');

import { Portfolio, EVENT_RECONCILIATION } from '../js/portfolio.js';
import { chronometer_run } from '../js/chronometer.js';
import { TaxTable } from '../js/taxes.js';
import { quickStartProfiles, buildQuickStart } from '../js/quick-start.js';
import { EventType } from '../js/sim-event.js';
import {
  setActiveTaxTable,
  global_default_inflationRate,
  global_setInflationRate, global_getInflationRate,
  global_setFilingAs, global_getFilingAs,
  global_setUserStartAge, global_getUserStartAge,
  global_setUserRetirementAge, global_getUserRetirementAge,
  global_setUserFinishAge, global_getUserFinishAge,
} from '../js/globals.js';

// ── Profile, and a guard on its shape ─────────────────────────────────
const profile = quickStartProfiles.find(p => p.key === 'earlyCareer');
assert.ok(profile, 'earlyCareer profile is gone — this oracle models it specifically');

const INFL = global_default_inflationRate;

// The oracle hardwires this profile's ROUTING. Amounts and rates are read from
// the config so tweaks flow through, but if the topology changes, fail loudly
// rather than silently model a different plan.
function requireShape() {
  const qs = buildQuickStart(profile);
  const names = qs.assets.map(a => a.displayName).sort().join(',');
  assert.equal(names, '401K,Brokerage,Home,Living Expenses,Mortgage,Rent,Roth IRA,Salary,Social Security',
    'earlyCareer asset set changed — update this oracle');
  assert.deepEqual(
    { s: profile.startAge, r: profile.retirementAge, f: profile.finishAge },
    { s: 35, r: 67, f: 90 },
    'earlyCareer ages changed — update this oracle');
  const acc = qs.lifeEvents[0].phaseTransfers;
  assert.deepEqual(acc['Salary'].map(x => [x.toDisplayName, x.monthlyMoveValue]),
    [['401K', 8], ['Roth IRA', 4], ['Brokerage', 88]],
    'accumulate-phase salary routing changed — update this oracle');
  const ret = qs.lifeEvents[1].phaseTransfers;
  assert.deepEqual(ret['Living Expenses'].map(x => [x.toDisplayName, x.monthlyMoveValue]),
    [['Brokerage', 60], ['401K', 40]],
    'retire-phase expense routing changed — update this oracle');
  return qs;
}
const qsShape = requireShape();
const cfg = (n) => profile.assets(anchors()).find(a => a.displayName === n);

function anchors() {
  // Mirrors quick-start.js dateAnchors() under the pinned clock.
  const y = 2026, m = 7;
  const birthYear = y - profile.startAge;
  return {
    now: { year: y, month: m },
    retire: { year: birthYear + profile.retirementAge, month: 1 },
    finish: { year: birthYear + profile.finishAge, month: 1 },
    plus(n) { return { year: y + n, month: m }; },
  };
}
const A = anchors();
const rateOf = (a) => a.annualReturnRate?.rate ?? 0;

// ── Layer A: clean-room law model ─────────────────────────────────────
// Independent of every simulator module. Conventions matched to the engine's
// documented ones: monthly rate is annual/12 (see the compounding-convention
// note in memory — the engine's ARR.asMonthly() is rate/12, not the true
// twelfth root, and this oracle deliberately mirrors that so a band failure
// means a real divergence rather than a known convention gap).
function runOracle() {
  const first = A.now;                       // 2026-07
  const finishYear = A.finish.year;          // 2081
  const MONTHS = (finishYear - first.year) * 12 + (12 - first.month) + 1;

  // Mortgage: pure amortization, no interaction with anything else.
  const mCfg = cfg('Mortgage');
  const P0 = Math.abs(mCfg.startCurrency.amount);
  const mR = rateOf(mCfg) / 12;
  const mN = mCfg.monthsRemaining;
  const mPay = P0 * mR * Math.pow(1 + mR, mN) / (Math.pow(1 + mR, mN) - 1);
  let mortgage = P0;
  let mortInterest = 0;
  for (let i = 0; i < mN && mortgage > 0.005; i++) {
    const interest = mortgage * mR;
    let principal = mPay - interest;
    if (principal > mortgage) principal = mortgage;
    mortgage -= principal;
    mortInterest += interest;
  }

  // Home: compounds monthly, and accrues property tax on the post-growth
  // value. Sold at plus(25), so the oracle reports the value AT SALE.
  const hCfg = cfg('Home');
  const hG = rateOf(hCfg) / 12;
  const hTax = (hCfg.annualTaxRate?.rate ?? 0) / 12;
  const monthsHeld = (A.plus(25).year - first.year) * 12 + (A.plus(25).month - first.month);
  let home = hCfg.startCurrency.amount;
  let propTax = 0;
  for (let i = 0; i < monthsHeld; i++) {
    home *= (1 + hG);
    propTax += home * hTax;
  }

  // Social Security: starts at retirement, COLA each January thereafter.
  const ssCfg = cfg('Social Security');
  const ssCola = rateOf(ssCfg);
  const colas = finishYear - A.retire.year;      // Januaries after the start year
  const ssMonthly = ssCfg.startCurrency.amount * Math.pow(1 + ssCola, colas);

  // Expenses inflate monthly from their own start date to the plan's end.
  const inflateFrom = (start, amount) => {
    const months = (finishYear - start.year) * 12 + (12 - start.month);
    return amount * Math.pow(1 + INFL / 12, months);
  };
  const livingMonthly = inflateFrom(first, Math.abs(cfg('Living Expenses').startCurrency.amount));
  const rentMonthly = inflateFrom(A.plus(25), Math.abs(cfg('Rent').startCurrency.amount));

  // Salary: 3% raise each January, paid until the month before retirement.
  const sCfg = cfg('Salary');
  const sG = rateOf(sCfg);
  let salary = sCfg.startCurrency.amount;
  let employedIncome = 0;
  for (let i = 0; i < MONTHS; i++) {
    const y = first.year + Math.floor((first.month - 1 + i) / 12);
    const m = ((first.month - 1 + i) % 12) + 1;
    if (m === 1 && i > 0) salary *= (1 + sG);
    if (y > A.retire.year || (y === A.retire.year && m >= A.retire.month)) break;
    employedIncome += salary;
  }

  return { MONTHS, mortgage, mortInterest, mPay, home, propTax, ssMonthly,
           livingMonthly, rentMonthly, employedIncome };
}

// ── Run the engine ────────────────────────────────────────────────────
global_setInflationRate(INFL); global_getInflationRate();
global_setFilingAs('Single'); global_getFilingAs();
const qs = buildQuickStart(profile);
global_setUserStartAge(qs.ages.startAge); global_getUserStartAge();
global_setUserRetirementAge(qs.ages.retirementAge); global_getUserRetirementAge();
global_setUserFinishAge(qs.ages.finishAge); global_getUserFinishAge();
setActiveTaxTable(new TaxTable());

// Layer C instrumentation: capture conservation per month while the run
// happens, since monthlySanityCheck reports into a dead logger.
const conservation = { pairedOnlyFails: 0, threeTermFails: 0, worstPairedOnly: 0, worstThreeTerm: 0, months: 0 };
const origCheck = Portfolio.prototype.monthlySanityCheck;
Portfolio.prototype.monthlySanityCheck = function (currentDateInt) {
  let paired = 0, spillover = 0, unfunded = 0;
  for (const a of this.modelAssets) {
    const start = a.eventsCheckedIndex || 0;
    for (let i = start; i < a.events.length; i++) {
      const ev = a.events[i];
      if (ev.type === EventType.UNFUNDED) { unfunded += ev.amount.amount; continue; }
      if (ev.kind === 'info') continue;
      if (EVENT_RECONCILIATION[ev.type] === 'paired') paired += ev.amount.amount;
      if (ev.type === EventType.SPILLOVER) spillover += ev.amount.amount;
    }
    a.eventsCheckedIndex = a.events.length;
  }
  conservation.months++;
  if (Math.abs(paired) > 0.01) {
    conservation.pairedOnlyFails++;
    conservation.worstPairedOnly = Math.max(conservation.worstPairedOnly, Math.abs(paired));
  }
  const threeTerm = paired + spillover + unfunded;
  if (Math.abs(threeTerm) > 0.01) {
    conservation.threeTermFails++;
    conservation.worstThreeTerm = Math.max(conservation.worstThreeTerm, Math.abs(threeTerm));
  }
};

const portfolio = new Portfolio(qs.assets, false);
portfolio.lifeEvents = qs.lifeEvents.map(e => e.copy());
await chronometer_run(portfolio);
Portfolio.prototype.monthlySanityCheck = origCheck;

const asset = (n) => portfolio.modelAssets.find(a => a.displayName === n);
const engine = {
  'Social Security': asset('Social Security').finishCurrency.amount,
  '401K': asset('401K').finishCurrency.amount,
  'Roth IRA': asset('Roth IRA').finishCurrency.amount,
  'Brokerage': asset('Brokerage').finishCurrency.amount,
  'Home': asset('Home').finishCurrency.amount,
  'Mortgage': asset('Mortgage').finishCurrency.amount,
  'Living Expenses': asset('Living Expenses').finishCurrency.amount,
  'Rent': asset('Rent').finishCurrency.amount,
  portfolioTotal: portfolio.finishValue().amount,
  employedIncome: portfolio.total.employedIncome.amount,
  socialSecurityIncome: portfolio.total.socialSecurityIncome.amount,
  four01KContribution: portfolio.total.four01KContribution.amount,
  four01KDistribution: portfolio.total.four01KDistribution.amount,
  longTermCapitalGains: portfolio.total.longTermCapitalGains.amount,
  mortgageInterest: portfolio.total.mortgageInterest.amount,
  propertyTaxes: portfolio.total.propertyTaxes.amount,
  incomeTax: portfolio.total.incomeTax.amount,
};

// ── Layer B literal ───────────────────────────────────────────────────
// Generated with --print-actual under the pinned 2026-07-15 clock.
// Established 2026-07-29 as the baseline BEFORE the transfer-conservation
// terms are adopted by the engine, so that change shows as a reviewable diff.
const EXPECTED_ENGINE = {
  "Social Security": 3882.14,
  "401K": 4876213.41,
  "Roth IRA": 4990880.32,
  "Brokerage": 8212308.30,
  "Home": 0.00,
  "Mortgage": 0.00,
  "Living Expenses": -13937.35,
  "Rent": -6427.41,
  "portfolioTotal": 18079402.02,
  "employedIncome": 3432182.06,
  "socialSecurityIncome": 854014.60,
  "four01KContribution": 274574.57,
  "four01KDistribution": 4185149.97,
  "longTermCapitalGains": 1826635.54,
  "mortgageInterest": -287174.02,
  "propertyTaxes": -157235.10,
  "incomeTax": -681290.82,
};

const CONSERVATION_BASELINE = {
  pairedOnlyFails: 158,
  threeTermFails: 0,
};

if (PRINT_MODE) {
  console.log('\n// ── Paste over the EXPECTED_ENGINE literal ──');
  console.log('const EXPECTED_ENGINE = {');
  for (const [k, v] of Object.entries(engine)) console.log(`  ${JSON.stringify(k)}: ${v.toFixed(2)},`);
  console.log('};');
  console.log('\nconst CONSERVATION_BASELINE = {');
  console.log(`  pairedOnlyFails: ${conservation.pairedOnlyFails},`);
  console.log(`  threeTermFails: ${conservation.threeTermFails},`);
  console.log('};');
  process.exit(0);
}

// ── Harness ───────────────────────────────────────────────────────────
const fmt = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}
const oracle = runOracle();
const band = (label, engineVal, oracleVal, tolAbs, tolPct) => {
  check(label, () => {
    const diff = Math.abs(engineVal - oracleVal);
    const limit = Math.max(tolAbs, Math.abs(oracleVal) * (tolPct ?? 0));
    assert.ok(diff <= limit,
      `engine ${fmt(engineVal)} vs oracle ${fmt(oracleVal)} — off by ${fmt(diff)}, allowed ${fmt(limit)}`);
  });
};

// ══ Layer A ══════════════════════════════════════════════════════════
console.log('\n── Layer A: clean-room law vs engine ────────────────────\n');

// Pure amortization: no interaction with any other asset, so a mismatch here
// is an amortization bug and nothing else.
band('Mortgage pays off exactly at term', engine['Mortgage'], 0, 0.01);
band('Lifetime mortgage interest', Math.abs(engine.mortgageInterest), oracle.mortInterest, 50);

// Pure compounding + accrual on the post-growth value.
band('Lifetime property tax', Math.abs(engine.propertyTaxes), oracle.propTax, 0, 0.01);

// Pure COLA from a fixed start — the tightest band in the file.
band('Social Security benefit at plan end', engine['Social Security'], oracle.ssMonthly, 1);

// Pure inflation from each expense's own start date.
band('Living Expenses monthly at plan end', Math.abs(engine['Living Expenses']), oracle.livingMonthly, 0, 0.01);
band('Rent monthly at plan end', Math.abs(engine['Rent']), oracle.rentMonthly, 0, 0.01);

// Salary growth schedule.
band('Lifetime employed income', engine.employedIncome, oracle.employedIncome, 0, 0.01);

// ROUTING LAW: the accumulate phase sends 8% of gross salary to the 401K, and
// the annual limit never binds at these income levels — so the lifetime
// contribution must be exactly 8% of lifetime wages. This catches a routing or
// clamp regression without needing the tax model.
check('401K contributions are exactly 8% of lifetime wages', () => {
  const expected = engine.employedIncome * 0.08;
  assert.ok(Math.abs(engine.four01KContribution - expected) <= 1,
    `engine ${fmt(engine.four01KContribution)} vs 8% of wages ${fmt(expected)}`);
});

check('Salary and Home both closed at their finish dates', () => {
  assert.equal(asset('Salary').isClosed, true, 'Salary should close at retirement');
  assert.equal(asset('Home').isClosed, true, 'Home should close at plus(25)');
  assert.ok(Math.abs(engine['Home']) <= 0.005, `Home ended at ${fmt(engine['Home'])}`);
});

// ══ Layer C ══════════════════════════════════════════════════════════
console.log('\n── Layer C: conservation ────────────────────────────────\n');

check('THE LAW: transfer + spillover + unfunded === 0, every month', () => {
  assert.equal(conservation.threeTermFails, 0,
    `${conservation.threeTermFails} of ${conservation.months} months break conservation ` +
    `(worst ${fmt(conservation.worstThreeTerm)}). Money is appearing or vanishing — this is ` +
    `not a check artifact, it is a leak.`);
});

check('the run actually exercised conservation', () => {
  assert.ok(conservation.months > 600, `only ${conservation.months} months checked`);
});

// The narrower check the ENGINE currently applies. Early Career trips it
// because its Brokerage is the only funding-backstop account in the plan, so
// when it empties there is nothing to spill to and the shortfall is UNFUNDED —
// a term monthlySanityCheck does not yet include. Frozen, not asserted to be
// zero: when the engine adopts the three-term law this should drop to 0 and
// this baseline must be updated deliberately.
check('engine-side paired-only failures match the recorded baseline', () => {
  assert.equal(conservation.pairedOnlyFails, CONSERVATION_BASELINE.pairedOnlyFails,
    `paired-only failures moved from ${CONSERVATION_BASELINE.pairedOnlyFails} to ` +
    `${conservation.pairedOnlyFails}. If you fixed monthlySanityCheck to use the ` +
    `three-term law this is the expected improvement — update the baseline. If you ` +
    `did not, something changed the funding path.`);
});

// ══ Layer B ══════════════════════════════════════════════════════════
console.log('\n── Layer B: frozen engine values ────────────────────────\n');
const divergences = [];
for (const [k, v] of Object.entries(EXPECTED_ENGINE)) {
  if (Math.abs(engine[k] - v) > 0.02) divergences.push(`${k}: expected ${fmt(v)}, got ${fmt(engine[k])}`);
}
check('all frozen values match (regen with --print-actual after intentional changes)', () => {
  assert.ok(divergences.length === 0, `${divergences.length} divergence(s):\n      ` + divergences.join('\n      '));
});

console.log(`\n  (info) Brokerage depleted at least once: ${!!asset('Brokerage').isDepleted}` +
            ` — Early Career's only funding-backstop account, which is why unfunded obligations arise`);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
