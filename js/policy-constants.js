/**
 * policy-constants.js — fixed tax-policy parameters.
 *
 * Spec 9 step 6. Lifted out of globals.js unchanged. Neither is a setting:
 * both are `export const`, with no setter, no localStorage and nothing to
 * reset between runs. They sat among the settings only because globals.js had
 * become the default destination for anything module-scoped.
 *
 * Moving them is what lets `engines/tax-engine.js` and `tax-allocation.js`
 * stop importing the settings store — two of the last files keeping globals.js
 * inside the engine's import closure.
 *
 * globals.js re-exports both, so callers outside the engine are unaffected.
 */

/**
 * Federal withholding at the source of a traditional IRA / 401(K) distribution.
 *
 * 10% mirrors the default a custodian applies when the account holder makes no
 * election (Form W-4R). It governs ATTRIBUTION, not correctness: the monthly and
 * annual true-ups reconcile any over- or under-withholding in either direction,
 * so a wrong rate misplaces cash between accounts but never changes the
 * household's total tax.
 *
 * Flat by design. A rate derived from the resulting liability would reintroduce
 * the feedback loop that ExpenseEngine.calculateGrossWithdrawal's comments call
 * the "death-spiral": withholding raises taxable income, which raises the
 * liability, which raises the withholding.
 *
 * Roth is excluded — the guard is isTaxDeferred(), never "is a retirement
 * account". TAX_DEFERRED is exactly {IRA, FOUR_01K}.
 */
export const global_retirement_withholding_rate = 0.10;

/**
 * Age from which a tax-DEFERRED account may be allocated a share of the tax on
 * income it generated.
 *
 * The statutory threshold is 59.5, which this engine cannot express: the
 * simulated user ages in whole years on New Year's Day (Portfolio.applyYear
 * calls activeUser.addYears(1); activeUser.month is pinned to 0 and no caller
 * advances it). 60 is the conservative rounding — it never reaches money that
 * might still carry a 10% early-withdrawal penalty, at the cost of a few months
 * of attribution in the year the holder turns 59.5.
 *
 * This gates ATTRIBUTION ONLY. FUNDING_BACKSTOP_PRIORITY is deliberately
 * unchanged: the engine still never implicitly draws a retirement account to
 * pay an expense, a mortgage or an escrow at any age.
 */
export const global_deferred_allocation_age = 60;
