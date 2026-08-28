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
 * ── The wall clock is deliberately still here ────────────────────────
 *
 * `new Date().getFullYear()` inside a derived getter means a plan's finish
 * date and every life-event trigger depend on when they are READ, not on
 * anything the plan records. Capturing the current year into the config would
 * fix that, and is tempting while touching exactly these two functions — but
 * it changes behaviour across a year boundary, which is a behavioural change
 * wearing a refactor's clothes. It belongs in its own change, against its own
 * predicted diff, not inside one whose entire verification story is "the
 * numbers did not move". Preserved verbatim from both originals for now.
 */

import { DateInt } from './utils/date-int.js';

/** The plan's implied birth year: the year the user was `startAge` in. */
export function birthYearFor(env) {
    return new Date().getFullYear() - env.startAge;
}

/** December of the year the user turns `finishAge` — the plan's last month. */
export function finishDateIntFor(env) {
    return DateInt.from(birthYearFor(env) + env.finishAge, 12);
}

/** January of the year the user turns `triggerAge` — when a life event fires. */
export function ageToDateIntFor(env, triggerAge) {
    return DateInt.from(birthYearFor(env) + triggerAge, 1);
}
