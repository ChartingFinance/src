/**
 * instrument-behavior.js
 *
 * Strategy objects for each instrument family. Each behavior defines:
 *   - relevantMetrics()  — which metrics this instrument actually uses
 *   - applyMonthly(asset) — monthly simulation logic (lifted from ModelAsset)
 *   - computeCashFlow(asset) — per-asset cash flow calculation (lifted from Portfolio)
 *
 * ModelAsset delegates to its behavior instead of branching on instrument type.
 */

import { Currency } from '../utils/currency.js';
import { Instrument } from './instrument.js';
import {
  IncomeResult, ExpenseResult, MortgageResult,
  AssetAppreciationResult, InterestResult,
} from '../results.js';

// ── Metric keys (import-free; matches Metric enum in model-asset.js) ────

const M = {
  VALUE:                       'value',
  GROWTH:                      'growth',
  DIVIDEND:                    'dividend',
  INTEREST_INCOME:             'interestIncome',
  ORDINARY_INCOME:             'ordinaryIncome',
  WORKING_INCOME:              'workingIncome',
  INCOME:                      'income',
  WITHHELD_FICA_TAX:           'withheldFicaTax',
  ESTIMATED_FICA_TAX:          'estimatedFicaTax',
  WITHHELD_INCOME_TAX:         'withheldIncomeTax',
  ESTIMATED_INCOME_TAX:        'estimatedIncomeTax',
  ESTIMATED_TAX:               'estimatedTax',
  INCOME_TAX:                  'incomeTax',
  NET_INCOME:                  'netIncome',
  EXPENSE:                     'expense',
  CASH_FLOW:                   'cashFlow',
  CASH_FLOW_ACCUMULATED:       'cashFlowAccumulated',
  SHORT_TERM_CAPITAL_GAIN:     'shortTermCapitalGain',
  LONG_TERM_CAPITAL_GAIN:      'longTermCapitalGain',
  CAPITAL_GAIN:                'capitalGain',
  RMD:                         'rmd',
  SOCIAL_SECURITY:             'socialSecurity',
  MEDICARE:                    'medicare',
  MORTGAGE_PAYMENT:            'mortgagePayment',
  MORTGAGE_INTEREST:           'mortgageInterest',
  MORTGAGE_PRINCIPAL:          'mortgagePrincipal',
  PROPERTY_TAX:                'propertyTax',
  MORTGAGE_ESCROW:             'mortgageEscrow',
  TAXABLE_CONTRIBUTION:        'taxableContribution',
  TRAD_IRA_CONTRIBUTION:       'tradIRAContribution',
  ROTH_IRA_CONTRIBUTION:       'rothIRAContribution',
  FOUR_01K_CONTRIBUTION:       'four01KContribution',
  TRAD_IRA_DISTRIBUTION:       'tradIRADistribution',
  ROTH_IRA_DISTRIBUTION:       'rothIRADistribution',
  FOUR_01K_DISTRIBUTION:       'four01KDistribution',
  TAXABLE_DISTRIBUTION:        'taxableDistribution',
  SHORT_TERM_CAPITAL_GAIN_TAX: 'shortTermCapitalGainTax',
  LONG_TERM_CAPITAL_GAIN_TAX:  'longTermCapitalGainTax',
  CAPITAL_GAIN_TAX:            'capitalGainTax',
  CREDIT:                      'credit',
};

// Every instrument gets these
const COMMON_METRICS = [M.VALUE, M.CASH_FLOW, M.CASH_FLOW_ACCUMULATED, M.CREDIT];

// ── Behaviors ───────────────────────────────────────────────────────────

const WorkingIncomeBehavior = Object.freeze({

  relevantMetrics() {
    return [
      ...COMMON_METRICS,
      M.INCOME, M.WORKING_INCOME, M.ORDINARY_INCOME, M.NET_INCOME, M.GROWTH,
      M.SOCIAL_SECURITY, M.MEDICARE,
      M.WITHHELD_FICA_TAX, M.ESTIMATED_FICA_TAX,
      M.WITHHELD_INCOME_TAX, M.ESTIMATED_INCOME_TAX, M.ESTIMATED_TAX, M.INCOME_TAX,
      M.FOUR_01K_CONTRIBUTION, M.TRAD_IRA_CONTRIBUTION, M.ROTH_IRA_CONTRIBUTION,
    ];
  },

  applyMonthly(asset) {
    asset.ensurePositiveStart();

    const income = asset.finishCurrency.copy();
    if (asset.isSelfEmployed) {
      asset.workingIncomeCurrency.add(income);
    } else {
      asset.ordinaryIncomeCurrency.add(income);
    }

    asset.incomeCurrency.add(income);
    asset.netIncomeCurrency.add(income);

    return asset.isSelfEmployed
      ? new IncomeResult(income, Currency.zero())
      : new IncomeResult(Currency.zero(), income);
  },

  computeCashFlow(asset) {
    const cf = asset.incomeCurrency.copy();
    cf.add(asset.socialSecurityCurrency);
    cf.add(asset.medicareCurrency);
    cf.add(asset.estimatedIncomeTaxCurrency);
    cf.add(asset.four01KContributionCurrency);
    cf.add(asset.tradIRAContributionCurrency);
    cf.add(asset.rothIRAContributionCurrency);
    return cf;
  },
});

const RetirementIncomeBehavior = Object.freeze({

  relevantMetrics() {
    return [
      ...COMMON_METRICS,
      M.INCOME, M.ORDINARY_INCOME, M.NET_INCOME, M.GROWTH,
    ];
  },

  applyMonthly(asset) {
    asset.ensurePositiveStart();

    const income = asset.finishCurrency.copy();
    asset.ordinaryIncomeCurrency.add(income);
    asset.incomeCurrency.add(income);
    asset.netIncomeCurrency.add(income);

    return new IncomeResult(Currency.zero(), income);
  },

  computeCashFlow(asset) {
    return asset.incomeCurrency.copy();
  },
});

const ExpenseBehavior = Object.freeze({

  relevantMetrics() {
    return [...COMMON_METRICS, M.EXPENSE, M.GROWTH];
  },

  applyMonthly(asset) {
    asset.ensureNegativeStart();

    const expense = asset.finishCurrency.copy();
    asset.expenseCurrency.add(expense);

    const inflation = new Currency(expense.amount * asset.annualReturnRate.asMonthly());
    asset.finishCurrency.add(inflation);
    asset.monthlyValueChange.add(inflation);
    
    if (inflation.amount !== 0) {
      asset.addCreditMemo(inflation, 'Expense inflation');
    }

    return new ExpenseResult(expense, asset.finishCurrency.copy());
  },

  computeCashFlow(asset) {
    return asset.expenseCurrency.copy();
  },
});

const MortgageBehavior = Object.freeze({

  relevantMetrics() {
    return [
      ...COMMON_METRICS,
      M.MORTGAGE_PAYMENT, M.MORTGAGE_INTEREST, M.MORTGAGE_PRINCIPAL,
      M.MORTGAGE_ESCROW, M.GROWTH,
    ];
  },

  applyMonthly(asset) {
    asset.ensureNegativeStart();
    const rate = asset.annualReturnRate.asMonthly();
    const n = asset.monthsRemainingDynamic;

    const payment = (asset.finishCurrency.amount * rate * Math.pow(1 + rate, n))
                  / (Math.pow(1 + rate, n) - 1);

    const paymentCurrency = new Currency(payment);
    const interest = new Currency(asset.finishCurrency.amount * rate);
    const principal = new Currency(payment - interest.amount);

    asset.mortgagePaymentCurrency.add(paymentCurrency);
    asset.mortgageInterestCurrency.add(interest);
    asset.mortgagePrincipalCurrency.add(principal);

    asset.monthsRemainingDynamic--;
    asset.finishCurrency.subtract(principal);    
    asset.growthCurrency.subtract(principal);

    // and don't forget our monthlyValueChange tracker
    asset.monthlyValueChange.subtract(principal);

    asset.addCreditMemo(principal.copy().flipSign(), 'Mortgage Principal');
    asset.addCreditMemo(interest, 'Mortgage Interest');

    return new MortgageResult(principal, interest, Currency.zero());
  },

  computeCashFlow(asset) {
    
    let cf = asset.mortgageInterestCurrency.copy();
    cf.add(asset.mortgagePrincipalCurrency);
    return cf;

  },
});

const CapitalBehavior = Object.freeze({

  relevantMetrics() {
    return [
      ...COMMON_METRICS,
      M.GROWTH, M.DIVIDEND,
      M.SHORT_TERM_CAPITAL_GAIN, M.LONG_TERM_CAPITAL_GAIN, M.CAPITAL_GAIN,
      M.SHORT_TERM_CAPITAL_GAIN_TAX, M.LONG_TERM_CAPITAL_GAIN_TAX, M.CAPITAL_GAIN_TAX,
      M.TAXABLE_CONTRIBUTION, M.TAXABLE_DISTRIBUTION,
      M.TRAD_IRA_CONTRIBUTION, M.ROTH_IRA_CONTRIBUTION, M.FOUR_01K_CONTRIBUTION,
      M.TRAD_IRA_DISTRIBUTION, M.ROTH_IRA_DISTRIBUTION, M.FOUR_01K_DISTRIBUTION,
      M.RMD,
    ];
  },

  applyMonthly(asset) {
    const growth = new Currency(asset.finishCurrency.amount * asset.annualReturnRate.asMonthly());

    asset.growthCurrency.add(growth);
    asset.finishCurrency.add(growth);
    asset.monthlyValueChange.add(growth);
    asset.addCreditMemo(growth, 'Asset growth');

    let dividend = Currency.zero();
    if (asset.annualDividendRate.rate != 0.0) {
      dividend = new Currency(asset.finishCurrency.amount * asset.annualDividendRate.asMonthly());

      asset.dividendCurrency.add(dividend);
      asset.finishCurrency.add(dividend);
      asset.monthlyValueChange.add(dividend);
      asset.addCreditMemo(dividend, 'Dividend income');
    }

    return new AssetAppreciationResult(asset.finishCurrency.copy(), growth, dividend);
  },

  computeCashFlow(asset) {

    let cf = asset.dividendCurrency.copy();
    cf.add(asset.shortTermCapitalGainCurrency);
    cf.add(asset.longTermCapitalGainCurrency);
    cf.add(asset.tradIRADistributionCurrency);
    cf.add(asset.four01KDistributionCurrency);
    cf.add(asset.rothIRADistributionCurrency);
    cf.add(asset.taxableDistributionCurrency);
    return cf;

  },
});

const RealEstateBehavior = Object.freeze({

  relevantMetrics() {
    return [
      ...COMMON_METRICS,
      M.GROWTH,
      M.SHORT_TERM_CAPITAL_GAIN, M.LONG_TERM_CAPITAL_GAIN, M.CAPITAL_GAIN,
      M.SHORT_TERM_CAPITAL_GAIN_TAX, M.LONG_TERM_CAPITAL_GAIN_TAX, M.CAPITAL_GAIN_TAX,
      M.PROPERTY_TAX, M.MORTGAGE_ESCROW,
    ];
  },

  applyMonthly(asset) {

    // Real estate appreciates like capital but typically has no dividends
    const growth = new Currency(asset.finishCurrency.amount * asset.annualReturnRate.asMonthly());

    asset.growthCurrency.add(growth);
    asset.finishCurrency.add(growth);
    asset.monthlyValueChange.add(growth);
    asset.addCreditMemo(growth, 'Asset growth');

    const tax = new Currency(asset.finishCurrency.amount * asset.annualTaxRate.asMonthly());
    tax.flipSign(); // taxes are negative

    asset.propertyTaxCurrency.add(tax);
    asset.addCreditMemo(tax, 'Property tax');

    return new AssetAppreciationResult(asset.finishCurrency.copy(), growth, Currency.zero(), tax);

  },

  computeCashFlow(asset) {
    return asset.propertyTaxCurrency.copy();
  },
});

const IncomeAccountBehavior = Object.freeze({

  relevantMetrics() {
    return [
      ...COMMON_METRICS,
      M.INTEREST_INCOME, M.INCOME, M.NET_INCOME, M.GROWTH,
    ];
  },

  applyMonthly(asset) {
    asset.ensurePositiveStart();
    const income = new Currency(asset.finishCurrency.amount * asset.annualReturnRate.asMonthly());

    asset.interestIncomeCurrency.add(income);
    asset.incomeCurrency.add(income);
    asset.netIncomeCurrency.add(income);
    asset.finishCurrency.add(income);
    asset.monthlyValueChange.add(income);

    asset.addCreditMemo(income, 'Interest income');

    return new InterestResult(income);
  },

  computeCashFlow(asset) {
    return asset.interestIncomeCurrency.copy();
  },
});

// ── Registry ────────────────────────────────────────────────────────────

const BEHAVIOR_MAP = new Map([
  [Instrument.WORKING_INCOME,    WorkingIncomeBehavior],
  [Instrument.RETIREMENT_INCOME, RetirementIncomeBehavior],
  [Instrument.MONTHLY_EXPENSE, ExpenseBehavior],
  [Instrument.MORTGAGE,        MortgageBehavior],
  [Instrument.TAXABLE_EQUITY,  CapitalBehavior],
  [Instrument.IRA,             CapitalBehavior],
  [Instrument.FOUR_01K,        CapitalBehavior],
  [Instrument.ROTH_IRA,        CapitalBehavior],
  [Instrument.CASH,            CapitalBehavior],
  [Instrument.DEBT,            CapitalBehavior],
  [Instrument.REAL_ESTATE,     RealEstateBehavior],
  [Instrument.US_BOND,         IncomeAccountBehavior],
  [Instrument.CORP_BOND,       IncomeAccountBehavior],
  [Instrument.BANK,            IncomeAccountBehavior],
]);

export function getBehavior(instrument) {
  const b = BEHAVIOR_MAP.get(instrument);
  if (!b) throw new Error(`No behavior registered for instrument: "${instrument}"`);
  return b;
}
