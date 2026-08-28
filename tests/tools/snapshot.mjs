#!/usr/bin/env node
/**
 * snapshot.mjs — total-state baselines for the simulation engine.
 *
 * ── Why this exists ──────────────────────────────────────────────────
 *
 * This project's recurring failure is not a missing assertion, it is a passing
 * one. A one-letter memo rename corrupted reconciliation and passed 162
 * assertions. Two of four provenance tags could be inverted with every suite
 * green. `monthlySanityCheck` reported 293 findings for months into a logger
 * with an empty body. In each case the tests were fine — they simply were not
 * *comparing the thing that changed*.
 *
 * More assertions do not fix that, because the flaw is in what they cover.
 * Totality does. This tool records EVERYTHING a run produces — every asset's end
 * state, every event with its causal chain, every metric history, every monthly
 * package, the deflator, the guardrail snapshots and the engine's own sanity
 * output — into a committed text baseline. A change either moves those bytes or
 * it does not. A snapshot cannot be vacuous the way an assertion can: there is
 * no code path it forgot to look at.
 *
 * ── The workflow it is built for ─────────────────────────────────────
 *
 * The house rule is predict-before-engine-fix: write down the expected diff
 * BEFORE applying a change, then check it. That rule was expensive to follow
 * because producing the "actual" half meant hand-building a probe every time.
 * Now:
 *
 *     1. write the prediction down
 *     2. make the change
 *     3. node tests/tools/snapshot.mjs            → drift, or silence
 *     4. git diff tests/baselines/                → the actual diff, reviewable
 *     5. it matches the prediction, or you learned something
 *     6. node tests/tools/snapshot.mjs --bless    → the diff lands in the PR
 *
 * Because the baselines are COMMITTED, step 6 puts the behavioural change in the
 * pull request as reviewable text. A reviewer no longer has to take "no
 * behaviour change" on trust; an empty baseline diff is the proof, and a
 * surprising one is the conversation.
 *
 * ── Commands ─────────────────────────────────────────────────────────
 *
 *   node tests/tools/snapshot.mjs                  check every fixture (exit 1 on drift)
 *   node tests/tools/snapshot.mjs --bless          rewrite the baselines
 *   node tests/tools/snapshot.mjs --only retired   filter by name substring
 *   node tests/tools/snapshot.mjs --list           what is in the corpus, and why
 *
 *   node tests/tools/snapshot.mjs --set global_allocate_household_tax=true
 *       Run the corpus under a different global and diff against the committed
 *       baseline WITHOUT touching it — "what would flipping this flag do?"
 *       answered in one command. --bless is refused while --set is in play, so
 *       an exploratory run can never quietly become the new truth.
 *
 * ── Determinism ──────────────────────────────────────────────────────
 *
 * The clock is pinned (quick-start.js anchors plans to `new Date()`), globals
 * are reset per fixture, trace ids are a counter reset by chronometer_run, and
 * nothing on this path calls Math.random — that lives in simulator.js's GA and
 * mc-compute.js, neither of which is snapshotted here. Money is printed to six
 * decimals: fine enough that any real behaviour change shows, coarse enough
 * that last-bit float noise does not.
 */

// ── Pin the clock BEFORE anything imports quick-start.js ─────────────
// Same pin as tests/quickstart-golden.mjs (2026-01-15) — deliberately, so the
// two agree about what "today" means. Only the zero-arg constructor and now().
const RealDate = Date;
const PINNED = new RealDate(2026, 0, 15);
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(PINNED.getTime());
    else super(...args);
  }
  static now() { return PINNED.getTime(); }
};

const store = {};
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Portfolio } from '../../js/portfolio.js';
import { FINANCIAL_FIELDS } from '../../js/financial-package.js';
import { chronometer_run } from '../../js/chronometer.js';
import { TaxTable } from '../../js/taxes.js';
import { METRIC_NAMES, DERIVED_METRICS } from '../../js/metric.js';
import { MONTH_NAMES_LONG } from '../../js/utils/date-int.js';
import { EventType } from '../../js/sim-event.js';
import { chainFor } from '../../js/trace.js';
import { logger, LogCategory } from '../../js/utils/logger.js';
import * as G from '../../js/globals.js';
import { SNAPSHOT_FIXTURES } from './fixtures.mjs';
import { simConfigFromGlobals } from '../../js/globals.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_DIR = join(HERE, '..', 'baselines');

// ── CLI ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i === -1 ? null : argv[i + 1];
};
const overrides = argv
  .map((a, i) => (argv[i - 1] === '--set' ? a : null))
  .filter(Boolean)
  .map((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1) fail(`--set expects name=value, got "${pair}"`);
    return [pair.slice(0, eq), pair.slice(eq + 1)];
  });

function fail(msg) {
  console.error(`snapshot: ${msg}`);
  process.exit(2);
}

/**
 * Read a baseline with line endings normalised.
 *
 * This repo is used with core.autocrlf=true, so a checkout can hand back CRLF
 * while the tool always generates LF — which would report every fixture as
 * drifted on a clean clone, with no engine change behind it. .gitattributes
 * pins these files to LF; this is the seatbelt for anyone whose copy arrived
 * some other way.
 */
const readBaseline = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

const BLESS = has('--bless');
const ONLY = valueOf('--only');
/** Write every history value instead of a digest. Local investigation only. */
const FULL_HISTORIES = has('--full-histories');

if (BLESS && FULL_HISTORIES) {
  fail('--bless with --full-histories would commit a corpus an order of magnitude ' +
       'larger than the reviewable one. Use it to investigate, not to record.');
}

if (BLESS && overrides.length) {
  fail('--bless with --set would record an exploratory config as the baseline. ' +
       'Change the default in js/globals.js first, then bless.');
}

// ── Canonical formatting ─────────────────────────────────────────────
// Every value that reaches a baseline goes through one of these, so "why did
// this line change?" is never a formatting question.

/** Money. Six decimals — see the determinism note in the header. */
const money = (c) => {
  const n = typeof c === 'number' ? c : c?.amount;
  if (n == null || Number.isNaN(n)) return 'n/a';
  // -0 and 0 must print identically or a sign flip on a zero shows as drift.
  const v = Object.is(n, -0) ? 0 : n;
  return v.toFixed(6);
};

const dateStr = (d) => (d == null ? '-' : String(d));
const bool = (b) => (b ? 'yes' : 'no');

/** Stable, readable rendering of an event's `data` payload. */
const dataStr = (data) => {
  if (data == null) return '';
  const keys = Object.keys(data).sort();
  if (keys.length === 0) return '';
  return ' {' + keys.map((k) => {
    const v = data[k];
    return `${k}=${typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(6)) : v}`;
  }).join(' ') + '}';
};

/** Numeric history, wrapped so a one-month change is a one-line diff. */
function historyLines(prefix, values) {
  const out = [];
  const PER_LINE = 6;
  for (let i = 0; i < values.length; i += PER_LINE) {
    const chunk = values.slice(i, i + PER_LINE)
      .map((v) => (v == null ? 'null' : money(v)).padStart(16));
    out.push(`${prefix}[${String(i).padStart(4, '0')}] ${chunk.join(' ')}`);
  }
  return out;
}

/**
 * FNV-1a over the canonical rendering of a history.
 *
 * A 65-year plan has ~780 months per metric per asset, and writing them all out
 * produced a 12MB corpus that no reviewer would read — the size problem and the
 * reviewability problem are the same problem. The digest still FAILS on any
 * change (that is the job), and the summary stats next to it usually say what
 * kind of change it was. `--full-histories` prints the arrays when you need to
 * see exactly which month moved.
 */
function digest(values) {
  let h = 0x811c9dc5;
  for (const v of values) {
    const s = v == null ? 'null' : money(v);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x2c; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ── Causal-chain interning ───────────────────────────────────────────
// Chains are stable text but hugely repetitive. Each distinct chain gets a
// short id (c0, c1, …) assigned in first-seen order, and the mapping is written
// once per fixture under [traceLegend]. First-seen order is deterministic
// because event order is.

const chainPool = new Map();
const chainOrder = [];

/**
 * The chain's root is usually the month scope ("January 2026"), which makes
 * every chain unique per month — 6,085 distinct chains on Early Career, and no
 * deduplication at all. That root is redundant: the event line already carries
 * its own dateInt.
 *
 * So the root is dropped ONLY when it renders exactly as the event's own month.
 * A root that does not match stays in the chain and shows up as its own legend
 * entry, which means a scope leak that attributed an event to the wrong month
 * becomes MORE visible here, not less. Non-month roots — "Life event: Retire",
 * "2031 annual pass" — are never redundant and are always kept.
 */
function chainShape(event, scopes) {
  const chain = chainFor(event.traceId, scopes).map((s) => s.label);
  if (chain.length === 0) return '';
  const d = event.dateInt;
  if (d != null) {
    const own = `${MONTH_NAMES_LONG[d.month - 1]} ${d.year}`;
    if (chain[0] === own) chain.shift();
  }
  return chain.join(' > ');
}

function internChain(event, scopes) {
  const chain = event.traceId == null ? '' : chainShape(event, scopes);
  if (!chain) return 'c-';
  let id = chainPool.get(chain);
  if (id == null) {
    id = `c${chainOrder.length}`;
    chainPool.set(chain, id);
    chainOrder.push(chain);
  }
  return id;
}

function historyDigestLine(name, values) {
  const nums = values.filter((v) => v != null);
  const sum = nums.reduce((a, b) => a + b, 0);
  const min = nums.length ? Math.min(...nums) : 0;
  const max = nums.length ? Math.max(...nums) : 0;
  return `  ${name.padEnd(28)} n=${String(values.length).padStart(4)} ` +
         `first=${money(values[0] ?? 0).padStart(16)} last=${money(values[values.length - 1] ?? 0).padStart(16)} ` +
         `min=${money(min).padStart(16)} max=${money(max).padStart(16)} sum=${money(sum).padStart(18)} ` +
         `#${digest(values)}`;
}

// ── Config handling ──────────────────────────────────────────────────

/**
 * Globals that are NOT covered by global_reset() but do change results. Listed
 * explicitly so a new one is a conscious addition here rather than a silent
 * hole in the baseline's config header.
 */
const EXTRA_CONFIG = [
  // Derived from filingAs rather than set directly, so it is recorded as the
  // EFFECTIVE value — a reader should not have to know the mapping to see that
  // an MFJ fixture excludes $500,000 and a single one $250,000.
  ['homeSaleExclusion', () => G.activeTaxTable?.activeHomeSaleExclusion],
  ['retirementWithholdingRate', () => G.global_retirement_withholding_rate],
];

/** Reset to a known state, then apply the fixture's config and any --set. */
function applyConfig(fixture) {
  G.global_reset();
  G.global_setAllocateHouseholdTax(false);
  G.global_setBacktestYearDirect?.('current');

  const c = fixture.config ?? {};
  if (c.startAge != null) { G.global_setUserStartAge(c.startAge); G.global_getUserStartAge(); }
  if (c.retirementAge != null) { G.global_setUserRetirementAge(c.retirementAge); G.global_getUserRetirementAge(); }
  if (c.finishAge != null) { G.global_setUserFinishAge(c.finishAge); G.global_getUserFinishAge?.(); }
  // A fixture declares its filing status rather than inheriting the reset
  // default, so an MFJ fixture is MFJ on its own terms and not because of the
  // order it happened to run in. --set is applied after this and still wins.
  if (c.filingAs != null) { G.global_setFilingAs(c.filingAs); G.global_getFilingAs(); }

  for (const [name, raw] of overrides) {
    const setter = SETTERS[name];
    if (!setter) fail(`--set ${name}: no known setter. Known: ${Object.keys(SETTERS).join(', ')}`);

    const want = coerce(raw);
    setter.apply(want);

    // The write must be observable, or the run below would silently measure the
    // default and report it as "no drift". See the note on SETTERS.
    const got = setter.read();
    if (!valueLanded(got, want)) {
      fail(
        `--set ${name}=${raw} did not take — the global still reads ${JSON.stringify(got)}.\n` +
        `  This global is probably localStorage-backed, so its setter writes the key\n` +
        `  without assigning the module variable. Add the matching global_getX() to\n` +
        `  the SETTERS entry.`
      );
    }
  }

  // A fresh table every fixture: TaxTable caches bracket state across years.
  G.setActiveTaxTable(new TaxTable());
}

const coerce = (raw) => {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const n = Number(raw);
  return Number.isNaN(n) ? raw : n;
};

/**
 * Only globals that actually change a simulation are exposed to --set.
 *
 * Each entry is {apply, read}, and `read` is not decoration — it is the whole
 * point. Several of these globals are localStorage-backed: `global_setX` writes
 * the key and DOES NOT assign the module variable, which only `global_getX`
 * copies back. A `--set` wired to the setter alone therefore writes somewhere
 * real, throws nothing, and changes no simulated number — the tool reports "no
 * drift" and the reader concludes the flag does nothing.
 *
 * That was true here for four of the then-eight knobs below (filingAs,
 * inflationRate, taxYear, propertyTaxRate) until 2026-08-06. taxYear and
 * propertyTaxRate have since been deleted as dead; the discipline stands. `--set global_inflationRate=0.02`
 * on a 46-year plan reported "No simulated number moved", against a probe-
 * measured ~$6M swing.
 *
 * So every entry now declares how to read the value back, and applyConfig
 * verifies the write landed. A future knob added without its getter fails loudly
 * on first use instead of quietly reporting that nothing happened.
 */
const SETTERS = {
  global_allocate_household_tax: {
    apply: (v) => G.global_setAllocateHouseholdTax(v),
    read: () => G.global_allocate_household_tax,
  },
  global_inflationRate: {
    apply: (v) => { G.global_setInflationRate(v); G.global_getInflationRate(); },
    read: () => G.global_inflationRate,
  },
  global_filingAs: {
    apply: (v) => { G.global_setFilingAs(v); G.global_getFilingAs(); },
    read: () => G.global_filingAs,
  },
  global_user_startAge: {
    apply: (v) => { G.global_setUserStartAge(v); G.global_getUserStartAge(); },
    read: () => G.global_user_startAge,
  },
  global_user_retirementAge: {
    apply: (v) => { G.global_setUserRetirementAge(v); G.global_getUserRetirementAge(); },
    read: () => G.global_user_retirementAge,
  },
  global_backtestYear: {
    apply: (v) => G.global_setBacktestYearDirect(v),
    read: () => G.global_backtestYear,
  },
};

/**
 * Did the write land? Compared loosely on purpose: the setters round-trip
 * through localStorage strings (`toFixed(4)`, `parseInt`), so 0.05 comes back as
 * 0.05 but by way of "0.0500". Exact equality would report false failures.
 */
const valueLanded = (got, want) => {
  const a = Number(got), b = Number(want);
  if (Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) < 1e-9;
  return String(got) === String(want);
};

// ── Running one fixture ──────────────────────────────────────────────

async function runFixture(fixture) {
  applyConfig(fixture);

  const built = fixture.build();
  const portfolio = new Portfolio(built.assets, false, simConfigFromGlobals());
  if (built.lifeEvents) portfolio.lifeEvents = built.lifeEvents;
  if (built.guardrails) portfolio.guardrailsParams = built.guardrails;

  // The engine's own reconciliation verdict is part of the state. It is off by
  // default in production, and capturing it is the whole reason the 293
  // findings stayed hidden: a check that reports nowhere looks like one that
  // passes.
  logger.enable(LogCategory.SANITY);
  const cap = logger.capture(LogCategory.SANITY);
  await chronometer_run(portfolio);
  cap.stop();
  logger.disable(LogCategory.SANITY);

  return { portfolio, sanity: cap.lines.map((l) => l.message) };
}

// ── Rendering a run to text ──────────────────────────────────────────

function render(fixture, portfolio, sanity, coverage) {
  const L = [];
  const scopes = portfolio.traceScopes ?? [];
  chainPool.clear();
  chainOrder.length = 0;

  L.push(`# fixture: ${fixture.name}  (${fixture.kind})`);
  L.push('#');
  for (const line of wrap(fixture.reaches, 74)) L.push(`# ${line}`);
  L.push('');

  // ── config ──
  L.push('[config]');
  const snap = G.global_workerSnapshot();
  for (const k of Object.keys(snap).sort()) L.push(`  ${k} = ${snap[k]}`);
  for (const [label, read] of EXTRA_CONFIG) L.push(`  ${label} = ${read()}`);
  if (portfolio.guardrailsParams) {
    const g = portfolio.guardrailsParams;
    L.push(`  guardrails = rate:${g.withdrawalRate} preservation:${g.preservation} ` +
           `prosperity:${g.prosperity} adjustment:${g.adjustment} from:${dateStr(g.retirementDateInt)}`);
  }
  L.push('');

  // ── totals ──
  L.push('[totals]');
  L.push(`  months = ${portfolio.totalMonths}`);
  L.push(`  firstDate = ${dateStr(portfolio.firstDateInt)}`);
  L.push(`  lastDate = ${dateStr(portfolio.lastDateInt)}`);
  L.push(`  startValue = ${money(portfolio.startValue())}`);
  L.push(`  finishValue = ${money(portfolio.finishValue())}`);
  L.push(`  accumulated = ${money(portfolio.accumulatedValue())}`);
  for (const f of FINANCIAL_FIELDS) {
    const v = portfolio.total[f];
    if (v && Math.abs(v.amount) > 5e-7) L.push(`  total.${f} = ${money(v)}`);
  }
  L.push('');

  // Assets in a stable order — the engine sorts by sortIndex, which is itself
  // behaviour worth pinning, so the ORDER is recorded before sorting by name.
  L.push('[assetOrder]');
  portfolio.modelAssets.forEach((a, i) => L.push(`  ${i} ${a.displayName}`));
  L.push('');

  const byName = [...portfolio.modelAssets].sort((a, b) =>
    a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : 0);

  for (const a of byName) {
    L.push(`[asset] ${a.displayName}`);
    L.push(`  instrument = ${a.instrument}`);
    L.push(`  start = ${dateStr(a.startDateInt)}  finish = ${dateStr(a.finishDateInt)}`);
    L.push(`  startCurrency = ${money(a.startCurrency)}`);
    L.push(`  finishCurrency = ${money(a.finishCurrency)}`);
    L.push(`  startBasis = ${money(a.startBasisCurrency)}`);
    L.push(`  finishBasis = ${money(a.finishBasisCurrency)}`);
    L.push(`  isClosed = ${bool(a.isClosed)}  isDepleted = ${bool(a.isDepleted)}`);
    L.push(`  closedDate = ${dateStr(a.closedDateInt)}  closedValue = ${a.closedValue == null ? '-' : money(a.closedValue)}`);
    L.push(`  events = ${a.events.length}  reconciled = ${a.eventsCheckedIndex ?? 0}`);
    L.push('');

    if (a.events.length) {
      L.push(`[events] ${a.displayName}`);
      a.events.forEach((e, i) => {
        coverage.add(e.type);
        // The causal chain is referenced, not repeated. Chains are long and
        // massively duplicated ("November 2051 > Pay Living Expenses > ..."
        // once per event); interning them into [traceLegend] shrinks the corpus
        // by more than half AND makes a chain change one legend line instead of
        // hundreds of identical event lines.
        L.push(
          `  ${String(i).padStart(4, '0')} ${dateStr(e.dateInt)} ` +
          `${e.type.padEnd(24)} ${money(e.amount).padStart(16)} ` +
          `${(e.kind ?? '-').padEnd(5)} ${(e.metric ?? '-').padEnd(22)}` +
          ` ${internChain(e, scopes)}` +
          `${dataStr(e.data)}`);
      });
      L.push('');
    }

    const tracked = METRIC_NAMES
      .filter((m) => !DERIVED_METRICS.has(m))
      .map((m) => [m, a.getHistory(m)])
      .filter(([, h]) => Array.isArray(h) && h.length && h.some((v) => v != null && Math.abs(v) > 5e-7));
    if (tracked.length) {
      L.push(`[history] ${a.displayName}`);
      for (const [name, hist] of tracked) {
        if (FULL_HISTORIES) {
          L.push(`  ${name}:`);
          L.push(...historyLines('    ', hist));
        } else {
          L.push(historyDigestLine(name, hist));
        }
      }
      L.push('');
    }
  }

  // ── monthly packages ──
  L.push('[packages]');
  portfolio.monthlyPackages.forEach((m, i) => {
    const parts = FINANCIAL_FIELDS
      .filter((f) => m[f] && Math.abs(m[f].amount) > 5e-7)
      .map((f) => `${f}=${money(m[f])}`);
    L.push(`  ${String(i).padStart(4, '0')} ${parts.join(' ') || '(all zero)'}`);
  });
  L.push('');

  if (portfolio.monthlyPriceIndex?.length) {
    L.push('[priceIndex]');
    L.push(...historyLines('  ', portfolio.monthlyPriceIndex));
    L.push('');
  }

  if (portfolio.yearlySnapshots?.length) {
    L.push('[yearlySnapshots]');
    for (const s of portfolio.yearlySnapshots) {
      L.push(`  ${s.year} months=${s.months} partial=${bool(s.partial)} ` +
             `investable=${money(s.investableAssets)} expense=${money(s.annualExpense)} ` +
             `rate=${s.withdrawalRate.toFixed(6)}`);
    }
    L.push('');
  }

  if (portfolio.guardrailEvents?.length) {
    L.push('[guardrailEvents]');
    for (const e of portfolio.guardrailEvents) {
      L.push(`  ${e.year} ${e.type} rate=${Number(e.rate).toFixed(6)} adjustedTo=${e.adjustedTo}`);
    }
    L.push('');
  }

  // ── the engine's own verdict ──
  L.push('[sanity]');
  if (sanity.length === 0) L.push('  (no findings)');
  else for (const m of sanity) L.push(`  ${m}`);
  L.push('');

  // ── causal attribution ──
  L.push('[traces]');
  L.push(`  scopes = ${scopes.length}`);
  const unattributed = portfolio.modelAssets
    .flatMap((a) => a.events)
    .filter((e) => e.traceId == null).length;
  L.push(`  unattributedEvents = ${unattributed}`);
  const labels = new Map();
  for (const s of scopes) labels.set(s.label, (labels.get(s.label) ?? 0) + 1);
  for (const label of [...labels.keys()].sort()) L.push(`  ${labels.get(label)}x ${label}`);
  L.push('');

  // The legend the [events] ids point at. `c-` means the event carried no
  // traceId at all — an unattributed event, which is itself a finding.
  L.push('[traceLegend]');
  if (chainOrder.length === 0) L.push('  (no attributed events)');
  chainOrder.forEach((chain, i) => L.push(`  c${i} = ${chain}`));
  L.push('');

  return L.join('\n') + '\n';
}

function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > width) { lines.push(line); line = w; }
    else line = line ? line + ' ' + w : w;
  }
  if (line) lines.push(line);
  return lines;
}

// ── Coverage: the anti-vacuity report ────────────────────────────────

function renderCoverage(covered, perFixture) {
  const L = [];
  L.push('# EventType coverage across the whole corpus.');
  L.push('#');
  for (const line of wrap(
    'A type listed under NEVER EMITTED is a branch no fixture reaches — every ' +
    'assertion about it is currently vacuous, and it can be deleted or inverted ' +
    'with the suite green. That has happened here repeatedly, so the gap is ' +
    'recorded rather than assumed. Shrinking this list is a good PR on its own; ' +
    'growing it means a fixture stopped reaching something it used to.', 74)) {
    L.push(`# ${line}`);
  }
  L.push('');

  const all = Object.values(EventType).sort();
  const missing = all.filter((t) => !covered.has(t));

  L.push('[emitted]');
  for (const t of all.filter((t) => covered.has(t))) L.push(`  ${t}`);
  L.push('');
  L.push('[never emitted]');
  if (missing.length === 0) L.push('  (none — every declared EventType is reached)');
  else for (const t of missing) L.push(`  ${t}`);
  L.push('');
  L.push('[by fixture]');
  for (const name of [...perFixture.keys()].sort()) {
    L.push(`  ${name}:`);
    for (const t of [...perFixture.get(name)].sort()) L.push(`    ${t}`);
  }
  L.push('');
  return L.join('\n');
}

// ── Diff reporting ───────────────────────────────────────────────────
//
// Intentionally minimal. The baselines are committed, so `git diff` is the real
// diff tool and it is better than anything reimplemented here. This only has to
// say WHERE it first went wrong, clearly enough to act on.

function firstDivergence(expected, actual) {
  const e = expected.split('\n');
  const a = actual.split('\n');
  let i = 0;
  while (i < e.length && i < a.length && e[i] === a[i]) i++;
  let je = e.length - 1, ja = a.length - 1;
  while (je > i && ja > i && e[je] === a[ja]) { je--; ja--; }
  return { line: i + 1, expected: e.slice(i, Math.min(je + 1, i + 6)), actual: a.slice(i, Math.min(ja + 1, i + 6)) };
}

/**
 * Under --set the [config] block is SUPPOSED to differ — that is the whole
 * point of the run. Comparing it anyway made the first divergence always be the
 * overridden setting, burying the numbers the user actually asked about.
 */
function stripConfig(text) {
  return text.replace(/\[config\][\s\S]*?\n\n/, '[config]\n(overridden)\n\n');
}

/** What the run was worth, for the one-line "what did this flag do?" summary. */
function totalsOf(text) {
  const get = (key) => {
    const m = text.match(new RegExp(`^\\s*${key} = (-?[\\d.]+)$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  return { finishValue: get('finishValue'), incomeTax: get('total\\.incomeTax') };
}

function deltaLine(expected, actual) {
  const e = totalsOf(expected), a = totalsOf(actual);
  const parts = [];
  for (const k of ['finishValue', 'incomeTax']) {
    if (e[k] == null || a[k] == null) continue;
    const d = a[k] - e[k];
    if (Math.abs(d) < 5e-7) continue;
    const pct = e[k] !== 0 ? ` (${(d / Math.abs(e[k]) * 100).toFixed(2)}%)` : '';
    parts.push(`${k} ${e[k].toFixed(2)} → ${a[k].toFixed(2)}  Δ${d >= 0 ? '+' : ''}${d.toFixed(2)}${pct}`);
  }
  return parts;
}

// ── Main ─────────────────────────────────────────────────────────────

if (has('--list')) {
  console.log('\nSnapshot corpus\n');
  for (const f of SNAPSHOT_FIXTURES) {
    console.log(`  ${f.name}  [${f.kind}]`);
    for (const line of wrap(f.reaches, 68)) console.log(`      ${line}`);
    console.log('');
  }
  process.exit(0);
}

const selected = SNAPSHOT_FIXTURES.filter((f) => !ONLY || f.name.includes(ONLY));
if (selected.length === 0) fail(`--only "${ONLY}" matched no fixture. Try --list.`);

if (!existsSync(BASELINE_DIR)) mkdirSync(BASELINE_DIR, { recursive: true });

if (overrides.length) {
  console.log(`\n  config override: ${overrides.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log('  (checking against the committed baseline; --bless is disabled)\n');
}

const covered = new Set();
const perFixture = new Map();
let drifted = 0, blessed = 0, checked = 0;

for (const fixture of selected) {
  const fixtureCoverage = new Set();
  const { portfolio, sanity } = await runFixture(fixture);
  const text = render(fixture, portfolio, sanity, fixtureCoverage);
  for (const t of fixtureCoverage) covered.add(t);
  perFixture.set(fixture.name, fixtureCoverage);

  const file = join(BASELINE_DIR, `${fixture.name}.snap`);

  if (BLESS) {
    writeFileSync(file, text);
    blessed++;
    console.log(`  blessed  ${fixture.name}`);
    continue;
  }

  checked++;
  if (!existsSync(file)) {
    drifted++;
    console.log(`  MISSING  ${fixture.name} — no baseline. Run with --bless.`);
    continue;
  }
  const expected = readBaseline(file);
  // Under --set the deliberate config difference is not drift.
  const [lhs, rhs] = overrides.length
    ? [stripConfig(expected), stripConfig(text)]
    : [expected, text];

  if (lhs === rhs) {
    console.log(`  ok       ${fixture.name}`);
  } else {
    drifted++;
    const d = firstDivergence(lhs, rhs);
    console.log(`  DRIFT    ${fixture.name}  (first change at line ${d.line})`);
    for (const l of deltaLine(expected, text)) console.log(`             ${l}`);
    for (const l of d.expected) console.log(`             - ${l}`);
    for (const l of d.actual) console.log(`             + ${l}`);
  }
}

// Coverage is part of the baseline only on a full run — a filtered run would
// otherwise record a corpus-wide claim it did not measure.
//
// `--bless --only` therefore rewrites the filtered baselines and leaves
// _coverage.snap describing the corpus as it used to be. That is a quiet way to
// lose exactly what this file is for: the coverage report is how a branch going
// unreached gets noticed, and a stale one still reads as green. Caught while
// building the MFJ fixtures, where a partial bless left the coverage entry
// describing a fixture two revisions old. Say so rather than assume the next
// full run will clean it up.
if (ONLY && BLESS) {
  console.log(
    `\n  NOTE  _coverage.snap was NOT updated — coverage is corpus-wide and this\n` +
    `        run was filtered by --only. Re-run 'node tests/tools/snapshot.mjs --bless'\n` +
    `        with no filter before committing, or the coverage report will describe\n` +
    `        fixtures as they used to be.`
  );
}

if (!ONLY) {
  const covFile = join(BASELINE_DIR, '_coverage.snap');
  const covText = renderCoverage(covered, perFixture);
  if (BLESS) {
    writeFileSync(covFile, covText);
    console.log('  blessed  _coverage');
  } else if (!existsSync(covFile)) {
    drifted++;
    console.log('  MISSING  _coverage — no baseline. Run with --bless.');
  } else if (readBaseline(covFile) !== covText) {
    drifted++;
    const d = firstDivergence(readBaseline(covFile), covText);
    console.log(`  DRIFT    _coverage  (first change at line ${d.line})`);
    for (const l of d.expected) console.log(`             - ${l}`);
    for (const l of d.actual) console.log(`             + ${l}`);
  } else {
    console.log('  ok       _coverage');
  }

  // A baseline for a fixture nobody builds any more is a file that can never
  // fail. Report it rather than leaving it to rot.
  const known = new Set([...SNAPSHOT_FIXTURES.map((f) => `${f.name}.snap`), '_coverage.snap']);
  for (const f of readdirSync(BASELINE_DIR).filter((f) => f.endsWith('.snap'))) {
    if (!known.has(f)) {
      if (BLESS) { unlinkSync(join(BASELINE_DIR, f)); console.log(`  removed  ${f} (orphan)`); }
      else console.log(`  ORPHAN   ${f} — no fixture builds this any more; --bless removes it`);
    }
  }
}

console.log('');
if (BLESS) {
  console.log(`  ${blessed} baseline(s) written. Review with: git diff tests/baselines/`);
  process.exit(0);
}
if (drifted) {
  console.log(`  ${drifted} of ${checked} fixtures drifted.`);
  console.log('');
  console.log('  This is not automatically a failure — it is the behavioural diff of');
  console.log('  your change, and it is what you predicted, or it is a surprise.');
  console.log('');
  console.log('    git diff tests/baselines/                see exactly what moved');
  console.log('    node tests/tools/snapshot.mjs --bless    accept it into the PR');
  console.log('');
  process.exit(1);
}
console.log(`  ${checked} fixture(s) unchanged. No simulated number moved.`);
process.exit(0);
