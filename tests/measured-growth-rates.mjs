/**
 * measured-growth-rates.mjs
 *
 * An annual rate means one of two things, and the monthly step differs:
 *
 *   MEASURED  an annual change observed start-to-end — a market return,
 *             inflation, a savings APY, home appreciation. Twelve monthly
 *             steps must compound to EXACTLY the stated rate.
 *   NOMINAL   a contract APR (mortgage, debt), or an annual charge prorated
 *             (property tax, maintenance, a dividend yield). The month's
 *             figure is one twelfth.
 *
 * Until 2026-09-23 the engine used rate/12 for both, so a stated 8.5% return
 * realised 8.839% a year and a 30-year plan ended ~9.8% richer than its own
 * assumptions — and the calibrated Monte Carlo, which draws measured annual
 * returns, could not agree with the plan.
 *
 * Every expected value below is ANALYTIC — written from the rule, before the
 * change, not read back from the engine. One per conversion site, so moving
 * any site to the other convention fails exactly one named check.
 *
 * Run: node tests/measured-growth-rates.mjs   (from src/)
 */

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

import assert from 'node:assert/strict';

const G = await import('../js/globals.js');
const { Portfolio } = await import('../js/portfolio.js');
const { ModelAsset } = await import('../js/model-asset.js');
const { chronometer_run } = await import('../js/chronometer.js');
const { Metric } = await import('../js/metric.js');
const { ARR } = await import('../js/utils/arr.js');

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); failed++; }
}
const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol,
    `${what}: got ${actual.toFixed(4)}, expected ${expected.toFixed(4)} (off by ${Math.abs(actual - expected).toFixed(4)})`);

const START = { year: 2026, month: 1 };
const until = (years) => ({ year: 2026 + years - 1, month: 12 });
const A = (years, x) => ({ startDateInt: START, finishDateInt: until(years), startBasisCurrency: { amount: 0 }, ...x });

async function run(years, assets) {
    G.global_reset();
    G.global_setUserStartAge(40);
    G.global_setUserRetirementAge(70);
    G.setActiveTaxTable(G.makeActiveTaxTable());
    const p = new Portfolio(assets.map((a) => ModelAsset.fromJSON(A(years, a))), false, G.simConfigFromGlobals());
    await chronometer_run(p);
    return (name, metric) => p.modelAssets.find((a) => a.displayName === name).getHistory(metric);
}

// ── ARR itself ───────────────────────────────────────────────────────

console.log('\n── The two conversions ──\n');

await test('asMonthlyEffective compounds to exactly the annual rate', () => {
    for (const r of [0.031, 0.085, 0.15, -0.2]) {
        near(Math.pow(1 + new ARR(r).asMonthlyEffective(), 12), 1 + r, 1e-12, `${r}`);
    }
});

await test('asMonthlyNominal is one twelfth', () => {
    assert.equal(new ARR(0.065).asMonthlyNominal(), 0.065 / 12);
});

await test('there is no ambiguous asMonthly() to reach for', () => {
    // Removing it forced every caller to say which one it means. Bringing it
    // back invites the next caller to not decide.
    assert.equal(ARR.prototype.asMonthly, undefined);
});

// ── MEASURED sites ───────────────────────────────────────────────────

console.log('\n── Measured: twelve months compound to the stated rate ──\n');

await test('a brokerage at 8.5% for 30 years ends at 100,000 × 1.085^30', async () => {
    const h = await run(30, [{ instrument: 'taxableEquity', displayName: 'Brokerage',
        annualReturnRate: { rate: 0.085 }, startCurrency: { amount: 100_000 }, startBasisCurrency: { amount: 100_000 } }]);
    // $1,155,825.19. Under rate/12 this plan ended at $1,269,250.
    near(h('Brokerage', Metric.VALUE).at(-1), 100_000 * Math.pow(1.085, 30), 0.05, 'ending value');
});

await test('a savings account at 4% grows by exactly 4% in a year', async () => {
    const h = await run(1, [{ instrument: 'bank', displayName: 'Savings',
        annualReturnRate: { rate: 0.04 }, startCurrency: { amount: 100_000 }, startBasisCurrency: { amount: 100_000 } }]);
    near(h('Savings', Metric.VALUE).at(-1), 104_000, 0.02, 'balance after 12 months');
});

await test('a home at 3% appreciates by exactly 3% in a year', async () => {
    const h = await run(1, [
        { instrument: 'realEstate', displayName: 'Home', isPrimaryHome: true,
          annualReturnRate: { rate: 0.03 }, startCurrency: { amount: 500_000 }, startBasisCurrency: { amount: 500_000 } },
        { instrument: 'bank', displayName: 'Checking', startCurrency: { amount: 50_000 }, startBasisCurrency: { amount: 50_000 } },
    ]);
    near(h('Home', Metric.VALUE)[11], 515_000, 0.02, 'home value after 12 months');
});

await test('an expense at the default rate costs exactly 3.1% more a year later', async () => {
    const h = await run(2, [
        { instrument: 'monthlyExpense', displayName: 'Living', startCurrency: { amount: -1000 },
          fundTransfers: [{ toDisplayName: 'Checking', monthlyMoveValue: 100, closeMoveValue: 0 }] },
        { instrument: 'bank', displayName: 'Checking', startCurrency: { amount: 100_000 }, startBasisCurrency: { amount: 100_000 } },
    ]);
    const charges = h('Living', Metric.LIVING_EXPENSE);
    near(charges[12], -1000 * 1.031, 0.01, 'month-13 charge');
    near(charges[24 - 1], -1000 * Math.pow(1.031, 23 / 12), 0.01, 'month-24 charge');
});

// ── NOMINAL sites ────────────────────────────────────────────────────

console.log('\n── Nominal: one twelfth, as the contract or the charge defines it ──\n');

await test('a mortgage charges APR/12 of the balance — the lender\'s own amortization', async () => {
    const h = await run(1, [
        { instrument: 'mortgage', displayName: 'Mortgage', annualReturnRate: { rate: 0.065 },
          startCurrency: { amount: -300_000 }, monthsRemaining: 360 },
        { instrument: 'bank', displayName: 'Checking', startCurrency: { amount: 100_000 }, startBasisCurrency: { amount: 100_000 } },
    ]);
    near(h('Mortgage', Metric.MORTGAGE_INTEREST)[0], -300_000 * 0.065 / 12, 0.005, 'first month interest');
    // The standard 30-year payment on $300k at 6.5%: $1,896.20.
    const i = 0.065 / 12;
    const payment = 300_000 * i * Math.pow(1 + i, 360) / (Math.pow(1 + i, 360) - 1);
    near(-h('Mortgage', Metric.MORTGAGE_PAYMENT)[0], payment, 0.01, 'monthly payment');
});

await test('debt accrues at APR/12', async () => {
    const h = await run(1, [{ instrument: 'debt', displayName: 'Card', annualReturnRate: { rate: 0.12 },
        startCurrency: { amount: -10_000 } }]);
    near(h('Card', Metric.VALUE)[0], -10_000 * 1.01, 0.005, 'balance after one month at 12% APR');
});

await test('property tax and maintenance are one twelfth of the annual charge on the month\'s value', async () => {
    const h = await run(1, [
        { instrument: 'realEstate', displayName: 'Home', isPrimaryHome: true,
          annualReturnRate: { rate: 0.03 }, annualTaxRate: { rate: 0.012 }, annualMaintenanceRate: { rate: 0.01 },
          startCurrency: { amount: 500_000 }, startBasisCurrency: { amount: 500_000 } },
        { instrument: 'bank', displayName: 'Checking', startCurrency: { amount: 50_000 }, startBasisCurrency: { amount: 50_000 } },
    ]);
    const value = h('Home', Metric.VALUE)[0];   // after the month's appreciation
    near(value, 500_000 * Math.pow(1.03, 1 / 12), 0.01, 'month-1 value');
    near(h('Home', Metric.PROPERTY_TAX)[0], -value * 0.012 / 12, 0.01, 'month-1 property tax');
    near(h('Home', Metric.MAINTENANCE)[0], -value * 0.01 / 12, 0.01, 'month-1 maintenance');
});

await test('a dividend yield pays one twelfth a month on the grown balance', async () => {
    const h = await run(1, [{ instrument: 'taxableEquity', displayName: 'Brokerage',
        annualReturnRate: { rate: 0.06 }, annualDividendRate: { rate: 0.024 }, dividendQualifiedRatio: 1,
        startCurrency: { amount: 120_000 }, startBasisCurrency: { amount: 120_000 } }]);
    const grown = 120_000 * Math.pow(1.06, 1 / 12);
    near(h('Brokerage', Metric.QUALIFIED_DIVIDEND)[0], grown * 0.024 / 12, 0.01, 'month-1 dividend');
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);
process.exit(failed > 0 ? 1 : 0);
