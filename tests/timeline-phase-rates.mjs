/**
 * timeline-phase-rates.mjs
 *
 * Each phase band on <finplan-timeline> is labelled with a growth rate or a
 * dash, never NaN.
 *
 * A rate needs the plotted value above $0 at both ends of the phase. A plan
 * that runs out of money crosses zero, and the annualised ratio is then
 * undefined: Math.pow gives NaN for most spans, and a finite figure with no
 * meaning when the phase is a whole number of years long. Below $0 at both
 * ends the ratio is positive but reads backwards. The nominal and real rates
 * share one rule, so a band shows both or neither.
 *
 * Like editing-anchor.mjs, this borrows the component's prototype instead of
 * constructing it (a custom element cannot be constructed under node), so the
 * assertions run against the shipped methods.
 *
 * Usage:  node tests/timeline-phase-rates.mjs   (from src/)
 */

import assert from 'node:assert/strict';

import { FinplanTimeline } from '../js/components/finplan-timeline.js';
import { LifeEvent } from '../js/life-event.js';
import { Metric } from '../js/metric.js';
import { DateInt } from '../js/utils/date-int.js';

let passed = 0, failed = 0;
function check(label, fn) {
    try { fn(); console.log(`  ✓ ${label}`); passed++; }
    catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

// The plan opens in January of the year its owner turns 45, retires at 58 and
// runs to 90, so the Retire band starts at month 156 and the run ends at 540.
const FIRST = DateInt.from(2026, 1);
const BIRTH_YEAR = 1981;
const RETIRE_IDX = 156, LAST_IDX = 540;

const inflation = (months) => Array.from({ length: months + 1 }, (_, i) => 1.0025 ** i);

function aTimeline(values, priceIndex = null) {
    const portfolio = {
        firstDateInt: FIRST,
        config: { birthYear: BIRTH_YEAR },
        modelAssets: [{ getHistory: () => values }],
        monthlyPriceIndex: priceIndex,
    };
    // Own data properties, not assignment: Lit's reactive accessors on the
    // prototype reach for update machinery a bare object does not have.
    const fields = {
        portfolio, metricName: Metric.VALUE, selectedIndex: 0,
        startAge: 45, retirementAge: 58, finishAge: 90,
        lifeEvents: [
            { type: LifeEvent.ACCUMULATE, displayName: 'Accumulate', triggerAge: 45 },
            { type: LifeEvent.RETIRE, displayName: 'Retire', triggerAge: 58 },
        ],
    };
    return Object.create(FinplanTimeline.prototype, Object.fromEntries(
        Object.entries(fields).map(([k, value]) => [k, { value, writable: true }])));
}

/** A history from `start` to `end` over `months`; only the two ends are read. */
function between(start, end, months) {
    return Array.from({ length: months + 1 }, (_, i) => start + (end - start) * (i / months));
}

console.log('\n-- A phase rate needs a value above $0 at both ends --\n');

check('a phase that doubles in ten years grows 7.2%/yr', () => {
    const rate = aTimeline(between(100_000, 200_000, 120))._computeCAGRBetween(0, 120);
    assert.ok(Math.abs(rate - (2 ** 0.1 - 1) * 100) < 1e-9, `got ${rate}`);
});

check('across a sign change there is no rate', () => {
    assert.equal(aTimeline(between(100_000, -50_000, 240))._computeCAGRBetween(0, 240), null);
});

check('nor over a whole number of years, where the ratio gives a finite figure', () => {
    // Math.pow(-0.5, 1) is -0.5, so a guard on the result being finite would
    // let -150%/yr through.
    assert.equal(aTimeline(between(100_000, -50_000, 12))._computeCAGRBetween(0, 12), null);
});

check('below $0 at both ends there is no rate', () => {
    // The ratio is 2: +100%/yr for a net worth that fell by $100k.
    assert.equal(aTimeline(between(-100_000, -200_000, 12))._computeCAGRBetween(0, 12), null);
});

check('nor from or to exactly $0', () => {
    assert.equal(aTimeline(between(0, 100_000, 120))._computeCAGRBetween(0, 120), null);
    assert.equal(aTimeline(between(100_000, 0, 120))._computeCAGRBetween(0, 120), null);
});

check('the real rate is the nominal one less inflation', () => {
    const real = aTimeline(between(100_000, 200_000, 120), inflation(120))
        ._computeRealCAGRBetween(0, 120);
    assert.ok(Math.abs(real - (2 ** 0.1 / 1.0025 ** 12 - 1) * 100) < 1e-9, `got ${real}`);
});

check('and it appears and disappears with the nominal rate', () => {
    const ends = [[100_000, 200_000], [100_000, -50_000], [-100_000, -200_000],
                  [-100_000, 50_000], [0, 100_000], [100_000, 0]];
    for (const [start, end] of ends) {
        for (const months of [12, 120, 240]) {
            const el = aTimeline(between(start, end, months), inflation(months));
            const nominal = el._computeCAGRBetween(0, months);
            const real = el._computeRealCAGRBetween(0, months);
            assert.equal(nominal === null, real === null,
                `${start} to ${end} over ${months} months: nominal ${nominal}, real ${real}`);
        }
    }
});

console.log('\n-- The bands draw a dash where there is no rate --\n');

// The bands' SVG as text. Lit's `svg` tag returns a TemplateResult whose
// `strings` and `values` interleave, and a value may be a result itself.
function textOf(part) {
    if (Array.isArray(part)) return part.map(textOf).join('');
    if (part?.strings && part?.values) {
        return part.strings.map((s, i) =>
            s + (i < part.values.length ? textOf(part.values[i]) : '')).join('');
    }
    return part == null || typeof part === 'symbol' ? '' : String(part);
}

/** The Accumulate and Retire bands' markup, rendered by the shipped code. */
function bands(values) {
    const el = aTimeline(values, inflation(LAST_IDX));
    const text = textOf(el._svgPhaseBands(el._phaseSpans, el._buildSeries()));
    const [accumulate, retire] = text.split('RETIRE');
    return { text, accumulate, retire };
}

check('a plan that runs out in retirement: a rate, then a dash', () => {
    // Grows 0.5% a month to retirement, then falls to -$200k by 90.
    const atRetirement = 500_000 * 1.005 ** RETIRE_IDX;
    const values = Array.from({ length: LAST_IDX + 1 }, (_, i) => i <= RETIRE_IDX
        ? 500_000 * 1.005 ** i
        : atRetirement + (-200_000 - atRetirement) * ((i - RETIRE_IDX) / (LAST_IDX - RETIRE_IDX)));
    const { text, accumulate, retire } = bands(values);

    assert.ok(!text.includes('NaN'), 'a band reads NaN');
    // 1.005^12 and (1.005 / 1.0025)^12: 6.17% and 3.03%.
    assert.ok(accumulate.includes('6.2%/yr<'), 'Accumulate lost its rate');
    assert.ok(accumulate.includes('3.0%/yr real'), 'Accumulate lost its real rate');
    assert.ok(!accumulate.includes('—'), 'Accumulate shows a dash beside its rate');
    assert.ok(retire.includes('</title>—</text>'), 'Retire has no dash');
    assert.ok(retire.includes('above $0'), 'the dash does not say why');
    assert.ok(!retire.includes('%/yr'), 'Retire still shows a rate');
});

check('a plan that runs out before retiring: a dash in both bands', () => {
    // From $500k to -$50k at retirement, then -$300k by 90. Below $0 at both
    // ends, the Retire ratio is 6, which would read +5.8%/yr.
    const values = Array.from({ length: LAST_IDX + 1 }, (_, i) => i <= RETIRE_IDX
        ? 500_000 + (-50_000 - 500_000) * (i / RETIRE_IDX)
        : -50_000 + (-300_000 + 50_000) * ((i - RETIRE_IDX) / (LAST_IDX - RETIRE_IDX)));
    const { text, accumulate, retire } = bands(values);

    assert.ok(!text.includes('%/yr'), 'a band still shows a rate');
    assert.ok(accumulate.includes('</title>—</text>'), 'Accumulate has no dash');
    assert.ok(retire.includes('</title>—</text>'), 'Retire has no dash');
});

console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
