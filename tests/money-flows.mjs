/**
 * money-flows.mjs — the Flows view's bars are what moved, and its figures are
 * Month & Year Details' figures for what moved.
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
 *   THE FIGURES    every month and year of the corpus. The tiles are the
 *                  section's figures less what the bars leave out — income
 *                  with nowhere to go, bills not paid, property tax accrued
 *                  but not yet drawn — and equal them to the dollar where none
 *                  of that applies. The bars add up to the tiles, within each
 *                  bar's rounding. What could not be paid is the section's
 *                  "could not fund", in the same month.
 *
 *   EACH BAR       an account's bar is its own debits, rounded once; its parts
 *                  add up to it.
 *
 *   THE CASES      Mid Career June 2030 and June 2060, part by part and rule by
 *                  rule; then one case per thing that was wrong once — a
 *                  drained IRA's withholding, a sale a life event made, a
 *                  home's close rule, rules that cover half, a mortgage paid
 *                  and prepaid, an unpayable true-up, the refund's January, a
 *                  gross-up's split, spillovers, a windfall, a down payment,
 *                  estimated tax, unpaid amounts by what they were.
 *
 *   THE RULES      every part of every bar lands in exactly one row of the
 *                  rules list, and a rule's parts run between its own two
 *                  accounts; every automatic group occurs in the corpus.
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
const { ModelAsset } = await import('../js/model-asset.js');
const { ModelLifeEvent, LifeEvent } = await import('../js/life-event.js');
const { EventType } = await import('../js/sim-event.js');
const { Metric } = await import('../js/metric.js');
const { bookedMonthIndex } = await import('../js/trace.js');
const { DateInt } = await import('../js/utils/date-int.js');
const { monthSummary, yearSummary, headlineAsShown } = await import('../js/month-summary.js');
const {
  moneyFlows, rulesInForce, monthWindow, yearWindow, apportion,
  FLOW_TREATMENT, FlowKind, FlowVia, SourceRole, UnpaidKind,
} = await import('../js/money-flows.js');
const { SNAPSHOT_FIXTURES } = await import('./tools/fixtures.mjs');

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

function setUp(c) {
  G.global_reset();
  G.global_setAllocateHouseholdTax(false);
  G.global_setBacktestYearDirect?.('current');
  if (c.startAge != null) { G.global_setUserStartAge(c.startAge); G.global_getUserStartAge(); }
  if (c.retirementAge != null) { G.global_setUserRetirementAge(c.retirementAge); G.global_getUserRetirementAge(); }
  if (c.finishAge != null) { G.global_setUserFinishAge(c.finishAge); G.global_getUserFinishAge?.(); }
  if (c.filingAs != null) { G.global_setFilingAs(c.filingAs); G.global_getFilingAs(); }
}

async function runFixture(fixture) {
  setUp(fixture.config ?? {});
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
const ruleOf = (r, payer, payee, half = 'monthly') => r.rules.find((x) => x.payer === payer && x.payee === payee && x.half === half);
const groupOf = (r, key) => r.automatic.find((a) => a.key === key);

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

await check('apportion gives whole dollars that add up to the total, the largest remainders first', () => {
  assert.deepEqual(apportion([420.75, 440, 404.53, 169.39, 3726.55, 338.78], 5500), [421, 440, 404, 169, 3727, 339]);
  assert.deepEqual(apportion([0.5, 0.5], 1), [1, 0]);
  assert.deepEqual(apportion([2.2, 3.3], 5), [2, 3]);
});

// ── The figures ──────────────────────────────────────────────────────

console.log('\n── The figures are Month & Year Details\' for what moved, every month and year ──\n');

let windowsChecked = 0, exactWindows = 0;
for (const [name, p] of runs) {
  await check(`${name}: tiles, bars and unpaid amounts agree with the section in every window`, () => {
    for (const { label, w, summary } of windows(p)) {
      const flows = moneyFlows(p, w.from, w.to);
      const s = summary();
      const shown = headlineAsShown(s);
      const t = flows.totals;

      // The tiles: the section's figures, less what the bars leave out.
      assert.equal(t.income, shown.income - t.unplacedIncome, `${label}: Came in`);
      assert.equal(t.spent, -shown.expense - t.unpaidSpent, `${label}: Spent`);
      assert.equal(t.taxes, -shown.taxes - t.propertyTaxLag, `${label}: Tax paid`);
      assert.equal(t.intoAccounts, t.income - t.spent - t.taxes, `${label}: the tiles do not add up`);
      if (!t.unplacedIncome && !t.unpaidSpent && !t.propertyTaxLag) exactWindows++;

      // The bars: each bar rounded once, each part within a dollar of its
      // amount, the section's lines each within half a dollar.
      const parts = (pred) => flows.sources.flatMap((src) => src.parts.filter((pt) => pred(src, pt)));
      const sum = (ps) => ps.reduce((u, pt) => u + pt.amount, 0);
      const incomeBars = flows.sources.filter((src) => src.role === SourceRole.INCOME || src.role === SourceRole.YIELD);
      const spentParts = parts((src, pt) => pt.kind === FlowKind.SPENT && pt.via !== FlowVia.ONE_TIME);
      const taxParts = parts((src, pt) => pt.kind === FlowKind.TAX);
      // Each rounding the comparison crosses: a bar's total is within half a
      // dollar, a part within a dollar, each of the section's lines and each
      // adjustment within half.
      const refundBars = flows.sources.filter((src) => src.role === SourceRole.REFUND).length;
      const tolIncome = 0.5 * (incomeBars.length + s.incomeItems.length + flows.unpaid.length) + 0.01;
      const tolSpent = spentParts.length + 0.5 * (s.expenseItems.length + flows.unpaid.length) + 0.01;
      const tolTax = taxParts.length + 0.5 * (refundBars + s.taxItems.length + 1) + 0.01;
      const di = incomeBars.reduce((u, src) => u + src.total, 0) - t.income;
      const ds = sum(spentParts) - t.spent;
      const dt = sum(taxParts) - t.refunds - t.taxes;
      assert.ok(Math.abs(di) <= tolIncome, `${label}: income bars ${t.income + di}, tile ${t.income}`);
      assert.ok(Math.abs(ds) <= tolSpent, `${label}: spent parts ${t.spent + ds}, tile ${t.spent}`);
      assert.ok(Math.abs(dt) <= tolTax, `${label}: tax parts less refunds ${t.taxes + dt}, tile ${t.taxes}`);

      // What could not be paid is the section's "could not fund".
      const unpaid = flows.unpaid.reduce((u, x) => u + x.amount, 0);
      assert.ok(Math.abs(unpaid - s.drawn.unfunded) <= 0.5 * flows.unpaid.length + 0.01,
        `${label}: unpaid ${unpaid}, the section's could-not-fund ${s.drawn.unfunded.toFixed(2)}`);

      for (const src of flows.sources) {
        assert.equal(src.total, src.parts.reduce((u, pt) => u + pt.amount, 0), `${label}: ${src.name}'s parts do not add up to it`);
        for (const pt of src.parts) assert.ok(pt.amount > 0, `${label}: ${src.name} → ${pt.to} is ${pt.amount}`);
      }
      windowsChecked++;
    }
  });
}

await check('the corpus checked thousands of windows, most with nothing to explain', () => {
  assert.ok(windowsChecked > 5000, `only ${windowsChecked}`);
  assert.ok(exactWindows > windowsChecked / 2, `only ${exactWindows} of ${windowsChecked} windows match the section exactly`);
});

// ── Each bar ─────────────────────────────────────────────────────────

console.log('\n── Each account\'s bar is its own debits ──\n');

const PAID = new Set([EventType.TRANSFER, EventType.SETTLEMENT, EventType.GROSS_UP, EventType.SPILLOVER,
  EventType.FICA_WITHHOLDING, EventType.INCOME_TAX_WITHHOLDING, EventType.CAPITAL_GAINS_TAX,
  EventType.TAX_TRUE_UP, EventType.NIIT_ASSESSED, EventType.ONE_TIME]);

for (const name of ['quickstart-midCareer', 'quickstart-retired', 'brokerage-only-retirement', 'single-home-sale',
                    'settlement-exhausts-fallback', 'annual-trueup-from-brokerage', 'ira-drained-by-a-bill',
                    'home-sold-by-its-rule', 'housing-rules-cover-half']) {
  const p = run(name);
  await check(`${name}: every year, each account's bar is the sum of its debits, rounded once`, () => {
    for (let y = p.firstDateInt.year; y <= p.lastDateInt.year; y++) {
      const w = yearWindow(p, y);
      const flows = moneyFlows(p, w.from, w.to);
      for (const asset of p.modelAssets) {
        let debits = 0;
        for (const e of asset.events) {
          if (!PAID.has(e.type) || e.amount.amount >= 0) continue;
          const idx = bookedMonthIndex(e, p.firstDateInt, p.traceScopes);
          if (idx < w.from || idx > w.to) continue;
          debits -= e.amount.amount;
        }
        const bar = flows.sources.find((s) => s.name === asset.displayName
          && (s.role === SourceRole.ACCOUNT || s.role === SourceRole.INCOME));
        assert.ok(Math.abs((bar?.total ?? 0) - debits) <= 0.5 + 1e-6,
          `${y}: ${asset.displayName}'s bar is ${bar?.total ?? 0}, its debits ${debits.toFixed(2)}`);
      }
    }
  });
}

// ── Mid Career ───────────────────────────────────────────────────────

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
  assert.equal(propertyTax.toGroup, 'realestate', 'property tax shows the property, not the tax office');
});

await check('June 2030: each rule claims what it moved, read the right way round', () => {
  const f = month(mid, 2030, 6);
  const r = rulesInForce(mid, f);
  const brokerage = sourceOf(f, 'Brokerage', SourceRole.ACCOUNT);
  assert.equal(ruleOf(r, 'Salary', 'Brokerage').moved, 5232);
  assert.equal(ruleOf(r, 'Salary', 'Brokerage').setting, '93% of take-home pay');
  assert.equal(ruleOf(r, 'Salary', '401K').setting, '5% of gross pay');
  assert.equal(ruleOf(r, 'Brokerage', 'Living Expenses').setting, '100% of the bill');
  // Housing rules are paid by the account they name: their money runs in.
  const mortgage = ruleOf(r, 'Brokerage', 'Mortgage');
  assert.ok(mortgage, 'the mortgage rule does not read Brokerage → Mortgage');
  // Parts are rounded to add up to their bar, so a part can move by a dollar.
  assert.equal(mortgage.moved, partOf(brokerage, 'Mortgage').amount);
  assert.ok(Math.abs(mortgage.moved - 2023) <= 1, `the mortgage rule moved ${mortgage.moved}`);
  assert.equal(mortgage.kind, FlowKind.SPENT);
  const home = ruleOf(r, 'Brokerage', 'Home');
  assert.equal(home.moved, partOf(brokerage, 'Home').amount);
  assert.ok(Math.abs(home.moved - 456) <= 1, `the property rule moved ${home.moved}`);
  assert.equal(home.kind, FlowKind.TAX, 'a rule that moved only property tax is colored as tax');
  assert.equal(groupOf(r, 'leftover').amount, 281);
  assert.equal(groupOf(r, 'incomeTax').amount, 549 + 641);
  assert.ok(!r.rules.some((x) => x.payer === '401K' && x.payee === 'Living Expenses'), 'a Retire rule is shown in 2030');
});

await check('June 2060: the RMD is automatic, the Retire settings stand alone, and ended rules moved nothing', () => {
  const f = month(mid, 2060, 6);
  const rmd = partOf(sourceOf(f, '401K', SourceRole.ACCOUNT), 'Brokerage', FlowVia.RMD);
  assert.equal(rmd.amount, 1598);
  assert.equal(rmd.kind, FlowKind.ACCOUNTS);
  const r = rulesInForce(mid, f);
  assert.equal(groupOf(r, 'rmd').amount, 1598);
  assert.equal(ruleOf(r, 'Brokerage', 'Living Expenses').setting, '60% of the bill',
    'an Accumulate setting is shown beside a Retire one');
  assert.equal(ruleOf(r, '401K', 'Living Expenses').setting, '40% of the bill');
  const salary = r.rules.filter((x) => x.owner === 'Salary');
  assert.ok(salary.length && salary.every((x) => x.moved === 0), 'the ended paycheck\'s rules moved money');
  const firstIdle = r.rules.findIndex((x) => x.moved === 0);
  assert.ok(r.rules.slice(firstIdle).every((x) => x.moved === 0), 'rules that moved nothing are not listed last');
});

await check('January 2048, Retire\'s first month: the ended paycheck\'s rules moved nothing', () => {
  const idx = DateInt.diffMonths(mid.firstDateInt, DateInt.from(2048, 1));
  const r = rulesInForce(mid, moneyFlows(mid, idx, idx));
  const salary = r.rules.filter((x) => x.owner === 'Salary');
  assert.equal(salary.length, 3);
  for (const x of salary) assert.equal(x.moved, 0, `${x.payer} → ${x.payee} moved ${x.moved}`);
  assert.deepEqual(salary[0].phases, ['Retire']);
});

// ── One case per thing that was wrong once ───────────────────────────

console.log('\n── The cases ──\n');

await check('a drained IRA: its $0 withholding names what the spillover paid', () => {
  const f = month(run('ira-drained-by-a-bill'), 2026, 4);
  const spill = sourceOf(f, 'Brokerage', SourceRole.ACCOUNT).parts
    .find((pt) => pt.via === FlowVia.SPILLOVER && pt.kind === FlowKind.TAX);
  assert.ok(spill, 'no tax spillover in the month the IRA emptied');
  assert.equal(spill.to, 'Income tax');
});

/** A plan whose Retire event closes the paycheck and sells a rental. */
async function lifeEventSale() {
  setUp({ startAge: 58, retirementAge: 60, filingAs: 'Single' });
  const START = { year: 2026, month: 1 }, END = { year: 2030, month: 12 };
  const a = (x) => ModelAsset.fromJSON({ startDateInt: START, finishDateInt: END, annualReturnRate: { rate: 0 }, ...x });
  const assets = [
    a({ instrument: 'workingIncome', displayName: 'Salary', startCurrency: { amount: 9000 }, startBasisCurrency: { amount: 0 } }),
    a({ instrument: 'realEstate', displayName: 'Rental', isPrimaryHome: false,
        startCurrency: { amount: 600000 }, startBasisCurrency: { amount: 300000 } }),
    a({ instrument: 'bank', displayName: 'Checking', startCurrency: { amount: 50000 }, startBasisCurrency: { amount: 50000 } }),
    a({ instrument: 'monthlyExpense', displayName: 'Living', startCurrency: { amount: -5000 }, startBasisCurrency: { amount: 0 } }),
  ];
  const accumulate = ModelLifeEvent.createDefault(LifeEvent.ACCUMULATE, 58);
  accumulate.phaseTransfers = { Living: [{ toDisplayName: 'Checking', monthlyMoveValue: 100, closeMoveValue: 0 }] };
  const retire = ModelLifeEvent.createDefault(LifeEvent.RETIRE, 60);
  retire.closes = ['Salary', 'Rental'];
  retire.phaseTransfers = { Living: [{ toDisplayName: 'Checking', monthlyMoveValue: 100, closeMoveValue: 0 }] };
  const p = new Portfolio(assets, false, simConfigFromGlobals());
  p.lifeEvents = [accumulate, retire];
  await chronometer_run(p);
  return p;
}

await check('a sale a life event makes counts in the trigger month, where the section books it', async () => {
  const p = await lifeEventSale();
  const rental = p.modelAssets.find((x) => x.displayName === 'Rental');
  const trigger = DateInt.diffMonths(p.firstDateInt, rental.closedDateInt);
  const before = moneyFlows(p, trigger - 1, trigger - 1), at = moneyFlows(p, trigger, trigger);
  assert.equal(sourceOf(before, 'Rental'), undefined, 'the sale shows in the month before the life event');
  const tax = partOf(sourceOf(at, 'Rental', SourceRole.ACCOUNT), 'Capital gains tax');
  assert.ok(tax?.amount > 30000, 'no capital-gains tax in the trigger month');
  const s = monthSummary(p, rental.closedDateInt.year, rental.closedDateInt.month);
  assert.equal(at.totals.taxes, -headlineAsShown(s).taxes - at.totals.propertyTaxLag);
});

await check('a home\'s close rule is its own row, read out of the home, and claims the sale', () => {
  const p = run('home-sold-by-its-rule');
  const f = month(p, 2027, 7);
  const r = rulesInForce(p, f);
  const sale = ruleOf(r, 'Home', 'Brokerage', 'close');
  assert.ok(sale, 'no Home → Brokerage close row');
  assert.equal(sale.setting, '100% at close');
  assert.equal(sale.moved, partOf(sourceOf(f, 'Home', SourceRole.ACCOUNT), 'Brokerage', FlowVia.RULE_AT_CLOSE).amount);
  assert.ok(sale.moved > 500000);
  assert.equal(ruleOf(r, 'Brokerage', 'Home').setting, '100% of property costs');
  assert.equal(groupOf(r, 'other'), undefined, 'a part fell through to "Other transfers"');
});

await check('rules that cover half: each claims its half, and the backstop\'s half is a bill no rule covers', () => {
  const p = run('housing-rules-cover-half');
  const f = month(p, 2026, 6);
  const r = rulesInForce(p, f);
  const checking = sourceOf(f, 'Checking', SourceRole.ACCOUNT);
  const backstop = checking.parts.filter((pt) => pt.via === FlowVia.BACKSTOP);
  const byRule = checking.parts.filter((pt) => pt.via === FlowVia.SETTLEMENT);
  assert.equal(backstop.length, 3, 'the backstop\'s mortgage, property tax and maintenance halves');
  assert.equal(ruleOf(r, 'Checking', 'Mortgage').moved, partOf(checking, 'Mortgage', FlowVia.SETTLEMENT).amount);
  assert.ok(Math.abs(ruleOf(r, 'Checking', 'Mortgage').moved - partOf(checking, 'Mortgage', FlowVia.BACKSTOP).amount) <= 1,
    'the mortgage rule does not claim half');
  assert.equal(groupOf(r, 'uncovered').amount, backstop.reduce((t, pt) => t + pt.amount, 0));
  assert.equal(byRule.length, 3);
});

await check('a mortgage paid and prepaid from one account: two rows, one paying a bill, one moving money in', () => {
  const p = run('mortgage-paid-and-prepaid');
  const f = month(p, 2026, 6);
  const r = rulesInForce(p, f);
  const rows = r.rules.filter((x) => x.payer === 'Checking' && x.payee === 'Mortgage');
  assert.equal(rows.length, 2);
  const payment = rows.find((x) => x.owner === 'Mortgage'), prepayment = rows.find((x) => x.owner === 'Checking');
  assert.equal(payment.kind, FlowKind.SPENT);
  assert.equal(prepayment.kind, FlowKind.ACCOUNTS);
  const checking = sourceOf(f, 'Checking', SourceRole.ACCOUNT);
  assert.equal(payment.moved, partOf(checking, 'Mortgage', FlowVia.SETTLEMENT).amount);
  assert.equal(prepayment.moved, partOf(checking, 'Mortgage', FlowVia.RULE).amount);
  assert.equal(prepayment.setting, '1% of the balance, monthly');
});

await check('an unpayable annual true-up is unpaid tax in January, in both sections', () => {
  const p = run('unpayable-annual-true-up');
  const dec = month(p, 2026, 12), jan = month(p, 2027, 1);
  assert.equal(dec.unpaid.length, 0);
  const tax = jan.unpaid.find((u) => u.kind === UnpaidKind.TAX);
  assert.ok(tax?.amount > 5000, 'no unpaid true-up in January');
  assert.equal(monthSummary(p, 2026, 12).drawn.unfunded, 0, 'the section still dates it December');
  assert.ok(Math.abs(monthSummary(p, 2027, 1).drawn.unfunded - tax.amount) <= 0.5);
});

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

await check('income tax drawn from an account as the year goes is estimated tax, not withholding', () => {
  const f = month(run('brokerage-only-retirement'), 2026, 1);
  const part = partOf(sourceOf(f, 'Brokerage', SourceRole.ACCOUNT), 'Income tax');
  assert.equal(part.via, FlowVia.ESTIMATED);
  const r = rulesInForce(run('brokerage-only-retirement'), f);
  assert.ok(groupOf(r, 'estimated').partIds.includes(part.id));
  assert.ok(groupOf(r, 'incomeTax').items.every((i) => i.source === 'Pension'), 'pension withholding is tax withheld from income');
});

await check('a spillover pays what the drained account was paying', () => {
  // February 2050: the Roth IRA is empty; the Brokerage pays its share of Living Expenses.
  const f = month(run('quickstart-retired'), 2050, 2);
  const spill = partOf(sourceOf(f, 'Brokerage', SourceRole.ACCOUNT), 'Living Expenses', FlowVia.SPILLOVER);
  assert.ok(spill?.amount > 0, 'no spillover part to Living Expenses');
  assert.equal(spill.kind, FlowKind.SPENT);
  const r = rulesInForce(run('quickstart-retired'), f);
  assert.ok(groupOf(r, 'spillover').partIds.includes(spill.id));
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
  const into = partOf(sourceOf(f, 'Dividends and interest', SourceRole.YIELD), 'Brokerage');
  assert.equal(into.kind, FlowKind.ACCOUNTS);
  assert.equal(into.amount, 546 + 234);
});

await check('a windfall is a bar of its own, and not in the figures', () => {
  const f = month(run('dividends-caps-and-windfalls'), 2027, 6);
  assert.equal(sourceOf(f, 'Inheritance', SourceRole.ONE_TIME).total, 50000);
  assert.equal(f.totals.oneTimeIn, 50000);
  assert.ok(f.totals.income < 50000);
  assert.equal(f.totals.intoAccounts, f.totals.income - f.totals.spent - f.totals.taxes);
});

await check('a down payment moves money into the home as it opens', () => {
  const p = run('home-bought-with-a-down-payment');
  const f = month(p, 2027, 4);
  const down = partOf(sourceOf(f, 'Brokerage', SourceRole.ACCOUNT), 'House', FlowVia.OPENING);
  assert.equal(down.amount, 100000);
  assert.equal(down.kind, FlowKind.ACCOUNTS);
  assert.ok(groupOf(rulesInForce(p, f), 'opening').partIds.includes(down.id));
});

await check('unpaid amounts by what they were: tax, bills, and pay with nowhere to go', () => {
  const kinds = (f) => Object.fromEntries(f.unpaid.map((u) => [u.kind, u.amount]));
  // Withholding a drained wallet could not pay: tax, read from the draw it fell short of.
  assert.ok(kinds(month(run('trueup-draw-unfunded'), 2026, 7))[UnpaidKind.TAX] > 0);
  // Insurance no account could pay: a bill; property tax: tax.
  const settle = kinds(month(run('settlement-unfunded'), 2026, 3));
  assert.ok(settle[UnpaidKind.SPENT] > 0 && settle[UnpaidKind.TAX] > 0, JSON.stringify(settle));
  const unfundable = month(run('unfundable-tax-bill'), 2028, 7);
  assert.equal(unfundable.totals.unplacedIncome, 3000);
  assert.ok(kinds(unfundable)[UnpaidKind.SPENT] > 0, 'the unpaid bill is missing');
});

// ── The rules list ───────────────────────────────────────────────────

console.log('\n── Every part lands in exactly one row of the rules list ──\n');

const groupsSeen = new Set();
let partsChecked = 0, closeRowsClaiming = 0;
for (const [name, p] of runs) {
  await check(`${name}: every window, each part is in one row, between that row's own accounts`, () => {
    for (const { label, w } of windows(p)) {
      const flows = moneyFlows(p, w.from, w.to);
      const r = rulesInForce(p, flows);
      const claimed = [...r.rules, ...r.automatic].flatMap((row) => row.partIds);
      const byId = new Map(flows.sources.flatMap((s) => s.parts.map((pt) => [pt.id, { s, pt }])));
      assert.equal(byId.size, flows.sources.reduce((t, s) => t + s.parts.length, 0), `${label}: two parts share an id`);
      assert.deepEqual([...claimed].sort(), [...byId.keys()].sort(), `${label}: the rows do not claim each part once`);
      const total = flows.sources.reduce((t, s) => t + s.total, 0);
      const rowsTotal = r.rules.reduce((t, x) => t + x.moved, 0) + r.automatic.reduce((t, x) => t + x.amount, 0);
      assert.equal(rowsTotal, total, `${label}: the rows add to ${rowsTotal}, the bars to ${total}`);
      for (const rule of r.rules) {
        for (const id of rule.partIds) {
          const { s, pt } = byId.get(id);
          assert.ok(s.name === rule.payer && pt.to === rule.payee,
            `${label}: ${rule.payer} → ${rule.payee} claims ${s.name} → ${pt.to}`);
        }
        if (rule.half === 'close' && rule.moved > 0) closeRowsClaiming++;
      }
      for (const a of r.automatic) groupsSeen.add(a.key);
      partsChecked += byId.size;
    }
  });
}

await check('every automatic group occurs in the corpus, none falls through to "other", and close rows claim', () => {
  for (const key of ['incomeTax', 'drawTax', 'estimated', 'gainsTax', 'settlement', 'refund', 'rmd', 'leftover',
                     'uncovered', 'spillover', 'close', 'opening', 'yield', 'oneTime']) {
    assert.ok(groupsSeen.has(key), `no window has the "${key}" group`);
  }
  assert.ok(!groupsSeen.has('other'), 'a part fell through to "Other transfers"');
  assert.ok(closeRowsClaiming > 0, 'no close row claimed anything');
  assert.ok(partsChecked > 40000, `only ${partsChecked} parts checked`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
