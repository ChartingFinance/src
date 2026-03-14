import { Currency } from './utils/currency.js';
import { InstrumentType } from './instruments/instrument.js';
import { MonthsSpan } from './utils/months-span.js';
import { logger, LogCategory } from './utils/logger.js';
import { User } from './user.js';
import { firstDateInt, lastDateInt } from './asset-queries.js';
import { global_user_startAge } from './globals.js';
import { FundTransfer } from './fund-transfer.js';
import { FinancialPackage } from './financial-package.js';
import { PayrollEngine } from './engines/payroll-engine.js';
import { ExpenseEngine } from './engines/expense-engine.js';
import { TaxEngine } from './engines/tax-engine.js';

export { FinancialPackage, FINANCIAL_FIELDS } from './financial-package.js';

export class Portfolio {
    constructor(modelAssets, reports) {
        this.modelAssets = this.sortModelAssets(modelAssets);
        this.reports = !!reports;
        this.generatedReports = [];
        this.activeUser = new User(global_user_startAge);

        // Guardrails (Guyton-Klinger) — set before chronometer_run to activate
        this.guardrailsParams = null; // { withdrawalRate, preservation, prosperity, adjustment }
        this.guardrailEvents = [];    // [{ year, type, rate, adjustedTo }]
        this.yearlySnapshots = [];    // [{ year, investableAssets, annualExpense, withdrawalRate }]

        // Deficit trigger — first month where expenses exceed income (signals withdrawal phase)
        this.deficitDateInt = null;

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

    zeroFundTransfersMonthlyMoveValues() {

        for (let modelAsset of this.modelAssets) {
            modelAsset.zeroFundTransfersMonthlyMoveValues();
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

        /*
        this.monthlyPropertyTaxes = [];
        this.monthlyIncomeTaxes = [];
        this.monthlyCapitalGainsTaxes = [];

        this.displayCapitalGainsTaxes = [];
        */

        for (let modelAsset of this.modelAssets) {
            modelAsset.initializeChron();
        }

        this.taxes = new TaxEngine(this.modelAssets, this.monthly, this.yearly, this.activeUser);
        this.payroll = new PayrollEngine(this.modelAssets, this.monthly, this.yearly, this.activeUser, this.taxes);
        this.expenses = new ExpenseEngine(this.modelAssets, this.monthly, this.activeUser);
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

        check('FICA', ficaMemos, this.monthly.fica().amount);
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

        //this.monthlyPropertyTaxes.push(this.monthly.propertyTaxes.toCurrency());
        //this.monthlyIncomeTaxes.push(this.monthly.incomeTax.toCurrency());
        //this.monthlyCapitalGainsTaxes.push(this.monthly.longTermCapitalGainsTax.toCurrency());

        this.computePerAssetCashFlow();

        // Detect first month where expenses exceed earned income (deficit trigger).
        // Uses earnedIncome (wages + SS/pension) — excludes distributions and capital
        // gains, which represent asset drawdown rather than independent income.
        if (!this.deficitDateInt) {
            const earned = this.monthly.earnedIncome().amount;
            const expense = Math.abs(this.monthly.expense.amount);
            if (expense > 0 && expense > earned) {
                this.deficitDateInt = currentDateInt.copy();
            }
        }

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

    getTotalInvestableAssets() {
        let total = new Currency(0);
        for (const a of this.modelAssets) {
            if ((InstrumentType.isExpensable(a.instrument) || InstrumentType.isIncomeAccount(a.instrument)) && !a.isClosed) {
                total.add(a.finishCurrency);
            }
        }
        return total;
    }

    applyGuardrails(currentDateInt) {
        if (!this.guardrailsParams) return;

        const investable = this.getTotalInvestableAssets().amount;
        if (investable <= 0) return;

        const annualExpense = Math.abs(this.yearly.expense.amount);
        const currentRate = annualExpense / investable;
        const initialRate = this.guardrailsParams.withdrawalRate / 100;
        const preservationThreshold = this.guardrailsParams.preservation / 100;
        const prosperityThreshold = this.guardrailsParams.prosperity / 100;
        const adjustmentPct = this.guardrailsParams.adjustment / 100;

        this.yearlySnapshots.push({
            year: currentDateInt.year - 1,
            investableAssets: investable,
            annualExpense,
            withdrawalRate: currentRate,
        });

        // Only apply guardrail adjustments after the deficit trigger
        const deficitDate = this.guardrailsParams.deficitDateInt;
        if (deficitDate && currentDateInt.toInt() < deficitDate.toInt()) return;

        const upperGuardrail = initialRate * (1 + preservationThreshold);
        const lowerGuardrail = initialRate * (1 - prosperityThreshold);

        if (currentRate > upperGuardrail) {
            // Preservation: cut expenses
            for (const a of this.modelAssets) {
                if (InstrumentType.isMonthlyExpense(a.instrument) && !a.isClosed) {
                    a.finishCurrency.multiply(1 - adjustmentPct);
                }
            }
            this.guardrailEvents.push({
                year: currentDateInt.year - 1,
                type: 'preservation',
                rate: currentRate,
                adjustedTo: currentRate * (1 - adjustmentPct),
            });
        } else if (currentRate < lowerGuardrail) {
            // Prosperity: raise expenses
            for (const a of this.modelAssets) {
                if (InstrumentType.isMonthlyExpense(a.instrument) && !a.isClosed) {
                    a.finishCurrency.multiply(1 + adjustmentPct);
                }
            }
            this.guardrailEvents.push({
                year: currentDateInt.year - 1,
                type: 'prosperity',
                rate: currentRate,
                adjustedTo: currentRate * (1 + adjustmentPct),
            });
        }
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
                this.taxes.applyPropertyTaxEscrow(modelAsset, currentDateInt);
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

        // Two-phase net income: compute household tax once, then allocate proportionally
        const { householdTax, totalWorkingIncome } = this.payroll.computeHouseholdIncomeTax();
        for (let modelAsset of this.modelAssets) {
            if (!modelAsset.isClosed) {
                this.payroll.applyNetIncome(modelAsset, householdTax, totalWorkingIncome);
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

        this.taxes.applyMonthlyTaxTrueUp();

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

            this.taxes.applyCapitalGainsTax(modelAsset);

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

                const target = FundTransfer.resolveExpensable(this.modelAssets);
                if (target) {
                    FundTransfer.system(modelAsset, target, extraAmount).execute({ skipGain: true });
                }
            }

        }
        else {

            logger.log(LogCategory.TRANSFER, 'Portfolio.applyAssetCloseFundTransfers: ' + modelAsset.displayName + ' funding ' + modelAssetValue.toString() + ' to first expensable account');

            const target = FundTransfer.resolveExpensable(this.modelAssets);
            if (target) {
                FundTransfer.system(modelAsset, target, modelAssetValue).execute({ skipGain: true });
            }

        }

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