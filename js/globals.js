// S&P 500 annual total returns (price + dividends), 2000–2025
// Source: https://www.slickcharts.com/sp500/returns
export const global_sp500_annual_returns = Object.freeze({
    1970: 4.01,
    1971: 14.31,
    1972: 18.98,
    1973: -14.66,
    1974: -26.47,
    1975: 37.20,
    1976: 23.84,
    1977: -7.18,
    1978: 6.56,
    1979: 18.44,
    1980: 32.42,
    1981: -4.91,
    1982: 21.55,
    1983: 22.56,
    1984: 6.27,
    1985: 31.73,
    1986: 18.67,
    1987: 5.25,
    1988: 16.61,
    1989: 31.69,
    1990: -3.10,
    1991: 30.47,
    1992: 7.62,
    1993: 10.08,
    1994: 1.32,
    1995: 37.58,
    1996: 22.96,
    1997: 33.36,
    1998: 28.58,
    1999: 21.04,
    2000: -9.10,
    2001: -11.89,
    2002: -22.10,
    2003: 28.68,
    2004: 10.88,
    2005: 4.91,
    2006: 15.79,
    2007: 5.49,
    2008: -37.00,
    2009: 26.46,
    2010: 15.06,
    2011: 2.11,
    2012: 16.00,
    2013: 32.39,
    2014: 13.69,
    2015: 1.38,
    2016: 11.96,
    2017: 21.83,
    2018: -4.38,
    2019: 31.49,
    2020: 18.40,
    2021: 28.71,
    2022: -18.11,
    2023: 26.29,
    2024: 25.02,
    2025: 17.88,
});

// 10-Year U.S. Treasury yield (annual average %), 2000–2025
// Source: https://www.multpl.com/10-year-treasury-rate/table/by-year
export const global_10yr_treasury_rates = Object.freeze({
    1970: 7.79,
    1971: 6.24,
    1972: 5.95,
    1973: 6.46,
    1974: 6.99,
    1975: 7.50,
    1976: 7.74,
    1977: 7.21,
    1978: 7.96,
    1979: 9.10,
    1980: 10.80,
    1981: 12.57,
    1982: 14.59,
    1983: 10.46,
    1984: 11.67,
    1985: 11.38,
    1986: 9.19,
    1987: 7.08,
    1988: 8.67,
    1989: 9.09,
    1990: 8.21,
    1991: 8.09,
    1992: 7.03,
    1993: 6.60,
    1994: 5.75,
    1995: 7.78,
    1996: 5.65,
    1997: 6.58,
    1998: 5.54,
    1999: 4.72,
    2000: 6.66,
    2001: 5.16,
    2002: 5.04,
    2003: 4.05,
    2004: 4.15,
    2005: 4.22,
    2006: 4.42,
    2007: 4.76,
    2008: 3.74,
    2009: 2.52,
    2010: 3.73,
    2011: 3.39,
    2012: 1.97,
    2013: 1.91,
    2014: 2.86,
    2015: 1.88,
    2016: 2.09,
    2017: 2.43,
    2018: 2.58,
    2019: 2.71,
    2020: 1.76,
    2021: 1.08,
    2022: 1.76,
    2023: 3.53,
    2024: 4.06,
    2025: 4.63,
});

// U.S. annual CPI inflation rate (%), 2000–2025
// Source: https://www.minneapolisfed.org/about-us/monetary-policy/inflation-calculator/consumer-price-index-1913-
export const global_cpi_annual_inflation = Object.freeze({
    1970: 5.8,
    1971: 4.3,
    1972: 3.3,
    1973: 6.2,
    1974: 11.1,
    1975: 9.1,
    1976: 5.7,
    1977: 6.5,
    1978: 7.6,
    1979: 11.3,
    1980: 13.5,
    1981: 10.3,
    1982: 6.1,
    1983: 3.2,
    1984: 4.3,
    1985: 3.5,
    1986: 1.9,
    1987: 3.7,
    1988: 4.1,
    1989: 4.8,
    1990: 5.4,
    1991: 4.2,
    1992: 3.0,
    1993: 3.0,
    1994: 2.6,
    1995: 2.8,
    1996: 2.9,
    1997: 2.3,
    1998: 1.6,
    1999: 2.2,
    2000: 3.4,
    2001: 2.8,
    2002: 1.6,
    2003: 2.3,
    2004: 2.7,
    2005: 3.4,
    2006: 3.2,
    2007: 2.9,
    2008: 3.8,
    2009: -0.4,
    2010: 1.6,
    2011: 3.2,
    2012: 2.1,
    2013: 1.5,
    2014: 1.6,
    2015: 0.1,
    2016: 1.3,
    2017: 2.1,
    2018: 2.4,
    2019: 1.8,
    2020: 1.2,
    2021: 4.7,
    2022: 8.0,
    2023: 4.1,
    2024: 2.9,
    2025: 2.6,
});

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

export let global_backtestYear = 'current';

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

export function global_setBacktestYear(value) {
    localStorage.setItem('backtestYear', value);
}

export function global_getBacktestYear() {
    let local = localStorage.getItem('backtestYear');
    if (local == null) local = 'current';
    global_backtestYear = local;
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
    global_getBacktestYear();
}
