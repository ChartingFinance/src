import { DateInt } from './utils/date-int.js';
// logger.js imports nothing, so this cannot cycle back through globals.
import { logger, LogCategory } from './utils/logger.js';

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

// U.S. annual nominal wage growth (%), 1970–2025
// Source: FRED CEU0500000008 — Avg Hourly Earnings, Production & Nonsupervisory, Total Private
// Year-over-year % change in annual average hourly earnings
export const global_wage_growth_annual = Object.freeze({
    1970: 5.9,
    1971: 6.5,
    1972: 7.2,
    1973: 6.2,
    1974: 7.3,
    1975: 7.2,
    1976: 6.5,
    1977: 7.1,
    1978: 7.7,
    1979: 8.2,
    1980: 8.2,
    1981: 8.2,
    1982: 6.2,
    1983: 4.5,
    1984: 3.5,
    1985: 2.8,
    1986: 2.1,
    1987: 2.6,
    1988: 3.1,
    1989: 4.2,
    1990: 3.9,
    1991: 2.9,
    1992: 2.7,
    1993: 2.6,
    1994: 2.4,
    1995: 2.9,
    1996: 3.3,
    1997: 4.1,
    1998: 3.7,
    1999: 3.6,
    2000: 4.3,
    2001: 3.5,
    2002: 3.1,
    2003: 2.5,
    2004: 2.2,
    2005: 2.9,
    2006: 3.7,
    2007: 3.9,
    2008: 3.6,
    2009: 3.0,
    2010: 2.6,
    2011: 1.9,
    2012: 1.6,
    2013: 2.0,
    2014: 2.2,
    2015: 2.0,
    2016: 2.7,
    2017: 2.2,
    2018: 2.9,
    2019: 3.5,
    2020: 4.6,
    2021: 5.4,
    2022: 6.9,
    2023: 4.5,
    2024: 4.6,
    2025: 3.8,
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

/**
 * The filing statuses this engine models. One vocabulary, validated at the door.
 *
 * There used to be three: 'Single' here, 'MFJ' in the settings <select>, and
 * "single" / "married" as the filingType keys inside the tax tables — with
 * `global_filingAs != 'Single'` as the only branch that read any of them. MFJ
 * therefore worked by falling through an else, which means a corrupted
 * localStorage value or a future 'MFS' option would have silently filed the
 * household jointly. FILING_TYPE_KEY in taxes.js maps these to the table keys,
 * so the table vocabulary stays an implementation detail of the tables.
 */
export const FilingStatus = Object.freeze({
    SINGLE: 'Single',
    MARRIED_FILING_JOINTLY: 'MFJ',
});

export const FILING_STATUSES = Object.freeze(Object.values(FilingStatus));

export function isFilingStatus(value) {
    return FILING_STATUSES.includes(value);
}

/**
 * Coerce UNTRUSTED input — localStorage, an imported portfolio — to a known
 * status, falling back rather than throwing. Code paths should call
 * global_setFilingAs directly and get an exception if they are wrong.
 */
export function asFilingStatus(value, fallback = FilingStatus.SINGLE) {
    if (isFilingStatus(value)) return value;
    if (value != null) {
        logger.log(LogCategory.GENERAL,
            `unrecognised filing status ${JSON.stringify(value)} — using ${fallback}`);
    }
    return fallback;
}

export const global_default_filingAs = FilingStatus.SINGLE;

export const global_default_propertyTaxDeductionMax = 40000.0;

export const global_default_user_startAge = 50;
export const global_default_user_retirementAge = 67;
export const global_default_user_finishAge = 87;

export const global_default_fica = 7.65;

/**
 * Federal withholding at the source of a traditional IRA / 401(K) distribution.
 *
 * 10% mirrors the default a custodian applies when the account holder makes no
 * election (Form W-4R). It governs ATTRIBUTION, not correctness: the monthly and
 * annual true-ups reconcile any over- or under-withholding in either direction,
 * so a wrong rate misplaces cash between accounts but never changes the
 * household's total tax.
 *
 * Flat by design. A rate derived from the resulting liability would reintroduce
 * the feedback loop that ExpenseEngine.calculateGrossWithdrawal's comments call
 * the "death-spiral": withholding raises taxable income, which raises the
 * liability, which raises the withholding.
 *
 * Roth is excluded — the guard is isTaxDeferred(), never "is a retirement
 * account". TAX_DEFERRED is exactly {IRA, FOUR_01K}.
 */
export const global_retirement_withholding_rate = 0.10;

/**
 * Split the residual household tax across the accounts that generated the
 * income, instead of billing the whole thing to the funding backstop.
 *
 * OFF until the golden masters are re-blessed against the predictions in
 * markdowns/tax-allocation-spec.md §7.6. With this false the engine must be
 * event-for-event identical to one built without the feature — that is the
 * neutrality assertion in tests/tax-allocation.mjs, and it is what makes the
 * flag a real rollback rather than a decoration.
 */
export let global_allocate_household_tax = false;

export function global_setAllocateHouseholdTax(value) {
    global_allocate_household_tax = !!value;
}

/**
 * Age from which a tax-DEFERRED account may be allocated a share of the tax on
 * income it generated.
 *
 * The statutory threshold is 59.5, which this engine cannot express: the
 * simulated user ages in whole years on New Year's Day (Portfolio.applyYear
 * calls activeUser.addYears(1); activeUser.month is pinned to 0 and no caller
 * advances it). 60 is the conservative rounding — it never reaches money that
 * might still carry a 10% early-withdrawal penalty, at the cost of a few months
 * of attribution in the year the holder turns 59.5.
 *
 * This gates ATTRIBUTION ONLY. FUNDING_BACKSTOP_PRIORITY is deliberately
 * unchanged: the engine still never implicitly draws a retirement account to
 * pay an expense, a mortgage or an escrow at any age.
 */
export const global_deferred_allocation_age = 60;

/**
 * Federal withholding on a periodic pension payment.
 *
 * 10% stands in for the Form W-4P default, which is to withhold on periodic
 * payments unless the recipient elects otherwise. Like every rate in this file
 * it governs ATTRIBUTION, not correctness — the monthly and annual true-ups
 * reconcile over- and under-withholding in either direction, so a wrong rate
 * misplaces cash between accounts without changing the household's total tax.
 *
 * Withheld ON ARRIVAL: it reduces what the pension pays out, rather than
 * debiting an account afterwards the way IRA/401(K) withholding does. A pension
 * is a flow with no balance to debit — see markdowns/retirement-income-withholding-spec.md.
 */
export let global_pension_withholding_rate = 0.10;

export function global_setPensionWithholdingRate(value) {
    global_pension_withholding_rate = Number(value) || 0;
}

/**
 * Federal withholding on Social Security.
 *
 * ZERO by default, and that is the faithful modelling choice rather than a
 * placeholder. Form W-4V is ELECTIVE — 7, 10, 12 or 22 percent, with no default
 * — and not filing one is the common case, so most recipients have nothing
 * withheld. Withholding by default would model a decision the household never
 * made.
 *
 * The consequence is deliberate and worth stating: Social Security stays
 * unattributed unless a rate is elected, which is over half of taxable income in
 * a fully-retired plan. The mechanism is there the moment someone chooses it.
 */
export let global_social_security_withholding_rate = 0.0;

export function global_setSocialSecurityWithholdingRate(value) {
    global_social_security_withholding_rate = Number(value) || 0;
}

export let global_inflationRate = global_default_inflationRate;

export let global_taxYear = global_default_taxYear;

export let global_filingAs = global_default_filingAs;

export let global_propertyTaxDeductionMax = global_default_propertyTaxDeductionMax;

export let global_user_startAge = global_default_user_startAge;
export let global_user_retirementAge = global_default_user_retirementAge;
export let global_user_finishAge = global_default_user_finishAge;

export let global_backtestYear = 'current';

export let activeTaxTable = null;
export function setActiveTaxTable(t) { activeTaxTable = t; }

export function global_reset() {
    global_inflationRate = global_default_inflationRate;
    global_taxYear = global_default_taxYear;
    global_filingAs = global_default_filingAs;
    global_propertyTaxDeductionMax = global_default_propertyTaxDeductionMax;
    global_user_startAge = global_default_user_startAge;
    global_user_retirementAge = global_default_user_retirementAge;
    global_user_finishAge = global_default_user_finishAge;

    global_setInflationRate(global_inflationRate);
    global_setTaxYear(global_taxYear);
    global_setFilingAs(global_filingAs);
    global_setPropertyTaxDeductionMax(global_propertyTaxDeductionMax);
    global_setUserStartAge(global_user_startAge);
    global_setUserRetirementAge(global_user_retirementAge);
    global_setUserFinishAge(global_user_finishAge);

    global_setShowEngineDiagnostics(global_default_showEngineDiagnostics);
}

// ── Worker settings snapshot ──────────────────────────────────
//
// Web Workers have no localStorage, so their copy of this module boots with
// DEFAULTS — a simulation run in a worker would use the wrong age, filing
// status, inflation, etc. (life-event trigger dates derive from
// global_user_startAge, so even phase timing shifts). Every worker payload
// must carry global_workerSnapshot() from the main thread, and every worker
// message handler must call global_applyWorkerSnapshot(payload.settings)
// BEFORE constructing a TaxTable or touching model objects.

export function global_workerSnapshot() {
    return {
        inflationRate: global_inflationRate,
        taxYear: global_taxYear,
        filingAs: global_filingAs,
        propertyTaxDeductionMax: global_propertyTaxDeductionMax,
        userStartAge: global_user_startAge,
        userRetirementAge: global_user_retirementAge,
        userFinishAge: global_user_finishAge,
        backtestYear: global_backtestYear,
        simDataMode: global_simDataMode,
    };
}

export function global_applyWorkerSnapshot(s) {
    if (!s) return;
    global_inflationRate = s.inflationRate;
    global_taxYear = s.taxYear;
    // Workers boot on defaults and receive this payload; a status the main
    // thread never validated would otherwise reach TaxTable and throw inside a
    // worker, where the failure is far harder to see.
    global_filingAs = asFilingStatus(s.filingAs, global_default_filingAs);
    global_propertyTaxDeductionMax = s.propertyTaxDeductionMax;
    global_user_startAge = s.userStartAge;
    global_user_retirementAge = s.userRetirementAge;
    global_user_finishAge = s.userFinishAge;
    global_backtestYear = s.backtestYear;
    global_simDataMode = s.simDataMode;
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
    // Throws rather than coerces: every caller is code with a known value — the
    // settings <select>, a quick-start profile, a test harness. A silent
    // fallback here is how 'MFJ' came to work by accident in the first place.
    if (!isFilingStatus(value)) {
        throw new Error(`global_setFilingAs: ${JSON.stringify(value)} is not one of ${FILING_STATUSES.join(', ')}`);
    }
    localStorage.setItem('filingAs', value);
}

export function global_getFilingAs() {
    const stored = localStorage.getItem('filingAs');
    // localStorage is untrusted — it can hold a value written by an older
    // version — so this coerces where the setter throws.
    global_filingAs = asFilingStatus(stored ?? global_filingAs, global_default_filingAs);
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

export function global_getRetirementDateInt() {
    const currentYear = new Date().getFullYear();
    const birthYear = currentYear - global_user_startAge;
    const retirementYear = birthYear + global_user_retirementAge;
    return DateInt.from(retirementYear, 1);
}

export function global_getFinishDateInt() {
    const currentYear = new Date().getFullYear();
    const birthYear = currentYear - global_user_startAge;
    const finishYear = birthYear + global_user_finishAge;
    return DateInt.from(finishYear, 12);
}

export function global_setBacktestYear(value) {
    localStorage.setItem('backtestYear', value);
}

export function global_getBacktestYear() {
    let local = localStorage.getItem('backtestYear');
    if (local == null) local = 'current';
    global_backtestYear = local;
}

/** Set backtest year directly (no localStorage). Used by Web Workers. */
export function global_setBacktestYearDirect(value) {
    global_backtestYear = value;
}

// ── Simulation data mode ──────────────────────────────────────
// 'historical'  — Monte Carlo samples raw historical returns (as they happened)
// 'calibrated'  — historical deviations re-centered on the user's configured rates
//                 (the default: matches what most retail MC tools model, and keeps
//                 the fan consistent with the deterministic charts' assumptions)

export const global_default_simDataMode = 'calibrated';

export let global_simDataMode = global_default_simDataMode;

export function global_setSimDataMode(value) {
    localStorage.setItem('simDataMode', value);
    global_simDataMode = value;
}
export function global_getSimDataMode() {
    const v = localStorage.getItem('simDataMode');
    global_simDataMode = v != null ? v : global_default_simDataMode;
}

// ── Engine diagnostics ────────────────────────────────────────
// Off by default, and deliberately so. The reconciliation findings this
// unlocks say "these numbers may not add up", which is an honest signal but
// reads as self-doubt printed beside someone's retirement projection. It is a
// firehose for getting into the weeds, not a default experience.

export const global_default_showEngineDiagnostics = false;

export let global_showEngineDiagnostics = global_default_showEngineDiagnostics;

export function global_setShowEngineDiagnostics(value) {
    localStorage.setItem('showEngineDiagnostics', value ? 'true' : 'false');
    global_showEngineDiagnostics = !!value;
}
export function global_getShowEngineDiagnostics() {
    const v = localStorage.getItem('showEngineDiagnostics');
    global_showEngineDiagnostics = v != null ? v === 'true' : global_default_showEngineDiagnostics;
    return global_showEngineDiagnostics;
}

// ── Guardrails ────────────────────────────────────────────────

export const global_default_guardrail_withdrawalRate = 5;
export const global_default_guardrail_preservation = 15;
export const global_default_guardrail_prosperity = 15;
export const global_default_guardrail_adjustment = 15;

export let global_guardrail_withdrawalRate = global_default_guardrail_withdrawalRate;
export let global_guardrail_preservation = global_default_guardrail_preservation;
export let global_guardrail_prosperity = global_default_guardrail_prosperity;
export let global_guardrail_adjustment = global_default_guardrail_adjustment;

export function global_setGuardrailWithdrawalRate(value) {
    localStorage.setItem('guardrailWithdrawalRate', value.toString());
    global_guardrail_withdrawalRate = parseFloat(value);
}
export function global_getGuardrailWithdrawalRate() {
    const v = localStorage.getItem('guardrailWithdrawalRate');
    global_guardrail_withdrawalRate = v != null ? parseFloat(v) : global_default_guardrail_withdrawalRate;
}

export function global_setGuardrailPreservation(value) {
    localStorage.setItem('guardrailPreservation', value.toString());
    global_guardrail_preservation = parseFloat(value);
}
export function global_getGuardrailPreservation() {
    const v = localStorage.getItem('guardrailPreservation');
    global_guardrail_preservation = v != null ? parseFloat(v) : global_default_guardrail_preservation;
}

export function global_setGuardrailProsperity(value) {
    localStorage.setItem('guardrailProsperity', value.toString());
    global_guardrail_prosperity = parseFloat(value);
}
export function global_getGuardrailProsperity() {
    const v = localStorage.getItem('guardrailProsperity');
    global_guardrail_prosperity = v != null ? parseFloat(v) : global_default_guardrail_prosperity;
}

export function global_setGuardrailAdjustment(value) {
    localStorage.setItem('guardrailAdjustment', value.toString());
    global_guardrail_adjustment = parseFloat(value);
}
export function global_getGuardrailAdjustment() {
    const v = localStorage.getItem('guardrailAdjustment');
    global_guardrail_adjustment = v != null ? parseFloat(v) : global_default_guardrail_adjustment;
}

export function global_initialize() {
    global_getInflationRate();
    global_getTaxYear();
    global_getFilingAs();
    global_getPropertyTaxDeductionMax();
    global_getUserStartAge();
    global_getUserRetirementAge();
    global_getUserFinishAge();
    global_getBacktestYear();
    global_getSimDataMode();
    global_getShowEngineDiagnostics();
    global_getGuardrailWithdrawalRate();
    global_getGuardrailPreservation();
    global_getGuardrailProsperity();
    global_getGuardrailAdjustment();
}
