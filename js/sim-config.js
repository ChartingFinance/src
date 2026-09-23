/**
 * sim-config.js — the engine's configuration, as a value.
 *
 * Every engine read of a setting goes through the config a `Portfolio` is
 * constructed with. Before Spec 9 the engine read module globals backed by
 * localStorage, so a headless caller had to fake browser storage and two plans
 * in one process shared one configuration.
 *
 * ── What this is for ─────────────────────────────────────────────────
 *
 * A config is a VALUE: captured at a known moment, frozen, and passed
 * explicitly.
 *
 * ── A captured copy, never a live view ───────────────────────────────
 *
 * The tempting shortcut is an object whose getters forward to the live module
 * bindings. It would work, and it would be a trap: it preserves the coupling
 * under a new name — two concurrent plans still read the same cell — and it is
 * unverifiable, because the migration's gate is a bit-identical snapshot and a
 * forwarding view is trivially bit-identical. Every step would pass while
 * proving nothing.
 *
 * So `Object.freeze`, and values copied in.
 *
 * ── It imports no globals, on purpose ────────────────────────────────
 *
 * Not stylistic. tests/layer-boundary.mjs asserts that nothing on the engine's
 * run path imports `globals.js`, the browser-side settings store, and this file
 * is on that path. `filing-status.js` was lifted out of globals.js for exactly
 * this reason; it is a frozen enum with no state.
 *
 * Building a config FROM the globals is therefore not this module's job — see
 * `simConfigFromGlobals()` in globals.js, which is UI-side, where the settings
 * store lives.
 */

import { FilingStatus, isFilingStatus } from './filing-status.js';

/**
 * The engine's own defaults (Spec 9 step 6).
 *
 * They used to live in globals.js as `global_default_*`, which made the
 * settings store the source of truth for what the engine does when told
 * nothing. That is backwards, and it was the last thing keeping globals.js in
 * the engine's import closure: `run-plan.js` needed these to build a config
 * from a plan spec, and importing them dragged the whole settings store in
 * behind them.
 *
 * The direction is now right: the engine owns its defaults, and globals.js —
 * the browser-side settings store — imports them to seed what it persists.
 * globals.js re-exports each under its old `global_default_*` name, so every
 * existing caller is unaffected.
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
 * `birthYear` and `taxTable` are the two ATTACHED fields: optional here, and
 * added with `withSimConfig` rather than passed to `makeSimConfig`.
 *
 * `taxTable` is built by the config builders — `simConfigFromGlobals()` and
 * `simConfigFromPlanSpec()` — and `Portfolio` throws if a config arrives without
 * one. `birthYear` is attached by `Portfolio`, because it needs the plan's own
 * first month, which no builder has. The engine used
 * to derive the year from `new Date()` inside a getter, which made a frozen
 * plan's finish date and every life-event trigger depend on WHEN IT WAS READ:
 * one spec replayed across a New Year moved 5.4% in ending net worth and grew
 * by twelve months, from nothing but the calendar. `Portfolio` anchors it to
 * `firstDateInt.year - startAge` instead — a property of the plan, so a spec
 * run today and in 2030 is the same run.
 *
 * Both are absent rather than defaulted when unattached, and `birthYearFor()`
 * throws on absence. A default here would be a year nobody chose, which is the
 * failure this whole migration is about.
 *
 * Every field the engine reads. `global_workerSnapshot()` must carry each of
 * them too: workers boot on defaults and rebuild a config from the snapshot.
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
 * Fields `Portfolio` attaches later, so absent is legal at build time. See the
 * FIELDS comment; `birthYear` needs the plan's first month and `taxTable` needs
 * the resolved filing status, neither of which a config builder holds.
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
 * Throws on anything missing or malformed rather than defaulting. Defaults
 * belong to whoever owns the setting — `globals.js` for the app, the plan spec
 * for MCP — and a config that quietly substituted its own would reintroduce the
 * failure this whole migration is about: a plausible number from an
 * unaccountable source.
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

    // Attached, so absent is legal; present and nonsensical is not. A birth
    // year that arrived as a string or a float would flow into DateInt.from()
    // and produce a plausible date, which is the shape of bug this field
    // exists to remove.
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
 * A copy with some fields replaced. The config is frozen, so this is how step 2
 * attaches the `taxTable` once it has one, and how a what-if would vary a
 * setting without mutating the run that is already using it.
 */
export function withSimConfig(config, changes) {
    return makeSimConfig({ ...config, ...changes });
}
