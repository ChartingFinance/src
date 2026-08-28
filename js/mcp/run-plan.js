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
import { asFilingStatus } from '../filing-status.js';
import { makeSimConfig, SIM_CONFIG_DEFAULTS } from '../sim-config.js';

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
            inflationRate: SIM_CONFIG_DEFAULTS.inflationRate,
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
    const D = SIM_CONFIG_DEFAULTS;
    const filingAs = asFilingStatus(settings.filingAs, D.filingAs);
    const propertyTaxDeductionMax = D.propertyTaxDeductionMax;

    return makeSimConfig({
        inflationRate: settings.inflationRate ?? D.inflationRate,
        filingAs,
        startAge: settings.startAge ?? D.startAge,
        retirementAge: settings.retirementAge ?? D.retirementAge,
        finishAge: settings.finishAge ?? D.finishAge,
        propertyTaxDeductionMax,

        // Not carried by the share format, and deliberately taken from the
        // defaults rather than from whatever this process happens to hold. A
        // plan spec describes a plan; it must not inherit ambient state from a
        // previous caller. In a fresh server process these ARE the current
        // values, so this is identical to what applySettings produced.
        allocateHouseholdTax: D.allocateHouseholdTax,
        pensionWithholdingRate: D.pensionWithholdingRate,
        socialSecurityWithholdingRate: D.socialSecurityWithholdingRate,
        backtestYear: D.backtestYear,
        simDataMode: D.simDataMode,

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

// ── Run handles ──────────────────────────────────────────────────────
//
// This block used to open by saying a handle is "not an optimisation — it is a
// CORRECTNESS requirement", because trace scopes are run state and a server
// that re-ran the plan would resolve chains against a different run than the
// one it was describing.
//
// That was true, and Spec 9 made it false. It rested on the engine reading its
// configuration from module state, so a second plan in the process changed what
// the first one meant. The engine now takes a SimConfig as a value: two plans
// share nothing, and a re-run of the same spec is BYTE-IDENTICAL — same events,
// same amounts, same traceIds — so a chain resolved against a re-run is the
// same chain. Measured, not assumed; tests/mcp-stateless.mjs asserts it.
//
// The other half of the old argument also turns out to be wrong on inspection:
// `resetTraces()` REBINDS `_scopes = []` rather than emptying it, so a finished
// portfolio keeps its own array regardless of what runs later.
//
// So handles are now an honest cache. What is kept is the SPEC — a few KB of
// JSON — rather than the finished Portfolio, which for one Quick Start profile
// is 23,276 trace scopes and 12,290 events. A miss re-runs in ~36ms instead of
// erroring, which is the difference between a handle that expires and one that
// merely goes cold.
//
// Handles are CONTENT-ADDRESSED. The same plan always produces the same handle,
// so a client that runs the same report twice can keep using the handle it
// already has, and an agent that guesses a handle from an earlier transcript is
// right rather than unlucky.

import { createHash } from 'node:crypto';

/**
 * Finished runs held for speed only. Small, because a miss is cheap now — the
 * old cache held four because eviction meant a dead handle; this one holds two
 * because eviction means a 36ms re-run.
 */
const MAX_MEMO = 2;
const MEMO = new Map();

/**
 * handle → { spec, opts }. This is what makes a handle resolvable, and it is
 * the whole of the server's session state.
 */
const SPECS = new Map();

/** A handle that depends only on what was asked for. */
function handleFor(spec, opts) {
    const digest = createHash('sha1')
        .update(JSON.stringify({ spec, opts }))
        .digest('hex').slice(0, 10);
    return `plan_${digest}`;
}

function memoize(handle, result) {
    MEMO.set(handle, result);
    while (MEMO.size > MAX_MEMO) MEMO.delete(MEMO.keys().next().value);
}

/** Register a spec under its content-addressed handle. */
export function cacheRun(spec, opts, result) {
    const handle = handleFor(spec, opts);
    SPECS.set(handle, { spec, opts });
    if (result) memoize(handle, result);
    return handle;
}

/**
 * The run behind a handle, re-running it if it is no longer in memory.
 *
 * ASYNC, because a miss re-runs. Callers await it; the alternative was keeping
 * every finished run alive forever so this could stay synchronous, which is the
 * memory profile the change exists to remove.
 */
export async function getRun(handle) {
    const memo = MEMO.get(handle);
    if (memo) return memo;

    const known = SPECS.get(handle);
    if (!known) {
        const live = [...SPECS.keys()];
        throw new Error(
            `No run "${handle}". ${live.length
                ? `Known handles: ${live.join(', ')}.`
                : 'No plan has been run yet — call quick_start_report or run_plan first.'}`);
    }

    const result = await runPlan(known.spec, known.opts);
    memoize(handle, result);
    return result;
}

/** Run a plan and register it. Returns the handle alongside the result. */
export async function runPlanCached(spec, opts = {}) {
    const result = await runPlan(spec, opts);
    return { handle: cacheRun(spec, opts, result), ...result };
}

/** Test seam: forget every handle. */
export function clearRuns() {
    SPECS.clear();
    MEMO.clear();
}

/** Test seam: drop finished runs but keep the handles resolvable. */
export function evictMemo() {
    MEMO.clear();
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
