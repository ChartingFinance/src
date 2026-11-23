/**
 * return-schedule.js — loss years: a calendar year's typed price change for
 * stocks and for bonds (spec 18 §4).
 *
 * SimConfig `returnSchedule` is a list of `{ year, stocks, bonds }`. In that
 * calendar year:
 *
 *   STOCKS   every stock asset's return rate is `stocks` (−0.30 for a 30%
 *            fall). Those are the assets the simulated markets give stock
 *            returns: brokerage, IRA, Roth IRA and 401K. Growth compounds by
 *            the twelfth root, so an account with no money in or out and no
 *            dividend ends the year at exactly (1 + stocks) of its start.
 *            Dividends keep paying at the asset's own rate.
 *
 *   BONDS    every US Treasury and corporate bond account's PRICE changes by
 *            `bonds`, while its interest keeps paying at its own rate (as
 *            entered, under an outlook, or drawn). A bond is an income
 *            account: its rate is paid as interest, taxed as ordinary income.
 *            Setting the rate to a loss would book negative interest, which the
 *            tax engine would take off ordinary income. So the price change is
 *            a separate run-state field, `annualPriceChange`, which
 *            IncomeAccountBehavior books as growth, untaxed. A bank account
 *            shares that behaviour and is never touched.
 *
 * Nothing else moves a typed figure: a stock rate set here replaces the year's
 * draw, backtest year or outlook-shifted rate, with no dividend subtracted and
 * no shift added. The next January puts the stock rates back (or the year's
 * draw or backtest replaces them) and clears the bond price change.
 *
 * The page and MCP allow only losses; the engine takes any rate from −1 up.
 *
 * Headless engine module: no DOM, no globals.
 */

import { Instrument, InstrumentType } from './instruments/instrument.js';

/** The assets a schedule's `stocks` figure sets: the ones the markets draw as stocks. */
export function isScheduledStock(instrument) {
    return InstrumentType.isTaxableAccount(instrument)
        || InstrumentType.isIRA(instrument)
        || InstrumentType.isRothIRA(instrument)
        || InstrumentType.is401K(instrument);
}

/** The accounts a schedule's `bonds` figure moves the price of. Never a bank account. */
export function isScheduledBond(instrument) {
    return instrument === Instrument.US_BOND || instrument === Instrument.CORP_BOND;
}

const KEYS = Object.freeze(['year', 'stocks', 'bonds']);

/**
 * A schedule as makeSimConfig keeps it: frozen, each entry with all three
 * fields, `bonds` 0 when absent. Absent, null or empty is null: no loss years.
 * Throws on anything malformed, naming `returnSchedule`.
 */
export function normalizeReturnSchedule(value) {
    if (value === undefined || value === null) return null;
    const fail = (why) => { throw new Error(`makeSimConfig: returnSchedule ${why}.`); };
    if (!Array.isArray(value)) fail(`must be a list of { year, stocks, bonds }, got ${JSON.stringify(value)}`);
    if (!value.length) return null;
    const years = new Set();
    const rate = (name, v, year) => {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < -1) {
            fail(`${year}: ${name} must be a finite rate of −1 or more, got ${String(v)}`);
        }
        return v;
    };
    return Object.freeze(value.map((entry) => {
        if (!entry || typeof entry !== 'object') fail(`entry ${JSON.stringify(entry)} is not an object`);
        const unknown = Object.keys(entry).filter((k) => !KEYS.includes(k));
        if (unknown.length) fail(`entry has unknown field(s) ${unknown.join(', ')}; known: ${KEYS.join(', ')}`);
        if (!Number.isInteger(entry.year)) fail(`year must be an integer, got ${String(entry.year)}`);
        if (years.has(entry.year)) fail(`lists ${entry.year} twice`);
        years.add(entry.year);
        return Object.freeze({
            year: entry.year,
            stocks: rate('stocks', entry.stocks, entry.year),
            bonds: entry.bonds === undefined || entry.bonds === null ? 0 : rate('bonds', entry.bonds, entry.year),
        });
    }));
}

const NO_SCHEDULE = Object.freeze({ runStarts() {}, yearStarts() {}, runEnds() {} });

/**
 * One run's loss years.
 *
 * Make it after the portfolio's `initializeChron()` and before any draw or
 * backtest sets a rate: it keeps each stock asset's configured rate to put
 * back after a scheduled year. Then:
 *
 *   runStarts(firstDateInt, { ratesSet })  before the first month: a plan that
 *                                          starts on a scheduled January has
 *                                          it from its first month
 *   yearStarts(year, { ratesSet })         each New Year's Day, after the year's
 *                                          draw or backtest has set its rates
 *   runEnds()                              after the loop: the assets get their
 *                                          own rates back
 *
 * `ratesSet` says the caller has just set the year's stock rates (a draw or a
 * backtest year); otherwise a stock rate left by last year's schedule is put
 * back to the configured one.
 *
 * @param {ModelAsset[]} modelAssets  the run's assets
 * @param {ReadonlyArray|null} schedule  config.returnSchedule
 */
export function scheduleStepper(modelAssets, schedule) {
    if (!schedule) return NO_SCHEDULE;
    const byYear = new Map(schedule.map((e) => [e.year, e]));
    const stocks = modelAssets.filter((a) => isScheduledStock(a.instrument));
    const bonds = modelAssets.filter((a) => isScheduledBond(a.instrument));
    const configured = new Map(stocks.map((a) => [a, a.annualReturnRate.rate]));
    let applied = false;

    const restoreStocks = () => {
        for (const a of stocks) a.annualReturnRate.rate = configured.get(a);
    };

    const yearStarts = (year, { ratesSet = false } = {}) => {
        for (const b of bonds) b.annualPriceChange = 0;
        if (applied && !ratesSet) restoreStocks();
        const entry = byYear.get(year);
        applied = !!entry;
        if (!entry) return;
        for (const a of stocks) a.annualReturnRate.rate = entry.stocks;
        for (const b of bonds) b.annualPriceChange = entry.bonds;
    };

    return {
        runStarts(firstDateInt, opts) {
            if (firstDateInt.month === 1) yearStarts(firstDateInt.year, opts);
        },
        yearStarts,
        runEnds() {
            if (applied) restoreStocks();
            for (const b of bonds) b.annualPriceChange = 0;
            applied = false;
        },
    };
}
