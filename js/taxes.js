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
import { FilingStatus, FILING_STATUSES } from './filing-status.js';
import { taxableBasis } from './tax-basis.js';

/**
 * Bracket rows are half-open, `[fromAmount, toAmount)`: each row's `fromAmount`
 * equals the previous row's `toAmount`, so the bands tile with no gap and no
 * overlap. `calculateYearlyIncomeTax` depends on that.
 *
 * The IRS publishes bands as "$12,401 to $50,400". Do not copy the `+1` starts:
 * each would lose a dollar of base. When checking a boundary, check `toAmount`
 * against the IRS release; `fromAmount` is derived from it.
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
    },
    // IRC §63(f) — the additional standard deduction for a filer aged 65 or
    // older, PER PERSON: a married couple where both qualify gets it twice.
    // Indexed, like the standard deduction it adds to, and — also like it —
    // lost entirely by a household that itemises.
    "additionalStandardDeduction65": {
        "url": "https://www.irs.gov/newsroom/irs-releases-tax-inflation-adjustments-for-tax-year-2026-including-amendments-from-the-one-big-beautiful-bill",
        "single": 2050.0,
        "married": 1650.0
    },
    // The One Big Beautiful Bill Act's senior deduction: $6,000 per person
    // aged 65 or older, for tax years 2025 through 2028 only, each person's
    // $6,000 reduced by 6% of MAGI over the threshold. NOT indexed, and taken
    // whether the household itemises or not — it is not part of the standard
    // deduction. Fully phased out at $175,000 single, $250,000 joint.
    "seniorDeduction": {
        "url": "https://www.irs.gov/newsroom/one-big-beautiful-bill-provisions",
        "amount": 6000.0,
        "phaseOutRate": 0.06,
        "single": 75000.0,
        "married": 150000.0,
        "firstYear": 2025,
        "lastYear": 2028
    },
    // IRC §86 — how much of a Social Security benefit is taxable. The base
    // amount ($25,000 / $32,000) has been fixed since 1984 and the adjusted
    // base amount ($34,000 / $44,000) since 1993. Neither is indexed, so a
    // larger share of benefits becomes taxable every year — the same kind of
    // statutory stealth tax as the NIIT threshold below. See inflateTaxes().
    "socialSecurityBenefits": {
        "url": "https://www.irs.gov/publications/p915",
        "single":  { "base": 25000.0, "adjusted": 34000.0 },
        "married": { "base": 32000.0, "adjusted": 44000.0 }
    },
    // IRC §1411 net investment income tax. The RATE and the THRESHOLDS have
    // both been fixed since 2013 and neither is inflation-indexed — see the
    // note in inflateTaxes(). This is a deliberate stealth tax: the threshold
    // catches more households every year by standing still.
    "niit": {
        "url": "https://www.irs.gov/individuals/net-investment-income-tax",
        "rate": 0.038,
        "single": 200000.0,
        "married": 250000.0
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
    },
    // IRC §63(f) and the OBBBA senior deduction — see the 2026 table.
    "additionalStandardDeduction65": {
        "url": "https://www.irs.gov/newsroom/irs-releases-tax-inflation-adjustments-for-tax-year-2025",
        "single": 2000.0,
        "married": 1600.0
    },
    "seniorDeduction": {
        "url": "https://www.irs.gov/newsroom/one-big-beautiful-bill-provisions",
        "amount": 6000.0,
        "phaseOutRate": 0.06,
        "single": 75000.0,
        "married": 150000.0,
        "firstYear": 2025,
        "lastYear": 2028
    },
    // IRC §86 — same figures as 2026: never indexed.
    "socialSecurityBenefits": {
        "url": "https://www.irs.gov/publications/p915",
        "single":  { "base": 25000.0, "adjusted": 34000.0 },
        "married": { "base": 32000.0, "adjusted": 44000.0 }
    },
    // IRC §1411 — same figures as 2026, and for the same reason: never indexed.
    "niit": {
        "url": "https://www.irs.gov/individuals/net-investment-income-tax",
        "rate": 0.038,
        "single": 200000.0,
        "married": 250000.0
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
 * Household figures, not per person: every limit is enforced against a
 * household total (payroll compares against this.yearly.four01KContribution,
 * summed over all income). So a married limit is the per-person statutory
 * figure doubled — for the IRA and the 401(k) alike.
 */
/**
 * Whose Social Security wage base is being consumed.
 *
 * One key today, because the household has a single User. The wage base is per
 * person, so a married couple currently shares one $184,500 base where each
 * spouse should have their own (visible in the mfj-two-earners fixture). Adding
 * SPOUSE and a second User fixes it; every call site already passes an owner.
 */
export const TaxOwner = Object.freeze({
    PRIMARY: 'primary',
});

export const ContributionKind = Object.freeze({
    IRA: 'ira',
    FOUR01K: '401k',
});

const CONTRIBUTION_LIMITS = Object.freeze({
    single:  { iraBelow50:  7500, ira50AndOver:  8600, four01KBelow50: 24500, four01K50AndOver: 32500 },
    married: { iraBelow50: 15000, ira50AndOver: 17200, four01KBelow50: 49000, four01K50AndOver: 65000 },
});

/** Age from which the §63(f) and OBBBA senior deductions apply. */
const SENIOR_AGE = 65;

/** No age-based deductions — the default for every caller that has no user. */
const NO_AGE_DEDUCTIONS = Object.freeze({ additionalStandard: 0, senior: 0 });

export class TaxTable {
    /**
     * @param {string} filingAs  selects the brackets, limits and exclusion
     * @param {number} propertyTaxDeductionMax  the SALT-style cap
     *
     * Both required: this file reads nothing from the settings store.
     */
    constructor(filingAs, propertyTaxDeductionMax) {
        if (!filingAs || typeof propertyTaxDeductionMax !== 'number') {
            throw new Error(
                'TaxTable requires (filingAs, propertyTaxDeductionMax). Build one '
                + 'with makeActiveTaxTable() from globals, or from a SimConfig. '
                + 'The globals fallback was removed in Spec 9 step 6.');
        }
        this.filingAs = filingAs;
        // A cap on a deduction is a parameter of the tax regime, like the
        // brackets beside it — so it lives on the table rather than being
        // threaded through every method that applies it.
        this.configuredPropertyTaxDeductionMax = propertyTaxDeductionMax;
        this.taxes = null;     
        this.initializeChron();
        this.singleContributionLimitBelow50
    }

    initializeChron() {
        
        this.activeTaxTables = JSON.parse(JSON.stringify(us_2026_taxtables));

        // The base year the run is indexed forward from, read off the table set
        // itself (globals.html displays it). Swapping the table set above is the
        // only edit a new tax year needs.
        this.baseYear = this.activeTaxTables.year;
        this.propertyTaxDeductionMax = this.configuredPropertyTaxDeductionMax;

        // Selected by key, so an unrecognised filing status fails rather than
        // silently filing jointly.
        const filingAs = this.filingAs;
        const key = FILING_TYPE_KEY[filingAs];
        if (!key) {
            throw new Error(`TaxTable: filing status ${JSON.stringify(filingAs)} `
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
        this.activeNIITThreshold = this.activeTaxTables.niit[key];
        this.activeSocialSecurityThresholds = this.activeTaxTables.socialSecurityBenefits[key];
        this.activeAdditionalStandardDeduction65 = this.activeTaxTables.additionalStandardDeduction65[key];
        const senior = this.activeTaxTables.seniorDeduction;
        this.activeSeniorDeduction = { ...senior, threshold: senior[key] };
        // The age-based deductions are per person. The household has one age
        // (see User), so a married household counts as two people of that age —
        // both qualify at 65 together. limitFor() doubles its limits the same
        // way.
        this.householdPersons = key === 'married' ? 2 : 1;
        this.niitRate = this.activeTaxTables.niit.rate;

        const limits = CONTRIBUTION_LIMITS[key];
        this.iraContributionLimitBelow50 = limits.iraBelow50;
        this.iraContributionLimit50AndOver = limits.ira50AndOver;
        this.four01KContributionLimitBelow50 = limits.four01KBelow50;
        this.four01KContributionLimit50AndOver = limits.four01K50AndOver;

        // Keyed by TaxOwner, with exactly one key. See TaxOwner.
        this.yearlySocialSecurityByOwner = new Map([[TaxOwner.PRIMARY, new Currency()]]);

    }

    monthlyChron() {

    }

    /** The running total of SS tax withheld from one earner this year. */
    #socialSecurityAccumulator(owner) {
        let acc = this.yearlySocialSecurityByOwner.get(owner);
        if (!acc) {
            acc = new Currency();
            this.yearlySocialSecurityByOwner.set(owner, acc);
        }
        return acc;
    }

    addYearlySocialSecurity(amount, owner = TaxOwner.PRIMARY) {

        this.#socialSecurityAccumulator(owner).add(amount);

    }

    yearlyChron(inflationOverride) {

        // Every earner's base resets on the same January.
        for (const acc of this.yearlySocialSecurityByOwner.values()) acc.zero();

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

        // Required: every caller passes the run's inflation rate.
        if (typeof inflationOverride !== 'number' || !Number.isFinite(inflationOverride)) {
            throw new Error('TaxTable.inflateTaxes needs the run inflation rate; got '
                + JSON.stringify(inflationOverride));
        }
        const r = 1.0 + inflationOverride;
        this.activeTaxTables.fica.maxSSEarnings *= r;
        this.inflateTaxRows(this.activeTaxTables.income.tables, r);
        this.inflateTaxRows(this.activeTaxTables.capitalGains.tables, r);
        this.activeStandardDeduction *= r;
        this.activeAdditionalStandardDeduction65 *= r;
        // Not indexed here, because the statutes do not index them:
        //   activeSeniorDeduction           OBBBA: fixed dollars, 2025–2028 only.
        //   activeNIITThreshold             IRC §1411: fixed since 2013, so it
        //                                   catches more households each year.
        //   activeSocialSecurityThresholds  IRC §86: fixed since 1984/1993, so
        //                                   more of each benefit is taxable.
        //   activeHomeSaleExclusion         IRC §121: fixed since 1997.
        // Inflating any of them would model a tax that quietly fades away.
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

    calculateMonthlyWithholding(isSelfEmployed, income, owner = TaxOwner.PRIMARY) {

        let result = this.calculateFICATax(isSelfEmployed, income, owner);
        result.income.add(this.calculateMonthlyIncomeTax(income, new Currency()));                        
        return result;

    }

    calculateFICATax(isSelfEmployed, income, owner = TaxOwner.PRIMARY) {

        let result = new WithholdingResult(new Currency(), new Currency(), new Currency());
        result.socialSecurityTax.add(this.calculateSocialSecurityTax(isSelfEmployed, income, owner));
        result.medicareTax.add(this.calculateMedicareTax(isSelfEmployed, income));

        if (isSelfEmployed && result.fica().amount / income.amount > 0.16) {
            logger.log(LogCategory.TAX, 'TaxTable.calculateFICATax: ratio over 16%?');
        }
        else if (result.fica().amount / income.amount > 0.08) {
            logger.log(LogCategory.TAX, 'TaxTable.calculateFICATax: ratio over 8%?');
        }

        return result;

    }

    calculateSocialSecurityTax(isSelfEmployed, income, owner = TaxOwner.PRIMARY) {

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
            
        const accumulated = this.#socialSecurityAccumulator(owner);
        if (accumulated.amount + c.amount > maxC.amount) {
            logger.log(LogCategory.TAX, 'at maximum social security tax');
            c.amount = maxC.amount - accumulated.amount;
        }

        return c;

    }

    calculateMedicareTax(isSelfEmployed, income) {        

        let c = new Currency();
        if (isSelfEmployed)
            c = new Currency(income.amount * this.activeTaxTables.fica.medicareFullRate);
        else
            c = new Currency(income.amount * this.activeTaxTables.fica.medicareHalfRate);

        return c;

    }

    calculateYearlyIncomeTax(income, deduction) {

        // `deduction` is a Currency; Currency.subtract throws on a number.
        let adjusted = new Currency(income.amount);
        if (deduction)
            adjusted.subtract(deduction);

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
            // How much §121 actually removed — a gain smaller than the
            // exclusion uses only part of it. The caller passes this to the
            // annual true-up, which would otherwise tax the gross gain.
            //
            // This is withholding, not liability, so the §63 deduction overflow
            // is not applied here (see the call site in tax-engine.js).
            const excluded = capitalGains.amount - taxableGains.amount;

            const tax = this.calculateYearlyLongTermCapitalGainsTax(annualizedIncome, taxableGains);
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

    /**
     * IRC §1411 net investment income tax.
     *
     *     0.038 × min( netInvestmentIncome , MAGI − threshold )
     *
     * Both arguments matter. A household with large wages and no investment
     * income owes nothing (fixture mfj-two-earners); so does one living on
     * gains below the threshold (gain-harvest-under-the-deduction).
     *
     * Floored at zero here, because `magi` is deliberately unfloored.
     *
     * @param {Currency} netInvestmentIncome  from taxableBasis
     * @param {Currency} magi                 from taxableBasis — AGI, gross of the deduction
     */
    calculateNIIT(netInvestmentIncome, magi) {

        const overThreshold = magi.amount - this.activeNIITThreshold;
        const base = Math.min(netInvestmentIncome.amount, overThreshold);
        if (base <= 0) return new Currency(0);
        return new Currency(base * this.niitRate);

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

            // The RMD divides the prior December 31 balance, found in the VALUE
            // history. GA fitness runs disable history, so fall back to the live
            // balance — an approximation, but it keeps RMDs in those runs.
            if (!Number.isFinite(value)) {
                value = modelAsset.finishCurrency.amount;
            }

            let rmd = value / divisor;

            rmd /= 12.0;
            return new Currency(rmd);
        }
        return new Currency(0);
    }

    /**
     * Every dollar this package may deduct, as a positive Currency: the greater
     * of the standard or itemised deduction, plus the deductible pre-tax
     * contribution. taxableBasis() needs the total, because a deduction larger
     * than ordinary income shelters capital gains (IRC §1(h)).
     *
     * Property tax is accepted with either sign: the engine stores it negative,
     * a package built by hand in a test may not.
     */
    totalYearlyDeduction(yearly, age = NO_AGE_DEDUCTIONS) {

        const { base, preTax, senior } = this.deductionComponents(yearly, age);
        return base.copy().add(preTax).add(senior);

    }

    /**
     * The deductions that depend on being 65 or older, for one tax year.
     *
     * Two of them, and they behave differently on purpose:
     *
     *   additionalStandard  IRC §63(f). Raises the STANDARD deduction, so it
     *                       competes with itemising and is lost to a household
     *                       that itemises. Indexed.
     *   senior              The OBBBA senior deduction, 2025-2028. Stands on its
     *                       own — taken whether the household itemises or not —
     *                       and phases out on MAGI. Not indexed.
     *
     * "65 or older" is `activeUser.age >= 65`, the same reading of age the
     * engine already uses for the 50+ catch-up and for RMDs: the age reached in
     * this tax year. The tax year itself is `birthYear + age`, because the
     * plan's birthYear is its first year minus the start age (Portfolio) and
     * the age advances on each New Year's Day, after that year's settlement.
     *
     * @param {import('./user.js').User} activeUser
     * @param {Currency} magi  AGI — the senior deduction phases out on it
     * @returns {{additionalStandard: number, senior: number}}
     */
    ageDeductions(activeUser, magi) {
        if (!activeUser || !(activeUser.age >= SENIOR_AGE)) return NO_AGE_DEDUCTIONS;
        const persons = this.householdPersons;
        const additionalStandard = this.activeAdditionalStandardDeduction65 * persons;

        const s = this.activeSeniorDeduction;
        const taxYear = activeUser.birthYear + activeUser.age;
        let senior = 0;
        if (taxYear >= s.firstYear && taxYear <= s.lastYear) {
            // Each person's $6,000 loses 6% of the excess, so a couple's pair is
            // gone at the same MAGI a single filer's one is: $100,000 over.
            const excess = Math.max(0, magi.amount - s.threshold);
            senior = persons * Math.max(0, s.amount - s.phaseOutRate * excess);
        }
        return { additionalStandard, senior };
    }

    /**
     * The deduction as the two pieces `applyYearlyDeductions` subtracts
     * separately. Keep them separate: Currency is raw floating point, and
     * `x − base − preTax` differs from `x − (base + preTax)` in the last bit,
     * which changes the snapshot for no tax reason.
     */
    deductionComponents(yearly, age = NO_AGE_DEDUCTIONS) {

        let propertyTaxDeduction = new Currency(yearly.propertyTaxes.amount);

        if (propertyTaxDeduction.amount < 0)
            propertyTaxDeduction.flipSign();

        // maximum property tax deduction
        if (propertyTaxDeduction.amount > this.propertyTaxDeductionMax)
            propertyTaxDeduction.amount = this.propertyTaxDeductionMax;

        if (propertyTaxDeduction.amount > 0)
            propertyTaxDeduction.flipSign();

        let itemised = new Currency(yearly.mortgageInterest.amount + propertyTaxDeduction.amount);
        itemised.flipSign();

        // `+ 0` for anyone under 65.
        const standard = this.activeStandardDeduction + age.additionalStandard;
        const base = itemised.amount > standard
            ? itemised
            : new Currency(standard);

        const preTax = new Currency(yearly.four01KContribution.amount > 0
            ? yearly.four01KContribution.amount
            : yearly.tradIRAContribution.amount);

        return { base, preTax, senior: new Currency(age.senior) };

    }

    applyYearlyDeductions(yearly, taxableIncome, age = NO_AGE_DEDUCTIONS) {

        const { base, preTax, senior } = this.deductionComponents(yearly, age);
        taxableIncome.subtract(base);
        taxableIncome.subtract(preTax);
        taxableIncome.subtract(senior);

        if (taxableIncome.amount < 0) {
            logger.log(LogCategory.TAX, 'TaxTable.applyYearlyDeductions: taxable income < 0, setting to 0');
            taxableIncome.zero();
        }

        return taxableIncome;

    }

    /**
     * Vestigial. Logs three self-checks and returns an empty Currency that
     * nothing reads. The middle check compares post-deduction taxable income
     * with gross wages, so it reports a failure on every run. Listed for
     * deletion in markdowns/code-issues-from-comments.md.
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

    calculateYearlyTaxableIncome(yearly, age = NO_AGE_DEDUCTIONS) {
        
        let taxableIncome = yearly.irsTaxableGrossIncome(this);
        return this.applyYearlyDeductions(yearly, taxableIncome, age);

    }

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
     * One helper for every contribution limit, so the policy lives in one
     * place. It takes a user, so a second (per-person) User can be added later
     * without changing call sites.
     *
     * The figure is a household ceiling — every caller compares it with a
     * household total — so married values are the per-person amounts doubled.
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