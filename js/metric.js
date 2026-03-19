/**
 * metric.js
 *
 * Single source of truth for the Metric identity enum, display labels,
 * and the rollup DAG.  Both model-asset.js and instrument-behavior.js
 * import from here — no duplication, no circular dependencies.
 */

// ── Metric identity enum ─────────────────────────────────────────────

export const Metric = Object.freeze({
  VALUE:                        'value',
  GROWTH:                       'growth',
  QUALIFIED_DIVIDEND:           'qualifiedDividend',
  NON_QUALIFIED_DIVIDEND:       'nonQualifiedDividend',
  INTEREST_INCOME:              'interestIncome',
  ORDINARY_INCOME:              'ordinaryIncome',
  EMPLOYED_INCOME:              'employedIncome',
  SELF_INCOME:                  'selfIncome',
  INCOME:                       'income',
  WITHHELD_FICA_TAX:            'withheldFicaTax',
  ESTIMATED_FICA_TAX:           'estimatedFicaTax',       // reserved: future self-employment enhancement
  WITHHELD_INCOME_TAX:          'withheldIncomeTax',
  ESTIMATED_INCOME_TAX:         'estimatedIncomeTax',
  ESTIMATED_TAX:                'estimatedTax',            // reserved: future self-employment enhancement
  INCOME_TAX:                   'incomeTax',
  FEDERAL_TAXES:                'federalTaxes',
  SALT_TAXES:                   'saltTaxes',
  TAXES:                        'taxes',
  NET_INCOME:                   'netIncome',
  EXPENSE:                      'expense',
  CASH_FLOW:                    'cashFlow',
  CASH_FLOW_ACCUMULATED:        'cashFlowAccumulated',
  SHORT_TERM_CAPITAL_GAIN:      'shortTermCapitalGain',
  LONG_TERM_CAPITAL_GAIN:       'longTermCapitalGain',
  CAPITAL_GAIN:                 'capitalGain', // only long term
  RMD:                          'rmd',
  SOCIAL_SECURITY_TAX:          'socialSecurityTax',
  SOCIAL_SECURITY_INCOME:       'socialSecurityIncome',
  MEDICARE_TAX:                 'medicareTax',
  MORTGAGE_PAYMENT:             'mortgagePayment',
  MORTGAGE_INTEREST:            'mortgageInterest',
  MORTGAGE_PRINCIPAL:           'mortgagePrincipal',
  PROPERTY_TAX:                 'propertyTax',
  CONTRIBUTION:                 'contribution',
  PRETAX_CONTRIBUTION:          'preTaxContribution',
  POSTTAX_CONTRIBUTION:         'postTaxContribution',
  TRAD_IRA_CONTRIBUTION:        'tradIRAContribution',
  ROTH_IRA_CONTRIBUTION:        'rothIRAContribution',
  FOUR_01K_CONTRIBUTION:        'four01KContribution',
  TAX_FREE_DISTRIBUTION:        'taxFreeDistribution', // from roth IRA or post tax cash
  TAXABLE_DISTRIBUTION:         'taxableDistribution', // these are distributions from IRA and 401K accounts
  TRAD_IRA_DISTRIBUTION:        'tradIRADistribution',
  ROTH_IRA_DISTRIBUTION:        'rothIRADistribution',
  FOUR_01K_DISTRIBUTION:        'four01KDistribution',
  SHORT_TERM_CAPITAL_GAIN_TAX:  'shortTermCapitalGainTax',
  LONG_TERM_CAPITAL_GAIN_TAX:   'longTermCapitalGainTax',
  MAINTENANCE:                  'maintenance',
  INSURANCE:                    'insurance',
  CREDIT:                       'credit',
});

export const METRIC_NAMES = Object.values(Metric);

// ── Display labels ───────────────────────────────────────────────────

export const MetricLabel = Object.freeze({
  [Metric.VALUE]:                       'Value',
  [Metric.GROWTH]:                      'Growth',
  [Metric.QUALIFIED_DIVIDEND]:          'Qualified Dividend',
  [Metric.NON_QUALIFIED_DIVIDEND]:      'Non-Qualified Dividend',
  [Metric.INTEREST_INCOME]:             'Interest Income',
  [Metric.ORDINARY_INCOME]:             'Ordinary Income',
  [Metric.EMPLOYED_INCOME]:             'Employed Income',
  [Metric.SELF_INCOME]:                 'Self-Employment Income',
  [Metric.INCOME]:                      'Income',
  [Metric.WITHHELD_FICA_TAX]:           'Withheld FICA / Medicare',
  [Metric.ESTIMATED_FICA_TAX]:          'Estimated FICA / Medicare',
  [Metric.WITHHELD_INCOME_TAX]:         'Withheld Income Tax',
  [Metric.ESTIMATED_INCOME_TAX]:        'Estimated Income Tax',
  [Metric.ESTIMATED_TAX]:               'Estimated Tax',
  [Metric.INCOME_TAX]:                  'Income Tax',
  [Metric.FEDERAL_TAXES]:               'Federal Taxes',
  [Metric.SALT_TAXES]:                  'State and Local Taxes',
  [Metric.TAXES]:                       'All Taxes',
  [Metric.NET_INCOME]:                  'Net Income',
  [Metric.EXPENSE]:                     'Expense',
  [Metric.CASH_FLOW]:                   'Cash Flow',
  [Metric.CASH_FLOW_ACCUMULATED]:       'Cash Flow Accumulated',
  [Metric.SHORT_TERM_CAPITAL_GAIN]:     'Short Term Capital Gain',
  [Metric.LONG_TERM_CAPITAL_GAIN]:      'Long Term Capital Gain',
  [Metric.CAPITAL_GAIN]:                'Capital Gain',
  [Metric.RMD]:                         'Required Min. Distribution',
  [Metric.SOCIAL_SECURITY_TAX]:         'Social Security Tax',
  [Metric.SOCIAL_SECURITY_INCOME]:      'Social Security Income',
  [Metric.MEDICARE_TAX]:                'Medicare Tax',
  [Metric.MORTGAGE_PAYMENT]:            'Mortgage Payment',
  [Metric.MORTGAGE_INTEREST]:           'Mortgage Interest',
  [Metric.MORTGAGE_PRINCIPAL]:          'Mortgage Principal',
  [Metric.CONTRIBUTION]:                'Contribution',
  [Metric.PRETAX_CONTRIBUTION]:         'Pre Tax Contribution',
  [Metric.POSTTAX_CONTRIBUTION]:        'Post Tax Contribution',
  [Metric.TRAD_IRA_CONTRIBUTION]:       'Traditional IRA Contribution',
  [Metric.ROTH_IRA_CONTRIBUTION]:       'Roth IRA Contribution',
  [Metric.FOUR_01K_CONTRIBUTION]:       '401K Contribution',
  [Metric.TAX_FREE_DISTRIBUTION]:       'Tax Free Distribution',
  [Metric.TAXABLE_DISTRIBUTION]:        'Taxable Distribution',
  [Metric.TRAD_IRA_DISTRIBUTION]:       'Traditional IRA Distribution',
  [Metric.ROTH_IRA_DISTRIBUTION]:       'Roth IRA Distribution',
  [Metric.FOUR_01K_DISTRIBUTION]:       '401K Distribution',
  [Metric.SHORT_TERM_CAPITAL_GAIN_TAX]: 'Short Term Capital Gain Tax',
  [Metric.LONG_TERM_CAPITAL_GAIN_TAX]:  'Long Term Capital Gain Tax',
  [Metric.MAINTENANCE]:                 'Maintenance',
  [Metric.INSURANCE]:                   'Insurance',
  [Metric.CREDIT]:                      'Credit',
});

// ── Rollup DAG ───────────────────────────────────────────────────────
// Child Metric -> Array of Parent Metrics.
// addToMetric(child, amount) automatically propagates up via these edges.

export const MetricRollups = {
    // --- FOUNDATIONAL INCOME TO ORDINARY INCOME ---
    [Metric.TRAD_IRA_DISTRIBUTION]:       [Metric.TAXABLE_DISTRIBUTION],
    [Metric.FOUR_01K_DISTRIBUTION]:       [Metric.TAXABLE_DISTRIBUTION],
    [Metric.RMD]:                         [Metric.TAXABLE_DISTRIBUTION],

    [Metric.TAXABLE_DISTRIBUTION]:        [Metric.ORDINARY_INCOME],
    [Metric.EMPLOYED_INCOME]:             [Metric.ORDINARY_INCOME],
    [Metric.SELF_INCOME]:                 [Metric.ORDINARY_INCOME],
    [Metric.INTEREST_INCOME]:             [Metric.ORDINARY_INCOME],
    [Metric.SOCIAL_SECURITY_INCOME]:      [Metric.ORDINARY_INCOME],
    [Metric.SHORT_TERM_CAPITAL_GAIN]:     [Metric.ORDINARY_INCOME], // Taxed at ordinary rates

    // --- FOUNDATIONAL GAINS TO CAPITAL GAINS ---
    [Metric.LONG_TERM_CAPITAL_GAIN]:      [Metric.CAPITAL_GAIN],

    // --- MASTER COMBINATIONS TO RETIREMENT PLANS ---
    [Metric.FOUR_01K_CONTRIBUTION]:       [Metric.PRETAX_CONTRIBUTION],
    [Metric.TRAD_IRA_CONTRIBUTION]:       [Metric.PRETAX_CONTRIBUTION],
    [Metric.ROTH_IRA_CONTRIBUTION]:       [Metric.POSTTAX_CONTRIBUTION],
    [Metric.PRETAX_CONTRIBUTION]:         [Metric.CONTRIBUTION],
    [Metric.POSTTAX_CONTRIBUTION]:        [Metric.CONTRIBUTION],

    // --- MASTER COMBINATIONS TO TOTAL INCOME ---
    [Metric.ORDINARY_INCOME]:             [Metric.INCOME],
    [Metric.CAPITAL_GAIN]:                [Metric.INCOME],
    [Metric.ROTH_IRA_DISTRIBUTION]:       [Metric.TAX_FREE_DISTRIBUTION], // Non-taxable, but still cash flow income
    [Metric.TAX_FREE_DISTRIBUTION]:       [Metric.INCOME],
    [Metric.NON_QUALIFIED_DIVIDEND]:      [Metric.ORDINARY_INCOME],
    [Metric.QUALIFIED_DIVIDEND]:          [Metric.INCOME],

    [Metric.MEDICARE_TAX]:                [Metric.WITHHELD_FICA_TAX],
    [Metric.SOCIAL_SECURITY_TAX]:         [Metric.WITHHELD_FICA_TAX],

    // --- TAX ROLLUPS ---
    [Metric.WITHHELD_FICA_TAX]:           [Metric.INCOME_TAX],
    [Metric.WITHHELD_INCOME_TAX]:         [Metric.INCOME_TAX],
    [Metric.ESTIMATED_INCOME_TAX]:        [Metric.INCOME_TAX],
    [Metric.SHORT_TERM_CAPITAL_GAIN_TAX]: [Metric.INCOME_TAX],

    [Metric.INCOME_TAX]:                  [Metric.FEDERAL_TAXES],
    [Metric.LONG_TERM_CAPITAL_GAIN_TAX]:  [Metric.FEDERAL_TAXES],

    // --- EXPENSE & DEBT ROLLUPS ---
    [Metric.MORTGAGE_INTEREST]:           [Metric.MORTGAGE_PAYMENT],
    [Metric.MORTGAGE_PRINCIPAL]:          [Metric.MORTGAGE_PAYMENT],
    [Metric.MORTGAGE_PAYMENT]:            [Metric.EXPENSE],
    [Metric.PROPERTY_TAX]:                [Metric.SALT_TAXES],
    [Metric.FEDERAL_TAXES]:               [Metric.TAXES],
    [Metric.SALT_TAXES]:                  [Metric.TAXES],
    [Metric.MAINTENANCE]:                 [Metric.EXPENSE],
    [Metric.INSURANCE]:                   [Metric.EXPENSE],
};