/**
 * fund-transfer.js
 *
 * Represents a percentage-based transfer of funds from one asset to another.
 * Supports a monthly recurring transfer and/or a separate on-close transfer
 * when the source asset reaches its finish date.
 */

import { Currency } from './utils/currency.js';
import { Instrument, InstrumentType } from './instruments/instrument.js';
import { logger, LogCategory } from './utils/logger.js';
// ── Result Type ──────────────────────────────────────────────────────

export class FundTransferResult {
  constructor(fromAssetChange = Currency.zero(), toAssetChange = Currency.zero(), fromMemo = null, toMemo = null, realizedGain = Currency.zero()) {
    this.fromAssetChange = fromAssetChange instanceof Currency ? fromAssetChange.copy() : new Currency(fromAssetChange);
    this.toAssetChange   = toAssetChange instanceof Currency ? toAssetChange.copy() : new Currency(toAssetChange);
    this.fromMemo = fromMemo;
    this.toMemo = toMemo;
    this.realizedGain = realizedGain instanceof Currency ? realizedGain.copy() : new Currency(realizedGain);

    // The spillover leg: when an account clamps at $0 mid-withdrawal, execute()
    // sources the shortfall from a fallback and reports it here, so callers can
    // book each leg against the account that paid. fromAssetChange/toAssetChange
    // are the REQUESTED amounts; subtract `spillover` for what the named account
    // supplied. spilloverGain is separate from realizedGain so neither is
    // booked twice.
    this.spillover = Currency.zero();           // amount supplied by the fallback
    this.spilloverGain = Currency.zero();       // realized gain on the fallback debit
    this.spilloverInstrument = null;            // fallback account's instrument
  }
}
import { Metric } from './metric.js';
import { EventType, ShortfallOrigin, renderNote } from './sim-event.js';
import { withTrace, TraceKind } from './trace.js';

/**
 * A one-sided movement, such as a tax payment: toModel is debited and nothing
 * is credited, because nothing is received in return.
 */
export class FundTransferOneSided {

  constructor(fundTransfer, amount) {
    this.fromModel = fundTransfer?.fromModel ?? null;
    this.toModel = fundTransfer?.toModel ?? null;

    //if (!amount) debugger;

    this.amount = amount;
    
    if (fundTransfer) {
      this.amount = new Currency(amount.amount * (fundTransfer.monthlyMoveValue / 100));
    }
  }

}

export class FundTransfer {
  /**
   * @param {string} toDisplayName     Target asset's familiar name
   * @param {number} monthlyMoveValue  Monthly percentage of source value (0-100)
   * @param {number} closeMoveValue    On-close percentage of source value (0-100)
   */
  constructor(toDisplayName, monthlyMoveValue = 0, closeMoveValue = 0) {
    this.toDisplayName    = toDisplayName;
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
      return obj.moveOnFinishDate
        ? new FundTransfer(obj.toDisplayName, 0, mv)
        : new FundTransfer(obj.toDisplayName, mv, 0);
    }
    return new FundTransfer(
      obj.toDisplayName,
      mv,
      obj.closeMoveValue ?? 0,
    );
  }

  static fromHTML(formElement) {
    let toDisplayName = null;
    let monthlyMoveValue = 0;
    let closeMoveValue = 0;

    const elements = formElement.querySelectorAll
      ? formElement.querySelectorAll('input, select')
      : formElement;   // allow passing NodeList directly

    for (const el of elements) {
      switch (el.name) {
        case 'toDisplayName':      toDisplayName = el.value; break;
        case 'monthlyMoveValue':   monthlyMoveValue = parseInt(el.value, 10) || 0; break;
        case 'closeMoveValue':     closeMoveValue = parseInt(el.value, 10) || 0; break;
      }
    }

    return new FundTransfer(toDisplayName, monthlyMoveValue, closeMoveValue);
  }

  // ── Activity helpers ───────────────────────────────────────────

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
  static system(fromModel, toModel, amount, allModels = null) {
    const ft = new FundTransfer(toModel.displayName, 0, 0);
    ft.fromModel = fromModel;
    ft.toModel = toModel;
    ft.approvedAmount = amount.copy();
    ft._allModels = allModels;
    return ft;
  }

  // ── Account Resolution ─────────────────────────────────────────

  /**
   * The funding backstop: the first open account from the everyday priority
   * list (cash → savings → brokerage → treasuries → corporate bonds) holding
   * a positive balance.
   *
   * The one policy for every implicit money movement the engine makes for the
   * user: an expense or mortgage no transfer covers, property-tax escrow,
   * unallocated take-home pay, tax true-ups, sale proceeds, RMDs, and spillover.
   * Retirement accounts are not eligible (see `FUNDING_BACKSTOP_PRIORITY` in
   * instrument.js).
   *
   * Returns null when nothing qualifies; callers must then call
   * `reportUnfunded()`, never skip silently.
   */
  static resolveFunding(modelAssets) {
    for (const key of InstrumentType.fundingBackstopPriority) {
      const match = modelAssets.find(a => a.instrument === key && !a.isClosed && a.finishCurrency.amount > 0);
      if (match) return match;
    }
    return null;
  }

  /**
   * Record an obligation the funding backstop could not cover, as an info
   * event (no money moved) on the asset that owes.
   *
   * `origin` is required: it decides which conservation total the shortfall
   * belongs to, so an omitted origin throws rather than defaulting.
   *
   * @param {ModelAsset} modelAsset  The obligation's own asset (expense, mortgage, home)
   * @param {Currency}   amount      Positive amount that went unpaid
   * @param {string}     memo        What the money was for
   * @param {string}     origin      ShortfallOrigin — which movement this is the remainder of
   */
  /**
   * Where money coming in lands when no account was named: resolveFunding's
   * priority list without its positive-balance filter, since an empty account
   * can still receive a deposit. Retirement accounts stay out — a deposit into
   * a 401(k) is a contribution, with rules attached.
   */
  static resolveDeposit(modelAssets) {
    for (const key of InstrumentType.fundingBackstopPriority) {
      const match = modelAssets.find(a => a.instrument === key && !a.isClosed);
      if (match) return match;
    }
    return null;
  }

  static reportUnfunded(modelAsset, amount, memo, origin) {
    if (!Object.values(ShortfallOrigin).includes(origin)) {
      throw new Error(`reportUnfunded: origin must be a ShortfallOrigin, got "${origin}"`);
    }
    if (!amount || amount.amount <= 0) return;
    logger.log(LogCategory.SANITY,
      `Unfunded: ${modelAsset?.displayName ?? '?'} ${memo} ${amount.toString()} — ` +
      `no eligible funding account (cash, savings, brokerage or bonds with a positive balance)`);
    modelAsset?.recordEvent(EventType.UNFUNDED, amount.copy().flipSign(), { data: { cause: memo, origin } });
  }

  // ── One-Sided Settlement ───────────────────────────────────────

  /**
   * Settle a one-sided withdrawal (mortgage payment, property-tax escrow,
   * carrying cost, tax): debit the funding account and, if it clamps at $0,
   * source the shortfall from a fallback, reporting what nothing can cover.
   *
   * `supplied` is what the named account paid; `spillover` is what the
   * fallback paid. Callers book each leg against the account that paid it.
   *
   * @param {FundTransferOneSided} oneSided
   * @param {string}      memo
   * @param {ModelAsset[]} allModels
   * @param {Function}    resolveFallback  Funding policy for the shortfall
   * @returns {{supplied: Currency, realizedGain: Currency, spillover: Currency,
   *            spilloverGain: Currency, spilloverInstrument: string|null}}
   */
  static settleOneSided(oneSided, event, allModels, resolveFallback = FundTransfer.resolveFunding) {
    // Nested under whatever obligation asked for this draw, so the chain reads
    // "Pay Living Expenses > Settle from Brokerage > spillover".
    return withTrace(TraceKind.SETTLEMENT,
      `Settle from ${oneSided.toModel?.displayName ?? '?'}`,
      oneSided.toModel?.currentDateInt,
      () => FundTransfer.#settleInScope(oneSided, event, allModels, resolveFallback));
  }

  static #settleInScope(oneSided, event, allModels, resolveFallback) {
    const result = oneSided.toModel.debit(oneSided.amount, event);
    // The unfunded report quotes what could not be paid for, which is this
    // settlement's own note — rendered once, here, rather than rebuilt.
    const memo = renderNote(event);
    const supplied = oneSided.amount.minus(result.spillover);

    oneSided.toModel.recordDistribution(supplied);
    if (result.realizedGain?.amount > 0) {
      oneSided.toModel.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, result.realizedGain);
      oneSided.toModel.recordEvent(EventType.CAPITAL_GAIN_RECOGNIZED, result.realizedGain.copy(), { metric: Metric.LONG_TERM_CAPITAL_GAIN, data: { spillover: false } });
    }

    let spillover = Currency.zero();
    let spilloverGain = Currency.zero();
    let spilloverInstrument = null;

    if (result.spillover.amount > 0) {
      const fallback = resolveFallback(allModels);
      if (fallback) {
        // `cause` records which obligation this spill settled, so a tax payment
        // re-sourced from the backstop reconciles as tax.
        const spillResult = fallback.debit(result.spillover,
          { type: EventType.SPILLOVER,
            data: { depleted: oneSided.toModel.displayName,
                    origin: ShortfallOrigin.ONE_SIDED,
                    cause: event?.type ?? null } });
        spillover = result.spillover.copy();
        spilloverGain = spillResult.realizedGain?.copy() ?? Currency.zero();
        spilloverInstrument = fallback.instrument;

        fallback.recordDistribution(spillover.minus(spillResult.spillover));
        if (spilloverGain.amount > 0) {
          fallback.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, spilloverGain);
          fallback.recordEvent(EventType.CAPITAL_GAIN_RECOGNIZED, spilloverGain.copy(), { metric: Metric.LONG_TERM_CAPITAL_GAIN, data: { spillover: true } });
        }
        // The fallback itself clamped: nothing left at this layer to draw on.
        if (spillResult.spillover?.amount > 0) {
          FundTransfer.reportUnfunded(oneSided.fromModel ?? oneSided.toModel, spillResult.spillover, memo, ShortfallOrigin.ONE_SIDED);
        }
      } else {
        FundTransfer.reportUnfunded(oneSided.fromModel ?? oneSided.toModel, result.spillover, memo, ShortfallOrigin.ONE_SIDED);
      }
    }

    return { supplied, realizedGain: result.realizedGain, spillover, spilloverGain, spilloverInstrument };
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
    this._allModels = allModels;

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

    // Skip percentage-based transfers from depleted capital accounts (IRA, 401K, etc.)
    // Flow instruments (salary, expenses) use negative balances by design, so exclude them.
    if (InstrumentType.isCapital(this.fromModel.instrument) && this.fromModel.finishCurrency.amount <= 0) {
      return Currency.zero();
    }

    const pct = (useClosePercent ? this.closeMoveValue : this.monthlyMoveValue) / 100;

    // The base the percentage applies to: the full value on close, else net
    // income or property tax when a caller sets useNetIncome / usePropertyTax,
    // else the full value (for an income asset, the gross).
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

    // One causal scope for the whole movement: both legs, any realized gain,
    // spillover and unfunded remainder are attributed to this transfer.
    return withTrace(TraceKind.TRANSFER,
      `Transfer ${this.fromModel.displayName} → ${this.toDisplayName}`,
      this.fromModel.currentDateInt,
      () => this.#executeInScope({ useClosePercent }));
  }

  #executeInScope({ useClosePercent = false } = {}) {

    const amount = this.calculate({ useClosePercent });
    const event = {
      type: EventType.TRANSFER,
      data: {
        from: this.fromModel?.displayName ?? '?',
        to: this.toDisplayName,
        cadence: useClosePercent ? 'on close' : 'monthly',
      },
    };
    const memo = renderNote(event);

    const fromResult = this.fromModel.debit(amount, event);
    const toResult   = this.toModel.credit(amount, event);

    // Mechanical bookkeeping: record realized capital gains on whichever
    // side produced them (debit with positive gain, or credit-as-withdrawal)
    if (fromResult.realizedGain?.amount > 0) {
      this.fromModel.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, fromResult.realizedGain);
      this.fromModel.recordEvent(EventType.CAPITAL_GAIN_RECOGNIZED, fromResult.realizedGain.copy(), { metric: Metric.LONG_TERM_CAPITAL_GAIN, data: { spillover: false } });
    }
    if (toResult.realizedGain?.amount > 0) {
      this.toModel.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, toResult.realizedGain);
      this.toModel.recordEvent(EventType.CAPITAL_GAIN_RECOGNIZED, toResult.realizedGain.copy(), { metric: Metric.LONG_TERM_CAPITAL_GAIN, data: { spillover: false } });
    }

    // A clamped account: the shortfall comes from a fallback. The clamped
    // withdrawal can be on either side:
    //   - debit(amount > 0) on fromModel (e.g. an RMD top-up from an IRA), or
    //   - credit(amount < 0) on toModel — "credit-as-withdrawal", how expense
    //     transfers pull from their funding account.
    // Opposite signs of `amount`, so at most one side spills.
    //
    // The fallback is assumed to supply the whole shortfall: if it clamps too,
    // the rest is neither re-sourced nor reported.
    const spillSource = fromResult.spillover?.amount > 0 ? this.fromModel
                      : toResult.spillover?.amount > 0 ? this.toModel
                      : null;
    let spillover = Currency.zero();
    let spilloverGain = Currency.zero();
    let spilloverInstrument = null;
    if (spillSource && this._allModels) {
      const spillAmount = fromResult.spillover?.amount > 0 ? fromResult.spillover : toResult.spillover;
      const fallback = FundTransfer.resolveFunding(this._allModels);
      if (fallback) {
        const spillResult = fallback.debit(spillAmount,
          { type: EventType.SPILLOVER,
            data: { depleted: spillSource.displayName, origin: ShortfallOrigin.PAIRED } });
        spillover = spillAmount.copy();
        spilloverGain = spillResult.realizedGain?.copy() ?? Currency.zero();
        spilloverInstrument = fallback.instrument;
        if (spilloverGain.amount > 0) {
          fallback.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, spilloverGain);
          fallback.recordEvent(EventType.CAPITAL_GAIN_RECOGNIZED, spilloverGain.copy(), { metric: Metric.LONG_TERM_CAPITAL_GAIN, data: { spillover: true } });
        }
      } else {
        // No backstop can cover the shortfall: report it as unfunded. The
        // target was still credited the full requested amount above, so that
        // part of its balance was paid by no one.
        FundTransfer.reportUnfunded(spillSource, spillAmount, `${memo} (account depleted, no backstop)`, ShortfallOrigin.PAIRED);
      }
    }

    // Combine gains from both sides: debit may trigger gains on the source,
    // and credit-as-withdrawal (negative amount) may trigger gains on the target.
    const combinedGain = fromResult.realizedGain.plus(toResult.realizedGain ?? Currency.zero());

    const result = new FundTransferResult(
      fromResult.assetChange,
      toResult.assetChange,
      memo,
      memo,
      combinedGain
    );
    result.spillover = spillover;
    result.spilloverGain = spilloverGain;
    result.spilloverInstrument = spilloverInstrument;
    return result;
  }

  // ── Utilities ────────────────────────────────────────────────────

  copy() {
    return new FundTransfer(this.toDisplayName, this.monthlyMoveValue, this.closeMoveValue);
  }

  toJSON() {
    return {
      toDisplayName:    this.toDisplayName,
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
