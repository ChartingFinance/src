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
 * Age from which retirement accounts may be drawn implicitly — both for
 * proportional tax allocation on tax-deferred accounts (`tax-allocation.js`)
 * and as secondary funding backstop failover (`FundTransfer.resolveFunding`).
 *
 * The statutory penalty-free withdrawal age is 59½ (IRC §72(t)), and the
 * engine ages users in whole years, so 60 is the conservative threshold that
 * never reaches funds still subject to the early-withdrawal penalty. Before
 * age 60, retirement accounts are protected from implicit draws; at age 60+,
 * once all everyday accounts are empty, backstop failover draws retirement
 * accounts in tax-efficient order: `IRA → 401K → Roth IRA`.
 */
export const global_deferred_allocation_age = 60;
