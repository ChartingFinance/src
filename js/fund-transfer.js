/**
 * fund-transfer.js
 *
 * Represents a percentage-based transfer of funds from one asset to another.
 * Supports recurring transfers (monthly/quarterly/half-yearly/yearly) and/or
 * a separate on-close transfer when the source asset reaches its finish date.
 */

import { Currency } from './utils/currency.js';
import { Instrument, InstrumentType } from './instruments/instrument.js';
// ── Result Type ──────────────────────────────────────────────────────

export class FundTransferResult {
  constructor(fromAssetChange = Currency.zero(), toAssetChange = Currency.zero(), fromMemo = null, toMemo = null, realizedGain = Currency.zero()) {
    this.fromAssetChange = fromAssetChange instanceof Currency ? fromAssetChange.copy() : new Currency(fromAssetChange);
    this.toAssetChange   = toAssetChange instanceof Currency ? toAssetChange.copy() : new Currency(toAssetChange);
    this.fromMemo = fromMemo;
    this.toMemo = toMemo;
    this.realizedGain = realizedGain instanceof Currency ? realizedGain.copy() : new Currency(realizedGain);
  }
}
import { Metric } from './metric.js';

export const Frequency = Object.freeze({
  NONE:        'none',
  MONTHLY:     'monthly',
  QUARTERLY:   'quarterly',
  HALF_YEARLY: 'half-yearly',
  YEARLY:      'yearly',
});

/**
 * This is to handle one-sided debits or credits. For example, a tax payment. Here we simply
 * debit the toModel without crediting the fromModel since there is not credit for a tax payment--
 * other than continuing to possess the asset.
 */
export class FundTransferOneSided {

  constructor(fundTransfer, amount) {
    this.fromModel = fundTransfer?.fromModel ?? null;
    this.toModel = fundTransfer?.toModel ?? null;

    if (!amount) debugger;

    this.amount = amount;
    
    if (fundTransfer) {
      this.amount = new Currency(amount.amount * (fundTransfer.monthlyMoveValue / 100));
    }
  }

}

export class FundTransfer {
  /**
   * @param {string} toDisplayName     Target asset's familiar name
   * @param {string} frequency         Recurring frequency (Frequency enum value)
   * @param {number} monthlyMoveValue  Monthly percentage of source value (0-100)
   * @param {number} closeMoveValue    On-close percentage of source value (0-100)
   */
  constructor(toDisplayName, frequency = Frequency.NONE, monthlyMoveValue = 0, closeMoveValue = 0) {
    this.toDisplayName    = toDisplayName;
    this.frequency        = frequency;
    this.monthlyMoveValue = monthlyMoveValue;
    this.closeMoveValue   = closeMoveValue;

    // Bound at runtime by Portfolio — not serialised
    this.fromModel          = null;
    this.useNetIncome       = false;
    this.usePropertyTax     = false;
    this.toModel            = null;
    this.approvedAmount     = null;
  }

  // ── Parsing ──────────────────────────────────────────────────────

  static fromJSON(obj) {
    const mv = obj.monthlyMoveValue ?? obj.moveValue ?? 0;
    // Backward compat: old format had moveOnFinishDate (boolean) + single moveValue
    if (obj.moveOnFinishDate !== undefined) {
      if (obj.moveOnFinishDate) {
        return new FundTransfer(obj.toDisplayName, Frequency.NONE, 0, mv);
      } else {
        return new FundTransfer(obj.toDisplayName, Frequency.MONTHLY, mv, 0);
      }
    }
    return new FundTransfer(
      obj.toDisplayName,
      obj.frequency ?? Frequency.NONE,
      mv,
      obj.closeMoveValue ?? 0,
    );
  }

  static fromHTML(formElement) {
    let toDisplayName = null;
    let frequency = Frequency.NONE;
    let monthlyMoveValue = 0;
    let closeMoveValue = 0;

    const elements = formElement.querySelectorAll
      ? formElement.querySelectorAll('input, select')
      : formElement;   // allow passing NodeList directly

    for (const el of elements) {
      switch (el.name) {
        case 'toDisplayName':      toDisplayName = el.value; break;
        case 'frequency':          frequency = el.value; break;
        case 'monthlyMoveValue':   monthlyMoveValue = parseInt(el.value, 10) || 0; break;
        case 'closeMoveValue':     closeMoveValue = parseInt(el.value, 10) || 0; break;
      }
    }

    return new FundTransfer(toDisplayName, frequency, monthlyMoveValue, closeMoveValue);
  }

  // ── Frequency helpers ──────────────────────────────────────────

  /**
   * Returns true if this transfer's recurring frequency is active for the given month (1-12).
   */
  isActiveForMonth(_month) {
    return this.monthlyMoveValue > 0;
  }

  get hasRecurring() {
    return this.monthlyMoveValue > 0;
  }

  get hasClose() {
    return this.closeMoveValue > 0;
  }

  // ── System Factory ─────────────────────────────────────────────

  /**
   * Create an ephemeral, pre-bound transfer with a fixed Currency amount.
   * Used by engines for mortgage payments, property tax, etc. so that all
   * money movement flows through execute() → debit/credit → realizedGain.
   *
   * @param {ModelAsset} fromModel  Source asset (debited)
   * @param {ModelAsset} toModel    Target asset (credited)
   * @param {Currency}   amount     Fixed amount to transfer
   * @returns {FundTransfer}
   */
  static system(fromModel, toModel, amount) {
    const ft = new FundTransfer(toModel.displayName, Frequency.NONE, 0, 0);
    ft.fromModel = fromModel;
    ft.toModel = toModel;
    ft.approvedAmount = amount.copy();
    return ft;
  }

  // ── Account Resolution ─────────────────────────────────────────

  /** First non-closed taxable account. */
  static resolveTaxable(modelAssets) {
    return modelAssets.find(a => InstrumentType.isTaxableAccount(a.instrument) && !a.isClosed) ?? null;
  }

  /** First non-closed expensable account, following priority order. */
  static resolveExpensable(modelAssets) {
    for (const key of InstrumentType.expensablePriority) {
      const match = modelAssets.find(a => a.instrument === key && !a.isClosed);
      if (match) return match;
    }
    return null;
  }

  // ── Binding ──────────────────────────────────────────────────────

  /**
   * Resolve display-name references to actual ModelAsset instances.
   * @param {ModelAsset} fromModel
   * @param {ModelAsset[]} allModels
   */
  bind(fromModel, allModels) {
    
    this.fromModel = fromModel;
    this.toModel = allModels.find(m => m.displayName === this.toDisplayName) ?? null;

  }

  // ── Calculation ──────────────────────────────────────────────────

  /**
   * Calculate the transfer amount without executing it.
   * @param {{ useClosePercent?: boolean }} options
   * @returns {Currency}
   */
  calculate({ useClosePercent = false } = {}) {
    
    if (!this.fromModel || !this.toModel || this.toModel.isClosed) {
      return Currency.zero();
    }

    // approvedAmount is set by pre-tax contribution pre-calculations (401K, IRA)
    // which determine the correct amount from gross income before net income
    // is computed. Use it directly — it's the determined amount, not just a cap.
    if (this.approvedAmount) {
      return this.approvedAmount.copy();
    }

    const pct = (useClosePercent ? this.closeMoveValue : this.monthlyMoveValue) / 100;

    // Old -- Determine the base amount for the transfer:
    // New -- introduce flags set by callers (that have context) on where to pull funds from
    // On close: always use finishCurrency (full asset value)
    let base;
    if (useClosePercent) {
      base = this.fromModel.finishCurrency;
    } else if (this.useNetIncome) {
      base = this.fromModel.netIncomeCurrency;
    } else if (this.usePropertyTax) {
      base = this.fromModel.propertyTaxCurrency;
    } else {
      base = this.fromModel.finishCurrency;
    }

    let amount = new Currency(base.amount * pct);

    return amount;
  }

  /**
   * Execute the transfer: debit source, credit target.
   * @param {{ useClosePercent?: boolean }} options
   * @returns {FundTransferResult}
   */
  execute({ useClosePercent = false } = {}) {
    if (!this.fromModel || !this.toModel) return new FundTransferResult();

    const amount = this.calculate({ useClosePercent });
    const memo = this.describe(null, useClosePercent);

    const fromResult = this.fromModel.debit(amount, memo);
    const toResult   = this.toModel.credit(amount, memo);

    // Mechanical bookkeeping: record realized capital gains on whichever
    // side produced them (debit with positive gain, or credit-as-withdrawal)
    if (fromResult.realizedGain?.amount > 0) {
      this.fromModel.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, fromResult.realizedGain);
      this.fromModel.addCreditMemo(fromResult.realizedGain.copy(), 'Capital gains');
    }
    if (toResult.realizedGain?.amount > 0) {
      this.toModel.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, toResult.realizedGain);
      this.toModel.addCreditMemo(toResult.realizedGain.copy(), 'Capital gains');
    }

    // Combine gains from both sides: debit may trigger gains on the source,
    // and credit-as-withdrawal (negative amount) may trigger gains on the target.
    const combinedGain = fromResult.realizedGain.plus(toResult.realizedGain ?? Currency.zero());

    return new FundTransferResult(
      fromResult.assetChange,
      toResult.assetChange,
      memo,
      memo,
      combinedGain
    );
  }

  // ── Utilities ────────────────────────────────────────────────────

  copy() {
    return new FundTransfer(this.toDisplayName, this.frequency, this.monthlyMoveValue, this.closeMoveValue);
  }

  toJSON() {
    return {
      toDisplayName:    this.toDisplayName,
      frequency:        this.frequency,
      monthlyMoveValue: this.monthlyMoveValue,
      closeMoveValue:   this.closeMoveValue,
    };
  }

  /** Human-readable description for credit memo categorization */
  describe(fromName, onClose = false) {
    const from = fromName ?? this.fromModel?.displayName ?? '?';
    const dir = onClose ? '(on close)' : '(monthly)';
    return `${from} → ${this.toDisplayName} ${dir}`;
  }
}
