/**
 * policy-constants.js — fixed tax-policy parameters.
 *
 * Constants, not settings: no setter, no storage. Kept out of globals.js so
 * the engine never imports the settings store; globals.js re-exports them.
 */

/**
 * Federal withholding at the source of a traditional IRA / 401(K) distribution.
 *
 * 10%, the custodian default when the holder makes no election (Form W-4R).
 * It decides which account pays, not how much: the true-ups settle any
 * difference. Flat, because a rate derived from the liability would feed back
 * on itself (withholding is itself taxable income). Applies to tax-deferred
 * accounts only (IRA, 401(k)); never a Roth.
 */
export const global_retirement_withholding_rate = 0.10;

/**
 * Age from which a tax-DEFERRED account may be allocated a share of the tax on
 * income it generated.
 *
 * The statutory age is 59½, but the engine ages the user in whole years, so
 * 60 is the conservative rounding: it never reaches money that could still
 * carry the early-withdrawal penalty. This gates tax allocation only; the
 * engine never draws a retirement account implicitly to pay an expense.
 */
export const global_deferred_allocation_age = 60;
