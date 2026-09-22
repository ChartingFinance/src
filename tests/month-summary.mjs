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
const { trailingYearExpenditure } = await import('../js/annual-expenditure.js');
const { monthSummary, metricAtIndex, lastHistoryIndex, zeroTaxWasWithheld } = await import('../js/month-summary.js');
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

const idxOf = (p, y, m) => DateInt.diffMonths(p.firstDateInt, DateInt.from(y, m));

// The shipped rule, not a copy of it: a local re-implementation here would pass
// no matter what the section and its summary actually do.
const hintOn = zeroTaxWasWithheld;

const mid = await runProfile('midCareer');
const early = await runProfile('earlyCareer');
const house = await runFixture('housing-carrying-costs');

// ── the month figures ────────────────────────────────────────────────

console.log('\n── The month figures are the asset histories, summed ──\n');

for (const [y, m] of [[2030, 6], [2055, 6]]) {
    test(`midCareer ${y}-${String(m).padStart(2, '0')}: every month field matches an independent sum`, () => {
        const s = monthSummary(mid, y, m);
        const idx = idxOf(mid, y, m);
        assert.ok(s, 'month unexpectedly outside the run');
        assert.equal(s.index, idx);
        const fields = {
            value: Metric.VALUE, income: Metric.INCOME, expense: Metric.EXPENSE,
            taxes: Metric.TAXES, cashFlow: Metric.CASH_FLOW, growth: Metric.GROWTH,
            netChange: Metric.NET_WORTH_CHANGE,
        };
        for (const [field, metric] of Object.entries(fields)) {
            assert.equal(s[field], rawSum(mid, metric, idx), `${field} disagrees with ${metric}`);
        }
        // Not all zero — a summary of nothing would match a sum of nothing.
        assert.ok(s.value > 100000, `net worth ${s.value} is implausibly small`);
        assert.notEqual(s.income, 0);
    });
}

test('the trailing-year block is trailingYearExpenditure at the same index', () => {
    const s = monthSummary(mid, 2055, 6);
    assert.deepEqual(s.drawn, trailingYearExpenditure(mid, idxOf(mid, 2055, 6)));
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

// ── "withheld at source" ─────────────────────────────────────────────

console.log('\n── When a $0 Tax line may be explained as withheld ──\n');

test('working year: $0 drawn for tax, withholding real — the hint is ON', () => {
    const s = monthSummary(mid, 2030, 6);
    assert.equal(s.drawn.tax, 0, 'a working year should draw no tax from accounts');
    assert.ok(s.withheldAtSource > 1000,
        `withheld $${s.withheldAtSource.toFixed(2)} — a salaried year withholds thousands`);
    assert.equal(hintOn(s), true);
});

test('retired year: tax IS drawn — the hint is OFF', () => {
    const s = monthSummary(mid, 2055, 6);
    assert.ok(s.drawn.tax > 1000, `retired tax drawn $${s.drawn.tax.toFixed(2)}`);
    assert.equal(hintOn(s), false);
});

test('a homeowner with property tax and no paycheck: taxes paid, NOTHING withheld', () => {
    // The reason withheldAtSource is not the TAXES rollup. Both halves matter:
    // without the first, this passes on a plan that simply pays no tax.
    const idx = lastHistoryIndex(house);
    const y = house.firstDateInt.year + Math.floor((house.firstDateInt.month - 1 + idx) / 12);
    const m = ((house.firstDateInt.month - 1 + idx) % 12) + 1;
    const s = monthSummary(house, y, m);
    let taxesInWindow = 0;
    for (let i = idx - s.drawn.months + 1; i <= idx; i++) taxesInWindow += rawSum(house, Metric.TAXES, i);
    assert.ok(taxesInWindow < -1000,
        `expected property tax in the TAXES rollup, found ${taxesInWindow.toFixed(2)}`);
    assert.equal(s.withheldAtSource, 0, 'property tax was reported as withheld');
});

test('a shortfall year never gets the hint, even with withholding and $0 drawn', () => {
    // earlyCareer Dec 2029 is the case the unfunded clause exists for. The
    // other two conditions HOLD — tax withheld, nothing drawn — so without the
    // clause the section would explain a $0 as "withheld at source" in a year
    // the plan could not pay its bills. Asserting them first is what makes the
    // clause, and only the clause, responsible for the hint being off.
    const s = monthSummary(early, 2029, 12);
    assert.ok(s, 'earlyCareer 2029 outside the run');
    assert.ok(s.drawn.unfunded > 1000, `expected a shortfall, unfunded $${s.drawn.unfunded.toFixed(2)}`);
    assert.equal(s.drawn.tax, 0, 'precondition: nothing drawn for tax');
    assert.ok(s.withheldAtSource > 1000, 'precondition: tax was withheld');
    assert.equal(hintOn(s), false);
});

test('in a plan\'s first months the withholding window matches the drawn window', () => {
    const f = mid.firstDateInt;
    const third = DateInt.from(f.year, f.month); third.addMonths(2);
    const s = monthSummary(mid, third.year, third.month);
    assert.equal(s.drawn.months, 3);
    let withheld = 0;
    for (let i = 0; i <= 2; i++) {
        withheld -= rawSum(mid, Metric.WITHHELD_INCOME_TAX, i) + rawSum(mid, Metric.WITHHELD_FICA_TAX, i);
    }
    assert.ok(withheld > 0, 'midCareer withholds from its first month');
    assert.equal(s.withheldAtSource, withheld);
});

// ── the AI summary ───────────────────────────────────────────────────

console.log('\n── The ⚡ summary describes the same month ──\n');

test('working year: figures, the withheld sentence, and the heading', () => {
    const md = generateMonthDetailsSectionMarkdown(mid, 2030, 6, 'Jun 2030 · Age 49');
    const s = monthSummary(mid, 2030, 6);
    assert.ok(md.startsWith('# Month Details — Jun 2030 · Age 49'), md.split('\n')[0]);
    const usd = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);
    assert.ok(md.includes(`| Net worth | ${usd(s.value)} |`), 'net worth row missing or wrong');
    assert.ok(md.includes(`| **Total** | **${usd(s.drawn.total)}** |`), 'trailing total missing or wrong');
    assert.ok(md.includes('withheld at source'), 'working-year $0 left unexplained');
});

test('retired year: no withheld sentence', () => {
    const md = generateMonthDetailsSectionMarkdown(mid, 2055, 6, 'Jun 2055 · Age 74');
    assert.ok(!md.includes('withheld at source'));
});

test('outside the run: says so rather than printing zeroes', () => {
    const md = generateMonthDetailsSectionMarkdown(mid, 1990, 1);
    assert.ok(md.includes('No simulation data for this month.'));
    assert.ok(!md.includes('| Net worth |'));
});

test('other sections point to Month Details in page order', () => {
    // SECTIONS drives the "above / below this section" notes. The section sits
    // under the timeline, so Your Portfolio must list it above itself.
    const md = generatePortfolioSectionMarkdown(mid);
    assert.ok(/refer to: \*\*Your Timeline\*\*, \*\*Month Details\*\* \(above/.test(md),
        'Your Portfolio does not name Month Details as the section above it');
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);
process.exit(failed > 0 ? 1 : 0);
