import { Currency } from './utils/currency.js';
import { InstrumentType } from './instruments/instrument.js';
import { Metric } from './model-asset.js';
import { AssetAppreciationResult, CapitalGainsResult, MortgageResult, IncomeResult, ExpenseResult, InterestResult, WithholdingResult, CreditMemo } from './results.js';
import { MonthsSpan } from './utils/months-span.js';
import { logger, LogCategory } from './utils/logger.js';
import { User } from './user.js';
import { firstDateInt, lastDateInt } from './asset-queries.js';
import { activeTaxTable } from './globals.js';
import { global_propertyTaxDeductionMax, global_user_startAge } from './globals.js';
import { AccountRouter } from './engines/account-router.js';
import { PayrollEngine } from './engines/payroll-engine.js';
import { ExpenseEngine } from './engines/expense-engine.js';

/*
yearlyGrossIncome

yearlyDeductions

yearlyCapitalGains

yearlyWithheldTaxes (This is the sum of all the monthly estimates your engine currently calculates).
*/

export const FINANCIAL_FIELDS = [
    'employedIncome', 'selfIncome', 'socialSecurity', 'assetAppreciation',
    'expense', 'fica', 'incomeTax', 'estimatedTaxes',
    'preTaxContribution', 'postTaxContribution',
    'tradIRAContribution', 'four01KContribution', 'rothIRAContribution',
    'tradIRADistribution', 'four01KDistribution', 'rothIRADistribution',
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

    totalTaxes() {

        let taxes = this.incomeTax.copy();
        taxes.add(this.fica);
        taxes.add(this.longTermCapitalGainsTax);
        //taxes.add(this.propertyTaxes);
        taxes.add(this.estimatedTaxes);
        return taxes;

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

    report(category = LogCategory.GENERAL) {

        logger.log(category, 'income:                      ' + this.totalIncome().toString());
        logger.log(category, '  employedIncome:            ' + this.employedIncome.toString());
        logger.log(category, '  selfIncome:                ' + this.selfIncome.toString());
        logger.log(category, '  ordinaryIncome:            ' + this.ordinaryIncome().toString());
        logger.log(category, '    socialSecurity (taxed):  ' + this.socialSecurity.toString());
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
        logger.log(category, 'taxes:                       ' + this.totalTaxes().toString());
        logger.log(category, '  fica:                      ' + this.fica.toString());
        logger.log(category, '  incomeTax:                 ' + this.incomeTax.toString());
        logger.log(category, '  longTermCapitalGainsTax:   ' + this.longTermCapitalGainsTax.toString());
        logger.log(category, '  propertyTaxes:             ' + this.propertyTaxes.toString());
        logger.log(category, '  estimatedTaxes:            ' + this.estimatedTaxes.toString());
        logger.log(category, 'contributions:               ' + this.contributions().toString());
        logger.log(category, '  401KContribution:          ' + this.four01KContribution.toString());
        logger.log(category, '  iraContribution:           ' + this.tradIRAContribution.toString());
        logger.log(category, '  rothContribution:          ' + this.rothIRAContribution.toString());
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
        html += '<li>taxes:                       ' + this.totalTaxes().toString() + '<ul>';
        html += '  <li>fica:                      ' + this.fica.toString() + '</li>';
        html += '  <li>incomeTax:                 ' + this.incomeTax.toString() + '</li>';
        html += '  <li>longTermCapitalGainsTax:   ' + this.longTermCapitalGainsTax.toString() + '</li>';
        html += '  <li>propertyTaxes:             ' + this.propertyTaxes.toString() + '</li>';
        html += '  <li>estimatedTaxes:            ' + this.estimatedTaxes.toString() + '</li></ul>';
        html += '<li>contributions:               ' + this.contributions().toString() + '<ul>';
        html += '  <li>401KContribution:          ' + this.four01KContribution.toString() + '</li>';    
        html += '  <li>iraContribution:           ' + this.tradIRAContribution.toString() + '</li>';    
        html += '  <li>rothContribution:            ' + this.rothIRAContribution.toString() + '</li>';
        html += '<li>assetAppreciation:           ' + this.assetAppreciation.toString() + '</li>';
        html += '<li>mortgagePrincipal:           ' + this.mortgagePrincipal.toString() + '</li>';        
        html += '<li>cashFlow:                    ' + this.cashFlow().toString() + '</li>';
        html += '<li>effectiveTaxRate:            ' + this.effectiveTaxRate().toFixed(2) + '</li>';
        html += '<li>expenses:                    ' + this.expense.toString() + '</li>'; 
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

        this.router = new AccountRouter(this.modelAssets);
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

        this.payroll = new PayrollEngine(this.modelAssets, this.monthly, this.yearly, this.activeUser, this.router);
        this.expenses = new ExpenseEngine(this.modelAssets, this.monthly, this.activeUser, this.router);
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
            modelAsset.cashFlowCurrency = modelAsset.behavior.computeCashFlow(modelAsset);
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

            for (let modelAsset of this.modelAssets) {
                if (!modelAsset.inMonth(currentDateInt)) continue;
                if (InstrumentType.isRealEstate(modelAsset.instrument)) {
                    this.expenses.applyPropertyTaxEscrow(modelAsset, currentDateInt);
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

            if (!modelAsset.isClosed) {
                modelAsset.applyFirstDayOfMonth(currentDateInt);
            }

        }
        
        // TODO: You can either make contributions or take distributions. Not both.

        // Day 1 payroll pipeline
        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                this.payroll.applyPreTaxCalculations(modelAsset, currentDateInt);
            }
        }

        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                this.payroll.applyPreTaxTransfers(modelAsset);
            }
        }

        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                this.payroll.calculateRMDs(currentDateInt, modelAsset);
            }
        }

        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                this.payroll.computeNetIncome(modelAsset);
            }
        }

        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                if (InstrumentType.isWorkingIncome(modelAsset.instrument)) {
                    this.payroll.calculateRothIRAContribution(modelAsset);
                }
                this.payroll.calculatePostTaxContributions(modelAsset);
            }
        }

        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                this.payroll.applyPostTaxTransfers(modelAsset);
            }
        }

    }

    applyLastDayOfMonth(currentDateInt) {

        // apply expenses
        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                this.expenses.applyExpenseTransfers(modelAsset, currentDateInt);
            }
        }

        // ensure RMDs are handled
        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                this.expenses.ensureRMDs(modelAsset);
            }
        }

        // recognize asset gains
        // Doing this after applying expenses is pessimistic
        // Maybe an optimistic option to do this prior to expenses?
        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                this.expenses.applyAssetGrowth(modelAsset);
            }
        }

        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                modelAsset.applyLastDayOfMonth(currentDateInt);
            }
        }

        this.applyMonthlyTaxes();

    }

    handleCapitalGains(modelAsset) {
        if (InstrumentType.isTaxFree(modelAsset.instrument)) return;

        const capitalGains = new Currency(modelAsset.finishCurrency.amount - modelAsset.finishBasisCurrency.amount);
        logger.log(LogCategory.TAX, 'capital gains of ' + capitalGains.toString());

        const monthsSpan = MonthsSpan.build(modelAsset.startDateInt, modelAsset.finishDateInt);
        const annualizedIncome = this.monthly.totalIncome().copy().multiply(12);
        const isRealEstate = InstrumentType.isRealEstate(modelAsset.instrument);
        const isPrimaryHome = isRealEstate && modelAsset.isPrimaryHome;

        const result = activeTaxTable.calculateCapitalGainsTax(
            capitalGains, monthsSpan.totalMonths, isPrimaryHome, annualizedIncome
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
                if (!fundTransfer.toModel) continue;

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
                this.router.creditToExpensable(extraAmount, note);
            }

        }
        else {

            logger.log(LogCategory.TRANSFER, 'Portfolio.applyAssetCloseFundTransfers: ' + modelAsset.displayName + ' funding ' + modelAssetValue.toString() + ' to first expensable account');

            const note = `Asset closure proceeds from ${modelAsset.displayName}`;
            modelAsset.debit(modelAssetValue, note, true); // true = skipGain (already handled)
            this.router.creditToExpensable(modelAssetValue, note);

        }

    }

    applyMonthlyTaxes() {

        // Compute total tax liability across ALL income (salary + capital gains + dividends + interest)
        let yearly = this.monthly.copy().multiply(12.0);
        yearly.limitDeductions(this.activeUser);
        let yearlyIncome = activeTaxTable.calculateYearlyTaxableIncome(yearly);
        let totalIncomeTax = activeTaxTable.calculateYearlyIncomeTax(yearlyIncome).divide(12.0).flipSign();

        // What was already withheld from payroll on Day 1? (negative value)
        const alreadyWithheld = this.monthly.incomeTax.copy();

        // Additional estimated tax = total liability - already withheld
        // Both values are negative, so if total is more negative, additionalTax is negative (owe more)
        const additionalTax = new Currency(totalIncomeTax.amount - alreadyWithheld.amount);

        if (additionalTax.amount < 0) {
            // Additional tax owed beyond payroll withholding (e.g., from capital gains, dividends)
            this.monthly.incomeTax.add(additionalTax);

            const incomeAsset = this.modelAssets.find(a => InstrumentType.isMonthlyIncome(a.instrument) && !a.isClosed);
            if (incomeAsset) {
                incomeAsset.creditMemos.push(new CreditMemo(additionalTax.copy(), 'Income tax withholding', incomeAsset.currentDateInt));
            }
        }

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
            this.router.debitFromExpensable(taxBill, 'Annual IRS Tax Bill Due'); 
            
        } else if (taxDifference < 0) {
            // OVERPAID: The user gets a tax refund!
            // This is a positive cash flow event.
            const refundAmount = Math.abs(taxDifference);
            logger.log(LogCategory.TAX, `Annual True-Up: User overpaid. Refunding ${refundAmount}.`);
            const taxRefund = new Currency(refundAmount);
            
            this.router.creditToExpensable(taxRefund, 'IRS Tax Refund');
        }

        // 3. Reset the annual accumulators for the next year
        this.resetAnnualAccumulators();
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

    }

}