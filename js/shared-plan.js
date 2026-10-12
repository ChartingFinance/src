/**
 * shared-plan.js — opening a plan that arrived in a share link.
 *
 * Two steps, kept apart. `readSharedPlan` reads the whole payload and either
 * returns the plan or throws a reason a person can act on; it changes nothing.
 * `applySharedSettings` then writes the plan's settings to the settings store.
 *
 * The app reads a link when it arrives, so one that cannot be opened says why
 * in the import dialog before anything is applied. Reading while applying would
 * fail halfway through, and every setter persists: the user's own plan would
 * be left running on the link's settings.
 *
 * Settings are read by `planSettingsFrom()` (sim-config.js), the same reading
 * the MCP server runs a plan with. A setting the link leaves out takes the
 * engine's default, so the app opens a link on the settings its report used.
 *
 * DOM-free, so tests/share-link.mjs runs it on real links.
 */

import { planSettingsFrom } from './sim-config.js';
import { membrane_rawDataToModelAssets } from './membrane.js';
import { ModelLifeEvent } from './life-event.js';
import {
    global_setInflationRate,
    global_setFilingAs,
    global_setUserStartAge,
    global_setUserRetirementAge,
    global_setUserFinishAge,
    global_setBacktestYear,
    global_setGuardrailWithdrawalRate,
    global_setGuardrailPreservation,
    global_setGuardrailProsperity,
    global_setGuardrailAdjustment,
    global_default_guardrail_withdrawalRate,
    global_default_guardrail_preservation,
    global_default_guardrail_prosperity,
    global_default_guardrail_adjustment,
    setActiveTaxTable,
    makeActiveTaxTable,
} from './globals.js';

/**
 * A share payload, read into what the app opens.
 *
 * @param {object} payload what `decodeSharePayload()` returned
 * @returns {{settings, backtestYear, guardrailParams, modelAssets, lifeEvents, handle}}
 *   `lifeEvents` is null when the link carries none, and the app builds the
 *   default timeline from the ages once they are applied.
 * @throws {Error} a sentence saying why the link cannot be opened
 */
export function readSharedPlan(payload) {
    const settings = planSettingsFrom(payload);

    // The engine and the encoder both refuse a plan with no assets. Opening one
    // here would put its settings and phases under whatever plan is on screen.
    const rawAssets = payload?.modelAssets;
    if (!Array.isArray(rawAssets) || rawAssets.length === 0) {
        throw new Error('The link contains no assets.');
    }
    const modelAssets = readPart('An asset', () => membrane_rawDataToModelAssets(rawAssets));
    const lifeEvents = payload.lifeEvents?.length
        ? readPart('A life event', () => payload.lifeEvents.map(ModelLifeEvent.fromJSON))
        : null;

    return {
        settings,
        // Not one of the plan's settings: a link without it keeps the viewer's.
        backtestYear: payload.settings?.backtestYear ?? null,
        guardrailParams: payload.guardrailParams ? guardrailParamsFrom(payload.guardrailParams) : null,
        modelAssets,
        lifeEvents,
        handle: payload.handle ?? null,
    };
}

/**
 * Write a read plan's settings to the settings store, tax table included.
 *
 * Takes what `readSharedPlan` returned, so every value is one its setter
 * accepts.
 */
export function applySharedSettings({ settings, backtestYear, guardrailParams }) {
    global_setInflationRate(settings.inflationRate);
    global_setFilingAs(settings.filingAs);
    global_setUserStartAge(settings.startAge);
    global_setUserRetirementAge(settings.retirementAge);
    global_setUserFinishAge(settings.finishAge);
    if (backtestYear != null) global_setBacktestYear(backtestYear);
    setActiveTaxTable(makeActiveTaxTable());

    if (guardrailParams) {
        global_setGuardrailWithdrawalRate(guardrailParams.withdrawalRate);
        global_setGuardrailPreservation(guardrailParams.preservation);
        global_setGuardrailProsperity(guardrailParams.prosperity);
        global_setGuardrailAdjustment(guardrailParams.adjustment);
    }
}

/** Guardrail parameters, with any the link leaves out at the app's defaults. */
function guardrailParamsFrom(given) {
    return {
        withdrawalRate: given.withdrawalRate ?? global_default_guardrail_withdrawalRate,
        preservation:   given.preservation   ?? global_default_guardrail_preservation,
        prosperity:     given.prosperity     ?? global_default_guardrail_prosperity,
        adjustment:     given.adjustment     ?? global_default_guardrail_adjustment,
    };
}

/** Hydrate one part of the payload, saying which part when it cannot be read. */
function readPart(what, read) {
    try {
        return read();
    } catch (e) {
        throw new Error(`${what} in the link is incomplete or damaged (${e.message}).`, { cause: e });
    }
}
