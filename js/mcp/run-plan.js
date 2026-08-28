/**
 * run-plan.js — the ONE way to run a plan outside the browser.
 *
 * ── Why this file exists ─────────────────────────────────────────────
 *
 * Running a plan is not `new Portfolio(assets)` + `chronometer_run`. It is a
 * SEQUENCE, and every step of it is load-bearing:
 *
 *   1. reset globals          — they are module state; plan N+1 inherits plan N
 *   2. apply settings         — including filingAs, which nothing else infers
 *   3. build the TaxTable     — AFTER filingAs, because it reads it at construction
 *   4. hydrate assets AND life events
 *   5. run
 *   6. read the issues back
 *
 * mcp-server.js previously did an ad-hoc subset of that, and got three of the
 * six wrong: it never set filingAs (so an MFJ plan simulated on Single brackets,
 * Single contribution limits and a $250k home exclusion), it dropped the life
 * events on the floor (so no phase ever transitioned and no retirement transfer
 * ever fired), and it set global ages that quick-start does not read (so the
 * `startAge` parameter it advertised moved nothing).
 *
 * That is what a second client of the engine costs when it reimplements setup.
 * The fix is the same one this codebase applies everywhere else — recordEvent()
 * is the only ledger write path, taxableBasis() is the only tax base, one
 * funding resolver — so: one runPlan(), every headless caller goes through it.
 *
 * ── The plan spec ────────────────────────────────────────────────────
 *
 * Deliberately the SAME shape share-modal.js already emits, so an agent can
 * paste a shared portfolio straight in and the app can consume anything built
 * here. Reusing it is why "bring your own portfolio" costs nothing extra:
 *
 *   {
 *     name,
 *     settings: { inflationRate, filingAs, startAge, retirementAge, finishAge },
 *     modelAssets: [ ModelAsset.toJSON() ],
 *     lifeEvents:  [ ModelLifeEvent.toJSON() ],
 *     guardrailParams: { ... } | null,
 *   }
 *
 * ── What this file does NOT do ───────────────────────────────────────
 *
 * It does not format anything. Callers decide whether they want markdown, JSON
 * or a causal chain; this returns the live Portfolio (traceScopes included) so
 * `explainEvent` can resolve against the run that produced it rather than
 * against module state a later run will have reset.
 */

import { Portfolio } from '../portfolio.js';
import { chronometer_run } from '../chronometer.js';
import { TaxTable } from '../taxes.js';
import { membrane_rawDataToModelAssets } from '../membrane.js';
import { ModelLifeEvent } from '../life-event.js';
import { detectIssues } from '../portfolio-issues.js';
import { buildQuickStart, quickStartProfiles } from '../quick-start.js';
import {
    asFilingStatus,
    global_initialize,
    global_default_inflationRate, global_default_filingAs,
    global_default_propertyTaxDeductionMax,
    global_default_user_startAge, global_default_user_retirementAge,
    global_default_user_finishAge,
    global_default_allocate_household_tax,
    global_default_pension_withholding_rate,
    global_default_social_security_withholding_rate,
    global_default_simDataMode,
} from '../globals.js';
import { makeSimConfig } from '../sim-config.js';

/**
 * Build a plan spec from a Quick Start profile key.
 *
 * `ageOverrides` is threaded into buildQuickStart, NOT applied to globals
 * afterwards — asset dates and life-event triggers are derived at build time,
 * so a global set later moves nothing. See the note on buildQuickStart.
 *
 * @param {string} profileKey  e.g. 'midCareer', 'dualIncome'
 * @param {object} [ageOverrides] partial {startAge, retirementAge, finishAge}
 */
export function planFromProfile(profileKey, ageOverrides = null) {
    const profile = quickStartProfiles.find(p => p.key === profileKey);
    if (!profile) {
        const known = quickStartProfiles.map(p => p.key).join(', ');
        throw new Error(`Unknown profile "${profileKey}". Known profiles: ${known}`);
    }

    const { assets, lifeEvents, ages } = buildQuickStart(profile, ageOverrides);

    return {
        name: profile.label,
        settings: {
            inflationRate: global_default_inflationRate,
            // From the profile, never assumed. A joint profile that files Single
            // gets the wrong brackets, the wrong contribution limits and half
            // the home-sale exclusion.
            filingAs: profile.filingAs,
            ...ages,
        },
        modelAssets: assets.map(a => a.toJSON()),
        lifeEvents: lifeEvents.map(e => e.toJSON()),
        guardrailParams: null,
    };
}

/**
 * Build this run's configuration from the plan spec.
 *
 * Spec 9 step 5b. This replaces `applySettings()`, which mutated eight module
 * globals and then built a TaxTable that read one of them back. That function
 * carried a comment explaining that the TaxTable had to be constructed AFTER
 * filingAs — a six-step sequence with an ordering constraint, which every
 * headless caller had to perform correctly. Here the ordering is structural:
 * `filingAs` is resolved before it is handed to the table, in one expression.
 *
 * It lives in this file rather than in sim-config.js because it needs the
 * `global_default_*` values, and sim-config.js must import nothing from
 * globals.js (§4.6). This is the MCP layer building a config from an MCP
 * payload, which is exactly where §4.6's table puts it.
 *
 * Nothing here writes to a global, so two plans in one process no longer share
 * a configuration — which is the whole point of the migration, and the reason
 * the run-handle cache stops being a correctness requirement.
 */
export function simConfigFromPlanSpec(spec) {
    const settings = spec?.settings ?? {};

    // Untrusted: a spec can arrive from an agent or an old share URL. Coerce
    // rather than throw, matching how the app treats an imported portfolio.
    const filingAs = asFilingStatus(settings.filingAs, global_default_filingAs);
    const propertyTaxDeductionMax = global_default_propertyTaxDeductionMax;

    return makeSimConfig({
        inflationRate: settings.inflationRate ?? global_default_inflationRate,
        filingAs,
        startAge: settings.startAge ?? global_default_user_startAge,
        retirementAge: settings.retirementAge ?? global_default_user_retirementAge,
        finishAge: settings.finishAge ?? global_default_user_finishAge,
        propertyTaxDeductionMax,

        // Not carried by the share format, and deliberately taken from the
        // defaults rather than from whatever this process happens to hold. A
        // plan spec describes a plan; it must not inherit ambient state from a
        // previous caller. In a fresh server process these ARE the current
        // values, so this is identical to what applySettings produced.
        allocateHouseholdTax: global_default_allocate_household_tax,
        pensionWithholdingRate: global_default_pension_withholding_rate,
        socialSecurityWithholdingRate: global_default_social_security_withholding_rate,
        backtestYear: 'current',
        simDataMode: global_default_simDataMode,

        // Built from the resolved status, not from a global it might disagree
        // with. This is the ordering constraint, dissolved.
        taxTable: new TaxTable(filingAs, propertyTaxDeductionMax),
    });
}

/**
 * Run a plan spec to completion.
 *
 * @param {object} spec  see the module comment
 * @param {object} [opts]
 * @param {boolean} [opts.includeReconciliation] engine-diagnostic issues too
 * @returns {Promise<{portfolio: Portfolio, issues: Array, spec: object}>}
 */
export async function runPlan(spec, { includeReconciliation = false } = {}) {
    if (!spec?.modelAssets?.length) {
        throw new Error('Plan spec has no modelAssets — nothing to simulate.');
    }

    const config = simConfigFromPlanSpec(spec);

    const assets = membrane_rawDataToModelAssets(spec.modelAssets);

    const portfolio = new Portfolio(assets, false, config);

    // Not optional. With no life events nothing ever transitions: salary never
    // closes, retirement-phase transfers never activate, and the run reports an
    // accumulation plan that quietly never retires.
    portfolio.lifeEvents = (spec.lifeEvents ?? []).map(ModelLifeEvent.fromJSON);

    await chronometer_run(portfolio);

    const issues = detectIssues(portfolio, { includeReconciliation });

    return { portfolio, issues, spec };
}

/** Convenience: profile key straight to a completed run. */
export async function runProfile(profileKey, ageOverrides = null, opts = {}) {
    return runPlan(planFromProfile(profileKey, ageOverrides), opts);
}

// ── Run cache ────────────────────────────────────────────────────────
//
// A handle exists so a client can run once and then ask several questions
// about that run. It is not an optimisation — it is a CORRECTNESS
// requirement for explain.js.
//
// Trace scopes are run state: chronometer_run calls resetTraces() at the top,
// so running a second plan wipes the first one's scope list. A stateless
// server that re-ran the plan on every explain call would resolve chains
// against a different run than the one it is describing. Holding the finished
// Portfolio — traceScopes and all — is what makes a chain resolvable at all,
// and it is the same rule as "reads take the scope list explicitly", one
// level up.
//
// Bounded because a 666-month plan holds tens of thousands of events and
// scopes; four of those is already a lot of memory for a stdio server that
// may sit open all day.

const MAX_CACHED_RUNS = 4;
const RUNS = new Map();
let runCounter = 0;

/** Cache a completed run and return its handle. Oldest is evicted first. */
export function cacheRun(result) {
    const handle = `plan_${++runCounter}`;
    RUNS.set(handle, result);
    while (RUNS.size > MAX_CACHED_RUNS) {
        // Map preserves insertion order, so the first key is the oldest.
        RUNS.delete(RUNS.keys().next().value);
    }
    return handle;
}

/** Look up a cached run, or throw naming the handles that are still live. */
export function getRun(handle) {
    const run = RUNS.get(handle);
    if (!run) {
        const live = [...RUNS.keys()];
        throw new Error(
            `No run "${handle}". ${live.length
                ? `Live handles: ${live.join(', ')}. Only the ${MAX_CACHED_RUNS} most recent are kept.`
                : 'No runs are cached — run a plan first.'}`);
    }
    return run;
}

/** Run a plan and cache it. Returns the handle alongside the result. */
export async function runPlanCached(spec, opts = {}) {
    const result = await runPlan(spec, opts);
    return { handle: cacheRun(result), ...result };
}

/** Test seam: drop every cached run. */
export function clearRuns() {
    RUNS.clear();
}

/** Profile keys and labels, for a tool that needs to offer a choice. */
export function listProfiles() {
    return quickStartProfiles.map(p => ({
        key: p.key,
        label: p.label,
        filingAs: p.filingAs,
        ages: { startAge: p.startAge, retirementAge: p.retirementAge, finishAge: p.finishAge },
        tagline: p.tagline,
    }));
}

/** `global_initialize` is re-exported so a host can prime localStorage first. */
export { global_initialize };
