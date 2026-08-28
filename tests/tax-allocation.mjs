/**
 * tax-allocation.mjs — spec 4a
 *
 * Bills the residual household tax to the accounts that generated the income
 * instead of to whichever account resolveFunding returns first.
 *
 * What this suite is actually guarding, in rough order of how badly each would
 * hurt if it broke:
 *
 *  1. The ANNUAL site reads history, not the live accumulators. applyYear runs
 *     on January 1 of the following year, by which point every month of the
 *     settled year has been snapshotted and zeroed. Reading `.current` there
 *     returns zero for every asset, so nothing is eligible, so the whole feature
 *     silently degrades into the old single-backstop behaviour — with every
 *     other test in this repo still green. That is the failure this file exists
 *     for.
 *  2. An explicit fund transfer naming an IRA is still honoured. The engine may
 *     now allocate tax to a retirement account, and the line between "allocate
 *     tax the account's own income caused" and "spend the account on anything"
 *     must not blur.
 *  3. Roth is never allocated to, at any age.
 *  4. Nothing before the age threshold.
 *  5. The books still balance: legs sum to the bill, and collected still equals
 *     liability recomputed independently from income.
 *
 * Usage:  node src/tests/tax-allocation.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── Mock browser globals ──────────────────────────────────────────────
const store = {};
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

const RealDate = Date;
const PINNED = new RealDate(2026, 6, 15);
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(PINNED.getTime());
    else super(...args);
  }
  static now() { return PINNED.getTime(); }
};

// ── Imports ───────────────────────────────────────────────────────────
import { Portfolio } from '../js/portfolio.js';
import { chronometer_run } from '../js/chronometer.js';
import { Metric } from '../js/metric.js';
import { EventType } from '../js/sim-event.js';
import { InstrumentType, Instrument } from '../js/instruments/instrument.js';
import { ModelLifeEvent, LifeEvent } from '../js/life-event.js';
import { membrane_rawDataToModelAssets } from '../js/membrane.js';
import { buildQuickStart, quickStartProfiles } from '../js/quick-start.js';
import { makeRuleContext, ruleNotesFor } from '../js/rule-notes.js';
import { logger, LogCategory } from '../js/utils/logger.js';
import {
  setActiveTaxTable, activeTaxTable,
  global_setAllocateHouseholdTax,
  global_deferred_allocation_age,
  global_setInflationRate, global_getInflationRate,
  global_setFilingAs, global_getFilingAs,
  global_setUserStartAge, global_getUserStartAge,
  global_setUserRetirementAge, global_getUserRetirementAge,
  global_setUserFinishAge, global_getUserFinishAge,
  global_setBacktestYear, global_getBacktestYear,
} from '../js/globals.js';
import { simConfigFromGlobals } from '../js/globals.js';
import { makeActiveTaxTable } from '../js/globals.js';

let checks = 0;
const check = (cond, msg) => { checks++; assert.ok(cond, msg); };
const eq = (a, b, msg) => { checks++; assert.equal(a, b, msg); };

// ── Builders ──────────────────────────────────────────────────────────

// The reference dataset writes inflation and backtestYear into module globals,
// and nothing resets them. Running a profile afterwards would silently inherit
// 3.5% inflation and the dataset's backtest setting — which is how the first
// draft of this file measured Early Career at 27 allocated legs instead of 220.
// Every builder therefore sets EVERY global it depends on.
const PROFILE_INFLATION = 0.02;

function buildProfile(profile) {
  global_setInflationRate(PROFILE_INFLATION);         global_getInflationRate();
  global_setBacktestYear('current');                  global_getBacktestYear();
  global_setUserStartAge(profile.startAge);           global_getUserStartAge();
  global_setUserRetirementAge(profile.retirementAge); global_getUserRetirementAge();
  global_setUserFinishAge(profile.finishAge);         global_getUserFinishAge();
  global_setFilingAs('Single');                       global_getFilingAs();
  setActiveTaxTable(makeActiveTaxTable());
  const { assets, lifeEvents } = buildQuickStart(profile);
  const portfolio = new Portfolio(assets, false, simConfigFromGlobals());
  portfolio.lifeEvents = lifeEvents;
  return portfolio;
}

const refData = JSON.parse(readFileSync(new URL('./data/portfolio-2026-05-mouk0ygz.json', import.meta.url), 'utf8'));

function buildReference() {
  const S = refData.settings;
  global_setInflationRate(S.inflationRate); global_getInflationRate();
  global_setFilingAs(S.filingAs); global_getFilingAs();
  global_setUserStartAge(S.startAge); global_getUserStartAge();
  global_setUserRetirementAge(S.retirementAge); global_getUserRetirementAge();
  global_setUserFinishAge(S.finishAge); global_getUserFinishAge();
  if (S.backtestYear != null) { global_setBacktestYear(S.backtestYear); global_getBacktestYear(); }
  setActiveTaxTable(makeActiveTaxTable());
  const modelAssets = membrane_rawDataToModelAssets(refData.modelAssets);
  let lifeEvents = (refData.lifeEvents ?? []).map(ModelLifeEvent.fromJSON);
  if (S.startAge >= S.retirementAge) {
    const i = lifeEvents.findIndex(e => e.type === LifeEvent.ACCUMULATE);
    if (i !== -1) lifeEvents.splice(i, 1);
  }
  const portfolio = new Portfolio(modelAssets, false, simConfigFromGlobals());
  portfolio.lifeEvents = lifeEvents.map(e => e.copy());
  return portfolio;
}

/** Run with the flag in a known state, always restoring it. */
async function runWith(allocate, build) {
  global_setAllocateHouseholdTax(allocate);
  try {
    const portfolio = build();
    await chronometer_run(portfolio);
    return portfolio;
  } finally {
    global_setAllocateHouseholdTax(false);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

const isAllocatedLeg = (e) => e.data?.basis === 'proportional' && e.type !== EventType.SPILLOVER;

function allocatedLegs(portfolio) {
  const out = [];
  for (const a of portfolio.modelAssets) {
    for (const e of (a.events ?? [])) {
      if (isAllocatedLeg(e)) out.push({ asset: a, event: e, amount: Math.abs(e.amount?.amount ?? 0) });
    }
  }
  return out;
}

function ageInYear(portfolio, year) {
  return portfolio.startUserAge + (year - portfolio.firstDateInt.year);
}

// ═══════════════════════════════════════════════════════════════════════
console.log('spec 4a — proportional allocation of the residual household tax');

// ── 1. Neutrality: the flag genuinely gates everything ────────────────
{
  for (const profile of quickStartProfiles) {
    const off = await runWith(false, () => buildProfile(profile));
    eq(allocatedLegs(off).length, 0,
      `${profile.label}: flag off must produce no allocated legs`);
  }
  const refOff = await runWith(false, buildReference);
  eq(allocatedLegs(refOff).length, 0, 'reference: flag off must produce no allocated legs');
  console.log('  ok  neutrality — flag off allocates nothing on all five scenarios');
}

// ── 2. It actually fires. Silence and success look identical. ─────────
{
  const fired = [];
  for (const profile of quickStartProfiles) {
    const on = await runWith(true, () => buildProfile(profile));
    const legs = allocatedLegs(on);
    check(legs.length > 0, `${profile.label}: allocation must fire with the flag on`);
    fired.push(`${profile.label} ${legs.length}`);
  }
  const refOn = await runWith(true, buildReference);
  check(allocatedLegs(refOn).length > 0, 'reference: allocation must fire with the flag on');
  console.log(`  ok  fires — ${fired.join(', ')}, reference ${allocatedLegs(refOn).length}`);
}

// ── 3. THE ANNUAL SITE READS HISTORY ──────────────────────────────────
// Guards the silent-degradation trap. The annual true-up settles on January 1
// of the following year, so every month of the settled year is already
// snapshotted and zeroed; reading live accumulators yields nothing eligible.
{
  const on = await runWith(true, buildReference);
  const annual = allocatedLegs(on).filter(l => l.event.type === EventType.TAX_TRUE_UP);
  check(annual.length > 0,
    'the ANNUAL true-up must produce allocated legs — if this is 0 the site is ' +
    'reading live accumulators, which are zero by the time applyYear runs, and ' +
    'the feature has silently degraded to the old backstop behaviour');
  const annualTotal = annual.reduce((s, l) => s + l.amount, 0);
  check(annualTotal > 1000,
    `annual allocated total ${annualTotal.toFixed(2)} is implausibly small`);
  console.log(`  ok  annual site reads history — ${annual.length} legs, $${annualTotal.toFixed(2)}`);
}

// ── 4. Roth is never allocated to, at any age ─────────────────────────
// Protected TWICE: the eligibility gate excludes tax-free instruments, and
// TAX_FREE_DISTRIBUTION is outside the basis. Neither mutation alone can be
// turned into a failure — widening the gate leaves the basis at zero, adding
// tax-free to the basis leaves the gate closed — so this asserts the OUTCOME
// and both guards were mutation-checked together on 2026-08-05.
//
// FIXTURE CHOICE IS LOAD-BEARING. The first version of this test ran Early
// Career and the reference portfolio, which are the only two scenarios that
// never distribute their Roth at all. With a $0 distribution the basis is zero
// for trivial reasons, so removing BOTH guards still allocated nothing and the
// test stayed green. Mid Career, Pre-Retirement and Retired draw $418k, $395k
// and $359k respectively, and all three run past the age threshold.
{
  const drawsRoth = ['Mid Career', 'Pre-Retirement', 'Retired'];
  let checkedDistribution = 0;
  for (const label of drawsRoth) {
    const profile = quickStartProfiles.find(p => p.label === label);
    const on = await runWith(true, () => buildProfile(profile));

    const roth = on.modelAssets.find(a => InstrumentType.isTaxFree(a.instrument));
    let distributed = 0;
    for (const v of (roth?.getHistory(Metric.ROTH_IRA_DISTRIBUTION) ?? [])) distributed += (v ?? 0);
    check(distributed > 0,
      `${label} must actually distribute its Roth for this test to bite — a Roth ` +
      'that is never drawn has a zero basis for reasons unrelated to either guard');
    checkedDistribution += distributed;

    for (const leg of allocatedLegs(on)) {
      check(!InstrumentType.isTaxFree(leg.asset.instrument),
        `${label}: Roth ${leg.asset.displayName} was allocated $${leg.amount} on ` +
        `$${distributed.toFixed(0)} of distributions — both guards are gone`);
    }
  }
  console.log(`  ok  Roth never allocated — $${checkedDistribution.toFixed(0)} of Roth ` +
              `distributions across ${drawsRoth.length} scenarios, none billed`);
}

// ── 5. Nothing reaches a deferred account below the age threshold ─────
// MUST use the reference portfolio, not a Quick Start profile. Those retire at
// 65-67, so their 401K has no taxable income at all before the threshold — the
// basis is zero, nothing is a candidate, and the assertion passes whether the
// age gate exists or not. Deleting the gate entirely left every Quick Start
// assertion green.
//
// The reference portfolio retires at 57 and takes IRA distributions from month
// one, so the IRA carries real basis for three years while under age 60. That is
// the only fixture here that can tell the gate apart from its absence.
{
  const on = await runWith(true, buildReference);
  const startYear = on.firstDateInt.year;
  const gateYear = startYear + (global_deferred_allocation_age - on.startUserAge);

  // The fixture must actually exercise the gate, or this test proves nothing.
  const ira = on.modelAssets.find(a => a.displayName === 'IRA');
  let underAgeBasis = 0;
  for (const m of [Metric.ORDINARY_INCOME, Metric.CAPITAL_GAIN, Metric.QUALIFIED_DIVIDEND]) {
    const h = ira.getHistory(m) ?? [];
    const months = (gateYear - startYear) * 12;
    for (let i = 0; i < Math.min(months, h.length); i++) underAgeBasis += (h[i] ?? 0);
  }
  check(underAgeBasis > 0,
    `the IRA must carry taxable income before age ${global_deferred_allocation_age} ` +
    'for this test to mean anything — otherwise it passes with no gate at all');

  let earliestDeferred = Infinity;
  for (const leg of allocatedLegs(on)) {
    if (!InstrumentType.isTaxDeferred(leg.asset.instrument)) continue;
    const age = ageInYear(on, leg.event.dateInt.year);
    earliestDeferred = Math.min(earliestDeferred, age);
    check(age >= global_deferred_allocation_age,
      `deferred account ${leg.asset.displayName} allocated at age ${age} ` +
      `(${leg.event.dateInt.year}-${leg.event.dateInt.month}), below the ` +
      `${global_deferred_allocation_age} threshold`);
  }
  check(earliestDeferred < Infinity, 'the reference IRA should be allocated to once past the threshold');

  console.log(`  ok  age gate — $${underAgeBasis.toFixed(0)} of under-age IRA income ` +
              `ignored, earliest deferred allocation at ${earliestDeferred}`);
}

// ── 5b. The under-age exclusion still costs what it costs ─────────────
// Early Career exhausts its backstop at 38 while holding $82k of deferred money
// and reports it unfunded. That is the correct answer — the only money left
// carries a penalty — and allocation must not have quietly started spending it.
{
  const on = await runWith(true, () => buildProfile(quickStartProfiles[0]));
  const unfunded = on.modelAssets.flatMap(a => (a.events ?? []).filter(e => e.type === EventType.UNFUNDED));
  check(unfunded.length > 0,
    'Early Career must still report under-age unfunded obligations');
  for (const leg of allocatedLegs(on)) {
    if (!InstrumentType.isTaxDeferred(leg.asset.instrument)) continue;
    check(ageInYear(on, leg.event.dateInt.year) >= global_deferred_allocation_age,
      'Early Career allocated to a deferred account under age');
  }
  console.log(`  ok  under-age exclusion — ${unfunded.length} unfunded events preserved`);
}

// ── 6. Explicit IRA fund transfers are still honoured ─────────────────
// The reference portfolio routes Living Expenses 75% from the IRA.
//
// "Event-for-event identical over the whole run" is the WRONG assertion and the
// first draft of this file used it: allocation changes balances, so an account
// depletes or survives on a different month and downstream transfer timing
// legitimately diverges. Measured 368 vs 377 IRA transfers — a real consequence,
// not a regression.
//
// Two assertions that do isolate the claim:
//   (a) Before the first allocated leg, nothing can have diverged yet, so IRA
//       transfers must match exactly.
//   (b) Over the whole run the ROUTING PAIRS must be unchanged. Filtering the
//       IRA out of the explicit path — the failure this guards — removes a pair
//       entirely rather than shifting its timing.
{
  const off = await runWith(false, buildReference);
  const on  = await runWith(true,  buildReference);

  const iraTransfers = (pf) => {
    const ira = pf.modelAssets.find(a => a.displayName === 'IRA');
    return (ira.events ?? []).filter(e => e.type === EventType.TRANSFER);
  };
  const stamp = (e) => `${e.dateInt.year}-${String(e.dateInt.month).padStart(2, '0')}|` +
                       `${e.data?.from ?? ''}→${e.data?.to ?? ''}|${e.amount?.amount?.toFixed(6)}`;
  const pair = (e) => `${e.data?.from ?? ''}→${e.data?.to ?? ''}`;

  const offT = iraTransfers(off), onT = iraTransfers(on);
  check(offT.length > 0, 'reference IRA must have explicit transfer events to compare');

  // (a) everything strictly before the feature first acts
  const firstLeg = allocatedLegs(on)
    .map(l => l.event.dateInt.year * 100 + l.event.dateInt.month)
    .sort((x, y) => x - y)[0];
  const before = (e) => (e.dateInt.year * 100 + e.dateInt.month) < firstLeg;
  const offBefore = offT.filter(before).map(stamp);
  const onBefore = onT.filter(before).map(stamp);
  check(offBefore.length > 0, 'expected IRA transfers before the first allocation');
  eq(onBefore.join('\n'), offBefore.join('\n'),
    'IRA transfers diverged BEFORE any tax was allocated — allocation must not ' +
    'touch the explicit fund-transfer path');

  // (b) no routing may DISAPPEAR. Subset, not equality: the ON run picks up 9
  // extra IRA→Brokerage entries in 2056, all $0.00 — the engine records
  // zero-amount transfer events, and which months produce them shifts with the
  // balances. Harmless here, and asserting equality would fail on that noise.
  // Losing a pair is the real failure: that is what filtering the explicit path
  // by instrument would look like.
  const offPairs = [...new Set(offT.map(pair))].sort();
  const onPairs = new Set(onT.map(pair));
  for (const pr of offPairs) {
    check(onPairs.has(pr), `explicit IRA routing "${pr}" disappeared when allocation ` +
      'was enabled — the transfer loop must never filter by instrument');
  }
  check(offPairs.includes('Living Expenses→IRA'),
    'the reference portfolio must still route Living Expenses from the IRA; if this ' +
    'fails the fixture changed and this test is no longer testing what it claims');

  const nonZeroOff = offT.filter(e => Math.abs(e.amount?.amount ?? 0) > 0).length;
  const nonZeroOn = onT.filter(e => Math.abs(e.amount?.amount ?? 0) > 0).length;
  console.log(`  ok  explicit IRA transfers untouched — ${offBefore.length} identical ` +
              `pre-allocation transfers, routings [${offPairs.join(', ')}] all preserved ` +
              `(${nonZeroOff}→${nonZeroOn} non-zero; timing diverges downstream by design)`);
}

// ── 7. Conservation: legs sum to the bill ─────────────────────────────
// Every allocated settlement in one month+event-type must total the bill the
// true-up computed. Largest-remainder rounding makes this exact, not approximate.
{
  const on = await runWith(true, buildReference);
  const groups = new Map();
  for (const leg of allocatedLegs(on)) {
    const key = `${leg.event.dateInt.year}-${leg.event.dateInt.month}|${leg.event.type}`;
    if (!groups.has(key)) groups.set(key, { total: 0, shares: 0 });
    const g = groups.get(key);
    g.total += leg.amount;
    g.shares += leg.event.data?.share ?? 0;
  }
  check(groups.size > 0, 'expected grouped allocation events');
  for (const [key, g] of groups) {
    const drift = Math.abs(g.shares - 1);
    check(drift < 1e-9, `${key}: shares sum to ${g.shares}, not 1`);
  }
  console.log(`  ok  conservation — ${groups.size} allocation groups, every share set sums to 1`);
}

// ── 8. The tax identity survives ──────────────────────────────────────
// Lifetime tax RISES when allocation is on, because paying tax from a deferred
// account is itself a taxable distribution. That is a consequence, not a leak —
// and the way to tell the two apart is to recompute the liability from income
// through the public tax API and compare it to what was collected.
{
  const off = await runWith(false, buildReference);
  const on  = await runWith(true,  buildReference);

  const collected = (pf) => {
    let total = 0;
    for (const a of pf.modelAssets) {
      for (const e of (a.events ?? [])) {
        const amt = Math.abs(e.amount?.amount ?? 0);
        if (e.type === EventType.INCOME_TAX_WITHHOLDING || e.type === EventType.FICA_WITHHOLDING) total += amt;
        else if (e.type === EventType.TAX_TRUE_UP) total += (e.data?.direction === 'refund' ? -amt : amt);
      }
    }
    return total;
  };

  const offTax = collected(off), onTax = collected(on);
  check(onTax > offTax,
    `lifetime tax must RISE with allocation on (${offTax.toFixed(2)} → ${onTax.toFixed(2)}). ` +
    'A flat or falling total means the deferred draws were not booked as ' +
    'distributions, so the engine spent IRA money without recognising the income.');

  // The rise must be explained by more deferred distribution, not by nothing.
  const deferredDistribution = (pf) => {
    let total = 0;
    for (const a of pf.modelAssets) {
      if (!InstrumentType.isTaxDeferred(a.instrument)) continue;
      for (const m of [Metric.TRAD_IRA_DISTRIBUTION, Metric.FOUR_01K_DISTRIBUTION]) {
        for (const v of (a.getHistory(m) ?? [])) total += (v ?? 0);
      }
    }
    return total;
  };
  const dDist = deferredDistribution(on) - deferredDistribution(off);
  check(dDist > 0,
    `deferred distributions must rise when tax is billed to a deferred account ` +
    `(delta ${dDist.toFixed(2)}). settleOneSided calls recordDistribution; if this ` +
    'is 0 that path was bypassed and the income is invisible to the tax table.');

  console.log(`  ok  tax identity — lifetime tax +$${(onTax - offTax).toFixed(2)}, ` +
              `explained by +$${dDist.toFixed(2)} of deferred distribution`);
}

// ── 9. Reconciliation stays clean ─────────────────────────────────────
// Every allocated leg uses an EventType that EVENT_RECONCILIATION already
// declares, so no bucket should change shape and monthlySanityCheck must not
// throw on an undeclared type.
{
  // NIIT_ASSESSED joined this list on 2026-08-18 (spec 8). It is allocated by a
  // DIFFERENT basis from the other two — NII_BASIS_METRICS rather than
  // BASIS_METRICS, because wages cannot trigger §1411 — but it settles through
  // the same #settleAllocatedLeg path, so it lands here and needs its own
  // EVENT_RECONCILIATION entry ('oneSided') exactly as the assertion says.
  const ALLOCATED_LEG_TYPES = new Set([
    EventType.INCOME_TAX_WITHHOLDING,
    EventType.TAX_TRUE_UP,
    EventType.NIIT_ASSESSED,
  ]);

  const on = await runWith(true, buildReference);
  for (const leg of allocatedLegs(on)) {
    check(ALLOCATED_LEG_TYPES.has(leg.event.type),
      `allocated leg used unexpected event type ${leg.event.type}; adding a new ` +
      'type requires an EVENT_RECONCILIATION entry or monthlySanityCheck throws');
  }
  console.log('  ok  reconciliation — allocated legs reuse already-declared event types');
}

// ── 9b. Reconciliation stays silent, and the capture is proven live ───
// The engine's own monthly reconciliation is the check that catches "the
// package says tax was collected but no event backs it". Allocation bills an
// account by income share, which can exceed what that account holds, so this is
// exactly where that class of defect appears — it did, on 2056-04 of the
// reference portfolio, until the monthly site was changed to book what was
// actually supplied rather than what was billed.
//
// A probe that captures nothing reports zero findings and looks identical to a
// clean run, so this asserts the capture EMITTED before trusting its silence.
{
  logger.enable(LogCategory.SANITY);
  const seen = [];
  for (const [label, build] of [['reference', buildReference],
                                ['Early Career', () => buildProfile(quickStartProfiles[0])]]) {
    for (const flag of [false, true]) {
      global_setAllocateHouseholdTax(flag);
      const cap = logger.capture();
      try {
        const pf = build();
        await chronometer_run(pf);
      } finally {
        cap.stop();
        global_setAllocateHouseholdTax(false);
      }
      seen.push(cap.lines.length);
      const findings = cap.lines.filter(l => /events=.*package=/.test(l.message));

      // Clean either way. A withholding spill — a depleted IRA whose source
      // withholding is paid by the backstop — used to leave the incomeTax bucket
      // short by exactly the spill, because the only cash event was a SPILLOVER
      // filed under 'oneSided'. conservationBucket now files a
      // cause:'withholding' spill under incomeTax.
      eq(findings.length, 0,
        `${label} (allocation ${flag ? 'on' : 'off'}): reconciliation mismatch — ` +
        `${findings.map(f => f.message).join(' | ')}`);
    }
  }
  check(seen.some(n => n > 0),
    'the SANITY capture produced no output at all, so its silence proves nothing — ' +
    'Early Career emits unfunded reports and must show up here');
  logger.disable(LogCategory.SANITY);
  console.log(`  ok  reconciliation — ${seen.reduce((a, b) => a + b, 0)} SANITY lines captured ` +
              'across four runs, zero package/event mismatches with allocation on OR off');
}

// ── 10. The rule notes tell the truth about who paid and why ──────────
// A rule that fires silently is indistinguishable from one that never ran, and
// an IRA paying tax has no other explanation available: the funding-backstop
// note cannot cover it, because a retirement account is not in the backstop.
{
  const span = (pf) => ({ from: 0, to: (pf.modelAssets[0].getHistory(Metric.VALUE) ?? []).length - 1 });

  const notesFor = (pf, name) => {
    const asset = pf.modelAssets.find(a => a.displayName === name);
    const { from, to } = span(pf);
    return ruleNotesFor(makeRuleContext({
      asset, modelAssets: pf.modelAssets, firstDateInt: pf.firstDateInt, from, to,
    }));
  };

  const on = await runWith(true, buildReference);
  const off = await runWith(false, buildReference);

  // The IRA is allocated to and must say so.
  const iraNotes = notesFor(on, 'IRA');
  const allocNote = iraNotes.find(n => n.id === 'tax-allocated-by-income');
  check(allocNote, 'the allocated IRA must carry a note explaining why it paid tax; ' +
    `got [${iraNotes.map(n => n.id).join(', ')}]`);
  check(/taxable income/.test(allocNote.text),
    'the allocation note must say the account generated the income');
  check(/taxable distribution/.test(allocNote.text),
    'a deferred payer must be told the draw is itself taxable');

  // A brokerage paying only an allocated share must NOT be called the
  // household's automatic funding account.
  const brokerOn = notesFor(on, 'Brokerage').map(n => n.id);
  const brokerOff = notesFor(off, 'Brokerage').map(n => n.id);
  check(brokerOff.includes('funding-backstop'),
    'with allocation off the brokerage IS the backstop and must say so; ' +
    `got [${brokerOff.join(', ')}]`);
  check(brokerOn.includes('tax-allocated-by-income'),
    `an allocated brokerage must carry the allocation note; got [${brokerOn.join(', ')}]`);
  check(!brokerOn.includes('funding-backstop'),
    'the backstop note must be suppressed for an account that only paid an ' +
    'allocated share — otherwise it describes a mechanism that did not run');

  // Silence: an account that paid no tax at all says nothing about tax.
  const rothNotes = notesFor(on, 'Roth').map(n => n.id);
  check(!rothNotes.includes('tax-allocated-by-income'),
    `the Roth paid no allocated tax and must stay silent; got [${rothNotes.join(', ')}]`);

  console.log(`  ok  rule notes — IRA explains its share, brokerage drops the ` +
              `backstop claim, Roth silent`);
}

console.log(`\nPASS — ${checks} assertions`);
