import { Currency } from './utils/currency.js';
import { InstrumentType } from './instruments/instrument.js';
import { AssetAppreciationResult, CapitalGainsResult, MortgageResult, IncomeResult, ExpenseResult, InterestResult, WithholdingResult } from './results.js';
import { logger, LogCategory } from './utils/logger.js';
import { activeTaxTable } from './globals.js';
import { global_propertyTaxDeductionMax } from './globals.js';

export const FINANCIAL_FIELDS = [
    'employedIncome', 'selfIncome', 'socialSecurityTax', 'socialSecurityIncome', 'assetAppreciation',
    'expense', 'medicareTax', 'incomeTax', 'estimatedTaxes', 'contribution',
    'preTaxContribution', 'postTaxContribution',
    'tradIRAContribution', 'four01KContribution', 'rothIRAContribution',
    'taxFreeDistribution', 'taxableDistribution',
    'tradIRADistribution', 'four01KDistribution', 'rothIRADistribution',
    'mortgageInterest', 'mortgagePrincipal', 'propertyTaxes',
    'shortTermCapitalGains', 'longTermCapitalGains',
    'nonQualifiedDividends', 'qualifiedDividends', "maintenance", "insurance",
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
        if (this.tradIRAContribution.amount + this.rothIRAContribution.amount > maxIRADeduction.amount) {
            // TODO: figure out how to split this up between traditional and roth
            //this.iraContribution.amount = maxIRADeduction.amount;
        }

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
        income.add(this.socialSecurityIncome); // Note: raw SS, not the 85% taxed portion
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
        income.add(this.longTermCapitalGains);
        return income;

    }

    wageIncome() {

        let income = this.employedIncome.copy();
        income.add(this.selfIncome);
        return income;

    }

    /** Earned/passive income only — wages + social security/pension.
     *  Excludes distributions, capital gains, dividends (those are asset drawdown). */
    earnedIncome() {
        let income = this.wageIncome().copy();
        income.add(this.socialSecurityIncome);
        return income;
    }

    fica() {

        let total = this.medicareTax.copy();
        total.add(this.socialSecurityTax);
        return total;

    }

    ordinaryIncome() {

        let income = this.socialSecurityIncome.copy().multiply(0.85); // maximum allowed for social security
        income.add(this.interestIncome);
        income.add(this.shortTermCapitalGains);
        income.add(this.tradIRADistribution);
        income.add(this.four01KDistribution);
        income.add(this.nonQualifiedDividends);
        return income;

    }

    nontaxableIncome() {

        let income = this.rothIRADistribution.copy();
        income.add(this.qualifiedDividends);
        return income;

    }

    deductiblePropertyTaxes() {

        let ptDeduction = this.propertyTaxes.copy().flipSign();
        if (ptDeduction.amount > global_propertyTaxDeductionMax)
            ptDeduction.amount = global_propertyTaxDeductionMax;
        return ptDeduction.flipSign();

    }

    contributions() {

        let contributions = this.tradIRAContribution.copy();
        contributions.add(this.four01KContribution);
        contributions.add(this.rothIRAContribution);
        return contributions;

    }

    deductions() {

        let d = this.tradIRAContribution.copy().flipSign();
        d.subtract(this.four01KContribution);
        d.add(this.mortgageInterest);
        d.add(this.deductiblePropertyTaxes());
        return d;

    }

    totalDebtPaydown() {

        let pd = this.mortgagePrincipal.copy();
        return pd;
        
    }

    federalTaxes() {

        let taxes = this.incomeTax.copy();
        taxes.add(this.fica());
        taxes.add(this.longTermCapitalGainsTax);
        taxes.add(this.estimatedTaxes);
        return taxes;

    }

    localTaxes() {

        let taxes = this.propertyTaxes.copy();
        return taxes;

    }

    totalTaxes() {

        let taxes = this.federalTaxes().copy();
        taxes.add(this.localTaxes());
        return taxes;

    }

    cashOutFlow() {

        // Subtract liabilities and outflows (all stored as negative values)
        let e = this.totalTaxes();
        e.add(this.expense);
        e.add(this.mortgagePrincipal);
        e.add(this.mortgageInterest);

        // TODO: debt interest

        return e;

    }

    cashInFlow() {

        return this.trueGrossIncome().copy();

    }

    cashFlow() {

        return new Currency(this.cashInFlow().amount + this.cashOutFlow().amount);
        
    }

    growth() {

        return this.assetAppreciation.copy();

    }

    wealth() {

        return new Currency(this.growth().amount + this.cashFlow().amount);

    }

    effectiveTaxRate() {

        let income = this.totalIncome();
        let taxes = this.totalTaxes().flipSign();
        let ratio = taxes.amount / income.amount;
        return ratio;

    }

    /**
     * Record the tax consequence of a fund movement from the given source instrument.
     * Centralizes the classification that was previously scattered across engines.
     *
     * @param {string} sourceInstrument - instrument key of the account being debited
     * @param {Currency} amount - positive withdrawal amount
     * @param {Currency} realizedGain - capital gain from proportional basis (taxable accounts only)
     */
    recordTransfer(sourceInstrument, amount, realizedGain) {
        const T = InstrumentType;
        if (amount.amount === 0) return;

        if (T.isTaxableAccount(sourceInstrument)) {
            this.longTermCapitalGains.add(realizedGain);
        } else if (T.isTaxDeferred(sourceInstrument)) {
            if (T.isIRA(sourceInstrument)) {
                this.tradIRADistribution.add(amount);
            } else if (T.is401K(sourceInstrument)) {
                this.four01KDistribution.add(amount);
            }
        } else if (T.isTaxFree(sourceInstrument)) {
            this.rothIRADistribution.add(amount);
        }
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

    report(category = LogCategory.GENERAL) {

        logger.log(category, 'income:                      ' + this.totalIncome().toString());
        logger.log(category, '  employedIncome:            ' + this.employedIncome.toString());
        logger.log(category, '  selfIncome:                ' + this.selfIncome.toString());
        logger.log(category, '  ordinaryIncome:            ' + this.ordinaryIncome().toString());
        logger.log(category, '    socialSecurity (taxed):  ' + this.socialSecurityIncome.toString());
        logger.log(category, '    iraDistribution:         ' + this.tradIRADistribution.toString());
        logger.log(category, '    401KDistribution:        ' + this.four01KDistribution.toString());
        logger.log(category, '    shortTermCapitalGains:   ' + this.shortTermCapitalGains.toString());
        logger.log(category, '    interestIncome:          ' + this.interestIncome.toString());
        logger.log(category, '    nonQualifiedDividends:   ' + this.nonQualifiedDividends.toString());
        logger.log(category, '  longTermCapitalGains:      ' + this.longTermCapitalGains.toString());
        logger.log(category, '  nonTaxableIncome:          ' + this.nontaxableIncome().toString());
        logger.log(category, '    qualifiedDividends       ' + this.qualifiedDividends.toString());
        logger.log(category, '    rothDistribution:        ' + this.rothIRADistribution.toString());
        logger.log(category, 'deductions:                  ' + this.deductions().toString());
        logger.log(category, '  iraContribution:           ' + this.tradIRAContribution.toString());
        logger.log(category, '  401KContribution:          ' + this.four01KContribution.toString());
        logger.log(category, '  mortgageInterest:          ' + this.mortgageInterest.toString());
        logger.log(category, '  propertyTaxes:             ' + this.deductiblePropertyTaxes().toString());
        logger.log(category, 'federal taxes:               ' + this.federalTaxes().toString());
        logger.log(category, '  fica:                      ' + this.fica().toString());
        logger.log(category, '  incomeTax:                 ' + this.incomeTax.toString());
        logger.log(category, '  longTermCapitalGainsTax:   ' + this.longTermCapitalGainsTax.toString());        
        logger.log(category, '  estimatedTaxes:            ' + this.estimatedTaxes.toString());
        logger.log(category, 'local taxes:                 ' + this.localTaxes().toString());
        logger.log(category, '  propertyTaxes:             ' + this.propertyTaxes.toString());
        logger.log(category, 'contributions:               ' + this.contributions().toString());
        logger.log(category, '  401KContribution:          ' + this.four01KContribution.toString());
        logger.log(category, '  iraContribution:           ' + this.tradIRAContribution.toString());
        logger.log(category, '  rothContribution:          ' + this.rothIRAContribution.toString());
        logger.log(category, 'expenses:                    ' + this.expense.toString());
        logger.log(category, 'assetAppreciation:           ' + this.assetAppreciation.toString());
        logger.log(category, 'mortgagePrincipal:           ' + this.mortgagePrincipal.toString());
        logger.log(category, 'cashInFlow:                  ' + this.cashInFlow().toString());
        logger.log(category, 'cashOutFlow:                 ' + this.cashOutFlow().toString());
        logger.log(category, 'cashFlow:                    ' + this.cashFlow().toString());
        logger.log(category, 'effectTaxRate:               ' + this.effectiveTaxRate().toFixed(2));
    
    }

    reportHTML(currentDateInt) {

        let html = '<div>';
        html += ('<h3>' + currentDateInt.toString() + '</h3>');
        html += "<ul>";
        html += '<li>income:                      ' + this.totalIncome().toString() + '<ul>';
        html += '  <li>employedIncome:            ' + this.employedIncome.toString() + '</li>';
        html += '  <li>selfIncome:                ' + this.selfIncome.toString() + '</li>';
        html += '  <li>ordinaryIncome:            ' + this.ordinaryIncome().toString() + '<ul>';
        html += '    <li>socialSecurity:          ' + this.socialSecurityIncome.toString() + '</li>';
        html += '    <li>iraDistribution:         ' + this.tradIRADistribution.toString() + '</li>';
        html += '    <li>401KDistribution:        ' + this.four01KDistribution.toString() + '</li>';
        html += '    <li>shortTermCapitalGains:   ' + this.shortTermCapitalGains.toString() + '</li>';
        html += '    <li>interestIncome:          ' + this.interestIncome.toString() + '</li>';
        html += '    <li>nonQualifiedDividends:   ' + this.nonQualifiedDividends.toString() + '</li></ul>';
        html += '  <li>longTermCapitalGains:      ' + this.longTermCapitalGains.toString() + '</li>';
        html += '  <li>nonTaxableIncome:          ' + this.nontaxableIncome().toString() + '<ul>';
        html += '    <li>qualifiedDividends       ' + this.qualifiedDividends.toString() + '</li>';
        html += '    <li>rothDistribution:        ' + this.rothIRADistribution.toString() + '</li></ul></ul>';
        html += '<li>deductions:                  ' + this.deductions().toString() + '<ul>';
        html += '  <li>iraContribution:           ' + this.tradIRAContribution.toString() + '</li>';
        html += '  <li>401KContribution:          ' + this.four01KContribution.toString() + '</li>';
        html += '  <li>mortgageInterest:          ' + this.mortgageInterest.toString() + '</li>';
        html += '  <li>propertyTaxes:             ' + this.deductiblePropertyTaxes().toString() + '</li></ul>';
        html += '<li>federal taxes:               ' + this.federalTaxes().toString() + '<ul>';
        html += '  <li>fica:                      ' + this.fica().toString() + '</li>';
        html += '  <li>incomeTax:                 ' + this.incomeTax.toString() + '</li>';
        html += '  <li>longTermCapitalGainsTax:   ' + this.longTermCapitalGainsTax.toString() + '</li>';
        html += '  <li>estimatedTaxes:            ' + this.estimatedTaxes.toString() + '</li></ul>';
        html += '<li>local taxes:                 ' + this.localTaxes().toString() + '</li><ul>';
        html += '  <li>property taxes             ' + this.propertyTaxes.toString() + '</li></ul>';
        html += '<li>contributions:               ' + this.contributions().toString() + '<ul>';
        html += '  <li>401KContribution:          ' + this.four01KContribution.toString() + '</li>';
        html += '  <li>iraContribution:           ' + this.tradIRAContribution.toString() + '</li>';
        html += '  <li>rothContribution:          ' + this.rothIRAContribution.toString() + '</li>';
        html += '<li>assetAppreciation:           ' + this.assetAppreciation.toString() + '</li>';
        html += '<li>cashFlow:                    ' + this.cashFlow().toString() + '<ul>';
        html += '  <li>inFlow:                    ' + this.cashInFlow().toString() + '</li>';
        html += '  <li>outFlow:                   ' + this.cashOutFlow().toString() + '</li></ul>'; 
        html += '<li>effectiveTaxRate:            ' + this.effectiveTaxRate().toFixed(2) + '</li>';
        html += '</ul>';
        html += '</div>';

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
        this.qualifiedDividends.add(assetAppreciationResult.qualifiedDividend);
        this.nonQualifiedDividends.add(assetAppreciationResult.nonQualifiedDividend);
        this.propertyTaxes.add(assetAppreciationResult.tax);
    }

    addCapitalGainsResult(capitalGainsResult) {
        this.shortTermCapitalGains.add(capitalGainsResult.shortTerm);
        this.longTermCapitalGains.add(capitalGainsResult.longTerm);
    }

    addMortgageResult(mortgageResult) {
        this.mortgageInterest.add(mortgageResult.interest);
        this.mortgagePrincipal.add(mortgageResult.principal);
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
        this.medicareTax.add(withholdingResult.medicareTax);
        this.socialSecurityTax.add(withholdingResult.socialSecurityTax);
        this.incomeTax.add(withholdingResult.income);
    }
}
