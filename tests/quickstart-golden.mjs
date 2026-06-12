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
import { TaxTable } from '../js/taxes.js';
import {
  setActiveTaxTable,
  global_setUserStartAge, global_getUserStartAge,
  global_setUserRetirementAge, global_getUserRetirementAge,
} from '../js/globals.js';
import { quickStartProfiles, buildQuickStart } from '../js/quick-start.js';

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
const EXPECTED = {
  earlyCareer: {
    month1: {
      assets: {
        Salary: 5500.00,
        'Social Security': 0.00,
        '401K': 45761.87,
        'Roth IRA': 15276.84,
        Brokerage: 19814.12,
        Home: 350875.00,
        Mortgage: -279626.09,
        'Living Expenses': -2506.46,
        Rent: 0.00,
      },
      fp: {
        employedIncome: 5500.00,
        selfIncome: 0.00,
        socialSecurityTax: -341.00,
        socialSecurityIncome: 0.00,
        pensionIncome: 0.00,
        assetAppreciation: 1817.59,
        expense: -2500.00,
        medicareTax: -79.75,
        incomeTax: -404.52,
        estimatedTaxes: 0.00,
        tradIRAContribution: 0.00,
        four01KContribution: 440.00,
        rothIRAContribution: 169.39,
        tradIRADistribution: 0.00,
        four01KDistribution: 0.00,
        rothIRADistribution: 0.00,
        mortgageInterest: -1516.67,
        mortgagePrincipal: -373.91,
        propertyTaxes: -350.87,
        shortTermCapitalGains: 0.00,
        longTermCapitalGains: 130.10,
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        value: 155095.28,
      },
    },
    month13: {
      assets: {
        Salary: 5665.00,
        'Social Security': 0.00,
        '401K': 55349.62,
        'Roth IRA': 18760.00,
        Brokerage: 13097.09,
        Home: 361547.20,
        Mortgage: -274977.97,
        'Living Expenses': -2585.27,
        Rent: 0.00,
      },
      fp: {
        employedIncome: 5665.00,
        selfIncome: 0.00,
        socialSecurityTax: -351.23,
        socialSecurityIncome: 0.00,
        pensionIncome: 0.00,
        assetAppreciation: 1913.94,
        expense: -2578.61,
        medicareTax: -82.14,
        incomeTax: -425.10,
        estimatedTaxes: 0.00,
        tradIRAContribution: 0.00,
        four01KContribution: 453.20,
        rothIRAContribution: 174.13,
        tradIRADistribution: 0.00,
        four01KDistribution: 0.00,
        rothIRADistribution: 0.00,
        mortgageInterest: -1491.62,
        mortgagePrincipal: -398.96,
        propertyTaxes: -361.55,
        shortTermCapitalGains: 0.00,
        longTermCapitalGains: 281.01,
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        value: 176855.67,
      },
    },
  },
  midCareer: {
    month1: {
      assets: {
        Salary: 6500.00,
        'Social Security': 0.00,
        '401K': 101035.64,
        'Roth IRA': 50457.72,
        Brokerage: 50370.11,
        Home: 401000.00,
        Mortgage: -319710.72,
        'Living Expenses': -3007.75,
        Rent: 0.00,
      },
      fp: {
        employedIncome: 6500.00,
        selfIncome: 0.00,
        socialSecurityTax: -403.00,
        socialSecurityIncome: 0.00,
        pensionIncome: 0.00,
        assetAppreciation: 2709.09,
        expense: -3000.00,
        medicareTax: -94.25,
        incomeTax: -536.47,
        estimatedTaxes: 0.00,
        tradIRAContribution: 0.00,
        four01KContribution: 325.00,
        rothIRAContribution: 102.83,
        tradIRADistribution: 0.00,
        four01KDistribution: 0.00,
        rothIRADistribution: 0.00,
        mortgageInterest: -1733.33,
        mortgagePrincipal: -289.28,
        propertyTaxes: -401.00,
        shortTermCapitalGains: 0.00,
        longTermCapitalGains: 0.00,
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        value: 286645.00,
      },
    },
    month13: {
      assets: {
        Salary: 6662.50,
        'Social Security': 0.00,
        '401K': 114058.76,
        'Roth IRA': 56211.83,
        Brokerage: 50025.98,
        Home: 413196.80,
        Mortgage: -316114.62,
        'Living Expenses': -3102.33,
        Rent: 0.00,
      },
      fp: {
        employedIncome: 6662.50,
        selfIncome: 0.00,
        socialSecurityTax: -413.07,
        socialSecurityIncome: 0.00,
        pensionIncome: 0.00,
        assetAppreciation: 2888.53,
        expense: -3094.33,
        medicareTax: -96.61,
        incomeTax: -561.03,
        estimatedTaxes: 0.00,
        tradIRAContribution: 0.00,
        four01KContribution: 333.13,
        rothIRAContribution: 105.17,
        tradIRADistribution: 0.00,
        four01KDistribution: 0.00,
        rothIRADistribution: 0.00,
        mortgageInterest: -1713.96,
        mortgagePrincipal: -308.66,
        propertyTaxes: -413.20,
        shortTermCapitalGains: 0.00,
        longTermCapitalGains: 200.39,
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        value: 320938.92,
      },
    },
  },
  preRetirement: {
    month1: {
      assets: {
        Salary: 7500.00,
        'Social Security': 0.00,
        '401K': 353234.48,
        IRA: 120850.00,
        'Roth IRA': 80730.63,
        Brokerage: 101981.59,
        'Living Expenses': -4010.33,
      },
      fp: {
        employedIncome: 7500.00,
        selfIncome: 0.00,
        socialSecurityTax: -465.00,
        socialSecurityIncome: 0.00,
        pensionIncome: 0.00,
        assetAppreciation: 4619.59,
        expense: -4000.00,
        medicareTax: -108.75,
        incomeTax: -749.14,
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
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        value: 660286.37,
      },
    },
    month13: {
      assets: {
        Salary: 7650.00,
        'Social Security': 0.00,
        '401K': 393897.63,
        IRA: 131532.04,
        'Roth IRA': 89916.10,
        Brokerage: 126157.30,
        'Living Expenses': -4136.44,
      },
      fp: {
        employedIncome: 7650.00,
        selfIncome: 0.00,
        socialSecurityTax: -474.30,
        socialSecurityIncome: 0.00,
        pensionIncome: 0.00,
        assetAppreciation: 5215.37,
        expense: -4125.78,
        medicareTax: -110.93,
        incomeTax: -756.03,
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
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        value: 745016.64,
      },
    },
  },
  retired: {
    month1: {
      assets: {
        'Social Security': 3000.00,
        'FERS Pension': 2200.00,
        '401K': 502182.10,
        IRA: 201416.67,
        'Roth IRA': 150156.13,
        Brokerage: 202614.44,
        'Living Expenses': -4511.63,
      },
      fp: {
        employedIncome: 5200.00,
        selfIncome: 0.00,
        socialSecurityTax: 0.00,
        socialSecurityIncome: 3000.00,
        pensionIncome: 2200.00,
        assetAppreciation: 7442.46,
        expense: -4500.00,
        medicareTax: 0.00,
        incomeTax: -1773.12,
        estimatedTaxes: 0.00,
        tradIRAContribution: 0.00,
        four01KContribution: 0.00,
        rothIRAContribution: 0.00,
        tradIRADistribution: 0.00,
        four01KDistribution: 1350.00,
        rothIRADistribution: 900.00,
        mortgageInterest: 0.00,
        mortgagePrincipal: 0.00,
        propertyTaxes: 0.00,
        shortTermCapitalGains: 0.00,
        longTermCapitalGains: 0.00,
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        value: 1057057.72,
      },
    },
    month13: {
      assets: {
        'Social Security': 3075.00,
        'FERS Pension': 2244.00,
        '401K': 529320.99,
        IRA: 219220.07,
        'Roth IRA': 151928.93,
        Brokerage: 235024.24,
        'Living Expenses': -4653.49,
      },
      fp: {
        employedIncome: 5319.00,
        selfIncome: 0.00,
        socialSecurityTax: 0.00,
        socialSecurityIncome: 3075.00,
        pensionIncome: 2244.00,
        assetAppreciation: 7999.23,
        expense: -4641.50,
        medicareTax: 0.00,
        incomeTax: -1808.62,
        estimatedTaxes: 0.00,
        tradIRAContribution: 0.00,
        four01KContribution: 0.00,
        rothIRAContribution: 0.00,
        tradIRADistribution: 0.00,
        four01KDistribution: 1392.45,
        rothIRADistribution: 928.30,
        mortgageInterest: 0.00,
        mortgagePrincipal: 0.00,
        propertyTaxes: 0.00,
        shortTermCapitalGains: 0.00,
        longTermCapitalGains: 0.00,
        nonQualifiedDividends: 0.00,
        qualifiedDividends: 0.00,
        maintenance: 0.00,
        insurance: 0.00,
        interestIncome: 0.00,
        longTermCapitalGainsTax: 0.00,
        value: 1136159.73,
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
  setActiveTaxTable(new TaxTable());

  const built = buildQuickStart(profile);
  const rawAssets = profile.assets(anchorsFor(profile));

  stage0(profile, built, rawAssets);

  const portfolio = new Portfolio(built.assets, true);
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
