/**
 * ui/util.js
 *
 * Helpers for persisting scenarios ("story arcs") in localStorage under
 * `<storyArc>+<storyName>` keys, plus date formatting and base64 JSON helpers.
 */

import { logger, LogCategory } from '../utils/logger.js';
import { findByName } from '../portfolio.js';

// ── Constants ──────────────────────────────────────────────────────────

export const storyArcsKey = 'storyArcs';
export const storyNamesKey = 'storyNames';

// ── Color Utility ──────────────────────────────────────────────────────

export const rgb2hex = (rgb) => `#${rgb.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/).slice(1).map(n => parseInt(n, 10).toString(16).padStart(2, '0')).join('')}`;

// ── Story Arc / Name Helpers ───────────────────────────────────────────

export function util_buildStoryArcKey(storyArc, storyName) {
    if (!storyArc)
        logger.log(LogCategory.STORAGE, 'util_buildStoryArcKey - null storyArc');
    if (!storyName)
        logger.log(LogCategory.STORAGE, 'util_buildStoryArcKey - null storyName');

    if (storyName == 'default') {
        logger.log(LogCategory.STORAGE, 'util_buildStoryArcKey - default passed to function. Did you call util_ensureStoryNames first?');
        storyName = util_YYYYmm();
    }

    return storyArc + '+' + storyName;
}

export function util_removeStoryName(storyArc, storyName) {
    const storyArcNamesKey = util_buildStoryArcKey(storyArc, storyNamesKey);
    let asString = localStorage.getItem(storyArcNamesKey);
    if (!asString)
        asString = '[]';

    let storyNames = JSON.parse(asString);

    let ii = 0;
    for (; ii < storyNames.length; ++ii) {
        if (storyNames[ii] == storyName)
            break;
    }

    if (ii < storyNames.length) {
        storyNames.splice(ii, 1);
        localStorage.setItem(storyArcNamesKey, JSON.stringify(storyNames));
    }
}

/**
 * Register `storyName` in the story arc's scenario list if not already present.
 * When appending to a non-empty list, seeds the new slot with a copy of the
 * previous scenario's saved asset array.
 */
export function util_ensureStoryNames(storyArc, storyName) {
    let storyArcNamesKey = util_buildStoryArcKey(storyArc, storyNamesKey);
    let asString = localStorage.getItem(storyArcNamesKey);
    if (!asString)
        asString = '[]';

    let storyNames = JSON.parse(asString);

    let ii = 0;
    for (; ii < storyNames.length; ++ii) {
        if (storyNames[ii] == storyName)
            break;
    }

    if (ii == storyNames.length) {
        storyNames.push(storyName);
        localStorage.setItem(storyArcNamesKey, JSON.stringify(storyNames));

        if (ii > 0) {
            let storyArcNameKey = util_buildStoryArcKey(storyArc, storyName)
            logger.log(LogCategory.STORAGE, () => 'util-ensureStoryNames - copy most recent dataset to ' + storyArcNameKey);
            let previousStoryArcNameKey = util_buildStoryArcKey(storyArc, storyNames[ii -1]);
            logger.log(LogCategory.STORAGE, () => 'util-ensureStoryNames - previous key to use ' + previousStoryArcNameKey);
            let previousStoryArcNameData = localStorage.getItem(previousStoryArcNameKey);
            localStorage.setItem(storyArcNameKey, previousStoryArcNameData);
        }
    }
}

// ── Local Storage Helpers ──────────────────────────────────────────────

export function util_saveLocalLifeEvents(storyArc, scenario, events) {
    const key = `lifeEvents_${storyArc}_${scenario}`;
    localStorage.setItem(key, JSON.stringify(events));
}

export function util_loadLocalLifeEvents(storyArc, scenario) {
    const key = `lifeEvents_${storyArc}_${scenario}`;
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
}

export function util_saveLocalAssetModels(storyArc, storyName, assetModels) {
    let key = util_buildStoryArcKey(storyArc, storyName);
    localStorage.setItem(key, JSON.stringify(assetModels));
}

export function util_loadLocalAssetModels(storyArc, storyName) {
    let key = util_buildStoryArcKey(storyArc, storyName);
    let assetModelsAsString = localStorage.getItem(key);
    if (assetModelsAsString)
        return JSON.parse(assetModelsAsString);
    else
        return null;
}

export function util_saveLocalGuardrailParams(storyArc, storyName, params) {
    const key = util_buildStoryArcKey(storyArc, storyName) + '+guardrails';
    localStorage.setItem(key, JSON.stringify(params));
}

export function util_loadLocalGuardrailParams(storyArc, storyName) {
    const key = util_buildStoryArcKey(storyArc, storyName) + '+guardrails';
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
}

// ── Scenario Metadata ─────────────────────────────────────────────────

export function util_saveLocalScenarioMeta(storyArc, storyName, meta) {
    const key = util_buildStoryArcKey(storyArc, storyName) + '+meta';
    localStorage.setItem(key, JSON.stringify(meta));
}

export function util_loadLocalScenarioMeta(storyArc, storyName) {
    const key = util_buildStoryArcKey(storyArc, storyName) + '+meta';
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
}

// Cached preview curve for the scenario menu: { series: number[], end: number, ts: number }.
// Stored separately from +meta so scenario title/note edits never clobber it.

export function util_saveLocalScenarioPreview(storyArc, storyName, preview) {
    const key = util_buildStoryArcKey(storyArc, storyName) + '+preview';
    localStorage.setItem(key, JSON.stringify(preview));
}

export function util_loadLocalScenarioPreview(storyArc, storyName) {
    const key = util_buildStoryArcKey(storyArc, storyName) + '+preview';
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
}

// The settings a scenario runs on — the settings row: { inflationRate, filingAs,
// startAge, retirementAge, finishAge, backtestYear }. See scenario-store.js.

export function util_saveLocalScenarioSettings(storyArc, storyName, settings) {
    const key = util_buildStoryArcKey(storyArc, storyName) + '+settings';
    localStorage.setItem(key, JSON.stringify(settings));
}

export function util_loadLocalScenarioSettings(storyArc, storyName) {
    const key = util_buildStoryArcKey(storyArc, storyName) + '+settings';
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
}

// The plan format a scenario was saved in (plan-ids.js PLAN_FORMAT); absent
// for a scenario saved before formats were numbered.

export function util_saveLocalPlanFormat(storyArc, storyName, format) {
    const key = util_buildStoryArcKey(storyArc, storyName) + '+format';
    localStorage.setItem(key, JSON.stringify(format));
}

export function util_loadLocalPlanFormat(storyArc, storyName) {
    const key = util_buildStoryArcKey(storyArc, storyName) + '+format';
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
}

export function util_loadStoryNames(storyArc) {
    const storyArcNamesKey = util_buildStoryArcKey(storyArc, storyNamesKey);
    const raw = localStorage.getItem(storyArcNamesKey);
    return raw ? JSON.parse(raw) : [];
}

export function util_deleteScenario(storyArc, storyName) {
    // Remove from story names list
    util_removeStoryName(storyArc, storyName);

    // Delete all associated keys
    const baseKey = util_buildStoryArcKey(storyArc, storyName);
    localStorage.removeItem(baseKey);                          // assets
    localStorage.removeItem(`lifeEvents_${storyArc}_${storyName}`); // life events
    localStorage.removeItem(baseKey + '+guardrails');           // guardrail params
    localStorage.removeItem(baseKey + '+meta');                 // scenario metadata
    localStorage.removeItem(baseKey + '+preview');              // cached preview curve
    localStorage.removeItem(baseKey + '+settings');             // settings row
    localStorage.removeItem(baseKey + '+format');               // plan format
}

export function util_loadFromStorage(key) {
    let data = localStorage.getItem(key);
    if (data)
        return JSON.parse(data);
    return null;
}

// ── Date Formatting ────────────────────────────────────────────────────

export function util_YYYYmm() {
    const date = new Date();
    const formattedDate = date.toISOString().split('T')[0];
    const segments = formattedDate.split('-');
    const resultDate = segments[0] + '-' + segments[1];
    return resultDate;
}

export function util_YYYYmmToDisplay(YYYYmm) {
    // Use day 02 so UTC midnight never shifts back into the previous month in western timezones.
    const date = new Date(YYYYmm + '-02');
    let options = { year: 'numeric', month: 'long' };
    return date.toLocaleDateString('en-US', options);
}

// ── JSON Encoding ──────────────────────────────────────────────────────

export function util_escapedJSONStringify(obj) {
    if (obj == null) {
        return null;
    }

    // Strip runtime model references before serializing to avoid circular JSON errors.
    for (let ii = 0; ii < obj.length; ++ii) {
        if (obj[ii].fromModel)
            delete obj[ii].fromModel;
        if (obj[ii].toModel)
            delete obj[ii].toModel;
    }

    return btoa(JSON.stringify(obj));
}

export function util_unescapedJSONParse(str) {
    return JSON.parse(atob(str));
}

// ── Legacy Alias ───────────────────────────────────────────────────────

export function util_findModelAssetByDisplayName(modelAssets, displayName) {
    return findByName(modelAssets, displayName);
}

// ── UUID / Cookie Helpers (unused legacy helpers) ──────────────────────

export function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

export function getOrCreateUniqueID() {
    let uniqueID = localStorage.getItem('uniqueID');
    if (!uniqueID) {
        uniqueID = generateUUID();
        localStorage.setItem('uniqueID', uniqueID);
    }
    return uniqueID;
}

export function setCookie(name, value, days) {
    const date = new Date();
    date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
    document.cookie = `${name}=${value};expires=${date.toUTCString()};path=/`;
}

export function getCookie(name) {
    const cookies = document.cookie.split('; ');
    for (const cookie of cookies) {
        const [key, value] = cookie.split('=');
        if (key === name) return value;
    }
    return null;
}

export function getOrCreateCookieID() {
    let uniqueID = getCookie('uniqueID');
    if (!uniqueID) {
        uniqueID = generateUUID();
        setCookie('uniqueID', uniqueID, 365);
    }
    return uniqueID;
}
