#!/usr/bin/env node
/**
 * build-plugin.mjs — bundle the MCP server into the distributable plugin.
 *
 * ── Why a bundle and not a checkout ──────────────────────────────────
 *
 * A marketplace plugin is installed by cloning it. There is no `npm
 * install` step on the other side, so anything the server needs at
 * runtime has to already be in the tree. Shipping `node_modules` for
 * that is 79 MB to deliver 5.6 MB of SDK; bundling is 1.4 MB and one
 * file, and it removes the possibility of a user's install resolving a
 * different version of the SDK than the one this was tested against.
 *
 * ── What makes this safe to do at all ────────────────────────────────
 *
 * `tests/layer-boundary.mjs` proves the closure from mcp-server.js
 * reaches no browser API and no bare specifier outside `node:`. That is
 * the precondition for a single-file Node bundle, and it is checked on
 * every run rather than assumed here — this script re-runs that test
 * before it writes, because a bundle that imports `document` fails at
 * the user's machine instead of ours.
 *
 * Usage:  npm run build:plugin
 */

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const OUT = resolve(SRC, 'plugin/server/mcp-server.mjs');
const PAYLOAD = resolve(SRC, 'plugin');
const LOCK = resolve(SRC, 'tools/plugin-payload.lock.json');

/** The oldest Node the bundle is built for, and the floor the guard enforces. */
const NODE_FLOOR = 20;

/**
 * The checkout whose `node_modules` this build resolves against.
 *
 * At the repository root that is `SRC` itself. In a git worktree there is no
 * local `node_modules`, so Node walks up to the parent checkout's — the same
 * walk, spelled out here because the answer decides how esbuild labels every
 * bundled dependency, and therefore whether two checkouts at one commit
 * produce the same file.
 */
function dependencyRoot() {
    let dir = SRC;
    for (;;) {
        if (existsSync(resolve(dir, 'node_modules'))) return dir;
        const up = dirname(dir);
        if (up === dir) return SRC;
        dir = up;
    }
}

/**
 * Relabel bundled dependencies relative to the checkout that owns them.
 *
 * esbuild records each module's path relative to the build's working
 * directory — twice: once as a `// path` comment, and once as the
 * `__commonJS` label that surfaces in stack traces. `absWorkingDir` pins that
 * directory to `SRC`, which settles the engine's own files. It does not
 * settle the dependencies: a worktree has no `node_modules`, so resolution
 * reaches the parent checkout's and all ~280 of them come out as
 * `../../../node_modules/...`.
 *
 * That prefix is a fact about the machine, not about what was bundled. Left
 * alone it makes two builds of one commit differ in 560 lines — which
 * `tests/plugin-bundle-fresh.mjs` can only read as staleness, and which puts
 * one developer's directory layout into a file everybody installs. It has
 * already been committed once, in 91ce700.
 *
 * So that prefix, and only that exact prefix, is removed. Anything else
 * pointing out of tree stops the build instead: a remaining `../` would mean
 * a dependency arrived from somewhere this has not accounted for, and a guess
 * about it would ship.
 */
function canonicaliseDependencyPaths(text) {
    const prefix = relative(SRC, dependencyRoot()).split(sep).join('/');
    const canonical = prefix
        ? text.split(`${prefix}/node_modules/`).join('node_modules/')
        : text;

    const leaked = canonical.match(/(?:\.\.\/)+node_modules\/\S*/);
    if (leaked) {
        throw new Error(
            `the bundle labels a dependency with a path outside the checkout: `
            + `${leaked[0]}\nThat describes this machine, not the build. Resolve `
            + `it, or teach canonicaliseDependencyPaths about it — do not commit `
            + `the artifact as it stands.`);
    }
    return canonical;
}

/**
 * Produce the bundle's exact text, without writing it.
 *
 * Exported because `tests/plugin-bundle-fresh.mjs` compares the committed
 * artifact against this. If the test built with its own copy of these options
 * it would be checking freshness against something other than what ships —
 * a second implementation of the build, guarding the first. One definition,
 * two callers.
 */
export async function bundleText() {
    const pkg = JSON.parse(readFileSync(resolve(SRC, 'package.json'), 'utf8'));
    const manifest = JSON.parse(
        readFileSync(resolve(SRC, 'plugin/.claude-plugin/plugin.json'), 'utf8'),
    );

    const result = await build({
        entryPoints: [resolve(SRC, 'js/mcp/mcp-server.js')],
        // Every path esbuild writes into the output is relative to this. Left
        // unset it is `process.cwd()`, so `npm run build:plugin` and the same
        // script run from a subdirectory would disagree about the artifact.
        absWorkingDir: SRC,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node20',
        banner: {
            js: [
                // No shebang here: esbuild preserves the entry file's own, and a
                // second one on line 2 is a syntax error, not a comment.
                '// GENERATED FILE — do not edit.',
                '// Built from ChartingFinance/src by tools/build-plugin.mjs.',
                `// Plugin version ${manifest.version}; engine deps `
                    + `@modelcontextprotocol/sdk ${pkg.dependencies['@modelcontextprotocol/sdk']}, `
                    + `zod ${pkg.dependencies.zod}.`,
                '// Rebuild with: npm run build:plugin',
                //
                // The runtime floor, checked before anything else in the bundle
                // runs. It is emitted HERE rather than written in the entry
                // module because esbuild puts the banner ahead of every bundled
                // dependency: a check inside the entry would run after ~280
                // modules had already been evaluated, which is too late if one
                // of them is what a too-old Node chokes on.
                //
                // Deliberately ES5: this is the one piece of the bundle that has
                // to survive the runtime it exists to reject.
                //
                // This cannot cover a MISSING Node — `.mcp.json` says
                // `"command": "node"`, so the spawn fails before a line of ours
                // runs, and the client reports nothing. plugin/README.md states
                // the requirement for that case; this covers "present but old",
                // which is the half we can turn into a sentence.
                'var __cfNode = (process.versions && process.versions.node) || "0";',
                `if (!(parseInt(__cfNode.split(".")[0], 10) >= ${NODE_FLOOR})) {`,
                '    process.stderr.write(',
                `        "charting-finance: needs Node.js ${NODE_FLOOR} or newer, found " + __cfNode + ".\\n"`,
                '        + "Install a current Node from https://nodejs.org and restart Claude.\\n");',
                '    process.exit(1);',
                '}',
            ].join('\n'),
        },
        // In memory. The caller decides whether this becomes a file.
        write: false,
    });
    return canonicaliseDependencyPaths(result.outputFiles[0].text);
}

/**
 * The banner names the plugin version, and `plugin.json` is rewritten by this
 * script — so read the version BEFORE the tool-list sync, or a rebuild could
 * disagree with itself about what it just built. It does not today (the sync
 * touches `tools`, not `version`), and this note is here so it stays that way.
 */

/**
 * A hash of everything under `plugin/` — the bytes a user actually installs.
 *
 * Exported so `tests/plugin-bundle-fresh.mjs` can check the committed lock
 * against the committed payload without running a build.
 *
 * Line endings are normalised before hashing, for the reason `.gitattributes`
 * spells out one file over: this repo is used with `core.autocrlf=true`, and
 * the markdown under `plugin/` is not pinned to LF. Hashing raw bytes would
 * make the fingerprint a fact about the checkout rather than about the
 * payload — which is the same defect PR #50 removed from the bundle itself.
 *
 * Everything under `plugin/` is text today. If that stops being true, this has
 * to learn the difference before it silently mangles a binary.
 */
export function payloadFingerprint() {
    const files = [];
    (function walk(dir) {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort(
            (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
            const full = resolve(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else files.push(full);
        }
    })(PAYLOAD);

    const hash = createHash('sha256');
    for (const file of files.sort()) {
        // The path is hashed too: moving a file without editing it is a change
        // to what ships, and a content-only hash would call that identical.
        hash.update(relative(SRC, file).split(sep).join('/'));
        hash.update('\0');
        hash.update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
        hash.update('\0');
    }
    return hash.digest('hex');
}

// ── Script ───────────────────────────────────────────────────────────
//
// Everything below runs ONLY when this file is executed, never when it is
// imported. That distinction is load-bearing, and it was found by mutation
// rather than by design: `tests/plugin-bundle-fresh.mjs` imports `bundleText`,
// and while this body ran on import the test REBUILT AND OVERWROTE the artifact
// before comparing it. The comparison could not fail — and running the test
// suite quietly modified a committed file.
//
// A module that does work when you import it is not a module. Guard it.

const isMain = process.argv[1]
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {

// The boundary test is the precondition, so it runs first and its failure
// is this script's failure. Bundling a closure that needs a browser would
// produce a file that only breaks after it ships.
console.error('→ verifying the engine is headless (layer-boundary.mjs)…');
execFileSync(process.execPath, [resolve(SRC, 'tests/layer-boundary.mjs')], {
    cwd: SRC,
    stdio: ['ignore', 'inherit', 'inherit'],
});

console.error('→ bundling mcp-server.js → plugin/server/mcp-server.mjs');
const text = await bundleText();
writeFileSync(OUT, text);

const manifest = JSON.parse(
    readFileSync(resolve(SRC, 'plugin/.claude-plugin/plugin.json'), 'utf8'),
);
const bytes = Buffer.byteLength(text);

console.error(`✓ wrote ${(bytes / 1024 / 1024).toFixed(2)} MB`);

// A bundle that cannot answer tools/list is not a build product, it is a
// 1.4 MB file. Boot it and ask, the same way a client would.
console.error('→ smoke-testing the bundle over stdio…');
const req = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'build-plugin', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
].map(m => JSON.stringify(m)).join('\n') + '\n';

const out = execFileSync(process.execPath, [OUT], { input: req, encoding: 'utf8' });
const listed = out.split('\n').filter(Boolean).map(JSON.parse).find(m => m.id === 2);
const names = (listed?.result?.tools ?? []).map(t => t.name);
if (names.length === 0) throw new Error('bundle returned no tools from tools/list');
console.error(`✓ ${names.length} tools: ${names.join(', ')}`);

// The manifest advertises the tool list to anyone reading the plugin
// without running it, so it is written from what the server actually
// served rather than kept in step by hand.
manifest.tools = names;
writeFileSync(
    resolve(SRC, 'plugin/.claude-plugin/plugin.json'),
    JSON.stringify(manifest, null, 2) + '\n',
);
console.error('✓ plugin.json tool list synced');

// ── The version is the update key ────────────────────────────────────
//
// `claude plugin update` compares the INSTALLED version string against the
// marketplace's. It does not look at the commit. Measured 2026-09-02: with the
// marketplace clone correctly fetched to a newer commit, `update` printed
// "already at the latest version (0.1.0)" and copied nothing — the cached
// skill kept its old text and the install record kept its old SHA.
//
// So a payload change that does not bump `plugin.json.version` reaches nobody
// who already installed the plugin, and says so to no one. It is invisible in
// development, because a source checkout is always current.
//
// This is the guard. The fingerprint of what shipped is recorded against the
// version that shipped it; a payload that moves under a version that did not
// stops the build.
//
// It is a REMINDER, not a proof. It fires on the second build within one
// version, which is exactly what iterating on an unreleased bump looks like —
// so `--relock` re-points the lock at the current version deliberately. What
// that costs is worth being plain about: anyone can pass it, including on a
// change that really is going out. Catching THAT needs a check against the
// merge base, which knows what has already been published and this does not.
const fingerprint = payloadFingerprint();
const lock = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, 'utf8')) : null;
const relock = process.argv.includes('--relock');

if (!relock && lock && lock.payload !== fingerprint
    && lock.version === manifest.version) {
    throw new Error(
        `the plugin payload changed but plugin.json is still ${manifest.version}.\n`
        + `Users on ${manifest.version} would never receive this: \`claude plugin `
        + `update\` keys on the version string, reports "already at the latest `
        + `version", and copies nothing.\n`
        + `Bump plugin.json.version and rebuild — or, if ${manifest.version} has `
        + `not shipped yet and you are still iterating on it:\n`
        + `    npm run build:plugin -- --relock`);
}

writeFileSync(LOCK, JSON.stringify(
    { version: manifest.version, payload: fingerprint }, null, 2) + '\n');
console.error(`✓ payload locked at ${manifest.version} (${fingerprint.slice(0, 12)}…)`);

}
