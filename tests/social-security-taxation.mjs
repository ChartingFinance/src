/**
 * social-security-taxation.mjs
 *
 * IRC §86 — how much of a Social Security benefit is taxable.
 *
 * Until 2026-09-23 the engine included 85% of every benefit, always. 85% is
 * §86's CEILING. A single retiree living on $3,500/month of Social Security was
 * billed $2,104 a year where the IRS says $0; one with $2,500 of Social Security
 * and a $2,500 pension, $4,480 where it says $3,082. It survived three code
 * reviews partly because two unit tests pinned the flat rule — the tests agreed
 * with the bug.
 *
 * ── What makes these non-vacuous ─────────────────────────────────────
 *
 *   THE WORKSHEET      every tier and both boundaries, hand-derived, for both
 *                      filing statuses — the same inputs give different answers
 *                      single and married, so a wrong threshold table fails.
 *
 *   PROVISIONAL INCOME long-term gains count, and a deductible contribution
 *                      reduces it. Each is asserted by a case whose answer
 *                      changes if the term is dropped.
 *
 *   NOT INDEXED        §86's amounts are fixed by statute. A year of inflation
 *                      must leave them where they are.
 *
 *   THE ENGINE         the two measured households, end to end.
 *
 * Run: node tests/social-security-taxation.mjs   (from src/)
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
const { chronometer_run } = await import('../js/chronometer.js');
const { ModelAsset } = await import('../js/model-asset.js');
const { TaxTable } = await import('../js/taxes.js');
const { FinancialPackage } = await import('../js/financial-package.js');
const { taxableBasis, taxableSocialSecurity } = await import('../js/tax-basis.js');

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); failed++; }
}

const SINGLE = { base: 25000, adjusted: 34000 };
const MARRIED = { base: 32000, adjusted: 44000 };

const near = (got, want, what) =>
    assert.ok(Math.abs(got - want) < 0.005, `${what}: got ${got}, want ${want}`);

/** A package with only the named fields set. */
function pkg(fields) {
    const p = new FinancialPackage();
    for (const [k, v] of Object.entries(fields)) p[k].amount = v;
    return p;
}

// ── the worksheet ────────────────────────────────────────────────────

console.log('\n── The §86 worksheet, every tier ──\n');

await test('single: provisional under the base — nothing taxable', () => {
    // 10,000 + 10,000 = 20,000 ≤ 25,000
    near(taxableSocialSecurity(20000, 10000, SINGLE), 0, 'taxable');
});

await test('single: exactly AT the base — still nothing', () => {
    // 15,000 + 10,000 = 25,000
    near(taxableSocialSecurity(20000, 15000, SINGLE), 0, 'taxable');
});

await test('single: between base and adjusted base — the 50% tier', () => {
    // provisional 30,000 → min(10,000, ½ × 5,000)
    near(taxableSocialSecurity(20000, 20000, SINGLE), 2500, 'taxable');
});

await test('single: exactly AT the adjusted base — the 50% tier\'s own cap', () => {
    // provisional 34,000 → min(10,000, ½ × 9,000) = 4,500
    near(taxableSocialSecurity(20000, 24000, SINGLE), 4500, 'taxable');
});

await test('single: above the adjusted base — the 85% tier', () => {
    // provisional 45,000 → min(25,500, 0.85 × 11,000 + min(15,000, 4,500))
    near(taxableSocialSecurity(30000, 30000, SINGLE), 13850, 'taxable');
});

await test('single: high income hits the 85% ceiling, never more', () => {
    near(taxableSocialSecurity(40000, 100000, SINGLE), 34000, 'taxable');
});

await test('married: the same inputs as a single filer, a different answer', () => {
    // provisional 40,000: married → min(15,000, ½ × 8,000) = 4,000
    //                     single  → min(25,500, 0.85 × 6,000 + 4,500) = 9,600
    near(taxableSocialSecurity(30000, 25000, MARRIED), 4000, 'married');
    near(taxableSocialSecurity(30000, 25000, SINGLE), 9600, 'single');
});

await test('married: the 85% tier uses ½ × (44,000 − 32,000) = 6,000', () => {
    // provisional 60,000 → min(42,500, 0.85 × 16,000 + min(25,000, 6,000))
    near(taxableSocialSecurity(50000, 35000, MARRIED), 19600, 'taxable');
});

await test('no benefits, no taxable benefits', () => {
    near(taxableSocialSecurity(0, 500000, SINGLE), 0, 'zero');
    near(taxableSocialSecurity(-100, 500000, SINGLE), 0, 'negative');
});

await test('across a sweep: never above 85%, never falling as other income rises', () => {
    for (const status of [SINGLE, MARRIED]) {
        for (const ss of [5000, 20000, 45000, 90000]) {
            let prev = -1;
            for (let other = 0; other <= 150000; other += 1250) {
                const t = taxableSocialSecurity(ss, other, status);
                assert.ok(t <= 0.85 * ss + 1e-9, `${t} exceeds 85% of ${ss}`);
                assert.ok(t >= prev - 1e-9, `fell from ${prev} to ${t} at other=${other}`);
                prev = t;
            }
        }
    }
});

// ── provisional income, as the package computes it ────────────────────

console.log('\n── What counts as "other income" ──\n');

const table = new TaxTable('Single', 10000);

await test('long-term gains count toward provisional income', () => {
    // other = 40,000 of LTCG → provisional 55,000
    // → min(25,500, 0.85 × 21,000 + 4,500) = 22,350; no other ordinary income.
    // Leaving gains out would give provisional 15,000 → 0.
    const p = pkg({ socialSecurityIncome: 30000, longTermCapitalGains: 40000 });
    near(p.irsTaxableGrossIncome(table).amount, 22350, 'gross ordinary');
});

await test('a deductible 401(k) contribution reduces provisional income', () => {
    // wages 40,000 − 401(k) 10,000 = 30,000 → provisional 45,000 → 13,850
    // Without the subtraction: provisional 55,000 → 22,350.
    const p = pkg({ socialSecurityIncome: 30000, employedIncome: 40000, four01KContribution: 10000 });
    near(p.irsTaxableGrossIncome(table).amount, 40000 + 13850, 'gross ordinary');
});

await test('the thresholds follow the filing status of the TABLE', () => {
    const married = new TaxTable('MFJ', 10000);
    const p = pkg({ socialSecurityIncome: 30000, pensionIncome: 25000 });
    near(p.irsTaxableGrossIncome(table).amount, 25000 + 9600, 'single');
    near(p.irsTaxableGrossIncome(married).amount, 25000 + 4000, 'married');
});

await test('the thresholds are never indexed for inflation', () => {
    const t = new TaxTable('Single', 10000);
    for (let y = 0; y < 30; y++) t.inflateTaxes(0.03);
    assert.deepEqual({ ...t.activeSocialSecurityThresholds }, SINGLE);
});

await test('no table, no answer — the old silent default is gone', () => {
    assert.throws(() => pkg({ socialSecurityIncome: 30000 }).irsTaxableGrossIncome(), /TaxTable/);
});

// ── the engine, end to end ────────────────────────────────────────────

console.log('\n── The measured households, through the engine ──\n');

const START = { year: 2026, month: 1 }, DEC = { year: 2026, month: 12 };
const A = (x) => ({ startDateInt: START, finishDateInt: DEC, annualReturnRate: { rate: 0 }, ...x });

async function yearOfRetirement(ssMonthly, pensionMonthly) {
    G.global_reset();
    G.global_setUserStartAge(70);
    G.global_setUserRetirementAge(65);
    G.global_setFilingAs('Single');
    G.setActiveTaxTable(G.makeActiveTaxTable());
    const assets = [
        A({ instrument: 'bank', displayName: 'Checking', startCurrency: { amount: 300000 }, startBasisCurrency: { amount: 300000 } }),
        A({ instrument: 'retirementIncome', displayName: 'Social Security', startCurrency: { amount: ssMonthly }, startBasisCurrency: { amount: 0 } }),
    ];
    if (pensionMonthly) {
        assets.push(A({ instrument: 'pension', displayName: 'Pension', startCurrency: { amount: pensionMonthly }, startBasisCurrency: { amount: 0 } }));
    }
    const p = new Portfolio(assets.map(ModelAsset.fromJSON), false, G.simConfigFromGlobals());
    await chronometer_run(p);
    // The liability the annual true-up enforces, on the 2026 table.
    const fresh = new TaxTable('Single', p.config.taxTable.configuredPropertyTaxDeductionMax);
    const b = taxableBasis(p.total, p.activeUser, { taxTable: fresh });
    return fresh.calculateYearlyIncomeTax(b.ordinaryTaxable).amount;
}

await test('Social Security alone, $3,500/month: no income tax (was $2,104)', async () => {
    near(await yearOfRetirement(3500, 0), 0, 'income tax');
});

await test('Social Security $2,500 + pension $2,500: $3,082 (was $4,480)', async () => {
    // provisional 30,000 + 15,000 = 45,000 → 13,850 taxable;
    // 30,000 + 13,850 − 16,100 = 27,750 → 1,240 + 12% × 15,350
    near(await yearOfRetirement(2500, 2500), 3082, 'income tax');
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);
process.exit(failed > 0 ? 1 : 0);
