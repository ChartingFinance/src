/**
 * filing-status.js — the filing-status vocabulary, on its own.
 *
 * A frozen enum and two pure predicates, kept out of globals.js so sim-config.js
 * can validate a status without importing the settings store (globals.js
 * re-exports them).
 *
 * One vocabulary: 'Single' and 'MFJ'. FILING_TYPE_KEY in taxes.js maps them to
 * the tax tables' own keys, and an unknown status is rejected rather than
 * falling through to joint filing.
 */

import { logger, LogCategory } from './utils/logger.js';

export const FilingStatus = Object.freeze({
    SINGLE: 'Single',
    MARRIED_FILING_JOINTLY: 'MFJ',
});

export const FILING_STATUSES = Object.freeze(Object.values(FilingStatus));

export function isFilingStatus(value) {
    return FILING_STATUSES.includes(value);
}

/**
 * Coerce UNTRUSTED input — localStorage, an imported portfolio — to a known
 * status, falling back rather than throwing. Code paths should call
 * global_setFilingAs directly and get an exception if they are wrong.
 */
export function asFilingStatus(value, fallback = FilingStatus.SINGLE) {
    if (isFilingStatus(value)) return value;
    if (value != null) {
        logger.log(LogCategory.GENERAL,
            `unrecognised filing status ${JSON.stringify(value)} — using ${fallback}`);
    }
    return fallback;
}
