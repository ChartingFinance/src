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
// Moved to filing-status.js (Spec 9 step 1) so sim-config.js can validate a
// status without importing this module — see §4.6. Re-exported here because
// finplan-app.js, taxes.js and run-plan.js all import it from globals.
export { FilingStatus, FILING_STATUSES, isFilingStatus, asFilingStatus };

export const global_default_filingAs = SIM_CONFIG_DEFAULTS.filingAs;

export const global_default_propertyTaxDeductionMax = SIM_CONFIG_DEFAULTS.propertyTaxDeductionMax;

export const global_default_user_startAge = SIM_CONFIG_DEFAULTS.startAge;
export const global_default_user_retirementAge = SIM_CONFIG_DEFAULTS.retirementAge;
export const global_default_user_finishAge = SIM_CONFIG_DEFAULTS.finishAge;

export const global_default_fica = 7.65;


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
export const global_default_allocate_household_tax = SIM_CONFIG_DEFAULTS.allocateHouseholdTax;
export let global_allocate_household_tax = global_default_allocate_household_tax;

export function global_setAllocateHouseholdTax(value) {
    global_allocate_household_tax = !!value;
}


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
export const global_default_pension_withholding_rate = SIM_CONFIG_DEFAULTS.pensionWithholdingRate;
export let global_pension_withholding_rate = global_default_pension_withholding_rate;

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
// DEFAULTS — a simulation run in a worker would use the wrong age, filing
// status, inflation, etc. (life-event trigger dates derive from
// global_user_startAge, so even phase timing shifts). Every worker payload
// must carry global_workerSnapshot() from the main thread, and every worker
// message handler must call global_applyWorkerSnapshot(payload.settings)
// BEFORE constructing a TaxTable or touching model objects.

/**
 * Capture the current settings as a SimConfig.
 *
 * This lives HERE, not in sim-config.js, and the direction is the point. The
 * globals are the browser-side settings store — the persistence behind the
 * settings editor — so reading them is this module's job. sim-config.js must
 * import nothing from here, or globals.js can never leave the engine's import
 * closure and the layer-boundary exemption can never be deleted (Spec 9 §4.6).
 *
 * `taxTable` is deliberately absent; step 2 attaches it.
 */
export function makeActiveTaxTable() {
    return new TaxTable(
        asFilingStatus(global_filingAs, global_default_filingAs),
        global_propertyTaxDeductionMax);
}

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

        // Built here as of step 6, so a config from the app carries its own
        // table exactly as one from a plan spec does. Portfolio no longer needs
        // to reach for the module-level `activeTaxTable`, which is what lets it
        // stop importing this file.
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
        // Added by Spec 9 step 5c. These three are READ BY THE ENGINE
        // (tax-engine, payroll-engine x2) but were never in the payload, so a
        // worker ran on its own defaults for them. Latent rather than live —
        // all three sit at their defaults today, so a worker booting on
        // defaults happened to agree — but toggling spec 4a on would have
        // silently given Monte Carlo a different tax regime than the chart
        // beside it.
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

export function global_setInflationRate(value) {
    localStorage.setItem('inflationRate', value.toFixed(4));
}

export function global_getInflationRate() {
    let localIR = localStorage.getItem('inflationRate');
    if (localIR == null)
        localIR = global_inflationRate.toFixed(4);

    global_inflationRate = parseFloat(localIR);
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

/**
 * The month the user retires in, resolved against a PLAN.
 *
 * Both of these used to derive their own birth year from the wall clock —
 * `new Date().getFullYear() - global_user_startAge` — the same second
 * derivation Spec 10 step 0 removed from `plan-dates.js`, surviving here
 * because these read the settings rather than a config. It is not cosmetic:
 * the retirement date returned here is handed to Monte Carlo and Guardrails,
 * which compare it against months the ENGINE produced from `config.birthYear`.
 * The gap is however many years have passed since the plan's first month, so a
 * scenario saved in one year and reopened in the next started withdrawing a
 * year late, and a five-year-old plan five years late — measured, on a
 * mid-career plan starting Aug 2021: guardrails switched regime in Jan 2048,
 * the plan retires in Jan 2043.
 *
 * So the anchor comes in now, read by `birthYearFor()` — the same reader the
 * engine uses, throwing on an unanchored config for the same reason a fallback
 * here would be the original bug wearing a guard clause. Only the anchor: the
 * AGES stay module state, because these are settings accessors and the
 * settings form is what moves them.
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
