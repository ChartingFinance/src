/**
 * money-flows.mjs — the Flows view's bars are what moved, and add up to Month
 * & Year Details.
 *
 * ── Why ──────────────────────────────────────────────────────────────
 *
 * The Flows view used to multiply each rule's percentage by a balance. Mid
 * Career June 2030 showed Salary → Brokerage at $7K, its "93%"; $5,232 moved
 * by that rule and $281 more as leftover pay. Taxes and RMDs did not show at
 * all. money-flows.js reads the ledger instead, so this suite holds it to the
 * ledger and to the figures the rest of the app shows.
 *
 * ── What is asserted ─────────────────────────────────────────────────
 *
 *   THE TABLE      every EventType has a flow treatment; an unknown one throws.
 *
 *   AGREEMENT      every month and every year of the corpus: the bars against
 *                  Month & Year Details, within the half-dollar each rounded
 *                  part can carry —
 *                    income bars + income with nowhere to go = Income received
 *                    spent parts + bills not paid            = Expenses
 *                    tax parts − refunds + property tax accrued but not yet
 *                      drawn                                 = Taxes
 *                  The last term is the escrow: property tax is drawn the month
 *                  after it accrues, and the Taxes figure books the accrual.
 *
 *   EACH ONCE      every account's bar is the sum of its own debits that
 *                  month or year — a movement counted once, from the side that
 *                  paid.
 *
 *   THE CASES      Mid Career June 2030 and June 2060 part by part; the annual
 *                  true-up in January, not December; a gross-up split into the
 *                  bill and its tax; a spillover from a drained account; sale
 *                  proceeds and a mortgage payoff; dividends; a windfall; pay
 *                  with nowhere to go.
 *
 *   THE RULES      every part of every bar lands in exactly one row of the
 *                  rules list, a rule or an automatic group; a rule that moved
 *                  money is open; the automatic groups each occur in the corpus.
 *
 * Run: node tests/money-flows.mjs   (from src/)
 */

import assert from 'node:assert/strict';

// quick-start profiles date their assets from `new Date()`.
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
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

const G = await import('../js/globals.js');
const { simConfigFromGlobals } = G;
const { Portfolio } = await import('../js/portfolio.js');
const { chronometer_run } = await import('../js/chronometer.js');
const { EventType } = await import('../js/sim-event.js');
const { Metric } = await import('../js/metric.js');
const { chainFor, TraceKind } = await import('../js/trace.js');
const { monthSummary, yearSummary } = await import('../js/month-summary.js');
const {
  moneyFlows, rulesInForce, monthWindow, yearWindow, FLOW_TREATMENT, FlowKind, FlowVia, SourceRole, UnpaidKind,
} = await import('../js/money-flows.js');
const { SNAPSHOT_FIXTURES } = await import('./tools/fixtures.mjs');

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

async function runFixture(fixture) {
  G.global_reset();
  G.global_setAllocateHouseholdTax(false);
  G.global_setBacktestYearDirect?.('current');
  const c = fixture.config ?? {};
  if (c.startAge != null) { G.global_setUserStartAge(c.startAge); G.global_getUserStartAge(); }
  if (c.retirementAge != null) { G.global_setUserRetirementAge(c.retirementAge); G.global_getUserRetirementAge(); }
  if (c.finishAge != null) { G.global_setUserFinishAge(c.finishAge); G.global_getUserFinishAge?.(); }
  if (c.filingAs != null) { G.global_setFilingAs(c.filingAs); G.global_getFilingAs(); }
  const built = fixture.build();
  const portfolio = new Portfolio(built.assets, false, simConfigFromGlobals());
  if (built.lifeEvents) portfolio.lifeEvents = built.lifeEvents;
  if (built.guardrails) portfolio.guardrailsParams = built.guardrails;
  await chronometer_run(portfolio);
  return portfolio;
}

const runs = new Map();
for (const fixture of SNAPSHOT_FIXTURES) runs.set(fixture.name, await runFixture(fixture));
const run = (name) => runs.get(name);

const month = (p, y, m) => { const w = monthWindow(p, y, m); return moneyFlows(p, w.from, w.to); };
const year = (p, y) => { const w = yearWindow(p, y); return moneyFlows(p, w.from, w.to); };
const sourceOf = (flows, name, role = null) => flows.sources.find((s) => s.name === name && (!role || s.role === role));
const partOf = (src, to, via = null) => src?.parts.find((p) => p.to === to && (!via || p.via === via));
const partCount = (flows) => flows.sources.reduce((t, s) => t + s.parts.length, 0) + flows.unpaid.length;

/** Every window of a run: each month, then each calendar year. */
function* windows(p) {
  for (let y = p.firstDateInt.year; y <= p.lastDateInt.year; y++) {
    for (let m = 1; m <= 12; m++) {
      const w = monthWindow(p, y, m);
      if (w) yield { label: `${y}-${String(m).padStart(2, '0')}`, w, summary: () => monthSummary(p, y, m) };
    }
    const w = yearWindow(p, y);
    if (w) yield { label: String(y), w, summary: () => yearSummary(p, y) };
  }
}

// ── The table ────────────────────────────────────────────────────────

console.log('\n── Every EventType has a flow treatment ──\n');

await check('FLOW_TREATMENT declares every EventType', () => {
  const missing = Object.values(EventType).filter((t) => !(t in FLOW_TREATMENT));
  assert.deepEqual(missing, []);
});

await check('an event of an undeclared type throws, rather than dropping out of the bars', () => {
  const p = run('quickstart-midCareer');
  const asset = p.modelAssets[0];
  const fake = { ...asset.events[0], type: 'madeUpType' };
  asset.events.push(fake);
  try {
    assert.throws(() => moneyFlows(p, 0, 0), /no flow treatment/);
  } finally {
    asset.events.pop();
  }
});

// ── Agreement with Month & Year Details ──────────────────────────────

console.log('\n── The bars add up to Month & Year Details, every month and year ──\n');

let windowsChecked = 0;
for (const [name, p] of runs) {
  await check(`${name}: income, spending and tax agree in every window`, () => {
    for (const { label, w, summary } of windows(p)) {
      const flows = moneyFlows(p, w.from, w.to);
      const s = summary();
      const t = flows.totals;
      const tol = 0.5 * partCount(flows) + 0.01;

      const accrued = -s.taxItems.filter((x) => x.metric === Metric.PROPERTY_TAX).reduce((u, x) => u + x.amount, 0);
      const drawn = flows.sources.reduce((u, src) =>
        u + src.parts.filter((pt) => pt.detail === 'property tax').reduce((v, pt) => v + pt.amount, 0), 0);

      const di = t.income + t.unplacedIncome - s.income;
      const ds = t.spent + t.unpaidSpent + s.expense;
      const dt = t.taxes + accrued - drawn + s.taxes;
      assert.ok(Math.abs(di) <= tol, `${label}: income bars ${t.income} + unplaced ${t.unplacedIncome}, Income received ${s.income.toFixed(2)}`);
      assert.ok(Math.abs(ds) <= tol, `${label}: spent ${t.spent} + unpaid ${t.unpaidSpent}, Expenses ${(-s.expense).toFixed(2)}`);
      assert.ok(Math.abs(dt) <= tol, `${label}: tax ${t.taxes} + accrued ${accrued.toFixed(2)} − drawn ${drawn}, Taxes ${(-s.taxes).toFixed(2)}`);
      assert.equal(t.intoAccounts, t.income + t.oneTime - t.spent - t.taxes, `${label}: the tiles do not add up`);
      for (const src of flows.sources) {
        assert.equal(src.total, src.parts.reduce((u, pt) => u + pt.amount, 0), `${label}: ${src.name}'s total is not its parts`);
        for (const pt of src.parts) assert.ok(pt.amount > 0, `${label}: ${src.name} → ${pt.to} is ${pt.amount}`);
      }
      windowsChecked++;
    }
  });
}

await check('the corpus checked thousands of windows', () => {
  assert.ok(windowsChecked > 5000, `only ${windowsChecked}`);
});

// ── Each movement once, from the side that paid ──────────────────────

console.log('\n── Each account’s bar is its own debits ──\n');

/** Month index of an event as money-flows dates it, recomputed independently. */
function bookedIndex(p, e) {
  const first = p.firstDateInt;
  const own = (e.dateInt.year - first.year) * 12 + (e.dateInt.month - first.month);
  const root = chainFor(e.traceId, p.traceScopes ?? [])[0];
  return root?.kind === TraceKind.YEAR ? own + 1 : own;
}

const PAID = new Set([EventType.TRANSFER, EventType.SETTLEMENT, EventType.GROSS_UP, EventType.SPILLOVER,
  EventType.FICA_WITHHOLDING, EventType.INCOME_TAX_WITHHOLDING, EventType.CAPITAL_GAINS_TAX,
  EventType.TAX_TRUE_UP, EventType.NIIT_ASSESSED, EventType.ONE_TIME]);

for (const name of ['quickstart-midCareer', 'quickstart-retired', 'brokerage-only-retirement', 'single-home-sale',
                    'settlement-exhausts-fallback', 'annual-trueup-from-brokerage']) {
  const p = run(name);
  await check(`${name}: every year, each account's bar is the sum of its debits`, () => {
    for (let y = p.firstDateInt.year; y <= p.lastDateInt.year; y++) {
      const w = yearWindow(p, y);
      const flows = moneyFlows(p, w.from, w.to);
      for (const asset of p.modelAssets) {
        let debits = 0, n = 0;
        for (const e of asset.events) {
          if (!PAID.has(e.type) || e.amount.amount >= 0) continue;
          const idx = bookedIndex(p, e);
          if (idx < w.from || idx > w.to) continue;
          debits -= e.amount.amount; n++;
        }
        const bar = flows.sources.find((s) => s.name === asset.displayName
          && (s.role === SourceRole.ACCOUNT || s.role === SourceRole.INCOME));
        const shown = bar?.total ?? 0;
        assert.ok(Math.abs(shown - debits) <= 0.5 * (bar?.parts.length ?? 0) + 0.5,
          `${y}: ${asset.displayName}'s bar is ${shown}, its ${n} debits ${debits.toFixed(2)}`);
      }
    }
  });
}

// ── The cases ────────────────────────────────────────────────────────

console.log('\n── Mid Career, part by part ──\n');

const mid = run('quickstart-midCareer');

await check('June 2030: the paycheck is its gross, in taxes, its rules, and the leftover', () => {
  const f = month(mid, 2030, 6);
  const salary = sourceOf(f, 'Salary', SourceRole.INCOME);
  assert.equal(salary.total, 7175);
  assert.equal(partOf(salary, 'FICA').amount, 549);
  assert.equal(partOf(salary, 'Income tax').amount, 641);
  assert.equal(partOf(salary, 'Brokerage', FlowVia.RULE).amount, 5232);
  assert.equal(partOf(salary, 'Brokerage', FlowVia.LEFTOVER).amount, 281);
  assert.equal(partOf(salary, '401K').amount, 359);
  assert.equal(partOf(salary, 'Roth IRA').amount, 113);
});

await check('June 2030: the Brokerage pays the bills, the mortgage, and the property tax as tax', () => {
  const f = month(mid, 2030, 6);
  const brokerage = sourceOf(f, 'Brokerage', SourceRole.ACCOUNT);
  assert.equal(partOf(brokerage, 'Living Expenses').kind, FlowKind.SPENT);
  assert.equal(partOf(brokerage, 'Mortgage').kind, FlowKind.SPENT);
  const propertyTax = partOf(brokerage, 'Home');
  assert.equal(propertyTax.kind, FlowKind.TAX);
  assert.equal(propertyTax.detail, 'property tax');
});

await check('June 2030: the rules claim what they moved; the leftover and withholding are automatic', () => {
  const f = month(mid, 2030, 6);
  const r = rulesInForce(mid, f);
  const rule = (payer, payee) => r.rules.find((x) => x.payer === payer && x.payee === payee);
  assert.equal(rule('Salary', 'Brokerage').moved, 5232);
  assert.equal(rule('Salary', 'Brokerage').setting, '93% of take-home pay');
  assert.equal(rule('Salary', '401K').setting, '5% of gross pay');
  assert.equal(rule('Brokerage', 'Living Expenses').setting, '100% of the bill');
  assert.equal(r.automatic.find((a) => a.key === 'leftover').amount, 281);
  assert.equal(r.automatic.find((a) => a.key === 'payTax').amount, 549 + 641);
  assert.ok(!r.rules.some((x) => x.payer === '401K' && x.payee === 'Living Expenses'), 'a Retire rule is shown in 2030');
});

await check('June 2060: the RMD is an automatic move from the 401K into the Brokerage', () => {
  const f = month(mid, 2060, 6);
  const rmd = partOf(sourceOf(f, '401K', SourceRole.ACCOUNT), 'Brokerage', FlowVia.RMD);
  assert.equal(rmd.amount, 1598);
  assert.equal(rmd.kind, FlowKind.ACCOUNTS);
  const r = rulesInForce(mid, f);
  assert.equal(r.automatic.find((a) => a.key === 'rmd').amount, 1598);
  const salaryRule = r.rules.find((x) => x.payer === 'Salary');
  assert.equal(salaryRule.open, false, 'a rule for a paycheck that ended is shown as open');
});

console.log('\n── The rules that make the bars agree ──\n');

await check('the 2026 true-up refund counts in January 2027, when it was booked, not December', () => {
  const refund = (f) => sourceOf(f, 'Tax refund', SourceRole.REFUND)?.total ?? 0;
  assert.equal(refund(month(mid, 2026, 12)), 0);
  assert.equal(refund(month(mid, 2027, 1)), 648);
  assert.equal(month(mid, 2027, 1).totals.refunds, 648);
});

await check('a gross-up is split into the bill (spent) and its capital-gains tax', () => {
  const f = month(run('brokerage-only-retirement'), 2026, 1);
  const brokerage = sourceOf(f, 'Brokerage', SourceRole.ACCOUNT);
  const bill = partOf(brokerage, 'Living', FlowVia.BACKSTOP);
  const tax = brokerage.parts.find((pt) => pt.via === FlowVia.PROVISION);
  assert.equal(bill.kind, FlowKind.SPENT);
  assert.equal(tax.kind, FlowKind.TAX);
  assert.equal(bill.amount + tax.amount, 21745, 'the split does not add back to the draw');
  assert.equal(tax.amount, 1745);
});

await check('a spillover pays what the drained account was paying', () => {
  // February 2050: the Roth IRA is empty; the Brokerage pays its share of Living Expenses.
  const f = month(run('quickstart-retired'), 2050, 2);
  const spill = partOf(sourceOf(f, 'Brokerage', SourceRole.ACCOUNT), 'Living Expenses', FlowVia.SPILLOVER);
  assert.ok(spill?.amount > 0, 'no spillover part to Living Expenses');
  assert.equal(spill.kind, FlowKind.SPENT);
  const r = rulesInForce(run('quickstart-retired'), f);
  assert.ok(r.automatic.find((a) => a.key === 'spillover').partIds.includes(spill.id));
});

await check('a spillover for a tax pays tax', () => {
  const f = month(run('trueup-draw-unfunded'), 2026, 7);
  const spill = sourceOf(f, 'Checking', SourceRole.ACCOUNT).parts.find((pt) => pt.via === FlowVia.SPILLOVER);
  assert.equal(spill.kind, FlowKind.TAX);
});

await check('a home sale: proceeds into the account, and the mortgage payoff is not spending', () => {
  const f = year(mid, 2036);
  const proceeds = partOf(sourceOf(f, 'Home', SourceRole.ACCOUNT), 'Brokerage', FlowVia.CLOSE);
  assert.ok(proceeds.amount > 500000);
  assert.equal(proceeds.kind, FlowKind.ACCOUNTS);
  const payoff = partOf(sourceOf(f, 'Brokerage', SourceRole.ACCOUNT), 'Mortgage', FlowVia.CLOSE);
  assert.ok(payoff.amount > 250000);
  assert.equal(payoff.kind, FlowKind.ACCOUNTS);
});

await check('capital gains tax on a sale is paid from the property', () => {
  const f = month(run('single-home-sale'), 2029, 7);
  assert.equal(partOf(sourceOf(f, 'Home', SourceRole.ACCOUNT), 'Capital gains tax').kind, FlowKind.TAX);
});

await check('dividends are income, kept in the account they were paid into', () => {
  const f = month(run('dividends-caps-and-windfalls'), 2027, 1);
  const yieldSrc = sourceOf(f, 'Dividends and interest', SourceRole.YIELD);
  const into = partOf(yieldSrc, 'Brokerage');
  assert.equal(into.kind, FlowKind.ACCOUNTS);
  assert.equal(into.amount, 546 + 234);
});

await check('a windfall is a bar of its own and not income', () => {
  const f = month(run('dividends-caps-and-windfalls'), 2027, 6);
  const windfall = sourceOf(f, 'Inheritance', SourceRole.ONE_TIME);
  assert.equal(windfall.total, 50000);
  assert.equal(f.totals.oneTime, 50000);
  assert.ok(f.totals.income < 50000);
});

await check('pay with no account to go to is reported, not drawn', () => {
  const f = month(run('unfundable-tax-bill'), 2028, 7);
  assert.equal(f.totals.unplacedIncome, 3000);
  assert.equal(f.unpaid.find((u) => u.kind === UnpaidKind.INCOME).amount, 3000);
  assert.ok(f.unpaid.some((u) => u.kind === UnpaidKind.SPENT), 'the unpaid bill is missing');
});

// ── The rules list ───────────────────────────────────────────────────

console.log('\n── Every part lands in exactly one row of the rules list ──\n');

const groupsSeen = new Set();
let partsChecked = 0;
for (const [name, p] of runs) {
  await check(`${name}: every month, each part is in one row, and a rule that moved money is open`, () => {
    for (const { label, w } of windows(p)) {
      const flows = moneyFlows(p, w.from, w.to);
      const r = rulesInForce(p, flows);
      const claimed = [...r.rules, ...r.automatic].flatMap((row) => row.partIds);
      const ids = flows.sources.flatMap((s) => s.parts.map((pt) => pt.id));
      assert.equal(new Set(ids).size, ids.length, `${label}: two parts share an id`);
      assert.deepEqual([...claimed].sort(), [...ids].sort(), `${label}: the rows do not claim each part once`);
      const total = flows.sources.reduce((t, s) => t + s.total, 0);
      const rowsTotal = r.rules.reduce((t, x) => t + x.moved, 0) + r.automatic.reduce((t, x) => t + x.amount, 0);
      assert.equal(rowsTotal, total, `${label}: the rows add to ${rowsTotal}, the bars to ${total}`);
      for (const rule of r.rules) {
        if (rule.moved > 0) assert.ok(rule.open, `${label}: ${rule.payer} → ${rule.payee} moved money but is not open`);
      }
      for (const a of r.automatic) groupsSeen.add(a.key);
      partsChecked += ids.length;
    }
  });
}

await check('every automatic group occurs in the corpus, and none falls through to "other"', () => {
  for (const key of ['payTax', 'drawTax', 'gainsTax', 'settlement', 'refund', 'rmd', 'leftover',
                     'uncovered', 'spillover', 'close', 'yield', 'oneTime']) {
    assert.ok(groupsSeen.has(key), `no window has the "${key}" group`);
  }
  assert.ok(!groupsSeen.has('other'), 'a part fell through to "Other transfers"');
  assert.ok(partsChecked > 40000, `only ${partsChecked} parts checked`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
