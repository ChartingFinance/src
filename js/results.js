/**
 * results.js
 *
 * Lightweight result types returned by monthly calculations.
 * Cleaned up from model.js — same semantics, modern syntax.
 */

import { Currency } from './currency.js';

export class AssetAppreciationResult {
  constructor(principal = Currency.zero(), growth = Currency.zero(), dividend = Currency.zero(), special = Currency.zero()) {
    this.principal = principal instanceof Currency ? principal.copy() : new Currency(principal);
    this.growth = growth instanceof Currency ? growth.copy() : new Currency(growth);
    this.dividend = dividend instanceof Currency ? dividend.copy() : new Currency(dividend);
    this.special = special instanceof Currency ? special.copy() : new Currency(special);
  }
}

export class MortgageResult {
  constructor(principal = Currency.zero(), interest = Currency.zero(), escrow = Currency.zero()) {
    this.principal = principal instanceof Currency ? principal.copy() : new Currency(principal);
    this.interest  = interest instanceof Currency ? interest.copy() : new Currency(interest);
    this.escrow    = escrow instanceof Currency ? escrow.copy() : new Currency(escrow);
  }

  payment() {
    return new Currency(this.principal.amount + this.interest.amount + this.escrow.amount);
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
  constructor(medicare = Currency.zero(), socialSecurity = Currency.zero(), income = Currency.zero()) {
    this.medicare       = medicare instanceof Currency ? medicare.copy() : new Currency(medicare);
    this.socialSecurity = socialSecurity instanceof Currency ? socialSecurity.copy() : new Currency(socialSecurity);
    this.income         = income instanceof Currency ? income.copy() : new Currency(income);
  }

  fica() {
    return new Currency(this.medicare.amount + this.socialSecurity.amount);
  }

  total() {
    return this.fica().add(this.income);
  }

  flipSigns() {
    this.medicare.flipSign();
    this.socialSecurity.flipSign();
    this.income.flipSign();
  }
}

export class CreditMemo {
  constructor(amount = Currency.zero(), note = '') {
    this.amount = amount instanceof Currency ? amount.copy() : new Currency(amount);
    this.note = note;
  }
}

export class FundTransferResult {
  constructor(fromAssetChange = Currency.zero(), toAssetChange = Currency.zero(), fromMemo = null, toMemo = null) {
    this.fromAssetChange = fromAssetChange instanceof Currency ? fromAssetChange.copy() : new Currency(fromAssetChange);
    this.toAssetChange   = toAssetChange instanceof Currency ? toAssetChange.copy() : new Currency(toAssetChange);
    this.fromMemo = fromMemo;
    this.toMemo = toMemo;
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
