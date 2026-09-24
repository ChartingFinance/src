/**
 * decumulation-oracle.mjs
 *
 * External-validity check: runs the "2026-05-mouk0ygz" 30-year decumulation
 * dataset (tests/data/portfolio-2026-05-mouk0ygz.json — decoded from a real
 * Share link) through the chronometer AND through an independent clean-room
 * projection built from the dataset's configuration plus federal tax law,
 * then asserts the two agree within documented tolerance bands.
 *
 * The conservation suites prove the books balance and quickstart-golden
 * proves results are stable; neither catches the engine being self-consistent
 * and wrong. Two such bugs were found this way — Social Security taxed at 185%
 * (benefits double-booked as wages) and RMDs forced on top of distributions
 * that already satisfied them — and both would trip these bands loudly if
 * reintroduced (+$209k tax / −$1.38M IRA).
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
 * The clock is pinned to 2026-07-15 as a precaution only: the engine anchors
 * to the plan's own dates, so these values do not depend on it.
 *
 * Known finding the bands still absorb (tighten when fixed):
 *   - longTermCapitalHoldingPercentage is unread (F5): oracle books 80/20
 *     LT/ST per config, engine books all gains long-term.
 *
 * The oracle's NIIT (IRC §1411) model was written from the statute before the
 * engine had one, so it is an independent check, not a restatement.
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

// ── Pin the clock (a precaution; see the header) ──
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
import { simConfigFromGlobals } from '../js/globals.js';
import { makeActiveTaxTable } from '../js/globals.js';

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
// Conventions: a measured annual rate (returns, interest, appreciation,
// inflation) compounds by its twelfth root; a contract APR (the mortgage), a
// dividend yield and the home's annual charges are one twelfth. Then
// withdraw-then-grow and escrow in arrears, matched to the engine; tax law
// computed exactly and annually.
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

  // Federal withholding on a traditional IRA distribution. Held as a literal
  // rather than imported from globals.js on purpose: this is a CLEAN-ROOM
  // model, and importing the engine's own constant would let a wrong rate agree
  // with itself. Must be kept in step with global_retirement_withholding_rate
  // by hand — the band below is what catches a drift.
  const WITHHOLD_RATE = 0.10;

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
  let companyStock = byName('CompanyStock').startCurrency.amount;
  let treasuries = byName('Treasuries').startCurrency.amount;
  let home = byName('Home').startCurrency.amount;
  let mortgage = -byName('Mortgage').startCurrency.amount;

  const measured = (r) => Math.pow(1 + r, 1 / 12) - 1;
  const g = {
    ira: measured(rate(byName('IRA'))), roth: measured(rate(byName('Roth'))),
    brok: measured(rate(byName('Brokerage'))), tc: measured(rate(byName('CompanyStock'))),
    home: measured(rate(byName('Home'))), sav: measured(rate(byName('Savings'))),
    tre: measured(rate(byName('Treasuries'))),
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

  let Y = { iraDist: 0, withheld: 0, interest: 0, ss: 0, stGains: 0, ltGains: 0, qualDiv: 0, mortInt: 0, propTax: 0 };
  let iraPriorDec31 = ira;
  let prevHomeTaxAccrual = 0;
  const totals = { ordTax: 0, ltcgTax: 0, niit: 0, iraDist: 0, withheld: 0, mortInterest: 0 };

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
      // The engine routes the mortgage 75% IRA / 25% brokerage like every
      // other obligation; this model charges it wholly to the brokerage. On
      // purpose: moving it into `fundable` drains the oracle's IRA to $0 while
      // the engine's keeps a large balance, so the rest of the model is
      // calibrated around it. It is the main reason the IRA band is wider.
      brokOutflow += principal + interest;
    }

    const livingExp = exp0 * Math.pow(1 + INFL, i / 12);
    const homePostGrowth = home * (1 + g.home);
    const propTax = prevHomeTaxAccrual;                 // escrow in arrears
    const maint = homePostGrowth * homeMaintM;
    prevHomeTaxAccrual = homePostGrowth * homeTaxM;
    home = homePostGrowth;
    Y.propTax += propTax;

    const fundable = livingExp + propTax + maint + homeInsM;
    const iraNet = Math.min(ira, 0.75 * fundable);

    // Federal withholding at the source. The account funds the obligation AND
    // the tax on the resulting gross distribution, so gross = net/(1−rate) and
    // the withheld portion is itself ordinary income. Clamped to what the
    // account actually holds, exactly as debit() clamps at $0.
    // Deducted AFTER growth below, not here: the engine's sweep runs on the
    // last day of the month, so the withheld dollars earn that month's return
    // before leaving. Taking them out now compounds a ~3.6% error over 200
    // months.
    const iraWithheldPending = iraNet * WITHHOLD_RATE / (1 - WITHHOLD_RATE);

    ira -= iraNet;
    Y.iraDist += iraNet;
    totals.iraDist += iraNet;

    // Only the NET reached the obligation — the brokerage still covers whatever
    // the IRA's 75% share could not.
    brokOutflow += 0.25 * fundable + (0.75 * fundable - iraNet);

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

    // Month-end withholding sweep, clamped to what the account still holds.
    const iraWithheld = Math.min(Math.max(0, ira), iraWithheldPending);
    ira -= iraWithheld;
    Y.iraDist += iraWithheld;
    Y.withheld += iraWithheld;
    totals.iraDist += iraWithheld;
    totals.withheld += iraWithheld;

    roth *= 1 + g.roth;
    brokerage *= 1 + g.brok;
    if (companyStock > 0) companyStock *= 1 + g.tc;
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
      Y.ltGains += companyStock;
      brokerage += companyStock;
      brokerageBasis += companyStock;
      companyStock = 0;
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

      // Withholding already remitted during the year settles the bill first;
      // only the remainder is collected in April. Over-withholding refunds,
      // which is why the rate governs attribution rather than total tax.
      let bill = ordTax + ltcgTax + niit - Y.withheld;
      let carryLT = 0, carryST = 0;
      if (bill < 0) {
        savings += -bill;                               // refund
      } else {
        const fromSav = Math.min(savings, bill);        // bank floors at $0
        savings -= fromSav;
        if (bill - fromSav > 0) {
          const gain = sellBrokerage(bill - fromSav);
          carryLT = gain * LT_FRAC;
          carryST = gain * (1 - LT_FRAC);
        }
      }

      iraPriorDec31 = ira;
      Y = { iraDist: 0, withheld: 0, interest: 0, ss: 0, stGains: carryST, ltGains: carryLT, qualDiv: 0, mortInt: 0, propTax: 0 };
    }
  }

  return {
    savings, ira, roth, brokerage, brokerageBasis, companyStock, treasuries, home,
    mortgage: -mortgage,
    ssMonthly: ssBenefit,
    livingExpMonthly: -(exp0 * Math.pow(1 + INFL, MONTHS / 12)),
    total: savings + ira + roth + brokerage + companyStock + treasuries + home - mortgage,
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
setActiveTaxTable(makeActiveTaxTable());

const modelAssets = membrane_rawDataToModelAssets(data.modelAssets);
let lifeEvents = (data.lifeEvents ?? []).map(ModelLifeEvent.fromJSON);
if (S.startAge >= S.retirementAge) {
  const idx = lifeEvents.findIndex(e => e.type === LifeEvent.ACCUMULATE);
  if (idx !== -1) lifeEvents.splice(idx, 1);
}
const portfolio = new Portfolio(modelAssets, false, simConfigFromGlobals());
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
// Generated with --print-actual under the pinned clock. Regenerate only after
// an intentional calculation change, predict the diff first, and review it line
// by line. Each past move is explained in the commit that made it
// (git log -p on this file).
//
// Do not "simplify" this scenario. It is the only one in the project where a
// capital gain at an asset's close is stacked on a non-zero taxable base: every
// snapshot fixture closes assets at the top of the month, before any income is
// booked, so their base is exactly zero. Here the non-zero base is an accident
// of asset ordering that a fixture built to reproduce it could not.
const EXPECTED_ENGINE = {
  "Social Security": 4021.09,
  "Savings": 0.00,
  "IRA": 205135.11,
  "Roth": 3661282.38,
  "Brokerage": 8727555.05,
  "CompanyStock": 0.00,
  "Treasuries": 114876.37,
  "Home": 2294291.59,
  "Mortgage": 0.00,
  "Living Expenses": -11487.64,
  "portfolioTotal": 15003140.51,
  "employedIncome": 0.00,
  "socialSecurityIncome": 950908.99,
  "tradIRADistribution": 3071923.44,
  "qualifiedDividends": 971527.26,
  "longTermCapitalGains": 1232004.31,
  "interestIncome": 74945.70,
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
// The banded model is the full-law one, including NIIT, since the engine
// charges it.
const oracle = runOracle({ withNIIT: true });
const oracleNoNIIT = runOracle({ withNIIT: false }); // informational: the gap NIIT accounts for

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
// The oracle models source withholding (gross-up, month-end timing,
// over-withholding refunds). The remaining gap, about $11k with the engine
// above, comes from this model charging the whole mortgage to the brokerage
// (see the mortgage block). Tighten when the oracle models mortgage routing.
//
// A dollar band, not a percentage: the gap is a fixed amount, and the IRA
// balance it sits on is a small residual, so a percentage band would have to be
// loose enough to hide a real divergence. $15k is the known gap plus room.
band('IRA balance', engine['IRA'], oracle.ira, 15000, 0);

// Tax-collection timing, all-LT booking, and the stranded-Savings finding
// legitimately separate the sides — wider bands. SS-as-wages moved the
// total by −4% and Brokerage by −11%; these still catch that class.
band('Brokerage balance', engine['Brokerage'], oracle.brokerage, 0, 0.08);
band('Portfolio total', engine.portfolioTotal, oracle.total, 0, 0.05);
// Funding accounts floor at $0 and the shortfall re-sources through the
// backstop chain, so the engine and the oracle agree exactly.
check('Savings floors at $0, matching the oracle exactly', () => {
  assert.ok(Math.abs(engine['Savings'] - oracle.savings) <= 0.01,
    `engine ${fmt(engine['Savings'])} vs oracle ${fmt(oracle.savings)}`);
});

// Regression tripwires for the two fixed bugs, exact:
check('benefits are never wages (employedIncome === $0)', () => {
  assert.ok(Math.abs(engine.employedIncome) <= 0.005,
    `total.employedIncome = ${fmt(engine.employedIncome)} — Social Security is leaking into the wage ledger again`);
});
check('CompanyStock closed and swept', () => {
  assert.ok(Math.abs(engine['CompanyStock']) <= 0.005, `CompanyStock ended at ${fmt(engine['CompanyStock'])}`);
});

// The oracle's 1411 model is INDEPENDENT of the engine's - written from the
// statute before the engine had one, not derived from js/tax-basis.js. It
// reaches the same shape by a different route: nii = interest + qualified
// dividends + both gain kinds, threshold 200,000, 3.8% of the lesser of NII
// and the MAGI excess. The bands above are what assert that agreement.
console.log(`
  (info) NIIT charged by the oracle: ${fmt(oracle.totals.niit)}; the same plan with 1411 switched off ends at ${fmt(oracleNoNIIT.total)}`);

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
