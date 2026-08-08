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
    setActiveTaxTable, asFilingStatus,
    global_reset, global_initialize,
    global_setInflationRate, global_getInflationRate,
    global_setFilingAs, global_getFilingAs,
    global_setUserStartAge, global_getUserStartAge,
    global_setUserRetirementAge, global_getUserRetirementAge,
    global_setUserFinishAge, global_getUserFinishAge,
    global_default_inflationRate, global_default_filingAs,
} from '../globals.js';

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
 * Apply a spec's settings to the module-level globals.
 *
 * Resets FIRST. These are module state shared by every plan this process runs,
 * and a server handling two plans in sequence would otherwise leak the first
 * one's filing status and inflation into the second — the same hazard as a Web
 * Worker booting on defaults, and the reason global_workerSnapshot() exists.
 */
function applySettings(settings = {}) {
    global_reset();

    const inflationRate = settings.inflationRate ?? global_default_inflationRate;
    global_setInflationRate(inflationRate);
    global_getInflationRate();

    // Untrusted: a spec can arrive from an agent or an old share URL. Coerce
    // rather than throw, matching how the app treats an imported portfolio.
    global_setFilingAs(asFilingStatus(settings.filingAs, global_default_filingAs));
    global_getFilingAs();

    if (settings.startAge != null)      { global_setUserStartAge(settings.startAge);           global_getUserStartAge(); }
    if (settings.retirementAge != null) { global_setUserRetirementAge(settings.retirementAge); global_getUserRetirementAge(); }
    if (settings.finishAge != null)     { global_setUserFinishAge(settings.finishAge);         global_getUserFinishAge(); }

    // AFTER filingAs. TaxTable.initializeChron() reads global_filingAs at
    // construction and throws on an unknown one; building it earlier would
    // silently pin the previous plan's tables.
    setActiveTaxTable(new TaxTable());
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

    applySettings(spec.settings);

    const assets = membrane_rawDataToModelAssets(spec.modelAssets);

    const portfolio = new Portfolio(assets, false);

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
