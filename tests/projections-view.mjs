/**
 * projections-view.mjs — Spec 19 Phase 1: unified full-width Projections view.
 *
 * Covers buckets, grouped/drilled balance-sheet and flow datasets, real-dollar
 * deflation, Taxes reconciliation against FinancialPackage, KPI tiles (including
 * Retirement Tax Mix), inflection-point markers, and Chart.js config invariants.
 *
 * Usage:  node tests/projections-view.mjs   (from src/)
 */

import assert from 'node:assert/strict';
import './tools/localstorage-polyfill.js';
import { planFromProfile, runPlan, listProfiles } from '../js/mcp/run-plan.js';
import { buildPlan } from '../js/mcp/build-plan.js';
import { planOutcome } from '../js/outcome-summary.js';
import { detectIssues } from '../js/portfolio-issues.js';
import { Metric } from '../js/metric.js';
import { AssetGroup } from '../js/asset-groups.js';
import { DateInt } from '../js/utils/date-int.js';
import {
    ProjectionView, DollarMode,
    buildProjectionBuckets, dateIntToBucketIndex, bucketIndexToDateInt,
    getAvailableDrillGroups, buildProjectionMarkers, computeInvestableTaxMix,
    buildProjectionData, buildProjectionChartConfig,
} from '../js/projections-view.js';

let passed = 0, failed = 0;
async function check(label, fn) {
    try { await fn(); passed++; console.log(`  ok   ${label}`); }
    catch (err) { failed++; console.log(`  FAIL ${label}\n       ${err.message}`); }
}

function at(iso, fn) {
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
        constructor(...args) { return args.length ? new RealDate(...args) : new RealDate(iso); }
        static now() { return new RealDate(iso).getTime(); }
    };
    try { return fn(); } finally { globalThis.Date = RealDate; }
}

const PINNED = '2026-10-15T12:00:00Z';
const midSpec = at(PINNED, () => planFromProfile('midCareer'));
const earlySpec = at(PINNED, () => planFromProfile('earlyCareer'));
const retiredSpec = at(PINNED, () => planFromProfile('retired'));
const healthSpec = at(PINNED, () => buildPlan({
    settingsOverrides: { startAge: 60, retirementAge: 60, finishAge: 85 },
    income: [{ label: 'Pension', annual: 40000, kind: 'pension' }],
    accounts: [{ label: 'Checking', startingBalance: 30000 },
               { label: 'Brokerage', startingBalance: 900000 }],
    healthInsurance: [{ label: 'Marketplace Plan', premium: { monthly: 1000 },
        benchmark: { monthly: 950 }, estimatedIncome: 40000 }],
}).spec);

const midRun = await runPlan(midSpec);
const earlyRun = await runPlan(earlySpec);
const retiredRun = await runPlan(retiredSpec);
const healthRun = await runPlan(healthSpec);

console.log('projections-view');

// ── Buckets & click-to-date mapping ──────────────────────────────────

await check('buckets partition every month contiguously with zero gaps across all MonthsSpan horizons', () => {
    const spans = [
        { first: DateInt.from(2026, 10), last: DateInt.from(2028, 12), name: 'monthly (27m)' },
        { first: DateInt.from(2026, 10), last: DateInt.from(2031, 12), name: 'quarterly (63m)' },
        { first: DateInt.from(2026, 10), last: DateInt.from(2038, 12), name: 'semi-annual (147m)' },
        { first: DateInt.from(2026, 10), last: DateInt.from(2070, 12), name: 'annual (531m)' },
    ];
    for (const s of spans) {
        const fakePortfolio = { firstDateInt: s.first, lastDateInt: s.last, config: { birthYear: 1983 } };
        const buckets = buildProjectionBuckets(fakePortfolio);
        const totalMonths = DateInt.diffMonths(s.first, s.last) + 1;
        assert.ok(buckets.length > 0, s.name);
        assert.equal(buckets[0].fromMonth, 0, `${s.name}: starts at month 0`);
        assert.equal(buckets[buckets.length - 1].toMonth, totalMonths - 1, `${s.name}: ends at last month`);
        assert.equal(buckets[buckets.length - 1].dateInt.toInt(), s.last.toInt(), `${s.name}: final dateInt matches lastDateInt`);
        for (let i = 1; i < buckets.length; i++) {
            assert.equal(buckets[i].fromMonth, buckets[i - 1].toMonth + 1, `${s.name}: contiguous at ${i}`);
        }
        // Round-trip every bucket's dateInt back to its bucket index
        for (const b of buckets) {
            const d = bucketIndexToDateInt(buckets, b.index);
            assert.equal(dateIntToBucketIndex(d, fakePortfolio, buckets), b.index, `${s.name}: round-trip ${b.index}`);
        }
    }
});

// ── Net Worth composition, stack keys, and agreement with Outcome ────

await check('All groups Net Worth matches Outcome end/endReal, separates Mortgage below $0, and never double-stacks lines', async () => {
    for (const { key } of listProfiles()) {
        const spec = at(PINNED, () => planFromProfile(key));
        const { portfolio } = await runPlan(spec);
        const outcome = planOutcome(portfolio, detectIssues(portfolio));

        const nom = buildProjectionData(portfolio, { view: ProjectionView.NET_WORTH, dollarMode: DollarMode.NOMINAL });
        const real = buildProjectionData(portfolio, { view: ProjectionView.NET_WORTH, dollarMode: DollarMode.REAL });

        const lastNom = nom.totals[nom.totals.length - 1];
        const lastReal = real.totals[real.totals.length - 1];
        assert.ok(Math.abs(lastNom - outcome.end) < 1, `${key} nominal end ${lastNom} vs ${outcome.end}`);
        assert.ok(Math.abs(lastReal - outcome.endReal) < 1, `${key} real end ${lastReal} vs ${outcome.endReal}`);

        // Overlay line matches sum(bars) at every bucket and uses its own stack key
        assert.ok(nom.overlayLine, `${key}: has Net Worth overlay line`);
        assert.equal(nom.overlayLine.stack, 'overlay-networth');
        assert.ok(nom.companionLine, `${key}: nominal Net Worth has Today's $ companion line`);
        assert.equal(nom.companionLine.stack, 'overlay-real');
        for (const bar of nom.barDatasets) {
            assert.equal(bar.stack, 'bars');
        }
        for (let i = 0; i < nom.buckets.length; i++) {
            const barSum = nom.barDatasets.reduce((s, d) => s + d.data[i], 0);
            assert.ok(Math.abs(barSum - nom.overlayLine.data[i]) < 0.01, `${key} bucket ${i}`);
        }
        // Today's $ mode omits the redundant companion line
        assert.equal(real.companionLine, null);
    }

    // Mid Career has a Mortgage plotted negative below $0
    const midReal = buildProjectionData(midRun.portfolio, { view: ProjectionView.NET_WORTH, dollarMode: DollarMode.REAL });
    const mortgageBar = midReal.barDatasets.find((d) => d.label.toLowerCase().includes('mortgage'));
    assert.ok(mortgageBar, 'Mid Career should have a Mortgage bar');
    assert.ok(mortgageBar.data[0] < 0, 'Mortgage starts negative below $0');
});

// ── Drill-down & assetsOnly guard ────────────────────────────────────

await check('drill-down excludes flow groups on Net Worth and plots individual accounts cleanly', () => {
    const pills = getAvailableDrillGroups(midRun.portfolio, ProjectionView.NET_WORTH, Metric.VALUE);
    const keys = pills.map((p) => p.key);
    assert.ok(keys.includes(AssetGroup.ALL));
    assert.ok(keys.includes(AssetGroup.RETIREMENT));
    assert.ok(keys.includes(AssetGroup.REAL_ESTATE));
    assert.ok(!keys.includes(AssetGroup.INCOME), 'Income pill must not appear on Net Worth');
    assert.ok(!keys.includes(AssetGroup.EXPENSES), 'Expenses pill must not appear on Net Worth');

    // Drill into Retirement → individual accounts (401K, Roth IRA)
    const ret = buildProjectionData(midRun.portfolio, {
        view: ProjectionView.NET_WORTH,
        drillGroup: AssetGroup.RETIREMENT,
        dollarMode: DollarMode.REAL,
    });
    const retLabels = ret.barDatasets.map((d) => d.label);
    assert.ok(retLabels.some((l) => l.includes('401')), `expected 401K in ${retLabels}`);
    assert.ok(retLabels.some((l) => l.includes('Roth')), `expected Roth in ${retLabels}`);

    // Drill into Real Estate → Home + Mortgage + Home Equity overlay line
    const re = buildProjectionData(midRun.portfolio, {
        view: ProjectionView.NET_WORTH,
        drillGroup: AssetGroup.REAL_ESTATE,
        dollarMode: DollarMode.REAL,
    });
    assert.ok(re.barDatasets.some((d) => d.data[0] > 0), 'Home positive');
    assert.ok(re.barDatasets.some((d) => d.data[0] < 0), 'Mortgage negative');
    assert.equal(re.overlayLine?.label, 'Home Equity');

    // Trying to drill into Income on Net Worth falls back safely to All groups
    const invalid = buildProjectionData(midRun.portfolio, {
        view: ProjectionView.NET_WORTH,
        drillGroup: AssetGroup.INCOME,
        dollarMode: DollarMode.REAL,
    });
    assert.equal(invalid.drillGroup, AssetGroup.ALL);
});

// ── Taxes breakdown & reconciliation ─────────────────────────────────

await check('Taxes view reconciles lifetime nominal taxes with portfolio.total.totalTaxes() and omits empty layers', () => {
    const taxNom = buildProjectionData(midRun.portfolio, {
        view: ProjectionView.TAXES,
        dollarMode: DollarMode.NOMINAL,
    });
    const sumBuckets = taxNom.totals.reduce((a, b) => a + b, 0);
    const totalTaxesPaid = -midRun.portfolio.total.totalTaxes().amount;
    assert.ok(Math.abs(sumBuckets - totalTaxesPaid) < 1, `bucket sum ${sumBuckets} vs total ${totalTaxesPaid}`);
    assert.ok(taxNom.barDatasets.every((d) => d.data.some((v) => Math.abs(v) >= 0.5)), 'no all-zero tax layers');
    assert.equal(taxNom.drillGroups.length, 0, 'Taxes view has no asset drill pills');
    assert.equal(taxNom.kpis.length, 4);
    assert.equal(taxNom.kpis[0].label, 'Lifetime Taxes');
    assert.match(taxNom.kpis[3].value, /^\d+\.\d%$/);
});

// ── KPIs & Retirement Tax Mix ────────────────────────────────────────

await check('Retirement Tax Mix sums to 100% across Taxable, Tax-Deferred, and Tax-Free investable assets', () => {
    const nw = buildProjectionData(midRun.portfolio, { view: ProjectionView.NET_WORTH, dollarMode: DollarMode.REAL });
    assert.equal(nw.kpis.length, 4);
    assert.equal(nw.kpis[3].label, 'Retirement Tax Mix');
    const parts = nw.kpis[3].value.match(/(\d+)% \/ (\d+)% \/ (\d+)%/);
    assert.ok(parts, `unexpected mix format: ${nw.kpis[3].value}`);
    const sum = Number(parts[1]) + Number(parts[2]) + Number(parts[3]);
    assert.equal(sum, 100);

    // Direct helper excludes real estate and mortgage
    const mix = computeInvestableTaxMix(midRun.portfolio, 0);
    assert.ok(mix && mix.pctTaxable + mix.pctDeferred + mix.pctTaxFree === 100);
});

// ── Inflection-point markers ─────────────────────────────────────────

await check('milestone markers appear only when applicable, merge co-located labels, and track cursor', () => {
    const midBuckets = buildProjectionBuckets(midRun.portfolio);
    const midMarkers = buildProjectionMarkers(midRun.portfolio, midBuckets, {
        cursorDateInt: DateInt.from(2040, 6),
    });
    const midLabels = midMarkers.map((m) => m.label);
    assert.ok(midLabels.some((l) => l.includes('Retire')), `expected Retire in ${midLabels}`);
    assert.ok(midLabels.some((l) => l.includes('RMDs 73')), `expected RMDs 73 in ${midLabels}`);
    assert.ok(!midLabels.some((l) => l.includes('Medicare 65')), 'Mid Career has no pre-65 health plan');
    assert.ok(!midLabels.some((l) => l.includes('Runs out')), 'Mid Career does not run out');
    assert.equal(midMarkers[midMarkers.length - 1].label, '\u25BC');
    assert.equal(midMarkers[midMarkers.length - 1].isCursor, true);

    // Health-plan retiree gets Medicare 65 marker and no RMDs (no IRA/401K)
    const healthBuckets = buildProjectionBuckets(healthRun.portfolio);
    const healthMarkers = buildProjectionMarkers(healthRun.portfolio, healthBuckets);
    const healthLabels = healthMarkers.map((m) => m.label);
    assert.ok(healthLabels.some((l) => l.includes('Medicare 65')), `expected Medicare 65 in ${healthLabels}`);
    assert.ok(!healthLabels.some((l) => l.includes('RMDs')), 'healthSpec has no tax-deferred account');

    // Early Career runs out → gets Runs out marker
    const earlyBuckets = buildProjectionBuckets(earlyRun.portfolio);
    const earlyMarkers = buildProjectionMarkers(earlyRun.portfolio, earlyBuckets);
    assert.ok(earlyMarkers.some((m) => m.label.includes('Runs out')), 'Early Career should flag Runs out');
});

// ── Chart.js config, tooltip callbacks, click-to-jump, and empty state ──

await check('buildProjectionChartConfig wires index tooltip with total + today\'s $, click-to-jump, and empty state', () => {
    const nom = buildProjectionData(retiredRun.portfolio, {
        view: ProjectionView.NET_WORTH,
        dollarMode: DollarMode.NOMINAL,
    });
    let clicked = null;
    const cfg = buildProjectionChartConfig(nom, { onBucketClick: (b) => { clicked = b; } });

    assert.equal(cfg.options.maintainAspectRatio, false);
    assert.equal(cfg.options.interaction.mode, 'index');
    assert.equal(cfg.options.interaction.intersect, false);

    // Tooltip title includes label and age
    const title = cfg.options.plugins.tooltip.callbacks.title([{ dataIndex: 5 }]);
    assert.match(title, /Age \d+/);

    // Tooltip footer includes Net Worth and In today's $ in nominal mode
    const footer = cfg.options.plugins.tooltip.callbacks.footer([{ dataIndex: 5 }]);
    assert.equal(footer.length, 2);
    assert.match(footer[0], /^Net Worth: \$/);
    assert.match(footer[1], /^In today's \$: \$/);

    // Click handler resolves clicked bucket
    cfg.options.onClick({}, [{ index: 3 }], {});
    assert.equal(clicked, nom.buckets[3]);

    // Empty portfolio builds a safe empty-state config without throwing
    const emptyData = buildProjectionData(null);
    const emptyCfg = buildProjectionChartConfig(emptyData);
    assert.equal(emptyCfg.data.datasets.length, 0);
    assert.equal(emptyCfg.options.plugins.title.display, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
