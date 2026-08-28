/**
 * pages-smoke.mjs
 *
 * The shipped HTML pages load, and their scripts still match the code.
 *
 * ── Why this test exists ─────────────────────────────────────────────
 *
 * Six pages ship to `dist/` and NOTHING tested any of them. Spec 9 step 6 made
 * `TaxTable`'s arguments required and rewrote 57 construction sites with a
 * script that globbed `--include=*.js --include=*.mjs` — so it never saw the
 * inline module script in globals.html.
 *
 * That page then threw on load. The throw landed inside `valuesToElements()`,
 * above the `addEventListener` calls, so the change listeners were never
 * attached: **the Globals settings page silently stopped saving anything.**
 * Every setting a user changed there was discarded. 493 assertions stayed
 * green, `vite build` was clean, and the only reason it surfaced was somebody
 * asking whether browser storage still worked.
 *
 * ── What is covered, and what is not ─────────────────────────────────
 *
 * Static, for every page: it is a build entry (a page missing from
 * vite.config.js is a 404 in production while `npm run dev` serves it happily),
 * every local reference resolves, every inline import resolves AND names a real
 * export, and every id the script reaches for exists in the markup.
 *
 * EXECUTED, for globals.html: its inline module is run against a small DOM
 * shim. That is the half that catches the bug above — an arity change is
 * invisible to static analysis, because the import was fine and the call was
 * not.
 *
 * index.html's entry is `js/finplan-app.js`, which needs Lit, Chart.js, a
 * canvas and Web Workers. Executing it means a real browser, so it is covered
 * statically here and left to the browser check in review. That gap is real and
 * named rather than papered over.
 *
 * Usage:  node tests/pages-smoke.mjs   (from src/)
 */

import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');

let passed = 0, failed = 0;
async function check(label, fn) {
    try { await fn(); console.log(`  ✓ ${label}`); passed++; }
    catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

/** The pages vite is told to build. Anything else never reaches dist/. */
function buildEntries() {
    const cfg = readFileSync(resolve(SRC, 'vite.config.js'), 'utf8');
    const m = /const pages = \[([^\]]*)\]/.exec(cfg);
    assert.ok(m, 'could not read the `pages` array out of vite.config.js');
    return m[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
}

const PAGES = buildEntries();

/** Inline `<script type="module">` bodies, in document order. */
function inlineModules(html) {
    return [...html.matchAll(/<script[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/g)]
        .map(m => m[1])
        .filter(body => body.trim());
}

const importsOf = (code) =>
    [...code.matchAll(/import\s*(?:\{([^}]*)\}\s*)?from\s*['"]([^'"]+)['"]/g)]
        .map(m => ({
            names: (m[1] ?? '').split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean),
            spec: m[2],
        }));

console.log('\n── Every page is a build entry and resolves ──\n');

await check(`vite builds all ${PAGES.length} pages, and each file exists`, () => {
    assert.ok(PAGES.length >= 5, `only ${PAGES.length} entries — is the array still there?`);
    for (const name of PAGES) {
        assert.ok(existsSync(resolve(SRC, `${name}.html`)), `${name}.html is a build entry but absent`);
    }
});

await check('no shipped page is missing from the build list', () => {
    // The trap this project documented: vite discovers index.html on its own and
    // nothing else, so an unlisted page 404s in production while dev serves it.
    const onDisk = readFileSync(resolve(SRC, 'vite.config.js'), 'utf8') && PAGES;
    for (const name of ['index', 'globals', 'help', 'rules', 'about', 'disclaimer']) {
        assert.ok(onDisk.includes(name), `${name}.html exists but is not a build entry`);
    }
});

await check('every local script and stylesheet a page references exists', () => {
    const missing = [];
    for (const name of PAGES) {
        const html = readFileSync(resolve(SRC, `${name}.html`), 'utf8');
        for (const m of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
            const ref = m[1];
            if (/^(https?:|\/\/|#|mailto:|data:)/.test(ref)) continue;
            const [path] = ref.split('#');                    // help.html#timeline
            if (!path || path.endsWith('.html')) continue;    // pages covered above
            if (!existsSync(resolve(SRC, path))) missing.push(`${name}.html → ${ref}`);
        }
    }
    assert.deepEqual(missing, [], 'dangling references:\n      ' + missing.join('\n      '));
});

console.log('\n── Inline scripts still match the modules they import ──\n');

await check('every inline import resolves to a file that exists', async () => {
    const bad = [];
    for (const name of PAGES) {
        const html = readFileSync(resolve(SRC, `${name}.html`), 'utf8');
        for (const body of inlineModules(html)) {
            for (const { spec } of importsOf(body)) {
                if (!spec.startsWith('.')) continue;
                if (!existsSync(resolve(SRC, spec))) bad.push(`${name}.html → ${spec}`);
            }
        }
    }
    assert.deepEqual(bad, [], bad.join(', '));
});

await check('every name an inline script imports is actually exported', async () => {
    // Catches a rename or a removal — the cheap half of what broke globals.html.
    const bad = [];
    for (const name of PAGES) {
        const html = readFileSync(resolve(SRC, `${name}.html`), 'utf8');
        for (const body of inlineModules(html)) {
            for (const { names, spec } of importsOf(body)) {
                if (!spec.startsWith('.') || !names.length) continue;
                const mod = await import(pathToFileURL(resolve(SRC, spec)).href);
                for (const n of names) {
                    if (!(n in mod)) bad.push(`${name}.html imports { ${n} } from ${spec}, which does not export it`);
                }
            }
        }
    }
    assert.deepEqual(bad, [], '\n      ' + bad.join('\n      '));
});

await check('every id an inline script reaches for exists in the markup', () => {
    // A getElementById returning null is the other way these pages die quietly.
    const bad = [];
    for (const name of PAGES) {
        const html = readFileSync(resolve(SRC, `${name}.html`), 'utf8');
        const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]));
        for (const body of inlineModules(html)) {
            for (const m of body.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) {
                if (!ids.has(m[1])) bad.push(`${name}.html: #${m[1]} is read but never defined`);
            }
        }
    }
    assert.deepEqual(bad, [], '\n      ' + bad.join('\n      '));
});

console.log('\n── globals.html actually runs ──\n');

/**
 * A DOM small enough to be honest about.
 *
 * It answers only what the page's script asks for — getElementById, the three
 * properties it reads or writes, and addEventListener. Anything the script
 * starts doing beyond that will throw here, which is the point: this is a
 * smoke test, not a browser.
 */
function domShim(html) {
    const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]);
    const listeners = [];
    const elements = new Map(ids.map(id => {
        // `textContent` and `value` STRINGIFY in a real DOM — `el.textContent = 2026`
        // reads back as "2026". A shim that stored the number would make an
        // assertion about rendered text pass or fail for the wrong reason.
        let text = '', val = '';
        const el = {
            id, checked: false,
            get textContent() { return text; },
            set textContent(v) { text = String(v); },
            get value() { return val; },
            set value(v) { val = String(v); },
            addEventListener: (type, fn) => listeners.push({ id, type, fn }),
            dispatch: (type) => listeners.filter(l => l.id === id && l.type === type)
                .forEach(l => l.fn({ target: el })),
        };
        return [id, el];
    }));
    globalThis.document = {
        getElementById: (id) => elements.get(id) ?? null,
        cookie: '',
    };
    return { elements, listeners };
}

await check('its inline module executes without throwing', async () => {
    // THE assertion. An arity change is invisible to every static check above,
    // because the import was fine and the call was not.
    const html = readFileSync(resolve(SRC, 'globals.html'), 'utf8');
    const [body] = inlineModules(html);
    assert.ok(body, 'globals.html has no inline module — has the page changed shape?');

    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    };
    const dom = domShim(html);

    // Relative specifiers are rewritten to absolute file URLs so the module can
    // live anywhere; everything else is the page's own source, unmodified.
    const rewritten = body.replace(/from\s*['"](\.[^'"]+)['"]/g,
        (_, spec) => `from '${pathToFileURL(resolve(SRC, spec)).href}'`);

    const tmp = join(SRC, '.pages-smoke.tmp.mjs');
    writeFileSync(tmp, rewritten);
    try {
        await import(pathToFileURL(tmp).href + `?t=${Date.now()}`);
    } finally {
        unlinkSync(tmp);
    }

    // It ran. Now: did it do its job?
    assert.ok(dom.listeners.length >= 5,
        `only ${dom.listeners.length} listeners attached — a throw above them would `
        + `leave the page rendering but SAVING NOTHING, which is exactly the bug `
        + `this test was written for`);
});

await check('it populates the derived tax panel rather than leaving placeholders', () => {
    const el = (id) => globalThis.document.getElementById(id);
    assert.match(el('taxBaseYear').textContent, /^\d{4}$/,
        'base year is still the em-dash placeholder — the panel never rendered');
    assert.match(el('taxStdDeduction').textContent, /^\$[\d,]+$/);
    assert.match(el('taxIndexRate').textContent, /^\d+(\.\d+)?%$/);
});

await check('changing a control writes it to localStorage', () => {
    // The behaviour that silently disappeared: listeners attached, and wired to
    // something that persists.
    const finish = globalThis.document.getElementById('finishAge');
    finish.value = '93';
    finish.dispatch('change');
    assert.equal(globalThis.localStorage.getItem('userFinishAge'), '93',
        'the change listener did not persist the value');
});

console.log('\n── index.html ──\n');

await check('its entry module exists and its own imports resolve', () => {
    // Executing finplan-app.js needs Lit, Chart.js, a canvas and Web Workers, so
    // it is a browser job. This asserts the reachable part; the browser check in
    // review covers the rest, and that split is deliberate.
    const html = readFileSync(resolve(SRC, 'index.html'), 'utf8');
    const m = /<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/.exec(html);
    assert.ok(m, 'index.html has no module entry point');

    const entry = resolve(SRC, m[1]);
    assert.ok(existsSync(entry), `entry ${m[1]} does not exist`);

    const code = readFileSync(entry, 'utf8');
    const missing = [];
    for (const { spec } of importsOf(code)) {
        if (!spec.startsWith('.')) continue;
        if (!existsSync(resolve(dirname(entry), spec))) missing.push(spec);
    }
    assert.deepEqual(missing, [], 'unresolved imports in the app entry: ' + missing.join(', '));
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
