/**
 * plan-dates.js — dates derived from the plan's ages.
 *
 * Spec 9 step 4a. Two classes derive a date from configuration in a getter:
 * `ModelAsset.effectiveFinishDateInt` and `ModelLifeEvent.triggerDateInt`.
 * Both computed `birthYear = currentYear - startAge` for themselves, in
 * `global_getFinishDateInt()` and `ageToDateInt()` respectively. One
 * derivation, written twice, is one derivation that can drift.
 *
 * These take the environment explicitly rather than reading module state,
 * which is the whole point of the step.
 *
 * ── The wall clock is gone (Spec 10 step 0) ──────────────────────────
 *
 * It used to be here, with a comment reserving its removal for a change of its
 * own. This is that change.
 *
 * `new Date().getFullYear()` inside a derived getter meant a plan's finish date
 * and every life-event trigger depended on when they were READ rather than on
 * anything the plan recorded. Measured on the midCareer profile, one frozen
 * spec replayed across a New Year:
 *
 *     clock        last month   months   events   ending net worth
 *     2026-08-31     2071-12      544    12,290       $4,661,966
 *     2027-01-01     2072-12      556    12,517       $4,914,376   +5.4%
 *     2028-06-15     2073-12      568    12,729       $5,100,596   +9.4%
 *
 * The plan grew a year longer every January, and nothing about the plan had
 * changed. Spec 10 makes this load-bearing rather than merely wrong: a
 * conversational plan supplies no age and no start date, so it is maximally
 * exposed, and a `build_plan` that emitted a spec whose meaning depended on
 * the day it was replayed would be a compiler with a nondeterministic target.
 *
 * The engine was already holding the correct anchor in the same constructor.
 * `Portfolio` derived the USER's birth year from `firstDateInt.year -
 * startAge` — a property of the plan, stable under any clock — while these
 * functions derived a SECOND birth year from the calendar. The two agreed only
 * for a plan built and read in the same year, and quick-start builds every
 * asset starting "now", which is why this survived so long: the divergence is
 * invisible until a spec is saved and replayed.
 *
 * So there is now one anchor, `config.birthYear`, attached by `Portfolio` and
 * read here. See `sim-config.js`.
 */

import { DateInt } from './utils/date-int.js';

/**
 * The plan's implied birth year: the year the user was `startAge` in.
 *
 * Throws rather than falling back. A fallback here would be the original bug
 * wearing a guard clause — silently correct in the fresh-plan case that hid it
 * for months, and silently wrong in exactly the replayed-spec case this exists
 * to fix. An unanchored config is a construction error, not a missing value.
 */
export function birthYearFor(env) {
    if (!Number.isInteger(env?.birthYear)) {
        throw new Error(
            'plan-dates: config has no birthYear. It is attached by the '
            + 'Portfolio constructor from the plan\'s first month; a config '
            + 'that reaches a derived date getter without one was never bound. '
            + `Got ${JSON.stringify(env?.birthYear)}.`,
        );
    }
    return env.birthYear;
}

/** December of the year the user turns `finishAge` — the plan's last month. */
export function finishDateIntFor(env) {
    return DateInt.from(birthYearFor(env) + env.finishAge, 12);
}

/** January of the year the user turns `triggerAge` — when a life event fires. */
export function ageToDateIntFor(env, triggerAge) {
    return DateInt.from(birthYearFor(env) + triggerAge, 1);
}
