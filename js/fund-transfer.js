/**
 * fund-transfer.js
 *
 * Represents a percentage-based transfer of funds from one asset to another.
 * Supports recurring transfers (monthly/quarterly/half-yearly/yearly) and/or
 * a separate on-close transfer when the source asset reaches its finish date.
 */

import { Currency } from './currency.js';
import { FundTransferResult } from './results.js';

export const Frequency = Object.freeze({
  NONE:        'none',
  MONTHLY:     'monthly',
  QUARTERLY:   'quarterly',
  HALF_YEARLY: 'half-yearly',
  YEARLY:      'yearly',
});

export class FundTransfer {
  /**
   * @param {string} toDisplayName     Target asset's familiar name
   * @param {string} frequency         Recurring frequency (Frequency enum value)
   * @param {number} moveValue         Recurring percentage of source value (0-100)
   * @param {number} closeMoveValue    On-close percentage of source value (0-100)
   */
  constructor(toDisplayName, frequency = Frequency.NONE, moveValue = 0, closeMoveValue = 0) {
    this.toDisplayName = toDisplayName;
    this.frequency     = frequency;
    this.moveValue     = moveValue;
    this.closeMoveValue = closeMoveValue;

    // Bound at runtime by Portfolio — not serialised
    this.fromModel = null;
    this.toModel   = null;
    this.approvedAmount = null;
  }

  // ── Parsing ──────────────────────────────────────────────────────

  static fromJSON(obj) {
    // Backward compat: old format had moveOnFinishDate (boolean) + single moveValue
    if (obj.moveOnFinishDate !== undefined) {
      if (obj.moveOnFinishDate) {
        return new FundTransfer(obj.toDisplayName, Frequency.NONE, 0, obj.moveValue ?? 0);
      } else {
        return new FundTransfer(obj.toDisplayName, Frequency.MONTHLY, obj.moveValue ?? 0, 0);
      }
    }
    return new FundTransfer(
      obj.toDisplayName,
      obj.frequency ?? Frequency.NONE,
      obj.moveValue ?? 0,
      obj.closeMoveValue ?? 0,
    );
  }

  static fromHTML(formElement) {
    let toDisplayName = null;
    let frequency = Frequency.NONE;
    let moveValue = 0;
    let closeMoveValue = 0;

    const elements = formElement.querySelectorAll
      ? formElement.querySelectorAll('input, select')
      : formElement;   // allow passing NodeList directly

    for (const el of elements) {
      switch (el.name) {
        case 'toDisplayName':  toDisplayName = el.value; break;
        case 'frequency':      frequency = el.value; break;
        case 'moveValue':      moveValue = parseInt(el.value, 10) || 0; break;
        case 'closeMoveValue': closeMoveValue = parseInt(el.value, 10) || 0; break;
      }
    }

    return new FundTransfer(toDisplayName, frequency, moveValue, closeMoveValue);
  }

  // ── Frequency helpers ──────────────────────────────────────────

  /**
   * Returns true if this transfer's recurring frequency is active for the given month (1-12).
   */
  isActiveForMonth(month) {
    switch (this.frequency) {
      case Frequency.MONTHLY:     return true;
      case Frequency.QUARTERLY:   return month % 3 === 0;   // Mar, Jun, Sep, Dec
      case Frequency.HALF_YEARLY: return month === 6 || month === 12;
      case Frequency.YEARLY:      return month === 12;
      default:                    return false;
    }
  }

  get hasRecurring() {
    return this.frequency !== Frequency.NONE && this.moveValue > 0;
  }

  get hasClose() {
    return this.closeMoveValue > 0;
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

    const pct = (useClosePercent ? this.closeMoveValue : this.moveValue) / 100;
    // Use net income when available (income assets after tax computation),
    // otherwise fall back to finishCurrency (non-income assets, asset closures)
    const base = this.fromModel.netIncomeCurrency?.amount > 0
      ? this.fromModel.netIncomeCurrency
      : this.fromModel.finishCurrency;
    let amount = new Currency(base.amount * pct);

    if (this.approvedAmount && amount.amount > this.approvedAmount.amount) {
      amount = this.approvedAmount.copy();
    }

    return amount;
  }

  /**
   * Execute the transfer: debit source, credit target.
   * @param {{ skipGain?: boolean }} options
   * @returns {FundTransferResult}
   */
  execute({ skipGain = false, useClosePercent = false } = {}) {
    if (!this.fromModel || !this.toModel) return new FundTransferResult();

    const amount = this.calculate({ useClosePercent });
    const fromMemo = this.describe(this.fromModel.displayName, amount);
    const toMemo = this.describe(this.toModel.displayName, amount.copy().flipSign());

    const fromResult = this.fromModel.debit(amount, fromMemo, skipGain);
    const toResult   = this.toModel.credit(amount, toMemo, skipGain);

    return new FundTransferResult(
      fromResult.assetChange,
      toResult.assetChange,
      fromMemo,
      toMemo,
      toResult.realizedGain
    );
  }

  // ── Utilities ────────────────────────────────────────────────────

  copy() {
    return new FundTransfer(this.toDisplayName, this.frequency, this.moveValue, this.closeMoveValue);
  }

  toJSON() {
    return {
      toDisplayName:  this.toDisplayName,
      frequency:      this.frequency,
      moveValue:      this.moveValue,
      closeMoveValue: this.closeMoveValue,
    };
  }

  /** Human-readable description for logging / debugging */
  describe(fromName, amount) {
    const dir = this.frequency !== Frequency.NONE ? `(${this.frequency})` : '(on close)';
    return `${fromName} → ${this.toDisplayName} ${dir}` + (amount != null ? ` => ${amount.toString()}` : '');
  }
}
