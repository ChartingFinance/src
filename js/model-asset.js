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
  AssetAppreciationResult, InterestResult, CreditMemo,
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
  WITHHELD_FICA_TAX:            'withheldFicaTax',
  ESTIMATED_FICA_TAX:           'estimatedFicaTax',
  WITHHELD_INCOME_TAX:          'withheldIncomeTax',
  ESTIMATED_INCOME_TAX:         'estimatedIncomeTax',
  ESTIMATED_TAX:                'estimatedTax',
  INCOME_TAX:                   'incomeTax',
  NET_INCOME:                   'netIncome',
  EXPENSE:                      'expense',
  CASH_FLOW:                    'cashFlow',
  CASH_FLOW_ACCUMULATED:        'cashFlowAccumulated',
  SHORT_TERM_CAPITAL_GAIN:      'shortTermCapitalGain',
  LONG_TERM_CAPITAL_GAIN:       'longTermCapitalGain',
  CAPITAL_GAIN:                 'capitalGain', // combine short and long term
  RMD:                          'rmd',
  SOCIAL_SECURITY:              'socialSecurity',
  MEDICARE:                     'medicare',
  MORTGAGE_PAYMENT:             'mortgagePayment',
  MORTGAGE_INTEREST:            'mortgageInterest',
  MORTGAGE_PRINCIPAL:           'mortgagePrincipal',
  PROPERTY_TAX:                 'propertyTax',
  MORTGAGE_ESCROW:              'mortgageEscrow',
  TAXABLE_CONTRIBUTION:         'taxableContribution',
  IRA_CONTRIBUTION:             'iraContribution',
  FOUR_01K_CONTRIBUTION:        'four01KContribution',
  IRA_DISTRIBUTION:             'iraDistribution',
  FOUR_01K_DISTRIBUTION:        'four01KDistribution',
  TAXABLE_DISTRIBUTION:         'taxableDistribution', // these are distributions from taxable accounts as cash
  SHORT_TERM_CAPITAL_GAIN_TAX:  'shortTermCapitalGainTax',
  LONG_TERM_CAPITAL_GAIN_TAX:   'longTermCapitalGainTax',
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
  [Metric.INCOME]:                      'Income', // rolls up ordinary, interest, and working income (i.e. everything that is considered income for tax purposes)
  [Metric.WITHHELD_FICA_TAX]:           'Withheld FICA / Medicare',
  [Metric.ESTIMATED_FICA_TAX]:          'Estimated FICA / Medicare',
  [Metric.WITHHELD_INCOME_TAX]:         'Estimated Income Tax',
  [Metric.ESTIMATED_INCOME_TAX]:        'Withheld Tax',
  [Metric.ESTIMATED_TAX]:               'Estimated Tax',
  [Metric.INCOME_TAX]:                  'Income Tax',
  [Metric.NET_INCOME]:                  'Net Income', // after withholding and estimated taxes
  [Metric.EXPENSE]:                     'Expense',  
  [Metric.CASH_FLOW]:                   'Cash Flow',
  [Metric.CASH_FLOW_ACCUMULATED]:       'Cash Flow Accumulated',
  [Metric.SHORT_TERM_CAPITAL_GAIN]:     'Short Term Capital Gain',
  [Metric.LONG_TERM_CAPITAL_GAIN]:      'Long Term Capital Gain',
  [Metric.CAPITAL_GAIN]:                'Capital Gain',
  [Metric.RMD]:                         'Required Min. Distribution',
  [Metric.SOCIAL_SECURITY]:             'Social Security',
  [Metric.MEDICARE]:                    'Medicare',
  [Metric.MORTGAGE_PAYMENT]:            'Mortgage Payment',
  [Metric.MORTGAGE_INTEREST]:           'Mortgage Interest',
  [Metric.MORTGAGE_PRINCIPAL]:          'Mortgage Principal',
  [Metric.MORTGAGE_ESCROW]:             'Mortgage Escrow',  
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
const KEEP_ON_SNAPSHOT = new Set([Metric.CASH_FLOW_ACCUMULATED]);


export class ModelAsset {
  #metrics;

  /**
   * @param {Object} opts
   * @param {string}        opts.instrument
   * @param {string}        opts.displayName
   * @param {DateInt}        opts.startDateInt
   * @param {Currency}       opts.startCurrency
   * @param {Currency}       [opts.startBasisCurrency]
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
    startBasisCurrency = Currency.zero(),
    finishDateInt,
    monthsRemaining = 0,
    annualReturnRate,
    annualDividendRate = new ARR(0),
    longTermCapitalHoldingPercentage = new ARR(0),
    fundTransfers = [],
    isSelfEmployed = false,
    annualTaxRate = new ARR(0),
  }) {
    this.instrument      = instrument;
    this.displayName     = displayName;
    this.startDateInt    = startDateInt;
    this.startCurrency   = startCurrency;
    this.startBasisCurrency = startBasisCurrency;
    this.finishBasisCurrency = new Currency(startBasisCurrency.amount);
    this.finishDateInt   = finishDateInt;
    this.monthsRemaining = Number.isInteger(monthsRemaining) ? monthsRemaining : 0;
    this.annualDividendRate = annualDividendRate;
    this.longTermCapitalHoldingPercentage = longTermCapitalHoldingPercentage;
    this.annualReturnRate = annualReturnRate;
    this.fundTransfers   = fundTransfers;
    this.isSelfEmployed  = isSelfEmployed;
    this.annualTaxRate   = annualTaxRate;

    this.colorId       = 0;
    this.beforeStartDate = false;
    this.onOrAfterStateDate = false;
    this.onOrBeforeFinishDate  = false;
    this.afterFinishDate = false;
    this.isClosed      = false;

    // Chronometer state
    this.finishCurrency = Currency.zero();
    this.monthsRemainingDynamic = this.monthsRemaining;
    this.#metrics = new MetricSet(METRIC_NAMES);
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
      startBasisCurrency: new Currency(obj.startBasisCurrency?.amount ?? obj.basisCurrency?.amount ?? 0),
      finishDateInt:   new DateInt(obj.finishDateInt.year * 100 + obj.finishDateInt.month),
      monthsRemaining: obj.monthsRemaining ?? 0,
      annualReturnRate: new ARR(obj.annualReturnRate?.annualReturnRate ?? obj.annualReturnRate?.rate ?? 0),
      annualDividendRate: new ARR(obj.annualDividendRate?.annualReturnRate ?? obj.annualDividendRate?.rate ?? 0),
      longTermCapitalHoldingPercentage: new ARR(obj.longTermCapitalHoldingPercentage?.annualReturnRate ?? obj.longTermCapitalHoldingPercentage?.rate ?? 0),
      fundTransfers:   (obj.fundTransfers ?? []).map(FundTransfer.fromJSON),
      isSelfEmployed:  obj.isSelfEmployed ?? false,
      annualTaxRate:   new ARR(obj.annualTaxRate?.annualReturnRate ?? obj.annualTaxRate?.rate ?? 0),
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
      startBasisCurrency: Currency.parse(vals.startBasisValue?.value),
      finishDateInt:   DateInt.parse(vals.finishDate?.value),
      monthsRemaining: parseInt(vals.monthsRemaining?.value, 10) || 0,
      annualReturnRate: ARR.parse(vals.annualReturnRate?.value),
      annualDividendRate: vals.dividendRate ? ARR.parse(vals.dividendRate.value) : new ARR(0),
      longTermCapitalHoldingPercentage: vals.longTermRate ? ARR.parse(vals.longTermRate.value) : new ARR(0),
      fundTransfers,
      isSelfEmployed: vals.isSelfEmployed?.type === 'checkbox'
        ? vals.isSelfEmployed.checked
        : vals.isSelfEmployed?.value === 'true',
      annualTaxRate: vals.annualTaxRate ? ARR.parse(vals.annualTaxRate.value) : new ARR(0),
    });

    // Restore color
    if (colorElement) {
      const hex = rgb2hex(colorElement.style.backgroundColor);
      asset.colorId = colorRange.indexOf(hex);
    }

    return asset;
  }

  // ── Metric access ───────────────────────────────────────────────

  /**
   * Add an amount to any tracked metric.
   * Handles automatic rollup to aggregate metrics (e.g. capital gains → income).
   * @param {string} metricName
   * @param {Currency} amount
   * @returns {Currency} current accumulated value
   */
  addToMetric(metricName, amount) {

    if (metricName == Metric.SHORT_TERM_CAPITAL_GAIN || metricName == Metric.LONG_TERM_CAPITAL_GAIN) {
      this.#metrics.get(Metric.CAPITAL_GAIN).add(amount);
      this.#metrics.get(Metric.INCOME).add(amount);
    }

    if (metricName == Metric.SHORT_TERM_CAPITAL_GAIN_TAX || metricName == Metric.LONG_TERM_CAPITAL_GAIN_TAX) {
      this.#metrics.get(Metric.CAPITAL_GAIN_TAX).add(amount);
      this.#metrics.get(Metric.INCOME_TAX).add(amount);
    }

    if (metricName == Metric.ORDINARY_INCOME || metricName == Metric.INTEREST_INCOME || metricName == Metric.WORKING_INCOME) {
      this.#metrics.get(Metric.INCOME).add(amount);
    }

    return this.#metrics.get(metricName).add(amount);
  }

  /** Iterate over all tracked metrics (used by display-data builders). */
  [Symbol.iterator]() {
    return this.#metrics[Symbol.iterator]();
  }

  /** Get the display-aligned history array for a named metric. */
  getDisplayHistory(metricName) {
    return this.#metrics.get(metricName).displayHistory;
  }

  /** Build display histories for all metrics at once. */
  buildAllDisplayHistories(monthsSpan) {
    for (let metric of this.#metrics) {
      metric.buildDisplayHistory(monthsSpan);
    }
  }

  // ── Currency get/set properties (current accumulator) ─────────

  get valueCurrency()   { return this.#metrics.get(Metric.VALUE).current; }
  set valueCurrency(c)  { this.#metrics.get(Metric.VALUE).current = c; }

  get growthCurrency()   { return this.#metrics.get(Metric.GROWTH).current; }
  set growthCurrency(c)  { this.#metrics.get(Metric.GROWTH).current = c; }

  get dividendCurrency()   { return this.#metrics.get(Metric.DIVIDEND).current; }
  set dividendCurrency(c)  { this.#metrics.get(Metric.DIVIDEND).current = c; }

  get interestIncomeCurrency()   { return this.#metrics.get(Metric.INTEREST_INCOME).current; }
  set interestIncomeCurrency(c)  { this.#metrics.get(Metric.INTEREST_INCOME).current = c; }

  get ordinaryIncomeCurrency()   { return this.#metrics.get(Metric.ORDINARY_INCOME).current; }
  set ordinaryIncomeCurrency(c)  { this.#metrics.get(Metric.ORDINARY_INCOME).current = c; }

  get workingIncomeCurrency()   { return this.#metrics.get(Metric.WORKING_INCOME).current; }
  set workingIncomeCurrency(c)  { this.#metrics.get(Metric.WORKING_INCOME).current = c; }

  get incomeCurrency()    { return this.#metrics.get(Metric.INCOME).current; }
  set incomeCurrency(c)   { this.#metrics.get(Metric.INCOME).current = c; }

  get expenseCurrency()   { return this.#metrics.get(Metric.EXPENSE).current; }
  set expenseCurrency(c)  { this.#metrics.get(Metric.EXPENSE).current = c; }

  get cashFlowCurrency()   { return this.#metrics.get(Metric.CASH_FLOW).current; }
  set cashFlowCurrency(c)  { this.#metrics.get(Metric.CASH_FLOW).current = c; }

  get creditCurrency()    { return this.#metrics.get(Metric.CREDIT).current; }
  set creditCurrency(c)   { this.#metrics.get(Metric.CREDIT).current = c; }

  get netIncomeCurrency()    { return this.#metrics.get(Metric.NET_INCOME).current; }
  set netIncomeCurrency(c)   { this.#metrics.get(Metric.NET_INCOME).current = c; }

  get cashFlowAccumulatedCurrency()    { return this.#metrics.get(Metric.CASH_FLOW_ACCUMULATED).current; }
  set cashFlowAccumulatedCurrency(c)   { this.#metrics.get(Metric.CASH_FLOW_ACCUMULATED).current = c; }

  get shortTermCapitalGainCurrency()   { return this.#metrics.get(Metric.SHORT_TERM_CAPITAL_GAIN).current; }
  set shortTermCapitalGainCurrency(c)  { this.#metrics.get(Metric.SHORT_TERM_CAPITAL_GAIN).current = c; }

  get longTermCapitalGainCurrency()   { return this.#metrics.get(Metric.LONG_TERM_CAPITAL_GAIN).current; }
  set longTermCapitalGainCurrency(c)  { this.#metrics.get(Metric.LONG_TERM_CAPITAL_GAIN).current = c; }

  get capitalGainCurrency()   { return this.#metrics.get(Metric.CAPITAL_GAIN).current; }
  set capitalGainCurrency(c)  { this.#metrics.get(Metric.CAPITAL_GAIN).current = c; }

  get rmdCurrency()   { return this.#metrics.get(Metric.RMD).current; }
  set rmdCurrency(c)  { this.#metrics.get(Metric.RMD).current = c; }

  get socialSecurityCurrency()   { return this.#metrics.get(Metric.SOCIAL_SECURITY).current; }
  set socialSecurityCurrency(c)  { this.#metrics.get(Metric.SOCIAL_SECURITY).current = c; }

  get medicareCurrency()   { return this.#metrics.get(Metric.MEDICARE).current; }
  set medicareCurrency(c)  { this.#metrics.get(Metric.MEDICARE).current = c; }

  get withheldFicaTaxCurrency()   { return this.#metrics.get(Metric.WITHHELD_FICA_TAX).current; }
  set withheldFicaTaxCurrency(c)  { this.#metrics.get(Metric.WITHHELD_FICA_TAX).current = c; }

  get estimatedFicaTaxCurrency()   { return this.#metrics.get(Metric.ESTIMATED_FICA_TAX).current; }
  set estimatedFicaTaxCurrency(c)  { this.#metrics.get(Metric.ESTIMATED_FICA_TAX).current = c; }

  get withheldIncomeTaxCurrency()   { return this.#metrics.get(Metric.WITHHELD_INCOME_TAX).current; }
  set withheldIncomeTaxCurrency(c)  { this.#metrics.get(Metric.WITHHELD_INCOME_TAX).current = c; }

  get estimatedIncomeTaxCurrency()    { return this.#metrics.get(Metric.ESTIMATED_INCOME_TAX).current; }
  set estimatedIncomeTaxCurrency(c)   { this.#metrics.get(Metric.ESTIMATED_INCOME_TAX).current = c; }

  get estimatedTaxCurrency()   { return this.#metrics.get(Metric.ESTIMATED_TAX).current; }
  set estimatedTaxCurrency(c)  { this.#metrics.get(Metric.ESTIMATED_TAX).current = c; }

  get incomeTaxCurrency()    { return this.#metrics.get(Metric.INCOME_TAX).current; }
  set incomeTaxCurrency(c)   { this.#metrics.get(Metric.INCOME_TAX).current = c; }

  get shortTermCapitalGainTaxCurrency()   { return this.#metrics.get(Metric.SHORT_TERM_CAPITAL_GAIN_TAX).current; }
  set shortTermCapitalGainTaxCurrency(c)  { this.#metrics.get(Metric.SHORT_TERM_CAPITAL_GAIN_TAX).current = c; }

  get longTermCapitalGainTaxCurrency()   { return this.#metrics.get(Metric.LONG_TERM_CAPITAL_GAIN_TAX).current; }
  set longTermCapitalGainTaxCurrency(c)  { this.#metrics.get(Metric.LONG_TERM_CAPITAL_GAIN_TAX).current = c; }

  get capitalGainTaxCurrency()   { return this.#metrics.get(Metric.CAPITAL_GAIN_TAX).current; }
  set capitalGainTaxCurrency(c)  { this.#metrics.get(Metric.CAPITAL_GAIN_TAX).current = c; }

  get mortgagePaymentCurrency()   { return this.#metrics.get(Metric.MORTGAGE_PAYMENT).current; }
  set mortgagePaymentCurrency(c)  { this.#metrics.get(Metric.MORTGAGE_PAYMENT).current = c; }

  get mortgageInterestCurrency()   { return this.#metrics.get(Metric.MORTGAGE_INTEREST).current; }
  set mortgageInterestCurrency(c)  { this.#metrics.get(Metric.MORTGAGE_INTEREST).current = c; }

  get mortgagePrincipalCurrency()   { return this.#metrics.get(Metric.MORTGAGE_PRINCIPAL).current; }
  set mortgagePrincipalCurrency(c)  { this.#metrics.get(Metric.MORTGAGE_PRINCIPAL).current = c; }

  get propertyTaxCurrency()   { return this.#metrics.get(Metric.PROPERTY_TAX).current; }
  set propertyTaxCurrency(c)  { this.#metrics.get(Metric.PROPERTY_TAX).current = c; }

  get mortgageEscrowCurrency()   { return this.#metrics.get(Metric.MORTGAGE_ESCROW).current; }
  set mortgageEscrowCurrency(c)  { this.#metrics.get(Metric.MORTGAGE_ESCROW).current = c; }

  get taxableContributionCurrency()   { return this.#metrics.get(Metric.TAXABLE_CONTRIBUTION).current; }
  set taxableContributionCurrency(c)  { this.#metrics.get(Metric.TAXABLE_CONTRIBUTION).current = c; }

  get iraContributionCurrency()   { return this.#metrics.get(Metric.IRA_CONTRIBUTION).current; }
  set iraContributionCurrency(c)  { this.#metrics.get(Metric.IRA_CONTRIBUTION).current = c; }

  get four01KContributionCurrency()   { return this.#metrics.get(Metric.FOUR_01K_CONTRIBUTION).current; }
  set four01KContributionCurrency(c)  { this.#metrics.get(Metric.FOUR_01K_CONTRIBUTION).current = c; }

  get iraDistributionCurrency()   { return this.#metrics.get(Metric.IRA_DISTRIBUTION).current; }
  set iraDistributionCurrency(c)  { this.#metrics.get(Metric.IRA_DISTRIBUTION).current = c; }

  get four01KDistributionCurrency()   { return this.#metrics.get(Metric.FOUR_01K_DISTRIBUTION).current; }
  set four01KDistributionCurrency(c)  { this.#metrics.get(Metric.FOUR_01K_DISTRIBUTION).current = c; }

  get taxableDistributionCurrency()   { return this.#metrics.get(Metric.TAXABLE_DISTRIBUTION).current; }
  set taxableDistributionCurrency(c)  { this.#metrics.get(Metric.TAXABLE_DISTRIBUTION).current = c; }

  // ── History array getters (for spreadsheet-view and charting) ──

  get monthlyValues()                { return this.#metrics.get(Metric.VALUE).history; }
  get monthlyGrowths()               { return this.#metrics.get(Metric.GROWTH).history; }
  get monthlyDividends()             { return this.#metrics.get(Metric.DIVIDEND).history; }
  get monthlyIncomes()               { return this.#metrics.get(Metric.INCOME).history; }
  get monthlyCashFlows()              { return this.#metrics.get(Metric.CASH_FLOW).history; }
  get monthlyTaxes()                 { return this.#metrics.get(Metric.INCOME_TAX).history; }
  get monthlyCashFlowAccumulateds()   { return this.#metrics.get(Metric.CASH_FLOW_ACCUMULATED).history; }
  get monthlyShortTermCapitalGains() { return this.#metrics.get(Metric.SHORT_TERM_CAPITAL_GAIN).history; }
  get monthlyLongTermCapitalGains()  { return this.#metrics.get(Metric.LONG_TERM_CAPITAL_GAIN).history; }
  get monthlyRMDs()                  { return this.#metrics.get(Metric.RMD).history; }
  get monthlySocialSecurities()      { return this.#metrics.get(Metric.SOCIAL_SECURITY).history; }
  get monthlyMedicares()             { return this.#metrics.get(Metric.MEDICARE).history; }
  get monthlyIncomeTaxes()           { return this.#metrics.get(Metric.INCOME_TAX).history; }
  get monthlyMortgagePayments()      { return this.#metrics.get(Metric.MORTGAGE_PAYMENT).history; }
  get monthlyMortgageInterests()     { return this.#metrics.get(Metric.MORTGAGE_INTEREST).history; }
  get monthlyMortgagePrincipals()    { return this.#metrics.get(Metric.MORTGAGE_PRINCIPAL).history; }
  get monthlyPropertyTaxes()         { return this.#metrics.get(Metric.PROPERTY_TAX).history; }
  get monthlyMortgageEscrows()       { return this.#metrics.get(Metric.MORTGAGE_ESCROW).history; }
  get monthlyEstimatedTaxes()        { return this.#metrics.get(Metric.ESTIMATED_INCOME_TAX).history; }
  get monthlyIRAContributions()      { return this.#metrics.get(Metric.IRA_CONTRIBUTION).history; }
  get monthlyFour01KContributions()  { return this.#metrics.get(Metric.FOUR_01K_CONTRIBUTION).history; }
  get monthlyIRADistributions()      { return this.#metrics.get(Metric.IRA_DISTRIBUTION).history; }
  get monthlyFour01KDistributions()  { return this.#metrics.get(Metric.FOUR_01K_DISTRIBUTION).history; }
  get monthlyInterestIncomes()       { return this.#metrics.get(Metric.INTEREST_INCOME).history; }
  get monthlyCapitalGainsTaxes()     { return this.#metrics.get(Metric.CAPITAL_GAIN_TAX).history; }
  get monthlyCredits()               { return this.#metrics.get(Metric.CREDIT).history; }


  // ── Chronometer lifecycle ────────────────────────────────────────

  initializeChron() {

    this.finishCurrency = new Currency(0);
    this.finishBasisCurrency = new Currency(this.startBasisCurrency.amount);
    this.monthsRemainingDynamic = this.monthsRemaining;
    this.beforeStartDate = false;
    this.onStateDate = false;
    this.onFinishDate  = false;
    this.afterFinishDate = false;
    this.isClosed = false;
    this.closedValue = null;
    this.closedBasisValue = null;
    this.creditMemos = [];
    this.creditMemosCheckedIndex = 0;
    this.#metrics.initializeAll();

  }

  handleCurrentDateInt(currentDateInt) {

    this.currentDateInt = currentDateInt.copy();

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

    // value and accumulated are special: add finishValue and cash flows, then snapshot WITHOUT zeroing
    this.#metrics.get(Metric.CASH_FLOW_ACCUMULATED).add(this.cashFlowCurrency);

    /* Was thinking of reconciling credit here, but it makes more sense to do it at the end of the month after all monthly changes have been applied, so that the metric history reflects the true "credit" activity rather than an artificial netting of credit against value changes. Keeping this code here as a reminder that credit reconciliation still needs to happen somewhere.
    // Reconcile credit buffer
    const credit = this.creditCurrency;
    if (credit.amount > 0) {
      this.finishCurrency.add(credit);
    }
    */

    this.#metrics.get(Metric.VALUE).add(this.finishCurrency);

    // Snapshot all metrics (zero after, except 'accumulated')
    this.#metrics.snapshotAll(KEEP_ON_SNAPSHOT);

  }

  yearlyChron() { /* hook for subclasses */ }
  finalizeChron() { /* hook for subclasses */ }

  // ── Monthly calculations ─────────────────────────────────────────

  applyFirstDayOfMonth(currentDateInt) {

    this.monthlyValueChange = Currency.zero();

    this.handleCurrentDateInt(currentDateInt);

    if (this.beforeStartDate) {

      this.finishCurrency.zero();

    }

    else if (this.afterFinishDate) {

      if (this.isClosed) {
        console.assert(this.finishCurrency.amount === 0, `Expected finishCurrency to be zero for closed asset ${this.displayName} but got ${this.finishCurrency.toCurrency()}`);
      }
      // if not yet closed, preserve finishCurrency so closeAsset can transfer the balance

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
      console.warn(`Value mismatch for ${this.displayName} on ${currentDateInt.toString()}: firstDayOfMonthValue (${this.firstDayOfMonthValue.toCurrency()}) + monthlyValueChange (${this.monthlyValueChange.toCurrency()}) = ${firstDayOfMonthValuePlusMonthlyValueChange.toCurrency()} but lastDayOfMonthValue is ${lastDayOfMonthValue.toCurrency()}`);
      debugger;
    }    

    this.cashFlowAccumulatedCurrency.add(this.monthlyValueChange);

  }

  /*
    * Apply monthly changes based on instrument type. Returns a result object with details of the changes.
    * Pattern is to compute the change as a local constant first, and then add to relevent properties
  */
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

    const income = this.finishCurrency.copy();
    if (this.isSelfEmployed) {
      this.workingIncomeCurrency.add(income);
    } else {
      this.ordinaryIncomeCurrency.add(income);
    }
    this.incomeCurrency.add(income);

    // growth in income happens yearly

    return this.isSelfEmployed
      ? new IncomeResult(income, Currency.zero())
      : new IncomeResult(Currency.zero(), income);

  }

applyMonthlyExpense() {

    this.ensureNegativeStart();

    const expense = this.finishCurrency.copy();
    this.expenseCurrency.add(expense);

    // expenses grow monthly cause that's how the world works
    const growth = new Currency(expense.amount * this.annualReturnRate.asMonthly());
    this.growthCurrency.add(growth);
    this.finishCurrency.add(growth);
    this.monthlyValueChange.add(growth);

    // FIX: Generate a memo so the expense drift is accounted for
    if (growth.amount !== 0) {
      this.creditMemos.push(new CreditMemo(growth, 'Expense growth', this.currentDateInt));
    }

    return new ExpenseResult(expense, this.finishCurrency.copy());

  }

  applyMonthlyMortgage() {

    this.ensureNegativeStart();
    const rate = this.annualReturnRate.asMonthly();
    const n = this.monthsRemainingDynamic;

    const payment   = (this.finishCurrency.amount * rate * Math.pow(1 + rate, n))
                    / (Math.pow(1 + rate, n) - 1);

    const paymentCurrency = new Currency(payment);
    const interest  = new Currency(this.finishCurrency.amount * rate);
    const principal = new Currency(payment - interest.amount);

    this.mortgagePaymentCurrency.add(paymentCurrency);
    this.mortgageInterestCurrency.add(interest);
    this.mortgagePrincipalCurrency.add(principal);

    this.monthsRemainingDynamic--;    
    this.finishCurrency.subtract(principal);
    this.growthCurrency.subtract(principal);
    this.monthlyValueChange.add(principal.copy().flipSign());

    this.creditMemos.push(new CreditMemo(principal.copy().flipSign(), 'Mortgage Principal', this.currentDateInt));   

    // TODO: generate memos for principal and interest if there are fund transfers directly. Otherwise assume its from expenses
    //this.creditMemos.push(new CreditMemo(interest, 'Mortgage interest', this.currentDateInt));
    //this.creditMemos.push(new CreditMemo(principal, 'Mortgage principal', this.currentDateInt));

    return new MortgageResult(principal, interest, Currency.zero());

  }

  applyMonthlyCapital() {

    const growth = new Currency(this.finishCurrency.amount * this.annualReturnRate.asMonthly());

    this.growthCurrency.add(growth);
    this.finishCurrency.add(this.growthCurrency); 
    this.monthlyValueChange.add(this.growthCurrency);
    this.creditMemos.push(new CreditMemo(this.growthCurrency, 'Asset growth', this.currentDateInt));

    let dividend = Currency.zero();
    if (this.annualDividendRate.rate != 0.0) {

      // add on top of growth
      dividend = new Currency(this.finishCurrency.amount * this.annualDividendRate.asMonthly());
      
      this.dividendCurrency.add(dividend);
      this.finishCurrency.add(dividend);
      this.monthlyValueChange.add(dividend);
      this.creditMemos.push(new CreditMemo(dividend, 'Dividend income', this.currentDateInt));      

    }

    return new AssetAppreciationResult(this.finishCurrency.copy(), growth, dividend);

  }

  applyMonthlyIncomeHoldings() {

    this.ensurePositiveStart();
    const income = new Currency(this.finishCurrency.amount * this.annualReturnRate.asMonthly());

    this.interestIncomeCurrency.add(income);
    this.incomeCurrency.add(income);
    this.finishCurrency.add(income);
    this.monthlyValueChange.add(income);

    this.creditMemos.push(new CreditMemo(income, 'Interest income', this.currentDateInt));

    return new InterestResult(income);

  }

  applyYearly() {

    if (InstrumentType.isMonthlyIncome(this.instrument)) {
      const growth = new Currency(this.finishCurrency.amount * this.annualReturnRate.rate);
      this.growthCurrency.add(growth);
      this.finishCurrency.add(growth);
      this.monthlyValueChange.add(growth);
      this.creditMemos.push(new CreditMemo(growth, 'Annual income growth', this.currentDateInt));

      return this.isSelfEmployed
        ? new IncomeResult(this.growthCurrency.copy(), Currency.zero())
        : new IncomeResult(Currency.zero(), this.growthCurrency.copy());
    }   
    
    return null;
  }

  // ── Credit / Debit (fund transfer interface) ─────────────────────

  credit(amount, note = '', skipGain = false) {
    if (this.#isFlowInstrument()) {
      // Record the memo to maintain double-entry balance, but don't alter asset value
      if (note) this.creditMemos.push(new CreditMemo(amount.copy(), note, this.currentDateInt));
      return { assetChange: Currency.zero(), realizedGain: Currency.zero() };
    }
    this.creditCurrency.add(amount);
    this.monthlyValueChange.add(amount);
    return this.reconcileCredit(note, skipGain);
  }

  debit(amount, note = '', skipGain = false) {
    if (this.#isFlowInstrument()) {
      // Record the memo (as a negative amount) to maintain balance
      if (note) this.creditMemos.push(new CreditMemo(amount.copy().flipSign(), note, this.currentDateInt));
      return { assetChange: Currency.zero(), realizedGain: Currency.zero() };
    }
    this.creditCurrency.subtract(amount);
    this.monthlyValueChange.subtract(amount);
    return this.reconcileCredit(note, skipGain);
  }

  reconcileCredit(note = '', skipGain = false) {
    let credit = this.creditCurrency.copy();
    this.creditCurrency.zero();

    // Calculate gain and adjust basis BEFORE changing finishCurrency
    let realizedGain = new Currency(0);
    const T = InstrumentType;
    
    if (credit.amount < 0 && T.isTaxableAccount(this.instrument)) {
      const withdrawal = Math.abs(credit.amount);
      const currentValue = this.finishCurrency.amount;
      if (currentValue > 0) {
        const fractionSold = Math.min(withdrawal / currentValue, 1.0);
        const basisWithdrawn = this.finishBasisCurrency.amount * fractionSold;
        realizedGain.amount = withdrawal - basisWithdrawn;
        this.finishBasisCurrency.amount -= basisWithdrawn;
      }
    } else if (credit.amount > 0 && T.isTaxableAccount(this.instrument)) {
      this.finishBasisCurrency.add(credit); // Deposits increase basis
    }

    this.finishCurrency.add(credit);

    if (credit.amount > 0) {
      if (T.isTaxableAccount(this.instrument)) {
        this.addToMetric(Metric.TAXABLE_CONTRIBUTION, credit);
      } else if (T.isIRA(this.instrument)) {
        this.addToMetric(Metric.IRA_CONTRIBUTION, credit);
      } else if (T.is401K(this.instrument)) {
        this.addToMetric(Metric.FOUR_01K_CONTRIBUTION, credit);
      } else if (T.isHome(this.instrument)) {
        if (!skipGain) this.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, credit);
      } else if (T.isMortgage(this.instrument)) {
        this.addToMetric(Metric.MORTGAGE_PRINCIPAL, credit);
      }
    }
    
    if (credit.amount < 0) {
      if (T.isTaxableAccount(this.instrument)) {
        if (!skipGain) {
            this.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, realizedGain);
            // FIX: Push the memo for incremental realized gains
            if (realizedGain.amount > 0) {
                this.creditMemos.push(new CreditMemo(realizedGain.copy(), 'Capital gains', this.currentDateInt));
            }
        }
      } else if (T.isIRA(this.instrument)) {
        this.addToMetric(Metric.IRA_DISTRIBUTION, credit.copy().flipSign());
      } else if (T.is401K(this.instrument)) {
        this.addToMetric(Metric.FOUR_01K_DISTRIBUTION, credit.copy().flipSign());
      } else if (T.isHome(this.instrument)) {
        if (!skipGain) this.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, credit);
      } else if (T.isMortgage(this.instrument)) {
        this.addToMetric(Metric.MORTGAGE_PRINCIPAL, credit);
      }
    }

    if (note) {
      this.creditMemos.push(new CreditMemo(credit, note, this.currentDateInt));
    }

    return { assetChange: credit, realizedGain: realizedGain };
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

  isPositive() { return this.cashFlowAccumulatedCurrency.amount > 0; }
  isNegative() { return this.cashFlowAccumulatedCurrency.amount < 0; }

  getFinishCurrencyForRollup() {
    const T = InstrumentType;
    const i = this.instrument;
    if (T.isMortgage(i) || T.isDebt(i) || T.isMonthlyExpense(i) || T.isMonthlyIncome(i)) {
      return this.cashFlowAccumulatedCurrency;
    }
    return this.finishCurrency;
  }

  /*
    Unrealized Gain Ratio of the asset 1 - (basis / currentValue)
  */
  getUnrealizedGainRatio() {
    if (this.finishCurrency.amount <= 0) return 0;
    const basisRatio = this.finishBasisCurrency.amount / this.finishCurrency.amount;
    return Math.max(0, 1.0 - basisRatio); // Returns a float between 0.0 and 1.0
  }

  close() {

    // closedValue / closedBasisValue are captured by Portfolio.closeAsset()
    // before fund transfers drain the asset
    this.creditCurrency.zero();
    this.finishCurrency.zero();

    // since we are closing we won't be tracking value changes anymore
    this.firstDayOfMonthValue.zero();
    this.monthlyValueChange.zero();

    this.isClosed = true;

  }

  // ── Display data (for charting) ──────────────────────────────────

  buildDisplayData(monthsSpan, metricName, outputArrayName) {

    const source = this.#metrics.get(metricName).history;

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

  monthlyCashFlowDataToDisplayCashFlowData(monthsSpan) {
    this.buildDisplayData(monthsSpan, 'monthlyCashFlows', 'displayCashFlowData');
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
      startBasisCurrency: this.startBasisCurrency.copy(),
      finishDateInt:   this.finishDateInt,
      monthsRemaining: this.monthsRemaining,
      annualReturnRate: this.annualReturnRate,
      annualDividendRate: this.annualDividendRate,
      longTermCapitalHoldingPercentage: this.longTermCapitalHoldingPercentage,
      fundTransfers:   this.fundTransfers.map(ft => ft.copy()),
      isSelfEmployed:  this.isSelfEmployed,
      annualTaxRate:   this.annualTaxRate,
    });
    clone.finishCurrency = this.finishCurrency.copy();
    clone.colorId = this.colorId;
    return clone;
  }

  // ── Serialization ───────────────────────────────────────────────

  toJSON() {
    const { creditMemos, creditMemosCheckedIndex, ...rest } = this;
    return rest;
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
