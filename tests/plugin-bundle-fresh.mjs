/**
 * plugin-bundle-fresh.mjs
 *
 * The shipped plugin is the engine that is in the repository.
 *
 * ── Why this test exists ─────────────────────────────────────────────
 *
 * `plugin/server/mcp-server.mjs` is generated and COMMITTED, because a
 * marketplace plugin is installed by cloning and there is no `npm install` on
 * the other side. That is the right trade for distribution and the wrong one
 * for drift: nothing about editing `js/` reminds anyone to rebuild, and a stale
 * bundle fails in the only place nobody is looking — someone else's machine,
 * running an engine from weeks ago while every test here passes.
 *
 * It had already happened once. Two PRs landed against the engine after the
 * plugin was packaged, and the committed bundle still served five tools while
 * the source served seven. Collapsing the branches fixed that instance; this
 * fixes the mechanism.
 *
 * ── It shares the build's own definition ─────────────────────────────
 *
 * The comparison calls `bundleText()` out of `tools/build-plugin.mjs` rather
 * than configuring esbuild itself. A test with its own copy of the options
 * would be checking the artifact against something other than what ships —
 * a second implementation of the build, guarding the first — which is the exact
 * failure this repository keeps finding elsewhere.
 *
 * ── Line endings are the trap ────────────────────────────────────────
 *
 * This repo is used with `core.autocrlf=true`. A generated file compared
 * byte-for-byte will therefore report drift on a clean clone with no change
 * behind it, which is precisely what `.gitattributes` already documents for
 * `tests/baselines/*.snap`. The bundle now carries the same `text eol=lf`
 * attribute, and this test normalises anyway — the attribute is the fix, the
 * normalisation is the seatbelt. Same arrangement, same reasons.
 *
 * ── Where it was built is not part of it ─────────────────────────────
 *
 * The comparison only means "stale" if one commit builds to one file from any
 * checkout. It did not: a git worktree has no `node_modules`, so esbuild
 * labelled every dependency `../../../node_modules/...` and this test reported
 * staleness in the place most of the work happens — for a reason that has
 * nothing to do with staleness, which is how a guard gets worked around. The
 * build now canonicalises those labels; the last check below holds the
 * committed artifact to the same standard.
 *
 * Usage:  node tests/plugin-bundle-fresh.mjs   (from src/)
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundleText } from '../tools/build-plugin.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const BUNDLE = resolve(SRC, 'plugin/server/mcp-server.mjs');

const normalise = (s) => s.replace(/\r\n/g, '\n');

let failures = 0;
let ran = 0;
const check = (label, fn) => {
    ran++;
    try { fn(); console.log(`  ok   ${label}`); }
    catch (err) { failures++; console.log(`  FAIL ${label}\n       ${err.message}`); }
};

const committed = normalise(readFileSync(BUNDLE, 'utf8'));
const rebuilt = normalise(await bundleText());

console.log('plugin-bundle-fresh: the committed artifact vs. a fresh build\n');
console.log(`  committed  ${(committed.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`  rebuilt    ${(rebuilt.length / 1024 / 1024).toFixed(2)} MB\n`);

check('the committed bundle matches a fresh build of the current engine', () => {
    if (committed === rebuilt) return;

    // Point at the first divergence rather than dumping 1.4 MB. A size-only
    // message would be useless for the common case, which is a small edit
    // somewhere in the middle of the closure.
    let i = 0;
    while (i < committed.length && i < rebuilt.length && committed[i] === rebuilt[i]) i++;
    const line = committed.slice(0, i).split('\n').length;
    const near = (s) => JSON.stringify(s.slice(Math.max(0, i - 40), i + 60));

    assert.fail(
        `plugin/server/mcp-server.mjs is STALE — it does not match the engine `
        + `in this working tree.\n`
        + `       First difference at line ${line} (byte ${i}):\n`
        + `         committed: ${near(committed)}\n`
        + `         rebuilt:   ${near(rebuilt)}\n`
        + `       Fix: npm run build:plugin, then commit the result.\n`
        + `       The bundle is what people install; if it lags the engine, `
        + `they run code that no longer exists here.`);
});

// A guard on the guard. If `bundleText()` ever returned something trivially
// equal to the file — an empty string, a read of the artifact itself — the
// assertion above would pass while checking nothing.
check('the rebuild actually produced a bundle', () => {
    assert.ok(rebuilt.length > 500_000,
        `a fresh build produced only ${rebuilt.length} bytes; that is not the bundle`);
    assert.match(rebuilt, /GENERATED FILE/, 'the banner is missing from the fresh build');
    assert.match(rebuilt, /ChartingFinance-Local/, 'the server name is missing');
});

check('the committed manifest lists what the server actually serves', () => {
    // `tools` in plugin.json is written by the build from a live tools/list.
    // A hand-edit, or a rebuild that was never run, shows up here.
    const manifest = JSON.parse(
        readFileSync(resolve(SRC, 'plugin/.claude-plugin/plugin.json'), 'utf8'));
    assert.ok(Array.isArray(manifest.tools) && manifest.tools.length,
        'plugin.json advertises no tools');
    for (const name of manifest.tools) {
        assert.ok(rebuilt.includes(`"${name}"`),
            `plugin.json advertises "${name}", which the bundle does not register`);
    }
});

// The artifact is the same file from every checkout, or the comparison above
// is measuring the builder rather than the build. esbuild labels each bundled
// module with its path relative to the build directory, and a git worktree —
// which has no `node_modules` of its own — resolves dependencies through the
// parent checkout, so those labels come out as `../../../node_modules/...`.
// `bundleText()` refuses to produce that; this is the same claim about the
// file that is actually committed, which no build has to have touched.
check('the committed bundle records nothing about the machine that built it', () => {
    const machinePath = committed.match(/(?:\.\.\/)+node_modules\/\S*/)
        ?? committed.match(/^\/\/ [A-Za-z]:[\\/]\S*/m);
    assert.ok(!machinePath,
        `the committed bundle carries a build-machine path: ${machinePath?.[0]}\n`
        + `       It was built somewhere whose layout leaked into the artifact — `
        + `a worktree, or a checkout without its own node_modules.\n`
        + `       Fix: npm run build:plugin, then commit the result.`);
});

console.log('\n───────────────────────────────────────────────────────');
console.log(`  ${ran - failures} passed, ${failures} failed`);
console.log('───────────────────────────────────────────────────────');
process.exit(failures ? 1 : 0);
