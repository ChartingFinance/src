/**
 * run-plan.js — the one way to run a plan outside the browser.
 *
 * ── Why this file exists ─────────────────────────────────────────────
 *
 * Running a plan is not just `new Portfolio(assets)` + `chronometer_run`. It is
 * a sequence, and each step matters:
 *
 *   1. build the config from the spec's settings — filingAs and the tax table
 *      included (`simConfigFromPlanSpec`)
 *   2. hydrate assets AND life events
 *   3. run
 *   4. read the issues back
 *
 * Every headless caller goes through runPlan(), so none can get the sequence
 * wrong: a caller that skipped a step once simulated an MFJ plan on Single
 * brackets and dropped the life events.
 *
 * ── The plan spec ────────────────────────────────────────────────────
 *
 * The same shape the app's Share link encodes, so a shared portfolio can be
 * run here and anything built here can be opened in the app:
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
 * It does not format anything. It returns the live Portfolio (traceScopes
 * included), so `explainEvent` can resolve chains against the run that
 * produced them.
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
import { computeMonteCarlo } from '../mc-compute.js';
import { ageToDateIntFor } from '../plan-dates.js';

/**
 * Build a plan spec from a Quick Start profile key.
 *
 * `ageOverrides` is passed into buildQuickStart, because asset dates and
 * life-event triggers are derived from the ages at build time.
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
 * Settings the spec leaves out take SIM_CONFIG_DEFAULTS. `filingAs` is
 * resolved first and handed to the TaxTable, so the two cannot disagree.
 * Nothing here writes to module state, so two plans in one process share
 * nothing.
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

        // Not carried by the share format, so taken from the defaults — a spec
        // must not inherit settings from an earlier caller.
        allocateHouseholdTax: D.allocateHouseholdTax,
        pensionWithholdingRate: D.pensionWithholdingRate,
        socialSecurityWithholdingRate: D.socialSecurityWithholdingRate,
        backtestYear: D.backtestYear,
        simDataMode: D.simDataMode,

        // Built from the resolved status.
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

    // `reports` = true (the second argument): it fills `generatedReports`,
    // which the markdown report's Annual Cash Flow table and the monthly
    // packages are built from. Without it those sections are silently empty.
    const portfolio = new Portfolio(assets, true, config);

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

// ── Monte Carlo ──────────────────────────────────────────────────────
//
// Outside runPlan and outside the handle cache. Monte Carlo uses an unseeded
// `Math.random()`, while a cached run is re-run on a miss and must come out
// byte-identical (tests/mcp-stateless.mjs). So it is a separate, uncached call.
//
// No Web Worker: the computation (mc-compute.js) is headless; monte-carlo.js is
// only the browser's transport.

/**
 * Run Monte Carlo over a plan spec, headless.
 *
 * @param {object} spec   the same plan spec runPlan takes
 * @param {object} [opts]
 * @param {number} [opts.numSimulations]
 * @returns {Promise<object>} results, JSON-serializable (see mc-compute.js)
 */
export async function runMonteCarloFor(spec, { numSimulations = 500 } = {}) {
    if (!spec?.modelAssets?.length) {
        throw new Error('Plan spec has no modelAssets — nothing to simulate.');
    }

    const config = simConfigFromPlanSpec(spec);
    const assets = membrane_rawDataToModelAssets(spec.modelAssets);
    const lifeEvents = (spec.lifeEvents ?? []).map(ModelLifeEvent.fromJSON);

    return computeMonteCarlo(assets, {
        numSimulations,
        lifeEvents,
        config,
        // A spec that carries no guardrail parameters must not silently acquire
        // a withdrawal policy: that would change the plan, not just describe it.
        guardrailParams: spec.guardrailParams ?? null,
        retirementDateInt: ageToDateIntFor(config, config.retirementAge),
        dataMode: config.simDataMode ?? SIM_CONFIG_DEFAULTS.simDataMode,
    });
}

// ── Run handles ──────────────────────────────────────────────────────
//
// A handle is a cache key, not a session. Re-running a spec is byte-identical
// (same events, amounts and traceIds; tests/mcp-stateless.mjs), so the server
// keeps each handle's spec — a few KB — and re-runs a finished run on a cache
// miss (tens of milliseconds) rather than holding every Portfolio.
//
// Handles are content-addressed: the same plan always gets the same handle.

import { createHash } from 'node:crypto';

/** Finished runs held for speed only; small, because a miss just re-runs. */
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
 * The SPEC behind a handle, without running anything.
 *
 * For callers that need the plan, not results — a share link — so they never
 * trigger a re-run.
 */
export function specForHandle(handle) {
    const known = SPECS.get(handle);
    if (!known) {
        const live = [...SPECS.keys()];
        throw new Error(
            `No run "${handle}". ${live.length
                ? `Known handles: ${live.join(', ')}.`
                : 'No plan has been run yet — call quick_start_report or run_plan first.'}`);
    }
    return known.spec;
}

/**
 * The run behind a handle, re-running it if it is no longer in memory.
 *
 * Async, because a miss re-runs.
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
