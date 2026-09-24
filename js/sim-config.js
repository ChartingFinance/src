/**
 * sim-config.js — the engine's configuration, as a value.
 *
 * Every engine read of a setting goes through the config a `Portfolio` is
 * constructed with: a value, captured at a known moment, frozen, and passed
 * explicitly. So a headless caller needs no browser storage, and two plans in
 * one process share nothing.
 *
 * ── A captured copy, never a live view ───────────────────────────────
 *
 * An object whose getters forwarded to the settings store would keep two plans
 * coupled, and no snapshot test could tell (a forwarding view gives identical
 * numbers). So values are copied in and frozen; tests/sim-config.mjs checks.
 *
 * ── It imports no globals, on purpose ────────────────────────────────
 *
 * Not stylistic. tests/layer-boundary.mjs asserts that nothing on the engine's
 * run path imports `globals.js`, the browser-side settings store, and this file
 * is on that path. `filing-status.js` was lifted out of globals.js for exactly
 * this reason; it is a frozen enum with no state.
 *
 * Building a config from the app's settings is done UI-side, by
 * `simConfigFromGlobals()` in globals.js.
 */

import { FilingStatus, isFilingStatus } from './filing-status.js';

/**
 * The engine's own defaults. The engine owns them; globals.js imports them to
 * seed the app's settings and re-exports each as `global_default_*`.
 */
export const SIM_CONFIG_DEFAULTS = Object.freeze({
    inflationRate: 0.031,
    filingAs: FilingStatus.SINGLE,
    startAge: 50,
    retirementAge: 67,
    finishAge: 87,
    propertyTaxDeductionMax: 40000.0,
    allocateHouseholdTax: false,
    pensionWithholdingRate: 0.10,
    socialSecurityWithholdingRate: 0.0,
    backtestYear: 'current',
    simDataMode: 'calibrated',
});

/**
 * Every field the engine reads. `global_workerSnapshot()` must carry each
 * setting too: workers boot on defaults and rebuild a config from the snapshot.
 */
const FIELDS = Object.freeze([
    'inflationRate',
    'filingAs',
    'startAge',
    'retirementAge',
    'finishAge',
    'propertyTaxDeductionMax',
    'allocateHouseholdTax',
    'pensionWithholdingRate',
    'socialSecurityWithholdingRate',
    'backtestYear',
    'simDataMode',
    'taxTable',
    'birthYear',
]);

/**
 * Fields that may be absent when makeSimConfig runs.
 *
 * `taxTable`: the builders (`simConfigFromGlobals()`, `simConfigFromPlanSpec()`)
 * supply it, and `Portfolio` throws if a config arrives without one.
 *
 * `birthYear`: attached by `Portfolio` with `withSimConfig`, from the plan's own
 * first month (`firstDateInt.year - startAge`) — never from the clock, so a
 * saved plan runs the same in any year. When absent, `birthYearFor()` throws
 * rather than invent one.
 */
const ATTACHED = Object.freeze(['taxTable', 'birthYear']);

const NUMERIC = Object.freeze([
    'inflationRate',
    'startAge',
    'retirementAge',
    'finishAge',
    'propertyTaxDeductionMax',
    'pensionWithholdingRate',
    'socialSecurityWithholdingRate',
]);

/**
 * Build a frozen config.
 *
 * Throws on anything missing or malformed rather than defaulting: defaults
 * belong to the caller (the app's settings, or the plan spec for MCP), and a
 * silent substitute would be a plausible number from nowhere.
 *
 * `taxTable` and `birthYear` are the exceptions, and are optional here — see
 * ATTACHED.
 *
 * @param {object} values  every entry of FIELDS except those in ATTACHED
 * @returns {Readonly<object>}
 */
export function makeSimConfig(values) {
    if (!values || typeof values !== 'object') {
        throw new Error('makeSimConfig: expected an object of settings.');
    }

    const missing = FIELDS.filter(f => !ATTACHED.includes(f) && !(f in values));
    if (missing.length) {
        throw new Error(`makeSimConfig: missing ${missing.join(', ')}.`);
    }

    const unknown = Object.keys(values).filter(k => !FIELDS.includes(k));
    if (unknown.length) {
        throw new Error(`makeSimConfig: unknown setting(s) ${unknown.join(', ')}. `
            + `Known: ${FIELDS.join(', ')}.`);
    }

    for (const f of NUMERIC) {
        if (typeof values[f] !== 'number' || !Number.isFinite(values[f])) {
            throw new Error(`makeSimConfig: ${f} must be a finite number, got `
                + `${JSON.stringify(values[f])}.`);
        }
    }

    if (!isFilingStatus(values.filingAs)) {
        throw new Error(`makeSimConfig: filingAs ${JSON.stringify(values.filingAs)} `
            + `is not a known filing status. Coerce untrusted input with `
            + `asFilingStatus() before calling this.`);
    }

    if (typeof values.allocateHouseholdTax !== 'boolean') {
        throw new Error('makeSimConfig: allocateHouseholdTax must be a boolean.');
    }

    // Absent is legal; present and malformed is not — a string or a float
    // would flow into DateInt.from() and produce a plausible wrong date.
    if (values.birthYear !== undefined && values.birthYear !== null
        && !Number.isInteger(values.birthYear)) {
        // String(), not JSON.stringify(): NaN stringifies to "null", which
        // sends the reader looking for a null that is not there. NaN is the
        // likely value here — it is what an arithmetic slip upstream produces.
        throw new Error('makeSimConfig: birthYear must be an integer year, got '
            + `${String(values.birthYear)}.`);
    }

    const config = {};
    for (const f of FIELDS) config[f] = values[f] ?? null;
    return Object.freeze(config);
}

/** The field list, for callers that need to build or check one. */
export const SIM_CONFIG_FIELDS = FIELDS;

/**
 * A copy with some fields replaced. The config is frozen, so this is how
 * Portfolio attaches `birthYear`, and how a what-if would vary a setting
 * without touching a run already using the original.
 */
export function withSimConfig(config, changes) {
    return makeSimConfig({ ...config, ...changes });
}
