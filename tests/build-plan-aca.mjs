/**
 * build-plan-aca.mjs
 *
 * `build_plan` and the marketplace health plan.
 *
 * ── What this guards ─────────────────────────────────────────────────
 *
 * The same two things tests/build-plan.mjs does, for one more kind of asset: a
 * described health plan compiles to a card the engine works the premium tax
 * credit out on, and a description the gate cannot honour is refused rather
 * than quietly turned into a number.
 *
 * The credit is checked where the household's figures live, in the run's
 * TaxYear records, not on the card: a card that compiles but never earns a
 * credit is a plan that reports the full premium and looks perfectly fine.
 *
 * ── The pin ──────────────────────────────────────────────────────────
 *
 * A user quotes today's premium. Coverage that starts at retirement is priced
 * at its start by build_plan, and stepped each January after that by the
 * engine. Those are two halves of one price path written in two places, so
 * `the price build_plan carried forward is the price the run charges` compares
 * them to the cent. A step skipped or taken twice moves every year's premium
 * and every year's credit, and nothing else would notice.
 *
 * ── The clock ────────────────────────────────────────────────────────
 *
 * build_plan reads the clock once, to anchor the plan. Every build here runs
 * under a pinned date, so the plan starts in October 2026, a part first year on
 * the published 2026 tables, on every day this suite runs.
 *
 * Usage:  node tests/build-plan-aca.mjs   (from src/)
 */

import assert from 'node:assert/strict';
import { buildPlan, healthInsuranceDefaults, PlanRefusal, AssetOrigin }
    from '../js/mcp/build-plan.js';
import { runPlan, cacheRun } from '../js/mcp/run-plan.js';
import { planFromReference } from '../js/mcp/plan-reference.js';
import { shareUrlFromPlan } from '../js/share-link.js';
import { Instrument } from '../js/instruments/instrument.js';
import { MEDICARE_AGE } from '../js/plan-dates.js';
import { ptcTableFor, fplPercent } from '../js/premium-tax-credit.js';

let passed = 0, failed = 0;
async function check(label, fn) {
    try { await fn(); passed++; console.log(`  ok   ${label}`); }
    catch (err) { failed++; console.log(`  FAIL ${label}\n       ${err.message}`); }
}

// ── The pinned clock ─────────────────────────────────────────────────

const CLOCK = '2026-10-15T12:00:00Z';

/** buildPlan as of CLOCK. The run reads no clock (plan anchoring), so only this does. */
function build(intent) {
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
        constructor(...args) { return args.length ? new RealDate(...args) : new RealDate(CLOCK); }
        static now() { return new RealDate(CLOCK).getTime(); }
    };
    try { return buildPlan(intent); } finally { globalThis.Date = RealDate; }
}

const refusalFrom = (intent) => {
    try { build(intent); return null; }
    catch (err) { if (err instanceof PlanRefusal) return err; throw err; }
};

// ── The households ───────────────────────────────────────────────────

/** "I'm 55. I retire at 60 and go on the marketplace until Medicare." */
const EARLY_RETIREE = {
    settingsOverrides: { startAge: 55, retirementAge: 60, finishAge: 70 },
    income: [{ label: 'Salary', annual: 120000 }],
    accounts: [{ label: 'Savings', startingBalance: 20000 },
               { label: 'Brokerage', startingBalance: 800000 }],
    savingsSplit: [{ from: 'Salary', to: 'Brokerage', percent: 15 }],
    healthInsurance: [{ label: 'Marketplace Plan', premium: { monthly: 1100 },
        benchmark: { monthly: 1000 }, estimatedIncome: 45000, fromAge: 60 }],
};

/** "I'm 60, retired on a pension, and on the marketplace now." */
const RETIRED_NOW = {
    settingsOverrides: { startAge: 60, retirementAge: 60, finishAge: 70 },
    income: [{ label: 'Pension', annual: 30000, kind: 'pension' }],
    accounts: [{ label: 'Checking', startingBalance: 30000 },
               { label: 'Brokerage', startingBalance: 900000 }],
    healthInsurance: [{ label: 'Marketplace Plan', premium: { monthly: 1000 },
        benchmark: { monthly: 950 }, estimatedIncome: 40000 }],
};

/** The refusal's reason, or a failure naming what was built instead. */
const reasonFor = (intent) => {
    const r = refusalFrom(intent);
    assert.ok(r, 'built a plan this should have refused');
    return r.reason;
};

/** One card, with fields replaced or (as undefined) removed. */
const withCard = (base, fields) => ({
    ...base,
    healthInsurance: [Object.fromEntries(Object.entries({ ...base.healthInsurance[0], ...fields })
        .filter(([, v]) => v !== undefined))],
});

const cardOf = (spec) => spec.modelAssets.find(a => a.instrument === Instrument.HEALTH_INSURANCE);
const covered = (portfolio) => portfolio.taxYears.filter(t => t.fplPercent != null);
const notesFor = (ledger, label) => ledger.assets.filter(a => a.label === label && a.note)
    .map(a => a.note);

/** A run's history index for a calendar month. */
const indexOf = (portfolio, year, month) =>
    (year - portfolio.firstDateInt.year) * 12 + (month - portfolio.firstDateInt.month);

console.log('\n── plan_defaults describes the card ──\n');

await check('plan_defaults names every default a marketplace plan inherits', () => {
    const byField = Object.fromEntries(healthInsuranceDefaults().map(d => [d.field, d]));
    for (const f of ['benchmark', 'growthRate', 'estimatedIncome', 'householdSize',
                     'advanceShare', 'premiumTaxCredit', 'fromAge', 'untilAge']) {
        assert.ok(byField[f], `${f} missing from the card's defaults`);
        assert.ok(byField[f].gloss, `${f} has no gloss`);
    }
    assert.equal(byField.untilAge.value, MEDICARE_AGE);
});

await check('the card defaults are what build_plan builds when a field is left out', async () => {
    const byField = Object.fromEntries(healthInsuranceDefaults().map(d => [d.field, d.value]));
    const { spec } = build(withCard(RETIRED_NOW, { benchmark: undefined, estimatedIncome: undefined }));
    const card = cardOf(spec);
    assert.equal(card.advanceCreditShare, byField.advanceShare);
    assert.equal(card.premiumTaxCreditEnabled, byField.premiumTaxCredit);
    assert.equal(card.householdSize, null, 'an unstated household size must defer to filing status');

    // The relative defaults are the engine's reading of an empty field, so
    // they are checked on a run.
    const { portfolio } = await runPlan(spec);
    const run = portfolio.modelAssets.find(a => a.instrument === Instrument.HEALTH_INSURANCE);
    assert.equal(run.effectiveAnnualReturnRate.rate, spec.settings.inflationRate,
        'an unstated growth rate is not plan inflation');
    assert.equal(run.benchmarkCurrency.amount, Math.abs(run.finishCurrency.amount),
        'an unstated benchmark is not the premium itself');
    // 60 in 2026 is 65 in 2031, so the last month before Medicare is December 2030.
    assert.equal(String(run.effectiveFinishDateInt), `${2026 - 60 + byField.untilAge - 1}-12`);
});

console.log('\n── It compiles ──\n');

await check('a plan from retirement compiles to a card that starts at retirement', () => {
    const { spec } = build(EARLY_RETIREE);
    const card = cardOf(spec);
    assert.ok(card, 'no health-insurance card in the spec');
    assert.equal(card.displayName, 'Marketplace Plan');
    // 55 in 2026 retires at 60 in 2031, from January, as marketplace years run.
    assert.deepEqual([card.startDateInt.year, card.startDateInt.month], [2031, 1]);
    assert.equal(card.finishDateInt, null, 'the end before Medicare is the engine\'s, not a copy');
    assert.ok(card.startCurrency.amount < 0, 'a premium is an expense, negative');
    assert.ok(card.benchmarkPremium.amount > 0);
    assert.ok(card.estimatedAcaIncome?.amount > 0);
    assert.equal(card.premiumTaxCreditEnabled, true);
});

await check('the card names its payer in every phase rather than leaving it to the backstop', () => {
    // The lesson of the expense version in build-plan.mjs: a payer left to the
    // backstop breaks no run-level assertion, and is a decision nobody recorded.
    const { spec } = build(EARLY_RETIREE);
    const names = new Set(spec.modelAssets.map(a => a.displayName));
    const payer = (type) => spec.lifeEvents.find(e => e.type === type).phaseTransfers['Marketplace Plan'];
    for (const type of ['accumulate', 'retire']) {
        const legs = payer(type);
        assert.ok(legs?.length, `the card has no payer in the ${type} phase`);
        assert.equal(legs.reduce((n, t) => n + t.monthlyMoveValue, 0), 100);
        for (const leg of legs) assert.ok(names.has(leg.toDisplayName), `${leg.toDisplayName} is not in the plan`);
    }
    // Coverage runs in retirement, so the account that pays the bills then pays it.
    assert.equal(payer('retire')[0].toDisplayName,
        spec.lifeEvents.find(e => e.type === 'retire').phaseTransfers['Living Expenses'][0].toDisplayName);
});

await check('today\'s prices are carried to the year coverage starts, and the ledger says so', () => {
    const { spec, ledger } = build(EARLY_RETIREE);
    const card = cardOf(spec);
    const growth = Math.pow(1 + spec.settings.inflationRate, 5);   // 2026 → 2031
    assert.ok(Math.abs(card.startCurrency.amount + 1100 * growth) < 0.01,
        `premium ${card.startCurrency.amount}, expected ${-1100 * growth}`);
    assert.ok(Math.abs(card.benchmarkPremium.amount - 1000 * growth) < 0.01);
    assert.ok(Math.abs(card.estimatedAcaIncome.amount - 45000 * growth) < 1);
    assert.ok(notesFor(ledger, 'Marketplace Plan').some(n => /today/.test(n) && /2031/.test(n)),
        'a derived price reached the spec without saying where it came from');
});

console.log('\n── It runs, and the credit reaches the tax years ──\n');

await check('the run\'s TaxYear records carry a premium tax credit for every covered year', async () => {
    const { spec } = build(EARLY_RETIREE);
    const { portfolio, issues } = await runPlan(spec);
    assert.equal(issues.length, 0, `issues: ${issues.map(i => i.id).join(', ')}`);

    const years = covered(portfolio);
    // From retirement in 2031 to the December before 65, which is 2035.
    assert.deepEqual(years.map(t => t.year), [2031, 2032, 2033, 2034, 2035]);
    const card = portfolio.modelAssets.find(a => a.instrument === Instrument.HEALTH_INSURANCE);
    for (const t of years) {
        assert.ok(t.ptc > 0, `${t.year} allowed no credit`);
        // Advanced every year: on the estimate in 2031, then on the year before.
        assert.ok(t.aptc > 0, `${t.year} advanced nothing`);
        const advanced = card.events
            .filter(e => e.type === 'premiumTaxCredit' && e.dateInt.year === t.year)
            .reduce((n, e) => n + e.amount.amount, 0);
        assert.ok(Math.abs(advanced - t.aptc) < 0.01,
            `${t.year}: the record says ${t.aptc} advanced, the card's events say ${advanced}`);
        // The return settles the difference, both ways (the engine's $1 gate).
        if (Math.abs(t.ptc - t.aptc) >= 1) {
            assert.ok(Math.abs(t.ptcReconciliation - (t.ptc - t.aptc)) < 0.01,
                `${t.year}: settled ${t.ptcReconciliation}, owed ${t.ptc - t.aptc}`);
        }
    }
    // Medicare: nothing is charged after December 2035.
    assert.equal(card.monthlyHealthPremiums[indexOf(portfolio, 2036, 1)], 0);
});

await check('the price build_plan carried forward is the price the run charges', async () => {
    for (const growthRate of [undefined, 0.07]) {
        const { spec } = build(withCard(EARLY_RETIREE, { growthRate }));
        const rate = growthRate ?? spec.settings.inflationRate;
        const { portfolio } = await runPlan(spec);
        const premiums = portfolio.modelAssets
            .find(a => a.instrument === Instrument.HEALTH_INSURANCE).monthlyHealthPremiums;
        const expected = -1100 * Math.pow(1 + rate, 5);
        const first = premiums[indexOf(portfolio, 2031, 1)];
        assert.ok(Math.abs(first - expected) < 0.01,
            `at ${rate}: the first month charged ${first}, today's premium grown to 2031 is ${expected}`);
        // And the engine takes it from there, once a January.
        assert.equal(premiums[indexOf(portfolio, 2031, 12)], first);
        const next = premiums[indexOf(portfolio, 2032, 1)];
        assert.ok(Math.abs(next - first * (1 + rate)) < 0.01, `at ${rate}: 2032 charged ${next}`);
    }
});

console.log('\n── The part first year ──\n');

await check('a plan that starts in retirement covers from its first month, and settles the part year on the estimate', async () => {
    const { spec } = build(RETIRED_NOW);
    assert.deepEqual([cardOf(spec).startDateInt.year, cardOf(spec).startDateInt.month], [2026, 10]);
    const { portfolio, issues } = await runPlan(spec);
    assert.equal(issues.length, 0, `issues: ${issues.map(i => i.id).join(', ')}`);

    const first = portfolio.taxYears.find(t => t.year === 2026);
    assert.equal(first.months, 3);
    assert.equal(first.ptcOnEstimate, true);
    assert.ok(first.ptc > 0);
    // A single household: 1 person, so the line is 2026's first-person figure.
    assert.equal(first.fplPercent, fplPercent(40000, ptcTableFor(2026), 1));
    assert.deepEqual(covered(portfolio).map(t => t.year), [2026, 2027, 2028, 2029, 2030]);
});

await check('with no estimate, the ledger says what the run then does, and the run does it', async () => {
    const { spec, ledger } = build(withCard(RETIRED_NOW, { estimatedIncome: undefined }));
    const note = notesFor(ledger, 'Marketplace Plan').find(n => /no income estimate/.test(n));
    assert.ok(note, 'an unstated estimate reached the spec undeclared');
    assert.match(note, /2026 in this plan earn no credit/);
    assert.match(note, /2027's credit comes back on the return/);

    const { portfolio } = await runPlan(spec);
    const year = (y) => portfolio.taxYears.find(t => t.year === y);
    assert.equal(year(2026).ptc, 0, '2026 earned a credit the note says it cannot');
    assert.equal(year(2027).aptc, 0, '2027 advanced a credit with nothing to advance it on');
    assert.ok(year(2027).ptcReconciliation > 0, '2027\'s credit never came back on the return');
    assert.ok(Math.abs(year(2027).ptcReconciliation - year(2027).ptc) < 0.01);
    assert.ok(year(2028).aptc > 0, '2028 should renew on 2027, a full year on the marketplace');
});

await check('a married household is two for the poverty line, as the ledger says', async () => {
    const intent = withCard({ ...RETIRED_NOW,
        settingsOverrides: { ...RETIRED_NOW.settingsOverrides, filingAs: 'MFJ' } }, {});
    const { spec, ledger } = build(intent);
    assert.ok(notesFor(ledger, 'Marketplace Plan').some(n => /household of 2/.test(n)));
    const { portfolio } = await runPlan(spec);
    assert.equal(portfolio.taxYears.find(t => t.year === 2026).fplPercent,
        fplPercent(40000, ptcTableFor(2026), 2));
});

console.log('\n── Every default is declared ──\n');

await check('every card field left out is declared a default in the ledger', () => {
    const { ledger } = build({ ...RETIRED_NOW, healthInsurance: [{ premium: { monthly: 1000 } }] });
    const notes = notesFor(ledger, 'Health Insurance');
    for (const [what, pattern] of [
        ['the start', /starts with the plan/],
        ['the end', /December 2030.*Medicare/],
        ['the growth', /plan inflation/],
        ['eligibility', /eligible for the premium tax credit/],
        ['the benchmark', /own premium/],
        ['the household', /household of 1/],
        ['the advance share', /whole estimated credit/],
        ['the estimate', /no income estimate/],
    ]) {
        assert.ok(notes.some(n => pattern.test(n) && /you did not/.test(n)),
            `${what} was defaulted without saying so: ${JSON.stringify(notes)}`);
    }
    assert.ok(ledger.assets.some(a => a.label === 'Health Insurance' && a.origin === AssetOrigin.STATED));
});

await check('a card with everything stated declares no defaults', () => {
    // A note that always fires is a note nobody reads.
    const { ledger } = build(withCard(RETIRED_NOW, { growthRate: 0.06, householdSize: 1,
        advanceShare: 0.8, premiumTaxCredit: true, fromAge: 60, untilAge: 65 }));
    const defaults = notesFor(ledger, 'Marketplace Plan').filter(n => /you did not/.test(n));
    assert.deepEqual(defaults, []);
});

console.log('\n── The gate refuses ──\n');

await check('a premium paid while working is refused, and the question offers retirement', () => {
    const unsaid = refusalFrom(withCard(EARLY_RETIREE, { fromAge: undefined }));
    assert.ok(unsaid, 'build_plan picked a start for coverage instead of asking');
    assert.deepEqual(unsaid.options, { fromAge: [60] });
    assert.match(unsaid.question, /while working/);

    const now = refusalFrom(withCard(EARLY_RETIREE, { fromAge: 55 }));
    assert.ok(now, 'a premium paid out of wages was built on top of the spending they fund');
    assert.match(now.reason, /before work income stops/);
});

await check('a card with no premium is a question about the full premium', () => {
    const r = refusalFrom(withCard(EARLY_RETIREE, { premium: undefined }));
    assert.ok(r);
    assert.match(r.question, /full premium, before any premium tax credit/);
    assert.match(reasonFor(withCard(EARLY_RETIREE, { premium: { monthly: 1100, annual: 13200 } })),
        /both a monthly and an annual/);
    assert.match(reasonFor(withCard(EARLY_RETIREE, { premium: { monthly: 0 } })), /premium of \$0/);
});

await check('Medicare ends marketplace coverage: nothing is built at or past 65', () => {
    assert.match(reasonFor(withCard(EARLY_RETIREE, { fromAge: MEDICARE_AGE })),
        /would start at 65.*Medicare/);
    assert.match(reasonFor(withCard(EARLY_RETIREE, { untilAge: MEDICARE_AGE + 1 })),
        /would run to 66.*Medicare/);
    // Work past 65 leaves no retired years before Medicare.
    assert.match(reasonFor({ ...EARLY_RETIREE,
        settingsOverrides: { startAge: 55, retirementAge: 67, finishAge: 80 } }),
        /work income until 67.*Medicare/);
    // Already 66: the plan is a Medicare premium, which is an ordinary expense.
    const r = refusalFrom({ ...RETIRED_NOW,
        settingsOverrides: { startAge: 66, retirementAge: 66, finishAge: 80 } });
    assert.ok(r);
    assert.match(r.question, /Medicare premium/);
});

await check('a plan that ends before retirement has no years for a card', () => {
    assert.match(reasonFor({ ...EARLY_RETIREE,
        settingsOverrides: { startAge: 50, retirementAge: 62 }, horizonYears: 10 }),
        /ends at 60, before work income stops.*no retired years/);
});

await check('coverage must stop after it starts, and start before the plan ends', () => {
    assert.match(reasonFor(withCard(EARLY_RETIREE, { untilAge: 60 })), /no later than it starts/);
    assert.match(reasonFor(withCard({ ...EARLY_RETIREE,
        settingsOverrides: { startAge: 55, retirementAge: 60, finishAge: 61 } }, { fromAge: 62 })),
        /after the plan ends at 61/);
});

await check('a stated 0% growth is refused, not read as plan inflation', () => {
    const r = refusalFrom(withCard(EARLY_RETIREE, { growthRate: 0 }));
    assert.ok(r, 'a flat premium became a 3.1% one without a word');
    assert.match(r.reason, /0% as plan inflation/);
});

await check('credit settings out of range are refused', () => {
    for (const [field, value, reason] of [
            ['advanceShare', 1.5, /advance share/], ['advanceShare', -0.1, /advance share/],
            ['householdSize', 0, /household of 0/], ['householdSize', 2.5, /household of 2.5/],
            ['estimatedIncome', -1, /estimate of -1/], ['benchmark', { monthly: 0 }, /benchmark/]]) {
        assert.match(reasonFor(withCard(EARLY_RETIREE, { [field]: value })), reason,
            `${field} ${JSON.stringify(value)}`);
    }
});

await check('credit settings on a plan bought without the credit are a contradiction', () => {
    const r = refusalFrom(withCard(EARLY_RETIREE, { premiumTaxCredit: false }));
    assert.ok(r, 'a benchmark and an estimate were dropped without a word');
    assert.match(r.reason, /benchmark, estimatedIncome/);
});

await check('two cards that disagree about the household are refused', () => {
    const second = { label: 'Second Plan', premium: { monthly: 400 }, fromAge: 60 };
    assert.match(reasonFor({ ...EARLY_RETIREE, healthInsurance: [
        ...EARLY_RETIREE.healthInsurance, { ...second, estimatedIncome: 60000 }] }),
        /different income estimates/);
    assert.match(reasonFor({ ...EARLY_RETIREE, healthInsurance: [
        { ...EARLY_RETIREE.healthInsurance[0], householdSize: 2 }, { ...second, householdSize: 3 }] }),
        /different household sizes/);
    // Agreeing is fine, and so is saying it once.
    assert.equal(refusalFrom({ ...EARLY_RETIREE, healthInsurance: [
        ...EARLY_RETIREE.healthInsurance, second] }), null);
});

await check('a card given as an account is refused, pointing at healthInsurance', () => {
    const r = refusalFrom({ ...EARLY_RETIREE, healthInsurance: undefined, accounts: [
        ...EARLY_RETIREE.accounts, { label: 'ACA', kind: Instrument.HEALTH_INSURANCE }] });
    assert.ok(r, 'a premium was built as an account balance');
    assert.match(r.reason, /health plan, not an account/);
    assert.match(r.question, /healthInsurance/);
});

await check('a card and an account cannot share a name, nor take the residual\'s', () => {
    assert.match(reasonFor(withCard(EARLY_RETIREE, { label: 'Savings' })), /called "Savings"/);
    // The residual adopts an asset already called Living Expenses, so a card
    // with that name would have the unsaved income added to its premium.
    assert.match(reasonFor(withCard(EARLY_RETIREE, { label: 'Living Expenses' })),
        /spending it sizes from income/);
});

console.log('\n── Off the marketplace, and a stated end ──\n');

await check('a plan bought off the marketplace pays its premium and earns no credit', async () => {
    const { spec } = build(withCard(EARLY_RETIREE, { premiumTaxCredit: false,
        benchmark: undefined, estimatedIncome: undefined }));
    const { portfolio } = await runPlan(spec);
    assert.deepEqual(covered(portfolio), []);
    const premiums = portfolio.modelAssets
        .find(a => a.instrument === Instrument.HEALTH_INSURANCE).monthlyHealthPremiums;
    assert.ok(premiums[indexOf(portfolio, 2031, 1)] < 0, 'the premium was never charged');
});

await check('untilAge ends coverage the December before that age', async () => {
    const { spec } = build(withCard(EARLY_RETIREE, { untilAge: 63 }));
    assert.deepEqual([cardOf(spec).finishDateInt.year, cardOf(spec).finishDateInt.month], [2033, 12]);
    const { portfolio } = await runPlan(spec);
    assert.deepEqual(covered(portfolio).map(t => t.year), [2031, 2032, 2033]);
});

console.log('\n── The return leg ──\n');

await check('a built card survives a share link: same content address', () => {
    // The handle hashes the spec, so a card field the link dropped or changed
    // would come back as a different plan.
    const { spec } = build(EARLY_RETIREE);
    const handleOf = (s) => cacheRun(s, { includeReconciliation: false }, null);
    assert.equal(handleOf(planFromReference(shareUrlFromPlan(spec).url)), handleOf(spec));
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);
process.exit(failed ? 1 : 0);
