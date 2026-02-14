/**
 * model-asset.js
 *
 * Refactored ModelAsset. Key changes:
 *
 *  1. 25+ currency/array pairs replaced by MetricSet (~120 lines → ~10 lines of declaration)
 *  2. 15 identical addMonthlyXxx() methods replaced by a single generic `addToMetric()`
 *  3. Instrument classification uses InstrumentType instead of loose functions
 *  4. Parsing (fromJSON, fromHTML) uses static factory methods
 *  5. All dependencies are explicit ES module imports
 *  6. Financial logic (applyMonthly*) kept intact — just cleaner
 */

import { Currency }       from './currency.js';
import { DateInt }        from './date-int.js';
import { ARR }            from './arr.js';
import { InstrumentType } from './instrument.js';
import { FundTransfer }   from './fund-transfer.js';
import { MetricSet }      from './tracked-metric.js';
import {
  IncomeResult, ExpenseResult, MortgageResult,
  AssetAppreciationResult, InterestResult,
} from './results.js';
import { colorRange }    from './html.js';

const rgb2hex = (rgb) => `#${rgb.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/).slice(1).map(n => parseInt(n, 10).toString(16).padStart(2, '0')).join('')}`;

// ── Metric identity enum ─────────────────────────────────────────────
// Single source of truth for every tracked-metric key.

export const Metric = Object.freeze({
  VALUE:                    'value',
  EARNING:                  'earning',
  INCOME:                   'income',
  AFTER_TAX:                'afterTax',
  AFTER_EXPENSE:            'afterExpense',
  ACCUMULATED:              'accumulated',
  SHORT_TERM_CAPITAL_GAIN:  'shortTermCapitalGain',
  LONG_TERM_CAPITAL_GAIN:   'longTermCapitalGain',
  RMD:                      'rmd',
  SOCIAL_SECURITY:          'socialSecurity',
  MEDICARE:                 'medicare',
  INCOME_TAX:               'incomeTax',
  MORTGAGE_PAYMENT:         'mortgagePayment',
  MORTGAGE_INTEREST:        'mortgageInterest',
  MORTGAGE_PRINCIPAL:       'mortgagePrincipal',
  MORTGAGE_ESCROW:          'mortgageEscrow',
  ESTIMATED_TAX:            'estimatedTax',
  IRA_CONTRIBUTION:         'iraContribution',
  FOUR_01K_CONTRIBUTION:    'four01KContribution',
  IRA_DISTRIBUTION:         'iraDistribution',
  FOUR_01K_DISTRIBUTION:    'four01KDistribution',
  INTEREST_INCOME:          'interestIncome',
  CAPITAL_GAINS_TAX:        'capitalGainsTax',
  CREDIT:                   'credit',
});

const METRIC_NAMES = Object.values(Metric);

// Metrics that should NOT be zeroed on monthly snapshot
const KEEP_ON_SNAPSHOT = new Set([Metric.VALUE, Metric.ACCUMULATED]);


export class ModelAsset {
  /**
   * @param {Object} opts
   * @param {string}        opts.instrument
   * @param {string}        opts.displayName
   * @param {DateInt}        opts.startDateInt
   * @param {Currency}       opts.startCurrency
   * @param {Currency}       [opts.basisCurrency]
   * @param {DateInt}        opts.finishDateInt
   * @param {number}         [opts.monthsRemaining]
   * @param {ARR}            opts.annualReturnRate
   * @param {FundTransfer[]} [opts.fundTransfers]
   */
  constructor({
    instrument,
    displayName,
    startDateInt,
    startCurrency,
    basisCurrency = Currency.zero(),
    finishDateInt,
    monthsRemaining = 0,
    annualReturnRate,
    fundTransfers = [],
    isSelfEmployed = false,
  }) {
    this.instrument      = instrument;
    this.displayName     = displayName;
    this.startDateInt    = startDateInt;
    this.startCurrency   = startCurrency;
    this.basisCurrency   = basisCurrency;
    this.finishDateInt   = finishDateInt;
    this.monthsRemaining = Number.isInteger(monthsRemaining) ? monthsRemaining : 0;
    this.annualReturnRate = annualReturnRate;
    this.fundTransfers   = fundTransfers;
    this.isSelfEmployed  = isSelfEmployed;

    this.colorId       = 0;
    this.onFinishDate  = false;
    this.isClosed      = false;

    // Chronometer state
    this.finishCurrency = Currency.zero();
    this.monthsRemainingDynamic = this.monthsRemaining;
    this.metrics = new MetricSet(METRIC_NAMES);
  }

  // ── Factories ────────────────────────────────────────────────────

  static trackedMetricNames() {
    return METRIC_NAMES;
  }

  static fromJSON(obj) {
    return new ModelAsset({
      instrument:      obj.instrument,
      displayName:     obj.displayName,
      startDateInt:    new DateInt(obj.startDateInt.year * 100 + obj.startDateInt.month),
      startCurrency:   new Currency(obj.startCurrency.amount),
      basisCurrency:   new Currency(obj.basisCurrency?.amount ?? 0),
      finishDateInt:   new DateInt(obj.finishDateInt.year * 100 + obj.finishDateInt.month),
      monthsRemaining: obj.monthsRemaining ?? 0,
      annualReturnRate: new ARR(obj.annualReturnRate.annualReturnRate),
      fundTransfers:   (obj.fundTransfers ?? []).map(FundTransfer.fromJSON),
      isSelfEmployed:  obj.isSelfEmployed ?? false,
    });
  }

  static fromHTML(inputElements, colorElement) {
    const vals = {};
    for (const el of inputElements) {
      vals[el.name] = el;
    }

    let fundTransfers = [];
    if (vals.fundTransfers) {
      const raw = vals.fundTransfers.getAttribute('data-fundtransfers');
      if (raw) {
        const parsed = JSON.parse(atob(raw));
        fundTransfers = parsed.map(FundTransfer.fromJSON);
      }
    }

    const asset = new ModelAsset({
      instrument:      vals.instrument?.value,
      displayName:     vals.displayName?.value,
      startDateInt:    DateInt.parse(vals.startDate?.value),
      startCurrency:   Currency.parse(vals.startValue?.value),
      basisCurrency:   Currency.parse(vals.basisValue?.value),
      finishDateInt:   DateInt.parse(vals.finishDate?.value),
      monthsRemaining: parseInt(vals.monthsRemaining?.value, 10) || 0,
      annualReturnRate: ARR.parse(vals.annualReturnRate?.value),
      fundTransfers,
    });

    // Restore color
    if (colorElement) {
      const hex = rgb2hex(colorElement.style.backgroundColor);
      asset.colorId = colorRange.indexOf(hex);
    }

    return asset;
  }

  // ── Metric access (replaces 15 identical addMonthlyXxx methods) ──

  getMetrics() {
    return this.metrics;
  }

  getMetric(name) {
    return this.metrics.get(name);
  }

  /**
   * Add an amount to any tracked metric.
   * @param {string} metricName
   * @param {Currency} amount
   * @returns {Currency} current accumulated value
   */
  addToMetric(metricName, amount) {
    return this.metrics.get(metricName).add(amount);
  }

  /** Convenience aliases for the most commonly accessed metrics */
  get valueCurrency()   { return this.metrics.get(Metric.VALUE).current; }
  set valueCurrency(c)  { this.metrics.get(Metric.VALUE).current = c; }

  get earningCurrency()   { return this.metrics.get(Metric.EARNING).current; }
  set earningCurrency(c)  { this.metrics.get(Metric.EARNING).current = c; }

  get incomeCurrency()    { return this.metrics.get(Metric.INCOME).current; }
  set incomeCurrency(c)   { this.metrics.get(Metric.INCOME).current = c; }

  get afterTaxCurrency()  { return this.metrics.get(Metric.AFTER_TAX).current; }
  set afterTaxCurrency(c) { this.metrics.get(Metric.AFTER_TAX).current = c; }

  get creditCurrency()    { return this.metrics.get(Metric.CREDIT).current; }
  set creditCurrency(c)   { this.metrics.get(Metric.CREDIT).current = c; }

  get accumulatedCurrency()    { return this.metrics.get(Metric.ACCUMULATED).current; }
  set accumulatedCurrency(c)   { this.metrics.get(Metric.ACCUMULATED).current = c; }

  get rmdCurrency()                 { return this.metrics.get(Metric.RMD).current; }
  get iraDistributionCurrency()     { return this.metrics.get(Metric.IRA_DISTRIBUTION).current; }
  get four01KDistributionCurrency() { return this.metrics.get(Metric.FOUR_01K_DISTRIBUTION).current; }

  // Shorthand for history arrays (backwards compat with charting code)
  get monthlyValues()     { return this.metrics.get(Metric.VALUE).history; }
  get monthlyEarnings()   { return this.metrics.get(Metric.EARNING).history; }
  get monthlyIncomes()    { return this.metrics.get(Metric.INCOME).history; }
  get monthlyAfterTaxes() { return this.metrics.get(Metric.AFTER_TAX).history; }

  // ── Chronometer lifecycle ────────────────────────────────────────

  initializeChron() {
    this.finishCurrency = new Currency(this.startCurrency.amount);
    this.monthsRemainingDynamic = this.monthsRemaining;
    this.onFinishDate = false;
    this.isClosed = false;
    this.metrics.initializeAll();
  }

  monthlyChron() {

    // value and accumulated are special: add finishValue and earnings, then snapshot WITHOUT zeroing
    this.metrics.get(Metric.ACCUMULATED).add(this.earningCurrency);

    // Reconcile credit buffer
    const credit = this.creditCurrency;
    if (credit.amount > 0) {
      this.finishCurrency.add(credit);
    }

    this.metrics.get(Metric.VALUE).add(this.finishCurrency);

    // Snapshot all metrics (zero after, except 'accumulated')
    this.metrics.snapshotAll(KEEP_ON_SNAPSHOT);

  }

  yearlyChron() { /* hook for subclasses */ }
  finalizeChron() { /* hook for subclasses */ }

  // ── Monthly calculations ─────────────────────────────────────────

  applyMonthly() {
    const { instrument } = this;
    const T = InstrumentType;

    if (T.isMonthlyIncome(instrument))  return this.applyMonthlyIncomeSalary();
    if (T.isMonthlyExpense(instrument)) return this.applyMonthlyExpense();
    if (T.isMortgage(instrument))       return this.applyMonthlyMortgage();
    if (T.isCapital(instrument))        return this.applyMonthlyCapital();
    if (T.isIncomeAccount(instrument))  return this.applyMonthlyIncomeHoldings();

    return null;
  }

  applyMonthlyIncomeSalary() {
    this.ensurePositiveStart();
    this.earningCurrency = new Currency(this.finishCurrency.amount);
    this.incomeCurrency  = new Currency(this.finishCurrency.amount);

    return this.isSelfEmployed
      ? new IncomeResult(this.incomeCurrency.copy(), Currency.zero())
      : new IncomeResult(Currency.zero(), this.incomeCurrency.copy());
  }

  applyMonthlyExpense() {
    this.ensureNegativeStart();
    this.earningCurrency = new Currency(this.finishCurrency.amount);
    this.finishCurrency.multiply(1 + this.annualReturnRate.asMonthly());
    return new ExpenseResult(this.earningCurrency.copy(), this.finishCurrency.copy());
  }

  applyMonthlyMortgage() {
    this.ensureNegativeStart();
    const rate = this.annualReturnRate.asMonthly();
    const n = this.monthsRemainingDynamic;

    const payment   = (this.finishCurrency.amount * rate * Math.pow(1 + rate, n))
                    / (Math.pow(1 + rate, n) - 1);
    const interest  = new Currency(this.finishCurrency.amount * rate);
    const principal = new Currency(payment - interest.amount);

    this.monthsRemainingDynamic--;
    this.earningCurrency = principal.copy().flipSign();
    this.finishCurrency.subtract(principal);

    this.addToMetric(Metric.MORTGAGE_PAYMENT, new Currency(payment));
    this.addToMetric(Metric.MORTGAGE_INTEREST, interest);
    this.addToMetric(Metric.MORTGAGE_PRINCIPAL, principal);

    return new MortgageResult(principal, interest, Currency.zero());
  }

  applyMonthlyCapital() {
    if (this.onFinishDate) {
      this.earningCurrency = new Currency(this.finishCurrency.amount - this.basisCurrency.amount);
      this.incomeCurrency  = this.earningCurrency.copy();
      this.afterTaxCurrency = Currency.zero();
      return new AssetAppreciationResult(this.finishCurrency.copy(), this.earningCurrency.copy());
    }

    this.earningCurrency = new Currency(this.finishCurrency.amount * this.annualReturnRate.asMonthly());
    this.afterTaxCurrency = this.earningCurrency.copy();
    this.finishCurrency.add(this.earningCurrency);
    return new AssetAppreciationResult(this.finishCurrency.copy(), this.earningCurrency.copy());
  }

  applyMonthlyIncomeHoldings() {
    this.ensurePositiveStart();
    this.earningCurrency = new Currency(this.finishCurrency.amount * this.annualReturnRate.asMonthly());
    this.incomeCurrency  = this.earningCurrency.copy();
    this.finishCurrency.add(this.earningCurrency);
    return new InterestResult(this.incomeCurrency.copy());
  }

  applyYearly() {
    if (InstrumentType.isMonthlyIncome(this.instrument)) {
      this.finishCurrency = new Currency(this.finishCurrency.amount * (1 + this.annualReturnRate.rate));
    }
  }

  // ── Credit / Debit (fund transfer interface) ─────────────────────

  credit(amount) {
    if (this.#isFlowInstrument()) return Currency.zero();
    this.creditCurrency.add(amount);
    return this.reconcileCredit();
  }

  debit(amount) {
    if (this.#isFlowInstrument()) return Currency.zero();
    this.creditCurrency.subtract(amount);
    return this.reconcileCredit();
  }

  reconcileCredit() {
    if (this.creditCurrency.amount >= 0) return Currency.zero();

    const toDebit = this.creditCurrency.copy().flipSign();
    this.creditCurrency.zero();
    this.finishCurrency.subtract(toDebit);

    const T = InstrumentType;
    if (T.isTaxableAccount(this.instrument)) {
      this.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, toDebit);
    } else if (T.isIRA(this.instrument)) {
      this.addToMetric(Metric.IRA_DISTRIBUTION, toDebit);
    } else if (T.is401K(this.instrument)) {
      this.addToMetric(Metric.FOUR_01K_DISTRIBUTION, toDebit);
    }

    return toDebit;
  }

  // ── Fund transfers ───────────────────────────────────────────────

  hasFundTransfer(name) {
    return this.fundTransfers.some(ft => ft.toDisplayName === name);
  }

  bindFundTransfers(allModels) {
    for (const ft of this.fundTransfers) ft.bind(this, allModels);
  }

  zeroFundTransfersMoveValues() {
    for (const ft of this.fundTransfers) ft.moveValue = 0;
  }

  combinedFundTransfersMoveValue() {
    return this.fundTransfers.reduce((sum, ft) => sum + ft.moveValue, 0);
  }

  stochasticLimit(cap = 100) {
    if (this.fundTransfers.length <= 1) return;
    const total = this.combinedFundTransfersMoveValue();
    if (total <= cap) return;
    const scale = cap / total;
    for (const ft of this.fundTransfers) ft.moveValue *= scale;
  }

  dnaFundTransfers() {
    return this.fundTransfers
      .map(ft => ft.describe(this.displayName))
      .join('\n');
  }

  // ── Withholding ──────────────────────────────────────────────────

  deductWithholding(withholding) {
    this.afterTaxCurrency = this.earningCurrency.copy();
    this.addToMetric(Metric.SOCIAL_SECURITY, withholding.socialSecurity);
    this.addToMetric(Metric.MEDICARE, withholding.medicare);
    this.addToMetric(Metric.INCOME_TAX, withholding.income);
    this.afterTaxCurrency.add(withholding.total());
    return this.afterTaxCurrency.copy();
  }

  // ── Queries ──────────────────────────────────────────────────────

  inMonth(dateInt) {
    return dateInt.toInt() >= this.startDateInt.toInt()
        && dateInt.toInt() <= this.finishDateInt.toInt();
  }

  isFinishDateInt(d) {
    return d && this.finishDateInt.year === d.year && this.finishDateInt.month === d.month;
  }

  sortIndex() {
    return InstrumentType.sortOrder(this.instrument);
  }

  isPositive() { return this.accumulatedCurrency.amount > 0; }
  isNegative() { return this.accumulatedCurrency.amount < 0; }

  getFinishCurrencyForRollup() {
    const T = InstrumentType;
    const i = this.instrument;
    if (T.isMortgage(i) || T.isDebt(i) || T.isMonthlyExpense(i) || T.isMonthlyIncome(i)) {
      return this.accumulatedCurrency;
    }
    return this.finishCurrency;
  }

  close() {
    this.creditCurrency.zero();
    this.finishCurrency.zero();
    this.isClosed = true;
  }

  // ── Display data (for charting) ──────────────────────────────────

  buildDisplayData(monthsSpan, metricName, outputArrayName) {
    const source = this.metrics.has(metricName)
      ? this.metrics.get(metricName).history
      : this[metricName]; // fallback for monthlyValues

    this[outputArrayName] = [];
    for (let i = monthsSpan.offsetMonths; i < source.length; i += monthsSpan.combineMonths) {
      let total = 0;
      for (let j = 0; j < monthsSpan.combineMonths && i + j < source.length; j++) {
        total += source[i + j];
      }
      this[outputArrayName].push(total);
    }
  }

  /** Legacy method kept for backwards compatibility with charting code that expects `displayValueData`. 
  monthlyAssetDataToDisplayAssetData(monthsSpan) {
    this.displayAssetData = [];
    for (let i = monthsSpan.offsetMonths; i < this.monthlyValues.length; i += monthsSpan.combineMonths) {
      this.displayAssetData.push(this.monthlyValues[i]);
    }
  }

  monthlyEarningDataToDisplayEarningData(monthsSpan) {
    this.buildDisplayData(monthsSpan, 'monthlyEarnings', 'displayEarningData');
  }
  */

  monthlyDataArrayToDisplayData(monthsSpan, monthlyArrayName, displayArrayName) {
    this.buildDisplayData(monthsSpan, monthlyArrayName, displayArrayName);
  }

  // ── Copy ─────────────────────────────────────────────────────────

  copy() {
    const clone = new ModelAsset({
      instrument:      this.instrument,
      displayName:     this.displayName,
      startDateInt:    this.startDateInt,
      startCurrency:   this.startCurrency,
      basisCurrency:   this.basisCurrency,
      finishDateInt:   this.finishDateInt,
      monthsRemaining: this.monthsRemaining,
      annualReturnRate: this.annualReturnRate,
      fundTransfers:   this.fundTransfers.map(ft => ft.copy()),
      isSelfEmployed:  this.isSelfEmployed,
    });
    clone.finishCurrency = this.finishCurrency.copy();
    clone.colorId = this.colorId;
    return clone;
  }

  // ── Private helpers ──────────────────────────────────────────────

  #isFlowInstrument() {
    return InstrumentType.isMonthlyIncome(this.instrument)
        || InstrumentType.isMonthlyExpense(this.instrument);
  }

  ensurePositiveStart() {
    if (this.startCurrency.amount < 0) {
      this.startCurrency.amount *= -1;
      this.finishCurrency.amount *= -1;
    }
  }

  ensureNegativeStart() {
    if (this.startCurrency.amount > 0) {
      this.startCurrency.amount *= -1;
      this.finishCurrency.amount *= -1;
    }
  }
}
