/**
 * layer-boundary.mjs
 *
 * The simulation engine does not depend on a browser.
 *
 * ── Why this test exists ─────────────────────────────────────────────
 *
 * There are three layers in this repo whether or not anyone names them:
 * an engine that computes, a UI that presents, and an MCP server that
 * answers questions about a run. The engine is already almost clean —
 * portfolio.js, chronometer.js, taxes.js, model-asset.js and the four
 * files under engines/ import nothing but each other, utils/ and
 * globals.js. Not one of them touches the DOM.
 *
 * "Almost" is the problem. Nothing enforced it, so the boundary held by
 * habit, and habit is not a constraint. `js/mcp/polyfill.js` exists
 * because the engine reads its configuration out of localStorage — the
 * headless caller has to fake a browser storage API to tell the engine
 * its own filing status. That is the one real leak, and it got there
 * without anyone deciding to add it.
 *
 * ── The manifest is DERIVED, not written down ────────────────────────
 *
 * A hand-maintained list of "core files" rots the first time someone
 * adds a module, and a rotted allowlist passes while asserting nothing —
 * the failure mode this codebase keeps rediscovering. So core is not
 * declared here. It is COMPUTED: the transitive closure of relative
 * imports from the headless entry points below. Whatever `runPlan()`
 * actually needs in order to run IS the engine, by definition.
 *
 * That makes the test self-maintaining in the direction that matters.
 * Import a UI module from an engine module and the closure grows to
 * include it, and the browser scan then fails on it. You cannot widen
 * the engine by accident.
 *
 * ── The exemption list is empty, and that is the result ──────────────
 *
 * `globals.js` was the one entry, because engine configuration was
 * mirrored out of localStorage. Spec 9 removed that: the engine takes a
 * SimConfig as a value, and globals.js is now the browser-side settings
 * store that nothing on the run path imports.
 *
 * The entry was written as a work item rather than a description, and the
 * obsolescence check below is why that mattered — it FAILED the moment the
 * exemption stopped being needed, so the migration announced its own
 * completion instead of waiting for someone to notice.
 *
 * Do not add an entry to make a change pass. One here means "the engine
 * needs a browser", which is the exact claim this file exists to refute.
 *
 * Usage:  node tests/layer-boundary.mjs   (from src/)
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const rel = (abs) => relative(SRC, abs).split(sep).join('/');

/**
 * Headless entry points. `run-plan.js` is the canonical one — it is the
 * single supported way to run a plan outside the browser, so its closure
 * is the engine. The other two are named directly so that deleting
 * run-plan.js could never silently empty this test.
 */
const ENTRY_POINTS = [
    'js/mcp/run-plan.js',
    'js/chronometer.js',
    'js/portfolio.js',
];

/**
 * Files the closure is allowed to reach that DO touch a browser.
 * See the module comment. This list shrinks to empty; it never grows.
 */
const EXEMPT = new Map([
    // EMPTY, as of Spec 9 step 6 (2026-08-28). `js/globals.js` was the one
    // entry: the engine read its configuration out of localStorage, and this
    // list existed to say so out loud until that stopped being true.
    //
    // It stopped. The engine takes a SimConfig as a value, globals.js is the
    // browser-side settings store and nothing on the run path imports it — a
    // full plan, report and causal chain run with no localStorage defined at
    // all. The check below turned this from a description into a deadline: it
    // FAILED once the exemption stopped being needed, which is how the
    // migration reported its own completion rather than waiting to be believed.
    //
    // Adding an entry here means "the engine needs a browser". Do not.
]);

/**
 * Browser and worker globals. `self.` and `postMessage` are here because
 * the Web Worker adapters (mc-worker.js, simulator.js) are host code, not
 * engine code, and an engine file reaching for them is the same mistake
 * as reaching for `document`.
 */
const BROWSER_GLOBALS = [
    /\bdocument\s*\./,
    /\bwindow\s*\./,
    /\blocalStorage\b/,
    /\bsessionStorage\b/,
    /\bcustomElements\b/,
    /\bHTMLElement\b/,
    /\bnavigator\s*\./,
    /\brequestAnimationFrame\b/,
    /\bself\s*\.\s*postMessage\b/,
    /\bself\s*\.\s*onmessage\b/,
    /\balert\s*\(/,
];

/** Bare specifiers an engine file may import. Node builtins only. */
const ALLOWED_BARE = /^node:/;

/**
 * A host-feature guard: `typeof window !== 'undefined'` and friends.
 *
 * The rule this test enforces is not "never write the word window". It is
 * that the engine may not ASSUME a host. Detecting one and adapting is how
 * a portable module is written — utils/logger.js picks console.log in a
 * browser and process.stderr under Node precisely so the MCP server's
 * stdio transport is not corrupted, and that is the behaviour we want,
 * not a violation to be exempted away.
 *
 * So access is a violation only when UNGUARDED. A guard opens a region
 * that runs to the end of its block; access inside it is fine.
 */
const GUARD = /typeof\s+(window|self|document|localStorage|process|navigator)\s*[!=]==?\s*['"]undefined['"]/;

/**
 * Line numbers covered by a host guard, by brace-tracking from each guard
 * to the end of the block it opens. Approximate on purpose — it only has
 * to be good enough to tell adaptation from assumption.
 */
function guardedLines(code) {
    const lines = code.split('\n');
    const covered = new Set();

    lines.forEach((line, idx) => {
        if (!GUARD.test(line)) return;
        covered.add(idx + 1);
        // A guard with no brace on its line guards only that line
        // (the ternary and early-return forms).
        let depth = 0, opened = false;
        for (let i = idx; i < lines.length; i++) {
            for (const ch of lines[i]) {
                if (ch === '{') { depth++; opened = true; }
                else if (ch === '}') depth--;
            }
            covered.add(i + 1);
            if (opened && depth <= 0) break;
            if (!opened && i > idx) break;
        }
    });
    return covered;
}

// ── Reading source without reading comments ──────────────────────────

/**
 * Strip comments, keeping string literals and line numbering intact.
 *
 * Not fussiness. A first pass at this test flagged tax-engine.js,
 * metric.js and rule-notes.js as browser-coupled on the strength of the
 * phrase "basis window" and "month window" in their prose, and cleared
 * charting.js — which imports Chart.js — because its coupling is an
 * import rather than a global. A scanner that reads comments produces
 * both false positives and false confidence.
 *
 * Strings survive this pass because the import specifier IS a string.
 * An earlier version stripped both at once and computed a two-file
 * "engine" — every `from '...'` had been erased before it was read, and
 * the closure silently collapsed. `blankStrings` handles the other half.
 */
function stripComments(source) {
    let out = '';
    let i = 0;
    const n = source.length;
    let state = 'code';
    let quote = '';

    while (i < n) {
        const c = source[i];
        const next = source[i + 1];

        if (state === 'code') {
            if (c === '/' && next === '/') { state = 'line'; i += 2; continue; }
            if (c === '/' && next === '*') { state = 'block'; i += 2; continue; }
            if (c === '"' || c === "'" || c === '`') { state = 'string'; quote = c; }
            out += c; i++; continue;
        }
        if (state === 'line') {
            if (c === '\n') { state = 'code'; out += '\n'; }
            i++; continue;
        }
        if (state === 'block') {
            if (c === '*' && next === '/') { state = 'code'; i += 2; continue; }
            if (c === '\n') out += '\n';
            i++; continue;
        }
        // inside a string: copy through so the specifier survives
        out += c;
        if (c === '\\') { out += next ?? ''; i += 2; continue; }
        if (c === quote) { state = 'code'; quote = ''; }
        i++;
    }
    return out;
}

/**
 * Blank the CONTENTS of string literals, preserving line count.
 *
 * Run only for the browser-global scan, so that a message or a
 * localStorage key name mentioned in a string is not mistaken for a call.
 */
function blankStrings(code) {
    let out = '';
    let i = 0;
    let quote = '';

    while (i < code.length) {
        const c = code[i];
        if (!quote) {
            if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
            out += c; i++; continue;
        }
        if (c === '\\') { i += 2; continue; }
        if (c === quote) { quote = ''; out += c; i++; continue; }
        if (c === '\n') out += '\n';
        i++;
    }
    return out;
}

/** Every specifier this file imports or re-exports. */
function importsOf(code) {
    const found = [];
    // `import ... from 'x'`, `export ... from 'x'`, bare `import 'x'`
    const staticRe = /(?:^|\n)\s*(?:import|export)\b[^;'"]*?from\s*['"]([^'"]+)['"]/g;
    const bareRe   = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
    const dynRe    = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const re of [staticRe, bareRe, dynRe]) {
        let m;
        while ((m = re.exec(code)) !== null) found.push(m[1]);
    }
    return found;
}

// ── Build the closure ────────────────────────────────────────────────

const closure = new Map();   // path -> { code, importers: Set }
const bareHits = [];         // { from, specifier }
const missing  = [];         // { from, specifier }

function visit(absPath, importer) {
    const key = rel(absPath);
    if (closure.has(key)) {
        closure.get(key).importers.add(importer);
        return;
    }
    let raw;
    try {
        raw = readFileSync(absPath, 'utf8');
    } catch {
        missing.push({ from: importer, specifier: key });
        return;
    }
    const code = stripComments(raw);
    closure.set(key, { code, scan: blankStrings(code), importers: new Set(importer ? [importer] : []) });

    for (const spec of importsOf(code)) {
        if (spec.startsWith('.')) {
            visit(resolve(dirname(absPath), spec), key);
        } else if (!ALLOWED_BARE.test(spec)) {
            bareHits.push({ from: key, specifier: spec });
        }
    }
}

for (const entry of ENTRY_POINTS) visit(resolve(SRC, entry), null);

// The MCP layer is the caller, not the engine. Its own files ride along
// in the closure because run-plan.js is an entry point; exclude them from
// the engine assertions but keep them honest about the DOM anyway.
const isMcp = (p) => p.startsWith('js/mcp/');
const engineFiles = [...closure.keys()].filter(p => !isMcp(p)).sort();

// ── Harness ──────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function check(label, fn) {
    try { fn(); console.log(`  ✓ ${label}`); passed++; }
    catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

console.log('\n── The engine does not depend on a browser ──\n');

check('the closure is non-trivial — this test is actually looking at the engine', () => {
    assert.ok(engineFiles.length >= 25,
        `closure has only ${engineFiles.length} engine files; entry points may be wrong`);
    for (const must of ['js/portfolio.js', 'js/chronometer.js', 'js/taxes.js',
                        'js/model-asset.js', 'js/engines/tax-engine.js']) {
        assert.ok(closure.has(must), `expected ${must} in the engine closure`);
    }
});

check('every relative import in the closure resolves to a real file', () => {
    assert.deepEqual(missing, [],
        'unresolved imports: ' + missing.map(m => `${m.specifier} (from ${m.from})`).join(', '));
});

check('no engine file touches a browser or worker global', () => {
    const violations = [];
    for (const path of engineFiles) {
        if (EXEMPT.has(path)) continue;
        const scan = closure.get(path).scan;
        const guarded = guardedLines(closure.get(path).code);  // strings intact: the guard names 'undefined'
        scan.split('\n').forEach((line, i) => {
            if (guarded.has(i + 1)) return;
            for (const re of BROWSER_GLOBALS) {
                if (re.test(line)) {
                    violations.push(`${path}:${i + 1}  ${re.source}  ${line.trim().slice(0, 60)}`);
                    break;
                }
            }
        });
    }
    assert.deepEqual(violations, [],
        `engine files reaching for the browser:\n      ` + violations.join('\n      '));
});

check('the engine imports no third-party package', () => {
    const engineBare = bareHits.filter(h => !isMcp(h.from));
    assert.deepEqual(engineBare, [],
        'bare imports: ' + engineBare.map(h => `${h.specifier} (from ${h.from})`).join(', '));
});

check('no engine file imports the UI or component layer', () => {
    const bad = engineFiles.filter(p => p.startsWith('js/components/') || p.startsWith('js/ui/'));
    assert.deepEqual(bad, [],
        'presentation modules pulled into the engine: ' + bad.join(', ') +
        (bad.length ? '\n      imported by: ' +
            bad.map(p => [...closure.get(p).importers].join(', ')).join(' | ') : ''));
});

check('util.js is host code and stays out of the engine', () => {
    // It holds every localStorage scenario read/write and the cookie helpers,
    // and finplan-app.js is its only importer. It lived under utils/ purely by
    // filing accident; if it ever reappears here, persistence has leaked in.
    assert.ok(!closure.has('js/ui/util.js'),
        'js/ui/util.js is in the engine closure, imported by: ' +
        (closure.get('js/ui/util.js') ? [...closure.get('js/ui/util.js').importers].join(', ') : '?'));
    assert.ok(!closure.has('js/utils/util.js'), 'js/utils/util.js should no longer exist');
});

console.log('\n── The shipped HTML pages call the engine correctly ──\n');

check('no page constructs an engine object with the arity it used to have', () => {
    // Narrow on purpose, and added because it happened.
    //
    // Spec 9 step 6 made TaxTable's arguments required. The migration script
    // that rewrote 57 construction sites globbed `--include=*.js --include=*.mjs`
    // and never saw globals.html, whose inline module script had one. The page
    // then threw on load, so its change listeners were never attached — the
    // Globals settings page silently stopped SAVING ANYTHING, and the whole
    // suite stayed green because nothing here loads an HTML page.
    //
    // This does not test the pages. It catches the one class of breakage a
    // JS-only sweep leaves behind: a shipped page calling a constructor whose
    // signature moved underneath it.
    const pages = readdirSync(SRC).filter(f => f.endsWith('.html'));
    assert.ok(pages.length >= 5, `expected the shipped pages, found ${pages.length}`);

    const violations = [];
    for (const page of pages) {
        const code = stripComments(readFileSync(resolve(SRC, page), 'utf8'));

        for (const m of code.matchAll(/new TaxTable\(\s*\)/g)) {
            violations.push(`${page}: ${m[0]} — needs (filingAs, propertyTaxDeductionMax); `
                + `use makeActiveTaxTable()`);
        }
        for (const m of code.matchAll(/new Portfolio\(([^)]*)\)/g)) {
            if (m[1].split(',').length < 3) {
                violations.push(`${page}: ${m[0].slice(0, 44)} — needs a SimConfig as its third argument`);
            }
        }
    }
    assert.deepEqual(violations, [], '\n      ' + violations.join('\n      '));
});


console.log('\n── The exemption list is the migration backlog ──\n');

check('the exemption list is empty — the engine needs no browser at all', () => {
    assert.deepEqual([...EXEMPT.keys()], [],
        'an exemption means someone made the engine need a browser to pass a test');
});

check('every exemption is real — an obsolete one must be deleted, not kept', () => {
    for (const [path, why] of EXEMPT) {
        assert.ok(closure.has(path), `${path} is exempt but not in the closure — delete the entry`);
        const scan = closure.get(path).scan;
        const guarded = guardedLines(closure.get(path).code);  // strings intact: the guard names 'undefined'
        const stillCoupled = scan.split('\n').some((line, i) =>
            !guarded.has(i + 1) && BROWSER_GLOBALS.some(re => re.test(line)));
        assert.ok(stillCoupled,
            `${path} no longer touches a browser. The migration landed — remove its exemption.\n` +
            `      (was: ${why})`);
    }
});

// ── Report ───────────────────────────────────────────────────────────

console.log(`\n  engine closure: ${engineFiles.length} files, `
          + `${EXEMPT.size} exempt (${[...EXEMPT.keys()].join(', ')})`);

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
