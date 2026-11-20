/**
 * market-outlook.js — the Test Bench's market outlook (spec 17).
 *
 * Pessimistic and Optimistic run a test with every stock and bond return one
 * percentage point a year lower or higher than entered. Moderate is the plan
 * as entered. Nothing else moves: not inflation, wages, cash, real estate or
 * debt.
 *
 * ── How ──────────────────────────────────────────────────────────────
 *
 * A test makes one copy of the plan at its start (outlookPlan) and runs
 * everything on the copy: the plan's own path, the simulated markets, the
 * guardrails check, the routing test and the chart. In calibrated simulated
 * markets a draw is added to the asset's own rate, which the copy already
 * moved. In historical markets a draw replaces the rate, so mc-compute.js adds
 * returnShift() back to the stock and bond rates it draws, in that mode only.
 *
 * The plan itself is never changed. A saved result, or the plan max_spending
 * hands back, is built from the user's own rates.
 *
 * Headless: no DOM, no globals, nothing it is given is changed.
 */

import { Instrument, InstrumentType } from './instruments/instrument.js';
import { MINUS } from './utils/html.js';

export const MarketOutlook = Object.freeze({
    PESSIMISTIC: 'pessimistic',
    MODERATE: 'moderate',
    OPTIMISTIC: 'optimistic',
});

/** In the order the page offers them. */
export const OUTLOOKS = Object.freeze([MarketOutlook.PESSIMISTIC, MarketOutlook.MODERATE, MarketOutlook.OPTIMISTIC]);

const SHIFTS = Object.freeze({ pessimistic: -0.01, moderate: 0, optimistic: 0.01 });

/** Instrument names a saved plan may still carry (ModelAsset.fromJSON reads them the same way). */
const RENAMED = Object.freeze({
    home: Instrument.REAL_ESTATE,
    monthlySalary: Instrument.WORKING_INCOME,
    monthlySocialSecurity: Instrument.RETIREMENT_INCOME,
    monthlyPension: Instrument.RETIREMENT_INCOME,
});

/** Whether `value` names an outlook. */
export function isMarketOutlook(value) {
    return Object.hasOwn(SHIFTS, value);
}

/**
 * What an outlook adds to each stock and bond return, a year. Absent means
 * Moderate. A name that is not an outlook throws, so a typo never runs as
 * Moderate.
 */
export function returnShift(outlook = MarketOutlook.MODERATE) {
    if (!isMarketOutlook(outlook)) {
        throw new Error(`Unknown market outlook "${outlook}". Use one of: ${OUTLOOKS.join(', ')}.`);
    }
    return SHIFTS[outlook];
}

/**
 * The assets an outlook moves: the ones the simulated markets draw as stocks
 * (brokerage, IRA, Roth IRA, 401K) or as bonds (US Treasury), and corporate
 * bonds, which the markets never draw and which keep their moved rate in every
 * market. The one list every reader uses.
 */
export function isStockOrBond(instrument) {
    return InstrumentType.isTaxableAccount(instrument)
        || InstrumentType.isIRA(instrument)
        || InstrumentType.isRothIRA(instrument)
        || InstrumentType.is401K(instrument)
        || instrument === Instrument.US_BOND
        || instrument === Instrument.CORP_BOND;
}

/**
 * The plan's assets as plain objects, with each stock and bond return moved by
 * the outlook. Only the growth part moves: the dividend rate is left alone, so
 * growth and dividends together move by exactly the shift. At Moderate the
 * copy is exact.
 *
 * Assets arrive live, plain, or plain with a live rate inside, and a rate is
 * written `{ annualReturnRate }` by the app and `{ rate }` in a spec. Each is
 * serialized first, read either way, and written back the app's way, which is
 * the one ModelAsset.fromJSON reads first.
 */
export function outlookAssets(modelAssets, outlook) {
    const shift = returnShift(outlook);
    return modelAssets.map((asset) => {
        const plain = JSON.parse(JSON.stringify(asset));
        if (shift === 0) return plain;
        const instrument = RENAMED[plain.instrument] ?? plain.instrument;
        if (!isStockOrBond(instrument)) return plain;
        const rate = plain.annualReturnRate?.annualReturnRate ?? plain.annualReturnRate?.rate ?? 0;
        plain.annualReturnRate = { annualReturnRate: rate + shift };
        return plain;
    });
}

/**
 * A plan under an outlook: the same plan with its assets copied by
 * outlookAssets, and the outlook named on it, so every step of a test reads
 * the same one.
 */
export function outlookPlan(plan, outlook = MarketOutlook.MODERATE) {
    return { ...plan, modelAssets: outlookAssets(plan.modelAssets, outlook), outlook };
}

/** The outlook as the page labels it: "Pessimistic (−1%)", "Moderate", "Optimistic (+1%)". */
export function outlookLabel(outlook) {
    returnShift(outlook);
    if (outlook === MarketOutlook.PESSIMISTIC) return `Pessimistic (${MINUS}1%)`;
    if (outlook === MarketOutlook.OPTIMISTIC) return 'Optimistic (+1%)';
    return 'Moderate';
}

/** "stock and bond returns 1% a year higher than you entered", or null at Moderate. */
export function outlookClause(outlook) {
    const shift = returnShift(outlook);
    if (shift === 0) return null;
    return `stock and bond returns 1% a year ${shift > 0 ? 'higher' : 'lower'} than you entered`;
}

/** The line that goes with a result under an outlook, or null at Moderate. */
export function outlookNote(outlook) {
    const clause = outlookClause(outlook);
    if (!clause) return null;
    return `Every figure assumes ${clause}. Inflation, wages and cash stay as entered.`;
}
