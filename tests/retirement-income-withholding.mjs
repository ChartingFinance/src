/**
 * retirement-income-withholding.mjs — spec 4c
 *
 * Withholds federal tax ON ARRIVAL from Social Security and pension, the only
 * taxable income the engine had no attribution mechanism for at all.
 *
 * The two assertions that carry this file:
 *
 *  1. GROSS INCOME IS UNCHANGED at every rate. A balance is grossed up because
 *     the withheld dollars are themselves a distribution (spec 4b); a flow's
 *     benefit is already gross. Booking the withheld amount as extra income —
 *     the natural thing to copy from 4b — inflates taxable income and RAISES the
 *     household bill. Paired with (2) that failure cannot hide.
 *
 *  2. LIFETIME TAX DOES NOT RISE. Opposite of spec 4a, where paying tax from an
 *     IRA genuinely created new taxable income. Redirecting a flow creates none.
 *
 * Plus the silent-failure guard: PensionBehavior carried NO tax metrics before
 * this spec, so a withholding booked to WITHHELD_INCOME_TAX resolved to
 * NULL_METRIC and vanished while every total still looked plausible.
 *
 * Usage:  node src/tests/retirement-income-withholding.mjs
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
import { TaxTable } from '../js/taxes.js';
import { Metric } from '../js/metric.js';
import { EventType } from '../js/sim-event.js';
import { InstrumentType, Instrument } from '../js/instruments/instrument.js';
import { FundTransfer } from '../js/fund-transfer.js';
import { ModelLifeEvent, LifeEvent } from '../js/life-event.js';
import { membrane_rawDataToModelAssets } from '../js/membrane.js';
import { buildQuickStart, quickStartProfiles } from '../js/quick-start.js';
import { logger, LogCategory } from '../js/utils/logger.js';
import {
  setActiveTaxTable,
  global_social_security_withholding_rate as shippedSocialSecurityRate,
  global_pension_withholding_rate as shippedPensionRate,
  global_setPensionWithholdingRate,
  global_setSocialSecurityWithholdingRate,
  global_setInflationRate, global_getInflationRate,
  global_setFilingAs, global_getFilingAs,
  global_setUserStartAge, global_getUserStartAge,
  global_setUserRetirementAge, global_getUserRetirementAge,
  global_setUserFinishAge, global_getUserFinishAge,
  global_setBacktestYear, global_getBacktestYear,
} from '../js/globals.js';

// Snapshot the SHIPPED defaults at load, before any test moves them.
// These are `export let` live bindings, so reading them later returns whatever
// the last runAt() restored — which made the "SS defaults to 0" assertion pass
// even with the module default raised to 10%.
const SHIPPED_SS_RATE = shippedSocialSecurityRate;
const SHIPPED_PENSION_RATE = shippedPensionRate;

let checks = 0;
const check = (cond, msg) => { checks++; assert.ok(cond, msg); };
const eq = (a, b, msg) => { checks++; assert.equal(a, b, msg); };
const near = (a, b, tol, msg) => {
  checks++;
  assert.ok(Math.abs(a - b) <= tol, `${msg} — ${a.toFixed(2)} vs ${b.toFixed(2)} (tol ${tol})`);
};

// ── Builders ──────────────────────────────────────────────────────────
// Every builder sets EVERY global it depends on: the reference dataset writes
// inflation and backtestYear and nothing resets them, so a profile run
// afterwards silently inherits them.
function buildProfile(profile) {
  global_setInflationRate(0.02);                      global_getInflationRate();
  global_setBacktestYear('current');                  global_getBacktestYear();
  global_setUserStartAge(profile.startAge);           global_getUserStartAge();
  global_setUserRetirementAge(profile.retirementAge); global_getUserRetirementAge();
  global_setUserFinishAge(profile.finishAge);         global_getUserFinishAge();
  global_setFilingAs('Single');                       global_getFilingAs();
  setActiveTaxTable(new TaxTable());
  const { assets, lifeEvents } = buildQuickStart(profile);
  const portfolio = new Portfolio(assets, false);
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
  setActiveTaxTable(new TaxTable());
  const modelAssets = membrane_rawDataToModelAssets(refData.modelAssets);
  let lifeEvents = (refData.lifeEvents ?? []).map(ModelLifeEvent.fromJSON);
  if (S.startAge >= S.retirementAge) {
    const i = lifeEvents.findIndex(e => e.type === LifeEvent.ACCUMULATE);
    if (i !== -1) lifeEvents.splice(i, 1);
  }
  const portfolio = new Portfolio(modelAssets, false);
  portfolio.lifeEvents = lifeEvents.map(e => e.copy());
  return portfolio;
}

/** Run at explicit rates, always restoring the defaults. */
async function runAt({ pension = 0, socialSecurity = 0 }, build) {
  global_setPensionWithholdingRate(pension);
  global_setSocialSecurityWithholdingRate(socialSecurity);
  try {
    const portfolio = build();
    await chronometer_run(portfolio);
    return portfolio;
  } finally {
    global_setPensionWithholdingRate(SHIPPED_PENSION_RATE);
    global_setSocialSecurityWithholdingRate(SHIPPED_SS_RATE);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────
const sumHist = (a, m) => { let s = 0; for (const v of (a.getHistory(m) ?? [])) s += (v ?? 0); return s; };

function fingerprint(pf) {
  const rows = [];
  for (const a of pf.modelAssets) {
    for (const e of (a.events ?? [])) {
      rows.push(`${a.displayName}|${e.dateInt?.year}-${e.dateInt?.month}|${e.type}|${e.amount?.amount?.toFixed(6)}`);
    }
  }
  return rows.join('\n');
}

/** Gross benefit income booked across the run — must never move. */
function grossFlowIncome(pf) {
  let ss = 0, pension = 0;
  for (const a of pf.modelAssets) {
    ss += sumHist(a, Metric.SOCIAL_SECURITY_INCOME);
    pension += sumHist(a, Metric.PENSION_INCOME);
  }
  return { ss, pension, total: ss + pension };
}

function lifetimeTax(pf) {
  let total = 0;
  for (const a of pf.modelAssets) {
    for (const e of (a.events ?? [])) {
      const amt = Math.abs(e.amount?.amount ?? 0);
      if (e.type === EventType.INCOME_TAX_WITHHOLDING || e.type === EventType.FICA_WITHHOLDING) total += amt;
      else if (e.type === EventType.TAX_TRUE_UP) total += (e.data?.direction === 'refund' ? -amt : amt);
    }
  }
  return total;
}

function withheldOnFlows(pf) {
  let total = 0;
  for (const a of pf.modelAssets) {
    if (!InstrumentType.isRetirementIncome(a.instrument)) continue;
    total += Math.abs(sumHist(a, Metric.WITHHELD_INCOME_TAX));
  }
  return total;
}

const RETIRED = quickStartProfiles.find(p => p.label === 'Retired');

// ═══════════════════════════════════════════════════════════════════════
console.log('spec 4c — withholding on arrival for retirement income');

// ── 1. A flow is never a funding source ───────────────────────────────
// Guards the trap that makes "add SS to the backstop" look obviously correct:
// resolveFunding selects on finishCurrency > 0, but on a flow that is a monthly
// RATE, so a benefit reads as an account that never depletes. And debiting one
// changes no balance while returning spillover ZERO, so the caller is told the
// money was collected.
{
  for (const inst of [Instrument.RETIREMENT_INCOME, Instrument.PENSION, Instrument.WORKING_INCOME]) {
    check(!InstrumentType.isFundingBackstop(inst),
      `${inst} must never be in FUNDING_BACKSTOP_PRIORITY — it is a flow with no balance`);
  }
  const pf = await runAt({ pension: 0.10, socialSecurity: 0.10 }, () => buildProfile(RETIRED));
  const picked = FundTransfer.resolveFunding(pf.modelAssets);
  check(!picked || !InstrumentType.isMonthlyIncome(picked.instrument),
    `resolveFunding returned the flow instrument ${picked?.displayName}`);
  console.log('  ok  flows are never funding sources');
}

// ── 2. Neutrality at rate 0 ───────────────────────────────────────────
{
  for (const profile of quickStartProfiles) {
    const a = await runAt({ pension: 0, socialSecurity: 0 }, () => buildProfile(profile));
    const b = await runAt({ pension: 0, socialSecurity: 0 }, () => buildProfile(profile));
    eq(fingerprint(a), fingerprint(b), `${profile.label}: rate-0 runs must be deterministic`);
    for (const asset of a.modelAssets) {
      if (!InstrumentType.isRetirementIncome(asset.instrument)) continue;
      eq(Math.abs(sumHist(asset, Metric.WITHHELD_INCOME_TAX)), 0,
        `${profile.label}: ${asset.displayName} withheld at rate 0`);
    }
  }
  console.log('  ok  neutrality — nothing withheld at rate 0');
}

// ── 3. It fires, and books on the ASSET's own ledger ──────────────────
// The silent-failure guard. Before this spec neither behavior registered a
// single tax metric, so addToMetric(WITHHELD_INCOME_TAX) resolved to NULL_METRIC
// and the write succeeded while showing nothing.
{
  const pf = await runAt({ pension: 0.10, socialSecurity: 0.10 }, () => buildProfile(RETIRED));

  const ssAsset = pf.modelAssets.find(a => a.instrument === Instrument.RETIREMENT_INCOME);
  const penAsset = pf.modelAssets.find(a => a.instrument === Instrument.PENSION);
  check(ssAsset && penAsset, 'the Retired profile must carry both a Social Security and a pension asset');

  for (const [label, asset] of [['Social Security', ssAsset], ['pension', penAsset]]) {
    const withheld = Math.abs(sumHist(asset, Metric.WITHHELD_INCOME_TAX));
    check(withheld > 0,
      `${label}: nothing booked to WITHHELD_INCOME_TAX. If the rate fired, the ` +
      'metric is unregistered on this behavior and the write hit NULL_METRIC');
    // The DAG must carry it upward too, or the asset view shows tax nowhere.
    const incomeTax = Math.abs(sumHist(asset, Metric.INCOME_TAX));
    near(incomeTax, withheld, 0.01, `${label}: WITHHELD_INCOME_TAX did not roll up into INCOME_TAX`);
  }

  const events = penAsset.events.filter(e => e.type === EventType.INCOME_TAX_WITHHOLDING);
  check(events.length > 0, 'the pension must record INCOME_TAX_WITHHOLDING events');
  console.log(`  ok  fires and books — SS $${Math.abs(sumHist(ssAsset, Metric.WITHHELD_INCOME_TAX)).toFixed(0)}, ` +
              `pension $${Math.abs(sumHist(penAsset, Metric.WITHHELD_INCOME_TAX)).toFixed(0)}`);
}

// ── 4. GROSS INCOME IS UNCHANGED at every rate ────────────────────────
// Withholding must reduce what LANDS, never what is EARNED. A flow's benefit is
// already gross; grossing it up the way a deferred distribution is grossed up
// would inflate taxable income and raise the household bill.
{
  const base = grossFlowIncome(await runAt({ pension: 0, socialSecurity: 0 }, () => buildProfile(RETIRED)));
  check(base.ss > 0 && base.pension > 0, 'the Retired profile must have both flows for this to bite');

  for (const rate of [0.07, 0.10, 0.22]) {
    const g = grossFlowIncome(await runAt({ pension: rate, socialSecurity: rate }, () => buildProfile(RETIRED)));
    near(g.ss, base.ss, 0.01,
      `Social Security GROSS income moved at rate ${rate} — withholding must reduce ` +
      'what lands, not what is earned');
    near(g.pension, base.pension, 0.01,
      `pension GROSS income moved at rate ${rate}`);
  }
  console.log(`  ok  gross income unchanged — SS $${base.ss.toFixed(0)}, pension $${base.pension.toFixed(0)} at 0%, 7%, 10%, 22%`);
}

// ── 5. Lifetime tax does not RISE ─────────────────────────────────────
// The opposite of spec 4a, and the discriminator against double-counting.
{
  const off = await runAt({ pension: 0, socialSecurity: 0 }, () => buildProfile(RETIRED));
  const on  = await runAt({ pension: 0.10, socialSecurity: 0.10 }, () => buildProfile(RETIRED));
  const a = lifetimeTax(off), b = lifetimeTax(on);
  check(b <= a + 1,
    `lifetime tax ROSE with withholding on (${a.toFixed(2)} → ${b.toFixed(2)}). ` +
    'Redirecting a flow creates no new taxable income; a rise means the withheld ' +
    'amount was booked as additional income, which is the 4b shape misapplied.');
  console.log(`  ok  lifetime tax did not rise — $${a.toFixed(0)} → $${b.toFixed(0)}`);
}

// ── 6. The brokerage is relieved ──────────────────────────────────────
// The headline behaviour change: less cash sweeps in, and it stops paying tax on
// income it never earned.
{
  const off = await runAt({ pension: 0, socialSecurity: 0 }, () => buildProfile(RETIRED));
  const on  = await runAt({ pension: 0.10, socialSecurity: 0.10 }, () => buildProfile(RETIRED));

  const brokerTax = (pf) => {
    const b = pf.modelAssets.find(a => a.instrument === Instrument.TAXABLE_EQUITY);
    return Math.abs(sumHist(b, Metric.ESTIMATED_INCOME_TAX));
  };
  const before = brokerTax(off), after = brokerTax(on);
  check(after < before,
    `the brokerage should pay LESS tax once the flows withhold their own ` +
    `(${before.toFixed(2)} → ${after.toFixed(2)})`);
  check(withheldOnFlows(on) > 0, 'expected the flows to have withheld something');
  console.log(`  ok  brokerage relieved — $${before.toFixed(0)} → $${after.toFixed(0)}, ` +
              `$${withheldOnFlows(on).toFixed(0)} withheld at source`);
}

// ── 6b. The cash ACTUALLY leaves the benefit ──────────────────────────
// Book-and-collect must be atomic, and this is the one place it can silently
// break. recordIncomeTaxWithholding tells the household the tax was collected,
// so the true-up stops asking the backstop for it — meaning that if
// netIncomeCurrency is never reduced, the brokerage still looks "relieved" while
// no cash was withheld from anything. Money from nowhere, and test 6 passes.
// Measured here at the only place it shows: what the flow actually paid out.
{
  const paidOut = (pf) => {
    let total = 0;
    for (const a of pf.modelAssets) {
      if (!InstrumentType.isRetirementIncome(a.instrument)) continue;
      for (const e of (a.events ?? [])) {
        if (e.type === EventType.TRANSFER) total += Math.abs(e.amount?.amount ?? 0);
      }
    }
    return total;
  };

  const off = await runAt({ pension: 0, socialSecurity: 0 }, () => buildProfile(RETIRED));
  const on  = await runAt({ pension: 0.10, socialSecurity: 0.10 }, () => buildProfile(RETIRED));

  const swept = paidOut(off) - paidOut(on);
  const withheld = withheldOnFlows(on);
  check(paidOut(off) > 0, 'the flows must pay out something for this to bite');
  near(swept, withheld, 1.0,
    'the benefit paid out the same amount despite withholding. The tax was BOOKED ' +
    'as collected without any cash being withheld, so the true-up stops charging ' +
    'the backstop for money that never moved');
  console.log(`  ok  cash really withheld — payout fell $${swept.toFixed(0)}, matching $${withheld.toFixed(0)} withheld`);
}

// ── 7. Social Security's default really is zero ───────────────────────
// Form W-4V is elective with no default. Asserted as behaviour so a future
// "sensible default" cannot quietly model a choice the household never made.
{
  // Assert the SHIPPED default, not a value this file passes in. The first
  // version only ever ran explicit rates, so raising the module default to 10%
  // left every assertion green.
  eq(SHIPPED_SS_RATE, 0,
    'the shipped Social Security withholding default must be 0 — Form W-4V is ' +
    'elective with no default, and withholding by default models a choice the ' +
    'household never made');

  const pf = await runAt({ pension: 0.10 }, () => buildProfile(RETIRED));
  const ss = pf.modelAssets.find(a => a.instrument === Instrument.RETIREMENT_INCOME);
  const pen = pf.modelAssets.find(a => a.instrument === Instrument.PENSION);
  eq(Math.abs(sumHist(ss, Metric.WITHHELD_INCOME_TAX)), 0,
    'Social Security withheld with no elected rate — W-4V is elective and its ' +
    'default is no withholding');
  check(Math.abs(sumHist(pen, Metric.WITHHELD_INCOME_TAX)) > 0,
    'the pension must still withhold at its own rate — the two are independent');
  console.log('  ok  SS silent without an elected rate, pension independent');
}

// ── 8. Reconciliation stays clean ─────────────────────────────────────
// Spec 4a's withholding-spill bucketing fix is recent; this must not reopen it.
// The capture is asserted to have EMITTED before its silence is trusted — a
// probe that captures nothing reports zero findings and looks identical to a
// clean run.
{
  logger.enable(LogCategory.SANITY);
  let captured = 0;
  for (const rates of [{ pension: 0, socialSecurity: 0 }, { pension: 0.10, socialSecurity: 0.10 }]) {
    // Early Career is here for LIVENESS, not for its own sake: Retired and the
    // reference now emit nothing at all, so on their own a broken capture and a
    // clean run are indistinguishable. Early Career exhausts its backstop under
    // age and reports it, so output arriving is itself the proof the sink works.
    for (const [label, build] of [['Retired', () => buildProfile(RETIRED)],
                                  ['reference', buildReference],
                                  ['Early Career', () => buildProfile(quickStartProfiles[0])]]) {
      const cap = logger.capture();
      try {
        await runAt(rates, build);
      } finally {
        cap.stop();
      }
      captured += cap.lines.length;
      const findings = cap.lines.filter(l => /events=.*package=/.test(l.message));
      eq(findings.length, 0,
        `${label} at pension ${rates.pension}/SS ${rates.socialSecurity}: ` +
        `reconciliation mismatch — ${findings.map(f => f.message).join(' | ')}`);
    }
  }
  check(captured > 0,
    'the SANITY capture produced nothing, so its silence proves nothing');
  logger.disable(LogCategory.SANITY);
  console.log(`  ok  reconciliation clean — ${captured} SANITY lines captured, no mismatches`);
}

// ── 9. The tax identity holds ─────────────────────────────────────────
// Every dollar withheld at source must be a dollar the household did not have to
// collect elsewhere. Reading the engine's own total back would be circular, so
// compare the SHIFT: what the flows withheld should be matched by what the
// backstop stopped paying, with the household total unmoved.
{
  const off = await runAt({ pension: 0, socialSecurity: 0 }, () => buildProfile(RETIRED));
  const on  = await runAt({ pension: 0.10, socialSecurity: 0.10 }, () => buildProfile(RETIRED));

  const estimatedElsewhere = (pf) => {
    let total = 0;
    for (const a of pf.modelAssets) {
      if (InstrumentType.isRetirementIncome(a.instrument)) continue;
      total += Math.abs(sumHist(a, Metric.ESTIMATED_INCOME_TAX));
    }
    return total;
  };

  const withheld = withheldOnFlows(on);
  const relieved = estimatedElsewhere(off) - estimatedElsewhere(on);
  const totalShift = Math.abs(lifetimeTax(on) - lifetimeTax(off));

  check(withheld > 0 && relieved > 0, 'expected both a withholding and a relief');
  check(totalShift < 1,
    `the household total moved by $${totalShift.toFixed(2)} — withholding a flow ` +
    'redirects cash, it does not change what is owed');
  // Relief need not equal withholding to the dollar: shifting when cash arrives
  // changes what compounds. It must be the same order, not a rounding artifact.
  check(relieved > withheld * 0.5,
    `only $${relieved.toFixed(2)} of relief against $${withheld.toFixed(2)} withheld — ` +
    'the backstop should stop paying roughly what the flows started paying');
  console.log(`  ok  tax identity — $${withheld.toFixed(0)} withheld at source, ` +
              `$${relieved.toFixed(0)} less paid elsewhere, household total moved $${totalShift.toFixed(2)}`);
}

console.log(`\nPASS — ${checks} assertions`);
