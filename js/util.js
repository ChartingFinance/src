/**
 * util.js - ES6 Module
 *
 * Utility functions for storage, story arcs, cookies, JSON encoding,
 * and other helpers. Extracted from util-compat.js (duplicates removed).
 */

import { logger } from './logger.js';
import { findByName } from './asset-queries.js';

// ── Constants ──────────────────────────────────────────────────────────

export const storyArcsKey = 'storyArcs';
export const storyNamesKey = 'storyNames';

// ── Color Utility ──────────────────────────────────────────────────────

export const rgb2hex = (rgb) => `#${rgb.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/).slice(1).map(n => parseInt(n, 10).toString(16).padStart(2, '0')).join('')}`;

// ── Story Arc / Name Helpers ───────────────────────────────────────────

export function util_buildStoryArcKey(storyArc, storyName) {
    if (!storyArc)
        logger.log('util_buildStoryArcKey - null storyArc');
    if (!storyName)
        logger.log('util_buildStoryArcKey - null storyName');

    if (storyName == 'default') {
        logger.log('util_buildStoryArcKey - default passed to function. Did you call util_ensureStoryNames first?');
        storyName = util_YYYYmm();
    }

    return storyArc + '+' + storyName;
}

export function util_removeStoryName(storyArc, storyName) {
    let asString = localStorage.getItem(util_buildStoryArcKey(storyArc, storyNamesKey));
    if (!asString)
        asString = '[]';

    let storyNames = JSON.parse(asString);

    let ii = 0;
    for (; ii < storyNames.length; ++ii) {
        if (storyNames[ii] == storyName)
            break;
    }

    if (ii < storyNames.length) {
        storyNames = storyNames.splice(ii, 1);
        asString = JSON.stringify(storyNames);
        localStorage.setItem(storyNamesKey, asString);
    }
}

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
            logger.log('util-ensureStoryNames - copy most recent dataset to ' + storyArcNameKey);
            let previousStoryArcNameKey = util_buildStoryArcKey(storyArc, storyNames[ii -1]);
            logger.log('util-ensureStoryNames - previous key to use ' + previousStoryArcNameKey);
            let previousStoryArcNameData = localStorage.getItem(previousStoryArcNameKey);
            localStorage.setItem(storyArcNameKey, previousStoryArcNameData);
        }
    }
}

// ── Local Storage Helpers ──────────────────────────────────────────────

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
    const date = new Date(YYYYmm + '-02');
    let options = { year: 'numeric', month: 'long' };
    return date.toLocaleDateString('en-US', options);
}

// ── JSON Encoding ──────────────────────────────────────────────────────

export function util_escapedJSONStringify(obj) {
    if (obj == null) {
        return null;
    }

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

// ── UUID / Cookie Helpers ──────────────────────────────────────────────

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
