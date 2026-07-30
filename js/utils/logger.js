/**
 * logger.js
 *
 * Category-based logging with pluggable sinks.
 *
 * ── Why this was dead, and why it is not just uncommented ────────────
 *
 * The whole body of this file sat commented out behind
 * `// TODO: move off of console.log because we will try mcp-server over stdio`.
 * That TODO was RIGHT, not an excuse: `js/mcp/mcp-server.js` speaks MCP over
 * `StdioServerTransport`, which owns **stdout** for JSON-RPC. A single
 * `console.log` from deep inside the engine corrupts that protocol.
 *
 * So the fix is a SINK, not a console call. The default sink is chosen by
 * environment:
 *
 *   browser  → console.log
 *   Node     → process.stderr  (NEVER stdout — see above)
 *
 * The cost of leaving it dead was high and hidden. `monthlySanityCheck` spent
 * months reporting that the engine's own books did not balance — 293 findings
 * across five healthy scenarios — into a function with an empty body. The only
 * reason anyone found out was a probe that re-implemented the check to see its
 * output. Correct checks that report nowhere are indistinguishable from checks
 * that pass.
 *
 * ── Volume ───────────────────────────────────────────────────────────
 *
 * SANITY fires per month per portfolio. A 666-month plan with a real problem
 * can emit thousands of lines, which will lock a browser tab. Output is capped
 * (MAX_LINES) with a single notice when the cap is hit; `logger.reset()` clears
 * it and `chronometer_run` calls that at the start of every run.
 *
 * ── Categories are opt-in ────────────────────────────────────────────
 *
 * Only GENERAL is enabled by default. SANITY — the engine's own reconciliation
 * verdict — is switched on by the app when `global_showEngineDiagnostics` is
 * set, the same advanced flag that reveals the reconciliation category in the
 * issues panel. This module deliberately does NOT import globals.js: the app
 * wires that, so the logger stays dependency-free and trivially testable.
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
     * Exists so tests stop monkey-patching `logger.log` — several probes did
     * exactly that, which breaks silently the moment the signature changes.
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
