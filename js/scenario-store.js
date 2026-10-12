/**
 * scenario-store.js — what a scenario keeps, and the plan on screen that keeps
 * nothing.
 *
 * A scenario is a plan (its assets and life events) and what the plan runs on:
 * its guardrail parameters and its settings, the six in the settings row. Each
 * scenario keeps its own, so changing one scenario's settings, or saving a
 * shared plan as a new scenario, leaves every other scenario running on its
 * own.
 *
 * The settings in force are globals.js's, and they are the active scenario's:
 * saving a scenario records them with it, and switching to a scenario puts its
 * own back in force. That is why the Globals page, which sets the settings in
 * force, sets the active scenario's.
 *
 * A shared plan opened with Open, not Open & Save, is on screen without being a
 * scenario. While it is, nothing here writes, and globals.js holds its settings
 * in memory, so the viewer's stored plans and settings stay exactly as they
 * were. Anything written then would land on the viewer's active scenario: on
 * its plan, or on the settings in force, which are its settings.
 *
 * DOM-free, so tests/scenario-store.mjs runs it against a stand-in localStorage.
 */

import {
    global_inflationRate,
    global_filingAs,
    global_user_startAge,
    global_user_retirementAge,
    global_user_finishAge,
    global_backtestYear,
    global_setInflationRate,
    global_setFilingAs,
    global_setUserStartAge,
    global_setUserRetirementAge,
    global_setUserFinishAge,
    global_setBacktestYear,
    global_holdPlanSettings,
    global_releasePlanSettings,
    isFilingStatus,
    setActiveTaxTable,
    makeActiveTaxTable,
} from './globals.js';
import {
    util_YYYYmm,
    util_saveLocalAssetModels,
    util_saveLocalLifeEvents,
    util_saveLocalGuardrailParams,
    util_saveLocalScenarioPreview,
    util_saveLocalScenarioSettings,
    util_loadLocalScenarioSettings,
    util_loadStoryNames,
} from './ui/util.js';

/** The unsaved plan on screen, `{ title, note }`; null while a scenario is. */
let unsaved = null;

// ── A scenario's settings ───────────────────────────────────────────

/** The settings in force, as a scenario keeps them. */
export function settingsInForce() {
    return {
        inflationRate: global_inflationRate,
        filingAs: global_filingAs,
        startAge: global_user_startAge,
        retirementAge: global_user_retirementAge,
        finishAge: global_user_finishAge,
        backtestYear: global_backtestYear,
    };
}

/** Put a scenario's settings in force, tax table included. */
export function putSettingsInForce(settings) {
    global_setInflationRate(settings.inflationRate);
    global_setFilingAs(settings.filingAs);
    global_setUserStartAge(settings.startAge);
    global_setUserRetirementAge(settings.retirementAge);
    global_setUserFinishAge(settings.finishAge);
    global_setBacktestYear(settings.backtestYear);
    setActiveTaxTable(makeActiveTaxTable());
}

/**
 * Put a stored scenario's own settings back in force.
 *
 * Stored settings are untrusted, and the setters throw on a value they cannot
 * take, which would leave the switch half done. So a setting with no usable
 * value keeps the one in force.
 *
 * @returns {boolean} whether the scenario keeps settings of its own. One that
 *   keeps none runs on the settings in force.
 */
export function restoreScenarioSettings(storyArc, storyName) {
    const stored = util_loadLocalScenarioSettings(storyArc, storyName);
    if (!stored || typeof stored !== 'object') return false;

    const inForce = settingsInForce();
    const number = (field) => (Number.isFinite(stored[field]) ? stored[field] : inForce[field]);
    putSettingsInForce({
        inflationRate: number('inflationRate'),
        filingAs: isFilingStatus(stored.filingAs) ? stored.filingAs : inForce.filingAs,
        startAge: number('startAge'),
        retirementAge: number('retirementAge'),
        finishAge: number('finishAge'),
        backtestYear: stored.backtestYear != null ? String(stored.backtestYear) : inForce.backtestYear,
    });
    return true;
}

/**
 * Give each scenario saved before scenarios kept their own settings the ones
 * in force, which are the ones it has always run on.
 *
 * Runs when the app starts, before a share link is read: Open & Save puts the
 * link's settings in force, and a scenario stamped after that would keep the
 * link's settings as its own.
 *
 * @returns {string[]} the scenarios given settings
 */
export function stampScenarioSettings(storyArc) {
    if (unsaved) return [];
    const settings = settingsInForce();
    const stamped = [];
    for (const name of util_loadStoryNames(storyArc)) {
        if (util_loadLocalScenarioSettings(storyArc, name)) continue;
        util_saveLocalScenarioSettings(storyArc, name, settings);
        stamped.push(name);
    }
    return stamped;
}

// ── Saving ──────────────────────────────────────────────────────────

/**
 * Save the plan on screen as the scenario `storyName`, with the guardrail
 * parameters and settings in force, and as the month's snapshot of it.
 *
 * @param {{assets: Array, lifeEvents: Array, guardrails: object}} plan
 *   life events as JSON, assets as they serialise
 * @returns {boolean} false, with nothing written, while an unsaved plan is open
 */
export function saveScenario(storyArc, storyName, { assets, lifeEvents, guardrails }) {
    if (unsaved) return false;

    const settings = settingsInForce();
    util_saveLocalAssetModels(storyArc, storyName, assets);
    util_saveLocalLifeEvents(storyArc, storyName, lifeEvents);
    util_saveLocalGuardrailParams(storyArc, storyName, guardrails);
    util_saveLocalScenarioSettings(storyArc, storyName, settings);

    // Monthly snapshot — always overwritten, so it holds the month's last state.
    localStorage.setItem(`${storyName}@${util_YYYYmm()}`,
        JSON.stringify({ assets, lifeEvents, guardrails, settings }));
    return true;
}

/**
 * Save the preview curve the scenario menu draws for `storyName`.
 *
 * @returns {boolean} false, with nothing written, while an unsaved plan is open
 */
export function saveScenarioPreview(storyArc, storyName, preview) {
    if (unsaved) return false;
    util_saveLocalScenarioPreview(storyArc, storyName, preview);
    return true;
}

// ── The unsaved plan ────────────────────────────────────────────────

/**
 * Show a plan without saving it. Until it is closed nothing here writes, and
 * the settings put in force after this are held in memory, not stored.
 *
 * Opening one while another is open drops the other's settings first, so a
 * setting the new plan leaves alone is the viewer's, not the last plan's.
 *
 * @param {{title: string, note?: string}} about what the scenario menu calls it
 */
export function openUnsaved({ title, note = '' }) {
    if (unsaved) global_releasePlanSettings();
    global_holdPlanSettings();
    unsaved = { title, note };
}

/** The unsaved plan on screen, `{ title, note }`, or null while a scenario is. */
export function unsavedPlan() {
    return unsaved;
}

/**
 * Close the unsaved plan. Dropped, the default, its settings go and the
 * viewer's come back into force. Kept, its settings are stored as the ones in
 * force, for the caller to save the plan as a new scenario.
 */
export function closeUnsaved({ keep = false } = {}) {
    if (!unsaved) return;
    unsaved = null;
    global_releasePlanSettings({ keep });
}
