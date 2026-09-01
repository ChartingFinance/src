/**
 * plan-anchoring.mjs
 *
 * A frozen plan means the same thing on every calendar day.
 *
 * ── Why this test exists ─────────────────────────────────────────────
 *
 * Spec 10 step 0. Until this change the engine derived a plan's birth year
 * from `new Date().getFullYear()` inside two derived getters —
 * `ModelAsset.effectiveFinishDateInt` and `ModelLifeEvent.triggerDateInt`. A
 * plan's finish date and every life-event trigger therefore depended on when
 * they were READ, not on anything the plan recorded. One frozen midCareer spec,
 * replayed:
 *
 *     2026-08-31 → last month 2071-12, 12,290 events, $4,661,966
 *     2027-01-01 → last month 2072-12, 12,517 events, $4,914,376   +5.4%
 *     2028-06-15 → last month 2073-12, 12,729 events, $5,100,596   +9.4%
 *
 * The plan grew twelve months every January and nobody had touched it.
 *
 * ── Why counts are not the assertion ─────────────────────────────────
 *
 * This project keeps rediscovering that a green check on an aggregate proves
 * very little: a one-letter memo rename once passed 162 assertions. Two runs can
 * agree on event COUNT and on ending balance while every event inside sits in a
 * different month — which is exactly what a date bug produces. So the
 * comparison is a digest of the full event stream, in order: asset, sequence,
 * type, month, metric, amount. Spec 10 §12 asks for event streams; this is
 * that, and it is why the test can catch a shift that conserves totals.
 *
 * ── Why the clock is faked rather than the spec re-dated ─────────────
 *
 * Re-dating the spec would test that different plans differ, which is not the
 * claim. The claim is that ONE plan is stable, so the plan is held fixed and
 * the world moves. Each clock gets a fresh module graph (cache-busted import),
 * because a module that captured a year at load time would otherwise hide the
 * very coupling under test.
 *
 * Usage:  node tests/plan-anchoring.mjs   (from src/)
 */

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_PLAN = pathToFileURL(resolve(HERE, '../js/mcp/run-plan.js')).href;
const PLAN_DATES = pathToFileURL(resolve(HERE, '../js/plan-dates.js')).href;

const RealDate = Date;
function setClock(iso) {
    const fixed = new RealDate(iso);
    globalThis.Date = class extends RealDate {
        constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(fixed); }
        static now() { return fixed.getTime(); }
    };
}
const restoreClock = () => { globalThis.Date = RealDate; };

/**
 * Every event in the run, in order, as comparable text.
 *
 * The month is in there deliberately: a plan whose anchor slipped produces the
 * same events against different months, which is precisely what a count or a
 * total cannot see.
 */
function eventStreamDigest(portfolio) {
    const lines = [];
    for (const asset of portfolio.modelAssets) {
        for (const e of asset.events ?? []) {
            lines.push([
                asset.displayName,
                e.seq,
                e.type,
                String(e.dateInt),
                e.metric ?? '',
                e.amount?.amount?.toFixed(6) ?? '',
            ].join('|'));
        }
    }
    return lines;
}

let failures = 0;
let total = 0;
const check = (label, fn) => {
    total++;
    try { fn(); console.log(`  ok   ${label}`); }
    catch (err) { failures++; console.log(`  FAIL ${label}\n       ${err.message}`); }
};

// ── Replay one frozen spec across a year boundary ────────────────────

setClock('2026-08-31T12:00:00Z');
const { planFromProfile } = await import(RUN_PLAN);
const FROZEN = JSON.parse(JSON.stringify(planFromProfile('midCareer')));
restoreClock();

const CLOCKS = [
    '2026-08-31T12:00:00Z',   // the day the spec was built
    '2026-12-31T12:00:00Z',   // last day of that year
    '2027-01-01T12:00:00Z',   // the boundary that used to move the plan
    '2028-06-15T12:00:00Z',   // two years on
    '2035-03-02T12:00:00Z',   // long after
];

const runs = [];
for (const clock of CLOCKS) {
    setClock(clock);
    const { runPlan } = await import(`${RUN_PLAN}?anchor=${encodeURIComponent(clock)}`);
    const { portfolio } = await runPlan(FROZEN);
    runs.push({
        clock: clock.slice(0, 10),
        last: String(portfolio.lastDateInt),
        first: String(portfolio.firstDateInt),
        birthYear: portfolio.config.birthYear,
        userBirthYear: portfolio.activeUser.birthYear,
        finish: Math.round(portfolio.finishValue().amount),
        digest: eventStreamDigest(portfolio),
    });
    restoreClock();
}

const base = runs[0];

console.log('plan-anchoring: one frozen midCareer spec under five clocks\n');
console.log(`  ${'clock'.padEnd(12)}${'last'.padEnd(9)}${'birthYr'.padStart(8)}` +
            `${'events'.padStart(9)}${'ending'.padStart(14)}`);
for (const r of runs) {
    console.log(`  ${r.clock.padEnd(12)}${r.last.padEnd(9)}${String(r.birthYear).padStart(8)}` +
                `${String(r.digest.length).padStart(9)}${r.finish.toLocaleString().padStart(14)}`);
}
console.log();

for (const r of runs.slice(1)) {
    check(`${r.clock}: last month unchanged`, () => assert.equal(r.last, base.last));
    check(`${r.clock}: ending net worth unchanged`, () => assert.equal(r.finish, base.finish));
    check(`${r.clock}: anchor unchanged`, () => assert.equal(r.birthYear, base.birthYear));

    // The real assertion. Compared element-wise so a failure names the first
    // event that moved instead of dumping twelve thousand lines.
    check(`${r.clock}: event stream identical (${base.digest.length} events)`, () => {
        assert.equal(r.digest.length, base.digest.length,
            `event count ${r.digest.length} vs ${base.digest.length}`);
        for (let i = 0; i < base.digest.length; i++) {
            if (r.digest[i] !== base.digest[i]) {
                assert.fail(`event ${i} diverged:\n         base: ${base.digest[i]}` +
                            `\n         this: ${r.digest[i]}`);
            }
        }
    });
}

// ── The engine's two birth years are now one ─────────────────────────
//
// `Portfolio` anchored `activeUser` from the plan while plan-dates.js anchored
// life events from the calendar. They agreed only for a plan read in the year
// it was built, which is why the divergence stayed invisible: quick-start
// starts every asset "now".
check('the User and the config share one anchor', () => {
    assert.equal(base.userBirthYear, base.birthYear);
});

check("the anchor is the plan's own first year minus startAge", () => {
    assert.equal(base.birthYear, Number(base.first.slice(0, 4)) - FROZEN.settings.startAge);
});

// ── An unanchored config throws rather than guessing ─────────────────
//
// The fallback IS the bug. A config that reaches a derived date getter without
// an anchor was never bound by a Portfolio, and silently substituting the
// current year is what let this survive for months.
const { birthYearFor } = await import(PLAN_DATES);

check('birthYearFor throws on an unanchored config', () => {
    assert.throws(() => birthYearFor({ startAge: 45 }), /no birthYear/);
});
check('birthYearFor throws on a null anchor', () => {
    assert.throws(() => birthYearFor({ startAge: 45, birthYear: null }), /no birthYear/);
});
check('birthYearFor returns the anchor when present', () => {
    assert.equal(birthYearFor({ startAge: 45, birthYear: 1981 }), 1981);
});

console.log('\n───────────────────────────────────────────────────────');
console.log(`  ${total - failures} passed, ${failures} failed`);
console.log('───────────────────────────────────────────────────────');
process.exit(failures ? 1 : 0);
