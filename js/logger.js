/**
 * logger.js
 *
 * Category-based logger with enum log levels.
 * Each category can be enabled/disabled independently.
 */

export const LogCategory = Object.freeze({
    GENERAL:    'GENERAL',
    INIT:       'INIT',
    MONTHLY:    'MONTHLY',
    YEARLY:     'YEARLY',
    TAX:        'TAX',
    TRANSFER:   'TRANSFER',
    CHARTING:   'CHARTING',
    SANITY:     'SANITY',
    STORAGE:    'STORAGE',
});

const _enabled = new Set([
    LogCategory.GENERAL,
]);

export class logger {

    /** Enable one or more categories */
    static enable(...categories) {
        for (const c of categories) _enabled.add(c);
    }

    /** Disable one or more categories */
    static disable(...categories) {
        for (const c of categories) _enabled.delete(c);
    }

    /** Enable every category */
    static enableAll() {
        for (const c of Object.values(LogCategory)) _enabled.add(c);
    }

    /** Disable every category */
    static disableAll() {
        _enabled.clear();
    }

    /** Check if a category is enabled */
    static isEnabled(category) {
        return _enabled.has(category);
    }

    /** Returns a copy of enabled categories */
    static enabledCategories() {
        return new Set(_enabled);
    }

    /**
     * Log a message under a category.
     * Falls back to GENERAL when called with a single argument (backward-compatible).
     */
    static log(messageOrCategory, message) {
        if (message === undefined) {
            // legacy single-arg call: logger.log('something')
            if (_enabled.has(LogCategory.GENERAL)) {
                console.log(messageOrCategory);
            }
            return;
        }
        if (_enabled.has(messageOrCategory)) {
            console.log(`[${messageOrCategory}] ${message}`);
        }
    }
}

// Expose on window for quick console toggling during debugging
if (typeof window !== 'undefined') {
    window.logger = logger;
    window.LogCategory = LogCategory;
}
