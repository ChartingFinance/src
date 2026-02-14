export const global_default_inflationRate = 0.031;

export const global_default_taxYear = 2025;

export const global_default_filingAs = 'Single';

export const global_default_propertyTaxRate = 0.01;

export const global_default_propertyTaxDeductionMax = 40000.0;

export const global_default_user_startAge = 57;
export const gobal_default_user_retirementAge = 67;
export const global_default_user_finishAge = 85;

export const global_default_fica = 7.65;

export let global_inflationRate = global_default_inflationRate;

export let global_taxYear = global_default_taxYear;

export let global_filingAs = global_default_filingAs;

export let global_propertyTaxRate = global_default_propertyTaxRate;

export let global_propertyTaxDeductionMax = global_default_propertyTaxDeductionMax;

export let global_user_startAge = global_default_user_startAge;
export let global_user_retirementAge = gobal_default_user_retirementAge;
export let global_user_finishAge = global_default_user_finishAge;

export let global_equity_dividend_allocation = 0.5;
export let global_equity_growth_allocation = 0.5;

export let global_equity_dividend_average_annual_rate = 0.025;
export let global_equity_dividend_qualified = 1.0;

export let global_home_sale_capital_gains_discount = 250000;

export let activeTaxTable = null;
export function setActiveTaxTable(t) { activeTaxTable = t; }

export function global_reset() {
    global_inflationRate = global_default_inflationRate;
    global_taxYear = global_default_taxYear;
    global_filingAs = global_default_filingAs;
    global_propertyTaxRate = global_default_propertyTaxRate;
    global_propertyTaxDeductionMax = global_default_propertyTaxDeductionMax;
    global_user_startAge = global_default_user_startAge;
    global_user_retirementAge = gobal_default_user_retirementAge;
    global_user_finishAge = global_default_user_finishAge;

    global_setInflationRate(global_inflationRate);
    global_setTaxYear(global_taxYear);
    global_setFilingAs(global_filingAs);
    global_setPropertyTaxRate(global_propertyTaxRate);
    global_setPropertyTaxDeductionMax(global_propertyTaxDeductionMax);
    global_setUserStartAge(global_user_startAge);
    global_setUserRetirementAge(global_user_retirementAge);
    global_setUserFinishAge(global_user_finishAge);
}

export function global_divBy100(strValue) {
    let asFloat = parseFloat(strValue);
    asFloat /= 100.0;
    return asFloat;
}

export function global_multBy100(value) {
    return value * 100.0;
}

export function global_setInflationRate(value) {
    localStorage.setItem('inflationRate', value.toFixed(4));
}

export function global_getInflationRate() {
    let localIR = localStorage.getItem('inflationRate');
    if (localIR == null)
        localIR = global_inflationRate.toFixed(4);

    global_inflationRate = parseFloat(localIR);
}

export function global_setTaxYear(value) {
    localStorage.setItem('taxYear', value.toString());
}

export function global_getTaxYear() {
    let localTY = localStorage.getItem('taxYear');
    if (localTY == null)
        localTY = global_taxYear.toString();

    global_taxYear = parseInt(localTY);
}

export function global_setFilingAs(value) {
    localStorage.setItem('filingAs', value);
}

export function global_getFilingAs() {
    let localFA = localStorage.getItem('filingAs');
    if (localFA == null)
        localFA = global_filingAs;

    global_filingAs = localFA;
}

export function global_setPropertyTaxRate(value) {
    localStorage.setItem('propertyTaxRate', value.toFixed(4));
}

export function global_getPropertyTaxRate(value) {
    let localPTR = localStorage.getItem('propertyTaxRate');
    if (localPTR == null)
        localPTR = global_propertyTaxRate.toFixed(4);

    global_propertyTaxRate = parseFloat(localPTR);
}

export function global_setPropertyTaxDeductionMax(value) {
    localStorage.setItem('propertyTaxDeductionMax', value.toFixed(2));
}

export function global_getPropertyTaxDeductionMax() {
    let localPTDM = localStorage.getItem('propertyTaxDeductionMax');
    if (localPTDM == null)
        localPTDM = global_propertyTaxDeductionMax.toFixed(2);

    global_propertyTaxDeductionMax = parseFloat(localPTDM);
}

export function global_setUserStartAge(value) {
    localStorage.setItem('userStartAge', value.toString());
}

export function global_getUserStartAge() {
    let localUA = localStorage.getItem('userStartAge');
    if (localUA == null)
        localUA = global_user_startAge.toString();

    global_user_startAge = parseInt(localUA);
}

export function global_setUserRetirementAge(value) {
    localStorage.setItem('userRetirementAge', value.toString());
}

export function global_getUserRetirementAge() {
    let localUA = localStorage.getItem('userRetirementAge');
    if (localUA == null)
        localUA = global_user_retirementAge.toString();

    global_user_retirementAge = parseInt(localUA);
}

export function global_setUserFinishAge(value) {
    localStorage.setItem('userFinishAge', value.toString());
}

export function global_getUserFinishAge() {
    let localUA = localStorage.getItem('userFinishAge');
    if (localUA == null)
        localUA = global_user_finishAge.toString();

    global_user_finishAge = parseInt(localUA);
}

export function global_initialize() {
    global_getInflationRate();
    global_getTaxYear();
    global_getFilingAs();
    global_getPropertyTaxRate();
    global_getPropertyTaxDeductionMax();
    global_getUserStartAge();
    global_getUserRetirementAge();
    global_getUserFinishAge();
}
