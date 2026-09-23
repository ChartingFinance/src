/**
 * age-65-deductions.mjs
 *
 * The two deductions that depend on being 65 or older, neither of which existed
 * before 2026-09-23 — the standard deduction was one flat number for every age:
 *
 *   IRC §63(f)       the additional standard deduction. $2,050 single, $1,650
 *                    per spouse (2026), indexed. Part of the STANDARD deduction,
 *                    so a household that itemises does not get it.
 *
 *   OBBBA senior     $6,000 per person aged 65+, tax years 2025-2028 only, each
 *   deduction        person's $6,000 cut by 6% of MAGI over $75,000 / $150,000.
 *                    Not indexed. Taken whether the household itemises or not.
 *
 * ── What makes these non-vacuous ─────────────────────────────────────
 *
 *   BOTH BOUNDARIES  age 64 gets nothing and 65 gets both; 2028 gets the senior
 *                    deduction and 2029 does not.
 *
 *   THE DIFFERENCES  the two deductions differ on itemising, indexing and
 *                    phase-out. Each difference has a case that fails if the two
 *                    are treated alike.
 *
 *   THE COUPLE       a married household gets each amount twice, and its pair
 *                    of senior deductions phases out at $250,000 — per-person
 *                    phase-out, not one 6% cut against $12,000.
 *
 *   THE GAINS        an unabsorbed age deduction reaches long-term gains, the
 *                    same §1(h) order the standard deduction follows.
 *
 * Run: node tests/age-65-deductions.mjs   (from src/)
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
const { taxableBasis } = await import('../js/tax-basis.js');
const { User } = await import('../js/user.js');
const { Currency } = await import('../js/utils/currency.js');

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); failed++; }
}

const near = (got, want, what) =>
    assert.ok(Math.abs(got - want) < 0.005, `${what}: got ${got}, want ${want}`);

function pkg(fields) {
    const p = new FinancialPackage();
    for (const [k, v] of Object.entries(fields)) p[k].amount = v;
    return p;
}

/** A user of `age` in calendar `year` — birthYear + age is the tax year. */
const personIn = (age, year) => new User(age, year - age);

const single = () => new TaxTable('Single', 10000);
const married = () => new TaxTable('MFJ', 10000);
const magi = (n) => new Currency(n);

// ── who qualifies, and when ──────────────────────────────────────────

console.log('\n── Who qualifies, and in which years ──\n');

await test('64 gets neither; 65 gets both', () => {
    const t = single();
    assert.deepEqual({ ...t.ageDeductions(personIn(64, 2026), magi(40000)) },
        { additionalStandard: 0, senior: 0 });
    const at65 = t.ageDeductions(personIn(65, 2026), magi(40000));
    near(at65.additionalStandard, 2050, '§63(f)');
    near(at65.senior, 6000, 'senior');
});

await test('the senior deduction runs 2025 through 2028 — and not 2029', () => {
    const t = single();
    near(t.ageDeductions(personIn(70, 2025), magi(40000)).senior, 6000, '2025');
    near(t.ageDeductions(personIn(70, 2028), magi(40000)).senior, 6000, '2028');
    near(t.ageDeductions(personIn(70, 2029), magi(40000)).senior, 0, '2029');
    // §63(f) is permanent.
    near(t.ageDeductions(personIn(70, 2029), magi(40000)).additionalStandard, 2050, '§63(f) in 2029');
});

await test('no user, no age deduction', () => {
    assert.deepEqual({ ...single().ageDeductions(null, magi(40000)) }, { additionalStandard: 0, senior: 0 });
});

// ── the phase-out ────────────────────────────────────────────────────

console.log('\n── The senior phase-out ──\n');

await test('single: 6% of MAGI over $75,000, gone at $175,000, never negative', () => {
    const t = single();
    near(t.ageDeductions(personIn(70, 2026), magi(75000)).senior, 6000, 'at threshold');
    near(t.ageDeductions(personIn(70, 2026), magi(100000)).senior, 4500, '25k over');
    near(t.ageDeductions(personIn(70, 2026), magi(175000)).senior, 0, '100k over');
    near(t.ageDeductions(personIn(70, 2026), magi(400000)).senior, 0, 'far over');
});

await test('married: twice each amount, and the PAIR is gone at $250,000', () => {
    const t = married();
    const low = t.ageDeductions(personIn(70, 2026), magi(100000));
    near(low.additionalStandard, 3300, '§63(f) × 2');
    near(low.senior, 12000, 'senior × 2');
    // Per-person phase-out: each $6,000 loses 6% of the $50,000 excess.
    // One 6% cut against the combined $12,000 would leave $9,000 here instead.
    near(t.ageDeductions(personIn(70, 2026), magi(200000)).senior, 6000, '50k over');
    near(t.ageDeductions(personIn(70, 2026), magi(250000)).senior, 0, '100k over');
});

// ── how each one enters taxable income ───────────────────────────────

console.log('\n── Itemising, indexing, and the gains ──\n');

await test('a non-itemiser gets both off ordinary income', () => {
    // 60,000 of pension, MAGI 60,000 → 60,000 − (16,100 + 2,050) − 6,000
    const b = taxableBasis(pkg({ pensionIncome: 60000 }), personIn(70, 2026), { taxTable: single() });
    near(b.ordinaryTaxable.amount, 60000 - 16100 - 2050 - 6000, 'ordinary taxable');
});

await test('an itemiser loses §63(f) but keeps the senior deduction', () => {
    // 30,000 of mortgage interest beats 16,100 + 2,050, so §63(f) buys nothing;
    // the senior deduction still comes off on top.
    const b = taxableBasis(pkg({ pensionIncome: 60000, mortgageInterest: -30000 }),
        personIn(70, 2026), { taxTable: single() });
    near(b.ordinaryTaxable.amount, 60000 - 30000 - 6000, 'ordinary taxable');
});

await test('§63(f) is indexed with the standard deduction; the senior deduction is not', () => {
    const t = single();
    t.inflateTaxes(0.03);
    const d = t.ageDeductions(personIn(70, 2026), magi(40000));
    near(d.additionalStandard, 2050 * 1.03, '§63(f) after a year');
    near(d.senior, 6000, 'senior after a year');
    assert.equal(t.activeSeniorDeduction.threshold, 75000, 'phase-out threshold moved');
});

await test('what ordinary income cannot absorb reaches long-term gains', () => {
    // $0 ordinary income, $80,000 of long-term gain; MAGI 80,000 → senior
    // 6,000 − 6% × 5,000 = 5,700. Deduction 16,100 + 2,050 + 5,700 = 23,850,
    // all of it overflowing onto the gain.
    const b = taxableBasis(pkg({ longTermCapitalGains: 80000 }), personIn(70, 2026), { taxTable: single() });
    near(b.ordinaryTaxable.amount, 0, 'ordinary');
    near(b.capitalGains.amount, 80000 - 23850, 'gains after the overflow');
});

await test('under 65 the basis is exactly what it always was', () => {
    // Bit-identity for everyone the change does not concern — asserted, not
    // assumed. `+ 0` and `− 0` must not move a single bit.
    const p = pkg({ employedIncome: 123456.78, longTermCapitalGains: 9876.54, four01KContribution: 7000 });
    const t = single();
    const user = personIn(64, 2026);
    const young = taxableBasis(p, user, { taxTable: t });
    // The pre-change path: the same methods with no age argument at all.
    const y = p.copy();
    y.limitDeductions(user, t);
    assert.equal(young.ordinaryTaxable.amount, t.calculateYearlyTaxableIncome(y).amount, 'ordinary');
    assert.equal(t.totalYearlyDeduction(y).amount,
        t.totalYearlyDeduction(y, t.ageDeductions(user, new Currency(0))).amount, 'deduction');
});

// ── the engine, end to end ────────────────────────────────────────────

console.log('\n── Through the engine ──\n');

await test('Social Security $2,500 + pension $2,500 at 70: $2,116 (was $3,082 at 64)', async () => {
    // Gross ordinary 30,000 + 13,850 (§86) = 43,850 = MAGI → full senior 6,000.
    // 43,850 − 16,100 − 2,050 − 6,000 = 19,700 → 1,240 + 12% × 7,300.
    G.global_reset();
    G.global_setUserStartAge(70);
    G.global_setUserRetirementAge(65);
    G.global_setFilingAs('Single');
    G.setActiveTaxTable(G.makeActiveTaxTable());
    const A = (x) => ({ startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 12 },
        annualReturnRate: { rate: 0 }, ...x });
    const p = new Portfolio([
        A({ instrument: 'bank', displayName: 'Checking', startCurrency: { amount: 300000 }, startBasisCurrency: { amount: 300000 } }),
        A({ instrument: 'retirementIncome', displayName: 'Social Security', startCurrency: { amount: 2500 }, startBasisCurrency: { amount: 0 } }),
        A({ instrument: 'pension', displayName: 'Pension', startCurrency: { amount: 2500 }, startBasisCurrency: { amount: 0 } }),
    ].map(ModelAsset.fromJSON), false, G.simConfigFromGlobals());
    await chronometer_run(p);
    const fresh = new TaxTable('Single', p.config.taxTable.configuredPropertyTaxDeductionMax);
    // The age DURING 2026 — p.activeUser has been advanced by the final New Year.
    const b = taxableBasis(p.total, { age: p.config.startAge, birthYear: p.config.birthYear }, { taxTable: fresh });
    near(fresh.calculateYearlyIncomeTax(b.ordinaryTaxable).amount, 2116, 'income tax');
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);
process.exit(failed > 0 ? 1 : 0);
