/**
 * results.js
 *
 * Lightweight result types returned by monthly calculations.
 * Cleaned up from model.js — same semantics, modern syntax.
 */

import { Currency } from './utils/currency.js';

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

export class WithholdingResult {
  constructor(medicareTax = Currency.zero(), socialSecurityTax = Currency.zero(), income = Currency.zero()) {
    this.medicareTax       = medicareTax instanceof Currency ? medicareTax.copy() : new Currency(medicareTax);
    this.socialSecurityTax = socialSecurityTax instanceof Currency ? socialSecurityTax.copy() : new Currency(socialSecurityTax);
    this.income            = income instanceof Currency ? income.copy() : new Currency(income);
  }

  fica() {
    return new Currency(this.medicareTax.amount + this.socialSecurityTax.amount);
  }

  total() {
    return this.fica().add(this.income);
  }

  flipSigns() {
    this.medicareTax.flipSign();
    this.socialSecurityTax.flipSign();
    this.income.flipSign();
  }
}

// tradContribution is for traditionalIRAContribution
export class IRAContributionResult {
  constructor(totalContribution = Currency.zero(), tradContribution = Currency.zero(), rothContribution = Currency.zero()) {
    this.totalContribution   = totalContribution instanceof Currency ? totalContribution.copy() : new Currency(totalContribution);
    this.tradContribution    = tradContribution instanceof Currency ? tradContribution.copy() : new Currency(tradContribution);
    this.rothContribution    = rothContribution instanceof Currency ? rothContribution.copy() : new Currency(rothContribution);
  }
}

export class CreditMemo {
  constructor(amount = Currency.zero(), note = '', dateInt = null) {
    this.amount = amount instanceof Currency ? amount.copy() : new Currency(amount);
    this.note = note;
    this.dateInt = dateInt;
  }
}

export class FundTransferResult {
  constructor(fromAssetChange = Currency.zero(), toAssetChange = Currency.zero(), fromMemo = null, toMemo = null, realizedGain = Currency.zero()) {
    this.fromAssetChange = fromAssetChange instanceof Currency ? fromAssetChange.copy() : new Currency(fromAssetChange);
    this.toAssetChange   = toAssetChange instanceof Currency ? toAssetChange.copy() : new Currency(toAssetChange);
    this.fromMemo = fromMemo;
    this.toMemo = toMemo;
    this.realizedGain = realizedGain instanceof Currency ? realizedGain.copy() : new Currency(realizedGain);
  }
}

export class CapitalGainsResult {
  constructor(shortTerm = Currency.zero(), longTerm = Currency.zero()) {
    this.shortTerm = shortTerm instanceof Currency ? shortTerm.copy() : new Currency(shortTerm);
    this.longTerm  = longTerm instanceof Currency ? longTerm.copy() : new Currency(longTerm);
  }

  total() {
    return this.shortTerm.plus(this.longTerm);
  }

  flipSigns() {
    this.shortTerm.flipSign();
    this.longTerm.flipSign();
  }
}
