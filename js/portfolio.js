import { Currency } from './currency.js';
import { InstrumentType } from './instrument.js';
import { Metric } from './model-asset.js';
import { FundTransferResult, AssetAppreciationResult, CapitalGainsResult, MortgageResult, IncomeResult, ExpenseResult, InterestResult, WithholdingResult, CreditMemo } from './results.js';
import { MonthsSpan } from './months-span.js';
import { logger, LogCategory } from './logger.js';
import { User } from './user.js';
import { firstDateInt, lastDateInt } from './asset-queries.js';
import { activeTaxTable } from './globals.js';
import { global_propertyTaxDeductionMax, global_user_startAge } from './globals.js';

/*
yearlyGrossIncome

yearlyDeductions

yearlyCapitalGains

yearlyWithheldTaxes (This is the sum of all the monthly estimates your engine currently calculates).
*/

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

    irsTaxableGrossIncome() {
        // Only what the IRS taxes (Wages + taxable distributions + taxable gains/interest)
        let irsIncome = this.wageIncome().copy();
        irsIncome.add(this.ordinaryIncome());
        return irsIncome;
    }

    trueGrossIncome() {
        let income = this.wageIncome().copy();
        income.add(this.socialSecurity); // Note: raw SS, not the 85% taxed portion
        income.add(this.interestIncome);
        income.add(this.qualifiedDividends);
        income.add(this.nonQualifiedDividends);
        // We do NOT add IRA/401k/Roth distributions here!
        return income;
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

    contributions() {

        let contributions = this.iraContribution.copy();
        contributions.add(this.four01KContribution);
        contributions.add(this.rothContribution);
        return contributions;

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
        //taxes.add(this.propertyTaxes);
        taxes.add(this.estimatedTaxes);
        return taxes;

    }

    expenses() {
        return this.expense.copy();
    }

    growth() {
        return this.assetAppreciation.copy();
    }

    cashFlow() {
        let e = this.trueGrossIncome();
    
        // Add wealth generation
        e.add(this.growth()); // Asset appreciation captures incremental wealth generation
    
        // Note: We DO NOT add shortTermCapitalGains or longTermCapitalGains here.
        // Selling an asset is a balance sheet transfer (Asset -> Cash). 
        // The wealth was already captured incrementally via growth().
    
        // Subtract liabilities and outflows (all stored as negative values)
        e.add(this.totalTaxes());
        e.add(this.expense);
        e.add(this.mortgageInterest);
    
        return e;
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
        result.push(this.expenses());
        result.push(this.growth());
        result.push(this.cashFlow());
        return result;

    }

    report(category = LogCategory.GENERAL) {

        logger.log(category, 'income:                      ' + this.totalIncome().toString());
        logger.log(category, '  employedIncome:            ' + this.employedIncome.toString());
        logger.log(category, '  selfIncome:                ' + this.selfIncome.toString());
        logger.log(category, '  ordinaryIncome:            ' + this.ordinaryIncome().toString());
        logger.log(category, '    socialSecurity (taxed):  ' + this.socialSecurity.toString());
        logger.log(category, '    iraDistribution:         ' + this.iraDistribution.toString());
        logger.log(category, '    401KDistribution:        ' + this.four01KDistribution.toString());
        logger.log(category, '    shortTermCapitalGains:   ' + this.shortTermCapitalGains.toString());
        logger.log(category, '    interestIncome:          ' + this.interestIncome.toString());
        logger.log(category, '    nonQualifiedDividends:   ' + this.nonQualifiedDividends.toString());
        logger.log(category, '  longTermCapitalGains:      ' + this.longTermCapitalGains.toString());
        logger.log(category, '  nonTaxableIncome:          ' + this.nontaxableIncome().toString());
        logger.log(category, '    qualifiedDividends       ' + this.qualifiedDividends.toString());
        logger.log(category, '    rothDistribution:        ' + this.rothDistribution.toString());
        logger.log(category, 'deductions:                  ' + this.deductions().toString());
        logger.log(category, '  iraContribution:           ' + this.iraContribution.toString());
        logger.log(category, '  401KContribution:          ' + this.four01KContribution.toString());
        logger.log(category, '  mortgageInterest:          ' + this.mortgageInterest.toString());
        logger.log(category, '  propertyTaxes:             ' + this.deductiblePropertyTaxes().toString());
        logger.log(category, 'taxes:                       ' + this.totalTaxes().toString());
        logger.log(category, '  fica:                      ' + this.fica.toString());
        logger.log(category, '  incomeTax:                 ' + this.incomeTax.toString());
        logger.log(category, '  longTermCapitalGainsTax:   ' + this.longTermCapitalGainsTax.toString());
        logger.log(category, '  propertyTaxes:             ' + this.propertyTaxes.toString());
        logger.log(category, '  estimatedTaxes:            ' + this.estimatedTaxes.toString());
        logger.log(category, 'contributions:               ' + this.contributions().toString());
        logger.log(category, '  401KContribution:          ' + this.four01KContribution.toString());
        logger.log(category, '  iraContribution:           ' + this.iraContribution.toString());
        logger.log(category, '  rothContribution:          ' + this.rothContribution.toString());
        logger.log(category, 'expenses:                    ' + this.expense.toString());
        logger.log(category, 'assetAppreciation:           ' + this.assetAppreciation.toString());
        logger.log(category, 'mortgagePrincipal:           ' + this.mortgagePrincipal.toString());
        logger.log(category, 'cashFlow:                    ' + this.cashFlow().toString());
        logger.log(category, 'effectTaxRate:               ' + this.effectiveTaxRate().toFixed(2));
        logger.log(category, 'expenses:                    ' + this.expense.toString());
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
        html += '<li>contributions:               ' + this.contributions().toString() + '<ul>';
        html += '  <li>401KContribution:          ' + this.four01KContribution.toString() + '</li>';    
        html += '  <li>iraContribution:           ' + this.iraContribution.toString() + '</li>';    
        html += '  <li>rothContribution:            ' + this.rothContribution.toString() + '</li>';
        html += '<li>assetAppreciation:           ' + this.assetAppreciation.toString() + '</li>';
        html += '<li>mortgagePrincipal:           ' + this.mortgagePrincipal.toString() + '</li>';        
        html += '<li>cashFlow:                    ' + this.cashFlow().toString() + '</li>';
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
        html += '<tr><td>Cash Flow</td><td>' + this.cashFlow().toString() + '</td></tr>';
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
        this.reports = !!reports; 
        this.generatedReports = []; 
        this.activeUser = new User(global_user_startAge);

        this.firstDateInt = firstDateInt(this.modelAssets);
        this.lastDateInt = lastDateInt(this.modelAssets);

        this.monthly = new FinancialPackage();
        this.yearly = new FinancialPackage();
        this.total = new FinancialPackage();

        this.monthlyPropertyTaxes = [];
        this.monthlyIncomeTaxes = [];
        this.monthlyCapitalGainsTaxes = [];

        this.displayCapitalGainsTaxes = [];
    }

    sortModelAssets(modelAssets) {
        logger.log(LogCategory.GENERAL, 'Portfolio.sortModelAssets');
    
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

        this.monthlyPropertyTaxes = [];
        this.monthlyIncomeTaxes = [];
        this.monthlyCapitalGainsTaxes = [];

        this.displayCapitalGainsTaxes = [];

        for (let modelAsset of this.modelAssets) {
            modelAsset.initializeChron();
        }
    }

    monthlySanityCheck(currentDateInt) {
        let ficaMemos = 0;
        let incomeTaxMemos = 0;
        let transferNet = 0;
        let capitalGainsMemos = 0;
        let capitalGainsTaxMemos = 0;
        let mortgageInterestMemos = 0;
        let mortgagePrincipalMemos = 0;
        let propertyTaxMemos = 0;
        let dividendMemos = 0;
        let interestIncomeMemos = 0;
        let assetGrowthMemos = 0;

        for (const modelAsset of this.modelAssets) {
            const startIdx = modelAsset.creditMemosCheckedIndex || 0;
            for (let i = startIdx; i < modelAsset.creditMemos.length; i++) {
                const memo = modelAsset.creditMemos[i];
                switch (memo.note) {
                    case 'FICA withholding':       ficaMemos += memo.amount.amount; break;
                    case 'Income tax withholding': incomeTaxMemos += memo.amount.amount; break;
                    case 'Capital gains':          capitalGainsMemos += memo.amount.amount; break;
                    case 'Mortgage interest':      mortgageInterestMemos += memo.amount.amount; break;
                    case 'Mortgage principal':     mortgagePrincipalMemos += memo.amount.amount; break;
                    case 'Property taxes':         propertyTaxMemos += memo.amount.amount; break;
                    case 'Dividend income':        dividendMemos += memo.amount.amount; break;
                    case 'Interest income':        interestIncomeMemos += memo.amount.amount; break;
                    case 'Asset growth':           assetGrowthMemos += memo.amount.amount; break;
                    case 'Expense growth':         assetGrowthMemos += memo.amount.amount; break; // Or create an expenseGrowthMemos variable
                    case 'Capital gains tax withholding': capitalGainsTaxMemos += memo.amount.amount; break;
                    default:                       transferNet += memo.amount.amount; break;
                }
            }
            modelAsset.creditMemosCheckedIndex = modelAsset.creditMemos.length;
        }

        const tolerance = 0.01;
        const check = (label, memoTotal, packageTotal) => {
            if (Math.abs(memoTotal - packageTotal) > tolerance) {
                logger.log(LogCategory.SANITY, `${currentDateInt} ${label}: memos=${memoTotal.toFixed(2)}, package=${packageTotal.toFixed(2)}`);
            }
        };

        check('FICA', ficaMemos, this.monthly.fica.amount);
        check('Income tax', incomeTaxMemos, this.monthly.incomeTax.amount);
        check('Mortgage interest', mortgageInterestMemos, this.monthly.mortgageInterest.amount);
        check('Mortgage principal', mortgagePrincipalMemos, this.monthly.mortgagePrincipal.amount);
        check('Property taxes', propertyTaxMemos, this.monthly.propertyTaxes.amount);
        check('Capital gains', capitalGainsMemos, this.monthly.longTermCapitalGains.amount);
        check('Capital gains tax', capitalGainsTaxMemos, this.monthly.longTermCapitalGainsTax.amount);

        if (Math.abs(transferNet) > tolerance) {
            logger.log(LogCategory.SANITY, `${currentDateInt} Fund transfers do not net to zero: ${transferNet.toFixed(2)}`);
        }
    }

    monthlyChron(currentDateInt) {

        this.reportMonthly(currentDateInt);

        this.monthlySanityCheck(currentDateInt);

        this.monthlyPropertyTaxes.push(this.monthly.propertyTaxes.toCurrency());
        this.monthlyIncomeTaxes.push(this.monthly.incomeTax.toCurrency());
        this.monthlyCapitalGainsTaxes.push(this.monthly.longTermCapitalGainsTax.toCurrency());

        this.computePerAssetCashFlow();

        this.yearly.add(this.monthly);
        this.total.add(this.monthly);
        this.monthly.zero();

        for (let modelAsset of this.modelAssets) {
            modelAsset.monthlyChron(currentDateInt);
        }
    }

    computePerAssetCashFlow() {
        for (let modelAsset of this.modelAssets) {
            let cashFlow = Currency.zero();
            const inst = modelAsset.instrument;

            if (InstrumentType.isMonthlyIncome(inst)) {
                cashFlow = modelAsset.incomeCurrency.copy();
                cashFlow.add(modelAsset.socialSecurityCurrency);
                cashFlow.add(modelAsset.medicareCurrency);
                cashFlow.add(modelAsset.estimatedIncomeTaxCurrency);
                cashFlow.add(modelAsset.four01KContributionCurrency);
                cashFlow.add(modelAsset.iraContributionCurrency);
            } else if (InstrumentType.isCapital(inst)) {
                cashFlow = modelAsset.growthCurrency.copy();
            } else if (InstrumentType.isIncomeAccount(inst)) {
                cashFlow = modelAsset.interestIncomeCurrency.copy();
            } else if (InstrumentType.isMortgage(inst)) {
                cashFlow = modelAsset.mortgageInterestCurrency.copy();
            } else if (InstrumentType.isMonthlyExpense(inst)) {
                cashFlow = modelAsset.expenseCurrency.copy();
            }

            modelAsset.cashFlowCurrency = cashFlow;
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
        return this.sumAssetCurrency('cashFlowAccumulatedCurrency');
    }
    
    applyMonth(currentDateInt) {

        /*
        leaving this in to test a specific test data case when selling a house
        if (currentDateInt.year == 2029 && currentDateInt.month == 7) {
            debugger;
        }
        */
        
        if (currentDateInt.day == 1) {

            this.applyFirstDayOfMonth(currentDateInt);
            return this.modelAssets.length; 

        }

        
        else if (currentDateInt.day == 15) {

            // Accumulate monthly property tax escrow for homes
            for (let modelAsset of this.modelAssets) {
                if (!modelAsset.inMonth(currentDateInt)) continue;
                if (InstrumentType.isHome(modelAsset.instrument) && modelAsset.monthlyPropertyTaxEscrow.amount > 0) {
                    const escrow = modelAsset.monthlyPropertyTaxEscrow.copy().flipSign();
                    modelAsset.propertyTaxCurrency.add(escrow);
                    modelAsset.creditMemos.push(new CreditMemo(escrow, 'Property tax escrow', modelAsset.currentDateInt));
                    this.monthly.propertyTaxes.add(escrow);
                }
            }

        }
        

        else if (currentDateInt.day == 30) {

            this.applyLastDayOfMonth(currentDateInt);            

        }

        return 0;

    }

    applyFirstDayOfMonth(currentDateInt) {

        // new month so update the modelAsset temporals
        for (let modelAsset of this.modelAssets) {
            modelAsset.handleCurrentDateInt(currentDateInt);
        }

        // close assets that are now past their finish date
        for (let modelAsset of this.modelAssets) {
            if (modelAsset.afterFinishDate && !modelAsset.isClosed) {
                this.closeAsset(modelAsset);
            }
        }

        // let the model assets know its the first day of the month.
        for (let modelAsset of this.modelAssets) {
            modelAsset.applyFirstDayOfMonth(currentDateInt);
        }        

        // recognize priority calculations (income, mortgages, taxableEquity, taxDeferredEquity)
        for (let modelAsset of this.modelAssets) {

            this.applyFirstDayOfMonthCalculations(modelAsset, currentDateInt);

        }

        // calculate fixed taxes like fica and property taxes
        for (let modelAsset of this.modelAssets) {       

            this.applyFirstDayOfMonthTaxes(modelAsset, currentDateInt);
     
        }
        
        // compute net income for income assets (gross - FICA - estimated income tax - pre-tax contributions)
        for (let modelAsset of this.modelAssets) {

            this.computeNetIncome(modelAsset);

        }

        // 401K or ira required minimum distribution
        for (let modelAsset of this.modelAssets) {

            this.calculateFirstDayOfMonthRMDs(currentDateInt, modelAsset);

        }

        // apply credits/debits
        for (let modelAsset of this.modelAssets) {

            this.applyFirstDayOfMonthIncomeFundTransfers(modelAsset, currentDateInt);

        }
    }

    applyFirstDayOfMonthCalculations(modelAsset, currentDateInt) {

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

            modelAsset.addToMetric(Metric.FOUR_01K_CONTRIBUTION, this.calculateFirstDayOfMonthIncomeFour01KContribution(modelAsset, currentDateInt));
            modelAsset.addToMetric(Metric.IRA_CONTRIBUTION, this.calculateFirstDayOfMonthIncomeIRAContribution(modelAsset, currentDateInt));            

        }
        else if (InstrumentType.isMortgage(modelAsset.instrument)) {

            let result = modelAsset.applyMonthly();
            this.monthly.addResult(result);        

        }
        
    }

    applyFirstDayOfMonthTaxes(modelAsset, currentDateInt) {

        if (InstrumentType.isMonthlyIncome(modelAsset.instrument)) {
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

    computeNetIncome(modelAsset) {        

        if (!InstrumentType.isMonthlyIncome(modelAsset.instrument)) {
            return;
        }

        let netIncome = modelAsset.incomeCurrency.copy();

        // subtract per-asset FICA (Social Security + Medicare, stored as negative values on model asset)
        let socialSecurity = modelAsset.socialSecurityCurrency;
        let medicare = modelAsset.medicareCurrency;
        netIncome.add(socialSecurity); // negative, so add subtracts
        netIncome.add(medicare);

        // subtract pre-tax 401K contributions (per-asset)
        let four01KContribution = modelAsset.four01KContributionCurrency;
        if (four01KContribution.amount > 0) {
            netIncome.subtract(four01KContribution);
        }

        // subtract IRA contributions (per-asset, includes both traditional and Roth)
        // all contributions reduce take-home pay regardless of tax treatment
        let iraContribution = modelAsset.iraContributionCurrency;
        if (iraContribution.amount > 0) {
            netIncome.subtract(iraContribution);
        }

        // estimate income tax withholding using annualized monthly data
        // this.monthly now has contributions properly wired:
        //   iraContribution = traditional IRA only (deductible)
        //   rothContribution = Roth only (not deductible)
        //   four01KContribution = traditional 401K (deductible)
        let yearlyEstimate = this.monthly.copy().multiply(12.0);
        yearlyEstimate.limitDeductions(this.activeUser);
        let yearlyTaxableIncome = activeTaxTable.calculateYearlyTaxableIncome(yearlyEstimate);
        let estimatedMonthlyIncomeTax = activeTaxTable.calculateYearlyIncomeTax(yearlyTaxableIncome);
        estimatedMonthlyIncomeTax.divide(12.0);
        modelAsset.estimatedMonthlyIncomeTax = estimatedMonthlyIncomeTax;
        modelAsset.addToMetric(Metric.ESTIMATED_INCOME_TAX, estimatedMonthlyIncomeTax);


        netIncome.subtract(estimatedMonthlyIncomeTax);
        modelAsset.netIncomeCurrency = netIncome;        

        logger.log(LogCategory.TRANSFER, `computeNetIncome: ${modelAsset.displayName} gross=${modelAsset.incomeCurrency.toString()} net=${netIncome.toString()}`);

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

    applyFirstDayOfMonthIncomeFundTransfers(modelAsset, currentDateInt) {
        if (!InstrumentType.isMonthlyIncome(modelAsset.instrument)) {
            return;
        }

        // Use net income (after taxes and pre-tax contributions) as the base for fund transfers
        const netIncome = modelAsset.netIncomeCurrency.copy();
        let runningTransferAmount = new Currency(0.0);

        if (modelAsset.fundTransfers?.length > 0) {
            for (const fundTransfer of modelAsset.fundTransfers) {
                if (!fundTransfer.isActiveForMonth(currentDateInt.month)) continue;
                fundTransfer.bind(modelAsset, this.modelAssets);
                const incomeAmount = fundTransfer.calculate();
                fundTransfer.execute();

                this.handleFundTransferContribution(fundTransfer, incomeAmount);
                runningTransferAmount.add(incomeAmount);
            }
        }

        const remainingIncome = new Currency(netIncome.amount - runningTransferAmount.amount);
        if (remainingIncome.amount < 0) {
            logger.log(LogCategory.SANITY, `applyFirstDayOfMonthIncomeFundTransfers: ${modelAsset.displayName} fund transfers (${runningTransferAmount.toString()}) exceed net income (${netIncome.toString()}) by ${remainingIncome.toString()}`);
        }
        if (remainingIncome.amount > 0) {
            this.creditToFirstExpensableAccount(remainingIncome, `Remaining income from ${modelAsset.displayName}`);
        }
    }
    
    handleFundTransferContribution(fundTransfer, incomeAmount) {
        const targetInstrument = fundTransfer.toModel.instrument;

        // 401K, IRA, and Roth contributions are already wired to this.monthly
        // in calculateFirstDayOfMonthIncomeFour01KContribution and
        // calculateFirstDayOfMonthIncomeIRAContribution (step 1)
        if (InstrumentType.isMortgage(targetInstrument)) {
            this.monthly.mortgagePrincipal.add(incomeAmount);
            logger.log(LogCategory.TRANSFER, 'handleFundTransferContribution: ' + fundTransfer.toModel.displayName + ' direct mortgage payment of ' + incomeAmount.toString());
        }
    }

    calculateFirstDayOfMonthIncomeIRAContribution(modelAsset, currentDateInt) {

        if (!InstrumentType.isMonthlyIncome(modelAsset.instrument)) {
            logger.log(LogCategory.TRANSFER, 'Portfolio.calculateFirstDayOfMonthIncomeIRAContribution - not a monthly income model asset');
            return new Currency();
        }

        let totalIRAContribution = new Currency(0.0);
        let traditionalIRAContribution = new Currency(0.0);
        let rothIRAContribution = new Currency(0.0);
        let totalIRAContributionLimit = activeTaxTable.iraContributionLimit(this.activeUser);
        for (let fundTransfer of modelAsset.fundTransfers) {
            if (!fundTransfer.isActiveForMonth(currentDateInt.month)) continue;
            delete fundTransfer.approvedAmount;
            fundTransfer.bind(modelAsset, this.modelAssets);
            if (InstrumentType.isTaxDeferred(fundTransfer.toModel.instrument) && InstrumentType.isIRA(fundTransfer.toModel.instrument)) {
                let iraContribution = fundTransfer.calculate();
                if (this.yearly.iraContribution.amount + this.yearly.rothContribution.amount + iraContribution.amount > totalIRAContributionLimit.amount) {
                    iraContribution = new Currency(totalIRAContributionLimit.amount - this.yearly.iraContribution.amount);
                }
                fundTransfer.approvedAmount = iraContribution;
                totalIRAContribution.add(iraContribution);
                traditionalIRAContribution.add(iraContribution);
            }
            else if (InstrumentType.isRothIRA(fundTransfer.toModel.instrument)) {
                let rothContribution = fundTransfer.calculate();
                if (this.yearly.iraContribution.amount + this.yearly.rothContribution.amount + rothContribution.amount > totalIRAContributionLimit.amount) {
                    rothContribution = new Currency(totalIRAContributionLimit.amount - this.yearly.rothContribution.amount);
                }
                fundTransfer.approvedAmount = rothContribution;
                totalIRAContribution.add(rothContribution);
                rothIRAContribution.add(rothContribution);
            }
        }

        if (totalIRAContribution.amount == 0) {
            // todo: look for ira or rothIRA and contribute
        }

        this.monthly.iraContribution.add(traditionalIRAContribution);
        this.monthly.rothContribution.add(rothIRAContribution);

        return totalIRAContribution

    }

    calculateFirstDayOfMonthIncomeFour01KContribution(modelAsset, currentDateInt) {

        if (!InstrumentType.isMonthlyIncome(modelAsset.instrument)) {
            logger.log(LogCategory.TRANSFER, 'Portfolio.calculateFirstDayOfMonthIncomeFour01KContribution - not a monthly income model asset');
            return new Currency();
        }

        let totalFour01KContribution = new Currency(0.0);
        let totalFour01KContributionLimit = activeTaxTable.four01KContributionLimit(this.activeUser);
        for (let fundTransfer of modelAsset.fundTransfers) {
            if (!fundTransfer.isActiveForMonth(currentDateInt.month)) continue;
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

        this.monthly.four01KContribution.add(totalFour01KContribution);

        return totalFour01KContribution

    }

    
    calculateGrossWithdrawalForShortfall(netShortfall, modelAsset) {
        // 1. Estimate current marginal LTCG bracket based strictly on base income (W-2, etc)
        const yearlyEstimate = this.monthly.copy().multiply(12.0);
        yearlyEstimate.limitDeductions(this.activeUser);
        const taxableIncome = activeTaxTable.calculateYearlyTaxableIncome(yearlyEstimate);
    
        // Quick heuristic for marginal LTCG rate (0%, 15%, 20%)
        const ltcgRate = activeTaxTable.getMarginalLTCGRate(taxableIncome); 
    
        // 2. Get the asset's gain ratio (g)
        const gainRatio = modelAsset.getUnrealizedGainRatio();
    
        // 3. Apply the Gross-Up Formula: W = X / (1 - (t * g))
        const denominator = 1.0 - (ltcgRate * gainRatio);
    
        // Prevent division by zero or negative bounds
        if (denominator <= 0) return netShortfall.copy(); 
    
        return new Currency(netShortfall.amount / denominator);
    }

    applyLastDayOfMonth(currentDateInt) {

        // apply expenses
        for (let modelAsset of this.modelAssets) {

            this.applyLastDayOfMonthExpenseFundTransfers(modelAsset, currentDateInt);

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

            // Compute estimated tax for non-Home capital assets (Home property tax is handled on day 15)
            if (InstrumentType.isCapital(modelAsset.instrument) && !InstrumentType.isHome(modelAsset.instrument) && modelAsset.annualTaxRate.rate !== 0) {
                const tax = new Currency(modelAsset.finishCurrency.amount * modelAsset.annualTaxRate.asMonthly()).flipSign();
                modelAsset.estimatedTaxCurrency.add(tax);
                modelAsset.creditMemos.push(new CreditMemo(tax, 'Estimated tax', modelAsset.currentDateInt));
                this.monthly.estimatedTaxes.add(tax);
            }
        }

    }

applyLastDayOfMonthExpenseFundTransfers(modelAsset, currentDateInt) {
        // Homes have property taxes and expenses are self-explanatory
        if (InstrumentType.isHome(modelAsset.instrument)) {
            
            
        } else if (!InstrumentType.isMonthlyExpense(modelAsset.instrument)) {
            return;
        }

        const modelAssetExpense = InstrumentType.isHome(modelAsset.instrument) ?
            modelAsset.propertyTaxCurrency.copy() :
            modelAsset.finishCurrency.copy();
        let runningExpenseAmount = new Currency(0.0);

        if (modelAsset.fundTransfers?.length > 0) {
            for (const fundTransfer of modelAsset.fundTransfers) {
                if (!fundTransfer.isActiveForMonth(currentDateInt.month)) continue;
                fundTransfer.bind(modelAsset, this.modelAssets);
                const expenseAmount = fundTransfer.calculate();
                const fundTransferResult = fundTransfer.execute();
    
                this.handleFundTransferExpense(fundTransfer, fundTransferResult, modelAsset.displayName);
                runningExpenseAmount.add(expenseAmount);
            }
    
            // =========================================================================
            // INSERTION POINT 1: Expense Overflow (Partial Shortfall)
            // Replaces the old "const extraAmount = ..." logic
            // =========================================================================
            const netShortfall = new Currency(runningExpenseAmount.amount - modelAssetExpense.amount);
            if (netShortfall.amount > 0) {
                logger.log(LogCategory.TRANSFER, `Portfolio.applyFundTransfersForExpense: ${modelAsset.displayName} expensing ${netShortfall.toString()} from taxable account (Grossed Up)`);
                
                const targetAsset = this.getFirstTaxableAccount(); 
                if (targetAsset) {
                    const grossWithdrawal = this.calculateGrossWithdrawalForShortfall(netShortfall, targetAsset);
                    const result = targetAsset.debit(grossWithdrawal, `Grossed-up expense overflow for ${modelAsset.displayName}`);
                    
                    if (result && result.realizedGain && result.realizedGain.amount > 0) {
                        this.monthly.longTermCapitalGains.add(result.realizedGain);
                        
                        // Isolate tax liability to prevent the death-spiral loop
                        const taxLiability = new Currency(grossWithdrawal.amount - netShortfall.amount);
                        this.monthly.estimatedTaxes.add(taxLiability); 
                    }
                }
            }
        } else {
            // =========================================================================
            // INSERTION POINT 2: Full Expense (Total Shortfall)
            // Replaces the old "this.debitFromFirstTaxableAccount" fallback
            // =========================================================================
            const netShortfall = modelAssetExpense.copy().flipSign();
            logger.log(LogCategory.TRANSFER, `Portfolio.applyFundTransfersForExpense: ${modelAsset.displayName} expensing ${netShortfall.toString()} from taxable account (Grossed Up)`);
            
            const targetAsset = this.getFirstTaxableAccount(); 
            if (targetAsset) {
                const grossWithdrawal = this.calculateGrossWithdrawalForShortfall(netShortfall, targetAsset);
                const result = targetAsset.debit(grossWithdrawal, `Grossed-up expense debit for ${modelAsset.displayName}`);
                
                if (result && result.realizedGain && result.realizedGain.amount > 0) {
                    this.monthly.longTermCapitalGains.add(result.realizedGain);
                    
                    // Isolate tax liability to prevent the death-spiral loop
                    const taxLiability = new Currency(grossWithdrawal.amount - netShortfall.amount);
                    this.monthly.estimatedTaxes.add(taxLiability); 
                }
            }
        }

        // Reset accumulated property tax after payment so it starts accumulating for the next period
        if (InstrumentType.isHome(modelAsset.instrument)) {
            modelAsset.propertyTaxCurrency.zero();
        }
    }

     handleFundTransferExpense(fundTransfer, fundTransferResult, modelAssetName) {
         const targetInstrument = fundTransfer.toModel.instrument;
         const change = fundTransferResult.toAssetChange.copy();
         const realizedGain = fundTransferResult.realizedGain.copy();

         change.flipSign(); // flip sign because it's an expense

         if (change.amount === 0) return;

         if (InstrumentType.isTaxableAccount(targetInstrument)) {
             logger.log(LogCategory.TRANSFER, `Portfolio.applyFundTransfersForExpense: ${modelAssetName} expensing ${fundTransfer.toModel.displayName} generated longTermCapitalGains of ${realizedGain.toString()}`);
             this.monthly.longTermCapitalGains.add(realizedGain); // Fix: Uses actual gain, not the full withdrawal!
         } else if (InstrumentType.isTaxDeferred(targetInstrument)) {
             logger.log(LogCategory.TRANSFER, `Portfolio.applyFundTransfersForExpense: ${modelAssetName} expensing ${fundTransfer.toModel.displayName} generated ordinaryIncome of ${change.toString()}`);
             if (InstrumentType.isIRA(targetInstrument)) {
                 this.monthly.iraDistribution.add(change);
             } else if (InstrumentType.is401K(targetInstrument)) {
                 this.monthly.four01KDistribution.add(change);
             } else {
                 logger.log(LogCategory.TRANSFER, `Portfolio.applyLastDayOfMonthExpenseFundTransfers: unhandled isTaxDeferred ${fundTransfer.toDisplayName}`);
             }
         } else if (InstrumentType.isTaxFree(targetInstrument)) {
             logger.log(LogCategory.TRANSFER, `Portfolio.applyFundTransfersForExpense: ${modelAssetName} expensing ${fundTransfer.toModel.displayName} generated no tax impact`);
             this.monthly.rothDistribution.add(change);
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
                logger.log(LogCategory.SANITY, 'Portfolio.ensureRMDDistributions: should not be here!');

        }

        if (rmd.amount > distributions.amount) {

            let remains = new Currency(rmd.amount - distributions.amount);

            if (InstrumentType.isIRA(modelAsset.instrument)) {
                modelAsset.addToMetric(Metric.IRA_DISTRIBUTION, remains);
                this.monthly.iraDistribution.add(remains);
            } else {
                modelAsset.addToMetric(Metric.FOUR_01K_DISTRIBUTION, remains);
                this.monthly.four01KDistribution.add(remains);
            }

            const rmdNote = `RMD distribution from ${modelAsset.displayName}`;
            modelAsset.debit(remains, rmdNote);
            this.creditToFirstExpensableAccount(remains, rmdNote);

        }

    }

    handleCapitalGains(modelAsset) {
        if (InstrumentType.isTaxFree(modelAsset.instrument)) return;

        const capitalGains = new Currency(modelAsset.finishCurrency.amount - modelAsset.finishBasisCurrency.amount);
        logger.log(LogCategory.TAX, 'capital gains of ' + capitalGains.toString());

        const monthsSpan = MonthsSpan.build(modelAsset.startDateInt, modelAsset.finishDateInt);
        const annualizedIncome = this.monthly.totalIncome().copy().multiply(12);
        const isHome = InstrumentType.isHome(modelAsset.instrument);

        const result = activeTaxTable.calculateCapitalGainsTax(
            capitalGains, monthsSpan.totalMonths, isHome, annualizedIncome
        );

        let amountToTax = result.tax.copy();

        if (result.isLongTerm) {
            this.monthly.longTermCapitalGains.add(capitalGains);
            modelAsset.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN, capitalGains);
            
            // FIX: Add the memo so the sanity check can find it
            modelAsset.creditMemos.push(new CreditMemo(capitalGains.copy(), 'Capital gains', modelAsset.currentDateInt));

            this.monthly.longTermCapitalGainsTax.add(amountToTax.flipSign());
            modelAsset.addToMetric(Metric.LONG_TERM_CAPITAL_GAIN_TAX, amountToTax);
            
            // FIX: Account for the money leaving the asset to pay tax
            if (amountToTax.amount !== 0) {
                modelAsset.creditMemos.push(new CreditMemo(amountToTax.copy(), 'Capital gains tax withholding', modelAsset.currentDateInt));
            }
        } else {
            this.monthly.shortTermCapitalGains.add(capitalGains);
            modelAsset.addToMetric(Metric.SHORT_TERM_CAPITAL_GAIN, capitalGains);
            
            this.monthly.incomeTax.add(amountToTax.flipSign());
            modelAsset.addToMetric(Metric.SHORT_TERM_CAPITAL_GAIN_TAX, capitalGains);
            
            // Short term is grouped into income tax, so use that memo string to satisfy the sanity check
            if (amountToTax.amount !== 0) {
                modelAsset.creditMemos.push(new CreditMemo(amountToTax.copy(), 'Income tax withholding', modelAsset.currentDateInt));
            }
        }

        logger.log(LogCategory.TAX, 'Portfolio.closeAsset: ' + modelAsset.displayName + ' generated tax of ' + amountToTax.toString() + ' to deduct from closure');
        modelAsset.finishCurrency.add(amountToTax);
    }

    closeAsset(modelAsset) {

        if (InstrumentType.isMonthlyIncome(modelAsset.instrument) ||
            InstrumentType.isMonthlyExpense(modelAsset.instrument)) {
            logger.log(LogCategory.TRANSFER, 'closing ' + modelAsset.displayName + ' with monthly income or expense, skipping fund transfers');
            modelAsset.close();
            return;
        }

        const amountToTransfer = new Currency(modelAsset.finishCurrency.amount);
        logger.log(LogCategory.TRANSFER, 'close asset: ' + modelAsset.displayName + ' valued at ' + amountToTransfer.toString());

        if (InstrumentType.isCapital(modelAsset.instrument)) {

            this.handleCapitalGains(modelAsset);

        }

        // Capture pre-transfer snapshots for display purposes
        modelAsset.closedValue = modelAsset.finishCurrency.copy();
        modelAsset.closedBasisValue = modelAsset.finishBasisCurrency.copy();

        this.applyAssetCloseFundTransfers(modelAsset);
        modelAsset.close();

    }

    applyAssetCloseFundTransfers(modelAsset) {

        let modelAssetValue = modelAsset.finishCurrency.copy();

        // Filter to only transfers that have an on-close percentage
        const closeTransfers = (modelAsset.fundTransfers || []).filter(ft => ft.hasClose);

        if (closeTransfers.length > 0) {

            let runningTransferAmount = new Currency(0.0);
            for (let fundTransfer of closeTransfers) {
                fundTransfer.bind(modelAsset, this.modelAssets);

                // can only send money to an expensable account
                if (!InstrumentType.isExpensable(fundTransfer.toModel.instrument)) {
                    logger.log(LogCategory.TRANSFER, 'Portfolio.applyAssetCloseFundTransfers: cannot transfer to ' + fundTransfer.toModel.displayName + ' because not an expensable account');
                    continue;
                }

                let transferAmount = fundTransfer.calculate({ useClosePercent: true });
                fundTransfer.execute({ skipGain: true, useClosePercent: true });

                runningTransferAmount.add(transferAmount);
            }

            let extraAmount = new Currency(modelAssetValue.amount - runningTransferAmount.amount);
            if (extraAmount.amount > 0) {
                logger.log(LogCategory.TRANSFER, 'Portfolio.applyAssetCloseFundTransfers: ' + modelAsset.displayName + ' funding ' + extraAmount.toString() + ' to first expensable account');

                const note = `Asset closure proceeds from ${modelAsset.displayName}`;
                modelAsset.debit(extraAmount, note, true); // true = skipGain (already handled)
                this.creditToFirstExpensableAccount(extraAmount, note);
            }

        }
        else {

            logger.log(LogCategory.TRANSFER, 'Portfolio.applyAssetCloseFundTransfers: ' + modelAsset.displayName + ' funding ' + modelAssetValue.toString() + ' to first expensable account');

            const note = `Asset closure proceeds from ${modelAsset.displayName}`;
            modelAsset.debit(modelAssetValue, note, true); // true = skipGain (already handled)
            this.creditToFirstExpensableAccount(modelAssetValue, note);

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

        logger.log(LogCategory.TAX, 'monthlyTaxes.fica: ' + this.monthly.fica.toString());
        this.creditToFirstExpensableAccount(this.monthly.fica, 'FICA withholding');

        logger.log(LogCategory.TAX, 'monthlyTaxes.incomeTax: ' + this.monthly.incomeTax.toString());
        this.creditToFirstExpensableAccount(this.monthly.incomeTax, 'Income tax withholding');

        //logger.log(LogCategory.TAX, 'monthlyTaxes.longTermCapitalGains: ' + this.monthly.longTermCapitalGainsTax.toString());
        //this.creditToFirstExpensableAccount(longTermCapitalGainsTax);                                  
        
    }

    applyAnnualTaxTrueUp(currentDateInt) {
        // Only run this once a year (e.g., end of December)
        if (currentDateInt.month !== 12) return; 

        // 1. Calculate the EXACT tax liability based on the full 365-day reality
        const actualTaxableIncome = activeTaxTable.calculateYearlyTaxableIncome(
            this.yearlyGrossIncome.copy().subtract(this.yearlyDeductions)
        );    

        // TODO: calculate the FICA liability for employedIncome and selfIncome

        const actualIncomeTax = activeTaxTable.calculateYearlyIncomeTax(actualTaxableIncome);
        const actualCapitalGainsTax = activeTaxTable.calculateYearlyLongTermCapitalGainsTax(
            actualTaxableIncome, 
            this.yearlyCapitalGains
        );

        const totalActualTax = actualIncomeTax.copy().add(actualCapitalGainsTax);

        // 2. Compare Actual vs. Withheld
        const taxDifference = totalActualTax.amount - this.yearlyWithheldTaxes.amount;

        if (taxDifference > 0) {
            // UNDERPAID: The user owes the IRS a check.
            // This is a negative cash flow event.
            logger.log(LogCategory.TAX, `Annual True-Up: User owes ${taxDifference}. Debiting account.`);
            const taxBill = new Currency(taxDifference);
            
            // This might trigger your new Gross-Up Shortfall logic if cashFlow is empty!
            this.debitFromFirstExpensableAccount(taxBill, 'Annual IRS Tax Bill Due'); 
            
        } else if (taxDifference < 0) {
            // OVERPAID: The user gets a tax refund!
            // This is a positive cash flow event.
            const refundAmount = Math.abs(taxDifference);
            logger.log(LogCategory.TAX, `Annual True-Up: User overpaid. Refunding ${refundAmount}.`);
            const taxRefund = new Currency(refundAmount);
            
            this.creditToFirstExpensableAccount(taxRefund, 'IRS Tax Refund');
        }

        // 3. Reset the annual accumulators for the next year
        this.resetAnnualAccumulators();
    }

    applyToFirstMatchingAccount(predicate, operation, amount, note = '') {
         for (let modelAsset of this.modelAssets) {
             if (predicate(modelAsset.instrument)) {
                 return modelAsset[operation](amount, note);
             }
         }
         return { assetChange: Currency.zero(), realizedGain: Currency.zero() };
    }

    getFirstExpensableAccount() {
        for (let modelAsset of this.modelAssets) {
            if (InstrumentType.isExpensableAccount(modelAsset.instrument)) {
                return modelAsset;
            }
        }
        return null; // Handle case where user is completely out of taxable funds
    }

    creditToFirstExpensableAccount(amount, note = '') {
        return this.applyToFirstMatchingAccount(InstrumentType.isExpensable, 'credit', amount, note);
    }

    debitFromFirstExpensableAccount(amount, note = '') {
        return this.applyToFirstMatchingAccount(InstrumentType.isExpensable, 'debit', amount, note);
    }

    // Add this helper to portfolio.js
    getFirstTaxableAccount() {
        for (let modelAsset of this.modelAssets) {
            if (InstrumentType.isTaxableAccount(modelAsset.instrument)) {
                return modelAsset;
            }
        }
        return null; // Handle case where user is completely out of taxable funds
    }

    creditToFirstTaxableAccount(amount, note = '') {
        return this.applyToFirstMatchingAccount(InstrumentType.isTaxableAccount, 'credit', amount, note);
    }

    debitFromFirstTaxableAccount(amount, note = '') {
        return this.applyToFirstMatchingAccount(InstrumentType.isTaxableAccount, 'debit', amount, note);
    }

    applyYear(currentDateInt) {

        for (let modelAsset of this.modelAssets) {
            if (modelAsset.inMonth(currentDateInt)) {
                if (InstrumentType.isMonthlyIncome(modelAsset.instrument))
                    modelAsset.applyYearly();

                // Reassess property tax annually based on current home value
                if (InstrumentType.isHome(modelAsset.instrument) && modelAsset.annualTaxRate.rate !== 0) {
                    modelAsset.assessedAnnualPropertyTax = new Currency(
                        modelAsset.finishCurrency.amount * modelAsset.annualTaxRate.rate
                    );
                    modelAsset.monthlyPropertyTaxEscrow = new Currency(
                        modelAsset.assessedAnnualPropertyTax.amount / 12
                    );
                }
            }
        }

    }

    modelMetricsToDisplayData(monthsSpan, modelAsset) {
        modelAsset.buildAllDisplayHistories(monthsSpan);
    }

    buildChartingDisplayData() {
        // asset and cash flow data will be handled by charting
        // portfolio will coelsece cashflow data

        let monthsSpan = MonthsSpan.build(this.firstDateInt, this.lastDateInt);
        for (let modelAsset of this.modelAssets) {
            this.modelMetricsToDisplayData(monthsSpan, modelAsset);
        }

        this.assertions();

    }

    reportMonthly(currentDateInt) {

        if (this.reports) {

            logger.log(LogCategory.MONTHLY, ' -------  Begin Monthly (' + currentDateInt.toString() + ' ) Report -------');
            this.monthly.report(LogCategory.MONTHLY);
            logger.log(LogCategory.MONTHLY, ' -------   End Monthly (' + currentDateInt.toString() + ' ) Report  -------');

            // NEW: Push directly to internal array
            this.generatedReports.push({ 
                type: 'monthly', 
                dateLabel: currentDateInt.toString(), 
                pkg: new FinancialPackage().add(this.monthly) 
            });

        }

    }

    reportYearly(currentDateInt) {

        if (this.reports) {

            logger.log(LogCategory.YEARLY, ' -------  Begin Yearly (' + currentDateInt.toString() + ' ) Report -------');
            this.yearly.report(LogCategory.YEARLY);
            logger.log(LogCategory.YEARLY, ' -------   End Yearly  (' + currentDateInt.toString() + ' ) Report  -------');

            // NEW: Push directly to internal array
            this.generatedReports.push({ 
                type: 'yearly', 
                dateLabel: currentDateInt.toString(), 
                pkg: new FinancialPackage().add(this.yearly) 
            });

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
            logger.log(LogCategory.SANITY, 'assert summed monthly income == total income is TRUE');
        else
            logger.log(LogCategory.SANITY, 'assert summed monthly income == total income is FALSE');

        let assertion2 = this.sumDisplayData('displayCashFlow');
        if (assertion2.amount == this.total.ordinaryIncome.amount)
            logger.log(LogCategory.SANITY, 'assert summed monthly cash flows == total taxableIncome is TRUE');
        else
            logger.log(LogCategory.SANITY, 'assert summed monthly cash flows == total taxableIncome is FALSE');

    }

}