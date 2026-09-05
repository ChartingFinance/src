/**
 * grossup-premium.mjs — the gross-up may not withdraw for a tax that is not coming.
 *
 * ── What went wrong ──────────────────────────────────────────────────
 *
 * When an expense cannot be funded, the engine withdraws MORE than the shortfall
 * so that what is left after capital-gains tax still covers it. Sizing that
 * premium requires predicting how much gain the withdrawal will realize, and the
 * prediction was made against the account's headline gain ratio:
 *
 *     W = X / (1 - t * getUnrealizedGainRatio())
 *
 * That is not the rule the account applies. `ModelAsset.planWithdrawal` draws
 * this month's fresh deposits FIRST at zero gain, and sells the remainder
 * pro-rata. A backstop account that receives income and pays expenses in the
 * same month therefore realizes almost nothing while its headline ratio can read
 * 80%.
 *
 * Two failures came out of that, and only the second one left a trace:
 *
 *   1. A premium was withdrawn in months where the draw realized NO gain at all.
 *      The booking is guarded by `realizedGain > 0`; the withdrawal is not. So
 *      the cash left and `estimatedTaxes` recorded nothing — the field
 *      under-counted its own damage, and a fixture could lose money with every
 *      tax figure looking untouched. Measured: four snapshot fixtures gained
 *      $4,850–$13,352 of ending net worth when this was fixed, with expenses
 *      unchanged to the cent.
 *   2. Where a gain WAS realized, the premium could still be far too large.
 *      `grossup-at-the-ltcg-boundary` provisioned 26.9% of the gain it realized;
 *      the correct figure is a marginal LTCG rate.
 *
 * ── What is asserted, and why in this shape ──────────────────────────
 *
 * The first two checks pin the PREDICTOR to the ACTUAL: `planWithdrawal` must
 * return what `debit()` goes on to do. They are the same code today — #transact
 * applies the plan rather than recomputing — and this is what stops that being
 * quietly undone, since a second copy of the realization rule is exactly how
 * the original bug happened.
 *
 * The corpus check is an upper bound rather than an equality. The marginal rate
 * varies by year and by fixture, so the honest invariant is that a provision for
 * capital-gains tax cannot exceed the highest rate that tax has — anything above
 * that is provisioning for a liability that cannot exist. It caught all three
 * over-sized fixtures at 269%, 297% and 790%.
 *
 * Run: node tests/grossup-premium.mjs
 */

import assert from 'node:assert/strict';

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

const G = await import('../js/globals.js');
const { makeActiveTaxTable, simConfigFromGlobals } = G;
const { ModelAsset } = await import('../js/model-asset.js');
const { Currency } = await import('../js/utils/currency.js');
const { Portfolio } = await import('../js/portfolio.js');
const { chronometer_run } = await import('../js/chronometer.js');
const { SNAPSHOT_FIXTURES } = await import('./tools/fixtures.mjs');

/** The top federal long-term capital gains rate. Nothing may provision above it. */
const MAX_LTCG_RATE = 0.20;

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

/**
 * An asset ready to transact.
 *
 * `fromJSON` builds the CONFIGURATION; the balances a withdrawal reads are run
 * state, which initializeChron() creates. Skipping it leaves finishCurrency
 * undefined, which fails as "cannot read properties of undefined" the moment
 * anything touches it — the trap Part B of the ModelAsset split exists to remove.
 */
const brokerage = ({ value, basis }) => {
  const a = ModelAsset.fromJSON({
    instrument: 'taxableEquity', displayName: 'Brokerage',
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2030, month: 12 },
    startCurrency: { amount: value }, startBasisCurrency: { amount: basis },
    annualReturnRate: { rate: 0 },
  });
  a.initializeChron();
  // initializeChron creates the run state but leaves the balance at zero — the
  // opening value is written by applyFirstDayOfMonth once the asset's first
  // month arrives. These checks are about one withdrawal, not about a month, so
  // the balance is placed directly rather than running a chronometer to get it.
  a.finishCurrency = new Currency(value);
  a.finishBasisCurrency = new Currency(basis);
  return a;
};

console.log('\n── The prediction is what actually happens ──\n');

await check('planWithdrawal matches debit(), with no fresh deposits', () => {
  const a = brokerage({ value: 100000, basis: 20000 });   // 80% gain
  const plan = a.planWithdrawal(new Currency(10000));
  const actual = a.debit(new Currency(10000), { type: 'transfer' });
  assert.equal(plan.realizedGain.amount.toFixed(6), actual.realizedGain.amount.toFixed(6),
    `predicted ${plan.realizedGain.amount}, realized ${actual.realizedGain.amount}`);
  assert.ok(plan.realizedGain.amount > 0, 'a pure vested draw realized nothing — check the fixture');
});

await check('planWithdrawal matches debit(), when fresh deposits cover the draw', () => {
  const a = brokerage({ value: 100000, basis: 20000 });
  a.credit(new Currency(12000), { type: 'transfer' });    // this month's deposit
  const plan = a.planWithdrawal(new Currency(10000));
  assert.equal(plan.realizedGain.amount, 0,
    'a draw covered entirely by this month\'s deposits predicted a gain');
  const actual = a.debit(new Currency(10000), { type: 'transfer' });
  assert.equal(actual.realizedGain.amount, 0, 'and it realized one anyway');
});

await check('planWithdrawal matches debit(), when deposits cover only part', () => {
  const a = brokerage({ value: 100000, basis: 20000 });
  a.credit(new Currency(4000), { type: 'transfer' });
  const plan = a.planWithdrawal(new Currency(10000));
  const actual = a.debit(new Currency(10000), { type: 'transfer' });
  assert.equal(plan.realizedGain.amount.toFixed(6), actual.realizedGain.amount.toFixed(6));
  assert.ok(plan.realizedGain.amount > 0, 'the vested remainder realized nothing');
  // The headline ratio would have predicted 80% of the whole draw. The rule
  // predicts gain only on the part that came out of vested holdings.
  assert.ok(plan.realizedGain.amount < 0.8 * 10000,
    'the prediction still looks like the headline ratio applied to the whole draw');
});

console.log('\n── An expense paid from the month\'s own income takes no premium ──\n');

await check('income in, expense out, same account, same month: nothing extra withdrawn', async () => {
  // The case the old formula got worst. Salary lands in the brokerage and the
  // expense is drawn from it; almost nothing is sold, so almost no gain is
  // realized, and the correct premium is zero. The old code withdrew $48,391
  // over three years for a tax that never came due, and recorded none of it.
  G.global_reset(); G.global_setAllocateHouseholdTax(false);
  G.global_setUserStartAge(60); G.global_setUserRetirementAge(70); G.global_setUserFinishAge(64);
  G.global_setFilingAs('Single');
  G.setActiveTaxTable(makeActiveTaxTable());

  const assets = [
    { instrument: 'workingIncome', displayName: 'Salary', startCurrency: { amount: 15000 } },
    { instrument: 'taxableEquity', displayName: 'Brokerage', startCurrency: { amount: 500000 }, startBasisCurrency: { amount: 100000 } },
    { instrument: 'monthlyExpense', displayName: 'Living', startCurrency: { amount: 10000 } },
  ].map(o => ModelAsset.fromJSON({
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2028, month: 12 },
    startBasisCurrency: { amount: 0 }, annualReturnRate: { rate: 0 }, ...o,
  }));

  const p = new Portfolio(assets, false, simConfigFromGlobals());
  await chronometer_run(p);

  let grossUp = 0;
  for (const a of p.modelAssets) for (const e of (a.events ?? [])) if (e.type === 'grossUp') grossUp += e.amount?.amount ?? 0;

  const premium = Math.abs(grossUp) - Math.abs(p.total.expense.amount);
  assert.ok(Math.abs(grossUp) > 0, 'no gross-up fired — this check is not exercising the path');
  assert.ok(Math.abs(premium) < 0.02,
    `withdrew ${premium.toFixed(2)} more than the expenses it was settling, for a tax on a `
    + `gain of ${p.total.longTermCapitalGains.amount.toFixed(2)}`);

  // And with nothing over-withdrawn, the household's reported federal tax is the
  // tax it was actually charged.
  const charged = p.total.incomeTax.amount + p.total.socialSecurityTax.amount
                + p.total.medicareTax.amount + p.total.longTermCapitalGainsTax.amount
                + p.total.niit.amount;
  assert.ok(Math.abs(p.total.federalTaxes().amount - charged) < 0.02,
    `federalTaxes() ${p.total.federalTaxes().amount.toFixed(2)} vs charges ${charged.toFixed(2)}`);
});

console.log('\n── No fixture provisions more than the tax could ever be ──\n');

const provisioning = [];
for (const f of SNAPSHOT_FIXTURES) {
  G.global_reset(); G.global_setAllocateHouseholdTax(false); G.global_setBacktestYearDirect?.('current');
  const c = f.config ?? {};
  if (c.startAge != null) G.global_setUserStartAge(c.startAge);
  if (c.retirementAge != null) G.global_setUserRetirementAge(c.retirementAge);
  if (c.finishAge != null) G.global_setUserFinishAge(c.finishAge);
  if (c.filingAs != null) G.global_setFilingAs(c.filingAs);
  G.setActiveTaxTable(makeActiveTaxTable());
  const built = f.build();
  const p = new Portfolio(built.assets, false, simConfigFromGlobals());
  if (built.lifeEvents) p.lifeEvents = built.lifeEvents;
  if (built.guardrails) p.guardrailsParams = built.guardrails;
  await chronometer_run(p);
  const est = Math.abs(p.total.estimatedTaxes.amount);
  if (est > 0.005) provisioning.push({ name: f.name, est, gain: p.total.longTermCapitalGains.amount });
}

await check('some fixture actually takes a premium — this check is not vacuous', () => {
  assert.ok(provisioning.length > 0,
    'nothing in the corpus provisions capital-gains tax, so the bound below proves nothing');
});

for (const { name, est, gain } of provisioning) {
  await check(`${name}: provisions ${(est / gain * 100).toFixed(1)}% of the gain it realized`, () => {
    assert.ok(gain > 0, `provisioned ${est.toFixed(2)} against no realized gain at all`);
    assert.ok(est <= gain * MAX_LTCG_RATE + 0.02,
      `provisioned ${est.toFixed(2)} against ${gain.toFixed(2)} of gain — `
      + `${(est / gain * 100).toFixed(1)}%, above the ${MAX_LTCG_RATE * 100}% ceiling for the tax it is provisioning for`);
  });
}

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);
process.exit(failed > 0 ? 1 : 0);
