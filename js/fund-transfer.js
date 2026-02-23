/**
 * fund-transfer.js
 *
 * Extracted from model.js. Represents a percentage-based transfer
 * of funds from one asset to another, either monthly or on finish date.
 */

import { Currency } from './currency.js';
import { FundTransferResult } from './results.js';

export class FundTransfer {
  /**
   * @param {string}  toDisplayName    Target asset's familiar name
   * @param {boolean} moveOnFinishDate Only transfer when source reaches its finish date
   * @param {number}  moveValue        Percentage of source value to transfer (0-100)
   */
  constructor(toDisplayName, moveOnFinishDate = false, moveValue = 0) {
    this.toDisplayName    = toDisplayName;
    this.moveOnFinishDate = moveOnFinishDate;
    this.moveValue        = moveValue;

    // Bound at runtime by Portfolio — not serialised
    this.fromModel = null;
    this.toModel   = null;
    this.approvedAmount = null;
  }

  // ── Parsing ──────────────────────────────────────────────────────

  static fromJSON(obj) {
    return new FundTransfer(
      obj.toDisplayName,
      obj.moveOnFinishDate ?? false,
      obj.moveValue ?? 0,
    );
  }

  static fromHTML(formElement) {
    let toDisplayName = null;
    let moveOnFinishDate = false;
    let moveValue = 0;

    const elements = formElement.querySelectorAll
      ? formElement.querySelectorAll('input, select')
      : formElement;   // allow passing NodeList directly

    for (const el of elements) {
      switch (el.name) {
        case 'toDisplayName':    toDisplayName = el.value; break;
        case 'moveOnFinishDate': moveOnFinishDate = el.checked; break;
        case 'moveValue':        moveValue = parseInt(el.value, 10) || 0; break;
      }
    }

    return new FundTransfer(toDisplayName, moveOnFinishDate, moveValue);
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
   * @returns {Currency}
   */
  calculate() {
    if (!this.fromModel || !this.toModel || this.toModel.isClosed) {
      return Currency.zero();
    }

    const pct = this.moveValue / 100;
    let amount = new Currency(this.fromModel.finishCurrency.amount * pct);

    if (this.approvedAmount && amount.amount > this.approvedAmount.amount) {
      amount = this.approvedAmount.copy();
    }

    return amount;
  }

  /**
   * Execute the transfer: debit source, credit target.
   * @returns {FundTransferResult}
   */
  execute() {
    if (!this.fromModel || !this.toModel) return new FundTransferResult();
    if (this.moveOnFinishDate && !(this.fromModel.onFinishDate || this.fromModel.afterFinishDate)) return new FundTransferResult();

    const amount = this.calculate();
    const fromMemo = this.describe(this.fromModel.displayName, amount);
    const toMemo = this.describe(this.toModel.displayName, amount.copy().flipSign());
    const fromChange = this.fromModel.debit(amount, fromMemo);
    const toChange   = this.toModel.credit(amount, toMemo);

    return new FundTransferResult(fromChange, toChange, fromMemo, toMemo);
  }

  // ── Utilities ────────────────────────────────────────────────────

  copy() {
    return new FundTransfer(this.toDisplayName, this.moveOnFinishDate, this.moveValue);
  }

  toJSON() {
    return {
      toDisplayName:    this.toDisplayName,
      moveOnFinishDate: this.moveOnFinishDate,
      moveValue:        this.moveValue,
    };
  }

  /** Human-readable description for logging / debugging */
  describe(fromName, amount) {
    const dir = this.moveOnFinishDate ? '(on finish)' : '(monthly)';
    return `${fromName} → ${this.toDisplayName} ${dir} ${this.moveValue}% => ${amount.toString()}`;
  }
}
