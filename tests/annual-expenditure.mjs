/**
 * annual-expenditure.mjs
 *
 * Guards js/annual-expenditure.js — "what did the household withdraw to meet
 * its obligations?"
 *
 * ── What makes these assertions non-vacuous ──────────────────────────
 *
 * This project's signature failure is a test that passes without comparing the
 * thing that changed. "The total is a number" would pass on every wrong answer
 * here, so the checks below are anchored on identities that only hold if the
 * classification is right:
 *
 *   PARTITION      every cash debit on a fundable account lands in exactly one
 *                  of spending / tax / internal. Recomputed independently here,
 *                  so a new EventType silently falling into the wrong bucket
 *                  changes a total that this test knows the value of.
 *
 *   CONSERVATION   spending draws + unfunded == the accrued obligation, for a
 *                  plan whose obligations are all monthly expenses. This is the
 *                  identity that says the funding side and the accrual side are
 *                  describing the same household. It is measured on a DEPLETED
 *                  plan on purpose: when nothing goes unfunded the identity
 *                  degenerates to "spending == expense" and stops testing the
 *                  shortfall half.
 *
 *   THE TAX SPLIT  a working year draws $0 of tax from accounts while paying
 *                  tens of thousands of it, because payroll withholding never
 *                  passes through an account; a retired year draws nearly all
 *                  of it. Both directions are asserted. One alone would pass on
 *                  a function that always returned zero, or always returned the
 *                  whole tax bill.
 *
 * Run: node tests/annual-expenditure.mjs   (from src/)
 */

// ── Pin the clock BEFORE quick-start.js is imported ──────────────────
// quick-start builds asset dates from `new Date()`, so an unpinned fixture is a
// different test every month. Same pin as snapshot.mjs and quickstart-golden.
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
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

import assert from 'node:assert/strict';

import { Portfolio } from '../js/portfolio.js';
import { chronometer_run } from '../js/chronometer.js';
import { simConfigFromGlobals } from '../js/globals.js';
import { quickStartProfiles, buildQuickStart } from '../js/quick-start.js';
import { EventType, EventKind } from '../js/sim-event.js';
import { InstrumentType } from '../js/instruments/instrument.js';
import { DateInt } from '../js/utils/date-int.js';
import { Metric } from '../js/metric.js';
import {
    expenditureOverWindow, trailingYearExpenditure, classify,
    Expenditure, EXPENDITURE_TREATMENT,
} from '../js/annual-expenditure.js';

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); failed++; }
}

const runs = new Map();
async function run(key) {
    if (runs.has(key)) return runs.get(key);
    const profile = quickStartProfiles.find((p) => p.key === key);
    assert.ok(profile, `no such profile: ${key}`);
    const built = buildQuickStart(profile);
    const portfolio = new Portfolio(built.assets, false, simConfigFromGlobals());
    if (built.lifeEvents) portfolio.lifeEvents = built.lifeEvents;
    await chronometer_run(portfolio);
    runs.set(key, portfolio);
    return portfolio;
}

/** Index of January of `year` within the plan. */
const janIndex = (portfolio, year) =>
    DateInt.diffMonths(portfolio.firstDateInt, DateInt.from(year, 1));

/** A calendar year's worth of the window, for comparison against year metrics. */
const calendarYear = (portfolio, year) => {
    const from = janIndex(portfolio, year);
    return expenditureOverWindow(portfolio, from, from + 11);
};

/** Sum a metric across every asset over an inclusive index window. */
function sumMetric(portfolio, metric, from, to) {
    let total = 0;
    for (const asset of portfolio.modelAssets) {
        const h = asset.getHistory(metric);
        if (!h) continue;
        for (let i = Math.max(0, from); i <= Math.min(to, h.length - 1); i++) {
            total += h[i] ?? 0;
        }
    }
    return total;
}

/** The largest single month of `metric` across an inclusive index window. */
function maxMonthly(portfolio, metric, from, to) {
    let peak = 0;
    for (let i = Math.max(0, from); i <= to; i++) {
        let month = 0;
        for (const asset of portfolio.modelAssets) {
            const h = asset.getHistory(metric);
            if (h && i < h.length) month += h[i] ?? 0;
        }
        peak = Math.max(peak, Math.abs(month));
    }
    return peak;
}

const near = (a, b, tol, what) =>
    assert.ok(Math.abs(a - b) <= tol,
        `${what}: expected ${b.toFixed(2)}, got ${a.toFixed(2)} (delta ${(a - b).toFixed(2)}, tol ${tol})`);

console.log('\nannual-expenditure\n');

// ── The declaration table is total ───────────────────────────────────

test('every EventType declares an expenditure treatment', () => {
    const missing = Object.values(EventType).filter((t) => !EXPENDITURE_TREATMENT[t]);
    assert.deepEqual(missing, [],
        `undeclared EventType(s): ${missing.join(', ')}. ` +
        `A draw of this kind would be silently dropped from the total.`);
});

test('an undeclared EventType throws rather than being dropped', () => {
    const bogus = {
        type: 'somethingNobodyDeclared',
        kind: EventKind.CASH,
        amount: { amount: -100 },
        traceId: null,
    };
    assert.throws(() => classify(bogus, []), /no expenditure treatment/,
        'an unknown event type must throw, not fall into a default bucket');
});

test('credits are never withdrawals', () => {
    const credit = {
        type: EventType.TRANSFER, kind: EventKind.CASH,
        amount: { amount: 5000 }, traceId: null,
    };
    assert.equal(classify(credit, []), null);
});

// ── The measured numbers ─────────────────────────────────────────────

const main = async () => {

    // ---- working year: mortgage principal and property tax are counted ----

    const dual = await run('dualIncome');

    test('dualIncome 2026 counts the FULL mortgage payment, not just interest', () => {
        const got = calendarYear(dual, 2026);
        const living   = -sumMetric(dual, Metric.LIVING_EXPENSE,   janIndex(dual, 2026), janIndex(dual, 2026) + 11);
        const mortgage = -sumMetric(dual, Metric.MORTGAGE_PAYMENT, janIndex(dual, 2026), janIndex(dual, 2026) + 11);
        const propTax  = -sumMetric(dual, Metric.PROPERTY_TAX,     janIndex(dual, 2026), janIndex(dual, 2026) + 11);

        // The accrual side. The draw differs from it only by escrow timing: the
        // property tax escrow is drawn on day 15, so the window catches eleven
        // of its twelve months in the plan's first calendar year.
        //
        // The tolerance is ONE month of escrow, taken as the largest single
        // month in the window rather than propTax/12 — the escrow inflates
        // month over month, so the average understates the missing one and the
        // assertion would fail by a few dollars for the wrong reason.
        const accrued = living + mortgage + propTax;
        const oneEscrowMonth = maxMonthly(dual, Metric.PROPERTY_TAX,
            janIndex(dual, 2026), janIndex(dual, 2026) + 11);
        assert.ok(oneEscrowMonth > 0, 'fixture no longer escrows property tax');
        near(got.spending, accrued, oneEscrowMonth + 1,
            'spending draws vs living + full mortgage payment + property tax');

        // And it is materially MORE than Metric.EXPENSE, which is the whole
        // reason this module exists rather than a 12-month sum of that metric.
        const expenseMetric = -sumMetric(dual, Metric.EXPENSE, janIndex(dual, 2026), janIndex(dual, 2026) + 11);
        assert.ok(got.spending > expenseMetric * 1.05,
            `expected the draw to exceed Metric.EXPENSE by >5% on a mortgaged plan; ` +
            `draw ${got.spending.toFixed(0)} vs EXPENSE ${expenseMetric.toFixed(0)}`);
    });

    test('a working year draws NO tax from accounts, though it pays plenty', () => {
        const got = calendarYear(dual, 2026);
        const from = janIndex(dual, 2026);
        const withheld = -sumMetric(dual, Metric.WITHHELD_INCOME_TAX, from, from + 11)
                       + -sumMetric(dual, Metric.WITHHELD_FICA_TAX,   from, from + 11);

        assert.ok(withheld > 30000,
            `fixture no longer withholds a material amount (${withheld.toFixed(0)}); ` +
            `this assertion would be vacuous`);
        assert.equal(got.tax, 0,
            `payroll withholding is deducted at source and never passes through an ` +
            `account, so no tax should be counted as withdrawn`);
    });

    // ---- retired year: nearly all tax IS a withdrawal ----

    const pre = await run('preRetirement');

    test('a retired year draws essentially the whole tax bill from accounts', () => {
        const got = calendarYear(pre, 2055);
        const from = janIndex(pre, 2055);
        const taxesPaid = -sumMetric(pre, Metric.TAXES, from, from + 11);

        assert.ok(taxesPaid > 40000, 'fixture no longer pays material tax');
        near(got.tax, taxesPaid, taxesPaid * 0.02,
            'tax drawn from accounts vs tax paid, in a year with no paycheck');
    });

    test('retirement account sweeps are NOT counted as spending', () => {
        const got = calendarYear(pre, 2055);
        const from = janIndex(pre, 2055);
        const living = -sumMetric(pre, Metric.LIVING_EXPENSE, from, from + 11);

        // 2055 sweeps ~$185k from 401K/IRA into the brokerage before the
        // brokerage funds anything. Those are debits on fundable accounts and a
        // naive sum would report them; spending must equal the obligation.
        near(got.spending, living, 1, 'spending vs living expense in a swept year');

        const allDebits = everyDebit(pre, from, from + 11);
        assert.ok(allDebits > got.total * 1.5,
            `expected internal movement to dominate; all debits ${allDebits.toFixed(0)} ` +
            `vs obligations ${got.total.toFixed(0)}. If these are close, the fixture ` +
            `no longer sweeps and this test has stopped discriminating.`);
    });

    // ---- a depleted plan reports what it could pay ----

    const early = await run('earlyCareer');

    test('a depleted plan: spending drawn + unfunded == the obligation accrued', () => {
        const got = calendarYear(early, 2060);
        const from = janIndex(early, 2060);
        const living = -sumMetric(early, Metric.LIVING_EXPENSE, from, from + 11);

        assert.ok(got.unfunded > 1000,
            `2060 no longer goes unfunded (${got.unfunded.toFixed(0)}); this test is ` +
            `about the shortfall half of the identity and needs a plan that fails`);
        assert.ok(got.spending < living * 0.9,
            'the draw should fall well short of the accrual on a depleted plan');
        near(got.spending + got.unfunded, living, 1,
            'drawn + unfunded vs accrued obligation');
    });

    // ---- the partition holds across every profile ----

    test('every cash debit on a fundable account is classified exactly once', () => {
        for (const [key, portfolio] of runs) {
            const last = lastIndex(portfolio);
            const got = expenditureOverWindow(portfolio, 0, last);
            const scopes = portfolio.traceScopes ?? [];

            let spending = 0, tax = 0, internal = 0, all = 0;
            for (const asset of portfolio.modelAssets) {
                if (!InstrumentType.isFundable(asset.instrument)) continue;
                for (const ev of (asset.events ?? [])) {
                    if (ev.kind !== EventKind.CASH || ev.amount.amount >= 0) continue;
                    all += -ev.amount.amount;
                    const b = classify(ev, scopes);
                    if (b === Expenditure.SPENDING) spending += -ev.amount.amount;
                    else if (b === Expenditure.TAX) tax += -ev.amount.amount;
                    else internal += -ev.amount.amount;
                }
            }
            near(spending + tax + internal, all, 0.01, `${key}: buckets vs all debits`);
            near(got.spending, spending, 0.01, `${key}: module spending vs recomputed`);
            near(got.tax, tax, 0.01, `${key}: module tax vs recomputed`);
        }
    });

    test('the accrual event types are unreachable, and stay that way', () => {
        // These are declared 'excluded' so that counting them cannot double the
        // housing line — the DRAW that settles them is a SETTLEMENT under a
        // MORTGAGE or CARRYING_COST scope and is counted there.
        //
        // Today those declarations are unreachable: the events are recorded on
        // the mortgage or the home, and neither is a fundable account, so they
        // never reach classify() at all. Mutating one of them to 'spending'
        // therefore changes NOTHING, which is why no assertion above catches it.
        //
        // That is a fact about the engine, not a hole in the tests, so it is
        // pinned here rather than left as a comment. If an accrual ever starts
        // landing on a fundable account, this fires and the reader learns that
        // those declarations have become load-bearing.
        const accruals = [
            EventType.MORTGAGE_PRINCIPAL, EventType.MORTGAGE_INTEREST,
            EventType.PROPERTY_TAX, EventType.PROPERTY_TAX_ESCROW,
            EventType.MAINTENANCE, EventType.INSURANCE,
            EventType.CAPITAL_GAIN_RECOGNIZED, EventType.CAPITAL_GAIN_EXCLUDED,
        ];
        const reachable = new Set();
        for (const portfolio of runs.values()) {
            for (const asset of portfolio.modelAssets) {
                if (!InstrumentType.isFundable(asset.instrument)) continue;
                for (const ev of (asset.events ?? [])) {
                    if (ev.kind !== EventKind.CASH || ev.amount.amount >= 0) continue;
                    if (accruals.includes(ev.type)) reachable.add(ev.type);
                }
            }
        }
        assert.deepEqual([...reachable], [],
            `accrual event type(s) now appear as cash debits on a fundable account: ` +
            `${[...reachable].join(', ')}. Their EXPENDITURE_TREATMENT is no longer ` +
            `dead code — check that 'excluded' is still the right answer, because ` +
            `the settling draw may now be counted twice.`);
    });

    // ---- window mechanics ----

    test('the trailing window is twelve months and reports when it is not', () => {
        const full = trailingYearExpenditure(pre, janIndex(pre, 2055) + 11);
        assert.equal(full.months, 12);
        assert.equal(full.complete, true);

        // Month 3 of the plan cannot have a trailing year behind it.
        const short = trailingYearExpenditure(pre, 2);
        assert.equal(short.months, 3);
        assert.equal(short.complete, false);
    });

    test('trailing twelve months equals the calendar year when aligned', () => {
        const from = janIndex(pre, 2050);
        near(trailingYearExpenditure(pre, from + 11).total,
             expenditureOverWindow(pre, from, from + 11).total, 0.01,
             'trailing window aligned to a calendar year');
    });

    test('a portfolio with no run yields zeroes, not a crash', () => {
        assert.deepEqual(trailingYearExpenditure(null, 10),
            { spending: 0, tax: 0, total: 0, unfunded: 0, months: 0, complete: false });
        assert.deepEqual(trailingYearExpenditure({}, 10),
            { spending: 0, tax: 0, total: 0, unfunded: 0, months: 0, complete: false });
    });

    console.log(`\n${'─'.repeat(55)}`);
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log(`${'─'.repeat(55)}\n`);
    process.exit(failed > 0 ? 1 : 0);
};

function lastIndex(portfolio) {
    let last = -1;
    for (const a of portfolio.modelAssets) {
        const h = a.getHistory('value');
        if (h && h.length - 1 > last) last = h.length - 1;
    }
    return last;
}

function everyDebit(portfolio, from, to) {
    const start = dateAt(portfolio, from), end = dateAt(portfolio, to);
    let total = 0;
    for (const asset of portfolio.modelAssets) {
        if (!InstrumentType.isFundable(asset.instrument)) continue;
        for (const ev of (asset.events ?? [])) {
            const when = ev.dateInt?.toInt();
            if (ev.kind !== EventKind.CASH || ev.amount.amount >= 0) continue;
            if (when == null || when < start || when > end) continue;
            total += -ev.amount.amount;
        }
    }
    return total;
}

function dateAt(portfolio, index) {
    const d = new DateInt(portfolio.firstDateInt.toInt());
    d.addMonths(index);
    return d.toInt();
}

await main();
