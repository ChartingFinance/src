/**
 * filing-status.js — the filing-status vocabulary, on its own.
 *
 * Lifted out of globals.js by Spec 9 step 1. It is a frozen enum and two pure
 * predicates: no module state, no localStorage, nothing to reset between runs.
 * It only ever lived in globals.js because that is where the setting that uses
 * it lives.
 *
 * The move matters for one specific reason. `sim-config.js` has to validate a
 * filing status, and §4.6 of the spec requires that the engine-side config type
 * import nothing from globals.js — otherwise globals.js can never leave the
 * engine's import closure and the `tests/layer-boundary.mjs` exemption can never
 * be deleted, which is the signal that says the migration is finished. Getting
 * that right at creation is cheaper than unpicking it at step 6.
 *
 * globals.js re-exports all of this, so every existing importer is unaffected.
 *
 * ── The vocabulary is deliberately small ─────────────────────────────
 *
 * There used to be three spellings: 'Single' here, 'MFJ' in the settings
 * <select>, and "single" / "married" as the filingType keys inside the tax
 * tables — with `global_filingAs != 'Single'` as the only branch that read any
 * of them. MFJ therefore worked by falling through an else, which means a
 * corrupted localStorage value or a future 'MFS' option would have silently
 * filed the household jointly. FILING_TYPE_KEY in taxes.js maps these to the
 * table keys, so the table vocabulary stays an implementation detail of the
 * tables.
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
