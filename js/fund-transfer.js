/**
 * fund-transfer.js
 *
 * Represents a percentage-based transfer of funds from one asset to another.
 * Supports a monthly recurring transfer and/or a separate on-close transfer
 * when the source asset reaches its finish date.
 */

import { Currency } from './utils/currency.js';
import { Instrument, InstrumentType } from './instruments/instrument.js';
import { global_deferred_allocation_age } from './policy-constants.js';
import { logger, LogCategory } from './utils/logger.js';
// ── Result Type ──────────────────────────────────────────────────────

export class FundTransferResult {
  constructor(fromAssetChange = Currency.zero(), toAssetChange = Currency.zero(), fromMemo = null, toMemo = null, realizedGain = Currency.zero()) {
    this.fromAssetChange = fromAssetChange instanceof Currency ? fromAssetChange.copy() : new Currency(fromAssetChange);
    this.toAssetChange   = toAssetChange instanceof Currency ? toAssetChange.copy() : new Currency(toAssetChange);
    this.fromMemo = fromMemo;
    this.toMemo = toMemo;
    this.realizedGain = realizedGain instanceof Currency ? realizedGain.copy() : new Currency(realizedGain);

    // The spillover legs: when an account clamps at $0 mid-withdrawal, execute()
    // drains the shortfall across eligible fallbacks in priority order and
    // reports each leg in `spilloverLegs` so callers book each leg against the
    // account that paid. `spillover` / `spilloverGain` / `spilloverInstrument`
    // hold the totals (and first leg's instrument) for backward compatibility.
    this.spillover = Currency.zero();           // total amount supplied by fallbacks
    this.spilloverGain = Currency.zero();       // total realized gain on fallback debits
    this.spilloverInstrument = null;            // first fallback account's instrument
    this.spilloverLegs = [];                    // Array<{ account, instrument, amount, realizedGain }>
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

    this.amount = amount;
    
    if (fundTransfer) {
      this.amount = new Currency(amount.amount * (fundTransfer.monthlyMoveValue / 100));
    }
  }

}

export class FundTransfer {
  /**
   * @param {string} toDisplayName     Target asset's familiar name: its label, and how
   *                                   a plan written without ids names it
   * @param {number} monthlyMoveValue  Monthly percentage of source value (0-100)
   * @param {number} closeMoveValue    On-close percentage of source value (0-100)
   * @param {string|null} [toId]       Target asset's id: what the transfer goes to
   *                                   (plan-ids.js preparePlan fills it from the name)
   */
  constructor(toDisplayName, monthlyMoveValue = 0, closeMoveValue = 0, toId = null) {
    this.toId             = toId;
    this.toDisplayName    = toDisplayName;
    this.monthlyMoveValue = monthlyMoveValue;
    this.closeMoveValue   = closeMoveValue;

    // Bound at runtime by Portfolio — not serialised
    this.fromModel          = null;
    this.useNetIncome       = false;
    this.usePropertyTax     = false;
    this.toModel            = null;
    this.approvedAmount     = null;
    this._activeUser        = null;
  }

  // ── Parsing ──────────────────────────────────────────────────────

  static fromJSON(obj) {
    const mv = obj.monthlyMoveValue ?? obj.moveValue ?? 0;
    // Backward compat: old format had moveOnFinishDate (boolean) + single moveValue
    if (obj.moveOnFinishDate !== undefined) {
      return obj.moveOnFinishDate
        ? new FundTransfer(obj.toDisplayName, 0, mv, obj.toId ?? null)
        : new FundTransfer(obj.toDisplayName, mv, 0, obj.toId ?? null);
    }
    return new FundTransfer(
      obj.toDisplayName,
      mv,
      obj.closeMoveValue ?? 0,
      obj.toId ?? null,
    );
  }

  static fromHTML(formElement) {
    let toDisplayName = null;
    let toId = null;
    let monthlyMoveValue = 0;
    let closeMoveValue = 0;

    const elements = formElement.querySelectorAll
      ? formElement.querySelectorAll('input, select')
      : formElement;   // allow passing NodeList directly

    for (const el of elements) {
      switch (el.name) {
        case 'toDisplayName':      toDisplayName = el.value; break;
        case 'toId':               toId = el.value || null; break;
        case 'monthlyMoveValue':   monthlyMoveValue = parseInt(el.value, 10) || 0; break;
        case 'closeMoveValue':     closeMoveValue = parseInt(el.value, 10) || 0; break;
      }
    }

    return new FundTransfer(toDisplayName, monthlyMoveValue, closeMoveValue, toId);
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
  static system(fromModel, toModel, amount, allModels = null, activeUser = null) {
    const ft = new FundTransfer(toModel.displayName, 0, 0, toModel.id ?? null);
    ft.fromModel = fromModel;
    ft.toModel = toModel;
    ft.approvedAmount = amount.copy();
    ft._allModels = allModels;
    ft._activeUser = activeUser;
    // Marked on its events, so a reader can tell a movement the engine chose
    // (leftover take-home, a required distribution, sale proceeds) from one a
    // rule made between the same two accounts.
    ft.system = true;
    return ft;
  }

  // ── Account Resolution ─────────────────────────────────────────

  /**
   * The funding backstop: the first open account from the everyday priority
   * list (cash → savings → brokerage → treasuries → corporate bonds) holding
   * a positive balance.
   *
   * When all everyday accounts are empty and `activeUser` is at least age 60
   * (`global_deferred_allocation_age`, conservative whole-year rounding of
   * 59½), falls back through retirement accounts in tax-efficient order:
   * tax-deferred first (`IRA → 401K`), then `Roth IRA` strictly as last resort.
   *
   * Returns null when nothing qualifies; callers must then call
   * `reportUnfunded()`, never skip silently.
   */
  static resolveFunding(modelAssets, activeUser = null) {
    for (const key of InstrumentType.fundingBackstopPriority) {
      const match = modelAssets.find(a => a.instrument === key && !a.isClosed && a.finishCurrency.amount > 0);
      if (match) return match;
    }
    if (activeUser && activeUser.age >= global_deferred_allocation_age) {
      for (const key of [Instrument.IRA, Instrument.FOUR_01K, Instrument.ROTH_IRA]) {
        const match = modelAssets.find(a => a.instrument === key && !a.isClosed && a.finishCurrency.amount > 0);
        if (match) return match;
      }
    }
    return null;
  }

  /**
   * Build a fallback resolver bound to `activeUser` for `settleOneSided`.
   * @param {object|null} activeUser
   * @returns {(modelAssets: ModelAsset[]) => ModelAsset|null}
   */
  static fundingResolver(activeUser) {
    return (models) => FundTransfer.resolveFunding(models, activeUser);
  }

  /**
   * Where money coming in lands when no account was named: resolveFunding's
   * everyday priority list without its positive-balance filter, since an empty
   * account can still receive a deposit. Retirement accounts (including Roth
   * IRA) stay out — deposits into retirement accounts are contributions with
   * statutory rules attached.
   */
  static resolveDeposit(modelAssets) {
    for (const key of InstrumentType.fundingBackstopPriority) {
      const match = modelAssets.find(a => a.instrument === key && !a.isClosed);
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
  static reportUnfunded(modelAsset, amount, memo, origin) {
    if (!Object.values(ShortfallOrigin).includes(origin)) {
      throw new Error(`reportUnfunded: origin must be a ShortfallOrigin, got "${origin}"`);
    }
    if (!amount || amount.amount <= 0) return;
    logger.log(LogCategory.SANITY,
      () => `Unfunded: ${modelAsset?.displayName ?? '?'} ${memo} ${amount.toString()} — ` +
      `no eligible funding account (cash, savings, brokerage or bonds with a positive balance)`);
    modelAsset?.recordEvent(EventType.UNFUNDED, amount.copy().flipSign(), { data: { cause: memo, origin } });
  }

  /**
   * Drain a shortfall across eligible fallback accounts in priority order,
   * looping whenever a fallback clamps at $0 until either the shortfall is
   * covered or no eligible fallback remains.
   */
  static #drainFallbacks(spillAmount, spillSource, eventData, allModels, resolveFallback) {
    const legs = [];
    let remaining = spillAmount.copy();
    const tried = new Set();

    while (remaining.amount > 0.000001) {
      const fallback = resolveFallback(allModels);
      if (!fallback || tried.has(fallback)) break;
      tried.add(fallback);

      const spillResult = fallback.debit(remaining, {
        type: EventType.SPILLOVER,
        data: { depleted: spillSource.displayName, ...eventData },
      });
      const fallbackShortfall = spillResult.spillover?.amount ?? 0;
      const supplied = new Currency(Math.max(0, remaining.amount - fallbackShortfall));
      const gain = spillResult.realizedGain?.copy() ?? Currency.zero();

      if (supplied.amount > 0) {
        fallback.recordDistribution(supplied);
        if (gain.amount > 0) {
          fallback.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, gain);
          fallback.recordEvent(EventType.CAPITAL_GAIN_RECOGNIZED, gain.copy(),
            { metric: Metric.LONG_TERM_CAPITAL_GAIN, data: { spillover: true } });
        }
        legs.push({ account: fallback, instrument: fallback.instrument, amount: supplied, realizedGain: gain });
      }

      remaining = new Currency(fallbackShortfall);
    }

    const totalSpillover = legs.reduce((acc, l) => acc.plus(l.amount), Currency.zero());
    const totalGain = legs.reduce((acc, l) => acc.plus(l.realizedGain), Currency.zero());
    const unfunded = remaining.amount > 0.000001 ? remaining : Currency.zero();

    return { legs, totalSpillover, totalGain, unfunded };
  }

  // ── One-Sided Settlement ───────────────────────────────────────

  /**
   * Settle a one-sided withdrawal (mortgage payment, property-tax escrow,
   * carrying cost, tax): debit the funding account and, if it clamps at $0,
   * source the shortfall across fallbacks in priority order, reporting what
   * nothing can cover.
   *
   * `supplied` is what the named account paid; `spilloverLegs` lists each
   * fallback account and what it actually paid; `spillover` is the sum across
   * all fallback legs. `paid` is the amount asked for less everything reported
   * unfunded: the figure to book as collected.
   *
   * @param {FundTransferOneSided} oneSided
   * @param {object}      event
   * @param {ModelAsset[]} allModels
   * @param {Function}    resolveFallback  Funding policy for the shortfall
   * @returns {{supplied: Currency, realizedGain: Currency, spillover: Currency,
   *            spilloverGain: Currency, spilloverInstrument: string|null,
   *            spilloverLegs: Array<{account: ModelAsset, instrument: string, amount: Currency, realizedGain: Currency}>,
   *            paid: Currency}}
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
    let spilloverLegs = [];
    let unfunded = Currency.zero();

    if (result.spillover.amount > 0) {
      // `cause` records which obligation this spill settled, so a tax payment
      // re-sourced from the backstop reconciles as tax.
      const drained = FundTransfer.#drainFallbacks(
        result.spillover,
        oneSided.toModel,
        { origin: ShortfallOrigin.ONE_SIDED, cause: event?.type ?? null },
        allModels,
        resolveFallback,
      );
      spillover = drained.totalSpillover;
      spilloverGain = drained.totalGain;
      spilloverInstrument = drained.legs[0]?.instrument ?? null;
      spilloverLegs = drained.legs;
      unfunded = drained.unfunded;

      if (unfunded.amount > 0) {
        FundTransfer.reportUnfunded(oneSided.fromModel ?? oneSided.toModel, unfunded, memo, ShortfallOrigin.ONE_SIDED);
      }
    }

    // Asked for less unfunded, rather than supplied + what the fallbacks paid,
    // so that a settlement with nothing unfunded books exactly what it asked.
    const paid = oneSided.amount.minus(unfunded);

    return { supplied, realizedGain: result.realizedGain, spillover, spilloverGain, spilloverInstrument, spilloverLegs, paid };
  }

  // ── Binding ──────────────────────────────────────────────────────

  /**
   * Resolve the target to its ModelAsset instance, by id. A transfer with no id
   * is one nothing prepared (preparePlan gives every resolvable target one), so
   * it is looked up by its name, as a plan written without ids names it.
   * @param {ModelAsset} fromModel
   * @param {ModelAsset[]} allModels
   * @param {object|null} [activeUser]
   */
  bind(fromModel, allModels, activeUser = null) {

    this.fromModel = fromModel;
    this.toModel = (this.toId != null
      ? allModels.find(m => m.id === this.toId)
      : allModels.find(m => m.displayName === this.toDisplayName)) ?? null;
    this._allModels = allModels;
    this._activeUser = activeUser;

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
    // else what the month asks for: the full value (for an income asset, the
    // gross), or a health-insurance premium less its advance credit.
    let base;
    if (useClosePercent) {
      base = this.fromModel.finishCurrency;
    } else if (this.useNetIncome) {
      base = this.fromModel.netIncomeCurrency;
    } else if (this.usePropertyTax) {
      base = this.fromModel.propertyTaxCurrency;
    } else {
      base = this.fromModel.amountDueCurrency ?? this.fromModel.finishCurrency;
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
      `Transfer ${this.fromModel.displayName} → ${this.toModel.displayName}`,
      this.fromModel.currentDateInt,
      () => this.#executeInScope({ useClosePercent }));
  }

  #executeInScope({ useClosePercent = false } = {}) {

    const amount = this.calculate({ useClosePercent });
    const event = {
      type: EventType.TRANSFER,
      data: {
        from: this.fromModel?.displayName ?? '?',
        to: this.toModel.displayName,
        cadence: useClosePercent ? 'on close' : 'monthly',
        ...(this.system ? { system: true } : {}),
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

    // A clamped account: drain the shortfall across eligible fallbacks in
    // priority order. The clamped withdrawal can be on either side:
    //   - debit(amount > 0) on fromModel (e.g. an RMD top-up from an IRA), or
    //   - credit(amount < 0) on toModel — "credit-as-withdrawal", how expense
    //     transfers pull from their funding account.
    // Opposite signs of `amount`, so at most one side spills.
    //
    // Whatever no fallback can cover is reported unfunded, as settleOneSided
    // reports it: the target was credited the whole amount, and that part of
    // it was paid by no one.
    const spillSource = fromResult.spillover?.amount > 0 ? this.fromModel
                      : toResult.spillover?.amount > 0 ? this.toModel
                      : null;
    const rawClamp = fromResult.spillover?.amount > 0 ? fromResult.spillover.amount
                   : toResult.spillover?.amount > 0 ? toResult.spillover.amount
                   : 0;
    const supplied = new Currency(Math.max(0, Math.abs(amount.amount) - rawClamp));

    let spillover = Currency.zero();
    let spilloverGain = Currency.zero();
    let spilloverInstrument = null;
    let spilloverLegs = [];
    let unfunded = Currency.zero();
    if (spillSource && this._allModels) {
      const spillAmount = fromResult.spillover?.amount > 0 ? fromResult.spillover : toResult.spillover;
      const drained = FundTransfer.#drainFallbacks(
        spillAmount,
        spillSource,
        { origin: ShortfallOrigin.PAIRED },
        this._allModels,
        FundTransfer.fundingResolver(this._activeUser),
      );
      spillover = drained.totalSpillover;
      spilloverGain = drained.totalGain;
      spilloverInstrument = drained.legs[0]?.instrument ?? null;
      spilloverLegs = drained.legs;
      unfunded = drained.unfunded;

      if (unfunded.amount > 0) {
        const suffix = drained.legs.length > 0
          ? '(account and backstop depleted)'
          : '(account depleted, no backstop)';
        FundTransfer.reportUnfunded(spillSource, unfunded, `${memo} ${suffix}`, ShortfallOrigin.PAIRED);
      }
    } else if (rawClamp > 0) {
      unfunded = new Currency(rawClamp);
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
    result.supplied = supplied;
    result.spillover = spillover;
    result.spilloverGain = spilloverGain;
    result.spilloverInstrument = spilloverInstrument;
    result.spilloverLegs = spilloverLegs;
    result.unfunded = unfunded;
    return result;
  }

  // ── Utilities ────────────────────────────────────────────────────

  copy() {
    return new FundTransfer(this.toDisplayName, this.monthlyMoveValue, this.closeMoveValue, this.toId);
  }

  toJSON() {
    return {
      // Left out until the target is resolved, so a transfer that names no
      // asset writes what it was written with.
      ...(this.toId != null ? { toId: this.toId } : {}),
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
