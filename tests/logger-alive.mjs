/**
 * logger-alive.mjs
 *
 * The logger actually emits, and the engine's checks actually speak.
 *
 * ── Why this test exists ─────────────────────────────────────────────
 *
 * `logger.log()` had an empty body for months. Every call site in the codebase
 * — including all eight `LogCategory.SANITY` sites — compiled, ran, and emitted
 * nothing. `monthlySanityCheck` reported that the engine's own books did not
 * balance (293 findings across five healthy scenarios) into a void, and the
 * only reason anyone noticed was a probe written to re-implement the check.
 *
 * Nothing in the suite could have caught that, because no test asserted the
 * logger produces output. This one does. **A silent logger and a passing
 * reconciliation are indistinguishable from the outside, so the fact that
 * output arrives is itself an invariant.**
 *
 * ── The stdout constraint is also load-bearing ───────────────────────
 *
 * `js/mcp/mcp-server.js` speaks MCP over StdioServerTransport, which owns
 * stdout for JSON-RPC. A `console.log` from inside the engine corrupts that
 * protocol — which is exactly why the body was commented out rather than fixed.
 * Under Node the default sink must write to stderr, and that is asserted here.
 *
 * Usage:  node src/tests/logger-alive.mjs   (from repo root)
 */

import assert from 'node:assert/strict';

const store = {};
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

import { logger, LogCategory } from '../js/utils/logger.js';
import { ModelAsset } from '../js/model-asset.js';
import { Portfolio } from '../js/portfolio.js';
import { chronometer_run } from '../js/chronometer.js';
import { TaxTable } from '../js/taxes.js';
import {
  setActiveTaxTable,
  global_setUserStartAge, global_getUserStartAge,
  global_setUserRetirementAge, global_getUserRetirementAge,
} from '../js/globals.js';
import { simConfigFromGlobals } from '../js/globals.js';

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

console.log('\n── The logger emits ──\n');

check('an enabled category reaches a sink', () => {
  const cap = logger.capture();
  try {
    logger.log(LogCategory.GENERAL, 'hello');
    assert.equal(cap.lines.length, 1, 'nothing arrived — logger.log() is dead again');
    assert.equal(cap.lines[0].message, 'hello');
    assert.equal(cap.lines[0].category, LogCategory.GENERAL);
  } finally { cap.stop(); }
});

check('a disabled category is silent', () => {
  const wasEnabled = logger.isEnabled(LogCategory.TAX);
  logger.disable(LogCategory.TAX);
  const cap = logger.capture();
  try {
    logger.log(LogCategory.TAX, 'should not appear');
    assert.equal(cap.lines.length, 0, 'a disabled category emitted anyway');
  } finally {
    cap.stop();
    if (wasEnabled) logger.enable(LogCategory.TAX);
  }
});

check('single-argument calls still work (legacy sites)', () => {
  const cap = logger.capture();
  try {
    logger.log('bare message');
    assert.equal(cap.lines.length, 1);
    assert.equal(cap.lines[0].category, LogCategory.GENERAL);
  } finally { cap.stop(); }
});

check('SANITY is OFF by default', () => {
  // It fires once a month. On by default it would bury everything else, and the
  // app enables it only when global_showEngineDiagnostics is set.
  assert.equal(logger.isEnabled(LogCategory.SANITY), false,
    'SANITY must stay opt-in');
});

check('a broken sink cannot take a simulation down', () => {
  logger.clearSinks();
  const seen = [];
  logger.addSink(() => { throw new Error('sink exploded'); });
  logger.addSink((c, m) => seen.push(m));
  try {
    logger.log(LogCategory.GENERAL, 'survives');
    assert.deepEqual(seen, ['survives'], 'a throwing sink blocked the others');
  } finally { logger.useDefaultSink(); }
});

check('the default sink under Node writes to stderr, never stdout', () => {
  // mcp-server.js speaks MCP over stdio; stdout carries JSON-RPC. A stray
  // console.log from the engine corrupts the protocol.
  logger.useDefaultSink();
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  let toStdout = 0, toStderr = 0;
  process.stdout.write = (...a) => { toStdout++; return outWrite(...a); };
  process.stderr.write = (...a) => { toStderr++; return true; };
  try {
    logger.log(LogCategory.GENERAL, 'probe');
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
  assert.equal(toStdout, 0, 'the engine wrote to stdout — this breaks MCP over stdio');
  assert.ok(toStderr > 0, 'nothing reached stderr');
});

check('output is capped so a runaway cannot freeze a tab', () => {
  logger.reset();
  const cap = logger.capture();
  try {
    for (let i = 0; i < 6000; i++) logger.log(LogCategory.GENERAL, `line ${i}`);
    assert.ok(cap.lines.length < 6000, 'no cap applied');
    assert.ok(cap.lines.some(l => /capped at \d+ lines/.test(l.message)),
      'capping happened without saying so, which is its own silent failure');
  } finally { cap.stop(); logger.reset(); }
});

check('the cap resets per run, not per session', () => {
  logger.reset();
  const cap = logger.capture();
  try {
    for (let i = 0; i < 6000; i++) logger.log(LogCategory.GENERAL, 'x');
    const afterFirst = cap.lines.length;
    logger.reset();
    logger.log(LogCategory.GENERAL, 'second run speaks');
    assert.ok(cap.lines.length > afterFirst,
      'a second run stayed silent — the cap is leaking across runs');
  } finally { cap.stop(); logger.reset(); }
});

// ── The checks themselves ────────────────────────────────────────────
console.log('\n── The engine\'s checks speak ──\n');

async function run(assets, ages) {
  setActiveTaxTable(new TaxTable());
  global_setUserStartAge(ages.start); global_getUserStartAge();
  global_setUserRetirementAge(ages.retire); global_getUserRetirementAge();
  const p = new Portfolio(assets.map(o => ModelAsset.fromJSON(o)), false, simConfigFromGlobals());
  await chronometer_run(p);
  return p;
}

const S = { year: 2026, month: 1 }, F = { year: 2030, month: 12 };
const base = (x) => ({ startDateInt: S, finishDateInt: F, annualReturnRate: { rate: 0 }, ...x });

const healthy = [
  base({ instrument: 'monthlyExpense', displayName: 'Living', startCurrency: { amount: -2000 }, startBasisCurrency: { amount: 0 } }),
  base({ instrument: 'bank', displayName: 'Savings', startCurrency: { amount: 500000 }, startBasisCurrency: { amount: 500000 } }),
];

logger.enable(LogCategory.SANITY);
const sanity = logger.capture(LogCategory.SANITY);
let healthyLines = [];
try {
  await run(healthy, { start: 50, retire: 65 });
  healthyLines = [...sanity.lines];
} finally { sanity.stop(); logger.disable(LogCategory.SANITY); }

check('a healthy plan produces NO reconciliation complaint', () => {
  assert.deepEqual(healthyLines.map(l => l.message), [],
    `the engine complained about a plan that balances:\n      ` +
    healthyLines.slice(0, 5).map(l => l.message).join('\n      '));
});

// Now break conservation deliberately and confirm the complaint arrives. This
// is the half that matters: silence on a healthy plan is also what a dead
// logger looks like.
const { EventType } = await import('../js/sim-event.js');
logger.enable(LogCategory.SANITY);
const broken = logger.capture(LogCategory.SANITY);
let brokenLines = [];
try {
  const p = new Portfolio([], false, simConfigFromGlobals());
  p.modelAssets = [{
    eventsCheckedIndex: 0,
    events: [{ type: EventType.TRANSFER, kind: 'cash', amount: { amount: 1234.56 }, data: {} }],
  }];
  p.monthly = {
    fica: () => ({ amount: 0 }), incomeTax: { amount: 0 }, mortgageInterest: { amount: 0 },
    mortgagePrincipal: { amount: 0 }, propertyTaxes: { amount: 0 },
    longTermCapitalGains: { amount: 0 }, longTermCapitalGainsTax: { amount: 0 },
  };
  p.monthlySanityCheck({ toInt: () => 202601, toString: () => '202601' });
  brokenLines = [...broken.lines];
} finally { broken.stop(); logger.disable(LogCategory.SANITY); }

check('an UNBALANCED transfer produces a complaint that names the amount', () => {
  assert.equal(brokenLines.length, 1,
    `expected exactly one complaint, got ${brokenLines.length}`);
  assert.match(brokenLines[0].message, /Transfer conservation broken/);
  assert.match(brokenLines[0].message, /1234\.56/,
    `the complaint must quantify the gap: "${brokenLines[0].message}"`);
});

check('and it is silent again once SANITY is switched off', () => {
  const cap = logger.capture(LogCategory.SANITY);
  try {
    logger.log(LogCategory.SANITY, 'should not appear');
    assert.equal(cap.lines.length, 0);
  } finally { cap.stop(); }
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
