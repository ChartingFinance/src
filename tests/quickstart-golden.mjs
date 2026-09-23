/**
 * quickstart-golden.mjs
 *
 * Golden-master (characterization) test over the four Quick Start profiles
 * (js/quick-start.js: Early Career, Mid Career, Pre-Retirement, Retired).
 * Three stages per profile:
 *
 *   Stage 0  — load fidelity: the in-memory ModelAssets built by
 *              buildQuickStart() exactly match the profile's raw JSON
 *              definitions (computed live, no golden values needed).
 *   Stage 1  — after ONE simulated month, every asset balance and every
 *              FinancialPackage field matches the frozen golden values.
 *   Stage 13 — same after THIRTEEN months — one past the year boundary, so
 *              the annual tax true-up, COLA raise, yearly accumulator reset,
 *              and tax-table inflation have all fired exactly once.
 *
 * Any change to any financial calculation — intended or not — breaks
 * stage 1 or stage 13. That is the point. After an INTENTIONAL change:
 *
 *     node src/tests/quickstart-golden.mjs --print-actual
 *
 * prints the EXPECTED block with current values, ready to paste over the
 * literal below. Review the diff — every changed number should be explained
 * by the change you just made.
 *
 * THE CLOCK IS PINNED to 2026-01-15: quick-start.js anchors all dates to
 * "today", so without pinning, the golden values would rot every month.
 *
 * Usage:  node src/tests/quickstart-golden.mjs                (assert)
 *         node src/tests/quickstart-golden.mjs --print-actual (regenerate)
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

// ── Pin the clock (BEFORE any profile is built) ───────────────────────
// quick-start.js calls `new Date()` inside dateAnchors() at build time;
// life-event defaults do the same. Both run lazily, so patching here is
// sufficient. Only the zero-argument constructor and Date.now are pinned.
const RealDate = Date;
const PINNED_YEAR = 2026, PINNED_MONTH = 1;
const PINNED = new RealDate(PINNED_YEAR, PINNED_MONTH - 1, 15);
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(PINNED.getTime());
    else super(...args);
  }
  static now() { return PINNED.getTime(); }
};

// ── Imports ───────────────────────────────────────────────────────────
import { Portfolio, FINANCIAL_FIELDS } from '../js/portfolio.js';
import { chronometer_run } from '../js/chronometer.js';
import {
  setActiveTaxTable,
  global_setUserStartAge, global_getUserStartAge,
  global_setUserRetirementAge, global_getUserRetirementAge,
} from '../js/globals.js';
import { quickStartProfiles, buildQuickStart } from '../js/quick-start.js';
import { simConfigFromGlobals } from '../js/globals.js';
import { makeActiveTaxTable } from '../js/globals.js';

const PRINT_MODE = process.argv.includes('--print-actual');

// ── Helpers ───────────────────────────────────────────────────────────
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

/** Metric history entries may be Currency objects or numbers. */
const histVal = (entry) => (entry == null ? 0 : (entry.amount ?? Number(entry) ?? 0));

const round2 = (n) => Math.round(n * 100) / 100;
const TOLERANCE = 0.01; // golden values are stored at cent precision

/** Replicates quick-start.js dateAnchors() under the pinned clock. */
function anchorsFor(profile) {
  const birthYear = PINNED_YEAR - profile.startAge;
  return {
    now:    { year: PINNED_YEAR, month: PINNED_MONTH },
    retire: { year: birthYear + profile.retirementAge, month: 1 },
    finish: { year: birthYear + profile.finishAge, month: 1 },
    plus(years) { return { year: PINNED_YEAR + years, month: PINNED_MONTH }; },
  };
}

/** Snapshot of all asset balances + all FP fields at month index i (0-based). */
function snapshotAt(portfolio, i) {
  const assets = {};
  for (const a of portfolio.modelAssets) {
    assets[a.displayName] = round2(histVal(a.monthlyValues[i]));
  }
  const fp = {};
  const pkg = portfolio.monthlyPackages[i];
  for (const f of FINANCIAL_FIELDS) {
    fp[f] = round2(pkg[f].amount);
  }
  return { assets, fp };
}

function compareSnapshot(label, actual, expected) {
  check(label, () => {
    const diffs = [];
    for (const [group, expGroup] of Object.entries(expected)) {
      for (const [key, expVal] of Object.entries(expGroup)) {
        const actVal = actual[group]?.[key];
        if (actVal == null || Math.abs(actVal - expVal) > TOLERANCE) {
          diffs.push(`${group}.${key}: expected ${fmt(expVal)}, got ${actVal == null ? 'missing' : fmt(actVal)}`);
        }
      }
      // New keys appearing is also a change worth flagging
      for (const key of Object.keys(actual[group] ?? {})) {
        if (!(key in expGroup)) diffs.push(`${group}.${key}: unexpected new entry ${fmt(actual[group][key])}`);
      }
    }
    assert.equal(diffs.length, 0, `${diffs.length} divergence(s):\n      ` + diffs.join('\n      '));
  });
}

// ── Stage 0: load fidelity (computed live, not golden) ────────────────
function stage0(profile, built, rawAssets) {
  check(`stage 0: ${rawAssets.length} assets loaded, none extra`, () => {
    assert.equal(built.assets.length, rawAssets.length,
      `Built ${built.assets.length} assets from ${rawAssets.length} JSON definitions`);
  });

  check('stage 0: every in-memory field matches its JSON definition', () => {
    const diffs = [];
    for (const raw of rawAssets) {
      const asset = built.assets.find(a => a.displayName === raw.displayName);
      if (!asset) { diffs.push(`${raw.displayName}: not built`); continue; }

      const expect = (field, actualVal, rawVal) => {
        if (rawVal === undefined) return; // only assert fields present in the JSON
        if (actualVal !== rawVal) diffs.push(`${raw.displayName}.${field}: JSON ${rawVal}, in-memory ${actualVal}`);
      };

      expect('instrument', asset.instrument, raw.instrument);
      expect('startDateInt.year', asset.startDateInt.year, raw.startDateInt.year);
      expect('startDateInt.month', asset.startDateInt.month, raw.startDateInt.month);
      expect('finishDateInt.year', asset.finishDateInt?.year, raw.finishDateInt?.year);
      expect('finishDateInt.month', asset.finishDateInt?.month, raw.finishDateInt?.month);
      expect('startCurrency', asset.startCurrency.amount, raw.startCurrency.amount);
      expect('startBasisCurrency', asset.startBasisCurrency.amount, raw.startBasisCurrency?.amount);
      expect('annualReturnRate', asset.annualReturnRate.rate, raw.annualReturnRate?.rate);
      expect('annualTaxRate', asset.annualTaxRate.rate, raw.annualTaxRate?.rate);
      expect('monthsRemaining', asset.monthsRemaining, raw.monthsRemaining);
    }
    assert.equal(diffs.length, 0, `${diffs.length} divergence(s):\n      ` + diffs.join('\n      '));
  });

  check('stage 0: life events present and every transfer target resolves', () => {
    const names = new Set(built.assets.map(a => a.displayName));
    const diffs = [];
    for (const event of built.lifeEvents) {
      for (const [source, transfers] of Object.entries(event.phaseTransfers ?? {})) {
        if (!names.has(source)) diffs.push(`phase '${event.displayName}': source '${source}' is not an asset`);
        for (const t of transfers) {
          if (!names.has(t.toDisplayName)) diffs.push(`phase '${event.displayName}': target '${t.toDisplayName}' is not an asset`);
        }
      }
    }
    assert.ok(built.lifeEvents.length > 0, 'No life events built');
    assert.equal(diffs.length, 0, `${diffs.length} broken reference(s):\n      ` + diffs.join('\n      '));
  });
}

// ── Golden values ─────────────────────────────────────────────────────
// Generated with --print-actual under the pinned 2026-01-15 clock.
// Regenerate DELIBERATELY after intentional calculation changes and review
// the diff line by line.
// Values moved 2026-08-07 by the bracket-gap fix: 34 of 376, none by more than
// $0.66. Bracket rows now tile exactly rather than each starting a dollar above
// the previous row's end, so no crossed boundary loses a dollar of base. Tax up,
// balances down, everywhere.
// Extended 2026-08-07 with the three new MFJ profiles. Purely additive: all 376
// values across the five existing profiles are byte-identical, checked
// key-by-key before pasting, so nothing structural hid inside a regeneration.
// Extended 2026-08-20 by the NIIT visibility fix: FinancialPackage gained a
// `niit` field so federalTaxes() and the report view can show the tax the
// engine was already collecting. PURELY ADDITIVE — every pre-existing value is
// byte-identical, verified by stripping the new lines and comparing literals,
// and all 16 new entries are 0.00 because no profile owes NIIT by month 13.
// Extended 2026-09-05 by the estimatedTaxes sign fix: FinancialPackage gained a
// `taxTrueUp` field, because the annual true-up settled cash against the
// accounts in BOTH directions and told the household package about neither, so
// federalTaxes() reported the same number whether a plan paid an April bill,
// received a refund, or did neither. PURELY ADDITIVE — all 742 pre-existing
// lines are byte-identical, verified by stripping the new field and comparing
// literals line by line, and 12 of the 16 new entries are 0.00 because most
// profiles have not settled a year by month 13.
// Moved 2026-09-23 by measured growth rates: a stated annual return, interest
// rate or inflation rate now compounds to exactly that rate a year, instead of
// the rate/12 monthly step that realised 8.839% from 8.5%. After one month every
// growing balance is slightly SMALLER (401K, Roth, Brokerage, Home, bank) and
// every default-rate expense inflates slightly less. Wages, FICA, and the
// mortgage payment, interest and principal do not move: the mortgage is a
// contract APR and stays rate/12. 148 of 644 values moved; wages, FICA,
// pensions, Social Security and every mortgage field are byte-identical.
const EXPECTED = {
  earlyCareer: {
    month1: {
      assets: {
        Salary: 5500.00,
        'Social Security': 0.00,
        '401K': 45749.97,
        'Roth IRA': 15272.87,
        Brokerage: 19808.96,
        Home: 350863.19,
        Mortgage: -279626.09,
        'Living Expenses': -2506.37,
        Rent: 0.00,
      },
      fp: {
        employedIncome: 5500.00,
        selfIncome: 0.00,
        socialSecurityTax: -341.00,
        socialSecurityIncome: 0.00,
        pensionIncome: 0.00,
        assetAppreciation: 1784.77,
        expense: -2500.00,
        medicareTax: -79.75,
        incomeTax: -404.53,
        estimatedTaxes: 0.00,
        tradIRAContribution: 0.00,
        four01KContribution: 440.00,
        rothIRAContribution: 169.39,
        tradIRADistribution: 0.00,
        four01KDistribution: 0.00,
        rothIRADistribution: 0.00,
        mortgageInterest: -1516.67,
        mortgagePrincipal: -373.91,
        propertyTaxes: -350.86,
        shortTermCapitalGains: 0.00,
        longTermCapitalGains: 130.10,
        excludedCapitalGains: 0.00,
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        niit: 0.00,
        taxTrueUp: 0.00,
        value: 155062.53,
      },
    },
    month13: {
      assets: {
        Salary: 5665.00,
        'Social Security': 0.00,
        '401K': 55172.08,
        'Roth IRA': 18700.24,
        Brokerage: 13047.52,
        Home: 361389.09,
        Mortgage: -274977.97,
        'Living Expenses': -2584.07,
        Rent: 0.00,
      },
      fp: {
        employedIncome: 5665.00,
        selfIncome: 0.00,
        socialSecurityTax: -351.23,
        socialSecurityIncome: 0.00,
        pensionIncome: 0.00,
        assetAppreciation: 1876.95,
        expense: -2577.50,
        medicareTax: -82.14,
        incomeTax: -425.11,
        estimatedTaxes: 0.00,
        tradIRAContribution: 0.00,
        four01KContribution: 453.20,
        rothIRAContribution: 174.13,
        tradIRADistribution: 0.00,
        four01KDistribution: 0.00,
        rothIRADistribution: 0.00,
        mortgageInterest: -1491.62,
        mortgagePrincipal: -398.96,
        propertyTaxes: -361.39,
        shortTermCapitalGains: 0.00,
        longTermCapitalGains: 279.36,
        excludedCapitalGains: 0.00,
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        niit: 0.00,
        taxTrueUp: 512.15,
        value: 176411.90,
      },
    },
  },
  midCareer: {
    month1: {
      assets: {
        Salary: 6500.00,
        'Social Security': 0.00,
        '401K': 101009.37,
        'Roth IRA': 50444.60,
        Brokerage: 50356.99,
        Home: 400986.51,
        Mortgage: -319710.72,
        'Living Expenses': -3007.64,
        Rent: 0.00,
      },
      fp: {
        employedIncome: 6500.00,
        selfIncome: 0.00,
        socialSecurityTax: -403.00,
        socialSecurityIncome: 0.00,
        pensionIncome: 0.00,
        assetAppreciation: 2643.12,
        expense: -3000.00,
        medicareTax: -94.25,
        incomeTax: -536.50,
        estimatedTaxes: 0.00,
        tradIRAContribution: 0.00,
        four01KContribution: 325.00,
        rothIRAContribution: 102.83,
        tradIRADistribution: 0.00,
        four01KDistribution: 0.00,
        rothIRADistribution: 0.00,
        mortgageInterest: -1733.33,
        mortgagePrincipal: -289.28,
        propertyTaxes: -400.99,
        shortTermCapitalGains: 0.00,
        longTermCapitalGains: 0.00,
        excludedCapitalGains: 0.00,
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        niit: 0.00,
        taxTrueUp: 0.00,
        value: 286579.11,
      },
    },
    month13: {
      assets: {
        Salary: 6662.50,
        'Social Security': 0.00,
        '401K': 113680.67,
        'Roth IRA': 56024.28,
        Brokerage: 49860.48,
        Home: 413016.10,
        Mortgage: -316114.62,
        'Living Expenses': -3100.88,
        Rent: 0.00,
      },
      fp: {
        employedIncome: 6662.50,
        selfIncome: 0.00,
        socialSecurityTax: -413.07,
        socialSecurityIncome: 0.00,
        pensionIncome: 0.00,
        assetAppreciation: 2812.38,
        expense: -3093.00,
        medicareTax: -96.61,
        incomeTax: -561.06,
        estimatedTaxes: 0.00,
        tradIRAContribution: 0.00,
        four01KContribution: 333.13,
        rothIRAContribution: 105.17,
        tradIRADistribution: 0.00,
        four01KDistribution: 0.00,
        rothIRADistribution: 0.00,
        mortgageInterest: -1713.96,
        mortgagePrincipal: -308.66,
        propertyTaxes: -413.02,
        shortTermCapitalGains: 0.00,
        longTermCapitalGains: 199.06,
        excludedCapitalGains: 0.00,
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        niit: 0.00,
        taxTrueUp: 647.70,
        value: 320028.53,
      },
    },
  },
  preRetirement: {
    month1: {
      assets: {
        Salary: 7500.00,
        'Social Security': 0.00,
        '401K': 353142.64,
        IRA: 120818.58,
        'Roth IRA': 80709.64,
        Brokerage: 101955.04,
        'Living Expenses': -4010.19,
      },
      fp: {
        employedIncome: 7500.00,
        selfIncome: 0.00,
        socialSecurityTax: -465.00,
        socialSecurityIncome: 0.00,
        pensionIncome: 0.00,
        assetAppreciation: 4448.82,
        expense: -4000.00,
        medicareTax: -108.75,
        incomeTax: -749.17,
        estimatedTaxes: 0.00,
        tradIRAContribution: 0.00,
        four01KContribution: 750.00,
        rothIRAContribution: 162.81,
        tradIRADistribution: 0.00,
        four01KDistribution: 0.00,
        rothIRADistribution: 0.00,
        mortgageInterest: 0.00,
        mortgagePrincipal: 0.00,
        propertyTaxes: 0.00,
        shortTermCapitalGains: 0.00,
        longTermCapitalGains: 0.00,
        excludedCapitalGains: 0.00,
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        niit: 0.00,
        taxTrueUp: 0.00,
        value: 660115.72,
      },
    },
    month13: {
      assets: {
        Salary: 7650.00,
        'Social Security': 0.00,
        '401K': 392584.08,
        IRA: 131088.16,
        'Roth IRA': 89616.07,
        Brokerage: 125767.98,
        'Living Expenses': -4134.51,
      },
      fp: {
        employedIncome: 7650.00,
        selfIncome: 0.00,
        socialSecurityTax: -474.30,
        socialSecurityIncome: 0.00,
        pensionIncome: 0.00,
        assetAppreciation: 5007.31,
        expense: -4124.00,
        medicareTax: -110.93,
        incomeTax: -756.06,
        estimatedTaxes: 0.00,
        tradIRAContribution: 0.00,
        four01KContribution: 765.00,
        rothIRAContribution: 166.31,
        tradIRADistribution: 0.00,
        four01KDistribution: 0.00,
        rothIRADistribution: 0.00,
        mortgageInterest: 0.00,
        mortgagePrincipal: 0.00,
        propertyTaxes: 0.00,
        shortTermCapitalGains: 0.00,
        longTermCapitalGains: 0.00,
        excludedCapitalGains: 0.00,
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        niit: 0.00,
        taxTrueUp: 0.00,
        value: 742571.78,
      },
    },
  },
  retired: {
    month1: {
      assets: {
        'Social Security': 3000.00,
        'FERS Pension': 2200.00,
        '401K': 501901.54,
        IRA: 201364.30,
        'Roth IRA': 150117.08,
        Brokerage: 204014.69,
        'Living Expenses': -4511.46,
      },
      fp: {
        employedIncome: 0.00,
        selfIncome: 0.00,
        socialSecurityTax: 0.00,
        socialSecurityIncome: 3000.00,
        pensionIncome: 2200.00,
        assetAppreciation: 7165.84,
        expense: -4500.00,
        medicareTax: 0.00,
        incomeTax: -468.23,
        estimatedTaxes: 0.00,
        tradIRAContribution: 0.00,
        four01KContribution: 0.00,
        rothIRAContribution: 0.00,
        tradIRADistribution: 0.00,
        four01KDistribution: 1500.00,
        rothIRADistribution: 900.00,
        mortgageInterest: 0.00,
        mortgagePrincipal: 0.00,
        propertyTaxes: 0.00,
        shortTermCapitalGains: 0.00,
        longTermCapitalGains: 0.00,
        excludedCapitalGains: 0.00,
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        niit: 0.00,
        taxTrueUp: 0.00,
        value: 1058086.15,
      },
    },
    month13: {
      assets: {
        'Social Security': 3075.00,
        'FERS Pension': 2244.00,
        '401K': 525447.13,
        IRA: 218480.26,
        'Roth IRA': 151399.64,
        Brokerage: 253990.12,
        'Living Expenses': -4651.32,
      },
      fp: {
        employedIncome: 0.00,
        selfIncome: 0.00,
        socialSecurityTax: 0.00,
        socialSecurityIncome: 3075.00,
        pensionIncome: 2244.00,
        assetAppreciation: 7788.71,
        expense: -4639.50,
        medicareTax: 0.00,
        incomeTax: -486.14,
        estimatedTaxes: 0.00,
        tradIRAContribution: 0.00,
        four01KContribution: 0.00,
        rothIRAContribution: 0.00,
        tradIRADistribution: 0.00,
        four01KDistribution: 1546.50,
        rothIRADistribution: 927.90,
        mortgageInterest: 0.00,
        mortgagePrincipal: 0.00,
        propertyTaxes: 0.00,
        shortTermCapitalGains: 0.00,
        longTermCapitalGains: 0.00,
        excludedCapitalGains: 0.00,
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        niit: 0.00,
        taxTrueUp: 0.00,
        value: 1149984.83,
      },
    },
  },
  youngCouple: {
    month1: {
      assets: {
        'Salary A': 5500.00,
        'Salary B': 4500.00,
        'Social Security A': 0.00,
        'Social Security B': 0.00,
        '401K A': 45749.97,
        '401K B': 28553.46,
        'Roth IRA': 20297.17,
        Brokerage: 26782.94,
        Home: 421035.83,
        Mortgage: -339545.96,
        'Living Expenses': -3208.15,
        Rent: 0.00,
      },
      fp: {
        employedIncome: 10000.00,
        selfIncome: 0.00,
        socialSecurityTax: -620.00,
        socialSecurityIncome: 0.00,
        pensionIncome: 0.00,
        assetAppreciation: 2312.28,
        expense: -3200.00,
        medicareTax: -145.00,
        incomeTax: -1178.17,
        estimatedTaxes: 0.00,
        tradIRAContribution: 0.00,
        four01KContribution: 800.00,
        rothIRAContribution: 159.65,
        tradIRADistribution: 0.00,
        four01KDistribution: 0.00,
        rothIRADistribution: 0.00,
        mortgageInterest: -1841.67,
        mortgagePrincipal: -454.04,
        propertyTaxes: -421.04,
        shortTermCapitalGains: 0.00,
        longTermCapitalGains: 0.00,
        excludedCapitalGains: 0.00,
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        niit: 0.00,
        taxTrueUp: 0.00,
        value: 209665.26,
      },
    },
    month13: {
      assets: {
        'Salary A': 5665.00,
        'Salary B': 4635.00,
        'Social Security A': 0.00,
        'Social Security B': 0.00,
        '401K A': 55172.08,
        '401K B': 35507.80,
        'Roth IRA': 24028.93,
        Brokerage: 44428.93,
        Home: 433666.91,
        Mortgage: -333901.82,
        'Living Expenses': -3307.60,
        Rent: 0.00,
      },
      fp: {
        employedIncome: 10300.00,
        selfIncome: 0.00,
        socialSecurityTax: -638.60,
        socialSecurityIncome: 0.00,
        pensionIncome: 0.00,
        assetAppreciation: 2629.56,
        expense: -3299.20,
        medicareTax: -149.35,
        incomeTax: -1231.92,
        estimatedTaxes: 0.00,
        tradIRAContribution: 0.00,
        four01KContribution: 824.00,
        rothIRAContribution: 164.03,
        tradIRADistribution: 0.00,
        four01KDistribution: 0.00,
        rothIRADistribution: 0.00,
        mortgageInterest: -1811.26,
        mortgagePrincipal: -484.45,
        propertyTaxes: -433.67,
        shortTermCapitalGains: 0.00,
        longTermCapitalGains: 0.00,
        excludedCapitalGains: 0.00,
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        niit: 0.00,
        taxTrueUp: 1126.74,
        value: 265895.21,
      },
    },
  },
  dualIncome: {
    month1: {
      assets: {
        'Salary A': 8000.00,
        'Salary B': 6500.00,
        'Social Security A': 0.00,
        'Social Security B': 0.00,
        '401K A': 181711.14,
        '401K B': 121211.24,
        'Roth IRA': 60524.14,
        Brokerage: 83796.24,
        Home: 551356.45,
        Mortgage: -379468.32,
        'Living Expenses': -4511.46,
      },
      fp: {
        employedIncome: 14500.00,
        selfIncome: 0.00,
        socialSecurityTax: -899.00,
        socialSecurityIncome: 0.00,
        pensionIncome: 0.00,
        assetAppreciation: 4918.32,
        expense: -4500.00,
        medicareTax: -210.25,
        incomeTax: -2183.17,
        estimatedTaxes: 0.00,
        tradIRAContribution: 0.00,
        four01KContribution: 870.00,
        rothIRAContribution: 114.07,
        tradIRADistribution: 0.00,
        four01KDistribution: 0.00,
        rothIRADistribution: 0.00,
        mortgageInterest: -1963.33,
        mortgagePrincipal: -531.68,
        propertyTaxes: -551.36,
        shortTermCapitalGains: 0.00,
        longTermCapitalGains: 0.00,
        excludedCapitalGains: 0.00,
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        niit: 0.00,
        taxTrueUp: 0.00,
        value: 629119.43,
      },
    },
    month13: {
      assets: {
        'Salary A': 8200.00,
        'Salary B': 6662.50,
        'Social Security A': 0.00,
        'Social Security B': 0.00,
        '401K A': 203190.57,
        '401K B': 136416.80,
        'Roth IRA': 67101.95,
        Brokerage: 125296.81,
        Home: 567897.14,
        Mortgage: -372869.80,
        'Living Expenses': -4651.32,
      },
      fp: {
        employedIncome: 14862.50,
        selfIncome: 0.00,
        socialSecurityTax: -921.47,
        socialSecurityIncome: 0.00,
        pensionIncome: 0.00,
        assetAppreciation: 5567.23,
        expense: -4639.50,
        medicareTax: -215.51,
        incomeTax: -2253.96,
        estimatedTaxes: 0.00,
        tradIRAContribution: 0.00,
        four01KContribution: 891.75,
        rothIRAContribution: 116.74,
        tradIRADistribution: 0.00,
        four01KDistribution: 0.00,
        rothIRADistribution: 0.00,
        mortgageInterest: -1929.42,
        mortgagePrincipal: -565.60,
        propertyTaxes: -567.90,
        shortTermCapitalGains: 0.00,
        longTermCapitalGains: 0.00,
        excludedCapitalGains: 0.00,
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        niit: 0.00,
        taxTrueUp: 1609.62,
        value: 737244.65,
      },
    },
  },
  coupleNearingRetirement: {
    month1: {
      assets: {
        'Salary A': 7500.00,
        'Salary B': 6000.00,
        'Social Security A': 0.00,
        'Social Security B': 0.00,
        '401K A': 353142.64,
        '401K B': 242241.25,
        IRA: 120818.58,
        'Roth IRA': 110903.74,
        Brokerage: 144466.55,
        'Living Expenses': -5514.01,
      },
      fp: {
        employedIncome: 13500.00,
        selfIncome: 0.00,
        socialSecurityTax: -837.00,
        socialSecurityIncome: 0.00,
        pensionIncome: 0.00,
        assetAppreciation: 6582.67,
        expense: -5500.00,
        medicareTax: -195.75,
        incomeTax: -1977.17,
        estimatedTaxes: 0.00,
        tradIRAContribution: 0.00,
        four01KContribution: 1350.00,
        rothIRAContribution: 152.33,
        tradIRADistribution: 0.00,
        four01KDistribution: 0.00,
        rothIRADistribution: 0.00,
        mortgageInterest: 0.00,
        mortgagePrincipal: 0.00,
        propertyTaxes: 0.00,
        shortTermCapitalGains: 0.00,
        longTermCapitalGains: 0.00,
        excludedCapitalGains: 0.00,
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        niit: 0.00,
        taxTrueUp: 0.00,
        value: 979558.75,
      },
    },
    month13: {
      assets: {
        'Salary A': 7650.00,
        'Salary B': 6120.00,
        'Social Security A': 0.00,
        'Social Security B': 0.00,
        '401K A': 392584.08,
        '401K B': 270371.21,
        IRA: 131088.16,
        'Roth IRA': 122244.93,
        Brokerage: 199554.58,
        'Living Expenses': -5684.94,
      },
      fp: {
        employedIncome: 13770.00,
        selfIncome: 0.00,
        socialSecurityTax: -853.74,
        socialSecurityIncome: 0.00,
        pensionIncome: 0.00,
        assetAppreciation: 7560.14,
        expense: -5670.50,
        medicareTax: -199.67,
        incomeTax: -2006.38,
        estimatedTaxes: 0.00,
        tradIRAContribution: 0.00,
        four01KContribution: 1377.00,
        rothIRAContribution: 155.55,
        tradIRADistribution: 0.00,
        four01KDistribution: 0.00,
        rothIRADistribution: 0.00,
        mortgageInterest: 0.00,
        mortgagePrincipal: 0.00,
        propertyTaxes: 0.00,
        shortTermCapitalGains: 0.00,
        longTermCapitalGains: 0.00,
        excludedCapitalGains: 0.00,
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        niit: 0.00,
        taxTrueUp: 0.00,
        value: 1123928.01,
      },
    },
  },
  retiredCouple: {
    month1: {
      assets: {
        'Social Security A': 3000.00,
        'Social Security B': 2400.00,
        Pension: 2200.00,
        '401K A': 502069.23,
        '401K B': 321176.74,
        IRA: 201364.30,
        'Roth IRA': 180321.73,
        Brokerage: 265585.93,
        'Living Expenses': -6015.28,
      },
      fp: {
        employedIncome: 0.00,
        selfIncome: 0.00,
        socialSecurityTax: 0.00,
        socialSecurityIncome: 5400.00,
        pensionIncome: 2200.00,
        assetAppreciation: 9968.79,
        expense: -6000.00,
        medicareTax: 0.00,
        incomeTax: -1050.87,
        estimatedTaxes: 0.00,
        tradIRAContribution: 0.00,
        four01KContribution: 0.00,
        rothIRAContribution: 0.00,
        tradIRADistribution: 0.00,
        four01KDistribution: 2333.33,
        rothIRADistribution: 900.00,
        mortgageInterest: 0.00,
        mortgagePrincipal: 0.00,
        propertyTaxes: 0.00,
        shortTermCapitalGains: 0.00,
        longTermCapitalGains: 0.00,
        excludedCapitalGains: 0.00,
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        niit: 0.00,
        taxTrueUp: 0.00,
        value: 1472102.64,
      },
    },
    month13: {
      assets: {
        'Social Security A': 3075.00,
        'Social Security B': 2460.00,
        Pension: 2244.00,
        '401K A': 527753.08,
        '401K B': 335732.74,
        IRA: 218480.26,
        'Roth IRA': 184171.68,
        Brokerage: 335056.41,
        'Living Expenses': -6201.76,
      },
      fp: {
        employedIncome: 0.00,
        selfIncome: 0.00,
        socialSecurityTax: 0.00,
        socialSecurityIncome: 5535.00,
        pensionIncome: 2244.00,
        assetAppreciation: 10854.40,
        expense: -6186.00,
        medicareTax: 0.00,
        incomeTax: -1090.47,
        estimatedTaxes: 0.00,
        tradIRAContribution: 0.00,
        four01KContribution: 0.00,
        rothIRAContribution: 0.00,
        tradIRADistribution: 0.00,
        four01KDistribution: 2405.67,
        rothIRADistribution: 927.90,
        mortgageInterest: 0.00,
        mortgagePrincipal: 0.00,
        propertyTaxes: 0.00,
        shortTermCapitalGains: 0.00,
        longTermCapitalGains: 0.00,
        excludedCapitalGains: 0.00,
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        niit: 0.00,
        taxTrueUp: 0.00,
        value: 1602771.41,
      },
    },
  },
};

// ── Main ──────────────────────────────────────────────────────────────
const printed = {};

for (const profile of quickStartProfiles) {
  console.log(`\n── Profile: ${profile.label} (${profile.key}) ${'─'.repeat(Math.max(1, 38 - profile.label.length))}\n`);

  // The app sets these globals when a profile is chosen — mirror that.
  global_setUserStartAge(profile.startAge);
  global_getUserStartAge();
  global_setUserRetirementAge(profile.retirementAge);
  global_getUserRetirementAge();
  setActiveTaxTable(makeActiveTaxTable());

  const built = buildQuickStart(profile);
  const rawAssets = profile.assets(anchorsFor(profile));

  stage0(profile, built, rawAssets);

  const portfolio = new Portfolio(built.assets, true, simConfigFromGlobals());
  portfolio.lifeEvents = built.lifeEvents;
  await chronometer_run(portfolio);

  const month1 = snapshotAt(portfolio, 0);
  const month13 = snapshotAt(portfolio, 12);

  if (PRINT_MODE) {
    printed[profile.key] = { month1, month13 };
  } else if (EXPECTED?.[profile.key]) {
    compareSnapshot('stage 1: month-1 balances and financial package match golden values', month1, EXPECTED[profile.key].month1);
    compareSnapshot('stage 13: month-13 (year-boundary) values match golden values', month13, EXPECTED[profile.key].month13);
  } else {
    check('golden values present for this profile', () => {
      assert.fail('No EXPECTED entry — run with --print-actual and paste the output');
    });
  }
}

// ── Print mode output ─────────────────────────────────────────────────
if (PRINT_MODE) {
  const lit = (obj, indent) => {
    const pad = ' '.repeat(indent);
    const entries = Object.entries(obj).map(([k, v]) => {
      const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : `'${k.replace(/'/g, "\\'")}'`;
      if (typeof v === 'number') return `${pad}${key}: ${v.toFixed(2)},`;
      return `${pad}${key}: {\n${lit(v, indent + 2)}\n${pad}},`;
    });
    return entries.join('\n');
  };
  console.log('\n// ── Paste over the EXPECTED literal ──');
  console.log('const EXPECTED = {');
  console.log(lit(printed, 2));
  console.log('};');
  process.exit(0);
}

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
