/**
 * build-plan.mjs
 *
 * `build_plan`: the compiler in front of the runtime.
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
 * The residual expense has to be sized from net income, because fund
 * transfers take their percentage after withholding. Sized from gross, every
 * plan is short by exactly the tax, every month.
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

// build_plan reads the clock for the plan's first month, and a horizon in
// years is counted from it: built in January, the same intent ends a calendar
// year earlier. Unpinned, this suite would be a different test every month.
const WallClock = Date;
function pinClock(iso) {
    globalThis.Date = class extends WallClock {
        constructor(...args) { return args.length ? new WallClock(...args) : new WallClock(iso); }
        static now() { return new WallClock(iso).getTime(); }
    };
}
const SUITE_CLOCK = '2026-11-15T12:00:00';
pinClock(SUITE_CLOCK);

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

// ── What review 2026-11-11 found the gate letting through ────────────
//
// Each of these once compiled to a plan that ran and reported a number.

const refusedAt = (clock, intent) => {
    pinClock(clock);
    try { return refusalFrom(intent); } finally { pinClock(SUITE_CLOCK); }
};
const builtAt = (clock, intent) => {
    pinClock(clock);
    try { return buildPlan(intent); } finally { pinClock(SUITE_CLOCK); }
};
const monthsRun = (portfolio) =>
    (portfolio.lastDateInt.year - portfolio.firstDateInt.year) * 12
    + (portfolio.lastDateInt.month - portfolio.firstDateInt.month) + 1;

await check('a share of income sent to an expense is refused', () => {
    // It ran as 20% of take-home leaving the salary and arriving nowhere,
    // with Rent still paid in full from savings.
    const r = refusalFrom({ horizonYears: 5, income: [{ label: 'Salary', annual: 100000 }],
        accounts: [{ label: 'Savings', startingBalance: 20000 }],
        expenses: [{ label: 'Rent', monthly: 1000 }],
        savingsSplit: [{ from: 'Salary', to: 'Rent', percent: 20 }] });
    assert.ok(r, 'the split to an expense compiled');
    assert.match(r.reason, /Rent is an expense/);
    assert.match(r.question, /Savings/, 'the question should offer the accounts');
    assert.doesNotMatch(r.question, /I have:.*Rent/, 'an expense was offered as a place to save');
});

await check('a share of income sent to a health plan is refused', () => {
    const r = refusalFrom({ settingsOverrides: { startAge: 60, retirementAge: 60, finishAge: 70 },
        income: [{ label: 'Pension', annual: 60000, kind: 'pension' }],
        accounts: [{ label: 'Savings', startingBalance: 20000 }],
        healthInsurance: [{ label: 'Marketplace', premium: { monthly: 900 } }],
        savingsSplit: [{ from: 'Pension', to: 'Marketplace', percent: 20 }] });
    assert.ok(r);
    assert.match(r.reason, /Marketplace is an expense/);
});

await check('a one-year plan asked for in January runs twelve months', async () => {
    // It ran 24: the finish age was the start age plus one, and a plan runs to
    // December of its finish-age year.
    const one = builtAt('2026-01-15T12:00:00', { ...TURN_ONE, horizonYears: 1 });
    assert.deepEqual(one.horizon, { firstMonth: '2026-01', lastMonth: '2026-12', years: 1, months: 12 });
    assert.equal(monthsRun((await runPlan(one.spec)).portfolio), 12);
    assert.ok(!one.notes.some(n => /longer/.test(n)), 'an exact horizon needs no caveat');

    const ten = builtAt('2026-01-15T12:00:00', TURN_ONE);
    assert.equal(ten.horizon.months, 120);
    assert.equal(ten.spec.settings.finishAge, 59, 'ten calendar years from 50 end the year of 59');
    assert.equal(monthsRun((await runPlan(ten.spec)).portfolio), 120);
});

await check('a horizon from any other month says how much longer it runs', async () => {
    const { spec, horizon, notes } = buildPlan(TURN_ONE);          // November 2026
    assert.deepEqual(horizon, { firstMonth: '2026-11', lastMonth: '2036-12', years: 10, months: 122 });
    assert.equal(monthsRun((await runPlan(spec)).portfolio), horizon.months,
        'the reply and the run disagree about how long the plan is');
    assert.ok(notes.some(n => /10 years/.test(n) && /2 months longer/.test(n) && /December 2036/.test(n)),
        'the extra months were not stated: ' + notes.join(' | '));
});

await check('a rate given as a percentage is refused, wherever it is given', () => {
    // An 8.5 growth rate ran as 850% a year: $10,000 became $1.76 billion.
    const account = refusalFrom({ ...TURN_ONE,
        accounts: [{ label: 'Savings', startingBalance: 10000, growthRate: 8.5 }] });
    assert.ok(account, 'an 850% account compiled');
    assert.match(account.reason, /850% a year/);
    assert.deepEqual(account.options, { rate: [0.085] }, 'the offered rate is the percentage as a decimal');

    const inflation = refusalFrom({ ...TURN_ONE, settingsOverrides: { inflationRate: 3 } });
    assert.ok(inflation, '300% inflation compiled');
    assert.equal(inflation.field, 'inflationRate');

    const raise = refusalFrom({ ...TURN_ONE, income: [{ label: 'Salary', annual: 100000, growthRate: 2.5 }] });
    assert.ok(raise, 'a 250% raise compiled');

    const premium = refusalFrom({ settingsOverrides: { startAge: 60, retirementAge: 60, finishAge: 70 },
        income: [{ label: 'Pension', annual: 60000, kind: 'pension' }],
        accounts: [{ label: 'Savings', startingBalance: 20000 }],
        healthInsurance: [{ premium: { monthly: 900 }, growthRate: 7 }] });
    assert.ok(premium, 'a 700% premium rise compiled');

    // The boundary, and the rates a plan really uses.
    assert.equal(refusalFrom({ ...TURN_ONE,
        accounts: [{ label: 'Savings', startingBalance: 0, growthRate: 0.5 }] }), null);
    assert.ok(refusalFrom({ ...TURN_ONE,
        accounts: [{ label: 'Savings', startingBalance: 0, growthRate: 0.51 }] }));
    assert.ok(refusalFrom({ ...TURN_ONE,
        accounts: [{ label: 'Savings', startingBalance: 0, growthRate: -0.51 }] }));
    assert.equal(refusalFrom({ ...TURN_ONE, settingsOverrides: { inflationRate: 0.04 },
        income: [{ label: 'Salary', annual: 100000, growthRate: -0.02 }] }), null);
});

await check('an income of zero or less is refused', () => {
    // A salary of -100,000 ran untaxed and saved $460,936 in five years.
    for (const annual of [-100000, 0]) {
        const r = refusalFrom({ ...TURN_ONE, income: [{ label: 'Salary', annual }] });
        assert.ok(r, `an income of ${annual} compiled`);
        assert.match(r.reason, /above zero/);
    }
    assert.ok(refusalFrom({ ...TURN_ONE, income: [{ label: 'Salary', monthly: Number.NaN }] }));
    // An expense is a magnitude, so its sign is not read; an amount that is not
    // a number still is.
    const rent = refusalFrom({ ...TURN_ONE, expenses: [{ label: 'Rent', monthly: Number.NaN }] });
    assert.ok(rent, 'an expense of NaN compiled');
    assert.match(rent.reason, /not a number/);
});

await check('an account that starts below zero is refused', () => {
    const r = refusalFrom({ ...TURN_ONE, accounts: [{ label: 'Savings', startingBalance: -5000 }] });
    assert.ok(r);
    assert.match(r.reason, /below zero/);
});

await check('a pension named as an account is refused, by label or by kind', () => {
    // "My pension pot", $200,000, resolved to the Pension INCOME instrument
    // and paid its balance every month.
    const byLabel = refusalFrom({ ...TURN_ONE, accounts: [{ label: 'Savings', startingBalance: 0 },
        { label: 'My pension pot', startingBalance: 200000 }] });
    assert.ok(byLabel, 'a pension pot compiled as an account');
    assert.match(byLabel.reason, /income, not an account/);
    assert.ok(byLabel.options, 'the refusal should offer what an account can be');

    for (const kind of [Instrument.PENSION, Instrument.WORKING_INCOME, Instrument.RETIREMENT_INCOME]) {
        const byKind = refusalFrom({ ...TURN_ONE, accounts: [{ label: 'Savings', startingBalance: 0 },
            { label: 'Pot', kind, startingBalance: 200000 }] });
        assert.ok(byKind, `an account of kind ${kind} compiled`);
    }

    // A word that does name an account still wins.
    const { spec } = buildPlan({ ...TURN_ONE, accounts: [{ label: 'Savings', startingBalance: 0 },
        { label: 'Pension rollover IRA', startingBalance: 200000 }] });
    assert.equal(spec.modelAssets.find(a => a.displayName === 'Pension rollover IRA').instrument,
        Instrument.IRA);
    // And a pension as an income is what it always was.
    assert.equal(refusalFrom({ ...TURN_ONE, income: [{ label: 'Salary', annual: 40000 },
        { label: 'Pension', annual: 24000, kind: 'pension' }] }), null);
});

await check('work income in a plan that starts at or after retirement is refused', () => {
    // "I am 70 and earn $100k": the default retirement age is 67, so the
    // salary's last month fell before its first and it never paid.
    const late = refusalFrom({ income: [{ label: 'Salary', annual: 100000 }],
        accounts: [{ label: 'Savings', startingBalance: 0 }], settingsOverrides: { startAge: 70 } });
    assert.ok(late, 'a salary that could never pay compiled');
    assert.match(late.reason, /would never be paid/);
    assert.match(late.reason, /default retirement age/);
    assert.equal(late.field, 'retirementAge');

    const atRetirement = refusalFrom({ income: [{ label: 'Salary', annual: 100000 }],
        accounts: [{ label: 'Savings', startingBalance: 0 }],
        settingsOverrides: { startAge: 65, retirementAge: 65 } });
    assert.ok(atRetirement);
    assert.doesNotMatch(atRetirement.reason, /default retirement age/, 'that age was stated');

    // One year short of it is a plan, and so is a retired household on benefits.
    assert.equal(refusalFrom({ income: [{ label: 'Salary', annual: 100000 }],
        accounts: [{ label: 'Savings', startingBalance: 0 }],
        settingsOverrides: { startAge: 66 } }), null);
    assert.equal(refusalFrom({ income: [{ label: 'Pension', annual: 60000, kind: 'pension' }],
        accounts: [{ label: 'Savings', startingBalance: 50000 }],
        settingsOverrides: { startAge: 70 } }), null);
});

await check('nothing the user named is adopted as the spending build_plan sizes', () => {
    // A stated expense of that name had the unsaved income added to it:
    // $3,000 became $8,938.50, under "You never mentioned spending".
    const expense = refusalFrom({ ...TURN_ONE, expenses: [{ label: 'Living Expenses', monthly: 3000 }] });
    assert.ok(expense, 'a stated Living Expenses was merged with the residual');
    assert.match(expense.reason, /already has an expense called that/);
    assert.match(expense.question, /stated total for spending/);

    // An account of that name had the residual taken off its balance, and no
    // expense was created: the plan spent nothing.
    const account = refusalFrom({ horizonYears: 5, income: [{ label: 'Salary', annual: 100000 }],
        accounts: [{ label: 'Living Expenses', kind: 'bank', startingBalance: 20000 }],
        savingsSplit: [{ from: 'Salary', to: 'Living Expenses', percent: 10 }] });
    assert.ok(account, 'an account called Living Expenses was adopted as the residual');
    assert.match(account.reason, /already has an account called that/);
    assert.match(account.question, /account be called/);

    // With every dollar of income routed there is no residual, so the name is free.
    const { spec } = buildPlan({ horizonYears: 5, income: [{ label: 'Salary', annual: 100000 }],
        accounts: [{ label: 'Savings', startingBalance: 20000 }],
        expenses: [{ label: 'Living Expenses', monthly: 3000 }],
        savingsSplit: [{ from: 'Salary', to: 'Savings', percent: 100 }] });
    assert.equal(spec.modelAssets.find(a => a.displayName === 'Living Expenses').startCurrency.amount, -3000);
});

await check('a horizon that lands exactly on retirement is refused', () => {
    // The case that came back from a real session, and the reason this check
    // sits on the DERIVED value: nobody typed a finish age. "A ten-year plan"
    // from 55 derives 65, which is the preRetirement retirement age, and the
    // engine happily produced a report for a retirement with no months in it.
    const r = refusalFrom({
        ...TURN_ONE,
        settingsOverrides: { startAge: 55, retirementAge: 65 },
    });
    assert.ok(r, 'finishAge == retirementAge was accepted');
    assert.match(r.reason, /same age it retires|no months/i);
    assert.match(r.question, /85|before it/i);
});

await check('a STATED finish age equal to retirement is refused the same way', () => {
    const r = refusalFrom({
        income: TURN_ONE.income,
        accounts: TURN_ONE.accounts,
        savingsSplit: TURN_ONE.savingsSplit,
        settingsOverrides: { startAge: 55, retirementAge: 65, finishAge: 65 },
    });
    assert.ok(r, 'the collision is only caught on the derived path');
});

await check('a plan that stops BEFORE retirement is allowed, and says so', () => {
    // Not a collision. This is §5.1's own example — ten years from 50 lands at
    // 60, retirement never fires, and an accumulation-only answer is correct.
    // Refusing it would block the most common question this tool exists for.
    const built = buildPlan({ ...TURN_ONE, settingsOverrides: { startAge: 50, retirementAge: 67 } });
    assert.equal(built.spec.settings.finishAge, 60);
    assert.ok(built.notes.some(n => /accumulation only/i.test(n)),
        'a plan that never reaches retirement said nothing about it: ' + JSON.stringify(built.notes));
    assert.ok(!built.notes.some(n => /includes a drawdown/i.test(n)),
        'a plan that never retires claimed to include a drawdown');
});

await check('a plan that crosses retirement still declares its drawdown', () => {
    const built = buildPlan({
        ...TURN_ONE,
        horizonYears: 30,
        settingsOverrides: { startAge: 50, retirementAge: 67 },
    });
    assert.equal(built.spec.settings.finishAge, 80);
    assert.ok(built.notes.some(n => /includes a drawdown/i.test(n)),
        'the drawdown note went missing: ' + JSON.stringify(built.notes));
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

// ── The estimate follows every rule the engine applies ──────────────
//
// The pin above uses the simplest household: a 50-year-old on wages alone.
// Each case below exercises a rule a wages-only estimate would miss (Social
// Security under §86, the age-65 deductions, pension withholding, 401(k)
// deferral). Missing any of them is off by hundreds of dollars a month, or
// leaves a 401(k) plan unfunded for most of its months.

/** What the run deposits, and what build_plan planned to spend, in month one. */
async function firstMonth(intent) {
    const { spec } = buildPlan(intent);
    const { portfolio } = await runPlan(spec);
    const month = String(portfolio.firstDateInt);
    const booked = (name, type) => (portfolio.modelAssets.find(a => a.displayName === name)?.events ?? [])
        .filter(e => e.type === type && String(e.dateInt) === month)
        .reduce((n, e) => n + e.amount.amount, 0);
    const le = Math.abs(spec.modelAssets.find(a => a.displayName === 'Living Expenses').startCurrency.amount);
    const unfundedMonths = new Set(portfolio.modelAssets.flatMap(a => a.events)
        .filter(e => e.type === 'unfunded').map(e => String(e.dateInt))).size;
    return { spec, portfolio, booked, le, unfundedMonths };
}

/** Salary take-home as payroll books it: gross less FICA, income tax and any deferral. */
const salaryTakeHome = (r, deferral = 0) =>
    r.portfolio.modelAssets.find(a => a.displayName === 'Salary').startCurrency.amount
    + r.booked('Salary', 'ficaWithholding') + r.booked('Salary', 'incomeTaxWithholding') - deferral;

const SAVE_10 = { horizonYears: 10, accounts: [{ label: 'Savings', startingBalance: 0 }],
    savingsSplit: [{ from: 'Salary', to: 'Savings', percent: 10 }] };

await check('Social Security is taxed by §86, not at a flat 85%', async () => {
    // $20k of wages and $24k of benefits: provisional income $32,000, so §86
    // taxes $3,500 of the benefit where a flat 85% taxed $20,400. At 63: a
    // benefit can't be claimed before 62, and 65 would add age deductions.
    const r = await firstMonth({ ...SAVE_10, settingsOverrides: { startAge: 63, retirementAge: 67 },
        income: [{ label: 'Salary', annual: 20000 },
        { label: 'Social Security', annual: 24000, kind: 'socialSecurity' }] });
    const planned = 0.9 * salaryTakeHome(r) + 2000;      // SS withholds nothing by default
    assert.ok(Math.abs(r.le - planned) < 0.01,
        `Living Expenses ${r.le.toFixed(2)}, but the run deposits for ${planned.toFixed(2)}`);
});

await check('a household of 65+ gets the age deductions in the estimate', async () => {
    const r = await firstMonth({ ...SAVE_10, settingsOverrides: { startAge: 66, retirementAge: 70 },
        income: [{ label: 'Salary', annual: 100000 }] });
    const planned = 0.9 * salaryTakeHome(r);
    assert.ok(Math.abs(r.le - planned) < 0.01,
        `Living Expenses ${r.le.toFixed(2)}, but the run deposits for ${planned.toFixed(2)}`);
});

await check('a pension withholds on arrival, and the plan spends what arrives', async () => {
    const r = await firstMonth({ ...SAVE_10, income: [{ label: 'Salary', annual: 40000 },
        { label: 'Pension', annual: 24000, kind: 'pension' }] });
    const pensionTakeHome = 2000 + r.booked('Pension', 'incomeTaxWithholding');
    assert.ok(pensionTakeHome < 2000, 'the pension withheld nothing — this case would be vacuous');
    const planned = 0.9 * salaryTakeHome(r) + pensionTakeHome;
    assert.ok(Math.abs(r.le - planned) < 0.01,
        `Living Expenses ${r.le.toFixed(2)}, but the run deposits for ${planned.toFixed(2)}`);
});

await check('a 401(k) deferral is taken before tax, and the plan still funds itself', async () => {
    const r = await firstMonth({ horizonYears: 10,
        income: [{ label: 'Salary', annual: 100000 }],
        accounts: [{ label: 'Savings', startingBalance: 0 }, { label: '401k', startingBalance: 0 }],
        savingsSplit: [{ from: 'Salary', to: '401k', percent: 10 }] });
    const deferral = r.portfolio.modelAssets.find(a => a.displayName === '401k')
        .getHistory('four01KContribution')[0];
    assert.ok(deferral > 0, 'no deferral was booked — this case would be vacuous');
    const planned = 0.9 * salaryTakeHome(r, deferral);
    assert.ok(Math.abs(r.le - planned) < 0.01,
        `Living Expenses ${r.le.toFixed(2)}, but the run deposits for ${planned.toFixed(2)}`);
    assert.equal(r.unfundedMonths, 0, `${r.unfundedMonths} unfunded months — the plan does not fund itself`);
});

await check('the emitted spec is anchored — it does not move with the clock', async () => {
    // Ties the compiler to plan anchoring. A compiler whose output means
    // something different next January has a nondeterministic target.
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
