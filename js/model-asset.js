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
import { Metric, METRIC_NAMES, MetricLabel, MetricRollups } from './metric.js';

// Re-export so existing consumers can still import from model-asset.js
export { Metric, MetricLabel, MetricRollups };

const rgb2hex = (rgb) => `#${rgb.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/).slice(1).map(n => parseInt(n, 10).toString(16).padStart(2, '0')).join('')}`;

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
    dividendQualifiedRatio = 1.0,
    annualMaintenanceRate = new ARR(0),
    annualInsuranceCost = Currency.zero(),
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
    this.dividendQualifiedRatio = dividendQualifiedRatio;
    this.longTermCapitalHoldingPercentage = longTermCapitalHoldingPercentage;
    this.annualReturnRate = annualReturnRate;
    this.fundTransfers   = fundTransfers;
    this.isSelfEmployed  = isSelfEmployed;
    this.isPrimaryHome   = isPrimaryHome;
    this.annualTaxRate   = annualTaxRate;
    this.annualMaintenanceRate = annualMaintenanceRate;
    this.annualInsuranceCost = annualInsuranceCost;

    this.behavior      = getBehavior(instrument);
    this.colorId       = 0;
    this.beforeStartDate = false;
    this.onOrAfterStateDate = false;
    this.onOrBeforeFinishDate  = false;
    this.afterFinishDate = false;
    this.isClosed      = false;
    this.closedDateInt = null;

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
      dividendQualifiedRatio: obj.dividendQualifiedRatio ?? 1.0,
      longTermCapitalHoldingPercentage: new ARR(obj.longTermCapitalHoldingPercentage?.annualReturnRate ?? obj.longTermCapitalHoldingPercentage?.rate ?? 0),
      fundTransfers:   (obj.fundTransfers ?? []).map(FundTransfer.fromJSON),
      isSelfEmployed:  obj.isSelfEmployed ?? false,
      isPrimaryHome:   obj.isPrimaryHome ?? true,
      annualTaxRate:   new ARR(obj.annualTaxRate?.annualReturnRate ?? obj.annualTaxRate?.rate ?? 0),
      annualMaintenanceRate: new ARR(obj.annualMaintenanceRate?.annualReturnRate ?? obj.annualMaintenanceRate?.rate ?? 0),
      annualInsuranceCost: new Currency(obj.annualInsuranceCost?.amount ?? 0),
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
      dividendQualifiedRatio: vals.dividendQualifiedRatio ? parseFloat(vals.dividendQualifiedRatio.value) / 100 : 1.0,
      longTermCapitalHoldingPercentage: vals.longTermRate ? ARR.parse(vals.longTermRate.value) : new ARR(0),
      fundTransfers,
      isSelfEmployed: vals.isSelfEmployed?.type === 'checkbox'
        ? vals.isSelfEmployed.checked
        : vals.isSelfEmployed?.value === 'true',
      isPrimaryHome: vals.isPrimaryHome?.type === 'checkbox'
        ? vals.isPrimaryHome.checked
        : (vals.isPrimaryHome?.value !== 'false'),
      annualTaxRate: vals.annualTaxRate ? ARR.parse(vals.annualTaxRate.value) : new ARR(0),
      annualMaintenanceRate: vals.annualMaintenanceRate ? ARR.parse(vals.annualMaintenanceRate.value) : new ARR(0),
      annualInsuranceCost: vals.annualInsuranceCost ? Currency.parse(vals.annualInsuranceCost.value) : Currency.zero(),
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

  get qualifiedDividendCurrency()   { return this.#metrics.get(Metric.QUALIFIED_DIVIDEND).current; }
  set qualifiedDividendCurrency(c)  { this.#metrics.get(Metric.QUALIFIED_DIVIDEND).current = c; }

  get nonQualifiedDividendCurrency()   { return this.#metrics.get(Metric.NON_QUALIFIED_DIVIDEND).current; }
  set nonQualifiedDividendCurrency(c)  { this.#metrics.get(Metric.NON_QUALIFIED_DIVIDEND).current = c; }

  get interestIncomeCurrency()   { return this.#metrics.get(Metric.INTEREST_INCOME).current; }
  set interestIncomeCurrency(c)  { this.#metrics.get(Metric.INTEREST_INCOME).current = c; }

  get ordinaryIncomeCurrency()   { return this.#metrics.get(Metric.ORDINARY_INCOME).current; }
  set ordinaryIncomeCurrency(c)  { this.#metrics.get(Metric.ORDINARY_INCOME).current = c; }

  get employedIncomeCurrency()   { return this.#metrics.get(Metric.EMPLOYED_INCOME).current; }
  set employedIncomeCurrency(c)  { this.#metrics.get(Metric.EMPLOYED_INCOME).current = c; }

  get selfIncomeCurrency()   { return this.#metrics.get(Metric.SELF_INCOME).current; }
  set selfIncomeCurrency(c)  { this.#metrics.get(Metric.SELF_INCOME).current = c; }

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

  get maintenanceCurrency()   { return this.#metrics.get(Metric.MAINTENANCE).current; }
  set maintenanceCurrency(c)  { this.#metrics.get(Metric.MAINTENANCE).current = c; }

  get insuranceCurrency()   { return this.#metrics.get(Metric.INSURANCE).current; }
  set insuranceCurrency(c)  { this.#metrics.get(Metric.INSURANCE).current = c; }

  get contributionCurrency()   { return this.#metrics.get(Metric.CONTRIBUTION).current; }
  set contributionCurrency(c)  { this.#metrics.get(Metric.CONTRIBUTION).current = c; }

  get preTaxContributionCurrency()   { return this.#metrics.get(Metric.PRETAX_CONTRIBUTION).current; }
  set preTaxContributionCurrency(c)  { this.#metrics.get(Metric.PRETAX_CONTRIBUTION).current = c; }

  get postTaxContributionCurrency()   { return this.#metrics.get(Metric.POSTTAX_CONTRIBUTION).current; }
  set postTaxContributionCurrency(c)  { this.#metrics.get(Metric.POSTTAX_CONTRIBUTION).current = c; }

  get tradIRAContributionCurrency()   { return this.#metrics.get(Metric.TRAD_IRA_CONTRIBUTION).current; }
  set tradIRAContributionCurrency(c)  { this.#metrics.get(Metric.TRAD_IRA_CONTRIBUTION).current = c; }

  get rothIRAContributionCurrency()   { return this.#metrics.get(Metric.ROTH_IRA_CONTRIBUTION).current; }
  set rothIRAContributionCurrency(c)  { this.#metrics.get(Metric.ROTH_IRA_CONTRIBUTION).current = c; }

  get four01KContributionCurrency()   { return this.#metrics.get(Metric.FOUR_01K_CONTRIBUTION).current; }
  set four01KContributionCurrency(c)  { this.#metrics.get(Metric.FOUR_01K_CONTRIBUTION).current = c; }

  get taxFreeDistributionCurrency()   { return this.#metrics.get(Metric.TAX_FREE_DISTRIBUTION).current; }
  set taxFreeDistributionCurrency(c)  { this.#metrics.get(Metric.TAX_FREE_DISTRIBUTION).current = c; }

  get taxableDistributionCurrency()   { return this.#metrics.get(Metric.TAXABLE_DISTRIBUTION).current; }
  set taxableDistributionCurrency(c)  { this.#metrics.get(Metric.TAXABLE_DISTRIBUTION).current = c; }

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
  get monthlyQualifiedDividends()    { return this.#metrics.get(Metric.QUALIFIED_DIVIDEND).history; }
  get monthlyNonQualifiedDividends() { return this.#metrics.get(Metric.NON_QUALIFIED_DIVIDEND).history; }
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
  get monthlyPreTaxContributionCurrency()   { return this.#metrics.get(Metric.PRETAX_CONTRIBUTION).history; }
  get monthlyPostTaxContributionCurrency()  { return this.#metrics.get(Metric.POSTTAX_CONTRIBUTION).history; }
  get monthlyTradIRAContributions()  { return this.#metrics.get(Metric.TRAD_IRA_CONTRIBUTION).history; }
  get monthlyRothIRAContributions()  { return this.#metrics.get(Metric.ROTH_IRA_CONTRIBUTION).history; }
  get monthlyFour01KContributions()  { return this.#metrics.get(Metric.FOUR_01K_CONTRIBUTION).history; }
  get monthlyTaxFreeDistributions()  { return this.#metrics.get(Metric.TAX_FREE_DISTRIBUTION).history; }
  get monthlyTaxableDistributions()  { return this.#metrics.get(Metric.TAXABLE_DISTRIBUTION).history; }
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
    this.closedDateInt = null;
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

    } else if (this.isClosed) {

        this.beforeStartDate = false;
        this.onStartDate = false;
        this.onFinishDate = false;
        this.afterFinishDate = true;

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

  credit(amount, note = '') {
    logger.log(LogCategory.TRANSFER,
      `${this.displayName}.credit(${amount.toString()}, '${note}')`);
    return this.#transact(amount.copy(), note);
  }

  debit(amount, note = '') {
    logger.log(LogCategory.TRANSFER,
      `${this.displayName}.debit(${amount.toString()}, '${note}')`);
    return this.#transact(amount.copy().flipSign(), note);
  }

  #transact(amount, note) {
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

    if (note) {
      this.addCreditMemo(amount.copy(), note);
    }

    return { assetChange: amount.copy(), realizedGain };
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

  close(dateInt) {

    // closedValue / closedBasisValue are captured by Portfolio.closeAsset()
    // before fund transfers drain the asset
    this.finishCurrency.zero();

    // since we are closing we won't be tracking value changes anymore
    this.firstDayOfMonthValue.zero();
    this.monthlyValueChange.zero();

    this.isClosed = true;
    if (dateInt) this.closedDateInt = dateInt;

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
      dividendQualifiedRatio: this.dividendQualifiedRatio,
      longTermCapitalHoldingPercentage: this.longTermCapitalHoldingPercentage,
      fundTransfers:   [],
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
    const { creditMemos, creditMemosCheckedIndex, fundTransfers, ...rest } = this;
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
