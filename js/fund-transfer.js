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

    // Spillover leg: when a tax-advantaged account is clamped at $0 mid-
    // withdrawal, execute() sources the shortfall from a taxable fallback and
    // reports it here so callers can book each leg against the account that
    // actually supplied the cash. fromAssetChange/toAssetChange report the
    // REQUESTED amounts; subtract `spillover` to get what the nominal account
    // really supplied. spilloverGain is kept separate from realizedGain to
    // make double-booking impossible.
    this.spillover = Currency.zero();           // amount supplied by the fallback
    this.spilloverGain = Currency.zero();       // realized gain on the fallback debit
    this.spilloverInstrument = null;            // fallback account's instrument
  }
}
import { Metric } from './metric.js';
import { EventType, ShortfallOrigin, renderNote } from './sim-event.js';
import { withTrace, TraceKind } from './trace.js';

/**
 * This is to handle one-sided debits or credits. For example, a tax payment. Here we simply
 * debit the toModel without crediting the fromModel since there is not credit for a tax payment--
 * other than continuing to possess the asset.
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
   * This is the ONE policy for every implicit money movement the engine makes
   * on the user's behalf: paying an expense or mortgage no fund transfer
   * covers, escrowing property tax, sweeping unallocated take-home pay,
   * settling a tax true-up, landing sale proceeds and RMDs, and covering
   * spillover from a depleted account. Retirement accounts are not eligible —
   * see `FUNDING_BACKSTOP_PRIORITY` in instrument.js for why.
   *
   * Returns null when nothing qualifies. Callers must treat that as an
   * UNFUNDED obligation and report it via `reportUnfunded()` — never as a
   * silent skip, which books the obligation while no cash leaves any account.
   */
  static resolveFunding(modelAssets) {
    for (const key of InstrumentType.fundingBackstopPriority) {
      const match = modelAssets.find(a => a.instrument === key && !a.isClosed && a.finishCurrency.amount > 0);
      if (match) return match;
    }
    return null;
  }

  /**
   * Record an obligation the funding backstop could not cover. The memo is
   * `info` kind — no money moved, so it must stay out of cash reconciliation —
   * and lands on the asset that owes, where the UI already shows its ledger.
   *
   * `origin` is REQUIRED and has no default on purpose. It decides which
   * conservation total this shortfall belongs to, and a wrong answer silently
   * mis-buckets money — the exact failure class this whole line of work exists
   * to remove. An omitted origin throws instead.
   *
   * @param {ModelAsset} modelAsset  The obligation's own asset (expense, mortgage, home)
   * @param {Currency}   amount      Positive amount that went unpaid
   * @param {string}     memo        What the money was for
   * @param {string}     origin      ShortfallOrigin — which movement this is the remainder of
   */
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
   * Settle a one-sided withdrawal (mortgage payment, property tax escrow,
   * carrying cost): debit the funding account and, when that account is
   * tax-advantaged and clamps at $0, source the shortfall from a fallback.
   *
   * These paths call debit() directly rather than execute(), so they never
   * reached execute()'s spillover handling: the clamped remainder was
   * reported and then dropped — the obligation was booked but the cash never
   * left any account. They also booked the FULL requested amount against the
   * named account, recording phantom IRA/401K distributions for money the
   * account never held.
   *
   * `supplied` is what the named account actually paid; `spillover` is what
   * the fallback paid. Callers book each leg against the account that really
   * supplied the cash.
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
        const spillResult = fallback.debit(result.spillover,
          { type: EventType.SPILLOVER,
            data: { depleted: oneSided.toModel.displayName, origin: ShortfallOrigin.ONE_SIDED } });
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

    // One causal scope for the whole movement. Everything recorded inside —
    // both legs, any realized gain, a clamp's spillover, an unfunded remainder
    // — becomes attributable to this one transfer rather than floating loose in
    // the month.
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

    // Tax-advantaged account depleted: the overshoot must come from a taxable
    // account — you can't withdraw more than the account holds. The clamped
    // WITHDRAWAL can sit on either side of a transfer:
    //   - debit(amount > 0) on fromModel (e.g. an RMD top-up from an IRA), or
    //   - credit(amount < 0) on toModel — "credit-as-withdrawal", which is how
    //     expense transfers pull from their funding account.
    // The two are mutually exclusive (opposite signs of `amount`). Handling
    // only the from side (the old code) silently discarded the to-side
    // spillover: a depleted IRA "paid" expenses in full with money that never
    // existed, and the books recorded the phantom as a taxable distribution.
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
        // No backstop account can cover the shortfall. Nothing at this layer
        // can conjure the cash; surface it instead of failing silently — the
        // requested amount was still credited in full to the target.
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
