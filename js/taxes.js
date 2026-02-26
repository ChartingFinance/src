import { Currency } from './currency.js';
import { InstrumentType } from './instrument.js';
import { WithholdingResult } from './results.js';
import { logger, LogCategory } from './logger.js';
import { global_filingAs, global_inflationRate, global_propertyTaxDeductionMax, global_home_sale_capital_gains_discount } from './globals.js';

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
                    {"rate": 0.12, "fromAmount": 11926.0, "toAmount": 48475.0},
                    {"rate": 0.22, "fromAmount": 48476.0, "toAmount": 103350.0},
                    {"rate": 0.24, "fromAmount": 103351.0, "toAmount": 197300.0},
                    {"rate": 0.32, "fromAmount": 197301.0, "toAmount": 250525.0},
                    {"rate": 0.35, "fromAmount": 250556.0, "toAmount": 626350.0},
                    {"rate": 0.37, "fromAmount": 626251.0, "toAmount": -1.0 }
                ]
            },
            {
                "filingType": "married",
                "taxRows": [
                    {"rate": 0.10, "fromAmount": 0.0, "toAmount": 23850.0},
                    {"rate": 0.12, "fromAmount": 23851.0, "toAmount": 96950.0},
                    {"rate": 0.22, "fromAmount": 96951.0, "toAmount": 206700.0},
                    {"rate": 0.24, "fromAmount": 206701.0, "toAmount": 394600.0},
                    {"rate": 0.32, "fromAmount": 394601.0, "toAmount": 501050.0},
                    {"rate": 0.35, "fromAmount": 501051.0, "toAmount": 751600.0},
                    {"rate": 0.37, "fromAmount": 751601.0, "toAmount": -1.0}
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
                {"rate": 0.15, "fromAmount": 48351.0, "toAmount": 533400.0 },
                {"rate": 0.2, "fromAmount": 533401.0, "toAmount": -1.0 }
                ]
            },
            {
                "filingType": "married",
                "taxRows": [
                    {"rate": 0.0, "fromAmount": 0.0, "toAmount": 96700.0 },
                    {"rate": 0.15, "fromAmount": 96701.0, "toAmount": 600050.0 },
                    {"rate": 0.2, "fromAmount": 600051.0, "toAmount": -1.0 }                    
                ]
            }
        ]
    },
    "standardDeduction": {
        "url": "https://www.irs.gov/newsroom/irs-provides-tax-inflation-adjustments-for-tax-year-2024",
        "single": 15000.0,
        "married": 30000.0        
    }
}; 

export const uniformLifetimeTable = [
    { age: 70, divisor: 27.4 },
    { age: 71, divisor: 26.5 },
    { age: 72, divisor: 25.6 },
    { age: 73, divisor: 24.7 },
    { age: 74, divisor: 23.8 },
    { age: 75, divisor: 22.9 },
    { age: 76, divisor: 22.0 },
    { age: 77, divisor: 21.2 },
    { age: 78, divisor: 20.3 },
    { age: 79, divisor: 19.5 },
    { age: 80, divisor: 18.7 },
    { age: 81, divisor: 17.9 },
    { age: 82, divisor: 17.1 },
    { age: 83, divisor: 16.3 },
    { age: 84, divisor: 15.5 },
    { age: 85, divisor: 14.8 },
    { age: 86, divisor: 14.1 },
    { age: 87, divisor: 13.4 },
    { age: 88, divisor: 12.7 },
    { age: 89, divisor: 12.0 },
    { age: 90, divisor: 11.4 },
    { age: 91, divisor: 10.8 },
    { age: 92, divisor: 10.2 },
    { age: 93, divisor: 9.6 },
    { age: 94, divisor: 9.1 },
    { age: 95, divisor: 8.6 },
    { age: 96, divisor: 8.1 },
    { age: 97, divisor: 7.6 },
    { age: 98, divisor: 7.1 },
    { age: 99, divisor: 6.7 },
    { age: 100, divisor: 6.3 },
    { age: 101, divisor: 5.9 },
    { age: 102, divisor: 5.5 },
    { age: 103, divisor: 5.2 },
    { age: 104, divisor: 4.9 },
    { age: 105, divisor: 4.5 },
    { age: 106, divisor: 4.2 },
    { age: 107, divisor: 3.9 },
    { age: 108, divisor: 3.7 },
    { age: 109, divisor: 3.4 },
    { age: 110, divisor: 3.1 },
    { age: 111, divisor: 2.9 },
    { age: 112, divisor: 2.6 },
    { age: 113, divisor: 2.4 },
    { age: 114, divisor: 2.1 },
    { age: 115, divisor: 1.9 },
    { age: 116, divisor: 1.7 },
    { age: 117, divisor: 1.5 },
    { age: 118, divisor: 1.3 },
    { age: 119, divisor: 1.1 },
    { age: 120, divisor: 1.0 }
];

export class TaxTable {
    constructor() {
        this.taxes = null;     
        this.initializeChron();
        this.singleContributionLimitBelow50
    }

    initializeChron() {
        
        this.activeTaxTables = JSON.parse(JSON.stringify(us_2025_taxtables));
        if (global_filingAs == 'Single') {
            this.activeIncomeTable = this.activeTaxTables.income.tables[0];
            this.activeCapitalGainsTable = this.activeTaxTables.capitalGains.tables[0];
            this.activeStandardDeduction = this.activeTaxTables.standardDeduction.single;
            this.iraContributionLimitBelow50 = 7000;
            this.iraContributionLimit50AndOver = 8000;
            this.four01KContributionLimitBelow50 = 23500;
            this.four01KContributionLimit50AndOver = 31000;
        }
        else {
            this.activeIncomeTable = this.activeTaxTables.income.tables[1];
            this.activeCapitalGainsTable = this.activeTaxTables.capitalGains.tables[1];
            this.activeStandardDeduction = this.activeTaxTables.standardDeduction.married;
            this.iraContributionLimitBelow50 = 14000;
            this.iraContributionLimit50AndOver = 16000;
            this.four01KContributionLimitBelow50 = 23500;
            this.four01KContributionLimit50AndOver = 31000;        }

        this.yearlySocialSecurityAccumulator = new Currency();

    }

    monthlyChron() {

    }

    addYearlySocialSecurity(amount) {

        this.yearlySocialSecurityAccumulator.add(amount);
        
    }

    yearlyChron() {

        this.yearlySocialSecurityAccumulator.zero();

        // apply inflation to the tax rows
        this.inflateTaxes();

    }

    finalizeChron() {

    }

    inflateTaxRows(taxTables) {
        for (let taxTable of taxTables) {
            for (let taxRow of taxTable.taxRows) {
                taxRow.fromAmount *= (1.0 + global_inflationRate);
                if (taxRow.toAmount != -1.0)
                    taxRow.toAmount *= (1.0 + global_inflationRate);
            }
        }
    }

    inflateTaxes() {

        this.activeTaxTables.fica.maxSSEarnings *= (1.0 + global_inflationRate);
        this.inflateTaxRows(this.activeTaxTables.income.tables);
        this.inflateTaxRows(this.activeTaxTables.capitalGains.tables);

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
        result.socialSecurity.add(this.calculateSocialSecurityTax(isSelfEmployed, income));
        result.medicare.add(this.calculateMedicareTax(isSelfEmployed, income));

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

    calculateCapitalGainsTax(capitalGains, holdingMonths, isHome, annualizedIncome) {
        const isLongTerm = holdingMonths > 12;

        if (isLongTerm) {
            let taxableGains = capitalGains.copy();
            if (holdingMonths > 24 && isHome) {
                taxableGains.amount -= global_home_sale_capital_gains_discount;
                if (taxableGains.amount < 0) taxableGains.zero();
            }
            const tax = this.calculateYearlyLongTermCapitalGainsTax(annualizedIncome, taxableGains);
            return { isLongTerm: true, tax };
        } else {
            const tax = this.calculateYearlyIncomeTax(capitalGains);
            return { isLongTerm: false, tax };
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
            taxableIncome.subtract(yearly.iraContribution);


        if (taxableIncome.amount < 0) {
            logger.log(LogCategory.TAX, 'TaxTable.applyYearlyDeductions: taxable income < 0, setting to 0');
            taxableIncome.zero();
        }

        return taxableIncome;

    }

    reconcileYearlyTax(yearly) {

        let yearlyFICA = this.calculateYearlyFICATax(yearly);
        if (yearlyFICA.amount != yearly.fica.amount)
            logger.log(LogCategory.TAX, 'computed yearly FICA != portfolio yearly FICA')
        else
            logger.log(LogCategory.TAX, 'computed yearly FICA check PASSED');

        let yearlyTaxableIncome = this.calculateYearlyTaxableIncome(yearly);
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

        let taxableIncome = new Currency(yearly.selfIncome.amount + yearly.employedIncome.amount);
        taxableIncome.add(yearly.irsTaxableGrossIncome());
        return this.applyYearlyDeductions(yearly, taxableIncome);

    }

    /*
    calculateYearlyNonFICATaxableIncome(yearly) {

        let nonFICATaxableIncome = new Currency(yearly.selfIncome.amount + yearly.employedIncome.amount);
        nonFICATaxableIncome.add(yearly.iraDistribution);
        nonFICATaxableIncome.add(yearly.shortTermCapitalGains);   
        nonFICATaxableIncome.add(yearly.interest);
        return this.applyYearlyDeductions(yearly, nonFICATaxableIncome);

    }
    */

    applyYear(yearly) {
        this.reconcileYearlyTax(yearly);

        let yearlyFICATax = this.calculateYearlyFICATax(yearly);
        let yearlyTaxableIncome = this.calculateYearlyTaxableIncome(yearly);
        let yearlyIncomeTax = this.calculateYearlyIncomeTax(yearlyTaxableIncome);        
        
        let yearlyLongTermCapitalGainsAndQualifiedDividends = new Currency(yearly.longTermCapitalGains.amount + yearly.qualifiedDividends.amount);
        let yearlyLongTermCapitalGainsAndQualifiedDividendsTax = this.calculateYearlyLongTermCapitalGainsTax(yearlyTaxableIncome, yearlyLongTermCapitalGainsAndQualifiedDividends);
        logger.log(LogCategory.TAX, 'Taxes.applyYear|yearlyLongTermCapitalGainsAndQualifiedDividendsTax: ' + yearlyLongTermCapitalGainsAndQualifiedDividendsTax.toString());
    }

    iraContributionLimit(activeUser) {
        if (activeUser.age < 50)
            return new Currency(this.iraContributionLimitBelow50);
        else
            return new Currency(this.iraContributionLimit50AndOver);
    }

    four01KContributionLimit(activeUser) {
        if (activeUser.age < 50)
            return new Currency(this.four01KContributionLimitBelow50);
        else
            return new Currency(this.four01KContributionLimit50AndOver);
    }
}