import { Currency } from './utils/currency.js';
import { InstrumentType } from './instruments/instrument.js';
import { AssetAppreciationResult, MortgageResult, IncomeResult, RetirementIncomeResult, ExpenseResult, InterestResult } from './instruments/instrument-behavior.js';
import { WithholdingResult, ContributionKind } from './taxes.js';
import { taxableSocialSecurity } from './tax-basis.js';
import { logger, LogCategory } from './utils/logger.js';
import { SIM_CONFIG_DEFAULTS } from './sim-config.js';

export const FINANCIAL_FIELDS = [
    'employedIncome', 'selfIncome', 'socialSecurityTax', 'socialSecurityIncome', 'pensionIncome', 'assetAppreciation',
    'expense', 'medicareTax', 'incomeTax', 'estimatedTaxes',
    'tradIRAContribution', 'four01KContribution', 'rothIRAContribution',
    'tradIRADistribution', 'four01KDistribution', 'rothIRADistribution', 'rothConversion',
    'mortgageInterest', 'mortgagePrincipal', 'propertyTaxes',
    'shortTermCapitalGains', 'longTermCapitalGains', 'excludedCapitalGains',
    'nonQualifiedDividends', 'qualifiedDividends', "maintenance", "insurance",
    'interestIncome', 'longTermCapitalGainsTax', 'niit', 'taxTrueUp',
    'premiumTaxCredit', 'ptcReconciliation',
    'value',
];

/**
 * The tax fields, and which way each one is allowed to point.
 *
 * Taxes are stored negative (money out). This is a list, not just a
 * convention, so tests/tax-sign-convention.mjs can enforce it — including that
 * federalTaxes() sums exactly FEDERAL_TAX_FIELDS, so a new tax cannot be
 * collected and then left out of the total.
 */
export const FEDERAL_TAX_FIELDS = [
    'incomeTax', 'socialSecurityTax', 'medicareTax',
    'longTermCapitalGainsTax', 'estimatedTaxes', 'niit', 'taxTrueUp',
    'ptcReconciliation',
];

export const SALT_TAX_FIELDS = ['propertyTaxes'];

/**
 * Tax fields that may legitimately be POSITIVE.
 *
 * The two annual settlements: `taxTrueUp`, negative in a year with an April
 * bill and positive in a refund year, and `ptcReconciliation`, negative when
 * excess advance premium tax credit is repaid and positive when credit is still
 * owed. tests/tax-sign-convention.mjs checks that a fixture actually reaches
 * the positive case.
 */
export const BIDIRECTIONAL_TAX_FIELDS = ['taxTrueUp', 'ptcReconciliation'];

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

    /**
     * @param {User} activeUser
     * @param {TaxTable} taxTable  the run's table. Required: there is no fallback.
     */
    limitDeductions(activeUser, taxTable = null) {

        const table = taxTable;

        let maxIRADeduction = table.limitFor(ContributionKind.IRA, activeUser);
        if (this.tradIRAContribution.amount + this.rothIRAContribution.amount > maxIRADeduction.amount) {
            // TODO: figure out how to split this up between traditional and roth
            //this.iraContribution.amount = maxIRADeduction.amount;
        }

        let max401KDeduction = table.limitFor(ContributionKind.FOUR01K, activeUser);
        if (this.four01KContribution.amount > max401KDeduction.amount)
            this.four01KContribution.amount = max401KDeduction.amount;

        if (this.propertyTaxes.amount > table.propertyTaxDeductionMax)
            this.propertyTaxes.amount = table.propertyTaxDeductionMax;

    }

    /**
     * Social Security under IRC §86: the benefits, the "other income" they are
     * tested against, and the taxable part.
     *
     * `table` is required: §86's thresholds depend on filing status, and the
     * provisional-income test needs the deductible contribution as the engine
     * books it (`deductionComponents`).
     *
     * @returns {{benefits: number, otherIncome: number, taxable: number}}
     */
    socialSecurityTaxation(table) {
        if (!table?.activeSocialSecurityThresholds) {
            throw new Error('FinancialPackage.socialSecurityTaxation needs the TaxTable: '
                + '§86 thresholds depend on filing status.');
        }
        const benefits = this.socialSecurityIncome.amount;
        const { preTax } = table.deductionComponents(this);
        // AGI without the benefits: everything §86 counts as "other income".
        const otherIncome = this.ordinaryIncome().amount - benefits
            + this.longTermCapitalGains.amount
            + this.qualifiedDividends.amount
            - this.excludedCapitalGains.amount
            - preTax.amount;
        const taxable = taxableSocialSecurity(benefits, otherIncome,
            table.activeSocialSecurityThresholds);
        return { benefits, otherIncome, taxable };
    }

    /**
     * Gross income taxed at the ordinary rates: ordinary income with Social
     * Security replaced by its §86 taxable portion.
     *
     * Subtract-then-add keeps results bit-identical for households at the 85%
     * ceiling.
     *
     * @param {TaxTable} table
     * @param {{taxable: number}} [socialSecurity]  this package's
     *        socialSecurityTaxation(table), for a caller that already has it
     */
    irsTaxableGrossIncome(table, socialSecurity = this.socialSecurityTaxation(table)) {
        const { taxable } = socialSecurity;
        let irsIncome = this.ordinaryIncome().copy();
        irsIncome.subtract(this.socialSecurityIncome);
        irsIncome.add(new Currency(taxable));
        return irsIncome;
    }

    // ── Income rollups (aligned with Metric DAG) ─────────────────────

    /**
     * Every dollar that arrived, for reporting only. Not a tax base: it
     * includes tax-free Roth distributions and long-term gains, and no
     * deduction. Tax calculations use `taxableBasis()` (js/tax-basis.js).
     */
    totalIncome() {
        let income = this.ordinaryIncome().copy();
        income.add(this.capitalGain());
        income.add(this.taxFreeDistribution());
        income.add(this.qualifiedDividends);
        return income;
    }

    ordinaryIncome() {
        let income = this.wageIncome().copy();
        income.add(this.socialSecurityIncome);
        income.add(this.pensionIncome);
        income.add(this.interestIncome);
        income.add(this.shortTermCapitalGains);
        income.add(this.nonQualifiedDividends);
        income.add(this.taxableDistribution());
        return income;
    }

    wageIncome() {
        let income = this.employedIncome.copy();
        income.add(this.selfIncome);
        return income;
    }

    taxableDistribution() {
        let dist = this.tradIRADistribution.copy();
        dist.add(this.four01KDistribution);
        return dist;
    }

    capitalGain() {
        return this.longTermCapitalGains.copy();
    }

    taxFreeDistribution() {
        return this.rothIRADistribution.copy();
    }

    fica() {
        let total = this.medicareTax.copy();
        total.add(this.socialSecurityTax);
        return total;
    }

    /**
     * @param {TaxTable} [taxTable]  the run's table. Optional because the only
     *   callers without one are display and logging paths; they get the default
     *   cap.
     */
    deductiblePropertyTaxes(taxTable = null) {

        // Without a table (display and logging only; the engine always passes
        // one) the cap is SIM_CONFIG_DEFAULTS', which is also the only value the
        // app ever uses.
        const cap = taxTable?.propertyTaxDeductionMax
            ?? SIM_CONFIG_DEFAULTS.propertyTaxDeductionMax;
        let ptDeduction = this.propertyTaxes.copy().flipSign();
        if (ptDeduction.amount > cap)
            ptDeduction.amount = cap;
        return ptDeduction.flipSign();

    }

    preTaxContribution() {
        let c = this.four01KContribution.copy();
        c.add(this.tradIRAContribution);
        return c;
    }

    postTaxContribution() {
        return this.rothIRAContribution.copy();
    }

    contributions() {
        let c = this.preTaxContribution().copy();
        c.add(this.postTaxContribution());
        return c;
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
        // IRC §1411, which the per-asset FEDERAL_TAXES rollup also includes.
        taxes.add(this.niit);

        // The annual settlements: negative when collected, positive when
        // refunded, like every field above, so they can simply be summed.
        taxes.add(this.taxTrueUp);
        taxes.add(this.ptcReconciliation);
        return taxes;

    }

    saltTaxes() {

        let taxes = this.propertyTaxes.copy();
        return taxes;

    }

    totalTaxes() {

        let taxes = this.federalTaxes().copy();
        taxes.add(this.saltTaxes());
        return taxes;

    }

    cashOutFlow() {

        // Subtract liabilities and outflows (all stored as negative values)
        let e = this.totalTaxes();
        e.add(this.cashExpenses());
        return e;

    }

    /**
     * Expenses as cash flow counts them: living expenses, the whole mortgage
     * payment (principal as well as interest), maintenance and insurance.
     * Negative. The Expenses figure in Reports and in Month & Year Details.
     */
    cashExpenses() {

        let e = this.expense.copy();
        e.add(this.mortgagePrincipal);
        e.add(this.mortgageInterest);
        e.add(this.maintenance);
        e.add(this.insurance);

        // TODO: debt interest

        return e;

    }

    cashInFlow() {
        // Wage + SS + interest + dividends (excludes distributions — those are asset drawdown)
        let income = this.wageIncome().copy();
        income.add(this.socialSecurityIncome);
        income.add(this.pensionIncome);
        income.add(this.interestIncome);
        income.add(this.qualifiedDividends);
        income.add(this.nonQualifiedDividends);
        return income;
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
     * Record the tax consequence of a fund movement from the given source
     * instrument: the one place movements are classified for tax.
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

    /**
     * Record the part of a traditional IRA / 401(k) distribution that went
     * into a Roth: a Roth conversion (IRC §408A(d)(3)).
     *
     * `rothConversion` is an "of which" figure. The same dollars are already in
     * tradIRADistribution or four01KDistribution through recordTransfer, so it
     * is never income in its own right. It exists because the Roth contribution
     * limit measures MAGI without conversion income (§408A(c)(3)(B)).
     *
     * @param {string} sourceInstrument  account the money left
     * @param {string} targetInstrument  account the money entered
     * @param {Currency} amount          positive amount that arrived in the Roth
     */
    recordConversion(sourceInstrument, targetInstrument, amount) {
        const T = InstrumentType;
        if (!(amount.amount > 0)) return;
        if (T.isTaxDeferred(sourceInstrument) && T.isTaxFree(targetInstrument)) {
            this.rothConversion.add(amount);
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

        logger.log(category, () => 'income:                      ' + this.totalIncome().toString());
        logger.log(category, () => '  ordinaryIncome:            ' + this.ordinaryIncome().toString());
        logger.log(category, () => '    employedIncome:          ' + this.employedIncome.toString());
        logger.log(category, () => '    selfIncome:              ' + this.selfIncome.toString());
        logger.log(category, () => '    socialSecurity:          ' + this.socialSecurityIncome.toString());
        logger.log(category, () => '    pensionIncome:           ' + this.pensionIncome.toString());
        logger.log(category, () => '    interestIncome:          ' + this.interestIncome.toString());
        logger.log(category, () => '    shortTermCapitalGains:   ' + this.shortTermCapitalGains.toString());
        logger.log(category, () => '    nonQualifiedDividends:   ' + this.nonQualifiedDividends.toString());
        logger.log(category, () => '    taxableDistribution:     ' + this.taxableDistribution().toString());
        logger.log(category, () => '      iraDistribution:       ' + this.tradIRADistribution.toString());
        logger.log(category, () => '      401KDistribution:      ' + this.four01KDistribution.toString());
        logger.log(category, () => '  capitalGain:               ' + this.capitalGain().toString());
        logger.log(category, () => '  taxFreeDistribution:       ' + this.taxFreeDistribution().toString());
        logger.log(category, () => '    rothDistribution:        ' + this.rothIRADistribution.toString());
        logger.log(category, () => '  qualifiedDividends:        ' + this.qualifiedDividends.toString());
        logger.log(category, () => 'deductions:                  ' + this.deductions().toString());
        logger.log(category, () => '  iraContribution:           ' + this.tradIRAContribution.toString());
        logger.log(category, () => '  401KContribution:          ' + this.four01KContribution.toString());
        logger.log(category, () => '  mortgageInterest:          ' + this.mortgageInterest.toString());
        logger.log(category, () => '  propertyTaxes:             ' + this.deductiblePropertyTaxes().toString());
        logger.log(category, () => 'federal taxes:               ' + this.federalTaxes().toString());
        logger.log(category, () => '  fica:                      ' + this.fica().toString());
        logger.log(category, () => '  incomeTax:                 ' + this.incomeTax.toString());
        logger.log(category, () => '  longTermCapitalGainsTax:   ' + this.longTermCapitalGainsTax.toString());        
        logger.log(category, () => '  estimatedTaxes:            ' + this.estimatedTaxes.toString());
        logger.log(category, () => '  niit:                      ' + this.niit.toString());
        logger.log(category, () => '  taxTrueUp:                 ' + this.taxTrueUp.toString());
        logger.log(category, () => '  ptcReconciliation:         ' + this.ptcReconciliation.toString());
        logger.log(category, () => 'State/Local taxes:           ' + this.saltTaxes().toString());
        logger.log(category, () => '  propertyTaxes:             ' + this.propertyTaxes.toString());
        logger.log(category, () => 'contributions:               ' + this.contributions().toString());
        logger.log(category, () => '  preTaxContribution:        ' + this.preTaxContribution().toString());
        logger.log(category, () => '    401KContribution:        ' + this.four01KContribution.toString());
        logger.log(category, () => '    iraContribution:         ' + this.tradIRAContribution.toString());
        logger.log(category, () => '  postTaxContribution:       ' + this.postTaxContribution().toString());
        logger.log(category, () => '    rothContribution:        ' + this.rothIRAContribution.toString());
        logger.log(category, () => 'expenses:                    ' + this.expense.toString());
        logger.log(category, () => '  premiumTaxCredit (advance):' + this.premiumTaxCredit.toString());
        logger.log(category, () => 'assetAppreciation:           ' + this.assetAppreciation.toString());
        logger.log(category, () => 'mortgagePrincipal:           ' + this.mortgagePrincipal.toString());
        logger.log(category, () => 'cashInFlow:                  ' + this.cashInFlow().toString());
        logger.log(category, () => 'cashOutFlow:                 ' + this.cashOutFlow().toString());
        logger.log(category, () => 'cashFlow:                    ' + this.cashFlow().toString());
        logger.log(category, () => 'effectTaxRate:               ' + this.effectiveTaxRate().toFixed(2));
    
    }

    reportHTML(currentDateInt) {

        let html = '<div>';
        html += ('<h3>' + currentDateInt.toString() + '</h3>');
        html += "<ul>";
        html += '<li>income:                      ' + this.totalIncome().toString() + '<ul>';
        html += '  <li>ordinaryIncome:            ' + this.ordinaryIncome().toString() + '<ul>';
        html += '    <li>employedIncome:          ' + this.employedIncome.toString() + '</li>';
        html += '    <li>selfIncome:              ' + this.selfIncome.toString() + '</li>';
        html += '    <li>socialSecurity:          ' + this.socialSecurityIncome.toString() + '</li>';
        html += '    <li>pensionIncome:           ' + this.pensionIncome.toString() + '</li>';
        html += '    <li>interestIncome:          ' + this.interestIncome.toString() + '</li>';
        html += '    <li>shortTermCapitalGains:   ' + this.shortTermCapitalGains.toString() + '</li>';
        html += '    <li>nonQualifiedDividends:   ' + this.nonQualifiedDividends.toString() + '</li>';
        html += '    <li>taxableDistribution:     ' + this.taxableDistribution().toString() + '<ul>';
        html += '      <li>iraDistribution:       ' + this.tradIRADistribution.toString() + '</li>';
        html += '      <li>401KDistribution:      ' + this.four01KDistribution.toString() + '</li></ul></ul>';
        html += '  <li>capitalGain:               ' + this.capitalGain().toString() + '</li>';
        html += '  <li>taxFreeDistribution:       ' + this.taxFreeDistribution().toString() + '<ul>';
        html += '    <li>rothDistribution:        ' + this.rothIRADistribution.toString() + '</li></ul>';
        html += '  <li>qualifiedDividends:        ' + this.qualifiedDividends.toString() + '</li></ul>';
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
        html += '  <li>preTaxContribution:        ' + this.preTaxContribution().toString() + '<ul>';
        html += '    <li>401KContribution:        ' + this.four01KContribution.toString() + '</li>';
        html += '    <li>iraContribution:         ' + this.tradIRAContribution.toString() + '</li></ul>';
        html += '  <li>postTaxContribution:       ' + this.postTaxContribution().toString() + '<ul>';
        html += '    <li>rothContribution:        ' + this.rothIRAContribution.toString() + '</li></ul>';
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
        else if (result instanceof MortgageResult)
            this.addMortgageResult(result);
        else if (result instanceof IncomeResult)
            this.addIncomeResult(result);
        else if (result instanceof RetirementIncomeResult)
            this.addRetirementIncomeResult(result);
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

    addMortgageResult(mortgageResult) {
        this.mortgageInterest.add(mortgageResult.interest);
        this.mortgagePrincipal.add(mortgageResult.principal);
        // Principal paydown is growth — mortgage balance shrank, net worth increased
        this.assetAppreciation.add(mortgageResult.principal.copy().flipSign());
    }

    addIncomeResult(incomeResult) {
        this.selfIncome.add(incomeResult.selfIncome);
        this.employedIncome.add(incomeResult.employedIncome);
    }

    addRetirementIncomeResult(retirementIncomeResult) {
        this.socialSecurityIncome.add(retirementIncomeResult.socialSecurityIncome);
        this.pensionIncome.add(retirementIncomeResult.pensionIncome);
    }

    /**
     * `expense` is what the household paid. For a marketplace premium that is
     * net of the advance credit, and `premiumTaxCredit` records the advance:
     * an "of which" figure, like rothConversion, never added to expenses again.
     */
    addExpenseResult(expenseResult) {
        this.expense.add(expenseResult.expense);
        this.premiumTaxCredit.add(expenseResult.premiumTaxCredit);
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
