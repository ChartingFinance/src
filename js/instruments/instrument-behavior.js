/**
 * instrument-behavior.js
 *
 * Strategy objects for each instrument family. Each behavior defines:
 *   - relevantMetrics()  — which metrics this instrument actually uses
 *   - applyMonthly(asset) — the month's simulation step
 *
 * An asset's cash flow is not per-behavior: computeCashFlow() below is one rule
 * for every instrument.
 *
 * ModelAsset delegates to its behavior instead of branching on instrument type.
 */

import { Currency } from '../utils/currency.js';
import { Instrument, InstrumentType } from './instrument.js';
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

// Benefits are not wages: they carry no FICA and Social Security is taxed
// at 85% inclusion, so they must reach the FinancialPackage through their
// own fields — never selfIncome/employedIncome.
export class RetirementIncomeResult {
  constructor(socialSecurityIncome = Currency.zero(), pensionIncome = Currency.zero()) {
    this.socialSecurityIncome = socialSecurityIncome instanceof Currency ? socialSecurityIncome.copy() : new Currency(socialSecurityIncome);
    this.pensionIncome        = pensionIncome instanceof Currency ? pensionIncome.copy() : new Currency(pensionIncome);
  }
}

export class ExpenseResult {
  /**
   * @param {Currency} expense           what the household paid, negative
   * @param {Currency} nextExpense       next month's amount
   * @param {Currency} premiumTaxCredit  of `expense`, the advance credit the
   *                                     Treasury paid instead, positive
   */
  constructor(expense = Currency.zero(), nextExpense = Currency.zero(), premiumTaxCredit = Currency.zero()) {
    this.expense     = expense instanceof Currency ? expense.copy() : new Currency(expense);
    this.nextExpense = nextExpense instanceof Currency ? nextExpense.copy() : new Currency(nextExpense);
    this.premiumTaxCredit = premiumTaxCredit instanceof Currency ? premiumTaxCredit.copy() : new Currency(premiumTaxCredit);
  }
}

export class InterestResult {
  constructor(income = Currency.zero()) {
    this.income = income instanceof Currency ? income.copy() : new Currency(income);
  }
}
import { Metric as M } from '../metric.js';
import { EventType } from '../sim-event.js';

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
});

const RetirementIncomeBehavior = Object.freeze({

  relevantMetrics() {
    return [
      ...COMMON_METRICS,
      M.INCOME, M.ORDINARY_INCOME, M.NET_INCOME, M.GROWTH,
      M.SOCIAL_SECURITY_INCOME,
      // Withholding on arrival books here; an unregistered metric would land
      // on NULL_METRIC and disappear.
      M.WITHHELD_INCOME_TAX, M.INCOME_TAX, M.FEDERAL_TAXES, M.TAXES,
    ];
  },

  applyMonthly(asset) {
    asset.ensurePositiveStart();

    const income = asset.finishCurrency.copy();
    asset.addToMetric(M.SOCIAL_SECURITY_INCOME, income);
    // INCOME populated by DAG: SOCIAL_SECURITY_INCOME → ORDINARY_INCOME → INCOME
    asset.netIncomeCurrency.add(income);

    return new RetirementIncomeResult(income, Currency.zero());
  },
});

const PensionBehavior = Object.freeze({

  relevantMetrics() {
    return [
      ...COMMON_METRICS,
      M.INCOME, M.ORDINARY_INCOME, M.NET_INCOME, M.GROWTH,
      M.PENSION_INCOME,
      // See RetirementIncomeBehavior above — a pension carried no tax metrics
      // at all, so withholding booked here would have vanished into NULL_METRIC.
      M.WITHHELD_INCOME_TAX, M.INCOME_TAX, M.FEDERAL_TAXES, M.TAXES,
    ];
  },

  applyMonthly(asset) {
    asset.ensurePositiveStart();

    const income = asset.finishCurrency.copy();
    asset.addToMetric(M.PENSION_INCOME, income);
    // INCOME populated by DAG: PENSION_INCOME → ORDINARY_INCOME → INCOME
    asset.netIncomeCurrency.add(income);

    return new RetirementIncomeResult(Currency.zero(), income);
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

    // Inflation is a measured annual change: twelve steps compound to exactly
    // the stated rate. See ARR.asMonthlyEffective().
    const inflation = new Currency(expense.amount * asset.effectiveAnnualReturnRate.asMonthlyEffective());
    asset.finishCurrency.add(inflation);
    asset.monthlyValueChange.add(inflation);
    
    if (inflation.amount !== 0) {
      asset.recordEvent(EventType.EXPENSE_INFLATION, inflation);
    }

    return new ExpenseResult(expense, asset.finishCurrency.copy());
  },
});

/**
 * A marketplace health plan. Its balance is the month's gross premium, and the
 * advance premium tax credit PremiumCreditEngine set for the month pays part of
 * it, so the household pays the rest.
 *
 * Marketplace plans are priced by calendar year, so the premium does not grow
 * monthly like other expenses: ModelAsset.applyYearly steps it each January.
 */
const HealthInsuranceBehavior = Object.freeze({

  relevantMetrics() {
    return [...COMMON_METRICS, M.HEALTH_PREMIUM, M.PREMIUM_TAX_CREDIT, M.EXPENSE, M.GROWTH];
  },

  applyMonthly(asset) {
    asset.ensureNegativeStart();

    const premium = asset.finishCurrency.copy();
    asset.addToMetric(M.HEALTH_PREMIUM, premium);

    const credit = asset.monthlyAdvanceCredit.copy();
    if (credit.amount > 0) {
      asset.addToMetric(M.PREMIUM_TAX_CREDIT, credit);
      asset.recordEvent(EventType.PREMIUM_TAX_CREDIT, credit,
        { metric: M.PREMIUM_TAX_CREDIT, data: asset.monthlyAdvanceData });
    }
    // EXPENSE populated by DAG: HEALTH_PREMIUM + PREMIUM_TAX_CREDIT → EXPENSE

    return new ExpenseResult(premium.plus(credit), asset.finishCurrency.copy(), credit);
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
    // A mortgage rate is a contract APR: the month's interest is defined as
    // APR/12 of the balance, which is what the lender's amortization uses.
    const rate = asset.annualReturnRate.asMonthlyNominal();
    const n = asset.monthsRemainingDynamic;

    // Mortgage fully amortized — nothing left to compute
    if (n <= 0) {
      return new MortgageResult();
    }

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

    asset.recordEvent(EventType.MORTGAGE_PRINCIPAL, principal.copy().flipSign(), { metric: M.MORTGAGE_PRINCIPAL });
    // Interest is paid from the funding account (its own cash memo there) —
    // on the mortgage itself it's attribution, not a balance change.
    asset.recordEvent(EventType.MORTGAGE_INTEREST, interest, { metric: M.MORTGAGE_INTEREST });

    return new MortgageResult(principal, interest, Currency.zero());
  },
});

const CapitalBehavior = Object.freeze({

  relevantMetrics() {
    return [
      ...COMMON_METRICS,
      M.GROWTH, M.QUALIFIED_DIVIDEND, M.NON_QUALIFIED_DIVIDEND, M.INCOME, M.ORDINARY_INCOME,
      M.SHORT_TERM_CAPITAL_GAIN, M.LONG_TERM_CAPITAL_GAIN, M.CAPITAL_GAIN,
      M.SHORT_TERM_CAPITAL_GAIN_TAX, M.LONG_TERM_CAPITAL_GAIN_TAX, M.ESTIMATED_INCOME_TAX,
      // Federal withholding at the source of a deferred distribution books here.
      // Without it the tax is deducted from the account and never shown on it.
      M.WITHHELD_INCOME_TAX,
      // IRC §1411 books here; unregistered, the NIIT line would land on
      // NULL_METRIC and the tax would appear in no row by name.
      M.NIIT,
      // The premium tax credit's reconciliation is paid from, or credited to,
      // the backstop accounts; cash and brokerage are among them.
      M.PTC_RECONCILIATION,
      M.INCOME_TAX, M.FEDERAL_TAXES, M.TAXES,
      M.CONTRIBUTION, M.PRETAX_CONTRIBUTION, M.POSTTAX_CONTRIBUTION,
      M.TAX_FREE_DISTRIBUTION, M.TAXABLE_DISTRIBUTION,
      M.TRAD_IRA_CONTRIBUTION, M.ROTH_IRA_CONTRIBUTION, M.FOUR_01K_CONTRIBUTION,
      M.TRAD_IRA_DISTRIBUTION, M.ROTH_IRA_DISTRIBUTION, M.FOUR_01K_DISTRIBUTION,
      M.RMD,
    ];
  },

  applyMonthly(asset) {
    // Debt paid off — cap at $0, no reverse interest
    if (InstrumentType.isDebt(asset.instrument) && asset.finishCurrency.amount >= 0) {
      asset.finishCurrency.zero();
      return new AssetAppreciationResult(Currency.zero(), Currency.zero(), Currency.zero(), Currency.zero());
    }

    // No earnings on a negative balance: an overdrawn account is not a loan
    // at its own return rate. Debt is exempt — it reaches here only while still
    // owed, and its "growth" is the interest accruing.
    const earns = InstrumentType.isDebt(asset.instrument) || asset.finishCurrency.amount > 0;

    // Debt accrues at a contract APR (rate/12). Every other capital asset's
    // rate is a measured annual return, so it compounds to exactly that rate.
    const monthlyRate = InstrumentType.isDebt(asset.instrument)
      ? asset.annualReturnRate.asMonthlyNominal()
      : asset.annualReturnRate.asMonthlyEffective();
    const growth = earns
      ? new Currency(asset.finishCurrency.amount * monthlyRate)
      : Currency.zero();

    asset.growthCurrency.add(growth);
    asset.finishCurrency.add(growth);
    asset.monthlyValueChange.add(growth);
    asset.recordEvent(EventType.ASSET_GROWTH, growth, { metric: M.GROWTH });

    let qualifiedDiv = Currency.zero();
    let nonQualifiedDiv = Currency.zero();
    if (asset.annualDividendRate.rate != 0.0 && earns) {
      // A dividend yield is an annual payout as a share of value; a month pays
      // one twelfth of it. Proration, not compounding.
      const totalDiv = asset.finishCurrency.amount * asset.annualDividendRate.asMonthlyNominal();
      const qualifiedRatio = asset.dividendQualifiedRatio;
      qualifiedDiv = new Currency(totalDiv * qualifiedRatio);
      nonQualifiedDiv = new Currency(totalDiv * (1 - qualifiedRatio));

      asset.addToMetric(M.QUALIFIED_DIVIDEND, qualifiedDiv);
      asset.addToMetric(M.NON_QUALIFIED_DIVIDEND, nonQualifiedDiv);

      const totalDivCurrency = qualifiedDiv.plus(nonQualifiedDiv);
      asset.finishCurrency.add(totalDivCurrency);
      asset.monthlyValueChange.add(totalDivCurrency);
      // Reinvested dividends create new basis in taxable accounts — they are
      // taxed as dividend income in the year received, so without this the
      // same dollars would be taxed a second time as capital gain on sale.
      if (InstrumentType.isTaxableAccount(asset.instrument)) {
        asset.finishBasisCurrency.add(totalDivCurrency);
      }
      if (qualifiedDiv.amount !== 0) asset.recordEvent(EventType.DIVIDEND, qualifiedDiv, { metric: M.QUALIFIED_DIVIDEND, data: { qualified: true } });
      if (nonQualifiedDiv.amount !== 0) asset.recordEvent(EventType.DIVIDEND, nonQualifiedDiv, { metric: M.NON_QUALIFIED_DIVIDEND, data: { qualified: false } });
    }

    return new AssetAppreciationResult(asset.finishCurrency.copy(), growth, qualifiedDiv, nonQualifiedDiv);
  },
});

const RealEstateBehavior = Object.freeze({

  relevantMetrics() {
    return [
      ...COMMON_METRICS,
      M.GROWTH, M.INCOME, M.ORDINARY_INCOME, M.EXPENSE,
      M.SHORT_TERM_CAPITAL_GAIN, M.LONG_TERM_CAPITAL_GAIN, M.CAPITAL_GAIN,
      M.SHORT_TERM_CAPITAL_GAIN_TAX, M.LONG_TERM_CAPITAL_GAIN_TAX,
      // A home sale's gain is net investment income above the §121 exclusion.
      M.NIIT,
      M.INCOME_TAX, M.FEDERAL_TAXES, M.SALT_TAXES, M.TAXES,
      M.PROPERTY_TAX, M.MAINTENANCE, M.INSURANCE,
    ];
  },

  applyMonthly(asset) {

    // Real estate appreciates like capital but typically has no dividends
    const growth = new Currency(asset.finishCurrency.amount * asset.annualReturnRate.asMonthlyEffective());

    asset.growthCurrency.add(growth);
    asset.finishCurrency.add(growth);
    asset.monthlyValueChange.add(growth);
    asset.recordEvent(EventType.ASSET_GROWTH, growth, { metric: M.GROWTH });

    // Property tax and maintenance are annual charges, prorated monthly.
    const tax = new Currency(asset.finishCurrency.amount * asset.annualTaxRate.asMonthlyNominal());
    tax.flipSign(); // taxes are negative

    // Property tax / maintenance / insurance are paid from funding accounts
    // (their own cash memos there) — on the home they're attributed costs,
    // not balance changes.
    asset.addToMetric(M.PROPERTY_TAX, tax);      // leaf → SALT_TAXES → TAXES
    asset.recordEvent(EventType.PROPERTY_TAX, tax, { metric: M.PROPERTY_TAX });

    // Maintenance: percentage of home value (e.g. 1% annual rule of thumb)
    if (asset.annualMaintenanceRate.rate !== 0) {
      const maint = new Currency(asset.finishCurrency.amount * asset.annualMaintenanceRate.asMonthlyNominal());
      maint.flipSign();
      asset.addToMetric(M.MAINTENANCE, maint);   // leaf → EXPENSE
      asset.recordEvent(EventType.MAINTENANCE, maint, { metric: M.MAINTENANCE });
    }

    // Insurance: fixed annual cost spread monthly
    if (asset.annualInsuranceCost.amount !== 0) {
      const ins = new Currency(asset.annualInsuranceCost.amount / -12);
      asset.addToMetric(M.INSURANCE, ins);        // leaf → EXPENSE
      asset.recordEvent(EventType.INSURANCE, ins, { metric: M.INSURANCE });
    }

    return new AssetAppreciationResult(asset.finishCurrency.copy(), growth, Currency.zero(), Currency.zero(), tax);

  },
});

const IncomeAccountBehavior = Object.freeze({

  relevantMetrics() {
    return [
      ...COMMON_METRICS,
      M.INTEREST_INCOME, M.ORDINARY_INCOME, M.INCOME, M.NET_INCOME, M.GROWTH,
      // Interest is net investment income, and a bank is the usual NIIT
      // backstop and spillover payer — see the note in CapitalBehavior. The
      // same goes for the premium tax credit's reconciliation.
      M.NIIT, M.PTC_RECONCILIATION,
      M.ESTIMATED_INCOME_TAX, M.INCOME_TAX, M.FEDERAL_TAXES, M.TAXES,
    ];
  },

  applyMonthly(asset) {
    asset.ensurePositiveStart();
    // Interest never accrues on a deficit — see CapitalBehavior. A savings
    // account drawn below zero is not a loan against itself.
    const income = asset.finishCurrency.amount > 0
      ? new Currency(asset.finishCurrency.amount * asset.annualReturnRate.asMonthlyEffective())
      : Currency.zero();

    asset.addToMetric(M.INTEREST_INCOME, income);
    // INCOME populated by DAG: INTEREST_INCOME → ORDINARY_INCOME → INCOME
    asset.netIncomeCurrency.add(income);
    asset.finishCurrency.add(income);
    asset.monthlyValueChange.add(income);

    asset.recordEvent(EventType.INTEREST_INCOME, income, { metric: M.INTEREST_INCOME });

    return new InterestResult(income);
  },
});

// ── Cash flow ───────────────────────────────────────────────────────────

/**
 * Income that came into the household from outside its own accounts. A
 * distribution, a Roth withdrawal or a realized gain is not here: that is the
 * household drawing on what it already had, which is not cash flow.
 */
export const RECEIVED_INCOME_METRICS = Object.freeze([
  M.EMPLOYED_INCOME, M.SELF_INCOME, M.SOCIAL_SECURITY_INCOME, M.PENSION_INCOME,
  M.INTEREST_INCOME, M.QUALIFIED_DIVIDEND, M.NON_QUALIFIED_DIVIDEND,
]);

/**
 * An asset's cash flow for the month: income received, less expenses
 * (living, mortgage interest, maintenance, insurance), mortgage principal and
 * every tax booked on it. One rule for every instrument, the same one
 * FinancialPackage.cashFlow() applies to the household, so the accounts add
 * up to the Reports' Cash Flow and to the Month & Year Details section.
 *
 * Read from the month's metric amounts, which the DAG rolls up as they are
 * written, so it must run before the month's snapshot zeroes them.
 */
export function computeCashFlow(asset) {
  let cf = 0;
  for (const metric of RECEIVED_INCOME_METRICS) cf += asset.getMetricAmount(metric);
  // Expenses, principal and taxes are stored negative, so they simply add.
  cf += asset.getMetricAmount(M.EXPENSE);
  cf += asset.getMetricAmount(M.MORTGAGE_PRINCIPAL);
  cf += asset.getMetricAmount(M.TAXES);
  return new Currency(cf);
}

// ── Registry ────────────────────────────────────────────────────────────

const BEHAVIOR_MAP = new Map([
  [Instrument.WORKING_INCOME,    WorkingIncomeBehavior],
  [Instrument.RETIREMENT_INCOME, RetirementIncomeBehavior],
  [Instrument.PENSION,           PensionBehavior],
  [Instrument.MONTHLY_EXPENSE, ExpenseBehavior],
  [Instrument.HEALTH_INSURANCE, HealthInsuranceBehavior],
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
