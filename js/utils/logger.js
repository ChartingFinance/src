/**
 * logger.js
 *
 * Category-based logging with pluggable sinks.
 *
 * ── Sinks ────────────────────────────────────────────────────────────
 *
 * Output goes to a sink chosen by environment:
 *
 *   browser  → console.log
 *   Node     → process.stderr  (never stdout: mcp-server.js speaks MCP over
 *              stdio, and anything else on stdout corrupts the protocol)
 *
 * tests/logger-alive.mjs asserts the logger actually emits: a silent logger
 * and a passing check look the same.
 *
 * ── Volume ───────────────────────────────────────────────────────────
 *
 * SANITY can fire every month, enough to lock a browser tab. Output is capped
 * (MAX_LINES) with one notice at the cap; `chronometer_run` calls
 * `logger.reset()` at the start of every run.
 *
 * ── Categories are opt-in ────────────────────────────────────────────
 *
 * Only GENERAL is on by default. The app turns SANITY (the engine's
 * reconciliation findings) on with `global_showEngineDiagnostics`; this module
 * imports nothing, so the app does the wiring.
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

const _enabled = new Set([LogCategory.GENERAL]);

/** Ceiling per run. A runaway SANITY stream must not freeze the UI. */
const MAX_LINES = 5000;
let _emitted = 0;
let _cappedNoticeSent = false;

/**
 * Default sink. In Node this MUST avoid stdout: mcp-server.js runs MCP over
 * stdio, and anything on stdout that is not JSON-RPC breaks the transport.
 */
function defaultSink(category, message) {
    const line = `[${category}] ${message}`;
    const isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined';
    if (isBrowser) {
        console.log(line);
    } else if (typeof process !== 'undefined' && process.stderr) {
        process.stderr.write(line + '\n');
    } else {
        console.log(line);
    }
}

const _sinks = [defaultSink];

function emit(category, text) {
    for (const sink of _sinks) {
        try {
            sink(category, text);
        } catch {
            // A broken sink must never take a simulation down with it.
        }
    }
}

export class logger {

    // ── Sinks ────────────────────────────────────────────────────────

    /** Add a sink `(category, message) => void`. Returns a remover. */
    static addSink(fn) {
        _sinks.push(fn);
        return () => {
            const i = _sinks.indexOf(fn);
            if (i !== -1) _sinks.splice(i, 1);
        };
    }

    /** Drop every sink, including the default. Mostly for tests. */
    static clearSinks() {
        _sinks.length = 0;
    }

    /** Restore the environment-appropriate default sink. */
    static useDefaultSink() {
        _sinks.length = 0;
        _sinks.push(defaultSink);
    }

    /**
     * Collect output instead of printing it, for tests and probes. Replaces the
     * sinks for the duration; `stop()` restores the default.
     *
     * Use this rather than monkey-patching `logger.log`.
     *
     * @param {string} [category] only capture this category
     * @returns {{lines: Array<{category: string, message: string}>, stop: Function}}
     */
    static capture(category = null) {
        const lines = [];
        logger.clearSinks();
        const remove = logger.addSink((cat, msg) => {
            if (category == null || cat === category) lines.push({ category: cat, message: msg });
        });
        return {
            lines,
            stop() { remove(); logger.useDefaultSink(); },
        };
    }

    // ── Categories ───────────────────────────────────────────────────

    static enable(...categories)  { for (const c of categories) _enabled.add(c); }
    static disable(...categories) { for (const c of categories) _enabled.delete(c); }
    static enableAll()  { for (const c of Object.values(LogCategory)) _enabled.add(c); }
    static disableAll() { _enabled.clear(); }
    static isEnabled(category) { return _enabled.has(category); }
    static enabledCategories() { return new Set(_enabled); }

    // ── Emission ─────────────────────────────────────────────────────

    /** Clear the per-run output cap. Called by chronometer_run. */
    static reset() {
        _emitted = 0;
        _cappedNoticeSent = false;
    }

    /**
     * Log a message under a category. Called with one argument, falls back to
     * GENERAL for backward compatibility with legacy call sites.
     */
    static log(messageOrCategory, message) {
        const category = message === undefined ? LogCategory.GENERAL : messageOrCategory;
        const text     = message === undefined ? messageOrCategory : message;

        if (!_enabled.has(category)) return;
        if (_sinks.length === 0) return;

        if (_emitted >= MAX_LINES) {
            if (!_cappedNoticeSent) {
                _cappedNoticeSent = true;
                emit(LogCategory.GENERAL,
                    `log output capped at ${MAX_LINES} lines for this run; further messages suppressed`);
            }
            return;
        }
        _emitted++;
        emit(category, text);
    }
}

// Expose on window for quick console toggling during debugging.
if (typeof window !== 'undefined') {
    window.logger = logger;
    window.LogCategory = LogCategory;
}
