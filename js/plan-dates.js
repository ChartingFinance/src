/**
 * plan-dates.js — dates derived from the plan's ages.
 *
 * The one place a date is derived from an age: `ModelAsset.effectiveFinishDateInt`
 * and `ModelLifeEvent.triggerDateInt` both come through here, with the config
 * passed explicitly.
 *
 * The birth year is `config.birthYear`, which Portfolio sets from the plan's
 * own first month (see sim-config.js) — never the clock. A clock-derived birth
 * year would make a saved plan grow a year longer every January, with nothing
 * about the plan changed; tests/plan-anchoring.mjs guards this.
 */

import { DateInt } from './utils/date-int.js';

/**
 * The plan's implied birth year: the year the user was `startAge` in.
 *
 * Throws rather than falling back: an unanchored config is a construction
 * error, and a clock-based fallback would be silently wrong for a saved plan.
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

/**
 * The earliest age Social Security retirement benefits can be claimed: 42 U.S.C.
 * §402(a) entitles an insured worker who has attained age 62.
 */
export const SOCIAL_SECURITY_EARLIEST_AGE = 62;

/**
 * The first month Social Security can pay: January of the year the user turns
 * 62. The plan knows only a birth year, so this is the same January every other
 * age-derived date uses.
 */
export function earliestSocialSecurityDateIntFor(env) {
    return ageToDateIntFor(env, SOCIAL_SECURITY_EARLIEST_AGE);
}
