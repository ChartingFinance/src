import { Currency } from './utils/currency.js';
import { InstrumentType } from './instruments/instrument.js';
// ── Result Type ──────────────────────────────────────────────────────

export class WithholdingResult {
  constructor(medicareTax = Currency.zero(), socialSecurityTax = Currency.zero(), income = Currency.zero()) {
    this.medicareTax       = medicareTax instanceof Currency ? medicareTax.copy() : new Currency(medicareTax);
    this.socialSecurityTax = socialSecurityTax instanceof Currency ? socialSecurityTax.copy() : new Currency(socialSecurityTax);
    this.income            = income instanceof Currency ? income.copy() : new Currency(income);
  }

  fica() {
    return new Currency(this.medicareTax.amount + this.socialSecurityTax.amount);
  }

  total() {
    return this.fica().add(this.income);
  }

  flipSigns() {
    this.medicareTax.flipSign();
    this.socialSecurityTax.flipSign();
    this.income.flipSign();
  }
}
import { logger, LogCategory } from './utils/logger.js';
import { global_filingAs, global_inflationRate, global_propertyTaxDeductionMax,
         FilingStatus, FILING_STATUSES } from './globals.js';
import { taxableBasis } from './tax-basis.js';

/**
 * Bracket rows are HALF-OPEN: `[fromAmount, toAmount)`. Each row's `fromAmount`
 * is exactly the previous row's `toAmount`, so the bands tile with no gap and no
 * overlap.
 *
 * The IRS publishes them the other way — "$12,401 to $50,400" — and this file
 * used to copy that literally. But `calculateYearlyIncomeTax` charges
 * `(toAmount − fromAmount)` for a fully-spanned band, so every published `+1`
 * boundary lost a dollar of base, and income landing in the one-dollar gap was
 * taxed at no rate at all. Measured by an independent hand calculation on
 * 2026-08-06 (spec 6 post-test T5): a $90,355.80 taxable income crossing three
 * boundaries under-taxed by $0.37.
 *
 * Do not "correct" these back to the published figures. If a boundary needs
 * checking, check the `toAmount` against the IRS release — those are the
 * authoritative numbers here, and the `fromAmount` is derived from them.
 *
 * Two transcription errors surfaced when the bands were made to tile: the 2025
 * single table had 250,556 where the IRS says the 35% band starts at 250,526,
 * and 626,251 where the 37% band starts at 626,351. The first left 31 dollars
 * untaxed; the second made the rows OVERLAP by 99 dollars, which the loop taxed
 * at 35% and 37% both. Deriving `fromAmount` from `toAmount` repairs both.
 */
export const us_2026_taxtables = {
    "year": 2026,
    "fica": {
        "url": "https://www.ssa.gov/oact/cola/cbb.html",
        "ssHalfRate": 0.062,
        "ssFullRate": 0.124,
        "medicareHalfRate": 0.0145,
        "medicareFullRate": 0.0290,
        "maxSSEarnings": 184500.0
    },
    "income": {
        "url": "https://www.irs.gov/newsroom/irs-releases-tax-inflation-adjustments-for-tax-year-2026-including-amendments-from-the-one-big-beautiful-bill",
        "tables": [
            {
                "filingType": "single",
                "taxRows": [
                    {"rate": 0.10, "fromAmount": 0.0, "toAmount": 12400.0},
                    {"rate": 0.12, "fromAmount": 12400.0, "toAmount": 50400.0},
                    {"rate": 0.22, "fromAmount": 50400.0, "toAmount": 105700.0},
                    {"rate": 0.24, "fromAmount": 105700.0, "toAmount": 201775.0},
                    {"rate": 0.32, "fromAmount": 201775.0, "toAmount": 256225.0},
                    {"rate": 0.35, "fromAmount": 256225.0, "toAmount": 640600.0},
                    {"rate": 0.37, "fromAmount": 640600.0, "toAmount": -1.0}
                ]
            },
            {
                "filingType": "married",
                "taxRows": [
                    {"rate": 0.10, "fromAmount": 0.0, "toAmount": 24800.0},
                    {"rate": 0.12, "fromAmount": 24800.0, "toAmount": 100800.0},
                    {"rate": 0.22, "fromAmount": 100800.0, "toAmount": 211400.0},
                    {"rate": 0.24, "fromAmount": 211400.0, "toAmount": 403550.0},
                    {"rate": 0.32, "fromAmount": 403550.0, "toAmount": 512450.0},
                    {"rate": 0.35, "fromAmount": 512450.0, "toAmount": 768700.0},
                    {"rate": 0.37, "fromAmount": 768700.0, "toAmount": -1.0}
                ]
            }
        ]
    },
    "capitalGains": {
        "url": "https://www.irs.gov/taxtopics/tc409",
        "tables": [
            {
                "filingType": "single",
                "taxRows": [
                    {"rate": 0.0, "fromAmount": 0.0, "toAmount": 49450.0},
                    {"rate": 0.15, "fromAmount": 49450.0, "toAmount": 545500.0},
                    {"rate": 0.2, "fromAmount": 545500.0, "toAmount": -1.0}
                ]
            },
            {
                "filingType": "married",
                "taxRows": [
                    {"rate": 0.0, "fromAmount": 0.0, "toAmount": 98900.0},
                    {"rate": 0.15, "fromAmount": 98900.0, "toAmount": 613700.0},
                    {"rate": 0.2, "fromAmount": 613700.0, "toAmount": -1.0}
                ]
            }
        ]
    },
    "standardDeduction": {
        "url": "https://www.irs.gov/newsroom/irs-releases-tax-inflation-adjustments-for-tax-year-2026-including-amendments-from-the-one-big-beautiful-bill",
        "single": 16100.0,
        "married": 32200.0
    },
    // IRC §121. NOT inflation-indexed — unchanged since 1997, unlike every other
    // figure in this table. See the note in inflateTaxes().
    "homeSaleExclusion": {
        "url": "https://www.irs.gov/taxtopics/tc701",
        "single": 250000.0,
        "married": 500000.0
    }
};

export const us_2025_taxtables = {
    "year": 2025,
    "fica": {
        "url": "https://www.irs.gov/taxtopics/tc751",
        "ssHalfRate": 0.062,
        "ssFullRate": 0.124,
        "medicareHalfRate": 0.0145,
        "medicareFullRate": 0.0290,
        "maxSSEarnings": 176100.0
    },
    "income": {
        "url": "https://www.irs.gov/newsroom/irs-provides-tax-inflation-adjustments-for-tax-year-2024",
        "tables": [
            { 
                "filingType": "single",
                "taxRows": [
                    {"rate": 0.10, "fromAmount": 0.0, "toAmount": 11925.0},
                    {"rate": 0.12, "fromAmount": 11925.0, "toAmount": 48475.0},
                    {"rate": 0.22, "fromAmount": 48475.0, "toAmount": 103350.0},
                    {"rate": 0.24, "fromAmount": 103350.0, "toAmount": 197300.0},
                    {"rate": 0.32, "fromAmount": 197300.0, "toAmount": 250525.0},
                    {"rate": 0.35, "fromAmount": 250525.0, "toAmount": 626350.0},
                    {"rate": 0.37, "fromAmount": 626350.0, "toAmount": -1.0 }
                ]
            },
            {
                "filingType": "married",
                "taxRows": [
                    {"rate": 0.10, "fromAmount": 0.0, "toAmount": 23850.0},
                    {"rate": 0.12, "fromAmount": 23850.0, "toAmount": 96950.0},
                    {"rate": 0.22, "fromAmount": 96950.0, "toAmount": 206700.0},
                    {"rate": 0.24, "fromAmount": 206700.0, "toAmount": 394600.0},
                    {"rate": 0.32, "fromAmount": 394600.0, "toAmount": 501050.0},
                    {"rate": 0.35, "fromAmount": 501050.0, "toAmount": 751600.0},
                    {"rate": 0.37, "fromAmount": 751600.0, "toAmount": -1.0}
                ]
            }
        ]
    },
    "capitalGains": {
        "url": "https://www.irs.gov/taxtopics/tc409",
        "tables": [
            {
                "filingType": "single",
                "taxRows": [
                {"rate": 0.0, "fromAmount": 0.0, "toAmount": 48350.0 },
                {"rate": 0.15, "fromAmount": 48350.0, "toAmount": 533400.0 },
                {"rate": 0.2, "fromAmount": 533400.0, "toAmount": -1.0 }
                ]
            },
            {
                "filingType": "married",
                "taxRows": [
                    {"rate": 0.0, "fromAmount": 0.0, "toAmount": 96700.0 },
                    {"rate": 0.15, "fromAmount": 96700.0, "toAmount": 600050.0 },
                    {"rate": 0.2, "fromAmount": 600050.0, "toAmount": -1.0 }                    
                ]
            }
        ]
    },
    "standardDeduction": {
        "url": "https://www.irs.gov/newsroom/irs-provides-tax-inflation-adjustments-for-tax-year-2024",
        "single": 15000.0,
        "married": 30000.0
    },
    // IRC §121 — same figures as 2026, because it is not inflation-indexed.
    "homeSaleExclusion": {
        "url": "https://www.irs.gov/taxtopics/tc701",
        "single": 250000.0,
        "married": 500000.0
    }
};

// https://www.irs.gov/publications/p590b
export const uniformLifetimeTable = [
    { age: 72, divisor: 27.4 },
    { age: 73, divisor: 26.5 },
    { age: 74, divisor: 25.6 },
    { age: 75, divisor: 24.7 },
    { age: 76, divisor: 23.8 },
    { age: 77, divisor: 22.9 },
    { age: 78, divisor: 22.0 },
    { age: 79, divisor: 21.1 },
    { age: 80, divisor: 20.2 },
    { age: 81, divisor: 19.4 },
    { age: 82, divisor: 18.5 },
    { age: 83, divisor: 17.7 },
    { age: 84, divisor: 16.8 },
    { age: 85, divisor: 16.0 },
    { age: 86, divisor: 15.2 },
    { age: 87, divisor: 14.4 },
    { age: 88, divisor: 13.7 },
    { age: 89, divisor: 12.9 },
    { age: 90, divisor: 12.2 },
    { age: 91, divisor: 11.5 },
    { age: 92, divisor: 10.8 },
    { age: 93, divisor: 10.1 },
    { age: 94, divisor: 9.5 },
    { age: 95, divisor: 8.9 },
    { age: 96, divisor: 8.4 },
    { age: 97, divisor: 7.8 },
    { age: 98, divisor: 7.3 },
    { age: 99, divisor: 6.8 },
    { age: 100, divisor: 6.4 },
    { age: 101, divisor: 6.0 },
    { age: 102, divisor: 5.6 },
    { age: 103, divisor: 5.2 },
    { age: 104, divisor: 4.9 },
    { age: 105, divisor: 4.6 },
    { age: 106, divisor: 4.3 },
    { age: 107, divisor: 4.1 },
    { age: 108, divisor: 3.9 },
    { age: 109, divisor: 3.7 },
    { age: 110, divisor: 3.5 },
    { age: 111, divisor: 3.4 },
    { age: 112, divisor: 3.3 },
    { age: 113, divisor: 2.1 },
    { age: 114, divisor: 3.0 },
    { age: 115, divisor: 2.9 },
    { age: 116, divisor: 2.8 },
    { age: 117, divisor: 2.7 },
    { age: 118, divisor: 2.5 },
    { age: 119, divisor: 2.3 },
    { age: 120, divisor: 2.0 }
];

/**
 * FilingStatus -> the `filingType` key used inside the tax tables. The tables
 * keep their own vocabulary ("single" / "married", matching the IRS releases
 * they are transcribed from); this is the only place the two meet.
 */
const FILING_TYPE_KEY = Object.freeze({
    [FilingStatus.SINGLE]: 'single',
    [FilingStatus.MARRIED_FILING_JOINTLY]: 'married',
});

/**
 * Annual contribution limits, by filing-table key.
 *
 * HOUSEHOLD figures, not per-person — spec 5 scoped MFJ to the household level,
 * and every limit is enforced against a household aggregate (payroll-engine
 * compares against this.yearly.four01KContribution, summed across all income
 * assets). So a married limit is the per-person statutory figure DOUBLED, and
 * saying that here is the point of the table: the previous code doubled the IRA
 * limit and left the 401(k) one alone, which is not a policy anyone chose.
 */
export const ContributionKind = Object.freeze({
    IRA: 'ira',
    FOUR01K: '401k',
});

const CONTRIBUTION_LIMITS = Object.freeze({
    single:  { iraBelow50:  7500, ira50AndOver:  8600, four01KBelow50: 24500, four01K50AndOver: 32500 },
    married: { iraBelow50: 15000, ira50AndOver: 17200, four01KBelow50: 49000, four01K50AndOver: 65000 },
});

export class TaxTable {
    constructor() {
        this.taxes = null;     
        this.initializeChron();
        this.singleContributionLimitBelow50
    }

    initializeChron() {
        
        this.activeTaxTables = JSON.parse(JSON.stringify(us_2026_taxtables));

        // Selected BY KEY, not by array index and an else. The old form made
        // every unrecognised status file jointly by falling through, so 'MFJ'
        // worked by accident and a future 'MFS' would have too.
        const key = FILING_TYPE_KEY[global_filingAs];
        if (!key) {
            throw new Error(`TaxTable: filing status ${JSON.stringify(global_filingAs)} `
                + `is not one of ${FILING_STATUSES.join(', ')}`);
        }
        const byKey = (tables) => {
            const found = tables.find((t) => t.filingType === key);
            if (!found) throw new Error(`TaxTable: no ${key} table`);
            return found;
        };

        this.activeIncomeTable = byKey(this.activeTaxTables.income.tables);
        this.activeCapitalGainsTable = byKey(this.activeTaxTables.capitalGains.tables);
        this.activeStandardDeduction = this.activeTaxTables.standardDeduction[key];
        this.activeHomeSaleExclusion = this.activeTaxTables.homeSaleExclusion[key];

        const limits = CONTRIBUTION_LIMITS[key];
        this.iraContributionLimitBelow50 = limits.iraBelow50;
        this.iraContributionLimit50AndOver = limits.ira50AndOver;
        this.four01KContributionLimitBelow50 = limits.four01KBelow50;
        this.four01KContributionLimit50AndOver = limits.four01K50AndOver;

        this.yearlySocialSecurityAccumulator = new Currency();

    }

    monthlyChron() {

    }

    addYearlySocialSecurity(amount) {

        this.yearlySocialSecurityAccumulator.add(amount);
        
    }

    yearlyChron(inflationOverride) {

        this.yearlySocialSecurityAccumulator.zero();

        // apply inflation to the tax rows
        this.inflateTaxes(inflationOverride);

    }

    finalizeChron() {

    }

    inflateTaxRows(taxTables, r) {
        for (let taxTable of taxTables) {
            for (let taxRow of taxTable.taxRows) {
                taxRow.fromAmount *= r;
                if (taxRow.toAmount != -1.0)
                    taxRow.toAmount *= r;
            }
        }
    }

    inflateTaxes(inflationOverride) {

        const r = 1.0 + (inflationOverride != null ? inflationOverride : global_inflationRate);
        this.activeTaxTables.fica.maxSSEarnings *= r;
        this.inflateTaxRows(this.activeTaxTables.income.tables, r);
        this.inflateTaxRows(this.activeTaxTables.capitalGains.tables, r);
        this.activeStandardDeduction *= r;
        // activeHomeSaleExclusion is deliberately absent. IRC §121 fixed it at
        // $250,000 / $500,000 in 1997 with no inflation indexing, so a plan that
        // inflated it would under-tax every long-held home — by a factor of 2.4
        // over a 30-year plan at 3.1%. Everything else in this method is indexed
        // by statute; this one is the exception, so it is called out rather than
        // looking like an omission.
        this.iraContributionLimitBelow50 *= r;
        this.iraContributionLimit50AndOver *= r;
        this.four01KContributionLimitBelow50 *= r;
        this.four01KContributionLimit50AndOver *= r;

    }

    isEstimatedTaxPaymentDue(currentDateInt) {
        return (currentDateInt.month == 1 || currentDateInt.month == 4 || currentDateInt.month == 6 || currentDateInt.month == 9);
    }

    isYearlyTaxPaymentDue(currentDateInt) {
        return (currentDateInt.month == 4);
    }    

    calculateMonthlyWithholding(isSelfEmployed, income) {

        let result = this.calculateFICATax(isSelfEmployed, income);
        result.income.add(this.calculateMonthlyIncomeTax(income, new Currency()));                        
        return result;

    }

    calculateFICATax(isSelfEmployed, income) {

        let result = new WithholdingResult(new Currency(), new Currency(), new Currency());
        result.socialSecurityTax.add(this.calculateSocialSecurityTax(isSelfEmployed, income));
        result.medicareTax.add(this.calculateMedicareTax(isSelfEmployed, income));

        if (isSelfEmployed && result.fica().amount / income.amount > 0.16) {
            logger.log(LogCategory.TAX, 'TaxTable.calculateFICATax: ratio over 16%?');
        }
        else if (result.fica().amount / income.amount > 0.08) {
            logger.log(LogCategory.TAX, 'TaxTable.calculateFICATax: ratio over 8%?');
        }
        //else {
        //    let ratio = result.fica().amount / income.amount;
        //    logger.log(LogCategory.TAX, 'TaxTable.calculateFICATax: ratio is ' + ratio.toString());
        //}

        return result;

    }

    calculateSocialSecurityTax(isSelfEmployed, income) {

        let c = null;
        let maxC = null;
        if (isSelfEmployed) {
            c = new Currency(income.amount * this.activeTaxTables.fica.ssFullRate);
            maxC = new Currency(this.activeTaxTables.fica.maxSSEarnings * this.activeTaxTables.fica.ssFullRate);
        }
        else {
            c = new Currency(income.amount * this.activeTaxTables.fica.ssHalfRate);
            maxC = new Currency(this.activeTaxTables.fica.maxSSEarnings * this.activeTaxTables.fica.ssHalfRate);
        }
            
        if (this.yearlySocialSecurityAccumulator.amount + c.amount > maxC.amount) {
            logger.log(LogCategory.TAX, 'at maximum social security tax');
            c.amount = maxC.amount - this.yearlySocialSecurityAccumulator.amount;
        }

        return c;

    }

    calculateMedicareTax(isSelfEmployed, income) {        

        let c = new Currency();
        if (isSelfEmployed)
            c = new Currency(income.amount * this.activeTaxTables.fica.medicareFullRate);
        else
            c = new Currency(income.amount * this.activeTaxTables.fica.medicareHalfRate);

        //modelAsset.addMonthlyMedicare(c);
        return c;

    }

    /*
    estimateMonthlyIncomeTax(monthly, income) {

        let yearly = monthly.copy();
        yearly.multiply(12.0);
        let yearlyIncome = new Currency(income.amount * 12.0);

        yearlyIncome = this.applyYearlyDeductions(yearly, yearlyIncome);
        let yearlyTax = this.calculateYearlyIncomeTax(yearlyIncome);
        let monthlyTax = new Currency(yearlyTax.amount / 12.0);
        return monthlyTax;

    }
    */
    
    calculateYearlyIncomeTax(income, deduction) {

        let adjusted = new Currency(income.amount);
        if (deduction)
            adjusted.subtract(deduction.amount);

        let tax = 0.0;
        for (const taxRow of this.activeIncomeTable.taxRows) {
            if (adjusted.amount < taxRow.fromAmount)
                break;
            else if (adjusted.amount >= taxRow.fromAmount && adjusted.amount >= taxRow.toAmount && taxRow.toAmount != -1)
                tax += (taxRow.toAmount - taxRow.fromAmount) * taxRow.rate;
            else if ((adjusted.amount >= taxRow.fromAmount && adjusted.amount < taxRow.toAmount) || (taxRow.toAmount == -1)) {
                tax += (adjusted.amount - taxRow.fromAmount) * taxRow.rate;                
                break;
            }
        }

        return new Currency(tax);

    }

    /*
    estimateMonthlyLongTermCapitalGainsTax(taxableIncome, capitalGains) {

        let yearlyIncome = new Currency(income.amount * 12.0);
        let yearlyCapitalGains = new Currency(capitalGains.amount * 12.0);
        
        let yearlyTax = this.calculateYearlyLongTermCapitalGainsTax(yearlyIncome, yearlyCapitalGains);
        let monthlyTax = new Currency(yearlyTax.amount / 12.0);
        return monthlyTax;

    }
    */

    calculateYearlyLongTermCapitalGainsTax(taxableIncome, capitalGains) {          
        
        let tax = 0.0;
        let combinedIncome = taxableIncome.copy().add(capitalGains);
        for (const taxRow of this.activeCapitalGainsTable.taxRows) {

            let taxableAmount = 0.0;

            if (taxRow.toAmount === -1) {
                // Handle the last tax bracket (no upper limit)
                if (combinedIncome.amount > taxRow.fromAmount) {
                    taxableAmount = Math.min(capitalGains.amount, combinedIncome.amount - taxRow.fromAmount);
                }
            } else {
                // Handle regular tax brackets
                const lowerBound = Math.max(taxRow.fromAmount, taxableIncome.amount);
                const upperBound = Math.min(taxRow.toAmount, combinedIncome.amount);
    
                if (upperBound > lowerBound) {
                    taxableAmount = upperBound - lowerBound;
                }
            }
    
            tax += taxableAmount * taxRow.rate;

        }        

        return new Currency(tax);

    }

    calculateCapitalGainsTax(capitalGains, holdingMonths, isPrimaryHome, annualizedIncome) {
        const isLongTerm = holdingMonths > 12;

        if (isLongTerm) {
            let taxableGains = capitalGains.copy();
            if (holdingMonths > 24 && isPrimaryHome) {
                taxableGains.amount -= this.activeHomeSaleExclusion;
                if (taxableGains.amount < 0) taxableGains.zero();
            }
            const tax = this.calculateYearlyLongTermCapitalGainsTax(annualizedIncome, taxableGains);
            // How much §121 actually removed — the difference, not the headline
            // exclusion, because a gain smaller than the exclusion only uses
            // part of it. The caller has to tell the annual true-up, which
            // otherwise recomputes the year from the gross gain and hands the
            // exclusion straight back. Derived here rather than recomputed
            // there so the clamp above cannot be applied twice differently.
            const excluded = capitalGains.amount - taxableGains.amount;
            return { isLongTerm: true, tax, excluded };
        } else {
            const tax = this.calculateYearlyIncomeTax(capitalGains);
            return { isLongTerm: false, tax, excluded: 0 };
        }
    }

    getMarginalLTCGRate(taxableIncome) {
        for (const taxRow of this.activeCapitalGainsTable.taxRows) {
            const upper = taxRow.toAmount === -1 ? Infinity : taxRow.toAmount;
            if (taxableIncome.amount <= upper)
                return taxRow.rate;
        }
        // Fallback to the last bracket's rate
        const rows = this.activeCapitalGainsTable.taxRows;
        return rows[rows.length - 1].rate;
    }

    calculateMonthlyEstimatedTaxes(modelAsset) {
        return new Currency();
    }

    addLongTermCapitalGains(currency) {
        this.yearlyLongTermCapitalGainsAccumulator.add(currency);
    }

    calculateMonthlyMortgageDeduction(currentDateInt, modelAsset) {
        if (InstrumentType.isMortgage(modelAsset.instrument)) {
            let c = new Currency(modelAsset.cashFlowCurrency.amount * -1.0);
            return c;
        }
        else
            return new Currency(0);
    }

    calculateMonthlyRMD(currentDateInt, activeUser, modelAsset) {
        if (InstrumentType.isTaxDeferred(modelAsset.instrument)) {
            let divisor = 0;
            for (const table of uniformLifetimeTable) {
                if (table.age == activeUser.age) {
                    divisor = table.divisor;
                    break;
                }
            }
            if (divisor == 0) {
                logger.log(LogCategory.TAX, 'TaxTable.calculateRMD: could not find divisor for age ' + activeUser.age);
                return new Currency(0);
            }

            let index = modelAsset.monthlyValues.length - currentDateInt.month;
            if (index < 0)
                index = 0;
            let value = modelAsset.monthlyValues[index];

            // IRS rule: RMD divides the prior-year December 31 balance, which
            // the index above finds in the VALUE metric history. But history
            // tracking is disabled during GA fitness runs (Simulator
            // _setTrackHistory) — the lookup then returns undefined, and
            // undefined/divisor is NaN, which Currency coerces to $0. That
            // silently removed RMDs from every fitness world while the real
            // run kept them, so the optimizer scored candidates against rules
            // the recommendation would never face. Fall back to the live
            // balance: an approximation of prior-Dec-31, but it keeps
            // history-less runs in the same tax regime as tracked runs.
            if (!Number.isFinite(value)) {
                value = modelAsset.finishCurrency.amount;
            }

            let rmd = value / divisor;

            rmd /= 12.0;
            return new Currency(rmd);
        }
        return new Currency(0);
    }

    applyYearlyDeductions(yearly, taxableIncome) {

        let propertyTaxDeduction = new Currency(yearly.propertyTaxes.amount);
        
        if (propertyTaxDeduction.amount < 0)
            propertyTaxDeduction.flipSign();

        // maximum property tax deduction
        if (propertyTaxDeduction.amount > global_propertyTaxDeductionMax)
            propertyTaxDeduction.amount = global_propertyTaxDeductionMax;

        if (propertyTaxDeduction.amount > 0)
            propertyTaxDeduction.flipSign();

        let totalDeduction = new Currency(yearly.mortgageInterest.amount + propertyTaxDeduction.amount);
        totalDeduction.flipSign();

        if (totalDeduction.amount > this.activeStandardDeduction) {
            taxableIncome.subtract(totalDeduction);
        }
        else {
            let c = new Currency(this.activeStandardDeduction);;            
            taxableIncome.subtract(c);
        }

        if (yearly.four01KContribution.amount > 0)
            taxableIncome.subtract(yearly.four01KContribution);
        else
            taxableIncome.subtract(yearly.tradIRAContribution);


        if (taxableIncome.amount < 0) {
            logger.log(LogCategory.TAX, 'TaxTable.applyYearlyDeductions: taxable income < 0, setting to 0');
            taxableIncome.zero();
        }

        return taxableIncome;

    }

    /**
     * VESTIGIAL. Logs three self-checks and returns an empty Currency; nothing
     * reads its result and no caller branches on it.
     *
     * The middle check is worse than useless: it compares POST-deduction
     * taxable income against GROSS wages (`selfIncome + employedIncome`), which
     * cannot agree except by coincidence, so its "check PASSED" branch is
     * effectively unreachable and its failure branch logs on every run. It has
     * no recorded taxable-income field to compare against — the FinancialPackage
     * does not carry one — so the check cannot be repaired without first
     * deciding what it was meant to assert.
     *
     * Left in place deliberately: spec 6 step 6 must not change behaviour, and
     * deleting it is a separate decision with its own (small) log-output
     * consequences. Flagged rather than quietly removed.
     */
    reconcileYearlyTax(yearly, activeUser) {

        let yearlyFICA = this.calculateYearlyFICATax(yearly);
        if (yearlyFICA.amount != yearly.fica.amount)
            logger.log(LogCategory.TAX, 'computed yearly FICA != portfolio yearly FICA')
        else
            logger.log(LogCategory.TAX, 'computed yearly FICA check PASSED');

        let yearlyTaxableIncome = taxableBasis(yearly, activeUser, { taxTable: this }).ordinaryTaxable;
        if (yearlyTaxableIncome.amount != (yearly.selfIncome.amount + yearly.employedIncome.amount))
            logger.log(LogCategory.TAX, 'computed yearly taxable income != portfolio yearly taxable income');
        else
            logger.log(LogCategory.TAX, 'computed yearly taxable income check PASSED');

        let yearlyIncomeTax = this.calculateYearlyIncomeTax(yearlyTaxableIncome, new Currency());
        if (yearlyIncomeTax.amount != yearly.incomeTax.amount)
            logger.log(LogCategory.TAX, 'computed yearly income tax != portfolio yearly income tax');
        else
            logger.log(LogCategory.TAX, 'computed yearly income tax check PASSED');

        return new Currency();

    }

    calculateYearlyFICATax(yearly) {
        
        let ficaTaxSelf = this.calculateFICATax(true, yearly.selfIncome);
        let ficaTaxEmployed = this.calculateFICATax(false, yearly.employedIncome);        
        return new Currency(ficaTaxSelf.amount + ficaTaxEmployed.amount);

    }

    calculateYearlyTaxableIncome(yearly) {
        
        let taxableIncome = yearly.irsTaxableGrossIncome();
        return this.applyYearlyDeductions(yearly, taxableIncome);

    }

    /*
    calculateYearlyNonFICATaxableIncome(yearly) {

        let nonFICATaxableIncome = new Currency(yearly.selfIncome.amount + yearly.employedIncome.amount);
        nonFICATaxableIncome.add(yearly.tradIRADistribution);
        nonFICATaxableIncome.add(yearly.shortTermCapitalGains);   
        nonFICATaxableIncome.add(yearly.interest);
        return this.applyYearlyDeductions(yearly, nonFICATaxableIncome);

    }
    */

    applyYear(yearly, activeUser) {
        this.reconcileYearlyTax(yearly, activeUser);

        let yearlyFICATax = this.calculateYearlyFICATax(yearly);
        const basis = taxableBasis(yearly, activeUser, { taxTable: this });
        let yearlyTaxableIncome = basis.ordinaryTaxable;
        let yearlyIncomeTax = this.calculateYearlyIncomeTax(yearlyTaxableIncome);

        let yearlyLongTermCapitalGainsAndQualifiedDividendsTax = this.calculateYearlyLongTermCapitalGainsTax(yearlyTaxableIncome, basis.capitalGains);
        logger.log(LogCategory.TAX, 'Taxes.applyYear|yearlyLongTermCapitalGainsAndQualifiedDividendsTax: ' + yearlyLongTermCapitalGainsAndQualifiedDividendsTax.toString());
    }

    /**
     * The annual contribution ceiling for one kind of account.
     *
     * ONE helper, because there used to be two methods called from eight sites,
     * and the IRA limit had been doubled for married filers while the 401(k)
     * limit had not. Nobody chose that; it is what happens when the same policy
     * lives in several places. This is also the seam the per-person spec needs:
     * it already takes a user, so a second User slots in without touching a
     * single call site.
     *
     * The figure is a HOUSEHOLD ceiling — every caller compares it against a
     * household aggregate — so married values are the statutory per-person
     * amounts doubled.
     *
     * @param {'ira'|'401k'} kind  ContributionKind
     * @param {import('./user.js').User} activeUser
     */
    limitFor(kind, activeUser) {
        const catchUp = activeUser.age >= 50;
        switch (kind) {
            case ContributionKind.IRA:
                return new Currency(catchUp ? this.iraContributionLimit50AndOver
                                            : this.iraContributionLimitBelow50);
            case ContributionKind.FOUR01K:
                return new Currency(catchUp ? this.four01KContributionLimit50AndOver
                                            : this.four01KContributionLimitBelow50);
            default:
                throw new Error(`TaxTable.limitFor: unknown contribution kind ${JSON.stringify(kind)}`);
        }
    }
}