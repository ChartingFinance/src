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
// ── Result Types ─────────────────────────────────────────────────────

export class AssetAppreciationResult {
  constructor(principal = Currency.zero(), growth = Currency.zero(), qualifiedDividend = Currency.zero(), nonQualifiedDividend = Currency.zero(), tax = Currency.zero()) {
    this.principal = principal instanceof Currency ? principal.copy() : new Currency(principal);
    this.growth = growth instanceof Currency ? growth.copy() : new Currency(growth);
    this.qualifiedDividend = qualifiedDividend instanceof Currency ? qualifiedDividend.copy() : new Currency(qualifiedDividend);
    this.nonQualifiedDividend = nonQualifiedDividend instanceof Currency ? nonQualifiedDividend.copy() : new Currency(nonQualifiedDividend);
    this.tax = tax instanceof Currency ? tax.copy() : new Currency(tax);
  }
}

export class MortgageResult {
  constructor(principal = Currency.zero(), interest = Currency.zero()) {
    this.principal = principal instanceof Currency ? principal.copy() : new Currency(principal);
    this.interest  = interest instanceof Currency ? interest.copy() : new Currency(interest);
  }

  payment() {
    return new Currency(this.principal.amount + this.interest.amount);
  }
}

export class IncomeResult {
  constructor(selfIncome = Currency.zero(), employedIncome = Currency.zero()) {
    this.selfIncome    = selfIncome instanceof Currency ? selfIncome.copy() : new Currency(selfIncome);
    this.employedIncome = employedIncome instanceof Currency ? employedIncome.copy() : new Currency(employedIncome);
  }
}

export class ExpenseResult {
  constructor(expense = Currency.zero(), nextExpense = Currency.zero()) {
    this.expense     = expense instanceof Currency ? expense.copy() : new Currency(expense);
    this.nextExpense = nextExpense instanceof Currency ? nextExpense.copy() : new Currency(nextExpense);
  }
}

export class InterestResult {
  constructor(income = Currency.zero()) {
    this.income = income instanceof Currency ? income.copy() : new Currency(income);
  }
}
import { Metric as M } from '../metric.js';

// Every instrument gets these
const COMMON_METRICS = [M.VALUE, M.CASH_FLOW, M.CASH_FLOW_ACCUMULATED, M.CREDIT];

// ── Behaviors ───────────────────────────────────────────────────────────

const WorkingIncomeBehavior = Object.freeze({

  relevantMetrics() {
    return [
      ...COMMON_METRICS,
      M.INCOME, M.EMPLOYED_INCOME, M.SELF_INCOME, M.ORDINARY_INCOME, M.NET_INCOME, M.GROWTH,
      M.SOCIAL_SECURITY_TAX, M.MEDICARE_TAX,
      M.WITHHELD_FICA_TAX,
      M.WITHHELD_INCOME_TAX, M.ESTIMATED_INCOME_TAX, M.INCOME_TAX,
      M.FEDERAL_TAXES, M.TAXES,
    ];
  },

  applyMonthly(asset) {
    asset.ensurePositiveStart();

    const income = asset.finishCurrency.copy();
    if (asset.isSelfEmployed) {
      asset.addToMetric(M.SELF_INCOME, income);
    } else {
      asset.addToMetric(M.EMPLOYED_INCOME, income);
    }
    // INCOME populated by DAG: EMPLOYED_INCOME/SELF_INCOME → ORDINARY_INCOME → INCOME
    asset.netIncomeCurrency.add(income);

    return asset.isSelfEmployed
      ? new IncomeResult(income, Currency.zero())
      : new IncomeResult(Currency.zero(), income);
  },

  computeCashFlow(asset) {
    const cf = asset.incomeCurrency.copy();
    cf.add(asset.socialSecurityTaxCurrency);      // stored negative (after flipSigns)
    cf.add(asset.medicareTaxCurrency);             // stored negative (after flipSigns)
    cf.subtract(asset.withheldIncomeTaxCurrency);  // stored positive — subtract to reduce CF
    cf.subtract(asset.estimatedIncomeTaxCurrency); // stored positive for self-employed
    // Contributions are internal transfers (salary → 401K), not household cash flow
    return cf;
  },
});

const RetirementIncomeBehavior = Object.freeze({

  relevantMetrics() {
    return [
      ...COMMON_METRICS,
      M.INCOME, M.ORDINARY_INCOME, M.NET_INCOME, M.GROWTH,
      M.SOCIAL_SECURITY_INCOME,
    ];
  },

  applyMonthly(asset) {
    asset.ensurePositiveStart();

    const income = asset.finishCurrency.copy();
    asset.addToMetric(M.SOCIAL_SECURITY_INCOME, income);
    // INCOME populated by DAG: SOCIAL_SECURITY_INCOME → ORDINARY_INCOME → INCOME
    asset.netIncomeCurrency.add(income);

    return new IncomeResult(Currency.zero(), income);
  },

  computeCashFlow(asset) {
    return asset.incomeCurrency.copy();
  },
});

const ExpenseBehavior = Object.freeze({

  relevantMetrics() {
    return [...COMMON_METRICS, M.LIVING_EXPENSE, M.EXPENSE, M.GROWTH];
  },

  applyMonthly(asset) {
    asset.ensureNegativeStart();

    const expense = asset.finishCurrency.copy();
    asset.addToMetric(M.LIVING_EXPENSE, expense);
    // EXPENSE populated by DAG: LIVING_EXPENSE → EXPENSE

    const inflation = new Currency(expense.amount * asset.effectiveAnnualReturnRate.asMonthly());
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
      M.INTEREST_EXPENSE, M.EXPENSE, M.GROWTH,
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

    asset.mortgagePaymentCurrency.add(paymentCurrency);   // informational — no DAG
    asset.addToMetric(M.MORTGAGE_INTEREST, interest);     // leaf → INTEREST_EXPENSE → EXPENSE
    asset.mortgagePrincipalCurrency.add(principal);        // informational — no DAG

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
      M.GROWTH, M.QUALIFIED_DIVIDEND, M.NON_QUALIFIED_DIVIDEND, M.INCOME, M.ORDINARY_INCOME,
      M.SHORT_TERM_CAPITAL_GAIN, M.LONG_TERM_CAPITAL_GAIN, M.CAPITAL_GAIN,
      M.SHORT_TERM_CAPITAL_GAIN_TAX, M.LONG_TERM_CAPITAL_GAIN_TAX, M.ESTIMATED_INCOME_TAX,
      M.INCOME_TAX, M.FEDERAL_TAXES, M.TAXES,
      M.CONTRIBUTION, M.PRETAX_CONTRIBUTION, M.POSTTAX_CONTRIBUTION,
      M.TAX_FREE_DISTRIBUTION, M.TAXABLE_DISTRIBUTION,
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

    let qualifiedDiv = Currency.zero();
    let nonQualifiedDiv = Currency.zero();
    if (asset.annualDividendRate.rate != 0.0) {
      const totalDiv = asset.finishCurrency.amount * asset.annualDividendRate.asMonthly();
      const qualifiedRatio = asset.dividendQualifiedRatio;
      qualifiedDiv = new Currency(totalDiv * qualifiedRatio);
      nonQualifiedDiv = new Currency(totalDiv * (1 - qualifiedRatio));

      asset.addToMetric(M.QUALIFIED_DIVIDEND, qualifiedDiv);
      asset.addToMetric(M.NON_QUALIFIED_DIVIDEND, nonQualifiedDiv);

      const totalDivCurrency = qualifiedDiv.plus(nonQualifiedDiv);
      asset.finishCurrency.add(totalDivCurrency);
      asset.monthlyValueChange.add(totalDivCurrency);
      if (qualifiedDiv.amount !== 0) asset.addCreditMemo(qualifiedDiv, 'Qualified dividend');
      if (nonQualifiedDiv.amount !== 0) asset.addCreditMemo(nonQualifiedDiv, 'Non-qualified dividend');
    }

    return new AssetAppreciationResult(asset.finishCurrency.copy(), growth, qualifiedDiv, nonQualifiedDiv);
  },

  computeCashFlow(asset) {
    // Dividends are household income. Gains and distributions are
    // portfolio restructuring (asset drawdown), not household cash flow.
    let cf = asset.qualifiedDividendCurrency.copy();
    cf.add(asset.nonQualifiedDividendCurrency);
    // Estimated income tax from monthly true-up (assigned to liquid assets)
    cf.add(asset.estimatedIncomeTaxCurrency);
    return cf;
  },
});

const RealEstateBehavior = Object.freeze({

  relevantMetrics() {
    return [
      ...COMMON_METRICS,
      M.GROWTH, M.INCOME, M.ORDINARY_INCOME, M.EXPENSE,
      M.SHORT_TERM_CAPITAL_GAIN, M.LONG_TERM_CAPITAL_GAIN, M.CAPITAL_GAIN,
      M.SHORT_TERM_CAPITAL_GAIN_TAX, M.LONG_TERM_CAPITAL_GAIN_TAX,
      M.INCOME_TAX, M.FEDERAL_TAXES, M.SALT_TAXES, M.TAXES,
      M.PROPERTY_TAX, M.MAINTENANCE, M.INSURANCE,
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

    asset.addToMetric(M.PROPERTY_TAX, tax);      // leaf → SALT_TAXES → TAXES
    asset.addCreditMemo(tax, 'Property tax');

    // Maintenance: percentage of home value (e.g. 1% annual rule of thumb)
    if (asset.annualMaintenanceRate.rate !== 0) {
      const maint = new Currency(asset.finishCurrency.amount * asset.annualMaintenanceRate.asMonthly());
      maint.flipSign();
      asset.addToMetric(M.MAINTENANCE, maint);   // leaf → EXPENSE
      asset.addCreditMemo(maint, 'Maintenance');
    }

    // Insurance: fixed annual cost spread monthly
    if (asset.annualInsuranceCost.amount !== 0) {
      const ins = new Currency(asset.annualInsuranceCost.amount / -12);
      asset.addToMetric(M.INSURANCE, ins);        // leaf → EXPENSE
      asset.addCreditMemo(ins, 'Insurance');
    }

    return new AssetAppreciationResult(asset.finishCurrency.copy(), growth, Currency.zero(), Currency.zero(), tax);

  },

  computeCashFlow(asset) {
    const cf = asset.propertyTaxCurrency.copy();
    cf.add(asset.maintenanceCurrency);
    cf.add(asset.insuranceCurrency);
    return cf;
  },
});

const IncomeAccountBehavior = Object.freeze({

  relevantMetrics() {
    return [
      ...COMMON_METRICS,
      M.INTEREST_INCOME, M.ORDINARY_INCOME, M.INCOME, M.NET_INCOME, M.GROWTH,
      M.ESTIMATED_INCOME_TAX, M.INCOME_TAX, M.FEDERAL_TAXES, M.TAXES,
    ];
  },

  applyMonthly(asset) {
    asset.ensurePositiveStart();
    const income = new Currency(asset.finishCurrency.amount * asset.annualReturnRate.asMonthly());

    asset.addToMetric(M.INTEREST_INCOME, income);
    // INCOME populated by DAG: INTEREST_INCOME → ORDINARY_INCOME → INCOME
    asset.netIncomeCurrency.add(income);
    asset.finishCurrency.add(income);
    asset.monthlyValueChange.add(income);

    asset.addCreditMemo(income, 'Interest income');

    return new InterestResult(income);
  },

  computeCashFlow(asset) {
    let cf = asset.interestIncomeCurrency.copy();
    // Estimated income tax from monthly true-up (assigned to liquid assets)
    cf.add(asset.estimatedIncomeTaxCurrency);
    return cf;
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
