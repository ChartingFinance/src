/**
 * month-summary.mjs
 *
 * Guards js/month-summary.js — the numbers behind the Month Details section,
 * its AI summary, and (through metricAtIndex) the timeline's cursor chip.
 *
 * The code MOVED here from the timeline's month popover. The move itself was
 * verified in the browser, field by field against values recorded from the old
 * popover before it was deleted: 60 of 60 identical. This suite is what keeps
 * it that way, and it guards the one genuinely new rule — when the section may
 * say a $0 Tax line was "withheld at source".
 *
 * ── What makes these non-vacuous ─────────────────────────────────────
 *
 *   INDEPENDENT SUMS   the month figures are recomputed here from raw asset
 *                      histories, not by calling the helpers under test.
 *
 *   THE HOMEOWNER      the withheld figure must NOT be the TAXES rollup, which
 *                      carries property tax. housing-carrying-costs has property
 *                      tax and no paycheck: taxes are paid, nothing is withheld.
 *                      Asserting both halves means a switch to TAXES fails here.
 *
 *   BOTH DIRECTIONS    the hint is asserted ON in a working year and OFF in a
 *                      retired year and in a shortfall. One direction alone
 *                      passes on a constant.
 *
 * Run: node tests/month-summary.mjs   (from src/)
 */

// ── Pin the clock BEFORE quick-start.js is imported ──────────────────
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
const { quickStartProfiles, buildQuickStart } = await import('../js/quick-start.js');
const { Metric } = await import('../js/metric.js');
const { DateInt } = await import('../js/utils/date-int.js');
const { expenditureOverWindow } = await import('../js/annual-expenditure.js');
const { formatCurrency } = await import('../js/utils/html.js');
const { monthSummary, yearSummary, metricAtIndex, lastHistoryIndex, zeroTaxWasWithheld } = await import('../js/month-summary.js');
const { generateMonthDetailsSectionMarkdown, generatePortfolioSectionMarkdown } =
    await import('../js/generators/finplan-ai.js');
const { SNAPSHOT_FIXTURES } = await import('./tools/fixtures.mjs');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); failed++; }
}

async function runProfile(key) {
    const profile = quickStartProfiles.find((p) => p.key === key);
    G.global_reset();
    G.global_setUserStartAge(profile.startAge);
    G.global_setUserRetirementAge(profile.retirementAge);
    if (profile.finishAge != null) G.global_setUserFinishAge(profile.finishAge);
    if (profile.filingAs) G.global_setFilingAs(profile.filingAs);
    G.setActiveTaxTable(G.makeActiveTaxTable());
    const built = buildQuickStart(profile);
    const p = new Portfolio(built.assets, false, G.simConfigFromGlobals());
    p.lifeEvents = built.lifeEvents;
    await chronometer_run(p);
    return p;
}

async function runFixture(name) {
    const f = SNAPSHOT_FIXTURES.find((x) => x.name === name);
    assert.ok(f, `no fixture ${name}`);
    G.global_reset();
    const c = f.config ?? {};
    if (c.startAge != null) G.global_setUserStartAge(c.startAge);
    if (c.retirementAge != null) G.global_setUserRetirementAge(c.retirementAge);
    if (c.filingAs != null) G.global_setFilingAs(c.filingAs);
    G.setActiveTaxTable(G.makeActiveTaxTable());
    const built = f.build();
    const p = new Portfolio(built.assets, false, G.simConfigFromGlobals());
    if (built.lifeEvents) p.lifeEvents = built.lifeEvents;
    await chronometer_run(p);
    return p;
}

/** Straight off the raw histories — deliberately not metricAtIndex. */
function rawSum(p, metric, idx) {
    let t = 0;
    for (const a of p.modelAssets) {
        const h = a.getHistory(metric);
        if (h && idx < h.length) t += h[idx] ?? 0;
    }
    return t;
}

const near = (got, want, what, tol = 0.005) =>
    assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want}`);

const idxOf = (p, y, m) => DateInt.diffMonths(p.firstDateInt, DateInt.from(y, m));

// The shipped rule, not a copy of it: a local re-implementation here would pass
// no matter what the section and its summary actually do.
const hintOn = zeroTaxWasWithheld;

const mid = await runProfile('midCareer');
const early = await runProfile('earlyCareer');
const house = await runFixture('housing-carrying-costs');

// ── the month figures ────────────────────────────────────────────────

console.log('\n── The month figures are the asset histories, summed ──\n');

let withdrawalsLeftOut = 0, principalCounted = 0;

for (const [y, m] of [[2030, 6], [2055, 6]]) {
    test(`midCareer ${y}-${String(m).padStart(2, '0')}: every month field matches an independent sum`, () => {
        const s = monthSummary(mid, y, m);
        const idx = idxOf(mid, y, m);
        assert.ok(s, 'month unexpectedly outside the run');
        assert.equal(s.index, idx);
        const fields = {
            value: Metric.VALUE, taxes: Metric.TAXES, growth: Metric.GROWTH,
            netChange: Metric.NET_WORTH_CHANGE,
        };
        for (const [field, metric] of Object.entries(fields)) {
            assert.equal(s[field], rawSum(mid, metric, idx), `${field} disagrees with ${metric}`);
        }
        // Income received: the income leaves from outside the accounts, by name.
        const received = [Metric.EMPLOYED_INCOME, Metric.SELF_INCOME, Metric.SOCIAL_SECURITY_INCOME,
            Metric.PENSION_INCOME, Metric.INTEREST_INCOME, Metric.QUALIFIED_DIVIDEND, Metric.NON_QUALIFIED_DIVIDEND]
            .reduce((t, metric) => t + rawSum(mid, metric, idx), 0);
        near(s.income, received, 'income received', 1e-6);
        near(s.expense, rawSum(mid, Metric.EXPENSE, idx) + rawSum(mid, Metric.MORTGAGE_PRINCIPAL, idx), 'expenses', 1e-6);
        if (Math.abs(rawSum(mid, Metric.INCOME, idx) - received) > 1) withdrawalsLeftOut++;
        if (Math.abs(rawSum(mid, Metric.MORTGAGE_PRINCIPAL, idx)) > 1) principalCounted++;
        // Not all zero — a summary of nothing would match a sum of nothing.
        assert.ok(s.value > 100000, `net worth ${s.value} is implausibly small`);
        assert.notEqual(s.income, 0);
    });

    test(`midCareer ${y}-${String(m).padStart(2, '0')}: cash flow is income less expenses and taxes`, () => {
        const s = monthSummary(mid, y, m);
        const idx = idxOf(mid, y, m);
        near(s.cashFlow, s.income + s.expense + s.taxes, 'cash flow', 1e-6);
        // The same rule the per-account metric applies, to the cent.
        near(s.cashFlow, rawSum(mid, Metric.CASH_FLOW, idx), 'per-account Cash Flow', 0.05);
    });
}

test('the months tested leave withdrawals out of income and count mortgage principal', () => {
    // Without both, income received could be the whole Income metric, and
    // expenses could leave principal out, and the checks above would pass.
    assert.ok(withdrawalsLeftOut > 0, 'no month tested had a withdrawal in its Income');
    assert.ok(principalCounted > 0, 'no month tested paid mortgage principal');
});

test('the month\'s withdrawals are expenditureOverWindow over that month alone', () => {
    const idx = idxOf(mid, 2055, 6);
    assert.deepEqual(monthSummary(mid, 2055, 6).drawn, expenditureOverWindow(mid, idx, idx));
});

test('metricAtIndex is the independent sum too — the timeline chip reads it', () => {
    const idx = idxOf(mid, 2040, 3);
    assert.equal(metricAtIndex(mid, Metric.VALUE, idx), rawSum(mid, Metric.VALUE, idx));
    assert.equal(metricAtIndex(mid, Metric.VALUE, -1), 0);
    assert.equal(metricAtIndex(null, Metric.VALUE, idx), 0);
});

test('a month outside the run is null, not a row of zeroes', () => {
    const last = lastHistoryIndex(mid);
    const end = DateInt.from(mid.firstDateInt.year, mid.firstDateInt.month);
    end.addMonths(last + 1);
    assert.equal(monthSummary(mid, mid.firstDateInt.year - 1, 1), null, 'before the plan');
    assert.equal(monthSummary(mid, end.year, end.month), null, 'after the plan');
    assert.equal(monthSummary(null, 2030, 1), null, 'no portfolio');
    assert.ok(monthSummary(mid, mid.firstDateInt.year, mid.firstDateInt.month), 'first month is inside');
});

// ── the year figures ─────────────────────────────────────────────────

console.log('\n── The year is its months added up ──\n');

const firstYear = mid.firstDateInt.year;
const lastIdx = lastHistoryIndex(mid);
const lastDate = DateInt.from(mid.firstDateInt.year, mid.firstDateInt.month);
lastDate.addMonths(lastIdx);

/** The months of a year inside the run, as monthSummary sees them. */
function monthsOf(p, year) {
    const out = [];
    for (let m = 1; m <= 12; m++) { const s = monthSummary(p, year, m); if (s) out.push(s); }
    return out;
}

for (const year of [firstYear, 2030, 2055, lastDate.year]) {
    test(`midCareer ${year}: each flow is the sum of its months, by the month's definition`, () => {
        const y = yearSummary(mid, year);
        const months = monthsOf(mid, year);
        assert.ok(y, `${year} outside the run`);
        assert.equal(y.months, months.length);
        for (const field of ['income', 'expense', 'taxes', 'cashFlow', 'growth', 'netChange', 'withheldAtSource']) {
            near(y[field], months.reduce((t, s) => t + s[field], 0), `${year} ${field}`);
        }
        for (const field of ['spending', 'tax', 'total', 'unfunded']) {
            near(y.drawn[field], months.reduce((t, s) => t + s.drawn[field], 0), `${year} drawn.${field}`);
        }
        // Itemised the same way: each obligation is its months' sum.
        const byLabel = new Map();
        for (const s of months) for (const it of s.drawn.items) {
            byLabel.set(`${it.bucket}:${it.label}`, (byLabel.get(`${it.bucket}:${it.label}`) ?? 0) + it.amount);
        }
        assert.equal(y.drawn.items.length, byLabel.size, `${year} obligation count`);
        for (const it of y.drawn.items) near(it.amount, byLabel.get(`${it.bucket}:${it.label}`), `${year} ${it.label}`);

        // A balance is not summed: the year ends where its last month ends.
        const lastMonth = months[months.length - 1];
        assert.equal(y.value, lastMonth.value);
        assert.equal(y.lastMonth, y.firstMonth + months.length - 1);
    });
}

test('a full year begins where the December before it ended', () => {
    const y = yearSummary(mid, 2055);
    near(y.valueStart, monthSummary(mid, 2054, 12).value, '2055 opening balance', 0.01);
});

test('the plan\'s first year is short, and says so', () => {
    const y = yearSummary(mid, firstYear);
    assert.equal(y.firstMonth, mid.firstDateInt.month);
    assert.equal(y.months, 13 - mid.firstDateInt.month);
});

test('a year outside the run is null', () => {
    assert.equal(yearSummary(mid, firstYear - 1), null);
    assert.equal(yearSummary(mid, lastDate.year + 1), null);
    assert.equal(yearSummary(null, 2030), null);
});

test('the itemised withdrawals add up to the total, and name the obligations', () => {
    const y = yearSummary(mid, 2055);
    near(y.drawn.items.reduce((t, it) => t + it.amount, 0), y.drawn.total, '2055 items', 0.01);
    assert.ok(y.drawn.items.some((it) => it.label === 'Living Expenses' && it.bucket === 'spending'),
        `no Living Expenses item: ${y.drawn.items.map((it) => it.label).join(', ')}`);
    assert.ok(y.drawn.items.some((it) => it.bucket === 'tax'), 'a retired year draws no tax');
    for (const it of y.drawn.items) assert.ok(it.label && !it.label.startsWith('Pay '), `label "${it.label}"`);
});

// ── the tax year ─────────────────────────────────────────────────────

console.log('\n── The tax year is the year\'s record ──\n');

test('a settled year carries its TaxYear and both effective rates', () => {
    const y = yearSummary(mid, 2055);
    const t = mid.taxYears.find((r) => r.year === 2055);
    assert.equal(y.taxYear, t);
    assert.ok(t.federalTax > 0, 'nothing owed: the rates are vacuous');
    near(y.effectiveRateOnIncome, t.federalTax / y.totalIncome, 'rate on income', 1e-12);
    // On total income, not income received: a retired year's tax is owed on
    // its withdrawals too, and the two bases are far apart there.
    assert.ok(y.totalIncome - y.income > 1000, 'income received equals total income: the base is untested');
    near(y.effectiveRateOnAGI, t.federalTax / t.agi, 'rate on AGI', 1e-12);
    assert.notEqual(y.effectiveRateOnIncome.toFixed(4), y.effectiveRateOnAGI.toFixed(4),
        'income and AGI are equal, so the two rates cannot be told apart');
});

test('a year the plan never settled has no record and no rates', () => {
    // The fixture ends in a month other than December, or the last year settles.
    const y = yearSummary(mid, lastDate.year);
    const settled = mid.taxYears.some((r) => r.year === lastDate.year);
    assert.equal(y.taxYear !== null, settled);
    if (!settled) {
        assert.equal(y.effectiveRateOnIncome, null);
        assert.equal(y.effectiveRateOnAGI, null);
    }
});

// ── "withheld at source" ─────────────────────────────────────────────

console.log('\n── When a $0 Tax line may be explained as withheld ──\n');

test('working year: $0 drawn for tax, withholding real — the hint is ON for the month and the year', () => {
    for (const s of [monthSummary(mid, 2030, 6), yearSummary(mid, 2030)]) {
        assert.equal(s.drawn.tax, 0, 'a working year should draw no tax from accounts');
        assert.ok(s.withheldAtSource > 1000,
            `withheld $${s.withheldAtSource.toFixed(2)} — a salaried month withholds thousands`);
        assert.equal(hintOn(s), true);
    }
});

test('retired year: tax IS drawn — the hint is OFF', () => {
    const s = yearSummary(mid, 2055);
    assert.ok(s.drawn.tax > 1000, `retired tax drawn $${s.drawn.tax.toFixed(2)}`);
    assert.equal(hintOn(s), false);
});

test('a homeowner with property tax and no paycheck: taxes paid, NOTHING withheld', () => {
    // The reason withheldAtSource is not the TAXES rollup. Both halves matter:
    // without the first, this passes on a plan that simply pays no tax.
    const s = yearSummary(house, house.firstDateInt.year);
    assert.ok(s.taxes < -1000, `expected property tax in the TAXES rollup, found ${s.taxes.toFixed(2)}`);
    assert.equal(s.withheldAtSource, 0, 'property tax was reported as withheld');
});

test('a shortfall year never gets the hint, even with withholding and $0 drawn', () => {
    // earlyCareer 2029 is the case the unfunded clause exists for. The other
    // two conditions HOLD — tax withheld, nothing drawn — so without the clause
    // the section would explain a $0 as "withheld at source" in a year the plan
    // could not pay its bills. Asserting them first is what makes the clause,
    // and only the clause, responsible for the hint being off.
    const s = yearSummary(early, 2029);
    assert.ok(s, 'earlyCareer 2029 outside the run');
    assert.ok(s.drawn.unfunded > 1000, `expected a shortfall, unfunded $${s.drawn.unfunded.toFixed(2)}`);
    assert.equal(s.drawn.tax, 0, 'precondition: nothing drawn for tax');
    assert.ok(s.withheldAtSource > 1000, 'precondition: tax was withheld');
    assert.equal(hintOn(s), false);
});

test('in a plan\'s first year the withholding window matches the drawn window', () => {
    const s = yearSummary(mid, firstYear);
    let withheld = 0;
    for (let i = 0; i < s.months; i++) {
        withheld -= rawSum(mid, Metric.WITHHELD_INCOME_TAX, i) + rawSum(mid, Metric.WITHHELD_FICA_TAX, i);
    }
    assert.ok(withheld > 0, 'midCareer withholds from its first month');
    near(s.withheldAtSource, withheld, 'first-year withholding', 1e-6);
    assert.equal(s.drawn.months, s.months);
});

// ── the AI summary ───────────────────────────────────────────────────

console.log('\n── The ⚡ summary describes the same month and year ──\n');

const usd = (v) => formatCurrency(v);

test('working year: figures, the withheld sentence, and the heading', () => {
    const md = generateMonthDetailsSectionMarkdown(mid, 2030, 6, 'Jun 2030 · Age 49');
    const s = monthSummary(mid, 2030, 6);
    const y = yearSummary(mid, 2030);
    assert.ok(md.startsWith('# Month & Year Details — Jun 2030 · Age 49'), md.split('\n')[0]);
    assert.ok(md.includes(`| Net worth | ${usd(s.value)} | ${usd(y.value)} |`), 'net worth row missing or wrong');
    assert.ok(md.includes(`| **Total** | **${usd(s.drawn.total)}** | **${usd(y.drawn.total)}** |`), 'withdrawn total missing or wrong');
    assert.ok(md.includes('withheld at source'), 'working-year $0 left unexplained');
});

test('retired year: the tax year in the order shown, and no withheld sentence', () => {
    const md = generateMonthDetailsSectionMarkdown(mid, 2055, 6, 'Jun 2055 · Age 74');
    const t = mid.taxYears.find((r) => r.year === 2055);
    assert.ok(!md.includes('withheld at source'));
    const owed = md.indexOf(`| Federal taxes owed | ${usd(t.federalTax)} |`);
    const agi = md.indexOf(`| AGI | ${usd(t.agi)} |`);
    const magi = md.indexOf('| MAGI');
    const onIncome = md.indexOf('| Effective rate on total income');
    const onAGI = md.indexOf('| Effective rate on AGI |');
    assert.ok(owed > 0 && agi > owed && magi > agi && onIncome > magi && onAGI > onIncome,
        `tax-year rows missing or out of order: ${[owed, agi, magi, onIncome, onAGI]}`);
});

test('outside the run: says so rather than printing zeroes', () => {
    const md = generateMonthDetailsSectionMarkdown(mid, 1990, 1);
    assert.ok(md.includes('No simulation data for this month.'));
    assert.ok(!md.includes('| Net worth |'));
});

test('other sections point to Month & Year Details in page order', () => {
    // SECTIONS drives the "above / below this section" notes. The section sits
    // under the timeline, so Your Portfolio must list it above itself.
    const md = generatePortfolioSectionMarkdown(mid);
    assert.ok(/refer to: \*\*Your Timeline\*\*, \*\*Month & Year Details\*\* \(above/.test(md),
        'Your Portfolio does not name Month & Year Details as the section above it');
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);
process.exit(failed > 0 ? 1 : 0);
