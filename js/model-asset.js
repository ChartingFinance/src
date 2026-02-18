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
  VALUE:                        'value',
  GROWTH:                       'growth',
  DIVIDEND:                     'dividend',
  INTEREST_INCOME:              'interestIncome',
  ORDINARY_INCOME:              'ordinaryIncome',
  WORKING_INCOME:               'workingIncome', // subjct to FICA, Medicare, withholding
  INCOME:                       'income',
  EXPENSE:                      'expense',
  ESTIMATED_TAX:                'estimatedTax',
  INCOME_TAX:                   'incomeTax',
  EARNING:                      'earning',  
  EARNING_ACCUMULATED:          'earningAccumulated',
  SHORT_TERM_CAPITAL_GAIN:      'shortTermCapitalGain',
  LONG_TERM_CAPITAL_GAIN:       'longTermCapitalGain',
  RMD:                          'rmd',
  SOCIAL_SECURITY:              'socialSecurity',
  MEDICARE:                     'medicare',
  MORTGAGE_PAYMENT:             'mortgagePayment',
  MORTGAGE_INTEREST:            'mortgageInterest',
  MORTGAGE_PRINCIPAL:           'mortgagePrincipal',
  MORTGAGE_ESCROW:              'mortgageEscrow',
  TAXABLE_CONTRIBUTION:         'taxableContribution',
  IRA_CONTRIBUTION:             'iraContribution',
  FOUR_01K_CONTRIBUTION:        'four01KContribution',
  IRA_DISTRIBUTION:             'iraDistribution',
  FOUR_01K_DISTRIBUTION:        'four01KDistribution',
  TAXABLE_DISTRIBUTION:         'taxableDistribution', // these are distributions from taxable accounts as cash
  SHORT_TERM_CAPITAL_GAIN_TAX:  'shortTermCapitalGain',
  LONG_TERM_CAPITAL_GAIN_TAX:   'longTermCapitalGain',
  CAPITAL_GAIN_TAX:             'capitalGainTax',
  CREDIT:                       'credit',
});

const METRIC_NAMES = Object.values(Metric);

export const MetricLabel = Object.freeze({
  [Metric.VALUE]:                       'Value',
  [Metric.GROWTH]:                      'Growth',
  [Metric.DIVIDEND]:                    'Dividend',
  [Metric.INTEREST_INCOME]:             'Interest Income',
  [Metric.ORDINARY_INCOME]:             'Ordinary Income',
  [Metric.WORKING_INCOME]:              'Working Income',
  [Metric.INCOME]:                      'Income',
  [Metric.EXPENSE]:                     'Expense',
  [Metric.ESTIMATED_TAX]:               'Estimated Tax',
  [Metric.INCOME_TAX]:                  'Income Tax',
  [Metric.EARNING]:                     'Earning',
  [Metric.EARNING_ACCUMULATED]:         'Earning Accumulated',
  [Metric.SHORT_TERM_CAPITAL_GAIN]:     'Short Term Capital Gain',
  [Metric.LONG_TERM_CAPITAL_GAIN]:      'Long Term Capital Gain',
  [Metric.RMD]:                         'Required Min. Distribution',
  [Metric.SOCIAL_SECURITY]:             'Social Security',
  [Metric.MEDICARE]:                    'Medicare',
  [Metric.MORTGAGE_PAYMENT]:            'Mortgage Payment',
  [Metric.MORTGAGE_INTEREST]:           'Mortgage Interest',
  [Metric.MORTGAGE_PRINCIPAL]:          'Mortgage Principal',
  [Metric.MORTGAGE_ESCROW]:             'Mortgage Escrow',
  [Metric.ESTIMATED_TAX]:               'Estimated Tax',
  [Metric.TAXABLE_CONTRIBUTION]:        'Taxable Contribution',
  [Metric.IRA_CONTRIBUTION]:            'IRA Contribution',
  [Metric.FOUR_01K_CONTRIBUTION]:       '401K Contribution',
  [Metric.IRA_DISTRIBUTION]:            'IRA Distribution',
  [Metric.FOUR_01K_DISTRIBUTION]:       '401K Distribution',
  [Metric.TAXABLE_DISTRIBUTION]:        'Taxable Distribution', // these are distributions from taxable accounts as cash
  [Metric.SHORT_TERM_CAPITAL_GAIN_TAX]: 'Short Term Capital Gain Tax', // these are distributions from taxable accounts taxed as short term gains
  [Metric.LONG_TERM_CAPITAL_GAIN_TAX]:  'Long Term Capital Gain Tax',  // these are distriubtions from taxable accounts taxed as long term gains
  [Metric.CAPITAL_GAIN_TAX]:            'Capital Gains Tax',
  [Metric.CREDIT]:                      'Credit',
});

// Metrics that should NOT be zeroed on monthly snapshot
const KEEP_ON_SNAPSHOT = new Set([Metric.ACCUMULATED]);


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
    annualDividendRate = new ARR(0),
    longTermCapitalGainRate = new ARR(0),
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
    this.annualDividendRate = annualDividendRate;
    this.longTermCapitalGainRate = longTermCapitalGainRate;
    this.annualReturnRate = annualReturnRate;
    this.fundTransfers   = fundTransfers;
    this.isSelfEmployed  = isSelfEmployed;

    this.colorId       = 0;
    this.beforeStartDate = false;
    this.onOrAfterStateDate = false;
    this.onOrBeforeFinishDate  = false;
    this.afterFinishDate = false;
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
      annualDividendRate: new ARR(obj.annualDividendRate?.annualReturnRate ?? obj.annualDividendRate?.rate ?? 0),
      longTermCapitalGainRate: new ARR(obj.longTermCapitalGainRate?.annualReturnRate ?? obj.longTermCapitalGainRate?.rate ?? 0),
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
      annualDividendRate: vals.dividendRate ? ARR.parse(vals.dividendRate.value) : new ARR(0),
      longTermCapitalGainRate: vals.longTermRate ? ARR.parse(vals.longTermRate.value) : new ARR(0),
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

  get growthCurrency()   { return this.metrics.get(Metric.GROWTH).current; }
  set growthCurrency(c)  { this.metrics.get(Metric.GROWTH).current = c; }

  get dividendCurrency()   { return this.metrics.get(Metric.DIVIDEND).current; }
  set dividendCurrency(c)  { this.metrics.get(Metric.DIVIDEND).current = c; }

  get incomeCurrency()    { return this.metrics.get(Metric.INCOME).current; }
  set incomeCurrency(c)   { this.metrics.get(Metric.INCOME).current = c; }

  get expenseCurrency()   { return this.metrics.get(Metric.EXPENSE).current; }
  set expenseCurrency(c)  { this.metrics.get(Metric.EXPENSE).current = c; }

  get earningCurrency()   { return this.metrics.get(Metric.EARNING).current; }
  set earningCurrency(c)  { this.metrics.get(Metric.EARNING).current = c; }

  get creditCurrency()    { return this.metrics.get(Metric.CREDIT).current; }
  set creditCurrency(c)   { this.metrics.get(Metric.CREDIT).current = c; }

  get accumulatedCurrency()    { return this.metrics.get(Metric.EARNING_ACCUMULATED).current; }
  set accumulatedCurrency(c)   { this.metrics.get(Metric.EARNING_ACCUMULATED).current = c; }

  get rmdCurrency()                 { return this.metrics.get(Metric.RMD).current; }
  get iraDistributionCurrency()     { return this.metrics.get(Metric.IRA_DISTRIBUTION).current; }
  get four01KDistributionCurrency() { return this.metrics.get(Metric.FOUR_01K_DISTRIBUTION).current; }

  // Shorthand for history arrays (backwards compat with charting code)
  get monthlyValues()     { return this.metrics.get(Metric.VALUE).history; }
  get monthlyGrowths()    { return this.metrics.get(Metric.GROWTH).history; }
  get monthlyDividends() { return this.metrics.get(Metric.DIVIDEND).history; }
  get monthlyIncomes()    { return this.metrics.get(Metric.INCOME).history; }
  get monthlyEarnings()   { return this.metrics.get(Metric.EARNING).history; }
  get monthlyTaxes()      { return this.metrics.get(Metric.INCOME_TAX).history; }


  // ── Chronometer lifecycle ────────────────────────────────────────

  initializeChron() {

    this.finishCurrency = new Currency(0);
    this.monthsRemainingDynamic = this.monthsRemaining;
    this.beforeStartDate = false;
    this.onStateDate = false;
    this.onFinishDate  = false;
    this.afterFinishDate = false;
    this.isClosed = false;
    this.metrics.initializeAll();

  }

  handleCurrentDateInt(currentDateInt) {

    // see if we are active or not
    if (this.inMonth(currentDateInt)) {

      this.beforeStartDate = false;      
      this.afterFinishDate = false;
      this.onStartDate = (currentDateInt.toInt() == this.startDateInt.toInt());
      this.onFinishDate = (currentDateInt.toInt() == this.finishDateInt.toInt());

    } else {

      if (currentDateInt.toInt() < this.startDateInt.toInt()) {

        this.beforeStartDate = true;
        this.onStartDate = false;
        this.onFinishDate = false;
        this.afterFinishDate = false;

      } else if (currentDateInt.toInt() > this.finishDateInt.toInt()) {

        this.beforeStartDate = false;
        this.onStartDate = false;
        this.onFinishDate = false;      
        this.afterFinishDate = true;

      }

      else {

        console.warn(`Unexpected dateInt comparison for asset ${this.displayName}`);

      }

    }

  }

  monthlyChron() {   

    // value and accumulated are special: add finishValue and earnings, then snapshot WITHOUT zeroing
    this.metrics.get(Metric.EARNING_ACCUMULATED).add(this.earningCurrency);

    /* Was thinking of reconciling credit here, but it makes more sense to do it at the end of the month after all monthly changes have been applied, so that the metric history reflects the true "credit" activity rather than an artificial netting of credit against value changes. Keeping this code here as a reminder that credit reconciliation still needs to happen somewhere.
    // Reconcile credit buffer
    const credit = this.creditCurrency;
    if (credit.amount > 0) {
      this.finishCurrency.add(credit);
    }
    */

    this.metrics.get(Metric.VALUE).add(this.finishCurrency);

    // Snapshot all metrics (zero after, except 'accumulated')
    this.metrics.snapshotAll(KEEP_ON_SNAPSHOT);

  }

  yearlyChron() { /* hook for subclasses */ }
  finalizeChron() { /* hook for subclasses */ }

  // ── Monthly calculations ─────────────────────────────────────────

  applyFirstDayOfMonth(currentDateInt) {

    this.monthlyValueChange = Currency.zero();

    this.handleCurrentDateInt(currentDateInt);

    if (this.beforeStartDate || this.afterFinishDate) {

      this.finishCurrency.zero();

    }

    else if (this.onStartDate) {

      this.finishCurrency = this.startCurrency.copy();

    }

    this.firstDayOfMonthValue = this.finishCurrency.copy();

  }

  applyLastDayOfMonth(currentDateInt) {  

    // check against the sum of values + credits
    let lastDayOfMonthValue = this.finishCurrency.copy();
    let firstDayOfMonthValuePlusMonthlyValueChange = this.firstDayOfMonthValue.copy().add(this.monthlyValueChange);
    
    if (lastDayOfMonthValue.toFixed() !== firstDayOfMonthValuePlusMonthlyValueChange.toFixed()) {
      if (this.onFinishDate) {
        // we expect onFinishDate that this.finishCurrency will be zero
        if (this.finishCurrency.amount !== 0) {
          console.warn(`Value mismatch onFinishDate for ${this.displayName} on ${currentDateInt.toString()}: expected finishCurrency to be zero but got ${this.finishCurrency.toCurrency()}`);
          debugger;
        }
      }
      else {
        console.warn(`Value mismatch for ${this.displayName} on ${currentDateInt.toString()}: firstDayOfMonthValue (${this.firstDayOfMonthValue.toCurrency()}) + monthlyValueChange (${this.monthlyValueChange.toCurrency()}) = ${firstDayOfMonthValuePlusMonthlyValueChange.toCurrency()} but lastDayOfMonthValue is ${lastDayOfMonthValue.toCurrency()}`);
        debugger;
      }
    }    

  }

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
    this.incomeCurrency  = new Currency(this.finishCurrency.amount);
    // growth in income happens yearly

    return this.isSelfEmployed
      ? new IncomeResult(this.incomeCurrency.copy(), Currency.zero())
      : new IncomeResult(Currency.zero(), this.incomeCurrency.copy());

  }

  applyMonthlyExpense() {

    this.ensureNegativeStart();
    this.expenseCurrency = new Currency(this.finishCurrency.amount);
    this.growthCurrency = new Currency(this.finishCurrency.amount * this.annualReturnRate.asMonthly());
    this.finishCurrency.add(this.growthCurrency);
    this.monthlyValueChange.add(this.growthCurrency);

    return new ExpenseResult(this.expenseCurrency.copy(), this.finishCurrency.copy());

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
    this.growthCurrency = principal.copy().flipSign();
    this.finishCurrency.subtract(principal);
    this.monthlyValueChange.subtract(principal);

    this.addToMetric(Metric.MORTGAGE_PAYMENT, new Currency(payment));
    this.addToMetric(Metric.MORTGAGE_INTEREST, interest);
    this.addToMetric(Metric.MORTGAGE_PRINCIPAL, principal);

    return new MortgageResult(principal, interest, Currency.zero());
  }

  applyMonthlyCapital() {

    if (this.annualDividendRate.rate != 0.0) {

      this.dividendCurrency = new Currency(this.finishCurrency.amount * this.annualDividendRate.asMonthly());
      this.finishCurrency.add(this.dividendCurrency);
      this.monthlyValueChange.add(this.dividendCurrency);

    }

    this.growthCurrency = new Currency(this.finishCurrency.amount * this.annualReturnRate.asMonthly());
    this.finishCurrency.add(this.growthCurrency);
    this.monthlyValueChange.add(this.growthCurrency);

    return new AssetAppreciationResult(this.finishCurrency.copy(), this.growthCurrency.copy(), this.dividendCurrency.copy(), Currency.zero());

  }

  applyMonthlyIncomeHoldings() {

    this.ensurePositiveStart();
    this.incomeCurrency = new Currency(this.finishCurrency.amount * this.annualReturnRate.asMonthly());
    this.finishCurrency.add(this.incomeCurrency);
    this.monthlyValueChange.add(this.incomeCurrency);

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
    this.monthlyValueChange.add(amount);
    return this.reconcileCredit();

  }

  debit(amount) {

    if (this.#isFlowInstrument()) return Currency.zero();
    this.creditCurrency.subtract(amount);
    this.monthlyValueChange.subtract(amount);
    return this.reconcileCredit();

  }

  reconcileCredit() {

    //if (this.creditCurrency.amount >= 0) return Currency.zero();

    let credit = this.creditCurrency.copy();
    this.creditCurrency.zero();

    this.finishCurrency.add(credit);    

    const T = InstrumentType;
    if (credit.amount > 0) {
      if (T.isTaxableAccount(this.instrument)) {
        this.addToMetric(Metric.TAXABLE_CONTRIBUTION, credit);
      } else if (T.isIRA(this.instrument)) {
        this.addToMetric(Metric.IRA_CONTRIBUTION, credit);
      } else if (T.is401K(this.instrument)) {
        this.addToMetric(Metric.FOUR_01K_CONTRIBUTION, credit);
      }
    }
    if (credit.amount < 0) {    
      if (T.isTaxableAccount(this.instrument)) {
        // TODO: need to distinguish between taxable distribution as cash (TAXABLE_DISTRIBUTION) vs taxable distribution as gain (SHORT_TERM_CAPITAL_GAIN_TAX or LONG_TERM_CAPITAL_GAIN_TAX depending on holding period)
        this.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, credit); // for now just assume all distributions from taxable accounts are long term capital gains, but this is an area for improvement
      } else if (T.isIRA(this.instrument)) {
        this.addToMetric(Metric.IRA_DISTRIBUTION, credit);
      } else if (T.is401K(this.instrument)) {
        this.addToMetric(Metric.FOUR_01K_DISTRIBUTION, credit);
      }
    }

    return credit;

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

    const source = this.metrics.get(metricName).history;

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
      annualDividendRate: this.annualDividendRate,
      longTermCapitalGainRate: this.longTermCapitalGainRate,
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
