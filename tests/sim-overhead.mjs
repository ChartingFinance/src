/**
 * sim-overhead.mjs
 *
 * A batch simulation pays only for the simulation.
 *
 * Monte Carlo runs a plan a thousand times, the Maximizer thousands more. Two
 * costs rode along that none of them uses:
 *
 *   TRACING        every step opened a causal-chain scope. Monte Carlo steps
 *                  months itself and never calls chronometer_run, which is what
 *                  resets them, so it kept every simulation's ~23,600 scopes:
 *                  about 3 GB over a 1,000-run batch. Batch runs now record
 *                  none (trace.js withoutTracing). A single plan run still
 *                  records its full chain; explain depends on it.
 *
 *   LOG MESSAGES   arguments are evaluated before logger.log can check its
 *                  category, so ~1,000 messages per simulation were built and
 *                  thrown away, ~500 of them formatting money. An interpolated
 *                  message is now passed as a function. And TaxTable.applyYear
 *                  recomputed the year's whole tax only to log it; it now runs
 *                  only when TAX logging is on.
 *
 * Together a Mid Career simulation went from 29.1 to 26.0 ms with identical
 * results. Everything here is counted, not timed, so it is deterministic.
 *
 * Run: node tests/sim-overhead.mjs   (from src/)
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import './tools/localstorage-polyfill.js';
import { runPlan, planFromProfile } from '../js/mcp/run-plan.js';
import { computeMonteCarlo } from '../js/mc-compute.js';
import { computeGuardrails } from '../js/gr-compute.js';
import { withoutTracing, isTracing, traceScopes, resetTraces, withTrace, TraceKind } from '../js/trace.js';
import { logger, LogCategory } from '../js/utils/logger.js';
import { Currency } from '../js/utils/currency.js';
import { TaxTable } from '../js/taxes.js';

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); failed++; }
}

// quick-start dates every asset from the clock; pin it.
const RealDate = Date;
function frozenPlan(key) {
    const fixed = new RealDate('2026-08-31T12:00:00Z');
    globalThis.Date = class extends RealDate {
        constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(fixed); }
        static now() { return fixed.getTime(); }
    };
    try { return planFromProfile(key); } finally { globalThis.Date = RealDate; }
}

const { portfolio } = await runPlan(frozenPlan('midCareer'));
const mcOpts = (n) => ({ config: portfolio.config, numSimulations: n, seed: 1, retirementDateInt: null,
                         lifeEvents: portfolio.lifeEvents });

/** Count calls to a prototype method while `fn` runs. */
async function counting(proto, name, fn) {
    let calls = 0;
    const original = proto[name];
    proto[name] = function (...args) { calls++; return original.apply(this, args); };
    try { await fn(); } finally { proto[name] = original; }
    return calls;
}

// ── the tracing switch ───────────────────────────────────────────────

console.log('\n── The tracing switch ──\n');

await test('withoutTracing records nothing and turns tracing back on', () => {
    resetTraces();
    const result = withoutTracing(() => {
        assert.equal(isTracing(), false);
        return withTrace(TraceKind.MONTH, 'inside', null, () => 42);
    });
    assert.equal(result, 42, 'the wrapped function still runs and returns');
    assert.equal(traceScopes().length, 0);
    assert.equal(isTracing(), true);
});

await test('it turns tracing back on even when the function throws, and nests', () => {
    assert.throws(() => withoutTracing(() => { throw new Error('boom'); }), /boom/);
    assert.equal(isTracing(), true);
    withoutTracing(() => withoutTracing(() => {}));
    assert.equal(isTracing(), true, 'an inner call must restore what it found, not force "on"');
    withoutTracing(() => { withoutTracing(() => {}); assert.equal(isTracing(), false); });
});

// ── batch runs record no causal chain ────────────────────────────────

console.log('\n── Batch runs record no causal chain ──\n');

await test('Monte Carlo keeps no trace scopes', async () => {
    resetTraces();
    await computeMonteCarlo(portfolio.modelAssets, mcOpts(10));
    assert.equal(traceScopes().length, 0, `${traceScopes().length.toLocaleString()} scopes kept after 10 simulations`);
});

await test('Guardrails keeps no trace scopes', async () => {
    resetTraces();
    await computeGuardrails(portfolio.modelAssets, {
        params: { withdrawalRate: 4, preservation: 20, prosperity: 20, adjustment: 10 },
        retirementDateInt: null, lifeEvents: portfolio.lifeEvents, config: portfolio.config,
    });
    assert.equal(traceScopes().length, 0);
});

await test('every Maximizer and Guardrails plan run is wrapped', () => {
    // The Maximizer needs a worker context to construct, so its call sites are
    // read: a bare chronometer_run there would trace thousands of runs.
    for (const file of ['js/simulator.js', 'js/gr-compute.js']) {
        const src = readFileSync(file, 'utf8');
        const calls = src.match(/^.*\bchronometer_run\(.*$/gm).filter((l) => !/^\s*import\b/.test(l));
        assert.ok(calls.length > 0, `${file} no longer calls chronometer_run`);
        for (const line of calls) assert.match(line, /withoutTracing\(\(\) => chronometer_run\(/, `${file}: ${line.trim()}`);
    }
});

await test('a single plan run still records its causal chain', async () => {
    const { portfolio: p } = await runPlan(frozenPlan('midCareer'));
    assert.ok(p.traceScopes.length > 1000, `only ${p.traceScopes.length} scopes`);
    const traced = p.modelAssets.flatMap((a) => a.events).filter((e) => e.traceId != null).length;
    assert.ok(traced > 0, 'no event carries a trace id');
});

// ── log messages ─────────────────────────────────────────────────────

console.log('\n── Log messages cost nothing when their category is off ──\n');

await test('a function message is built only when its category is on', () => {
    let built = 0;
    const msg = () => { built++; return 'built'; };
    logger.disable(LogCategory.TAX);
    logger.log(LogCategory.TAX, msg);
    assert.equal(built, 0);
    logger.enable(LogCategory.TAX);
    const cap = logger.capture(LogCategory.TAX);
    try { logger.log(LogCategory.TAX, msg); } finally { cap.stop(); logger.disable(LogCategory.TAX); }
    assert.equal(built, 1);
    assert.deepEqual(cap.lines.map((l) => l.message), ['built']);
});

await test('a simulation formats no money with logging off', async () => {
    const calls = await counting(Currency.prototype, 'toString',
        () => computeMonteCarlo(portfolio.modelAssets, mcOpts(10)));
    assert.equal(calls, 0, `${calls} Currency.toString() calls in 10 simulations (was ~495 per simulation)`);
});

await test("TaxTable.applyYear's log-only recalculation runs only with TAX logging on", async () => {
    const off = await counting(TaxTable.prototype, 'reconcileYearlyTax',
        () => computeMonteCarlo(portfolio.modelAssets, mcOpts(5)));
    assert.equal(off, 0, `ran ${off} times with TAX logging off`);
    logger.enable(LogCategory.TAX);
    const cap = logger.capture(LogCategory.TAX);
    let on;
    try { on = await counting(TaxTable.prototype, 'reconcileYearlyTax', () => runPlan(frozenPlan('midCareer'))); }
    finally { cap.stop(); logger.disable(LogCategory.TAX); }
    assert.ok(on > 0, 'with TAX logging on it should still run, and log');
    assert.ok(cap.lines.some((l) => /yearlyLongTermCapitalGainsAndQualifiedDividendsTax/.test(l.message)));
});

// ── the rule, everywhere ─────────────────────────────────────────────

console.log('\n── Every interpolated log message is lazy ──\n');

/** Index of the ')' closing the call whose '(' ends at `i`, skipping strings and templates. */
function closeOf(s, i) {
    let depth = 0;
    const skipString = (j, q) => { for (j++; s[j] !== q; j++) if (s[j] === '\\') j++; return j; };
    const skipTemplate = (j) => {
        for (j++; s[j] !== '`'; j++) {
            if (s[j] === '\\') { j++; continue; }
            if (s[j] === '$' && s[j + 1] === '{') {
                let d = 0;
                for (j += 2; ; j++) {
                    if (s[j] === '`') j = skipTemplate(j);
                    else if (s[j] === "'" || s[j] === '"') j = skipString(j, s[j]);
                    else if (s[j] === '{') d++;
                    else if (s[j] === '}') { if (d === 0) break; d--; }
                }
            }
        }
        return j;
    };
    for (; i < s.length; i++) {
        const c = s[i];
        if (c === "'" || c === '"') i = skipString(i, c);
        else if (c === '`') i = skipTemplate(i);
        else if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return i; depth--; }
    }
    throw new Error('unclosed call');
}

function jsFiles(dir) {
    return readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? jsFiles(p) : p.endsWith('.js') ? [p] : [];
    });
}

/** Every logger.log call whose message interpolates but is not passed as a function. */
export function eagerLogMessages(root = 'js') {
    const hits = [];
    for (const file of jsFiles(root)) {
        const rel = relative('.', file).replaceAll('\\', '/');
        if (rel === 'js/utils/logger.js') continue;
        const src = readFileSync(file, 'utf8');
        for (const m of src.matchAll(/\blogger\.log\(/g)) {
            const open = m.index + m[0].length;
            const args = src.slice(open, closeOf(src, open));
            const comma = args.indexOf(',');
            if (comma < 0) continue;                       // one-argument GENERAL form
            const message = args.slice(comma + 1).trim();
            const constant = /^(['"])(?:[^\\]|\\.)*?\1$/s.test(message) || /^`[^`$]*`$/.test(message);
            if (constant || message.startsWith('() =>')) continue;
            const line = src.slice(0, m.index).split('\n').length;
            hits.push(`${rel}:${line}  ${message.split('\n')[0].slice(0, 70)}`);
        }
    }
    return hits;
}

await test('no logger.log call builds an interpolated message eagerly', () => {
    const hits = eagerLogMessages();
    assert.equal(hits.length, 0, `\n         ${hits.join('\n         ')}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
