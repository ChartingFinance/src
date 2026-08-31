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
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const OUT = resolve(SRC, 'plugin/server/mcp-server.mjs');

// The boundary test is the precondition, so it runs first and its failure
// is this script's failure. Bundling a closure that needs a browser would
// produce a file that only breaks after it ships.
console.error('→ verifying the engine is headless (layer-boundary.mjs)…');
execFileSync(process.execPath, [resolve(SRC, 'tests/layer-boundary.mjs')], {
    cwd: SRC,
    stdio: ['ignore', 'inherit', 'inherit'],
});

const pkg = JSON.parse(readFileSync(resolve(SRC, 'package.json'), 'utf8'));
const manifest = JSON.parse(
    readFileSync(resolve(SRC, 'plugin/.claude-plugin/plugin.json'), 'utf8'),
);

console.error(`→ bundling mcp-server.js → plugin/server/mcp-server.mjs`);
const result = await build({
    entryPoints: [resolve(SRC, 'js/mcp/mcp-server.js')],
    outfile: OUT,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    banner: {
        js: [
            // No shebang here: esbuild preserves the entry file's own, and a
            // second one on line 2 is a syntax error, not a comment.
            '// GENERATED FILE — do not edit.',
            `// Built from ChartingFinance/src by tools/build-plugin.mjs.`,
            `// Plugin version ${manifest.version}; engine deps ` +
                `@modelcontextprotocol/sdk ${pkg.dependencies['@modelcontextprotocol/sdk']}, ` +
                `zod ${pkg.dependencies.zod}.`,
            '// Rebuild with: npm run build:plugin',
        ].join('\n'),
    },
    metafile: true,
});

const bytes = Object.values(result.metafile.outputs)[0].bytes;
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
