/**
 * decumulation-oracle.mjs
 *
 * External-validity check: runs the "2026-05-mouk0ygz" 30-year decumulation
 * dataset (tests/data/portfolio-2026-05-mouk0ygz.json — decoded from a real
 * Share link) through the chronometer AND through an independent clean-room
 * projection built from the dataset's configuration plus federal tax law,
 * then asserts the two agree within documented tolerance bands.
 *
 * The conservation suites prove the books balance; quickstart-golden proves
 * results are stable. Neither can catch the engine being self-consistent
 * and WRONG — this test exists because two such bugs survived every suite:
 * Social Security taxed at 185% (benefits double-booked as wages) and RMDs
 * forced on top of distributions that already satisfied them. Both were
 * found by exactly this oracle comparison (2026-07-21 audit) and both would
 * trip these bands loudly if reintroduced (+$209k tax / −$1.38M IRA).
 *
 * Two layers:
 *   A. ORACLE BANDS — engine vs clean-room law model. Wide where the two
 *      legitimately differ (tax-collection timing, all-LT gain booking),
 *      tight where they must agree (untouched compounding assets, the
 *      distribution schedule, employedIncome === $0).
 *   B. FROZEN ENGINE VALUES — golden-style stability. Any formula change
 *      moves these by design. After an INTENTIONAL change run
 *          node src/tests/decumulation-oracle.mjs --print-actual
 *      and paste the printed literal, reviewing the diff line by line.
 *
 * THE CLOCK IS PINNED to 2026-07-15: the simulation window is derived from
 * `new Date()` (global_getFinishDateInt), so without pinning these values
 * would rot every January.
 *
 * Known open findings the bands still absorb (tighten when fixed):
 *   - Savings is overdrawn by a tax settlement and stranded (audit F4):
 *     oracle floors the bank at $0, engine ends ≈ −$17.4k.
 *   - longTermCapitalHoldingPercentage is unread (F5): oracle books 80/20
 *     LT/ST per config, engine books all gains long-term.
 *   - NIIT is not modeled (F8): asserted informationally, not banded.
 *
 * Usage:  node src/tests/decumulation-oracle.mjs                (assert)
 *         node src/tests/decumulation-oracle.mjs --print-actual (regen B)
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── Mock browser globals ──────────────────────────────────────────────
const store = {};
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

// ── Pin the clock (window derivation uses `new Date()` at run time) ──
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

// ── Imports ───────────────────────────────────────────────────────────
import { Portfolio } from '../js/portfolio.js';
import { chronometer_run } from '../js/chronometer.js';
import { TaxTable } from '../js/taxes.js';
import { ModelLifeEvent, LifeEvent } from '../js/life-event.js';
import { membrane_rawDataToModelAssets } from '../js/membrane.js';
import {
  setActiveTaxTable,
  global_setInflationRate, global_getInflationRate,
  global_setFilingAs, global_getFilingAs,
  global_setUserStartAge, global_getUserStartAge,
  global_setUserRetirementAge, global_getUserRetirementAge,
  global_setUserFinishAge, global_getUserFinishAge,
  global_setBacktestYear, global_getBacktestYear,
} from '../js/globals.js';

// ── Dataset ───────────────────────────────────────────────────────────
const data = JSON.parse(readFileSync(new URL('./data/portfolio-2026-05-mouk0ygz.json', import.meta.url), 'utf8'));
const S = data.settings;

// The oracle hardwires this dataset's ROUTING (who funds what). Parameters
// (amounts, rates, dates) are read from the JSON so tweaks flow through —
// but if the topology changes, fail loudly rather than model the wrong plan.
function requireRouting() {
  const t = data.lifeEvents?.[0]?.phaseTransfers ?? {};
  const shape = JSON.stringify({
    le: t['Living Expenses']?.map(x => [x.toDisplayName, x.monthlyMoveValue]),
    ho: t['Home']?.map(x => [x.toDisplayName, x.monthlyMoveValue]),
    ss: t['Social Security']?.map(x => [x.toDisplayName, x.monthlyMoveValue]),
    tc: t['CompanyStock']?.map(x => [x.toDisplayName, x.closeMoveValue]),
  });
  const expected = JSON.stringify({
    le: [['IRA', 75], ['Brokerage', 25]],
    ho: [['IRA', 75], ['Brokerage', 25]],
    ss: [['Brokerage', 100]],
    tc: [['Brokerage', 100]],
  });
  assert.equal(shape, expected,
    'dataset routing changed — update the oracle model in this file to match');
  assert.equal(S.filingAs, 'Single', 'oracle implements Single brackets only');
}
requireRouting();

const byName = (n) => data.modelAssets.find(a => a.displayName === n);
const rate = (a) => a.annualReturnRate.annualReturnRate ?? a.annualReturnRate.rate ?? 0;

// ── Clean-room oracle (independent of all simulator code above) ──────
// Conventions matched to the engine's documented ones (monthly ARR/12,
// withdraw-then-grow, escrow in arrears); tax law computed exactly and
// annually. See the 2026-07-21 audit for the full derivation.
function runOracle({ withNIIT }) {
  const ORD_2026 = [
    [0, 12400, 0.10], [12400, 50400, 0.12], [50400, 105700, 0.22],
    [105700, 201775, 0.24], [201775, 256225, 0.32], [256225, 640600, 0.35],
    [640600, Infinity, 0.37],
  ];
  const LTCG_2026 = [[0, 49450, 0], [49450, 545500, 0.15], [545500, Infinity, 0.20]];
  const RMD_DIVISORS = { 75: 24.7, 76: 23.8, 77: 22.9, 78: 22.0, 79: 21.1, 80: 20.2,
    81: 19.4, 82: 18.5, 83: 17.7, 84: 16.8, 85: 16.0, 86: 15.2, 87: 14.4 };
  const SALT_CAP = 40000, NIIT_THRESHOLD = 200000, LT_FRAC = 0.8;

  const walk = (br, x) => {
    let t = 0;
    for (const [lo, hi, r] of br) { if (x <= lo) break; t += (Math.min(x, hi) - lo) * r; }
    return t;
  };
  const stack = (br, o, g) => {
    let t = 0;
    for (const [lo, hi, r] of br) {
      const a = Math.max(lo, o), b = Math.min(hi, o + g);
      if (b > a) t += (b - a) * r;
    }
    return t;
  };

  const first = { y: 2026, m: 5 };                       // earliest startDateInt
  const finishYear = first.y - S.startAge + S.finishAge; // clock-pinned window
  const MONTHS = (finishYear - first.y) * 12 + (12 - first.m) + 1;
  const INFL = S.inflationRate;
  const birthYear = first.y - S.startAge;

  let ord = ORD_2026.map(r => [...r]);
  let ltcg = LTCG_2026.map(r => [...r]);
  let stdDed = 16100;

  let savings = byName('Savings').startCurrency.amount;
  let ira = byName('IRA').startCurrency.amount;
  let roth = byName('Roth').startCurrency.amount;
  let brokerage = byName('Brokerage').startCurrency.amount;
  let brokerageBasis = byName('Brokerage').startBasisCurrency.amount;
  let taxcloud = byName('CompanyStock').startCurrency.amount;
  let treasuries = byName('Treasuries').startCurrency.amount;
  let home = byName('Home').startCurrency.amount;
  let mortgage = -byName('Mortgage').startCurrency.amount;

  const g = {
    ira: rate(byName('IRA')) / 12, roth: rate(byName('Roth')) / 12,
    brok: rate(byName('Brokerage')) / 12, tc: rate(byName('CompanyStock')) / 12,
    home: rate(byName('Home')) / 12, sav: rate(byName('Savings')) / 12,
    tre: rate(byName('Treasuries')) / 12,
    div: (byName('Brokerage').annualDividendRate.annualReturnRate ?? 0) / 12,
  };
  const homeCfg = byName('Home');
  const homeTaxM = (homeCfg.annualTaxRate.annualReturnRate ?? 0) / 12;
  const homeMaintM = (homeCfg.annualMaintenanceRate.annualReturnRate ?? 0) / 12;
  const homeInsM = (homeCfg.annualInsuranceCost.amount ?? 0) / 12;
  const mRate = rate(byName('Mortgage')) / 12;
  const mN = byName('Mortgage').monthsRemaining;
  const mPay = mortgage * mRate * Math.pow(1 + mRate, mN) / (Math.pow(1 + mRate, mN) - 1);
  const ssCfg = byName('Social Security');
  let ssBenefit = ssCfg.startCurrency.amount;
  const ssStart = { y: ssCfg.startDateInt.year, m: ssCfg.startDateInt.month };
  const ssCola = rate(ssCfg);
  const tcFinish = byName('CompanyStock').finishDateInt;
  const exp0 = -byName('Living Expenses').startCurrency.amount;

  let Y = { iraDist: 0, interest: 0, ss: 0, stGains: 0, ltGains: 0, qualDiv: 0, mortInt: 0, propTax: 0 };
  let iraPriorDec31 = ira;
  let prevHomeTaxAccrual = 0;
  const totals = { ordTax: 0, ltcgTax: 0, niit: 0, iraDist: 0, mortInterest: 0 };

  const sellBrokerage = (amount) => {
    if (amount <= 0 || brokerage <= 0) return 0;
    const frac = Math.min(amount / brokerage, 1);
    const basisOut = brokerageBasis * frac;
    brokerage -= amount;
    brokerageBasis -= basisOut;
    return Math.max(amount - basisOut, 0);
  };

  for (let i = 0; i < MONTHS; i++) {
    const y = first.y + Math.floor((first.m - 1 + i) / 12);
    const m = ((first.m - 1 + i) % 12) + 1;

    if (m === 1) {
      const r = 1 + INFL;
      ord = ord.map(([lo, hi, rt]) => [lo * r, hi === Infinity ? Infinity : hi * r, rt]);
      ltcg = ltcg.map(([lo, hi, rt]) => [lo * r, hi === Infinity ? Infinity : hi * r, rt]);
      stdDed *= r;
      if (y > ssStart.y) ssBenefit *= 1 + ssCola;
    }

    let brokCash = 0;
    if (y > ssStart.y || (y === ssStart.y && m >= ssStart.m)) {
      brokCash += ssBenefit;
      Y.ss += ssBenefit;
    }

    let brokOutflow = 0;
    if (mortgage > 0.005) {
      const interest = mortgage * mRate;
      let principal = mPay - interest;
      if (principal > mortgage) principal = mortgage;
      mortgage -= principal;
      Y.mortInt += interest;
      totals.mortInterest += interest;
      brokOutflow += principal + interest;
    }

    const livingExp = exp0 * Math.pow(1 + INFL / 12, i);
    const homePostGrowth = home * (1 + g.home);
    const propTax = prevHomeTaxAccrual;                 // escrow in arrears
    const maint = homePostGrowth * homeMaintM;
    prevHomeTaxAccrual = homePostGrowth * homeTaxM;
    home = homePostGrowth;
    Y.propTax += propTax;

    const fundable = livingExp + propTax + maint + homeInsM;
    const iraGot = Math.min(ira, 0.75 * fundable);
    ira -= iraGot;
    Y.iraDist += iraGot;
    totals.iraDist += iraGot;
    brokOutflow += 0.25 * fundable + (0.75 * fundable - iraGot);

    const net = brokOutflow - brokCash;
    if (net > 0) {
      const gain = sellBrokerage(net);
      Y.ltGains += gain * LT_FRAC;
      Y.stGains += gain * (1 - LT_FRAC);
    } else if (net < 0) {
      brokerage += -net;
      brokerageBasis += -net;
    }

    ira *= 1 + g.ira;
    roth *= 1 + g.roth;
    brokerage *= 1 + g.brok;
    if (taxcloud > 0) taxcloud *= 1 + g.tc;
    const savInt = savings * g.sav;
    savings += savInt;
    const treInt = treasuries * g.tre;
    treasuries += treInt;
    Y.interest += savInt + treInt;

    const div = brokerage * g.div;
    brokerage += div;
    brokerageBasis += div;
    Y.qualDiv += div;

    if (y === tcFinish.year && m === tcFinish.month) {  // held >12mo: long-term
      Y.ltGains += taxcloud;
      brokerage += taxcloud;
      brokerageBasis += taxcloud;
      taxcloud = 0;
    }

    if (m === 12) {
      const age = y - birthYear;
      const divisor = RMD_DIVISORS[age];
      if (age >= 75 && divisor) {                       // born 1969 → RMD at 75
        const rmd = iraPriorDec31 / divisor;
        if (Y.iraDist < rmd) {
          const shortfall = Math.min(rmd - Y.iraDist, ira);
          ira -= shortfall;
          savings += shortfall;
          Y.iraDist += shortfall;
          totals.iraDist += shortfall;
        }
      }

      const ordinary = Y.iraDist + Y.interest + 0.85 * Y.ss + Y.stGains;
      const ded = Math.max(stdDed, Y.mortInt + Math.min(Y.propTax, SALT_CAP));
      const taxable = Math.max(0, ordinary - ded);
      const ordTax = walk(ord, taxable);
      const gains = Y.ltGains + Y.qualDiv;
      const ltcgTax = stack(ltcg, taxable, gains);
      let niit = 0;
      if (withNIIT) {
        const nii = Y.interest + Y.qualDiv + Y.ltGains + Y.stGains;
        niit = 0.038 * Math.max(0, Math.min(nii, ordinary + gains - NIIT_THRESHOLD));
      }
      totals.ordTax += ordTax;
      totals.ltcgTax += ltcgTax;
      totals.niit += niit;

      let bill = ordTax + ltcgTax + niit;
      const fromSav = Math.min(savings, bill);          // bank floors at $0
      savings -= fromSav;
      let carryLT = 0, carryST = 0;
      if (bill - fromSav > 0) {
        const gain = sellBrokerage(bill - fromSav);
        carryLT = gain * LT_FRAC;
        carryST = gain * (1 - LT_FRAC);
      }

      iraPriorDec31 = ira;
      Y = { iraDist: 0, interest: 0, ss: 0, stGains: carryST, ltGains: carryLT, qualDiv: 0, mortInt: 0, propTax: 0 };
    }
  }

  return {
    savings, ira, roth, brokerage, brokerageBasis, taxcloud, treasuries, home,
    mortgage: -mortgage,
    ssMonthly: ssBenefit,
    livingExpMonthly: -(exp0 * Math.pow(1 + INFL / 12, MONTHS)),
    total: savings + ira + roth + brokerage + taxcloud + treasuries + home - mortgage,
    totals,
  };
}

// ── Run the engine on the dataset (mirrors the app's import path) ────
global_setInflationRate(S.inflationRate); global_getInflationRate();
global_setFilingAs(S.filingAs); global_getFilingAs();
global_setUserStartAge(S.startAge); global_getUserStartAge();
global_setUserRetirementAge(S.retirementAge); global_getUserRetirementAge();
global_setUserFinishAge(S.finishAge); global_getUserFinishAge();
if (S.backtestYear != null) { global_setBacktestYear(S.backtestYear); global_getBacktestYear(); }
setActiveTaxTable(new TaxTable());

const modelAssets = membrane_rawDataToModelAssets(data.modelAssets);
let lifeEvents = (data.lifeEvents ?? []).map(ModelLifeEvent.fromJSON);
if (S.startAge >= S.retirementAge) {
  const idx = lifeEvents.findIndex(e => e.type === LifeEvent.ACCUMULATE);
  if (idx !== -1) lifeEvents.splice(idx, 1);
}
const portfolio = new Portfolio(modelAssets, false);
portfolio.lifeEvents = lifeEvents.map(e => e.copy());
await chronometer_run(portfolio);

const asset = (n) => portfolio.modelAssets.find(a => a.displayName === n);
const engine = {
  'Social Security': asset('Social Security').finishCurrency.amount,
  'Savings': asset('Savings').finishCurrency.amount,
  'IRA': asset('IRA').finishCurrency.amount,
  'Roth': asset('Roth').finishCurrency.amount,
  'Brokerage': asset('Brokerage').finishCurrency.amount,
  'CompanyStock': asset('CompanyStock').finishCurrency.amount,
  'Treasuries': asset('Treasuries').finishCurrency.amount,
  'Home': asset('Home').finishCurrency.amount,
  'Mortgage': asset('Mortgage').finishCurrency.amount,
  'Living Expenses': asset('Living Expenses').finishCurrency.amount,
  portfolioTotal: portfolio.finishValue().amount,
  employedIncome: portfolio.total.employedIncome.amount,
  socialSecurityIncome: portfolio.total.socialSecurityIncome.amount,
  tradIRADistribution: portfolio.total.tradIRADistribution.amount,
  qualifiedDividends: portfolio.total.qualifiedDividends.amount,
  longTermCapitalGains: portfolio.total.longTermCapitalGains.amount,
  interestIncome: portfolio.total.interestIncome.amount,
  mortgageInterest: portfolio.total.mortgageInterest.amount,
};

// ── Layer B literal ───────────────────────────────────────────────────
// Generated with --print-actual under the pinned 2026-07-15 clock.
// Regenerate DELIBERATELY after intentional calculation changes and
// review the diff line by line.
const EXPECTED_ENGINE = {
  "Social Security": 4021.09,
  "Savings": -17435.19,
  "IRA": 1825464.00,
  "Roth": 4028947.93,
  "Brokerage": 8943629.51,
  "CompanyStock": 0.00,
  "Treasuries": 116821.90,
  "Home": 2307042.36,
  "Mortgage": 0.00,
  "Living Expenses": -11682.19,
  "portfolioTotal": 17204470.52,
  "employedIncome": 0.00,
  "socialSecurityIncome": 950908.99,
  "tradIRADistribution": 2786481.44,
  "qualifiedDividends": 985773.08,
  "longTermCapitalGains": 1240545.89,
  "interestIncome": 66765.17,
  "mortgageInterest": -247134.01,
};

if (PRINT_MODE) {
  console.log('\n// ── Paste over the EXPECTED_ENGINE literal ──');
  console.log('const EXPECTED_ENGINE = {');
  for (const [k, v] of Object.entries(engine)) {
    console.log(`  ${JSON.stringify(k)}: ${v.toFixed(2)},`);
  }
  console.log('};');
  process.exit(0);
}

// ── Harness ───────────────────────────────────────────────────────────
const fmt = (n) => {
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};
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

// ── Layer A: oracle bands ─────────────────────────────────────────────
const oracle = runOracle({ withNIIT: false });   // engine scope: no NIIT
const oracleLaw = runOracle({ withNIIT: true }); // informational

console.log('\n── Oracle vs engine (2056-12) ───────────────────────────\n');

const band = (label, engineVal, oracleVal, tolAbs, tolPct) => {
  check(label, () => {
    const diff = Math.abs(engineVal - oracleVal);
    const limit = Math.max(tolAbs, Math.abs(oracleVal) * (tolPct ?? 0));
    assert.ok(diff <= limit,
      `engine ${fmt(engineVal)} vs oracle ${fmt(oracleVal)} — off by ${fmt(diff)}, allowed ${fmt(limit)}`);
  });
};

// Untouched compounding assets: must match the law model almost exactly.
band('Roth (untouched compounding)', engine['Roth'], oracle.roth, 25);
band('Home (untouched compounding)', engine['Home'], oracle.home, 25);
band('Treasuries (untouched compounding)', engine['Treasuries'], oracle.treasuries, 25);
band('Social Security monthly benefit', engine['Social Security'], oracle.ssMonthly, 1);
band('Living Expenses monthly amount', engine['Living Expenses'], oracle.livingExpMonthly, 1);
band('Mortgage paid off', engine['Mortgage'], oracle.mortgage, 0.01);
band('Lifetime mortgage interest', Math.abs(engine.mortgageInterest), oracle.totals.mortInterest, 5);

// The distribution schedule: both sides fund 75% of the same expense and
// home-cost formulas, and the RMD never binds — tight band. The RMD
// double-count bug moved this by +$736k (26%).
band('Lifetime IRA distributions', engine.tradIRADistribution, oracle.totals.iraDist, 100, 0.005);
band('IRA balance', engine['IRA'], oracle.ira, 0, 0.02);

// Tax-collection timing, all-LT booking, and the stranded-Savings finding
// legitimately separate the sides — wider bands. SS-as-wages moved the
// total by −4% and Brokerage by −11%; these still catch that class.
band('Brokerage balance', engine['Brokerage'], oracle.brokerage, 0, 0.08);
band('Portfolio total', engine.portfolioTotal, oracle.total, 0, 0.05);
check('Savings within the open-F4 window (oracle floors at $0)', () => {
  assert.ok(Math.abs(engine['Savings'] - oracle.savings) <= 25000,
    `engine ${fmt(engine['Savings'])} vs oracle ${fmt(oracle.savings)} — tighten this band when audit finding F4 is fixed`);
});

// Regression tripwires for the two fixed bugs, exact:
check('benefits are never wages (employedIncome === $0)', () => {
  assert.ok(Math.abs(engine.employedIncome) <= 0.005,
    `total.employedIncome = ${fmt(engine.employedIncome)} — Social Security is leaking into the wage ledger again`);
});
check('CompanyStock closed and swept', () => {
  assert.ok(Math.abs(engine['CompanyStock']) <= 0.005, `CompanyStock ended at ${fmt(engine['CompanyStock'])}`);
});

console.log(`\n  (info) full-law oracle incl. NIIT: total ${fmt(oracleLaw.total)}, NIIT ${fmt(oracleLaw.totals.niit)} — not banded; the engine does not model NIIT`);

// ── Layer B: frozen engine values ─────────────────────────────────────
console.log('\n── Frozen engine values (stability) ─────────────────────\n');
if (EXPECTED_ENGINE == null) {
  check('EXPECTED_ENGINE literal present', () => {
    assert.fail('No EXPECTED_ENGINE entry — run with --print-actual and paste the output');
  });
} else {
  const divergences = [];
  for (const [k, v] of Object.entries(EXPECTED_ENGINE)) {
    if (Math.abs(engine[k] - v) > 0.02) {
      divergences.push(`${k}: expected ${fmt(v)}, got ${fmt(engine[k])}`);
    }
  }
  check('all frozen values match (regen with --print-actual after intentional changes)', () => {
    assert.ok(divergences.length === 0, `${divergences.length} divergence(s):\n      ` + divergences.join('\n      '));
  });
}

// ── Summary ───────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
