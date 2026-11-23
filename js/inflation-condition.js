/**
 * inflation-condition.js — the Test Bench's "Higher inflation" condition.
 *
 * Stresses the plan's inflation assumption by +0% (As entered), +1%, or +2% a
 * year on top of the configured inflation rate.
 *
 *   - On the plan's own path (and calibrated simulated markets): raises
 *     `config.inflationRate` by the shift. Default-inflation expenses, health
 *     premiums, tax-bracket indexing, and the real-dollar deflator all read
 *     `config.inflationRate`, while nominal investment returns stay as entered.
 *   - In historical simulated markets: adds the same shift to each drawn year's
 *     CPI (expenses and deflator), mirroring how `returnShift` shifts historical
 *     stock/bond draws.
 *
 * Headless: no DOM, no globals, nothing it is given is changed.
 */

/** Allowed percentage-point shifts above the plan's configured inflation. */
export const INFLATION_SHIFTS = Object.freeze([0, 1, 2]);

/** Validate and normalize an inflation shift in whole percentage points (0, 1, or 2). */
export function inflationShiftOf(value = 0) {
    if (value == null) return 0;
    if (typeof value !== 'number' || !Number.isInteger(value) || !INFLATION_SHIFTS.includes(value)) {
        throw new Error(`Unknown inflation shift ${JSON.stringify(value)}; pass 0, 1, or 2 (percentage points).`);
    }
    return value;
}

/** Annual rate added to `config.inflationRate` and historical CPI draws (0, 0.01, or 0.02). */
export function inflationRateShift(percent = 0) {
    return inflationShiftOf(percent) / 100;
}

/** Control button label. */
export function inflationLabel(percent = 0) {
    const p = inflationShiftOf(percent);
    return p === 0 ? 'As entered' : `+${p}%`;
}

/** Compact chip label for the Conditions stack and Found under line, or null when neutral. */
export function inflationChip(percent = 0) {
    const p = inflationShiftOf(percent);
    return p === 0 ? null : `Inflation +${p}%`;
}

/** Clause for save notes and MCP headlines, or null when neutral. */
export function inflationClause(percent = 0) {
    const p = inflationShiftOf(percent);
    return p === 0 ? null : `inflation ${p}% a year higher than you entered`;
}

/** Short readout next to the control on the Test Bench. */
export function inflationLine(percent = 0) {
    const p = inflationShiftOf(percent);
    return p === 0 ? "Plan's own rate" : `+${p}%/yr on expenses & deflator`;
}

/** Sentence for MCP max_spending report, or null when neutral. */
export function inflationNote(percent = 0) {
    const p = inflationShiftOf(percent);
    return p === 0
        ? null
        : `Inflation runs ${p}% a year higher than entered on expenses, tax indexing, and today's-dollar deflation, in both the plan's own path and simulated markets.`;
}
