/**
 * build-plan.mjs
 *
 * Spec 10 steps 1 and 2: the compiler in front of the runtime.
 *
 * ── What this guards ─────────────────────────────────────────────────
 *
 * `build_plan` exists because the engine's failure mode is *numbers, never
 * errors*. A test suite for it therefore has to check two different things:
 * that a good description compiles to a plan that FUNDS ITSELF, and that a bad
 * one is REFUSED rather than quietly resolved into a number.
 *
 * The second half is the reason this file has as many refusal cases as
 * construction cases. A gate that never says no is not a gate.
 *
 * ── The pin ──────────────────────────────────────────────────────────
 *
 * §5.3's residual expense has to be sized from NET income, because fund
 * transfers take their percentage after withholding. Sizing it from gross made
 * every plan short by exactly the tax, every month, for ever — 125 unfunded
 * months on the scenario's own example.
 *
 * So `build_plan` computes withholding at build time. It calls the engine's own
 * `calculateFICATax` and `calculateYearlyIncomeTax` and invents no rate, but
 * the ORDER it applies them in is a second implementation of a sequence
 * `payroll-engine.js` owns. `withholding estimate matches what the run books`
 * below is the mitigation: it compares the estimate against the withholding a
 * real run actually records, to the cent. If the payroll pass changes and
 * build-plan.js does not, that assertion fails. It is the most important
 * assertion in this file.
 *
 * Usage:  node tests/build-plan.mjs   (from src/)
 */

import assert from 'node:assert/strict';
import { buildPlan, planDefaults, PlanRefusal, Provenance, AssetOrigin }
    from '../js/mcp/build-plan.js';
import { runPlan } from '../js/mcp/run-plan.js';
import { SIM_CONFIG_DEFAULTS } from '../js/sim-config.js';
import { Instrument } from '../js/instruments/instrument.js';

let passed = 0, failed = 0;
async function check(label, fn) {
    try { await fn(); passed++; console.log(`  ok   ${label}`); }
    catch (err) { failed++; console.log(`  FAIL ${label}\n       ${err.message}`); }
}

/** The scenario's turn one, verbatim from §1. */
const TURN_ONE = {
    horizonYears: 10,
    income: [{ label: 'Salary', annual: 100000 }],
    accounts: [{ label: 'Savings', startingBalance: 0 }],
    savingsSplit: [{ from: 'Salary', to: 'Savings', percent: 10 }],
};

/** Turn two: "what about 5% to a brokerage and 5% to savings?" */
const TURN_TWO = {
    horizonYears: 10,
    income: [{ label: 'Salary', annual: 100000 }],
    accounts: [{ label: 'Savings', startingBalance: 0 },
               { label: 'Brokerage', startingBalance: 0 }],
    savingsSplit: [{ from: 'Salary', to: 'Brokerage', percent: 5 },
                   { from: 'Salary', to: 'Savings', percent: 5 }],
};

const refusalFrom = (intent) => {
    try { buildPlan(intent); return null; }
    catch (err) { if (err instanceof PlanRefusal) return err; throw err; }
};

console.log('\n── Step 1: the settings preamble (§7) ──\n');

await check('plan_defaults names every default a plan silently inherits', () => {
    const d = planDefaults();
    const byField = Object.fromEntries(d.map(x => [x.field, x]));
    for (const f of ['startAge', 'retirementAge', 'finishAge', 'inflationRate', 'filingAs']) {
        assert.ok(byField[f], `${f} missing from the preamble`);
        assert.ok(byField[f].gloss, `${f} has no gloss — the point is that it is answerable`);
    }
    // The value that makes this tool worth having: "how much in 10 years"
    // silently plans for a fifty-year-old.
    assert.equal(byField.startAge.value, SIM_CONFIG_DEFAULTS.startAge);
    assert.equal(byField.startAge.value, 50);
});

await check('the preamble tracks SIM_CONFIG_DEFAULTS rather than restating it', () => {
    for (const { field, value } of planDefaults()) {
        assert.equal(value, SIM_CONFIG_DEFAULTS[field],
            `${field} in the preamble disagrees with the engine's own default`);
    }
});

console.log('\n── Step 2: the scenario compiles (§4, §5) ──\n');

await check('§5.1 the horizon derives a finish age, and says so', () => {
    const { spec, ledger } = buildPlan(TURN_ONE);
    // 10 years from the default start age of 50 is 60 — NOT the default 87,
    // which would silently simulate 37 years.
    assert.equal(spec.settings.finishAge, 60);
    const entry = ledger.fields.find(f => f.field === 'finishAge');
    assert.equal(entry.provenance, Provenance.DERIVED);
    assert.match(entry.note, /10 years/);
});

await check('§5.2 a horizon short of retirement emits ONE life event', () => {
    const { spec } = buildPlan(TURN_ONE);
    assert.equal(spec.lifeEvents.length, 1);
    assert.equal(spec.lifeEvents[0].type, 'accumulate');
    // Not a default, not 45: a phase triggering after the plan starts
    // transfers nothing while producing a complete, plausible report.
    assert.equal(spec.lifeEvents[0].triggerAge, spec.settings.startAge);
});

await check('§5.2 a horizon that reaches retirement emits TWO', () => {
    const { spec } = buildPlan({ ...TURN_ONE, horizonYears: 30 });
    assert.equal(spec.settings.finishAge, 80);
    assert.deepEqual(spec.lifeEvents.map(e => e.type), ['accumulate', 'retire']);
});

await check('§5.3 every dollar of income is routed — splits total exactly 100', () => {
    for (const intent of [TURN_ONE, TURN_TWO]) {
        const { spec } = buildPlan(intent);
        const salary = spec.lifeEvents[0].phaseTransfers['Salary'];
        const total = salary.reduce((n, t) => n + t.monthlyMoveValue, 0);
        assert.equal(total, 100, `Salary routes ${total}%`);
    }
});

await check('§5.3 the residual becomes a declared structural expense', () => {
    const { spec, ledger, notes } = buildPlan(TURN_ONE);
    const le = spec.modelAssets.find(a => a.displayName === 'Living Expenses');
    assert.ok(le, 'no residual expense was created');
    assert.equal(le.instrument, Instrument.MONTHLY_EXPENSE);
    assert.ok(le.startCurrency.amount < 0, 'an expense must be negative');

    const entry = ledger.assets.find(a => a.label === 'Living Expenses');
    assert.equal(entry.origin, AssetOrigin.STRUCTURAL);
    // §9.2: structural additions say what they are. Not a footnote.
    assert.ok(notes.some(n => /Living Expenses/.test(n) && /never mentioned spending/.test(n)),
        'the structural addition never reached the reply');
});

await check('§5.4 a multi-way split warns that shares are of the source', async () => {
    const { notes } = buildPlan(TURN_TWO);
    assert.ok(notes.some(n => /not of each other/.test(n)),
        'a user who thinks 5+5 doubled their saving rate was not corrected');
    // And the one-leg case must NOT emit it — a warning that always fires is
    // a warning nobody reads.
    assert.ok(!buildPlan(TURN_ONE).notes.some(n => /not of each other/.test(n)));
});

await check('§8 account types are inferred from wording', () => {
    const kinds = (labels) => buildPlan({
        ...TURN_ONE,
        accounts: labels.map(label => ({ label, startingBalance: 0 })),
        savingsSplit: [{ from: 'Salary', to: labels[0], percent: 10 }],
    }).spec.modelAssets.filter(a => labels.includes(a.displayName))
      .map(a => [a.displayName, a.instrument]);

    assert.deepEqual(kinds(['Brokerage']), [['Brokerage', Instrument.TAXABLE_EQUITY]]);
    assert.deepEqual(kinds(['Savings']), [['Savings', Instrument.BANK]]);
    assert.deepEqual(kinds(['My 401k']), [['My 401k', Instrument.FOUR_01K]]);
    // Longest match wins, or "Roth IRA" resolves through "ira" to the wrong
    // tax treatment — and the report would look perfectly fine.
    assert.deepEqual(kinds(['Roth IRA']), [['Roth IRA', Instrument.ROTH_IRA]]);
});

console.log('\n── The gate refuses (§2, §8) ──\n');

await check('§8 an unresolvable account is a question, with categories offered', () => {
    const r = refusalFrom({
        ...TURN_ONE,
        accounts: [{ label: 'The Vault', startingBalance: 0 }],
        savingsSplit: [{ from: 'Salary', to: 'The Vault', percent: 10 }],
    });
    assert.ok(r, 'build_plan picked an account type instead of asking');
    assert.match(r.question, /retirement|capital/i);
    assert.ok(r.options?.retirement?.length, 'the refusal offered no options to choose from');
});

await check('§5.3 a split over 100% is refused, not scaled down', () => {
    // stochasticLimit scales silently when the total exceeds 100. That is the
    // behaviour this refusal exists to get in front of.
    const r = refusalFrom({
        ...TURN_ONE,
        savingsSplit: [{ from: 'Salary', to: 'Savings', percent: 140 }],
    });
    assert.ok(r);
    assert.match(r.reason, /more than all of it/);
});

await check('§5.1 a horizon AND a finish age is a contradiction, not a precedence rule', () => {
    const r = refusalFrom({ ...TURN_ONE, settingsOverrides: { finishAge: 90 } });
    assert.ok(r, 'one of the two was silently preferred');
    assert.match(r.question, /10 years|90/);
});

await check('a plan with no income is refused', () => {
    const r = refusalFrom({ horizonYears: 10, income: [] });
    assert.ok(r);
    assert.match(r.question, /income/i);
});

await check('an income with no amount is refused rather than defaulted to zero', () => {
    const r = refusalFrom({ ...TURN_ONE, income: [{ label: 'Salary' }] });
    assert.ok(r);
    assert.match(r.question, /How much/i);
});

await check('a split from an income that does not exist is refused', () => {
    const r = refusalFrom({
        ...TURN_ONE,
        savingsSplit: [{ from: 'Bonus', to: 'Savings', percent: 10 }],
    });
    assert.ok(r);
    assert.match(r.reason, /Bonus/);
});

console.log('\n── The ledger (§6, §9.2) ──\n');

await check('§6 every settings field carries a provenance', () => {
    const { spec, ledger } = buildPlan(TURN_ONE);
    const declared = new Set(ledger.fields.map(f => f.field));
    for (const field of Object.keys(spec.settings)) {
        assert.ok(declared.has(field), `${field} reached the spec undeclared`);
    }
    for (const f of ledger.fields) {
        assert.ok(Object.values(Provenance).includes(f.provenance),
            `${f.field} has provenance "${f.provenance}", which is not one of the four`);
    }
});

await check('§9.2 every asset carries an origin', () => {
    const { spec, ledger } = buildPlan(TURN_ONE);
    const withOrigin = new Set(ledger.assets.map(a => a.label));
    for (const a of spec.modelAssets) {
        assert.ok(withOrigin.has(a.displayName),
            `${a.displayName} is indistinguishable from one the user supplied`);
    }
});

await check('§6 a default is labelled a default, and a statement is not', () => {
    const bare = buildPlan(TURN_ONE).ledger.fields;
    assert.equal(bare.find(f => f.field === 'startAge').provenance, Provenance.DEFAULT);

    const stated = buildPlan({ ...TURN_ONE, settingsOverrides: { startAge: 35 } })
        .ledger.fields;
    assert.equal(stated.find(f => f.field === 'startAge').provenance, Provenance.STATED);
    // and the derivation follows the stated value, not the default
    assert.equal(stated.find(f => f.field === 'finishAge').value, 45);
});

console.log('\n── It runs, and it funds itself ──\n');

await check('§1 the scenario\'s turn one runs with no unfunded obligation', async () => {
    const { spec } = buildPlan(TURN_ONE);
    const { portfolio, issues } = await runPlan(spec);
    assert.equal(issues.length, 0,
        `plan reported ${issues.length} issue(s): `
        + issues.map(i => (i.detail ?? '').slice(0, 80)).join(' | '));
    assert.ok(portfolio.finishValue().amount > 0, 'ten years of saving ended at zero');
    assert.equal(String(portfolio.lastDateInt).slice(5), '12',
        'the plan should end in December of its finish year');
});

await check('turn two also runs clean, and the horizon is unchanged', async () => {
    const { spec } = buildPlan(TURN_TWO);
    const { portfolio, issues } = await runPlan(spec);
    assert.equal(issues.length, 0);
    assert.equal(spec.settings.finishAge, 60);
    assert.ok(portfolio.finishValue().amount > 0);
});

await check('a plan crossing retirement funds its expenses from an account', async () => {
    const { spec } = buildPlan({ ...TURN_ONE, horizonYears: 30 });
    const retire = spec.lifeEvents.find(e => e.type === 'retire');
    assert.ok(retire.phaseTransfers['Living Expenses'],
        'work income stops and nothing was told to pay the bills');
    const { issues } = await runPlan(spec);
    // Expenses may outlive the money; what must not happen is an obligation
    // with no payer at all, which is what an empty retire phase produces.
    assert.ok(issues.length <= 2, `unexpected issues: ${issues.length}`);
});

await check('every expense names its payer rather than leaving it to the backstop', () => {
    // Found by mutation. Deleting the expense's outbound transfer broke NOTHING
    // at first: the funding backstop picks an eligible account on its own and
    // the plan still funds itself, so every run-level assertion stayed green.
    //
    // That is the bug. The account paying for a plan's spending is then a
    // resolver's choice nobody recorded — indistinguishable, in the spec, from
    // a decision the user made. A compiler's output has to say who pays.
    for (const intent of [TURN_ONE, TURN_TWO]) {
        const { spec } = buildPlan(intent);
        const accum = spec.lifeEvents.find(e => e.type === 'accumulate');
        const expenses = spec.modelAssets
            .filter(a => a.instrument === Instrument.MONTHLY_EXPENSE)
            .map(a => a.displayName);
        assert.ok(expenses.length, 'no expense to check');
        for (const label of expenses) {
            const legs = accum.phaseTransfers[label];
            assert.ok(legs?.length, `${label} has no payer in the accumulate phase`);
            const total = legs.reduce((n, t) => n + t.monthlyMoveValue, 0);
            assert.equal(total, 100, `${label} is only ${total}% funded`);
            const accounts = new Set(spec.modelAssets.map(a => a.displayName));
            for (const leg of legs) {
                assert.ok(accounts.has(leg.toDisplayName),
                    `${label} is paid by "${leg.toDisplayName}", which is not in the plan`);
            }
        }
    }
});

await check('the working income never outlives the plan itself', () => {
    // A ten-year plan from 50 finishes at 60 while retirement is 67. An
    // unclamped salary pushes the run out to 2043 on a plan asked to end in
    // 2036 — a different plan, reported as the requested one.
    const { spec } = buildPlan(TURN_ONE);
    const salary = spec.modelAssets.find(a => a.displayName === 'Salary');
    const finishYear = salary.finishDateInt.year;
    const birthYear = new Date().getFullYear() - spec.settings.startAge;
    assert.ok(finishYear <= birthYear + spec.settings.finishAge,
        `salary runs to ${finishYear}, past the plan's own end`);
});

console.log('\n── The pin: build-time withholding vs. what the run books ──\n');

await check('withholding estimate matches what the run books, to the cent', async () => {
    const { spec } = buildPlan(TURN_ONE);
    const { portfolio } = await runPlan(spec);

    const salary = portfolio.modelAssets.find(a => a.displayName === 'Salary');
    const le = spec.modelAssets.find(a => a.displayName === 'Living Expenses');

    // The FIRST full month, before raises and inflation move anything.
    const month = String(portfolio.firstDateInt);
    const sum = (type) => (salary.events ?? [])
        .filter(e => e.type === type && String(e.dateInt) === month)
        .reduce((n, e) => n + e.amount.amount, 0);

    const gross = salary.startCurrency.amount;
    const actualNet = gross + sum('ficaWithholding') + sum('incomeTaxWithholding');

    // build_plan sized the residual expense at residual% of ITS estimate of
    // net, so the estimate is recoverable from the emitted spec.
    const residualShare = spec.lifeEvents[0].phaseTransfers['Salary']
        .reduce((n, t) => n + t.monthlyMoveValue, 0) === 100 ? 0.90 : null;
    assert.ok(residualShare, 'could not recover the residual share');
    const estimatedNet = Math.abs(le.startCurrency.amount) / residualShare;

    assert.ok(Math.abs(estimatedNet - actualNet) < 0.01,
        `build_plan estimated net income of ${estimatedNet.toFixed(2)} but the `
        + `engine withheld its way to ${actualNet.toFixed(2)}. The build-time `
        + `withholding in build-plan.js has drifted from payroll-engine.js.`);
});

await check('the emitted spec is anchored — it does not move with the clock', async () => {
    // Ties step 2 to step 0. A compiler whose output means something different
    // next January is a compiler with a nondeterministic target.
    const { spec } = buildPlan(TURN_ONE);
    const frozen = JSON.parse(JSON.stringify(spec));
    const a = await runPlan(frozen);

    const RealDate = Date;
    globalThis.Date = class extends RealDate {
        constructor(...args) {
            return args.length ? new RealDate(...args) : new RealDate('2031-04-09T00:00:00Z');
        }
        static now() { return new RealDate('2031-04-09T00:00:00Z').getTime(); }
    };
    try {
        const b = await runPlan(frozen);
        assert.equal(String(b.portfolio.lastDateInt), String(a.portfolio.lastDateInt));
        assert.equal(Math.round(b.portfolio.finishValue().amount),
                     Math.round(a.portfolio.finishValue().amount));
    } finally {
        globalThis.Date = RealDate;
    }
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);
process.exit(failed ? 1 : 0);
