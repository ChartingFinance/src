/**
 * money-format.mjs
 *
 * Money is written one way.
 *
 * Every amount the app shows goes through js/utils/html.js: compact ($4.7M,
 * $287K) where it is glanced at, full ($1,234,567) where it is read, with
 * cents only in the ledger and the spreadsheet. Always a $, always en-US
 * grouping, and a negative amount always takes U+2212 before the $.
 *
 *   THE RULES        each form at its edges, including the unit boundaries a
 *                    naive formatter gets wrong ($999,600 is $1.0M, not
 *                    $1,000K) and amounts that round to zero (no sign).
 *
 *   THE CHARTS       Chart.js defaults give every money chart compact axes
 *                    and full tooltips, including the Projections charts,
 *                    which set neither.
 *
 *   NO PRIVATE COPIES   display code may not format money itself. The app
 *                    once had five formats because each surface wrote its own.
 *                    Engine logs and MCP text for agents are outside this rule.
 *
 * Run: node tests/money-format.mjs   (from src/)
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
    formatCompactCurrency, formatCurrency, formatSignedCurrency, MINUS,
} from '../js/utils/html.js';

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); failed++; }
}

const table = (fn, rows) => {
    for (const [input, expected] of rows) assert.equal(fn(input), expected, `${fn.name}(${JSON.stringify(input)})`);
};

// ── the rules ────────────────────────────────────────────────────────

console.log('\n── The rules ──\n');

await test('the minus sign is U+2212', () => assert.equal(MINUS, '−'));

await test('compact: units, and the boundaries between them', () => table(formatCompactCurrency, [
    [0, '$0'], [42, '$42'], [999.4, '$999'], [999.6, '$1K'],
    [287_400, '$287K'], [999_499, '$999K'], [999_500, '$1.0M'],
    [4_749_000, '$4.7M'], [999_949_999, '$999.9M'], [999_950_000, '$1.0B'],
    [1_234_000_000_000, '$1,234.0B'],
]));

await test('compact: negatives take U+2212 before the $; near-zero takes no sign', () => table(formatCompactCurrency, [
    [-320_000, `${MINUS}$320K`], [-4_749_000, `${MINUS}$4.7M`], [-42, `${MINUS}$42`], [-0.4, '$0'],
]));

await test('full: whole dollars, grouped', () => table(formatCurrency, [
    [0, '$0'], [1_234_567.4, '$1,234,567'], [-1_234.5, `${MINUS}$1,235`], [-0.4, '$0'],
]));

await test('full with cents: the ledger and the spreadsheet', () => {
    const cents = (v) => formatCurrency(v, { cents: true });
    table(cents, [
        [325, '$325.00'], [-2_022.616, `${MINUS}$2,022.62`], [1_234_567.891, '$1,234,567.89'], [-0.004, '$0.00'],
    ]);
});

await test('signed: + for a gain, U+2212 for a loss, nothing for zero', () => {
    table(formatSignedCurrency, [[1_234, '+$1,234'], [-1_234, `${MINUS}$1,234`], [0, '$0'], [0.4, '$0']]);
    assert.equal(formatSignedCurrency(12_000, { compact: true }), '+$12K');
    assert.equal(formatSignedCurrency(-12_000, { compact: true }), `${MINUS}$12K`);
});

await test('anything that is not a number reads $0', () => {
    for (const v of [NaN, undefined, null, 'abc', Infinity]) {
        assert.equal(formatCompactCurrency(v), '$0', String(v));
        assert.equal(formatCurrency(v), '$0', String(v));
    }
    assert.equal(formatCurrency('1234.5'), '$1,235', 'numeric strings are numbers');
});

await test('no output ever contains an ASCII hyphen-minus', () => {
    for (const v of [-1, -999.6, -1e3, -1e6, -1e9, -1234.56]) {
        for (const s of [formatCompactCurrency(v), formatCurrency(v), formatCurrency(v, { cents: true }),
                         formatSignedCurrency(v), formatSignedCurrency(v, { compact: true })]) {
            assert.ok(!s.includes('-'), `${JSON.stringify(s)} for ${v}`);
        }
    }
});

// ── the charts ───────────────────────────────────────────────────────

console.log('\n── Chart defaults ──\n');

await test('charting.js sets compact axes and full tooltips for every chart', async () => {
    const { Chart } = await import('chart.js');
    await import('../js/charting.js');
    assert.equal(Chart.defaults.scales.linear.ticks.callback(5_000_000), '$5.0M');
    assert.equal(Chart.defaults.scales.linear.ticks.callback(-250_000), `${MINUS}$250K`);
    const label = Chart.defaults.plugins.tooltip.callbacks.label;
    const ctx = (y, dataset = 'Brokerage', indexAxis) => ({
        dataset: { label: dataset }, parsed: { x: 7, y }, chart: { options: { indexAxis } },
    });
    assert.equal(label(ctx(1_234_567)), 'Brokerage: $1,234,567');
    assert.equal(label(ctx(-50, '')), `${MINUS}$50`);
    assert.equal(label({ ...ctx(0), parsed: { x: 9_000, y: 0 }, chart: { options: { indexAxis: 'y' } } }), 'Brokerage: $9,000');
});

// ── no private copies ────────────────────────────────────────────────

console.log('\n── No private money formatters in display code ──\n');

// Outside the rule: the formatter itself, the engine (log lines), the MCP
// server (text for agents), and Currency.toString (debugging).
const EXEMPT = [/^js\/utils\/html\.js$/, /^js\/engines\//, /^js\/mcp\//, /^js\/utils\/currency\.js$/];

const PATTERNS = [
    [/'\$' *\+|"\$" *\+/, "'$' + …"],
    [/\$\$\{/, 'a literal $ before ${…} in a template'],
    [/minimumFractionDigits|maximumFractionDigits/, 'toLocaleString with fraction digits'],
    [/Intl\.NumberFormat/, 'Intl.NumberFormat'],
    [/['"`]-\$/, 'an ASCII hyphen before $'],
    // A sign glued onto a correct formatter: use a negated amount, or
    // formatSignedCurrency, so the sign is the shared one.
    [/['"][-+]['"]\s*\+\s*format\w*Currency\(/, "'-' + format…Currency(…)"],
    [/[-+]\$\{format\w*Currency\(/, '-${format…Currency(…)}'],
];

function jsFiles(dir) {
    return readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        return statSync(p).isDirectory() ? jsFiles(p) : p.endsWith('.js') ? [p] : [];
    });
}

/** Every line in display code that formats money itself, as "file:line  why". */
export function privateFormatters(root = 'js') {
    const hits = [];
    for (const file of jsFiles(root)) {
        const rel = relative('.', file).replaceAll('\\', '/');
        if (EXEMPT.some((re) => re.test(rel))) continue;
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
            if (/^\s*(\/\/|\*)/.test(line)) return;   // comments describe formats; they don't make them
            for (const [re, why] of PATTERNS) if (re.test(line)) hits.push(`${rel}:${i + 1}  ${why}`);
        });
    }
    return hits;
}

await test('display code formats money only through utils/html.js', () => {
    const hits = privateFormatters();
    assert.equal(hits.length, 0, `\n         ${hits.join('\n         ')}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
