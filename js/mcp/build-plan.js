/**
 * build-plan.js — turning a sentence into a plan the engine can run.
 *
 * Spec 10, steps 1 and 2. `run_plan` is the runtime; this is the compiler in
 * front of it, and **its most valuable output is a refusal or a question.**
 *
 * ── Why a gate exists at all ─────────────────────────────────────────
 *
 * The engine's documented failure mode is *numbers, never errors*. Ages that
 * move no date, life events dropped on the floor, a filing status never set:
 * each produced a clean report of a plan nobody asked for. A conversational
 * surface makes that worse twice over — the user supplies less information than
 * any UI would demand, and an agent renders whatever it receives as prose,
 * which is to say as advice.
 *
 * This is the only component positioned to say *"that sentence does not
 * determine a plan."* The engine cannot: by the time it sees a spec, every
 * ambiguity has already been resolved into a number.
 *
 * So whenever this module must choose between guessing and asking, the tie goes
 * to asking (`PlanRefusal`); and whenever it guesses anyway, the guess is
 * recorded in the assumption ledger and travels with the plan.
 *
 * ── It takes intent, and owns construction ───────────────────────────
 *
 * `run_plan`'s asset schema is `z.record(z.string(), z.any())` — correct for
 * passing through a portfolio the app exported, wrong for authoring one. It
 * gives a caller no guidance on `startDateInt` encoding, on whether
 * `startCurrency` is a number or a Currency, on `annualReturnRate` being an
 * ARR. Every wrong guess is silent.
 *
 * So the caller supplies MEANING and this module supplies Instrument keys,
 * dates, rates and phases. See §4 of the spec, and `run-plan.js`'s own header
 * on what a second client costs when it reimplements setup.
 *
 * ── What it returns ──────────────────────────────────────────────────
 *
 * A plan SPEC — the same `{name, settings, modelAssets, lifeEvents,
 * guardrailParams}` shape everything else already speaks — plus the assumption
 * ledger. It runs nothing. `run_plan` remains the only run path, and mints the
 * handle. (Spec §14 open question 1, decided 2026-08-31: return the spec, so
 * the gate stays honest that it ran nothing.)
 */

import { ModelAsset } from '../model-asset.js';
import { ModelLifeEvent, LifeEvent } from '../life-event.js';
import { Instrument, InstrumentMeta } from '../instruments/instrument.js';
import { SIM_CONFIG_DEFAULTS } from '../sim-config.js';
import { FilingStatus, asFilingStatus } from '../filing-status.js';
import { DateInt } from '../utils/date-int.js';
import { TaxTable, TaxOwner } from '../taxes.js';
import { Currency } from '../utils/currency.js';

// ── Refusals ─────────────────────────────────────────────────────────

/**
 * A sentence that does not determine a plan.
 *
 * Carries structure rather than only a message, because the caller is an agent
 * that has to ask the user something specific. `options` turns a refusal into
 * the offer §8 asks for — *"Retirement (401K, IRA, Roth IRA) or capital
 * (Taxable Account, Savings)?"* — rather than a dead end.
 */
export class PlanRefusal extends Error {
    constructor(reason, { question = null, options = null, field = null } = {}) {
        super(reason);
        this.name = 'PlanRefusal';
        this.reason = reason;
        this.question = question;
        this.options = options;
        this.field = field;
    }
}

// ── Step 1: the settings preamble (§7) ───────────────────────────────

/**
 * The defaults, with the gloss that makes them answerable.
 *
 * §7 calls this "the smallest possible addition and the highest-leverage one":
 * it converts the largest class of silent wrongness — a plan about a person the
 * user is not — into a visible sentence. `SIM_CONFIG_DEFAULTS` says
 * `startAge: 50`, so *"how much will I have in 10 years"* silently plans for a
 * fifty-year-old unless someone says otherwise.
 *
 * Runs once per conversation, not once per plan.
 */
export const PLAN_DEFAULT_GLOSS = Object.freeze([
    Object.freeze({ field: 'startAge', value: SIM_CONFIG_DEFAULTS.startAge,
        gloss: 'how old you are now' }),
    Object.freeze({ field: 'retirementAge', value: SIM_CONFIG_DEFAULTS.retirementAge,
        gloss: 'when work income stops' }),
    Object.freeze({ field: 'finishAge', value: SIM_CONFIG_DEFAULTS.finishAge,
        gloss: 'how far out to project' }),
    Object.freeze({ field: 'inflationRate', value: SIM_CONFIG_DEFAULTS.inflationRate,
        gloss: 'annual inflation applied to expenses' }),
    Object.freeze({ field: 'filingAs', value: SIM_CONFIG_DEFAULTS.filingAs,
        gloss: 'tax filing status' }),
]);

/** Step 1. The defaults a plan starts from, before anyone has said anything. */
export function planDefaults() {
    return PLAN_DEFAULT_GLOSS.map(d => ({ ...d }));
}

// ── Step 2: the intent vocabulary (§4) ───────────────────────────────

/**
 * Wording → Instrument (§8). Longest match wins, so "roth ira" does not resolve
 * as "ira".
 *
 * Deliberately partial. When wording does not determine an instrument this
 * module does NOT pick — it offers by category, which is what `ACCOUNT_CATEGORIES`
 * below is for. A silent default here would put money in an account with the
 * wrong tax treatment and report a tidy number.
 */
const ACCOUNT_WORDS = Object.freeze([
    ['roth ira', Instrument.ROTH_IRA],
    ['roth', Instrument.ROTH_IRA],
    ['traditional ira', Instrument.IRA],
    ['ira', Instrument.IRA],
    ['401k', Instrument.FOUR_01K],
    ['401(k)', Instrument.FOUR_01K],
    ['brokerage', Instrument.TAXABLE_EQUITY],
    ['taxable', Instrument.TAXABLE_EQUITY],
    ['after-tax', Instrument.TAXABLE_EQUITY],
    ['savings account', Instrument.BANK],
    ['savings', Instrument.BANK],
    ['bank', Instrument.BANK],
    ['cash account', Instrument.BANK],
    ['checking', Instrument.BANK],
    ['pension', Instrument.PENSION],
]);

// A note on "savings", per §8.1. The word does double duty — *"splitting
// savings by 5% to brokerage and 5% to savings"* uses it once as the act of
// saving and once as the BANK instrument whose label is literally **Savings**.
// That ambiguity lives in the SENTENCE, and is resolved before it reaches here:
// by the time an account arrives in `intent.accounts` it names an account. What
// this module owes the case is that two accounts stay two accounts and the
// shares are read against the source — see the §5.4 note and `claim()`.

const ACCOUNT_CATEGORIES = Object.freeze({
    retirement: [Instrument.FOUR_01K, Instrument.IRA, Instrument.ROTH_IRA],
    capital: [Instrument.TAXABLE_EQUITY, Instrument.BANK],
});

const INCOME_KINDS = Object.freeze({
    working: Instrument.WORKING_INCOME,
    pension: Instrument.PENSION,
    socialSecurity: Instrument.RETIREMENT_INCOME,
});

/**
 * Default growth rates, by instrument.
 *
 * Every one of these is a guess the user did not make, so every one becomes a
 * `default` entry in the ledger. A single blanket rate would be worse than it
 * looks: 8.5% on a savings account is not a rounding error, it is a different
 * plan.
 *
 * Note the compounding convention while reading these — `ARR.asMonthly()` is
 * `rate / 12`, so a stated 8.5% realizes about 8.839% a year. The rates are
 * quick-start's, kept identical on purpose: a plan built here and a profile
 * built there should not disagree about what a brokerage account does.
 */
const DEFAULT_RATES = Object.freeze({
    [Instrument.BANK]: 0.02,
    [Instrument.TAXABLE_EQUITY]: 0.085,
    [Instrument.FOUR_01K]: 0.085,
    [Instrument.IRA]: 0.085,
    [Instrument.ROTH_IRA]: 0.085,
    [Instrument.PENSION]: 0.025,
    [Instrument.WORKING_INCOME]: 0.025,
    [Instrument.RETIREMENT_INCOME]: 0.025,
});

const RESIDUAL_EXPENSE_LABEL = 'Living Expenses';

/**
 * What the income is actually worth once the engine has withheld from it.
 *
 * ── Why this exists, and why it is the risky part of this module ─────
 *
 * Fund transfers take their percentage of an income asset's value AFTER
 * withholding: on $100K single, $8,333/mo gross becomes $6,598 net, and a 90%
 * residual leg delivers $5,938. Sizing the residual expense from GROSS instead
 * makes it $7,500 — so every plan is short by exactly the tax, every month,
 * for ever. That is not a rounding error; it is the difference between a plan
 * that funds itself and one that reports `unfunded` 125 times.
 *
 * So the residual has to be sized from net, and net is a tax question.
 *
 * **Nothing here invents a rate.** `calculateFICATax` and
 * `calculateYearlyIncomeTax` are the engine's own, called with the engine's own
 * table; the only thing this function contributes is the ORDER, which mirrors
 * `payroll-engine.js`: FICA per asset, household income tax on the annualised
 * total less the standard deduction, then allocated across earners in
 * proportion to income.
 *
 * That order is nevertheless a SECOND implementation of a sequence the payroll
 * engine owns, which is the cost of keeping §5.3 as written. It is pinned by
 * `tests/build-plan.mjs`, which compares this estimate against the withholding
 * a real run actually books, to the cent. If the payroll pass changes and this
 * does not, that test fails — which is the whole reason it exists.
 */
function withholdingFor(incomeAssets, { filingAs, propertyTaxDeductionMax }) {
    const taxTable = new TaxTable(filingAs, propertyTaxDeductionMax);

    // FICA is per asset and applies to WORKING income only — the same guard
    // `applyPreTaxWithholding` uses. A pension is not wages.
    const fica = new Map();
    for (const a of incomeAssets) {
        fica.set(a.displayName, a.instrument === Instrument.WORKING_INCOME
            ? taxTable.calculateFICATax(false,
                new Currency(a.startCurrency.amount), TaxOwner.PRIMARY).fica().amount
            : 0);
    }

    // Social Security enters the IRS base at a flat 85% (financial-package.js:69),
    // so it must not be annualised at face value here either.
    const annualOrdinary = incomeAssets.reduce((sum, a) => sum + a.startCurrency.amount * 12
        * (a.instrument === Instrument.RETIREMENT_INCOME ? 0.85 : 1), 0);

    const taxable = Math.max(0, annualOrdinary - taxTable.activeStandardDeduction);
    const householdMonthlyTax =
        taxTable.calculateYearlyIncomeTax(new Currency(taxable)).amount / 12;

    // Allocated in proportion to income, exactly as applyNetIncome does.
    const totalWorking = incomeAssets
        .filter(a => a.instrument === Instrument.WORKING_INCOME)
        .reduce((n, a) => n + a.startCurrency.amount, 0);

    const net = new Map();
    for (const a of incomeAssets) {
        const share = totalWorking > 0 && a.instrument === Instrument.WORKING_INCOME
            ? a.startCurrency.amount / totalWorking : 0;
        const incomeTax = householdMonthlyTax * share;
        net.set(a.displayName,
            Math.max(0, a.startCurrency.amount - fica.get(a.displayName) - incomeTax));
    }
    return { net, taxTable, householdMonthlyTax };
}

// ── The ledger (§6, §9.2) ────────────────────────────────────────────

/** Where a FIELD's value came from. */
export const Provenance = Object.freeze({
    STATED: 'stated',     // the user said it
    INFERRED: 'inferred', // resolved from wording
    DERIVED: 'derived',   // computed from something stated
    DEFAULT: 'default',   // SIM_CONFIG_DEFAULTS, untouched
});

/**
 * Where an ASSET came from. Deliberately NOT merged with Provenance: a field
 * and an asset are not the same kind of thing, and only one of them is the
 * user's to own.
 */
export const AssetOrigin = Object.freeze({
    STATED: 'stated',         // "add a brokerage account"
    IMPLIED: 'implied',       // "5% to a brokerage" — named in the request itself
    STRUCTURAL: 'structural', // a construction rule produced it
});

class Ledger {
    constructor() {
        this.fields = [];
        this.assets = [];
    }

    field(name, value, provenance, note = null) {
        this.fields.push({ field: name, value, provenance, note });
        return value;
    }

    asset(label, origin, note = null) {
        this.assets.push({ label, origin, note });
    }

    /**
     * §6: a field with no declared provenance is a BUILD ERROR, not a blank.
     * Same shape as EVENT_RECONCILIATION throwing on an undeclared event type —
     * the failure being defended against is documented and specific: an agent
     * handed a number and a footnote reports the number.
     */
    assertComplete(settings, assetLabels) {
        const declared = new Set(this.fields.map(f => f.field));
        const missing = Object.keys(settings).filter(k => !declared.has(k));
        if (missing.length) {
            throw new Error(`build_plan: settings field(s) ${missing.join(', ')} `
                + 'reached the spec with no declared provenance. Every field '
                + 'carries one; see §6.');
        }
        const withOrigin = new Set(this.assets.map(a => a.label));
        const unattributed = assetLabels.filter(l => !withOrigin.has(l));
        if (unattributed.length) {
            throw new Error(`build_plan: asset(s) ${unattributed.join(', ')} `
                + 'carry no origin. An unattributed asset is indistinguishable '
                + 'from one the user supplied; see §9.2.');
        }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────

const monthlyFrom = ({ annual, monthly }, what) => {
    if (monthly != null && annual != null) {
        throw new PlanRefusal(
            `${what} gives both a monthly and an annual amount.`,
            { question: `Is ${what} ${monthly}/month or ${annual}/year?`, field: what });
    }
    if (monthly != null) return monthly;
    if (annual != null) return annual / 12;
    throw new PlanRefusal(`${what} has no amount.`,
        { question: `How much is ${what}? Monthly or annual is fine.`, field: what });
};

const labelFor = key => InstrumentMeta.get(key)?.label ?? key;

function resolveAccountInstrument(account) {
    if (account.kind) {
        if (!Object.values(Instrument).includes(account.kind)) {
            throw new PlanRefusal(
                `"${account.kind}" is not an instrument this engine has.`,
                { question: `What kind of account is ${account.label}?`,
                  options: ACCOUNT_CATEGORIES, field: account.label });
        }
        return { instrument: account.kind, provenance: Provenance.STATED };
    }

    const hay = String(account.label ?? '').toLowerCase();
    // Longest match first, so "roth ira" never resolves through "ira".
    const hit = [...ACCOUNT_WORDS]
        .sort((a, b) => b[0].length - a[0].length)
        .find(([word]) => hay.includes(word));
    if (hit) return { instrument: hit[1], provenance: Provenance.INFERRED };

    // §8: when wording does not determine one, do NOT pick.
    //
    // §8.1 is the case that proves it: "splitting savings by 5% to brokerage and
    // 5% to savings" uses the word twice — once as the act of saving, once as
    // the BANK instrument whose label is literally "Savings". Routing 10% into
    // one account and reporting a tidy number is the failure mode.
    throw new PlanRefusal(
        `"${account.label}" does not name an account type I can resolve.`,
        {
            question: `What kind of account is "${account.label}" — `
                + 'retirement (401K, IRA, Roth IRA) or capital '
                + '(Taxable Account, Savings)?',
            options: ACCOUNT_CATEGORIES,
            field: account.label,
        });
}

// ── build_plan ───────────────────────────────────────────────────────

/**
 * Compile intent into a plan spec.
 *
 * @param {object} intent  see §4 of the spec
 * @returns {{spec: object, ledger: {fields: Array, assets: Array}, notes: string[]}}
 * @throws {PlanRefusal} when the intent does not determine a plan
 */
export function buildPlan(intent = {}) {
    const ledger = new Ledger();
    const notes = [];

    if (!Array.isArray(intent.income) || intent.income.length === 0) {
        throw new PlanRefusal('A plan needs at least one income source.', {
            question: 'What income should the plan start from — '
                + 'a salary, a pension, Social Security?',
            field: 'income',
        });
    }

    // ── Settings (§5.1, §7) ──────────────────────────────────────
    const o = intent.settingsOverrides ?? {};
    const D = SIM_CONFIG_DEFAULTS;

    const startAge = ledger.field('startAge',
        o.startAge ?? D.startAge,
        o.startAge != null ? Provenance.STATED : Provenance.DEFAULT,
        o.startAge != null ? null : 'nobody said how old you are');

    const retirementAge = ledger.field('retirementAge',
        o.retirementAge ?? D.retirementAge,
        o.retirementAge != null ? Provenance.STATED : Provenance.DEFAULT);

    // §5.1. "How much in 10 years" against the defaults simulates a 50-year-old
    // to 87 — a 37-year run, not a 10-year one. The derivation must be
    // DECLARED, because it silently pins the user's age.
    if (intent.horizonYears != null && o.finishAge != null) {
        throw new PlanRefusal(
            'The plan has both a horizon and a finish age, and they may disagree.',
            { question: `Project for ${intent.horizonYears} years, or out to `
                + `age ${o.finishAge}?`, field: 'finishAge' });
    }
    let finishAge;
    if (o.finishAge != null) {
        finishAge = ledger.field('finishAge', o.finishAge, Provenance.STATED);
    } else if (intent.horizonYears != null) {
        finishAge = ledger.field('finishAge', startAge + intent.horizonYears,
            Provenance.DERIVED,
            `${intent.horizonYears} years from a start age of ${startAge}`);
    } else {
        finishAge = ledger.field('finishAge', D.finishAge, Provenance.DEFAULT,
            'no horizon given, so the plan runs to the default finish age');
    }

    if (finishAge <= startAge) {
        throw new PlanRefusal(
            `The plan finishes at ${finishAge}, at or before it starts (${startAge}).`,
            { question: 'How far out should the plan project?', field: 'finishAge' });
    }

    const inflationRate = ledger.field('inflationRate',
        o.inflationRate ?? D.inflationRate,
        o.inflationRate != null ? Provenance.STATED : Provenance.DEFAULT);

    const filingAs = ledger.field('filingAs',
        o.filingAs != null ? asFilingStatus(o.filingAs, D.filingAs) : D.filingAs,
        o.filingAs != null ? Provenance.STATED : Provenance.DEFAULT);

    // §5.1's note: from 50, ten years lands at 60 and retirement never fires.
    // The same question from a 60-year-old crosses the boundary and quietly
    // becomes a different plan with a drawdown in it. Say so.
    const reachesRetirement = finishAge >= retirementAge;
    if (reachesRetirement) {
        notes.push(`This plan runs past your retirement age (${retirementAge}), `
            + 'so it includes a drawdown: work income stops and expenses are '
            + 'paid from the accounts.');
    }

    // ── Dates ────────────────────────────────────────────────────
    //
    // Captured ONCE, here, and written into the spec as absolute months. That
    // is the whole point of Spec 10 step 0: the builder anchors, the engine
    // never re-derives. A spec emitted today runs identically in 2030.
    const now = new Date();
    // A DateInt, not its integer form: ModelAsset.fromJSON reads `.year` and
    // `.month` off this object. Handing it the int makes both undefined, the
    // asset's start date NaN, and the failure surfaces four frames away in
    // makeSimConfig — which is a long way to travel from a typo.
    const startMonth = DateInt.from(now.getFullYear(), now.getMonth() + 1);
    const birthYear = now.getFullYear() - startAge;
    const retireMonth = DateInt.from(birthYear + retirementAge, 1);
    const finishMonth = DateInt.from(birthYear + finishAge, 12);

    // ── Assets ───────────────────────────────────────────────────
    const raw = [];
    const seen = new Set();
    const claim = (label, what) => {
        if (seen.has(label)) {
            throw new PlanRefusal(`Two things in this plan are called "${label}".`,
                { question: `Rename one of them — which "${label}" is the ${what}?`,
                  field: label });
        }
        seen.add(label);
    };

    const incomeLabels = [];
    for (const src of intent.income) {
        const label = src.label ?? 'Salary';
        claim(label, 'income source');
        incomeLabels.push(label);

        const kind = src.kind ?? 'working';
        const instrument = INCOME_KINDS[kind];
        if (!instrument) {
            throw new PlanRefusal(`"${kind}" is not an income kind I have.`, {
                question: `Is ${label} working income, a pension, or Social Security?`,
                options: { kind: Object.keys(INCOME_KINDS) },
                field: label,
            });
        }

        const monthly = monthlyFrom(src, label);
        const rate = src.growthRate ?? DEFAULT_RATES[instrument];
        if (src.growthRate == null) {
            ledger.asset(label, AssetOrigin.STATED,
                `grows ${(rate * 100).toFixed(1)}%/yr — you did not say, so this is a default`);
        } else {
            ledger.asset(label, AssetOrigin.STATED);
        }

        raw.push({
            instrument, displayName: label,
            startDateInt: startMonth,
            // Working income stops at retirement — but never AFTER the plan
            // itself ends. A ten-year plan from age 50 finishes at 60 while
            // retirement is 67, and an unclamped salary pushes lastDateInt out
            // to 2043 on a plan the user asked to end in 2036. The run then
            // spans years the plan does not cover, which is a different plan
            // reported as the requested one.
            ...(instrument === Instrument.WORKING_INCOME
                ? { finishDateInt: retireMonth.isBefore(finishMonth)
                    ? retireMonth : finishMonth } : {}),
            startCurrency: { amount: monthly },
            annualReturnRate: { rate },
        });
    }

    const accountLabels = [];
    for (const acct of intent.accounts ?? []) {
        const label = acct.label ?? 'Savings';
        claim(label, 'account');
        accountLabels.push(label);

        const { instrument, provenance } = resolveAccountInstrument(acct);
        const balance = acct.startingBalance ?? 0;
        const rate = acct.growthRate ?? DEFAULT_RATES[instrument] ?? 0;

        ledger.asset(label, AssetOrigin.STATED,
            provenance === Provenance.INFERRED
                ? `read as a ${labelFor(instrument)} from what you called it`
                : null);

        const asset = {
            instrument, displayName: label,
            startDateInt: startMonth,
            startCurrency: { amount: balance },
            annualReturnRate: { rate },
        };

        // §14 open question 4. `startBasisCurrency` defaults to zero, which
        // would make an entire stated balance a future capital gain — a large
        // silent tax bill on money the user told us they already have. Treating
        // a stated balance as fully basis is the conservative reading, and it
        // is recorded rather than assumed quietly.
        if (isBasisBearing(instrument) && balance > 0) {
            asset.startBasisCurrency = { amount: balance };
            ledger.asset(label, AssetOrigin.STATED,
                'treated as all cost basis — you did not say what you paid, and '
                + 'assuming zero would tax the whole balance as gain');
        }
        raw.push(asset);
    }

    const expenseLabels = [];
    for (const exp of intent.expenses ?? []) {
        const label = exp.label ?? 'Expenses';
        claim(label, 'expense');
        expenseLabels.push(label);
        const monthly = monthlyFrom(exp, label);
        ledger.asset(label, AssetOrigin.STATED);
        raw.push({
            instrument: Instrument.MONTHLY_EXPENSE, displayName: label,
            startDateInt: startMonth,
            startCurrency: { amount: -Math.abs(monthly) },
        });
    }

    // ── Routing (§5.3) ───────────────────────────────────────────
    //
    // Quick-start's accumulate splits Salary 5 / 2 / 93. It sums to 100.
    // "Save 10%" names ONE leg of a two-leg split, and a plan that routes only
    // that leg produces a salary that earns, an account that receives a tenth,
    // and ninety per cent of the money vanishing without a report.
    const splits = intent.savingsSplit ?? [];
    for (const s of splits) {
        if (!incomeLabels.includes(s.from)) {
            throw new PlanRefusal(`Nothing called "${s.from}" produces income in this plan.`,
                { question: `Which income should the ${s.percent}% come from? `
                    + `I have: ${incomeLabels.join(', ')}.`, field: 'savingsSplit' });
        }
        if (!accountLabels.includes(s.to) && !expenseLabels.includes(s.to)) {
            throw new PlanRefusal(`Nothing called "${s.to}" can receive money in this plan.`,
                { question: `Where should ${s.from}'s ${s.percent}% go? `
                    + `I have: ${[...accountLabels, ...expenseLabels].join(', ') || 'no accounts yet'}.`,
                  field: 'savingsSplit' });
        }
        if (!(s.percent > 0)) {
            throw new PlanRefusal(`A split of ${s.percent}% from ${s.from} moves nothing.`,
                { question: `What share of ${s.from} should go to ${s.to}?`,
                  field: 'savingsSplit' });
        }
    }

    // Withholding is needed before any residual can be sized, and it depends on
    // every income asset at once (the household tax is allocated across them).
    const incomeAssets = raw.filter(a => incomeLabels.includes(a.displayName));
    const { net: netByIncome, householdMonthlyTax } =
        withholdingFor(incomeAssets, { filingAs,
            propertyTaxDeductionMax: D.propertyTaxDeductionMax });

    // ── Which account holds the money that gets spent ────────────
    //
    // MEASURED, and it corrects §5.3's diagram. The spec draws the residual as
    //
    //     Salary -> Savings          10%
    //     Salary -> Living Expenses  90%
    //
    // and that is the right ECONOMICS but not an encoding this engine has. A
    // transfer INTO a monthly expense does not pay it: the expense received
    // $5,938.50 and still reported `unfunded -5,294.01` in the same month,
    // because an expense is funded by its OWN outbound transfer naming the
    // account that covers it. Quick-start says the same thing in code —
    // `'Living Expenses': [xfer('Brokerage', 100)]` — and §3 already found the
    // general form of this mistake for asset-level transfers.
    //
    // So the residual routes to a spending ACCOUNT, and the expense draws from
    // that same account. The economics are identical and the plan funds itself:
    // income in, spending out, the difference is what accumulates.
    const spendingAccount = pickSpendingAccount(raw, accountLabels);

    const phaseTransfers = {};
    let residualExpense = null;

    for (const label of incomeLabels) {
        const legs = splits.filter(s => s.from === label);
        const stated = legs.reduce((n, s) => n + s.percent, 0);

        // `stochasticLimit` scales down when the total exceeds 100 and says
        // nothing about it; under 100 nothing checks at all. Refuse both.
        if (stated > 100) {
            throw new PlanRefusal(
                `${label} is split ${stated}%, which is more than all of it.`,
                { question: `The shares of ${label} add up to ${stated}%. `
                    + 'What should they be?', field: 'savingsSplit' });
        }

        const outbound = legs.map(s => ({
            toDisplayName: s.to, monthlyMoveValue: s.percent, closeMoveValue: 0,
        }));

        const residual = 100 - stated;
        if (residual > 0) {
            if (!spendingAccount) {
                throw new PlanRefusal(
                    'This plan has income to spend but no account to spend it from.',
                    { question: `Where should the ${residual}% of ${label} you are `
                        + 'not saving be held — a savings or a brokerage account?',
                      options: ACCOUNT_CATEGORIES, field: 'accounts' });
            }

            // The canonical STRUCTURAL asset of §9.2: created by a construction
            // rule rather than by anything the user said. Making the number
            // honest is the same act that puts an asset in the plan nobody
            // asked for, which is exactly why provenance has to travel with it.
            if (!residualExpense) {
                if (seen.has(RESIDUAL_EXPENSE_LABEL)) {
                    residualExpense = RESIDUAL_EXPENSE_LABEL;
                } else {
                    claim(RESIDUAL_EXPENSE_LABEL, 'residual spending');
                    residualExpense = RESIDUAL_EXPENSE_LABEL;
                    raw.push({
                        instrument: Instrument.MONTHLY_EXPENSE,
                        displayName: RESIDUAL_EXPENSE_LABEL,
                        startDateInt: startMonth,
                        startCurrency: { amount: 0 },   // summed below
                    });
                    expenseLabels.push(RESIDUAL_EXPENSE_LABEL);
                }
            }

            // Sized from NET, not gross. The residual share of what survives
            // withholding IS the spending; sizing it from gross makes every
            // plan short by exactly the tax, every month, for ever.
            const target = raw.find(a => a.displayName === RESIDUAL_EXPENSE_LABEL);
            target.startCurrency.amount -= netByIncome.get(label) * (residual / 100);

            outbound.push({
                toDisplayName: spendingAccount,
                monthlyMoveValue: residual, closeMoveValue: 0,
            });
        }

        // Merge legs that share a target. When the account someone saves into
        // is also the account they spend from, the 10% and the 90% are the same
        // pipe, and emitting them separately would show a split the plan does
        // not really have. The stated intent survives in the ledger, which is
        // where it belongs.
        const merged = [];
        for (const leg of outbound) {
            const prior = merged.find(m => m.toDisplayName === leg.toDisplayName);
            if (prior) prior.monthlyMoveValue += leg.monthlyMoveValue;
            else merged.push({ ...leg });
        }
        outbound.length = 0;
        outbound.push(...merged);

        // §5.3's invariant, checked on the emitted spec rather than trusted.
        const total = outbound.reduce((n, t) => n + t.monthlyMoveValue, 0);
        if (Math.abs(total - 100) > 1e-9) {
            throw new Error(`build_plan: ${label} routes ${total}%, not 100%. `
                + 'Every dollar of income must be routed; see §5.3.');
        }
        phaseTransfers[label] = outbound;
    }

    // Every expense draws from the spending account, structural or stated.
    // Without this an expense is an obligation with no payer, and the funding
    // backstop picks an account on its own — a choice nobody recorded.
    for (const label of expenseLabels) {
        if (!spendingAccount) {
            throw new PlanRefusal(
                `Nothing in this plan can pay for ${label}.`,
                { question: `Which account should cover ${label}?`,
                  options: ACCOUNT_CATEGORIES, field: 'accounts' });
        }
        phaseTransfers[label] = [{
            toDisplayName: spendingAccount, monthlyMoveValue: 100, closeMoveValue: 0,
        }];
    }

    if (residualExpense) {
        const amt = raw.find(a => a.displayName === RESIDUAL_EXPENSE_LABEL)
            .startCurrency.amount;
        ledger.asset(RESIDUAL_EXPENSE_LABEL, AssetOrigin.STRUCTURAL,
            'added to absorb the income you are not saving — '
            + `$${Math.abs(Math.round(amt * 12)).toLocaleString()}/yr. `
            + 'You never mentioned spending.');
        notes.push(`${RESIDUAL_EXPENSE_LABEL} — `
            + `$${Math.abs(Math.round(amt * 12)).toLocaleString()}/yr — added to `
            + 'absorb the income you are not saving, after tax. '
            + 'You never mentioned spending.');
    }

    // §5.4. The turn-two split — 5% brokerage, 5% savings — is still 10% saved.
    // A user who believes they doubled their saving rate has misread the plan.
    if (splits.length > 1) {
        notes.push('Percentages are shares of the income they come from, not of '
            + 'each other: 5% to one account and 5% to another is 10% saved, '
            + 'not 10% each.');
    }

    // ── Life events (§5.2) ───────────────────────────────────────
    //
    // The accumulate phase triggers at startAge. Not at a default, not at 45:
    // a phase whose triggerAge postdates the plan's start transfers nothing
    // while producing a complete, plausible report.
    const accumulate = ModelLifeEvent.createDefault(LifeEvent.ACCUMULATE, startAge);
    accumulate.phaseTransfers = phaseTransfers;
    const lifeEvents = [accumulate];
    ledger.field('lifeEvent:accumulate', startAge, Provenance.DERIVED,
        'the accumulate phase triggers at the plan\'s start age');

    // LifeEvent has exactly two members. A plan whose horizon ends before
    // retirementAge emits ONE life event, not two.
    if (reachesRetirement) {
        const fundingAccount = pickDrawdownAccount(raw, accountLabels);
        if (!fundingAccount) {
            throw new PlanRefusal(
                'This plan reaches retirement but has no account to pay expenses from.',
                { question: `Work income stops at ${retirementAge}. Which account `
                    + 'should cover spending after that?', field: 'accounts' });
        }
        const retire = ModelLifeEvent.createDefault(LifeEvent.RETIRE, retirementAge);
        retire.phaseTransfers = Object.fromEntries(
            expenseLabels.map(l => [l, [{
                toDisplayName: fundingAccount, monthlyMoveValue: 100, closeMoveValue: 0,
            }]]));
        lifeEvents.push(retire);
        ledger.field('lifeEvent:retire', retirementAge, Provenance.DERIVED,
            `spending is drawn from ${fundingAccount} once work income stops`);
        notes.push(`After ${retirementAge}, spending is drawn from `
            + `${fundingAccount} — you did not say which account should fund `
            + 'retirement, so I used the largest taxable one.');
    }

    // ── Emit ─────────────────────────────────────────────────────
    const settings = { inflationRate, filingAs, startAge, retirementAge, finishAge };
    ledger.assertComplete(settings, raw.map(a => a.displayName));

    const assets = raw.map(r => ModelAsset.fromJSON(r));
    const spec = {
        name: intent.name ?? 'Conversational plan',
        settings,
        modelAssets: assets.map(a => a.toJSON()),
        lifeEvents: lifeEvents.map(e => e.toJSON()),
        guardrailParams: null,
    };

    // The spec's finish month is derived by the engine from finishAge; this is
    // only for the reply, so the user sees the horizon in years, not ages.
    return {
        spec,
        ledger: { fields: ledger.fields, assets: ledger.assets },
        notes,
        horizon: {
            firstMonth: String(startMonth),
            lastMonth: String(finishMonth),
            years: finishAge - startAge,
        },
    };
}

/** Instruments that carry a cost basis, so a stated balance needs one. */
function isBasisBearing(instrument) {
    return instrument === Instrument.TAXABLE_EQUITY;
}

/**
 * Which account income lands in and spending comes out of.
 *
 * Prefers a bank account, the way the funding backstop prefers everyday
 * accounts: money meant to be spent should not sit somewhere that realizes a
 * capital gain on the way out.
 */
function pickSpendingAccount(raw, accountLabels) {
    const candidates = raw.filter(a => accountLabels.includes(a.displayName));
    for (const want of [Instrument.BANK, Instrument.TAXABLE_EQUITY]) {
        const hit = candidates.find(a => a.instrument === want);
        if (hit) return hit.displayName;
    }
    return candidates[0]?.displayName ?? null;
}

/**
 * Which account pays the bills once work income stops.
 *
 * Taxable first, then anything else. Deliberately never a Roth: draining the
 * tax-free account first is a strategy, and picking a strategy on the user's
 * behalf is the optimization this spec puts out of scope (§13).
 */
function pickDrawdownAccount(raw, accountLabels) {
    const candidates = raw.filter(a => accountLabels.includes(a.displayName));
    const byPreference = [Instrument.TAXABLE_EQUITY, Instrument.BANK,
        Instrument.FOUR_01K, Instrument.IRA, Instrument.ROTH_IRA];
    for (const want of byPreference) {
        const hits = candidates.filter(a => a.instrument === want);
        if (hits.length) {
            return hits.reduce((big, a) =>
                a.startCurrency.amount > big.startCurrency.amount ? a : big).displayName;
        }
    }
    return candidates[0]?.displayName ?? null;
}
