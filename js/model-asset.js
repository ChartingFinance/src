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

import { Currency }       from './utils/currency.js';
import { DateInt }        from './utils/date-int.js';
import { ARR }            from './utils/arr.js';
import { InstrumentType } from './instruments/instrument.js';
import { FundTransfer }   from './fund-transfer.js';
import { logger, LogCategory } from './utils/logger.js';
import { MetricSet }      from './tracked-metric.js';
import { CreditMemo } from './results.js';
import { IncomeResult } from './results.js';
import { colorRange }    from './utils/html.js';
import { getBehavior }   from './instruments/instrument-behavior.js';
import { global_getFinishDateInt, global_inflationRate } from './globals.js';

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
  SOCIAL_SECURITY_TAX:          'socialSecurityTax',
  SOCIAL_SECURITY_INCOME:       'socialSecurityIncome',
  MEDICARE_TAX:                 'medicareTax',
  MORTGAGE_PAYMENT:             'mortgagePayment',
  MORTGAGE_INTEREST:            'mortgageInterest',
  MORTGAGE_PRINCIPAL:           'mortgagePrincipal',
  MORTGAGE_ESCROW:              'mortgageEscrow',
  PROPERTY_TAX:                 'propertyTax',
  TAXABLE_CONTRIBUTION:         'taxableContribution',
  TRAD_IRA_CONTRIBUTION:        'tradIRAContribution',
  ROTH_IRA_CONTRIBUTION:        'rothIRAContribution',
  FOUR_01K_CONTRIBUTION:        'four01KContribution',
  TRAD_IRA_DISTRIBUTION:        'tradIRADistribution',
  ROTH_IRA_DISTRIBUTION:        'rothIRADistribution',
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
  [Metric.SOCIAL_SECURITY_TAX]:         'Social Security Tax',
  [Metric.SOCIAL_SECURITY_INCOME]:      'Social Security Income',
  [Metric.MEDICARE_TAX]:                    'Medicare Tax',
  [Metric.MORTGAGE_PAYMENT]:            'Mortgage Payment',
  [Metric.MORTGAGE_INTEREST]:           'Mortgage Interest',
  [Metric.MORTGAGE_PRINCIPAL]:          'Mortgage Principal',
  [Metric.MORTGAGE_ESCROW]:             'Mortgage Escrow', 
  [Metric.TAXABLE_CONTRIBUTION]:        'Taxable Contribution',
  [Metric.TRAD_IRA_CONTRIBUTION]:       'Traditional IRA Contribution',
  [Metric.ROTH_IRA_CONTRIBUTION]:       'Roth IRA Contribution',
  [Metric.FOUR_01K_CONTRIBUTION]:       '401K Contribution',
  [Metric.TRAD_IRA_DISTRIBUTION]:       'Traditional IRA Distribution',
  [Metric.ROTH_IRA_DISTRIBUTION]:       'Roth IRA Distribution',
  [Metric.FOUR_01K_DISTRIBUTION]:       '401K Distribution',
  [Metric.TAXABLE_DISTRIBUTION]:        'Taxable Distribution', // these are distributions from taxable accounts as cash
  [Metric.SHORT_TERM_CAPITAL_GAIN_TAX]: 'Short Term Capital Gain Tax', // these are distributions from taxable accounts taxed as short term gains
  [Metric.LONG_TERM_CAPITAL_GAIN_TAX]:  'Long Term Capital Gain Tax',  // these are distriubtions from taxable accounts taxed as long term gains
  [Metric.CAPITAL_GAIN_TAX]:            'Capital Gains Tax',
  [Metric.CREDIT]:                      'Credit',
});

// A mapping of Child Metric -> Array of Parent Metrics
export const MetricRollups = {
    // --- FOUNDATIONAL INCOME TO ORDINARY INCOME ---
    [Metric.TRAD_IRA_DISTRIBUTION]:       [Metric.ORDINARY_INCOME],
    [Metric.FOUR_01K_DISTRIBUTION]:       [Metric.ORDINARY_INCOME],
    [Metric.WORKING_INCOME]:              [Metric.ORDINARY_INCOME],
    [Metric.INTEREST_INCOME]:             [Metric.ORDINARY_INCOME],
    [Metric.SOCIAL_SECURITY_INCOME]:      [Metric.ORDINARY_INCOME], 
    [Metric.SHORT_TERM_CAPITAL_GAIN]:     [Metric.ORDINARY_INCOME], // Taxed at ordinary rates

    // --- FOUNDATIONAL GAINS TO CAPITAL GAINS ---
    [Metric.LONG_TERM_CAPITAL_GAIN]:      [Metric.CAPITAL_GAIN],

    // --- MASTER COMBINATIONS TO TOTAL INCOME ---
    [Metric.ORDINARY_INCOME]:             [Metric.INCOME],
    [Metric.CAPITAL_GAIN]:                [Metric.INCOME],
    [Metric.ROTH_IRA_DISTRIBUTION]:       [Metric.INCOME], // Non-taxable, but still cash flow income
    [Metric.DIVIDEND]:                    [Metric.INCOME],

    [Metric.MEDICARE_TAX]:                [Metric.WITHHELD_FICA_TAX],
    [Metric.SOCIAL_SECURITY_TAX]:         [Metric.WITHHELD_FICA_TAX],
    [Metric.WITHHELD_FICA_TAX]:           [Metric.WITHHELD_INCOME_TAX],

    // --- TAX ROLLUPS ---
    [Metric.WITHHELD_INCOME_TAX]:         [Metric.INCOME_TAX],
    [Metric.ESTIMATED_INCOME_TAX]:        [Metric.INCOME_TAX],
    [Metric.SHORT_TERM_CAPITAL_GAIN_TAX]: [Metric.INCOME_TAX],
    [Metric.LONG_TERM_CAPITAL_GAIN_TAX]:  [Metric.CAPITAL_GAIN_TAX],
    
    // --- EXPENSE & DEBT ROLLUPS ---
    [Metric.MORTGAGE_INTEREST]:           [Metric.MORTGAGE_PAYMENT],
    [Metric.MORTGAGE_PRINCIPAL]:          [Metric.MORTGAGE_PAYMENT],
    [Metric.MORTGAGE_ESCROW]:             [Metric.MORTGAGE_PAYMENT],
    [Metric.MORTGAGE_PAYMENT]:            [Metric.EXPENSE],
    [Metric.PROPERTY_TAX]:                [Metric.EXPENSE],
};

// Metrics that should NOT be zeroed on monthly snapshot
const KEEP_ON_SNAPSHOT = new Set([Metric.PROPERTY_TAX, Metric.CASH_FLOW_ACCUMULATED]);


export class ModelAsset {
  #metrics;

  /**
   * @param {Object} opts
   * @param {string}        opts.instrument
   * @param {string}        opts.displayName
   * @param {DateInt}        opts.startDateInt
   * @param {Currency}       opts.startCurrency
   * @param {Currency}       [opts.startBasisCurrency]
   * @param {DateInt|null}   [opts.finishDateInt]
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
    finishDateInt = null,
    monthsRemaining = 0,
    annualReturnRate,
    annualDividendRate = new ARR(0),
    longTermCapitalHoldingPercentage = new ARR(0),
    fundTransfers = [],
    isSelfEmployed = false,
    isPrimaryHome = true,
    annualTaxRate = new ARR(0),
  }) {
    this.instrument      = instrument;
    this.displayName     = displayName;
    this.startDateInt    = startDateInt;
    this.startCurrency   = startCurrency;
    this.startBasisCurrency = startBasisCurrency;
    this.finishBasisCurrency = new Currency(startBasisCurrency.amount);
    this.finishDateInt   = finishDateInt || null;
    this.monthsRemaining = Number.isInteger(monthsRemaining) ? monthsRemaining : 0;
    this.annualDividendRate = annualDividendRate;
    this.longTermCapitalHoldingPercentage = longTermCapitalHoldingPercentage;
    this.annualReturnRate = annualReturnRate;
    this.fundTransfers   = fundTransfers;
    this.isSelfEmployed  = isSelfEmployed;
    this.isPrimaryHome   = isPrimaryHome;
    this.annualTaxRate   = annualTaxRate;

    this.behavior      = getBehavior(instrument);
    this.colorId       = 0;
    this.beforeStartDate = false;
    this.onOrAfterStateDate = false;
    this.onOrBeforeFinishDate  = false;
    this.afterFinishDate = false;
    this.isClosed      = false;

    // Chronometer state
    this.finishCurrency = Currency.zero();
    this.monthsRemainingDynamic = this.monthsRemaining;
    this.monthlyTaxEscrow = Currency.zero();    
    this.#metrics = new MetricSet(this.behavior.relevantMetrics());
  }

  get effectiveFinishDateInt() {
    return this.finishDateInt ?? global_getFinishDateInt();
  }

  /** For expense instruments, fall back to global inflation when no rate is set. */
  get effectiveAnnualReturnRate() {
    if (InstrumentType.isMonthlyExpense(this.instrument) && this.annualReturnRate.rate === 0) {
      return new ARR(global_inflationRate);
    }
    return this.annualReturnRate;
  }

  // ── Factories ────────────────────────────────────────────────────

  static trackedMetricNames() {
    return METRIC_NAMES;
  }

  static fromJSON(obj) {
    // Migration: rename legacy instrument values
    const INSTRUMENT_MIGRATION = {
      'home': 'realEstate',
      'monthlySalary': 'workingIncome',
      'monthlySocialSecurity': 'retirementIncome',
      'monthlyPension': 'retirementIncome',
    };
    const instrument = INSTRUMENT_MIGRATION[obj.instrument] ?? obj.instrument;
    return new ModelAsset({
      instrument,
      displayName:     obj.displayName,
      startDateInt:    new DateInt(obj.startDateInt.year * 100 + obj.startDateInt.month),
      startCurrency:   new Currency(obj.startCurrency.amount),
      startBasisCurrency: new Currency(obj.startBasisCurrency?.amount ?? obj.basisCurrency?.amount ?? 0),
      finishDateInt:   obj.finishDateInt ? new DateInt(obj.finishDateInt.year * 100 + obj.finishDateInt.month) : null,
      monthsRemaining: obj.monthsRemaining ?? 0,
      annualReturnRate: new ARR(obj.annualReturnRate?.annualReturnRate ?? obj.annualReturnRate?.rate ?? 0),
      annualDividendRate: new ARR(obj.annualDividendRate?.annualReturnRate ?? obj.annualDividendRate?.rate ?? 0),
      longTermCapitalHoldingPercentage: new ARR(obj.longTermCapitalHoldingPercentage?.annualReturnRate ?? obj.longTermCapitalHoldingPercentage?.rate ?? 0),
      fundTransfers:   (obj.fundTransfers ?? []).map(FundTransfer.fromJSON),
      isSelfEmployed:  obj.isSelfEmployed ?? false,
      isPrimaryHome:   obj.isPrimaryHome ?? true,
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
      finishDateInt:   vals.finishDate?.value ? DateInt.parse(vals.finishDate.value) : null,
      monthsRemaining: parseInt(vals.monthsRemaining?.value, 10) || 0,
      annualReturnRate: vals.annualReturnRate?.value ? ARR.parse(vals.annualReturnRate.value) : new ARR(0),
      annualDividendRate: vals.dividendRate ? ARR.parse(vals.dividendRate.value) : new ARR(0),
      longTermCapitalHoldingPercentage: vals.longTermRate ? ARR.parse(vals.longTermRate.value) : new ARR(0),
      fundTransfers,
      isSelfEmployed: vals.isSelfEmployed?.type === 'checkbox'
        ? vals.isSelfEmployed.checked
        : vals.isSelfEmployed?.value === 'true',
      isPrimaryHome: vals.isPrimaryHome?.type === 'checkbox'
        ? vals.isPrimaryHome.checked
        : (vals.isPrimaryHome?.value !== 'false'),
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
 
    // 1. Add to the target metric
    let result = this.#metrics.get(metricName).current.add(amount);

    // 2. Automatically ripple up to parent metrics (if any exist)
    const parentMetrics = MetricRollups[metricName];
    if (parentMetrics) {
        for (const parentName of parentMetrics) {
            this.addToMetric(parentName, amount); // Recursive call
        }
    }

    return result;
  }

  /** Iterate over all tracked metrics (used by display-data builders). */
  [Symbol.iterator]() {
    return this.#metrics[Symbol.iterator]();
  }

  /** Get the raw monthly history array for a named metric. */
  getHistory(metricName) {
    return this.#metrics.get(metricName).history;
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

  get socialSecurityTaxCurrency()   { return this.#metrics.get(Metric.SOCIAL_SECURITY_TAX).current; }
  set socialSecurityTaxCurrency(c)  { this.#metrics.get(Metric.SOCIAL_SECURITY_TAX).current = c; }

  get socialSecurityIncomeCurrency()   { return this.#metrics.get(Metric.SOCIAL_SECURITY_INCOME).current; }
  set socialSecurityIncomeCurrency(c)  { this.#metrics.get(Metric.SOCIAL_SECURITY_INCOME).current = c; }

  get medicareTaxCurrency()   { return this.#metrics.get(Metric.MEDICARE_TAX).current; }
  set medicareTaxCurrency(c)  { this.#metrics.get(Metric.MEDICARE_TAX).current = c; }

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

  get taxableContributionCurrency()   { return this.#metrics.get(Metric.TAXABLE_CONTRIBUTION).current; }
  set taxableContributionCurrency(c)  { this.#metrics.get(Metric.TAXABLE_CONTRIBUTION).current = c; }

  get tradIRAContributionCurrency()   { return this.#metrics.get(Metric.TRAD_IRA_CONTRIBUTION).current; }
  set tradIRAContributionCurrency(c)  { this.#metrics.get(Metric.TRAD_IRA_CONTRIBUTION).current = c; }

  get rothIRAContributionCurrency()   { return this.#metrics.get(Metric.ROTH_IRA_CONTRIBUTION).current; }
  set rothIRAContributionCurrency(c)  { this.#metrics.get(Metric.ROTH_IRA_CONTRIBUTION).current = c; }

  get four01KContributionCurrency()   { return this.#metrics.get(Metric.FOUR_01K_CONTRIBUTION).current; }
  set four01KContributionCurrency(c)  { this.#metrics.get(Metric.FOUR_01K_CONTRIBUTION).current = c; }

  get tradIRADistributionCurrency()   { return this.#metrics.get(Metric.TRAD_IRA_DISTRIBUTION).current; }
  set tradIRADistributionCurrency(c)  { this.#metrics.get(Metric.TRAD_IRA_DISTRIBUTION).current = c; }

  get rothIRADistributionCurrency()   { return this.#metrics.get(Metric.ROTH_IRA_DISTRIBUTION).current; }
  set rothIRADistributionCurrency(c)  { this.#metrics.get(Metric.ROTH_IRA_DISTRIBUTION).current = c; }

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
  get monthlySocialSecurityTaxes()   { return this.#metrics.get(Metric.SOCIAL_SECURITY_TAX).history; }
  get monthlySocialSecurityIncomes() { return this.#metrics.get(Metric.SOCIAL_SECURITY_INCOME).history; }
  get monthlyMedicareTaxes()         { return this.#metrics.get(Metric.MEDICARE_TAX).history; }
  get monthlyIncomeTaxes()           { return this.#metrics.get(Metric.INCOME_TAX).history; }
  get monthlyMortgagePayments()      { return this.#metrics.get(Metric.MORTGAGE_PAYMENT).history; }
  get monthlyMortgageInterests()     { return this.#metrics.get(Metric.MORTGAGE_INTEREST).history; }
  get monthlyMortgagePrincipals()    { return this.#metrics.get(Metric.MORTGAGE_PRINCIPAL).history; }
  get monthlyPropertyTaxes()         { return this.#metrics.get(Metric.PROPERTY_TAX).history; }
  get monthlyEstimatedTaxes()        { return this.#metrics.get(Metric.ESTIMATED_INCOME_TAX).history; }
  get monthlyTradIRAContributions()  { return this.#metrics.get(Metric.TRAD_IRA_CONTRIBUTION).history; }
  get monthlyRothIRAContributions()  { return this.#metrics.get(Metric.ROTH_IRA_CONTRIBUTION).history; }
  get monthlyFour01KContributions()  { return this.#metrics.get(Metric.FOUR_01K_CONTRIBUTION).history; }
  get monthlyTradIRADistributions()  { return this.#metrics.get(Metric.TRAD_IRA_DISTRIBUTION).history; }
  get monthlyRothIRADistributions()  { return this.#metrics.get(Metric.ROTH_IRA_DISTRIBUTION).history; }
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
    this.monthlyCreditBalance = Currency.zero();
    this.monthlyTaxEscrow = Currency.zero();
    this.#metrics.initializeAll();

    // this is to track this.finishCurrency changes through the month with a check on the last day
    this.monthlyValueChange = Currency.zero();

  }

  handleCurrentDateInt(currentDateInt) {

    this.currentDateInt = currentDateInt.copy();

    // see if we are active or not
    if (this.inMonth(currentDateInt)) {

      this.beforeStartDate = false;      
      this.afterFinishDate = false;
      this.onStartDate = (currentDateInt.toInt() == this.startDateInt.toInt());
      this.onFinishDate = (currentDateInt.toInt() == this.effectiveFinishDateInt.toInt());

    } else {

      if (currentDateInt.toInt() < this.startDateInt.toInt()) {

        this.beforeStartDate = true;
        this.onStartDate = false;
        this.onFinishDate = false;
        this.afterFinishDate = false;

      } else if (currentDateInt.toInt() > this.effectiveFinishDateInt.toInt()) {

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

    this.#metrics.get(Metric.VALUE).add(this.finishCurrency);

    // Snapshot all metrics (zero after, except 'accumulated')
    this.#metrics.snapshotAll(KEEP_ON_SNAPSHOT);

  }

  yearlyChron() { /* hook for subclasses */ }
  finalizeChron() { /* hook for subclasses */ }

  // ── Monthly calculations ─────────────────────────────────────────

  applyMonthlyTaxEscrow() {

    this.monthlyTaxEscrow.add(this.propertyTaxCurrency);
    this.propertyTaxCurrency.zero();
    return this.monthlyTaxEscrow.copy();

  }

  clearMonthlyTaxEscrow() {

    this.monthlyTaxEscrow.zero();

  }

  applyFirstDayOfMonth(currentDateInt) {

    this.monthlyCreditBalance.zero();

    if (this.beforeStartDate) {

      this.finishCurrency.zero();

    }

    else if (this.afterFinishDate) {

      if (this.isClosed) {
        //console.assert(this.finishCurrency.amount === 0, `Expected finishCurrency to be zero for closed asset ${this.displayName} but got ${this.finishCurrency.toCurrency()}`);
      }
      // if not yet closed, preserve finishCurrency so closeAsset can transfer the balance

    }

    else if (this.onStartDate) {

      this.finishCurrency = this.startCurrency.copy();

    }

    this.firstDayOfMonthValue = this.finishCurrency.copy();
    this.monthlyValueChange.zero();

  }

  applyLastDayOfMonth(currentDateInt) {  

    const expected = this.firstDayOfMonthValue.plus(this.monthlyValueChange);
    if (expected.toFixed() !== this.finishCurrency.toFixed()) {
      console.warn('Value mismatch! finishValue: ' + this.finishCurrency.toFixed() + '   expected: ' + expected.toFixed());
      debugger;
    }

  }

  /**
   * Apply monthly changes. Delegates to the instrument's behavior strategy.
   * Returns a result object (IncomeResult, ExpenseResult, etc.) or null.
   */
  applyMonthly() {
    if (this.beforeStartDate || this.afterFinishDate) return;
    return this.behavior.applyMonthly(this);
  }

  applyYearly() {

    if (InstrumentType.isMonthlyIncome(this.instrument)) {
      const growth = new Currency(this.finishCurrency.amount * this.annualReturnRate.rate);
      this.growthCurrency.add(growth);
      this.finishCurrency.add(growth);      
      this.addCreditMemo(growth, 'Annual income growth');

      // and don't forget our monthlyValueChange tracker
      this.monthlyValueChange.add(growth);

      return this.isSelfEmployed
        ? new IncomeResult(this.growthCurrency.copy(), Currency.zero())
        : new IncomeResult(Currency.zero(), this.growthCurrency.copy());
    }   
    
    return null;
  }

  addCreditMemo(amount, note) {
    this.creditMemos.push(new CreditMemo(amount, note, this.currentDateInt));
  }

  // ── Credit / Debit (fund transfer interface) ─────────────────────

  credit(amount, note = '', skipGain = false) {
    logger.log(LogCategory.TRANSFER,
      `${this.displayName}.credit(${amount.toString()}, '${note}', skipGain=${skipGain})`);
    return this.#transact(amount.copy(), note, skipGain);
  }

  debit(amount, note = '', skipGain = false) {
    logger.log(LogCategory.TRANSFER,
      `${this.displayName}.debit(${amount.toString()}, '${note}', skipGain=${skipGain})`);
    return this.#transact(amount.copy().flipSign(), note, skipGain);
  }

  #transact(amount, note, skipGain) {
    // Flow instruments: memo only, no balance change
    if (this.#isFlowInstrument()) {
      if (note) this.addCreditMemo(amount.copy(), note);
      return { assetChange: Currency.zero(), realizedGain: Currency.zero() };
    }

    const isTaxable = InstrumentType.isTaxableAccount(this.instrument);
    let realizedGain = Currency.zero();

    if (amount.amount >= 0) {
      
      // ── DEPOSIT ──
      if (isTaxable) this.monthlyCreditBalance.add(amount);
      this.finishCurrency.add(amount);
      this.monthlyValueChange.add(amount);
      if (isTaxable) this.finishBasisCurrency.add(amount);
      
    } else {
      
      // ── WITHDRAWAL ──
      const withdrawal = new Currency(Math.abs(amount.amount));

      // Draw from fresh deposits first (no capital gains)
      let fromCredit = Currency.zero();
      if (isTaxable && this.monthlyCreditBalance.amount > 0) {
        fromCredit = new Currency(Math.min(withdrawal.amount, this.monthlyCreditBalance.amount));
        this.monthlyCreditBalance.subtract(fromCredit);
        this.finishCurrency.subtract(fromCredit);
        this.monthlyValueChange.subtract(fromCredit);
        this.finishBasisCurrency.subtract(fromCredit);        
      }

      // Remainder from vested holdings (fraction-sold, triggers gains)
      const fromVested = new Currency(withdrawal.amount - fromCredit.amount);
      if (fromVested.amount > 0) {
        if (isTaxable && this.finishCurrency.amount > 0) {
          const fractionSold = Math.min(fromVested.amount / this.finishCurrency.amount, 1.0);
          const basisWithdrawn = this.finishBasisCurrency.amount * fractionSold;
          realizedGain = new Currency(fromVested.amount - basisWithdrawn);
          this.finishBasisCurrency.amount -= basisWithdrawn;
        }
        this.finishCurrency.subtract(fromVested);
        this.monthlyValueChange.subtract(fromVested);
      }
    }

    this.#recordMetric(amount, skipGain, realizedGain);

    if (note) {
      this.addCreditMemo(amount.copy(), note);
    }
    else {
      console.warn('modelAsset.#recordMetric called without a note for ' + amount.toString());
      debugger;
    }

    return { assetChange: amount.copy(), realizedGain };
  }

  #recordMetric(amount, skipGain, realizedGain) {
    const T = InstrumentType;
    if (amount.amount > 0) {
      if (T.isTaxableAccount(this.instrument))        this.addToMetric(Metric.TAXABLE_CONTRIBUTION, amount);
      else if (T.isIRA(this.instrument))               this.addToMetric(Metric.TRAD_IRA_CONTRIBUTION, amount);
      else if (T.isRothIRA(this.instrument))            this.addToMetric(Metric.ROTH_IRA_CONTRIBUTION, amount);
      else if (T.is401K(this.instrument))               this.addToMetric(Metric.FOUR_01K_CONTRIBUTION, amount);
      else if (T.isRealEstate(this.instrument) && !skipGain)  this.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, amount);
      else if (T.isMortgage(this.instrument))           this.addToMetric(Metric.MORTGAGE_PRINCIPAL, amount);
    } else if (amount.amount < 0) {
      const positive = amount.copy().flipSign();
      if (T.isTaxableAccount(this.instrument)) {
        if (!skipGain) {
          this.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, realizedGain);
          if (realizedGain.amount > 0) {
            this.addCreditMemo(realizedGain.copy(), 'Capital gains');
          }
        }
      }
      else if (T.isIRA(this.instrument))               this.addToMetric(Metric.TRAD_IRA_DISTRIBUTION, positive);
      else if (T.isRothIRA(this.instrument))            this.addToMetric(Metric.ROTH_IRA_DISTRIBUTION, positive);
      else if (T.is401K(this.instrument))               this.addToMetric(Metric.FOUR_01K_DISTRIBUTION, positive);
      else if (T.isRealEstate(this.instrument) && !skipGain)  this.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, amount);
      else if (T.isMortgage(this.instrument))           this.addToMetric(Metric.MORTGAGE_PRINCIPAL, amount);
    }
  }

  // ── Fund transfers ───────────────────────────────────────────────

  hasFundTransfer(name) {
    return this.fundTransfers.some(ft => ft.toDisplayName === name);
  }

  bindFundTransfers(allModels) {
    for (const ft of this.fundTransfers) ft.bind(this, allModels);
  }

  zeroFundTransfersMonthlyMoveValues() {
    for (const ft of this.fundTransfers) ft.monthlyMoveValue = 0;
  }

  combinedFundTransfersMonthlyMoveValue() {
    return this.fundTransfers.reduce((sum, ft) => sum + ft.monthlyMoveValue, 0);
  }

  stochasticLimit(cap = 100) {
    if (this.fundTransfers.length <= 1) return;
    const total = this.combinedFundTransfersMonthlyMoveValue();
    if (total <= cap) return;
    const scale = cap / total;
    for (const ft of this.fundTransfers) ft.monthlyMoveValue *= scale;
  }

  dnaFundTransfers() {
    return this.fundTransfers
      .map(ft => ft.describe(this.displayName))
      .join('\n');
  }

  // ── Withholding ──────────────────────────────────────────────────

  // ── Queries ──────────────────────────────────────────────────────

  inMonth(dateInt) {

    if (this.isClosed) {
      return false;
    }
    else {
      return dateInt.toInt() >= this.startDateInt.toInt()
          && dateInt.toInt() <= this.effectiveFinishDateInt.toInt();

    }
  }

  isFinishDateInt(d) {
    if (this.isClosed) {
      return false;
    }
    else {
      return d && this.effectiveFinishDateInt.year === d.year && this.effectiveFinishDateInt.month === d.month;
    }
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
      isPrimaryHome:   this.isPrimaryHome,
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
