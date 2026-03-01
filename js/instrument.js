/**
 * instrument.js
 *
 * Replaces: sInstrumentNames, sInstrumentsIDs, sInstrumentSortOrder,
 *           sIntrumentDisplayNames, and ~30 loose isXxx() classifier functions.
 *
 * Each instrument is defined once. Classification (isCapital, isFundable, etc.)
 * is expressed as Set membership, making it O(1), exhaustive, and easy to extend.
 */

export const Instrument = Object.freeze({
  HOME:                'home',
  MORTGAGE:            'mortgage',
  MONTHLY_SALARY:      'monthlySalary',
  SOCIAL_SECURITY:     'monthlySocialSecurity',
  US_BOND:             'usBond',
  CORP_BOND:           'corpBond',
  BANK:                'bank',
  ROTH_IRA:            'rothIRA',
  IRA:                 'ira',
  FOUR_01K:            '401K',
  TAXABLE_EQUITY:      'taxableEquity',
  CASH:                'cash',
  DEBT:                'debt',
  MONTHLY_EXPENSE:     'monthlyExpense',
});

/** Display metadata — keeps UI concerns separate from identity */
export const InstrumentMeta = new Map([
  [Instrument.HOME,              { emoji: '🏡🌳',    label: 'House',            sortOrder: 0  }],
  [Instrument.MORTGAGE,          { emoji: '🏡💸',  label: 'Mortgage',         sortOrder: 1  }],
  [Instrument.MONTHLY_SALARY,    { emoji: '🔧💲',  label: 'Monthly Income',   sortOrder: 2  }],
  [Instrument.SOCIAL_SECURITY,   { emoji: '🏛️💲',  label: 'Social Security',  sortOrder: 3  }],
  [Instrument.US_BOND,           { emoji: '🏛️💲',    label: 'US Treasury',      sortOrder: 4  }],
  [Instrument.CORP_BOND,         { emoji: '🏦💲',    label: 'Corporate Bond',   sortOrder: 5  }],
  [Instrument.BANK,              { emoji: '🏦💲',    label: 'Savings',          sortOrder: 6  }],
  [Instrument.ROTH_IRA,          { emoji: '📈📈',    label: 'Roth IRA',         sortOrder: 7  }],
  [Instrument.IRA,               { emoji: '⏳📈',  label: 'IRA',              sortOrder: 8  }],
  [Instrument.FOUR_01K,          { emoji: '⏳📈',  label: '401K',             sortOrder: 9  }],
  [Instrument.TAXABLE_EQUITY,    { emoji: '🧾📈',  label: 'Taxable Account',  sortOrder: 10 }],
  [Instrument.CASH,              { emoji: '💰💰',    label: 'Cash',             sortOrder: 11 }],
  [Instrument.DEBT,              { emoji: '💳💸',    label: 'Debt',             sortOrder: 12 }],
  [Instrument.MONTHLY_EXPENSE,   { emoji: '💸💸',  label: 'Monthly Expense',  sortOrder: 13 }],
]);

// ── Classification Sets ──────────────────────────────────────────────
// Each replaces a chain of if/else-if string comparisons.

const MONTHLY_INCOME = new Set([
  Instrument.MONTHLY_SALARY,
  Instrument.SOCIAL_SECURITY,
]);

const MONTHLY_EXPENSE = new Set([
  Instrument.MONTHLY_EXPENSE,
]);

const MORTGAGE = new Set([
  Instrument.MORTGAGE,
]);

const DEBT = new Set([
  Instrument.DEBT,
]);

const TAX_DEFERRED = new Set([
  Instrument.IRA,
  Instrument.FOUR_01K,
]);

const TAX_FREE = new Set([
  Instrument.ROTH_IRA,
]);

const TAXABLE_ACCOUNT = new Set([
  Instrument.TAXABLE_EQUITY,
]);

const INCOME_ACCOUNT = new Set([
  Instrument.BANK,
  Instrument.US_BOND,
  Instrument.CORP_BOND,
]);

const CAPITAL = new Set([
  Instrument.TAXABLE_EQUITY,
  Instrument.IRA,
  Instrument.FOUR_01K,
  Instrument.ROTH_IRA,
  Instrument.HOME,
]);

const FUNDABLE = new Set([
  Instrument.CASH,
  Instrument.BANK,
  Instrument.TAXABLE_EQUITY,
  Instrument.FOUR_01K,
  Instrument.IRA,
  Instrument.ROTH_IRA,
  Instrument.US_BOND,
  Instrument.CORP_BOND,
  Instrument.DEBT,
]);

const EXPENSABLE = new Set([
  Instrument.CASH,
  Instrument.BANK,
  Instrument.TAXABLE_EQUITY,
  Instrument.FOUR_01K,
  Instrument.IRA,
  Instrument.ROTH_IRA,
]);

const LIQUID = new Set([
  Instrument.TAXABLE_EQUITY,
  Instrument.CASH,
  Instrument.BANK,
]);

// Priority order for implicit debits/credits (taxes, FICA, withholding, etc.).
// Liquid taxable accounts first, then tax-advantaged as a last resort.
const EXPENSABLE_PRIORITY = [
  Instrument.CASH,
  Instrument.BANK,
  Instrument.TAXABLE_EQUITY,
  Instrument.FOUR_01K,
  Instrument.IRA,
  Instrument.ROTH_IRA,
];

const MONTHS_REMAINING_ABLE = new Set([
  Instrument.MORTGAGE,
  Instrument.DEBT,
]);

const BASISABLE = new Set([
  Instrument.TAXABLE_EQUITY,
  Instrument.HOME,
]);

// ── Public classifier API ────────────────────────────────────────────
// Drop-in replacements for the old isXxx() free functions.
// Usage:  InstrumentType.isCapital(asset.instrument)

export const InstrumentType = Object.freeze({

  isHome:               (v) => v === Instrument.HOME,
  isMortgage:           (v) => MORTGAGE.has(v),
  isDebt:               (v) => DEBT.has(v),
  isMonthlyIncome:      (v) => MONTHLY_INCOME.has(v),
  isMonthlyExpense:     (v) => MONTHLY_EXPENSE.has(v),
  isSocialSecurity:     (v) => v === Instrument.SOCIAL_SECURITY,
  isIRA:                (v) => v === Instrument.IRA,
  isRothIRA:            (v) => v === Instrument.ROTH_IRA,
  is401K:               (v) => v === Instrument.FOUR_01K,
  isTaxDeferred:        (v) => TAX_DEFERRED.has(v),
  isTaxFree:            (v) => TAX_FREE.has(v),
  isTaxableAccount:     (v) => TAXABLE_ACCOUNT.has(v),
  isIncomeAccount:      (v) => INCOME_ACCOUNT.has(v),
  isCapital:            (v) => CAPITAL.has(v),
  isFundable:           (v) => FUNDABLE.has(v),
  isExpensable:         (v) => EXPENSABLE.has(v),
  isLiquid:             (v) => LIQUID.has(v),
  isSavingsAccount:     (v) => v === Instrument.BANK,
  isMonthsRemainingAble:(v) => MONTHS_REMAINING_ABLE.has(v),
  isBasisable:          (v) => BASISABLE.has(v),

  /** True if instrument represents a balance-sheet asset (not income/expense) */
  isAsset: (v) => FUNDABLE.has(v) || v === Instrument.HOME || v === Instrument.MORTGAGE,

  /** Metadata helpers */
  displayName: (v) => InstrumentMeta.get(v)?.label ?? v,
  emoji:       (v) => InstrumentMeta.get(v)?.emoji ?? '',
  sortOrder:   (v) => InstrumentMeta.get(v)?.sortOrder ?? 99,

  /** All valid instrument keys (useful for <select> options) */
  all: () => [...InstrumentMeta.entries()]
    .sort((a, b) => a[1].sortOrder - b[1].sortOrder)
    .map(([key, meta]) => ({ key, ...meta })),

  /** Priority order for implicit debits/credits (taxes, withholding, etc.) */
  expensablePriority: EXPENSABLE_PRIORITY,
});
