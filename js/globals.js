import { DateInt } from './utils/date-int.js';
// logger.js imports nothing, so this cannot cycle back through globals.
import { logger, LogCategory } from './utils/logger.js';
import { FilingStatus, FILING_STATUSES, isFilingStatus, asFilingStatus } from './filing-status.js';
// Moved to market-data.js (Spec 9 step 6): immutable historical series, not
// settings. Re-exported so callers outside the engine are unaffected.
export {
    global_sp500_annual_returns, global_10yr_treasury_rates,
    global_wage_growth_annual, global_cpi_annual_inflation,
} from './market-data.js';
import { makeSimConfig, SIM_CONFIG_DEFAULTS } from './sim-config.js';
// plan-dates.js imports only DateInt, so this cannot cycle back through globals.
import { birthYearFor } from './plan-dates.js';
import { TaxTable } from './taxes.js';
// Moved to policy-constants.js (Spec 9 step 6): fixed tax policy, not settings.
export { global_retirement_withholding_rate, global_deferred_allocation_age }
    from './policy-constants.js';

// S&P 500 annual total returns (price + dividends), 2000–2025
// Source: https://www.slickcharts.com/sp500/returns

// 10-Year U.S. Treasury yield (annual average %), 2000–2025
// Source: https://www.multpl.com/10-year-treasury-rate/table/by-year

// U.S. annual nominal wage growth (%), 1970–2025
// Source: FRED CEU0500000008 — Avg Hourly Earnings, Production & Nonsupervisory, Total Private
// Year-over-year % change in annual average hourly earnings

// U.S. annual CPI inflation rate (%), 2000–2025
// Source: https://www.minneapolisfed.org/about-us/monetary-policy/inflation-calculator/consumer-price-index-1913-

export const global_default_inflationRate = SIM_CONFIG_DEFAULTS.inflationRate;

/**
 * The filing statuses this engine models: one vocabulary, validated where it
 * enters. FILING_TYPE_KEY in taxes.js maps them to the tax tables' own keys.
 */
// Defined in filing-status.js, so sim-config.js can validate a status without
// importing this module; re-exported for existing importers.
export { FilingStatus, FILING_STATUSES, isFilingStatus, asFilingStatus };

export const global_default_filingAs = SIM_CONFIG_DEFAULTS.filingAs;

export const global_default_propertyTaxDeductionMax = SIM_CONFIG_DEFAULTS.propertyTaxDeductionMax;

export const global_default_user_startAge = SIM_CONFIG_DEFAULTS.startAge;
export const global_default_user_retirementAge = SIM_CONFIG_DEFAULTS.retirementAge;
export const global_default_user_finishAge = SIM_CONFIG_DEFAULTS.finishAge;

export const global_default_fica = 7.65;


/**
 * Split the residual household tax across the accounts that generated the
 * income, instead of billing all of it to the funding backstop.
 *
 * Off until the baselines are re-blessed against the predictions in
 * markdowns/tax-allocation-spec.md §7.6. Off, the engine is event-for-event
 * identical to one without the feature (tests/tax-allocation.mjs asserts it).
 */
export const global_default_allocate_household_tax = SIM_CONFIG_DEFAULTS.allocateHouseholdTax;
export let global_allocate_household_tax = global_default_allocate_household_tax;

export function global_setAllocateHouseholdTax(value) {
    global_allocate_household_tax = !!value;
}


/**
 * Federal withholding on a periodic pension payment: 10%, the Form W-4P
 * default. Like every withholding rate, it decides which account pays, not how
 * much: the true-ups settle any over- or under-withholding.
 *
 * Withheld on arrival — it reduces what the pension pays out — because a
 * pension is a flow with no balance to debit afterwards.
 */
export const global_default_pension_withholding_rate = SIM_CONFIG_DEFAULTS.pensionWithholdingRate;
export let global_pension_withholding_rate = global_default_pension_withholding_rate;

export function global_setPensionWithholdingRate(value) {
    global_pension_withholding_rate = Number(value) || 0;
}

/**
 * Federal withholding on Social Security: zero by default. Form W-4V is
 * elective (7, 10, 12 or 22%, no default) and most recipients never file one.
 * So by default the tax on Social Security is paid by the true-up from the
 * funding account, not withheld from the benefit.
 */
export const global_default_social_security_withholding_rate = SIM_CONFIG_DEFAULTS.socialSecurityWithholdingRate;
export let global_social_security_withholding_rate = global_default_social_security_withholding_rate;

export function global_setSocialSecurityWithholdingRate(value) {
    global_social_security_withholding_rate = Number(value) || 0;
}

export let global_inflationRate = global_default_inflationRate;

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
    global_filingAs = global_default_filingAs;
    global_propertyTaxDeductionMax = global_default_propertyTaxDeductionMax;
    global_user_startAge = global_default_user_startAge;
    global_user_retirementAge = global_default_user_retirementAge;
    global_user_finishAge = global_default_user_finishAge;

    global_setInflationRate(global_inflationRate);
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
// defaults. Every worker payload must carry global_workerSnapshot(), and every
// worker handler must call global_applyWorkerSnapshot(payload.settings) before
// building a TaxTable or a config, or the worker simulates the wrong ages,
// filing status and inflation.

/** A TaxTable for the current settings' filing status and property-tax cap. */
export function makeActiveTaxTable() {
    return new TaxTable(
        asFilingStatus(global_filingAs, global_default_filingAs),
        global_propertyTaxDeductionMax);
}

/**
 * Capture the current settings as a SimConfig, tax table included.
 *
 * This lives HERE, not in sim-config.js, and the direction is the point. The
 * globals are the browser-side settings store — the persistence behind the
 * settings editor — so reading them is this module's job. sim-config.js is on
 * the engine's run path and must import nothing from here; tests/layer-boundary.mjs
 * enforces that.
 */
export function simConfigFromGlobals() {
    return makeSimConfig({
        inflationRate: global_inflationRate,
        filingAs: asFilingStatus(global_filingAs, global_default_filingAs),
        startAge: global_user_startAge,
        retirementAge: global_user_retirementAge,
        finishAge: global_user_finishAge,
        propertyTaxDeductionMax: global_propertyTaxDeductionMax,
        allocateHouseholdTax: global_allocate_household_tax,
        pensionWithholdingRate: global_pension_withholding_rate,
        socialSecurityWithholdingRate: global_social_security_withholding_rate,
        backtestYear: global_backtestYear,
        simDataMode: global_simDataMode,

        // A config from the app carries its own table exactly as one from a
        // plan spec does, so Portfolio never reaches for a module-level table.
        taxTable: makeActiveTaxTable(),
    });
}

export function global_workerSnapshot() {
    return {
        inflationRate: global_inflationRate,
        filingAs: global_filingAs,
        propertyTaxDeductionMax: global_propertyTaxDeductionMax,
        userStartAge: global_user_startAge,
        userRetirementAge: global_user_retirementAge,
        userFinishAge: global_user_finishAge,
        backtestYear: global_backtestYear,
        simDataMode: global_simDataMode,
        // The engine reads these too (tax-engine, payroll-engine), so a
        // worker must not fall back to its defaults for them.
        allocateHouseholdTax: global_allocate_household_tax,
        pensionWithholdingRate: global_pension_withholding_rate,
        socialSecurityWithholdingRate: global_social_security_withholding_rate,
    };
}

export function global_applyWorkerSnapshot(s) {
    if (!s) return;
    global_inflationRate = s.inflationRate;
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
    // `??` so a payload from an older client still applies cleanly.
    global_allocate_household_tax = s.allocateHouseholdTax ?? global_allocate_household_tax;
    global_pension_withholding_rate = s.pensionWithholdingRate ?? global_pension_withholding_rate;
    global_social_security_withholding_rate =
        s.socialSecurityWithholdingRate ?? global_social_security_withholding_rate;
}

export function global_divBy100(strValue) {
    let asFloat = parseFloat(strValue);
    asFloat /= 100.0;
    return asFloat;
}

export function global_multBy100(value) {
    return value * 100.0;
}

/**
 * ── Setters ──────────────────────────────────────────────────────────
 *
 * Every setter writes localStorage AND assigns its exported binding, storing
 * exactly what the getter would read back (parsed and rounded the same way), so
 * memory and storage cannot disagree. A caller never has to call the matching
 * `global_getX()` afterwards; the calls that still do are harmless.
 */

export function global_setInflationRate(value) {
    localStorage.setItem('inflationRate', value.toFixed(4));
    global_inflationRate = parseFloat(value.toFixed(4));
}

export function global_getInflationRate() {
    let localIR = localStorage.getItem('inflationRate');
    if (localIR == null)
        localIR = global_inflationRate.toFixed(4);

    global_inflationRate = parseFloat(localIR);
}

export function global_setFilingAs(value) {
    // Throws rather than coerces: every caller passes a known value (the
    // settings <select>, a quick-start profile, a test).
    if (!isFilingStatus(value)) {
        throw new Error(`global_setFilingAs: ${JSON.stringify(value)} is not one of ${FILING_STATUSES.join(', ')}`);
    }
    localStorage.setItem('filingAs', value);
    global_filingAs = value;   // validated above, so no coercion needed here
}

export function global_getFilingAs() {
    const stored = localStorage.getItem('filingAs');
    // localStorage is untrusted — it can hold a value written by an older
    // version — so this coerces where the setter throws.
    global_filingAs = asFilingStatus(stored ?? global_filingAs, global_default_filingAs);
}

export function global_setPropertyTaxDeductionMax(value) {
    localStorage.setItem('propertyTaxDeductionMax', value.toFixed(2));
    global_propertyTaxDeductionMax = parseFloat(value.toFixed(2));
}

export function global_getPropertyTaxDeductionMax() {
    let localPTDM = localStorage.getItem('propertyTaxDeductionMax');
    if (localPTDM == null)
        localPTDM = global_propertyTaxDeductionMax.toFixed(2);

    global_propertyTaxDeductionMax = parseFloat(localPTDM);
}

export function global_setUserStartAge(value) {
    localStorage.setItem('userStartAge', value.toString());
    global_user_startAge = parseInt(value.toString(), 10);
}

export function global_getUserStartAge() {
    let localUA = localStorage.getItem('userStartAge');
    if (localUA == null)
        localUA = global_user_startAge.toString();

    global_user_startAge = parseInt(localUA);
}

export function global_setUserRetirementAge(value) {
    localStorage.setItem('userRetirementAge', value.toString());
    global_user_retirementAge = parseInt(value.toString(), 10);
}

export function global_getUserRetirementAge() {
    let localUA = localStorage.getItem('userRetirementAge');
    if (localUA == null)
        localUA = global_user_retirementAge.toString();

    global_user_retirementAge = parseInt(localUA);
}

export function global_setUserFinishAge(value) {
    localStorage.setItem('userFinishAge', value.toString());
    global_user_finishAge = parseInt(value.toString(), 10);
}

export function global_getUserFinishAge() {
    let localUA = localStorage.getItem('userFinishAge');
    if (localUA == null)
        localUA = global_user_finishAge.toString();

    global_user_finishAge = parseInt(localUA);
}

/**
 * The month the user retires in, resolved against a plan.
 *
 * Monte Carlo and Guardrails compare this date with months the engine produced
 * from `config.birthYear`, so it must use the same anchor: `birthYearFor()`,
 * which throws on an unanchored config. A birth year from the clock would put
 * the retirement date off by however many years the plan has been saved. The
 * ages still come from the settings.
 *
 * @param {object} env a SimConfig carrying `birthYear` — a run's
 *   `portfolio.config`, or the editor's `appState.editingConfig`, which is
 *   itself the plan's anchor, or the clock's when there is no plan to ask.
 */
export function global_getRetirementDateInt(env) {
    return DateInt.from(birthYearFor(env) + global_user_retirementAge, 1);
}

/** December of the year the user turns `finishAge`, on the same anchor. */
export function global_getFinishDateInt(env) {
    return DateInt.from(birthYearFor(env) + global_user_finishAge, 12);
}

export function global_setBacktestYear(value) {
    localStorage.setItem('backtestYear', value);
    global_backtestYear = String(value);
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

export const global_default_simDataMode = SIM_CONFIG_DEFAULTS.simDataMode;

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
// Off by default. The reconciliation findings it reveals ("these numbers may
// not add up") are for debugging, not for someone reading their projection.

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
