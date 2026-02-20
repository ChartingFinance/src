import { Currency } from './currency.js';
import { InstrumentType } from './instrument.js';
import { Metric } from './model-asset.js';
import { FundTransferResult, AssetAppreciationResult, CapitalGainsResult, MortgageResult, IncomeResult, ExpenseResult, InterestResult, WithholdingResult } from './results.js';
import { MonthsSpan } from './months-span.js';
import { logger } from './logger.js';
import { User } from './user.js';
import { firstDateInt, lastDateInt } from './asset-queries.js';
import { activeTaxTable } from './globals.js';
import { global_propertyTaxRate, global_propertyTaxDeductionMax, global_user_startAge, global_home_sale_capital_gains_discount } from './globals.js';

export const FINANCIAL_FIELDS = [
    'employedIncome', 'selfIncome', 'socialSecurity', 'assetAppreciation',
    'expense', 'fica', 'incomeTax', 'estimatedTaxes',
    'iraContribution', 'four01KContribution', 'rothContribution',
    'iraDistribution', 'four01KDistribution', 'rothDistribution',
    'mortgageInterest', 'mortgagePrincipal', 'mortgageEscrow', 'propertyTaxes',
    'shortTermCapitalGains', 'longTermCapitalGains',
    'nonQualifiedDividends', 'qualifiedDividends',
    'interestIncome', 'longTermCapitalGainsTax',
];

export class FinancialPackage {
    constructor() {
        for (const f of FINANCIAL_FIELDS) this[f] = new Currency();
    }

    add(financialPackage) {
        for (const f of FINANCIAL_FIELDS) this[f].add(financialPackage[f]);
        return this;
    }

    subtract(financialPackage) {
        for (const f of FINANCIAL_FIELDS) this[f].subtract(financialPackage[f]);
        return this;
    }

    multiply(amount) {
        for (const f of FINANCIAL_FIELDS) this[f].multiply(amount);
        return this;
    }

    limitDeductions(activeUser) {

        let maxIRADeduction = activeTaxTable.iraContributionLimit(activeUser);
        if (this.iraContribution.amount > maxIRADeduction.amount)
            this.iraContribution.amount = maxIRADeduction.amount;
        
        let max401KDeduction = activeTaxTable.four01KContributionLimit(activeUser);
        if (this.four01KContribution.amount > max401KDeduction.amount)
            this.four01KContribution.amount = max401KDeduction.amount;

        if (this.propertyTaxes.amount > global_propertyTaxDeductionMax)
            this.propertyTaxes.amount = global_propertyTaxDeductionMax;

    }

    totalIncome() {

        let income = this.wageIncome().copy();
        income.add(this.ordinaryIncome());
        income.add(this.nontaxableIncome());
        return income;

    }

    wageIncome() {

        let income = this.employedIncome.copy();
        income.add(this.selfIncome);
        return income;
    }

    ordinaryIncome() {

        let income = this.socialSecurity.copy().multiply(0.85); // maximum allowed for social security
        income.add(this.interestIncome);
        income.add(this.shortTermCapitalGains);
        income.add(this.iraDistribution);
        income.add(this.four01KDistribution);
        income.add(this.nonQualifiedDividends);
        return income;

    }

    nontaxableIncome() {

        let income = this.rothDistribution.copy();
        income.add(this.qualifiedDividends);
        return income;

    }

    deductiblePropertyTaxes() {

        let ptDeduction = this.propertyTaxes.copy().flipSign();
        if (ptDeduction.amount > global_propertyTaxDeductionMax)
            ptDeduction.amount = global_propertyTaxDeductionMax;
        return ptDeduction.flipSign();
    
    }

    nonDeductiblePropertyTaxes() {

        return this.propertyTaxes.copy().subtract(this.deductiblePropertyTaxes());

    }

    deductions() {

        let d = this.iraContribution.copy().flipSign();
        d.subtract(this.four01KContribution);
        d.add(this.mortgageInterest);
        d.add(this.deductiblePropertyTaxes());
        return d;

    }

    totalTaxes() {

        let taxes = this.incomeTax.copy();
        taxes.add(this.fica);
        taxes.add(this.longTermCapitalGainsTax);
        taxes.add(this.propertyTaxes);
        taxes.add(this.estimatedTaxes);
        return taxes;

    }

    earning() {

        let income = this.totalIncome();
        let taxes = this.totalTaxes();
        return income.add(taxes);
    }

    effectiveTaxRate() {

        let income = this.totalIncome();
        let taxes = this.totalTaxes().flipSign();
        let ratio = taxes.amount / income.amount;
        return ratio;        

    }

    copy() {

        let aCopy = new FinancialPackage();
        aCopy.add(this);
        return aCopy;

    }

    zero() {
        for (const f of FINANCIAL_FIELDS) this[f].zero();
        return this;
    }

    toIncomeArray() {
        var result = [];
        result.push(this.employedIncome.toCurrency());
        result.push(this.selfIncome.toCurrency());
        result.push(this.socialSecurity.toCurrency());
        result.push(this.iraDistribution.toCurrency());
        result.push(this.four01KDistribution.toCurrency());
        result.push(this.shortTermCapitalGains.toCurrency());
        result.push(this.interestIncome.toCurrency());
        result.push(this.nonQualifiedDividends.toCurrency());
        result.push(this.longTermCapitalGains.toCurrency());
        result.push(this.qualifiedDividends.toCurrency());
        result.push(this.rothDistribution.toCurrency());
        return result;
    }

    toDeductionArray() {

    }

    toTaxArray() {

    }

    toArray() {

        var result = [];
        result.push(this.totalIncome());
        result.push(this.deductions());
        result.push(this.taxes());
        return result;

    }

    report() {

        logger.log('income:                      ' + this.totalIncome().toString());
        logger.log('  employedIncome:            ' + this.employedIncome.toString());
        logger.log('  selfIncome:                ' + this.selfIncome.toString());
        logger.log('  ordinaryIncome:            ' + this.ordinaryIncome().toString());
        logger.log('    socialSecurity (taxed):  ' + this.socialSecurity.toString());
        logger.log('    iraDistribution:         ' + this.iraDistribution.toString());
        logger.log('    401KDistribution:        ' + this.four01KDistribution.toString());                       
        logger.log('    shortTermCapitalGains:   ' + this.shortTermCapitalGains.toString());
        logger.log('    interestIncome:          ' + this.interestIncome.toString());
        logger.log('    nonQualifiedDividends:   ' + this.nonQualifiedDividends.toString());        
        logger.log('  longTermCapitalGains:      ' + this.longTermCapitalGains.toString());        
        logger.log('  nonTaxableIncome:          ' + this.nontaxableIncome().toString());
        logger.log('    qualifiedDividends       ' + this.qualifiedDividends.toString());
        logger.log('    rothDistribution:        ' + this.rothDistribution.toString());
        logger.log('deductions:                  ' + this.deductions().toString());
        logger.log('  iraContribution:           ' + this.iraContribution.toString());
        logger.log('  401KContribution:          ' + this.four01KContribution.toString());
        logger.log('  mortgageInterest:          ' + this.mortgageInterest.toString());
        logger.log('  propertyTaxes:             ' + this.deductiblePropertyTaxes().toString());
        logger.log('taxes:                       ' + this.totalTaxes().toString());
        logger.log('  fica:                      ' + this.fica.toString());
        logger.log('  incomeTax:                 ' + this.incomeTax.toString());
        logger.log('  longTermCapitalGainsTax:   ' + this.longTermCapitalGainsTax.toString());
        logger.log('  propertyTaxes:             ' + this.propertyTaxes.toString());
        logger.log('  estimatedTaxes:            ' + this.estimatedTaxes.toString());
        logger.log('rothContribution:            ' + this.rothContribution.toString());
        logger.log('assetAppreciation:           ' + this.assetAppreciation.toString());
        logger.log('mortgagePrincipal:           ' + this.mortgagePrincipal.toString());        
        logger.log('earning:                     ' + this.earning().toString());
        logger.log('effectTaxRate:               ' + this.effectiveTaxRate().toFixed(2));
        logger.log('expenses:                    ' + this.expense.toString());      
    }

    reportHTML(currentDateInt) {

        let html = '<div>';
        html += ('<h3>' + currentDateInt.toString() + '</h3>');
        html += "<ul>";
        html += '<li>income:                      ' + this.totalIncome().toString() + '<ul>';
        html += '  <li>employedIncome:            ' + this.employedIncome.toString() + '</li>';
        html += '  <li>selfIncome:                ' + this.selfIncome.toString() + '</li>';
        html += '  <li>ordinaryIncome:            ' + this.ordinaryIncome().toString() + '<ul>';
        html += '    <li>socialSecurity:          ' + this.socialSecurity.toString() + '</li>';
        html += '    <li>iraDistribution:         ' + this.iraDistribution.toString() + '</li>';
        html += '    <li>401KDistribution:        ' + this.four01KDistribution.toString() + '</li>';                       
        html += '    <li>shortTermCapitalGains:   ' + this.shortTermCapitalGains.toString() + '</li>';
        html += '    <li>interestIncome:          ' + this.interestIncome.toString() + '</li>';
        html += '    <li>nonQualifiedDividends:   ' + this.nonQualifiedDividends.toString() + '</li></ul>';        
        html += '  <li>longTermCapitalGains:      ' + this.longTermCapitalGains.toString() + '</li>';        
        html += '  <li>nonTaxableIncome:          ' + this.nontaxableIncome().toString() + '<ul>';
        html += '    <li>qualifiedDividends       ' + this.qualifiedDividends.toString() + '</li>';
        html += '    <li>rothDistribution:        ' + this.rothDistribution.toString() + '</li></ul></ul>';
        html += '<li>deductions:                  ' + this.deductions().toString() + '<ul>';
        html += '  <li>iraContribution:           ' + this.iraContribution.toString() + '</li>';
        html += '  <li>401KContribution:          ' + this.four01KContribution.toString() + '</li>';
        html += '  <li>mortgageInterest:          ' + this.mortgageInterest.toString() + '</li>';
        html += '  <li>propertyTaxes:             ' + this.deductiblePropertyTaxes().toString() + '</li></ul>';
        html += '<li>taxes:                       ' + this.totalTaxes().toString() + '<ul>';
        html += '  <li>fica:                      ' + this.fica.toString() + '</li>';
        html += '  <li>incomeTax:                 ' + this.incomeTax.toString() + '</li>';
        html += '  <li>longTermCapitalGainsTax:   ' + this.longTermCapitalGainsTax.toString() + '</li>';
        html += '  <li>propertyTaxes:             ' + this.propertyTaxes.toString() + '</li>';
        html += '  <li>estimatedTaxes:            ' + this.estimatedTaxes.toString() + '</li></ul>';
        html += '<li>rothContribution:            ' + this.rothContribution.toString() + '</li>';
        html += '<li>assetAppreciation:           ' + this.assetAppreciation.toString() + '</li>';
        html += '<li>mortgagePrincipal:           ' + this.mortgagePrincipal.toString() + '</li>';        
        html += '<li>earning:                     ' + this.earning().toString() + '</li>';
        html += '<li>effectiveTaxRate:            ' + this.effectiveTaxRate().toFixed(2) + '</li>';
        html += '<li>expenses:                    ' + this.expense.toString() + '</li>'; 
        html += '</ul>';
        html += '</div>';

        return html;

    }

    reportHTMLTableStart() {
        
        let html = '<table border="1" cellpadding="8" cellspacing="0">';
        html += '<thead><tr><th colspan="2">Financial Summary</th></tr></thead>';
        html += '<tbody>';

        return html;

    }

    reportHTMLTableIncome() {

        let html = '<span>' + this.employedIncome.toString() + '</span>';

        /*
        '<td>&nbsp;&nbsp;Employed</td><td>&nbsp;&nbsp;' + this.employedIncome.toString() + '<br />';
        html += '<tr><td style="padding-left:20px">Self</td><td>' + this.selfIncome.toString() + '<br />';
        html += '<tr><td style="padding-left:20px">Ordinary</td><td>' + this.ordinaryIncome().toString() + '<br />';
        html += '<tr><td style="padding-left:40px">Social Security</td><td>' + this.socialSecurity.toString() + '<br />';
        html += '<tr><td style="padding-left:40px">IRA Distribution</td><td>' + this.iraDistribution.toString() + '<br />';
        html += '<tr><td style="padding-left:40px">401K Distribution</td><td>' + this.four01KDistribution.toString() + '<br />';
        html += '<tr><td style="padding-left:40px">Short Term Capital Gains</td><td>' + this.shortTermCapitalGains.toString() + '<br />';
        html += '<tr><td style="padding-left:40px">Interest</td><td>' + this.interestIncome.toString() + '<br />';
        html += '<tr><td style="padding-left:40px">Non-Qualified Dividends</td><td>' + this.nonQualifiedDividends.toString() + '<br />';
        html += '<tr><td style="padding-left:20px">Long Term Capital Gains</td><td>' + this.longTermCapitalGains.toString() + '<br />';
        html += '<tr><td style="padding-left:20px">Non-Taxable</td><td>' + this.nontaxableIncome().toString() + '<br />';
        html += '<tr><td style="padding-left:40px">Qualified Dividends</td><td>' + this.qualifiedDividends.toString() + '<br />';
        html += '<tr><td style="padding-left:40px">Roth Distribution</td><td>' + this.rothDistribution.toString();
        html += '</td>';
        */
     
        return html;

    }

    reportHTMLTableDeductions() {

        let html = '<span>' + this.deductions().toString() + '</span>';

        /*
        let html = '<tr><td colspan="2"><strong>Deductions</strong><br />';
        html += '<tr><td>Total Deductions</td><td>' + this.deductions().toString() + '<br />';
        html += '<tr><td style="padding-left:20px">IRA Contribution</td><td>' + this.iraContribution.toString() + '<br />';
        html += '<tr><td style="padding-left:20px">401K Contribution</td><td>' + this.four01KContribution.toString() + '<br />';
        html += '<tr><td style="padding-left:20px">Mortgage Interest</td><td>' + this.mortgageInterest.toString() + '<br />';
        html += '<tr><td style="padding-left:20px">Property Taxes</td><td>' + this.deductiblePropertyTaxes().toString();
        html += '</td>';
        */

        return html;

    }

    reportHTMLTableTaxes() {

        let html = '<span>' + this.totalTaxes().toString() + '</span>';

        /*
        let html = '<tr><td colspan="2"><strong>Taxes</strong><br />';
        html += '<tr><td>Total Taxes</td><td>' + this.totalTaxes().toString() + '<br />';
        html += '<tr><td style="padding-left:20px">FICA</td><td>' + this.fica.toString() + '<br />';
        html += '<tr><td style="padding-left:20px">Income Tax</td><td>' + this.incomeTax.toString() + '<br />';
        html += '<tr><td style="padding-left:20px">Long Term Capital Gains Tax</td><td>' + this.longTermCapitalGainsTax.toString() + '<br />';
        html += '<tr><td style="padding-left:20px">Property Taxes</td><td>' + this.propertyTaxes.toString() + '<br />';
        html += '<tr><td style="padding-left:20px">Estimated Taxes</td><td>' + this.estimatedTaxes.toString();
        html += '</td>';
        */

        return html;

    }

    reportHTMLTable(currentDateInt) {

        let html = this.reportHTMLTableStart();
        
        html += '<tr><td>Year</td><td colspan="2">Income</td><td colspan="2"><strong>Deductions</td><td colspan="2">Taxes</td></tr>';

        html += '<tr><td><strong>' + currentDateInt.toString() + '</strong></td><td><strong>Total</strong></td><td><strong>' + this.totalIncome().toString() + '</strong></td><td><strong>Total</strong></td><td><strong>' + this.deductions().toString() + '</strong></td><td><strong>Total</strong></td><td><strong>' + this.totalTaxes().toString() + '</strong></td></tr>';
        html += '<tr>';
        html += '<td>' + this.reportHTMLTableIncome() + '</td>';
        html += '<td>' + this.reportHTMLTableDeductions() + '</td>';
        html += '<td>' + this.reportHTMLTableTaxes() + '</td>';
        html += '</tr>';       
        
        /*        
        html += '<tr><td colspan="2"><strong>Other</strong></td></tr>';
        html += '<tr><td>Roth Contribution</td><td>' + this.rothContribution.toString() + '</td></tr>';
        html += '<tr><td>Asset Appreciation</td><td>' + this.assetAppreciation.toString() + '</td></tr>';
        html += '<tr><td>Mortgage Principal</td><td>' + this.mortgagePrincipal.toString() + '</td></tr>';
        html += '<tr><td>Earning</td><td>' + this.earning().toString() + '</td></tr>';
        html += '<tr><td>Effective Tax Rate</td><td>' + this.effectiveTaxRate().toFixed(2) + '%</td></tr>';
        html += '<tr><td>Expenses</td><td>' + this.expense.toString() + '</td></tr>';
        */

        return html;

    }

    reportHTMLTableFinish() {

        let html = '</tbody>';
        html += '</table>';

        return html;

    }

    addResult(result) {
        if (result instanceof AssetAppreciationResult)
            this.addAssetAppreciationResult(result);
        else if (result instanceof CapitalGainsResult)
            this.addCapitalGainsResult(result);
        else if (result instanceof MortgageResult)
            this.addMortgageResult(result);
        else if (result instanceof IncomeResult)
            this.addIncomeResult(result);
        else if (result instanceof ExpenseResult)
            this.addExpenseResult(result);
        else if (result instanceof InterestResult)
            this.addInterestResult(result);
        else if (result instanceof WithholdingResult)
            this.addWithholdingResult(result);
    }

    addAssetAppreciationResult(assetAppreciationResult) {
        this.assetAppreciation.add(assetAppreciationResult.growth);
    }

    addCapitalGainsResult(capitalGainsResult) {
        this.shortTermCapitalGains.add(capitalGainsResult.shortTerm);
        this.longTermCapitalGains.add(capitalGainsResult.longTerm);
    }

    addMortgageResult(mortgageResult) {
        this.mortgageInterest.add(mortgageResult.interest);
        this.mortgagePrincipal.add(mortgageResult.principal);
        this.mortgageEscrow.add(mortgageResult.escrow);
    }

    addIncomeResult(incomeResult) {
        this.selfIncome.add(incomeResult.selfIncome);
        this.employedIncome.add(incomeResult.employedIncome);
    }

    addExpenseResult(expenseResult) {
        this.expense.add(expenseResult.expense);
    }

    addInterestResult(interestResult) {
        this.interestIncome.add(interestResult.income);
    }

    addWithholdingResult(withholdingResult) { 
        this.fica.add(withholdingResult.fica());
        this.incomeTax.add(withholdingResult.income);        
    }
}

export class Portfolio {
    constructor(modelAssets, reports) {
        this.modelAssets = this.sortModelAssets(modelAssets);
        if (reports)
            this.reports = reports;
        else
            this.reports = false;
        this.activeUser = new User(global_user_startAge);

        this.firstDateInt = firstDateInt(this.modelAssets);
        this.lastDateInt = lastDateInt(this.modelAssets);

        this.monthly = new FinancialPackage();
        this.yearly = new FinancialPackage();
        this.total = new FinancialPackage();

        this.monthlyIncomeTaxes = [];
        this.monthlyCapitalGainsTaxes = [];

        this.displayCapitalGainsTaxes = [];
    }

    sortModelAssets(modelAssets) {
        logger.log('Portfolio.sortModelAssets');
    
        modelAssets.sort(function (a, b) {
            if (a.sortIndex() < b.sortIndex())
                return -1;
            else if (b.sortIndex() < a.sortIndex())
                return 1;
            else
                return a.displayName.localeCompare(b.displayName);
        });
    
        return modelAssets;
    }

    copy() {

        let modelAssets = this.modelAssets.map(modelAsset => modelAsset.copy());
        let portfolio = new Portfolio(modelAssets);

        portfolio.monthly = this.monthly.copy();
        portfolio.yearly = this.yearly.copy();
        portfolio.total = this.total.copy();
        return portfolio;

    }

    zeroFundTransfersMoveValues() {

        for (let modelAsset of this.modelAssets) {
            modelAsset.zeroFundTransfersMoveValues();
        }

    }

    dnaFundTransfers() {

        let result = '';
        for (let modelAsset of this.modelAssets) {
            result += modelAsset.dnaFundTransfers();
        }
        return result;

    }

    initializeChron() {

        this.monthly = new FinancialPackage();
        this.yearly = new FinancialPackage();
        this.total = new FinancialPackage();

        this.monthlyIncomeTaxes = [];
        this.monthlyCapitalGainsTaxes = [];

        this.displayCapitalGainsTaxes = [];

        for (let modelAsset of this.modelAssets) {
            modelAsset.initializeChron();
        }
    }

    monthlyChron(currentDateInt) {

        this.reportMonthly(currentDateInt);

        this.monthlyIncomeTaxes.push(this.monthly.incomeTax.toCurrency());
        this.monthlyCapitalGainsTaxes.push(this.monthly.longTermCapitalGainsTax.toCurrency());

        this.yearly.add(this.monthly);
        this.total.add(this.monthly);
        this.monthly.zero();
        
        for (let modelAsset of this.modelAssets) {
            modelAsset.monthlyChron(currentDateInt);
        }        
    }

    yearlyChron(currentDateInt) {

        this.reportYearly(currentDateInt);
        this.yearly.zero();
        this.activeUser.addYears(1);

    }

    finalizeChron() {
        for (let modelAsset of this.modelAssets) {
            modelAsset.finalizeChron();
        }
    }
    
    sumAssetCurrency(property) {

        let amount = new Currency(0.0);
        for (let modelAsset of this.modelAssets) {
            if (InstrumentType.isAsset(modelAsset.instrument))
                amount.add(modelAsset[property]);
        }
        return amount;

    }

    startValue() {
        return this.sumAssetCurrency('startCurrency');
    }

    finishValue() {
        return this.sumAssetCurrency('finishCurrency');
    }

    accumulatedValue() {
        return this.sumAssetCurrency('accumulatedCurrency');
    }
    
    applyMonth(currentDateInt) {
        
        if (currentDateInt.day == 1) {

            this.applyFirstDayOfMonth(currentDateInt);
            return this.modelAssets.length; 

        }

        
        else if (currentDateInt.day == 15) {       

            /*
            // potentially pay taxes
            for (let modelAsset of this.modelAssets) {
                if (modelAsset.inMonth(currentDateInt))
                    this.totalTaxesPaid.add(modelAsset.applyMonthlyTaxPayments());
            }
            */

        }
        

        else if (currentDateInt.day == 30) {

            this.applyLastDayOfMonth(currentDateInt);            

        }

        return 0;

    }

    applyFirstDayOfMonth(currentDateInt) {

        // let the model assets know its the first day of the month.
        for (let modelAsset of this.modelAssets) {
            modelAsset.applyFirstDayOfMonth(currentDateInt);
        }

        // close assets that are now past their finish date
        for (let modelAsset of this.modelAssets) {
            if (modelAsset.afterFinishDate && !modelAsset.isClosed) {
                this.closeAsset(modelAsset);
            }
        }

        // recognize priority calculations (income, mortgages, taxableEquity, taxDeferredEquity)
        for (let modelAsset of this.modelAssets) {

            this.applyFirstDayOfMonthCalculations(modelAsset);                              

        }

        // calculate fixed taxes like fica and property taxes
        for (let modelAsset of this.modelAssets) {       

            this.applyFirstDayOfMonthTaxes(modelAsset);                   
     
        }
        
        // 401K or ira required minimum distribution
        for (let modelAsset of this.modelAssets) {
            
            this.calculateFirstDayOfMonthRMDs(currentDateInt, modelAsset);
        
        }

        // apply credits/debits
        for (let modelAsset of this.modelAssets) {
                
            this.applyFirstDayOfMonthIncomeFundTransfers(modelAsset);                            
                 
        }
    }

    applyFirstDayOfMonthCalculations(modelAsset) {
        
        // assert mortgage happens before income happens before taxDeferredEquity happens before taxableEquity
        if (InstrumentType.isMonthlyIncome(modelAsset.instrument)) {

            modelAsset.applyMonthly();

            let taxableIncome = modelAsset.incomeCurrency.copy();
            if (InstrumentType.isSocialSecurity(modelAsset.instrument)) {
                //taxableIncome.multiply(0.85); // maximum allowed for social security
                this.monthly.socialSecurity.add(taxableIncome);
            }
            else if (modelAsset.isSelfEmployed)
                this.monthly.selfIncome.add(taxableIncome);
            else
                this.monthly.employedIncome.add(taxableIncome);            

            modelAsset.addToMetric(Metric.FOUR_01K_CONTRIBUTION, this.calculateFirstDayOfMonthIncomeFour01KContribution(modelAsset));
            modelAsset.addToMetric(Metric.IRA_CONTRIBUTION, this.calculateFirstDayOfMonthIncomeIRAContribution(modelAsset));            

        }
        else if (InstrumentType.isMortgage(modelAsset.instrument)) {

            let result = modelAsset.applyMonthly();
            this.monthly.addResult(result);        

        }
        
    }

    applyFirstDayOfMonthTaxes(modelAsset) {

        // assert mortgage happens before income happens before taxDeferredEquity happens before taxableEquity
        if (InstrumentType.isHome(modelAsset.instrument)) {
            // we do have property taxes
            let propertyTaxes = new Currency(modelAsset.finishCurrency.amount * (global_propertyTaxRate / 12.0));
            this.monthly.propertyTaxes.subtract(propertyTaxes);            
        }
        else if (InstrumentType.isMonthlyIncome(modelAsset.instrument)) {
            if (!InstrumentType.isSocialSecurity(modelAsset.instrument)) {                
                let withholding = activeTaxTable.calculateFICATax(modelAsset.isSelfEmployed, modelAsset.incomeCurrency.copy());
                activeTaxTable.addYearlySocialSecurity(withholding.socialSecurity);

                withholding.flipSigns();
                modelAsset.addToMetric(Metric.MEDICARE, withholding.medicare);
                modelAsset.addToMetric(Metric.SOCIAL_SECURITY, withholding.socialSecurity);                
                this.monthly.addWithholdingResult(withholding);
            }
        }

    }

    calculateFirstDayOfMonthRMDs(currentDateInt, modelAsset) {

        if (!InstrumentType.isTaxDeferred(modelAsset.instrument))
            return;
    
        if (this.activeUser.rmdRequired()) {
            // if the user is 73 or older, then they must take RMDs
            let rmd = activeTaxTable.calculateMonthlyRMD(currentDateInt, this.activeUser, modelAsset);
            modelAsset.addToMetric(Metric.RMD, rmd);
        }

    }

    applyFirstDayOfMonthIncomeFundTransfers(modelAsset) {
        if (!InstrumentType.isMonthlyIncome(modelAsset.instrument)) {
            return;
        }
    
        const modelAssetIncome = modelAsset.finishCurrency.copy();
        let runningIncomeAmount = new Currency(0.0);
    
        if (modelAsset.fundTransfers?.length > 0) {
            for (const fundTransfer of modelAsset.fundTransfers) {
                fundTransfer.bind(modelAsset, this.modelAssets);
                const incomeAmount = fundTransfer.calculate();
                fundTransfer.execute();
    
                this.handleFundTransferContribution(fundTransfer, incomeAmount);
                runningIncomeAmount.subtract(incomeAmount);
            }
        }
    
        const extraAmount = new Currency(modelAssetIncome.amount + runningIncomeAmount.amount);
        if (extraAmount.amount > 0) {
            this.creditToFirstExpensableAccount(extraAmount, `Remaining income from ${modelAsset.displayName}`);
        }
    }
    
    handleFundTransferContribution(fundTransfer, incomeAmount) {
        const targetInstrument = fundTransfer.toModel.instrument;
    
        if (InstrumentType.isTaxDeferred(targetInstrument)) {
            if (InstrumentType.isIRA(targetInstrument)) {
                this.monthly.iraContribution.add(incomeAmount);
            } else if (InstrumentType.is401K(targetInstrument)) {
                this.monthly.four01KContribution.add(incomeAmount);
            }
        } else if (InstrumentType.isTaxFree(targetInstrument)) {
            this.monthly.rothContribution.add(incomeAmount);
        }
    }

    calculateFirstDayOfMonthIncomeIRAContribution(modelAsset) {

        if (!InstrumentType.isMonthlyIncome(modelAsset.instrument)) {
            logger.log('Portfolio.calculateFirstDayOfMonthIncomeIRAContribution - not a monthly income model asset');
            return new Currency();
        }        
        
        let totalIRAContribution = new Currency(0.0);
        let totalIRAContributionLimit = activeTaxTable.iraContributionLimit(this.activeUser);
        for (let fundTransfer of modelAsset.fundTransfers) {
            delete fundTransfer.approvedAmount;
            fundTransfer.bind(modelAsset, this.modelAssets);
            if (InstrumentType.isTaxDeferred(fundTransfer.toModel.instrument) && InstrumentType.isIRA(fundTransfer.toModel.instrument)) {
                let iraContribution = fundTransfer.calculate();            
                if (this.yearly.iraContribution.amount + this.yearly.rothContribution.amount + iraContribution.amount > totalIRAContributionLimit.amount) {
                    iraContribution = new Currency(totalIRAContributionLimit.amount - this.yearly.iraContribution.amount);
                }
                fundTransfer.approvedAmount = iraContribution;
                totalIRAContribution.add(iraContribution);
            }
            else if (InstrumentType.isRothIRA(fundTransfer.toModel.instrument)) {
                let rothContribution = fundTransfer.calculate();            
                if (this.yearly.iraContribution.amount + this.yearly.rothContribution.amount + rothContribution.amount > totalIRAContributionLimit.amount) {
                    rothContribution = new Currency(totalIRAContributionLimit.amount - this.yearly.rothContribution.amount);
                }
                fundTransfer.approvedAmount = rothContribution;
                totalIRAContribution.add(rothContribution);
            }
        }

        if (totalIRAContribution.amount == 0) {
            // todo: look for ira or rothIRA and contribute
        }

        return totalIRAContribution

    }

    calculateFirstDayOfMonthIncomeFour01KContribution(modelAsset) {

        if (!InstrumentType.isMonthlyIncome(modelAsset.instrument)) {
            logger.log('Portfolio.calculateFirstDayOfMonthIncomeFour01KContribution - not a monthly income model asset');
            return new Currency();
        }        
        
        let totalFour01KContribution = new Currency(0.0);
        let totalFour01KContributionLimit = activeTaxTable.four01KContributionLimit(this.activeUser);
        for (let fundTransfer of modelAsset.fundTransfers) {
            delete fundTransfer.approvedAmount;
            fundTransfer.bind(modelAsset, this.modelAssets);
            if (InstrumentType.isTaxDeferred(fundTransfer.toModel.instrument) && InstrumentType.is401K(fundTransfer.toModel.instrument)) {
                let four01KContribution = fundTransfer.calculate();            
                if (this.yearly.four01KContribution.amount + four01KContribution.amount > totalFour01KContributionLimit.amount) {
                    four01KContribution = new Currency(totalFour01KContributionLimit.amount - this.yearly.four01KContribution.amount);
                }
                fundTransfer.approvedAmount = four01KContribution;
                totalFour01KContribution.add(four01KContribution);
            }        
        }

        if (totalFour01KContribution.amount == 0) {
            // todo: look for 401K and contribute
        }

        return totalFour01KContribution

    }

    applyLastDayOfMonth(currentDateInt) {

        // apply expenses
        for (let modelAsset of this.modelAssets) {

            this.applyLastDayOfMonthExpenseFundTransfers(modelAsset);           

        }

        // ensure RMDs are handled
        for (let modelAsset of this.modelAssets) {            

            this.ensureRMDDistributions(modelAsset);
        }

        // recognize asset gains
        // Doing this after applying expenses is pessimistic
        // Maybe an optimistic option to do this prior to expenses?
        for (let modelAsset of this.modelAssets) {
                  
            this.applyLastDayOfMonthCalculations(modelAsset);                
            
        }

        for (let modelAsset of this.modelAssets) {

            modelAsset.applyLastDayOfMonth(currentDateInt);

        }

        this.applyMonthlyTaxes();

    }

    applyLastDayOfMonthCalculations(modelAsset) {

        if (InstrumentType.isCapital(modelAsset.instrument) || InstrumentType.isIncomeAccount(modelAsset.instrument) || InstrumentType.isMonthlyExpense(modelAsset.instrument)) {
            let result = modelAsset.applyMonthly();
            this.monthly.addResult(result);
        }

    }

    applyLastDayOfMonthExpenseFundTransfers(modelAsset) {
        if (!InstrumentType.isMonthlyExpense(modelAsset.instrument)) {
            return;
        }
    
        const modelAssetExpense = modelAsset.finishCurrency.copy();
        let runningExpenseAmount = new Currency(0.0);
    
        if (modelAsset.fundTransfers?.length > 0) {
            for (const fundTransfer of modelAsset.fundTransfers) {
                fundTransfer.bind(modelAsset, this.modelAssets);
                const expenseAmount = fundTransfer.calculate();
                const fundTransferResult = fundTransfer.execute();
    
                this.handleFundTransferExpense(fundTransfer, fundTransferResult, modelAsset.displayName);
                runningExpenseAmount.add(expenseAmount);
            }
    
            const extraAmount = new Currency(runningExpenseAmount.amount - modelAssetExpense.amount);
            if (extraAmount.amount > 0) {
                logger.log(`Portfolio.applyFundTransfersForExpense: ${modelAsset.displayName} expensing ${extraAmount.toString()} from first taxable account`);
                const assetChange = this.debitFromFirstTaxableAccount(extraAmount, `Expense overflow for ${modelAsset.displayName}`);
                this.applyCapitalGainsToFirstExpensableAccount(assetChange);
            }
        } else {
            logger.log(`Portfolio.applyFundTransfersForExpense: ${modelAsset.displayName} expensing ${modelAssetExpense.toString()} from first taxable account`);
            const assetChange = this.debitFromFirstTaxableAccount(modelAssetExpense.flipSign(), `Expense debit for ${modelAsset.displayName}`);
            this.applyCapitalGainsToFirstExpensableAccount(assetChange);
        }
    }
    
    handleFundTransferExpense(fundTransfer, fundTransferResult, modelAssetName) {
        const targetInstrument = fundTransfer.toModel.instrument;
    
        if (InstrumentType.isTaxableAccount(targetInstrument)) {
            if (fundTransferResult.toAssetChange.amount !== 0) {
                logger.log(`Portfolio.applyFundTransfersForExpense: ${modelAssetName} expensing ${fundTransfer.toModel.displayName} generated longTermCapitalGains of ${fundTransferResult.toAssetChange.toString()}`);
                this.monthly.longTermCapitalGains.add(fundTransferResult.toAssetChange);                
            }
        } else if (InstrumentType.isTaxDeferred(targetInstrument)) {
            if (fundTransferResult.toAssetChange.amount !== 0) {
                logger.log(`Portfolio.applyFundTransfersForExpense: ${modelAssetName} expensing ${fundTransfer.toModel.displayName} generated ordinaryIncome of ${fundTransferResult.toAssetChange.toString()}`);
                if (InstrumentType.isIRA(targetInstrument)) {
                    this.monthly.iraDistribution.add(fundTransferResult.toAssetChange);
                } else if (InstrumentType.is401K(targetInstrument)) {
                    this.monthly.four01KDistribution.add(fundTransferResult.toAssetChange);
                } else {
                    logger.log(`Portfolio.applyLastDayOfMonthExpenseFundTransfers: unhandled isTaxDeferred ${fundTransfer.toDisplayName}`);
                }
            }
        } else if (InstrumentType.isTaxFree(targetInstrument)) {
            logger.log(`Portfolio.applyFundTransfersForExpense: ${modelAssetName} expensing ${fundTransfer.toModel.displayName} generated no tax impact`);
            this.monthly.rothDistribution.add(fundTransferResult.toAssetChange);
        }
    }

    ensureRMDDistributions(modelAsset) {

        if (!InstrumentType.isTaxDeferred(modelAsset.instrument))
            return;

        let rmd = modelAsset.rmdCurrency.copy();
        let distributions = new Currency();

        if (this.activeUser.rmdRequired()) {
            
            if (InstrumentType.isIRA(modelAsset.instrument))
                distributions = modelAsset.iraDistributionCurrency.copy();
            else if (InstrumentType.is401K(modelAsset.instrument))
                distributions = modelAsset.four01KDistributionCurrency.copy();            
            else
                logger.log('Portfolio.ensureRMDDistributions: should not be here!');

        }

        if (rmd.amount > distributions.amount) {

            let remains = new Currency(rmd.amount - distributions.amount);

            if (InstrumentType.isIRA(modelAsset.instrument))
                modelAsset.addToMetric(Metric.IRA_DISTRIBUTION, remains);
            else
                modelAsset.addToMetric(Metric.FOUR_01K_DISTRIBUTION, remains);

            const rmdNote = `RMD distribution from ${modelAsset.displayName}`;
            modelAsset.debit(remains, rmdNote);
            this.creditToFirstExpensableAccount(remains, rmdNote);

        }

    }

    handleCapitalGains(modelAsset) {

        if (!InstrumentType.isTaxFree(modelAsset.instrument)) {
            
            const capitalGains = new Currency(modelAsset.finishCurrency.amount - modelAsset.basisCurrency.amount);
            logger.log('capital gains of ' + capitalGains.toString());

            // we need to do the calculations for this transaction since the monthly taxation routine multiplies by 12
            let amountToTax = new Currency();

            const monthsSpan = MonthsSpan.build(modelAsset.startDateInt, modelAsset.finishDateInt);
            const isLongTerm = monthsSpan.totalMonths > 12;

            if (isLongTerm) {

                let longTermCapitalGains = capitalGains.copy();
                if (monthsSpan.totalMonths > 24 && InstrumentType.isHome(modelAsset.instrument)) {
                    longTermCapitalGains.amount -= global_home_sale_capital_gains_discount;
                    if (longTermCapitalGains.amount < 0) {
                        longTermCapitalGains.zero();
                    }
                }


                this.monthly.longTermCapitalGains.add(capitalGains);
                modelAsset.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, capitalGains);
                
                let income = this.monthly.totalIncome().copy().multiply(12);
                amountToTax.add(activeTaxTable.calculateYearlyLongTermCapitalGainsTax(income, longTermCapitalGains));                
                this.monthly.longTermCapitalGainsTax.add(amountToTax.flipSign());    
                modelAsset.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN_TAX, amountToTax);

            } else {

                this.monthly.shortTermCapitalGains.add(capitalGains);
                modelAsset.addToMetric(Metric.SHORT_TERM_CAPITAL_GAIN, capitalGains);

                amountToTax.add(activeTaxTable.calculateYearlyIncomeTax(capitalGains));
                this.monthly.incomeTax.add(amountToTax.flipSign());
                modelAsset.addToMetric(Metric.SHORT_TERM_CAPITAL_GAIN_TAX, capitalGains);


            }

            logger.log('Portfolio.closeAsset: ' + modelAsset.displayName + ' generated tax of ' + amountToTax.toString() + ' to deduct from closure');
            modelAsset.finishCurrency.add(amountToTax);
        }
    }

    closeAsset(modelAsset) {

        if (InstrumentType.isMonthlyIncome(modelAsset.instrument) ||
            InstrumentType.isMonthlyExpense(modelAsset.instrument)) {
            logger.log('closing ' + modelAsset.displayName + ' with monthly income or expense, skipping fund transfers');
            modelAsset.close();
            return;
        }

        const amountToTransfer = new Currency(modelAsset.finishCurrency.amount);
        logger.log('close asset: ' + modelAsset.displayName + ' valued at ' + amountToTransfer.toString());    
    
        if (InstrumentType.isCapital(modelAsset.instrument)) {

            this.handleCapitalGains(modelAsset);

        }
 
        this.applyAssetCloseFundTransfers(modelAsset);
        modelAsset.close();

    }

    applyAssetCloseFundTransfers(modelAsset) {

        let modelAssetValue = modelAsset.finishCurrency.copy();

        if (modelAsset.fundTransfers && modelAsset.fundTransfers.length > 0) {
        
            let runningTransferAmount = new Currency(0.0);        
            for (let fundTransfer of modelAsset.fundTransfers) {
                fundTransfer.bind(modelAsset, this.modelAssets);

                // can only send money to an expensable account
                if (!InstrumentType.isExpensable(fundTransfer.toModel.instrument)) {
                    logger.log('Portfolio.applyAssetCloseFundTransfers: cannot transfer to ' + fundTransfer.toModel.displayName + ' because not an expensable account');
                    continue;
                }

                let transferAmount = fundTransfer.calculate();
                fundTransfer.execute(); // goes to fundTransfer.toModel.creditCurrency
                //logger.log('Portfolio.applyAssetCloseFundTransfers: ' + modelAsset.displayName + ' transferred ' + transferAmount.toString() + ' to ' + fundTransfer.toModel.displayName);
                
                runningTransferAmount.add(transferAmount);
            }
            
            let extraAmount = new Currency(modelAssetValue.amount - runningTransferAmount.amount);
            if (extraAmount.amount > 0) {
                logger.log('Portfolio.applyAssetCloseFundTransfers: ' + modelAsset.displayName + ' funding ' + extraAmount.toString() + ' to first expensable account');
                this.creditToFirstExpensableAccount(extraAmount, `Asset closure proceeds from ${modelAsset.displayName}`);
            }

        }
        else {

            logger.log('Portfolio.applyAssetCloseFundTransfers: ' + modelAsset.displayName + ' funding ' + modelAssetValue.toString() + ' to first expensable account');
            this.creditToFirstExpensableAccount(modelAssetValue, `Asset closure proceeds from ${modelAsset.displayName}`);            
                        
        }

    }

    applyMonthlyTaxes() {

        let yearly = this.monthly.copy().multiply(12.0);
        yearly.limitDeductions(this.activeUser);
        let yearlyIncome = activeTaxTable.calculateYearlyTaxableIncome(yearly);

        let incomeTax = activeTaxTable.calculateYearlyIncomeTax(yearlyIncome);
        //let longTermCapitalGainsTax = activeTaxTable.calculateYearlyLongTermCapitalGainsTax(yearlyIncome, yearly.longTermCapitalGains);
        
        incomeTax.divide(12.0).flipSign();
        //longTermCapitalGainsTax.divide(12.0).flipSign();

        this.monthly.incomeTax.add(incomeTax);
        //this.monthly.longTermCapitalGainsTax.add(longTermCapitalGainsTax);

        logger.log('monthlyTaxes.fica: ' + this.monthly.fica.toString());
        this.creditToFirstExpensableAccount(this.monthly.fica, 'FICA withholding');

        logger.log('monthlyTaxes.incomeTax: ' + this.monthly.incomeTax.toString());
        this.creditToFirstExpensableAccount(this.monthly.incomeTax, 'Income tax withholding');

        //logger.log('monthlyTaxes.longTermCapitalGains: ' + this.monthly.longTermCapitalGainsTax.toString());
        //this.creditToFirstExpensableAccount(longTermCapitalGainsTax);                                  
        
    }

    applyCapitalGainsToFirstExpensableAccount(amount) {

        // todo: mix short term and long term capital gains
        for (let modelAsset of this.modelAssets) {
            if (InstrumentType.isExpensable(modelAsset.instrument)) {                
                modelAsset.credit(amount, 'Capital gains');
                this.monthly.longTermCapitalGains.add(amount);
                break;
            }
        }

    }

    applyToFirstMatchingAccount(predicate, operation, amount, note = '') {

        for (let modelAsset of this.modelAssets) {
            if (predicate(modelAsset.instrument)) {
                return modelAsset[operation](amount, note);
            }
        }
        return new FundTransferResult();

    }

    creditToFirstExpensableAccount(amount, note = '') {
        return this.applyToFirstMatchingAccount(InstrumentType.isExpensable, 'credit', amount, note);
    }

    debitFromFirstExpensableAccount(amount, note = '') {
        return this.applyToFirstMatchingAccount(InstrumentType.isExpensable, 'debit', amount, note);
    }

    debitFromFirstTaxableAccount(amount, note = '') {
        return this.applyToFirstMatchingAccount(InstrumentType.isTaxableAccount, 'debit', amount, note);
    }

    applyYear(currentDateInt) {

        for (let modelAsset of this.modelAssets) {
            if (modelAsset.inMonth(currentDateInt)) {
                if (InstrumentType.isMonthlyIncome(modelAsset.instrument))
                    modelAsset.applyYearly();
            }
        }

    }

    modelMetricsToDisplayData(monthsSpan, modelAsset) {
        
        for (let metric of modelAsset.getMetrics()) {

            metric.buildDisplayHistory(monthsSpan);            
            
        }    

    }

    buildChartingDisplayData() {
        // asset and earning data will be handled by charting
        // portfolio will coelsece cashflow data

        let monthsSpan = MonthsSpan.build(this.firstDateInt, this.lastDateInt);
        for (let modelAsset of this.modelAssets) {
            this.modelMetricsToDisplayData(monthsSpan, modelAsset);
        }

        this.assertions();

    }

    reportMonthly(currentDateInt) {

        if (this.reports) {
            
            logger.log(' -------  Begin Monthly (' + currentDateInt.toString() + ' ) Report -------');
            this.monthly.report();
            logger.log(' -------   End Monthly (' + currentDateInt.toString() + ' ) Report  -------');

        }

    }

    reportYearly(currentDateInt) {

        if (this.reports) {
            
            logger.log(' -------  Begin Yearly (' + currentDateInt.toString() + ' ) Report -------');
            this.yearly.report();
            logger.log(' -------   End Yearly  (' + currentDateInt.toString() + ' ) Report  -------');

            //spreadsheetElement.innerHTML += this.yearly.reportHTML(currentDateInt);

        }

    }

    reportHTML(currentDateInt) {
        let result = '';
        result += '<h3>Yearly Report for ' + currentDateInt.year + '</h3>\n';
        result += this.yearly.reportHTML(currentDateInt);
        return result;
    }

    sumDisplayData(displayArrayName) {
        let result = new Currency();
        if (this[displayArrayName] != null) {
            for (let ii = 0; ii < this[displayArrayName].length; ++ii)
                result.amount += this[displayArrayName][ii];
        }
        return result;
    }

    assertions() {

        let assertion1 = this.sumDisplayData('displayValue');
        if (assertion1.amount == (this.total.selfIncome.amount + this.total.employedIncome.amount))
            logger.log('assert summed monthly income == total income is TRUE');
        else
            logger.log('assert summed monthly income == total incomme is FALSE');
        
        let assertion2 = this.sumDisplayData('displayEarning');
        if (assertion2.amount == this.total.ordinaryIncome.amount)
            logger.log('assert summed monthly earnings == total taxableIncome is TRUE');
        else
            logger.log('assert summed monthly earnings == total taxableIncome is FALSE');

    }

}