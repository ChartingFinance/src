/**
 * build-plan.js — turning a described situation into a plan the engine can run.
 *
 * `run_plan` is the runtime; this is the compiler in front of it, and its most
 * valuable output is a refusal or a question. Section numbers (§) refer to
 * markdowns/mcp-conversational-plan-spec.md.
 *
 * ── Why a gate ───────────────────────────────────────────────────────
 *
 * The engine turns any input into numbers, never errors. A conversational
 * caller supplies less than a form would, and an agent repeats whatever comes
 * back as advice. Only this module can say "that does not determine a plan":
 * by the time the engine sees a spec, every ambiguity is already a number. So
 * when it must choose between guessing and asking, it asks (`PlanRefusal`);
 * when it guesses anyway, the guess goes in the assumption ledger that travels
 * with the plan.
 *
 * ── Intent in, construction here ─────────────────────────────────────
 *
 * `run_plan` accepts any asset object, which suits passing through an exported
 * portfolio but gives an author no guidance on dates, Currency or ARR. So the
 * caller supplies meaning (§4), and this module supplies instrument keys,
 * dates, rates and phases.
 *
 * ── What it returns ──────────────────────────────────────────────────
 *
 * A plan spec — the `{name, settings, modelAssets, lifeEvents,
 * guardrailParams}` shape the rest of the system uses — plus the assumption
 * ledger. It runs nothing; `run_plan` is the only run path and mints the handle.
 */

import { ModelAsset } from '../model-asset.js';
import { ModelLifeEvent, LifeEvent } from '../life-event.js';
import { Instrument, InstrumentMeta } from '../instruments/instrument.js';
import { SIM_CONFIG_DEFAULTS } from '../sim-config.js';
import { FilingStatus, asFilingStatus } from '../filing-status.js';
import { DateInt } from '../utils/date-int.js';
import { TaxTable, TaxOwner } from '../taxes.js';
import { Currency } from '../utils/currency.js';
import { FinancialPackage } from '../financial-package.js';
import { taxableBasis } from '../tax-basis.js';
import { User } from '../user.js';

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
 * The defaults, each with a note saying what it means (§7). Without this, "how
 * much will I have in 10 years" silently plans for a 50-year-old, the default
 * start age. Meant to be called once per conversation, not per plan.
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
 * Deliberately partial: when the wording does not determine an instrument, the
 * module offers categories (`ACCOUNT_CATEGORIES`) rather than guess a tax
 * treatment.
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

// "Savings" (§8.1) can mean the act of saving or the account labelled Savings.
// The caller resolves that before building the intent; here, two named accounts
// stay two accounts, and each share is read against its source (see `claim()`).

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
 * Default growth rates, by instrument. Each is a guess the user did not make,
 * so each becomes a `default` entry in the ledger.
 *
 * Measured annual rates: the engine compounds each to exactly the stated
 * figure a year (`ARR.asMonthlyEffective()`). They match quick-start's, so a
 * plan built here and a quick-start profile agree about each account.
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
 * What each income is worth once the engine has withheld from it.
 *
 * Fund transfers take their percentage of take-home pay, so the residual
 * expense must be sized from take-home, not gross, or the plan is short by the
 * tax every month.
 *
 * Nothing here decides what is taxed. The household tax comes from the
 * engine's own `taxableBasis()` and `calculateYearlyIncomeTax()`, given the same
 * one-month package payroll builds (wages, benefits, pre-tax deferrals), so every
 * tax rule applies exactly as in a run. This function contributes only the
 * order, which mirrors `payroll-engine.js`: FICA per earner, the household tax
 * allocated across earners by wages, and on-arrival withholding on a pension or
 * Social Security.
 *
 * Take-home is gross less FICA, income tax and any pre-tax deferral. A 401(k)
 * leg takes gross; every other leg takes take-home. `tests/build-plan.mjs`
 * compares this estimate with what a real run books, to the cent.
 */
function withholdingFor(incomeAssets, deferrals, { filingAs, propertyTaxDeductionMax,
    startAge, birthYear, pensionWithholdingRate, socialSecurityWithholdingRate }) {
    const taxTable = new TaxTable(filingAs, propertyTaxDeductionMax);

    // One month of the household package, as payroll has it when it estimates
    // the household tax.
    const pkg = new FinancialPackage();
    const fica = new Map();
    const deferred = new Map();
    for (const a of incomeAssets) {
        const gross = new Currency(a.startCurrency.amount);
        if (a.instrument === Instrument.WORKING_INCOME) {
            // FICA applies to wages only, and is not reduced by a deferral.
            fica.set(a.displayName,
                taxTable.calculateFICATax(false, gross, TaxOwner.PRIMARY).fica().amount);
            pkg.employedIncome.add(gross);
            const d = deferrals.get(a.displayName) ?? { four01K: 0, ira: 0 };
            pkg.four01KContribution.add(new Currency(gross.amount * d.four01K));
            pkg.tradIRAContribution.add(new Currency(gross.amount * d.ira));
            deferred.set(a.displayName, gross.amount * (d.four01K + d.ira));
        } else if (a.instrument === Instrument.RETIREMENT_INCOME) {
            pkg.socialSecurityIncome.add(gross);
        } else if (a.instrument === Instrument.PENSION) {
            pkg.pensionIncome.add(gross);
        }
    }

    const { ordinaryTaxable } = taxableBasis(pkg, new User(startAge, birthYear),
        { annualise: true, taxTable });
    const householdMonthlyTax = taxTable.calculateYearlyIncomeTax(ordinaryTaxable).amount / 12;

    // Allocated across earners in proportion to wages, exactly as applyNetIncome does.
    const totalWorking = pkg.employedIncome.amount;

    const net = new Map();
    for (const a of incomeAssets) {
        const gross = a.startCurrency.amount;
        let takeHome;
        if (a.instrument === Instrument.WORKING_INCOME) {
            const incomeTax = totalWorking > 0 ? householdMonthlyTax * gross / totalWorking : 0;
            takeHome = gross - fica.get(a.displayName) - incomeTax - deferred.get(a.displayName);
        } else {
            // Benefits withhold on arrival at a flat rate (payroll-engine.js).
            const rate = a.instrument === Instrument.PENSION
                ? pensionWithholdingRate : socialSecurityWithholdingRate;
            takeHome = gross * (1 - rate);
        }
        net.set(a.displayName, Math.max(0, takeHome));
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
 * Where an asset came from. Kept separate from Provenance, which describes
 * fields: an asset and a field are different kinds of thing.
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
     * §6: a field with no declared provenance is a build error, not a blank —
     * an agent handed a number without its source reports the number.
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

    // §8: when the wording does not determine an instrument, ask.
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

    // §5.1: "how much in 10 years" sets the finish age from the start age, so
    // the derivation is declared in the ledger — it silently pins the age.
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

    // Refuse a plan that finishes exactly AT retirement. Finishing before it is
    // fine (the §5.1 case: accumulation only). Finishing at it declares a
    // drawdown phase with no months in it, because `reachesRetirement` below is
    // `>=`. Checked on the derived finish age, since that is how it happens in
    // practice: ten years from 55 lands on a retirement age of 65.
    if (finishAge === retirementAge) {
        throw new PlanRefusal(
            `The plan finishes at ${finishAge}, the same age it retires (${retirementAge}), `
            + 'so it would model a retirement with no months in it.',
            { question: `Project past retirement — say, to age ${finishAge + 20} — `
                + `or stop before it and ask only about the years up to ${retirementAge}?`,
              field: 'finishAge' });
    }

    const inflationRate = ledger.field('inflationRate',
        o.inflationRate ?? D.inflationRate,
        o.inflationRate != null ? Provenance.STATED : Provenance.DEFAULT);

    const filingAs = ledger.field('filingAs',
        o.filingAs != null ? asFilingStatus(o.filingAs, D.filingAs) : D.filingAs,
        o.filingAs != null ? Provenance.STATED : Provenance.DEFAULT);

    // §5.1: if the horizon crosses retirement, the plan includes a drawdown.
    // Say so.
    const reachesRetirement = finishAge > retirementAge;   // equality refused above
    if (reachesRetirement) {
        notes.push(`This plan runs past your retirement age (${retirementAge}), `
            + 'so it includes a drawdown: work income stops and expenses are '
            + 'paid from the accounts.');
    } else {
        // And if it stops before retirement, say that too: the plan answers a
        // narrower question than the user may think.
        notes.push(`This plan ends at ${finishAge}, before your retirement age `
            + `(${retirementAge}), so it models accumulation only — no drawdown, `
            + 'and nothing about whether the money lasts.');
    }

    // ── Dates ────────────────────────────────────────────────────
    //
    // The clock is read once, here, and the spec stores absolute months, so a
    // spec built today runs identically in 2030.
    const now = new Date();
    // A DateInt, not its integer form: ModelAsset.fromJSON reads `.year` and
    // `.month`, and an int makes the start date NaN.
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
            // Working income stops at retirement, or at the plan's end if that
            // comes first; otherwise the salary would extend the run past the
            // requested finish.
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

        // A stated balance is treated as all cost basis, and the ledger says
        // so. The default basis of zero would tax the whole balance as a
        // future gain.
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
    // Every income is routed 100%. "Save 10%" names one leg of a two-leg split;
    // the other 90% goes to spending, or it would vanish without a report.
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

    // Pre-tax deferrals: the share of each wage routed to a 401(k) or a
    // traditional IRA. Payroll takes these from GROSS pay, before tax.
    const deferrals = new Map();
    for (const s of splits) {
        const to = raw.find(a => a.displayName === s.to);
        const kind = to?.instrument === Instrument.FOUR_01K ? 'four01K'
            : to?.instrument === Instrument.IRA ? 'ira' : null;
        if (!kind) continue;
        const d = deferrals.get(s.from) ?? { four01K: 0, ira: 0 };
        d[kind] += s.percent / 100;
        deferrals.set(s.from, d);
    }

    const { net: netByIncome, householdMonthlyTax } =
        withholdingFor(incomeAssets, deferrals, { filingAs,
            propertyTaxDeductionMax: D.propertyTaxDeductionMax,
            startAge, birthYear,
            pensionWithholdingRate: D.pensionWithholdingRate,
            socialSecurityWithholdingRate: D.socialSecurityWithholdingRate });

    // ── Which account holds the money that gets spent ────────────
    //
    // A transfer INTO an expense does not pay it: an expense is funded by its
    // own outbound transfer naming the account that covers it (as in
    // quick-start). So the residual routes to a spending account, and the
    // expense draws from that account. (§5.3's diagram, Salary -> Living
    // Expenses 90%, is the right economics but not this engine's encoding.)
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

            // A structural asset (§9.2): created by a construction rule, not by
            // anything the user said, so the ledger records it as such.
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

            // Sized from take-home, not gross (see withholdingFor).
            const target = raw.find(a => a.displayName === RESIDUAL_EXPENSE_LABEL);
            target.startCurrency.amount -= netByIncome.get(label) * (residual / 100);

            outbound.push({
                toDisplayName: spendingAccount,
                monthlyMoveValue: residual, closeMoveValue: 0,
            });
        }

        // Merge legs with the same target: saving into the spending account
        // makes the 10% and the 90% one transfer. The ledger keeps the stated
        // split.
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

    // Every expense draws from the spending account, so the payer is recorded
    // in the spec rather than left to the funding backstop.
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
    // The accumulate phase triggers at startAge. A later trigger would leave
    // the first months with no transfers at all.
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
 * Which account income lands in and spending comes out of: a bank account,
 * else a brokerage. With neither, it falls back to the first account named —
 * even a 401(k) (see markdowns/code-issues-from-comments.md).
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
 * Which account pays the bills once work income stops: brokerage, then bank,
 * 401(k), IRA, and a Roth IRA last — the largest balance within a type. Putting
 * the Roth last avoids choosing a withdrawal strategy for the user (§13), but
 * a plan whose only account is a Roth is drawn from it.
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
