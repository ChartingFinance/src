/**
 * loss-years.js — the Test Bench's loss-years condition (spec 18 §4), in
 * figures and in words.
 *
 * None, 1, 2 or 3 loss years, each with two figures the user types: how far
 * stock prices fall that year, and how far bond prices fall, as whole
 * percentages from 0 to 100. The years are the first calendar years from the
 * first January on or after both the retirement date and the plan's start, so
 * each runs a full twelve months. lossYearsSchedule() turns the figures into
 * the SimConfig `returnSchedule` the engine runs (return-schedule.js).
 *
 * Nothing moves a typed figure, and a condition is never saved with the plan.
 *
 * Headless: no DOM, no globals, nothing it is given is changed.
 */

import { MINUS } from './utils/html.js';

/** The most loss years the condition offers. */
export const MAX_LOSS_YEARS = 3;
/** What a new year's figures start at (decisions 7 and 13). */
export const NEW_STOCK_FIGURE = 20;
export const NEW_BOND_FIGURE = 0;

/** No loss years: the condition's neutral setting, with the figures a new year gets. */
export const NO_LOSS_YEARS = Object.freeze({
    count: 0,
    stocks: Object.freeze(Array(MAX_LOSS_YEARS).fill(NEW_STOCK_FIGURE)),
    bonds: Object.freeze(Array(MAX_LOSS_YEARS).fill(NEW_BOND_FIGURE)),
});

/**
 * The condition as one record, with only the figures in use: `{ count,
 * stocks, bonds }`, the lists `count` long. Absent is none.
 */
export function lossYearsOf(value = NO_LOSS_YEARS) {
    const count = value?.count ?? 0;
    if (!Number.isInteger(count) || count < 0 || count > MAX_LOSS_YEARS) {
        throw new Error(`Loss years must be 0 to ${MAX_LOSS_YEARS}, got ${String(count)}.`);
    }
    const figures = (list, name) => {
        const used = (list ?? []).slice(0, count);
        if (used.length !== count || !used.every(isLossFigure)) {
            throw new Error(`Each loss year's ${name} figure must be a whole percentage from 0 to 100.`);
        }
        return used;
    };
    return { count, stocks: figures(value.stocks, 'stock'), bonds: figures(value.bonds, 'bond') };
}

/** Whether a figure is a whole percentage from 0 to 100. */
export function isLossFigure(n) {
    return Number.isInteger(n) && n >= 0 && n <= 100;
}

/**
 * A figure as the user typed it. A leading minus is dropped, since the field
 * says the direction and people type "-30" for a 30% drop. A plus, a fraction,
 * anything above 100 or not a number is refused.
 *
 * @returns {{ value: number } | { error: string }}
 */
export function parseLossFigure(text) {
    const trimmed = String(text ?? '').trim().replace(/%$/, '').trim();
    const unsigned = trimmed.replace(/^[-−–]\s*/, '');
    if (!/^\d{1,3}$/.test(unsigned)) return { error: 'A loss is 0% to 100%' };
    const value = Number(unsigned);
    return value <= 100 ? { value } : { error: 'A loss is 0% to 100%' };
}

/** The first January on or after a date, as a year. */
function firstJanuaryFrom(dateInt) {
    return dateInt.month === 1 ? dateInt.year : dateInt.year + 1;
}

/**
 * The calendar years a condition's figures fall in, for one plan.
 *
 * @param {object} lossYears  lossYearsOf()'s record
 * @param {object} dates
 * @param {{year, month}|null} dates.retirement  the plan's retirement date; null starts from the plan
 * @param {{year, month}} dates.first  the plan's first month
 * @param {{year, month}} dates.last   the plan's last month
 * @returns {{ first: number, years: number[], inside: number[] }}  `years` one per
 *   figure; `inside` those the plan reaches
 */
export function lossYearsCalendar(lossYears, { retirement, first, last }) {
    const { count } = lossYearsOf(lossYears);
    const start = Math.max(firstJanuaryFrom(first), retirement ? firstJanuaryFrom(retirement) : -Infinity);
    const years = Array.from({ length: count }, (_, i) => start + i);
    return { first: start, years, inside: years.filter((y) => y <= last.year) };
}

/**
 * The engine's `returnSchedule` for a condition and a plan: one entry per loss
 * year the plan reaches, as rates (30 → −0.30). Null for none.
 */
export function lossYearsSchedule(lossYears, dates) {
    const record = lossYearsOf(lossYears);
    const { years, inside } = lossYearsCalendar(record, dates);
    // `|| 0`: a 0% figure is 0, not −0.
    const schedule = years.map((year, i) => ({ year, stocks: -record.stocks[i] / 100 || 0, bonds: -record.bonds[i] / 100 || 0 }))
        .filter((e) => inside.includes(e.year));
    return schedule.length ? schedule : null;
}

// ── Words ────────────────────────────────────────────────────────────

/** "−30%"; a flat year is "0%", with no sign. */
const pct = (n) => (n ? `${MINUS}${n}%` : '0%');
const NUMBER_WORDS = ['no', 'one', 'two', 'three'];

/** "30% in 2031 and 20% in 2032". */
function figuresIn(figures, years) {
    const parts = figures.map((f, i) => `${f}% in ${years[i]}`);
    return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
}

/**
 * The Found under chip: "2 loss years (−30%, −20%)", or with a bond figure
 * "2 loss years (stocks −30%, −20%; bonds −10%, 0%)". Null for none.
 */
export function lossYearsChip(lossYears) {
    const { count, stocks, bonds } = lossYearsOf(lossYears);
    if (!count) return null;
    const label = `${count} loss ${count === 1 ? 'year' : 'years'}`;
    return bonds.some((b) => b > 0)
        ? `${label} (stocks ${stocks.map(pct).join(', ')}; bonds ${bonds.map(pct).join(', ')})`
        : `${label} (${stocks.map(pct).join(', ')})`;
}

/**
 * The clause for a save note, a headline and the MCP report: "stock prices
 * falling 30% in 2031 and 20% in 2032, and bond prices 10% in 2031". Only the
 * years the plan reaches. Null when none apply.
 */
export function lossYearsClause(lossYears, dates) {
    const record = lossYearsOf(lossYears);
    const { years, inside } = lossYearsCalendar(record, dates);
    if (!inside.length) return null;
    const idx = inside.map((y) => years.indexOf(y));
    const stockText = figuresIn(idx.map((i) => record.stocks[i]), inside);
    const bonded = idx.filter((i) => record.bonds[i] > 0);
    const bondText = bonded.length ? `, and bond prices ${figuresIn(bonded.map((i) => record.bonds[i]), bonded.map((i) => years[i]))}` : '';
    return `stock prices falling ${stockText}${bondText}`;
}

/**
 * MCP's `lossYearsPercent` as the condition's record. Each entry is one year:
 * a whole number, the stock fall with bonds at 0, or `{ stocks, bonds }`.
 * Refuses more than three years, a negative, a fraction (0.3 meant as 30%
 * must not run as 0.3%) and anything above 100.
 */
export function lossYearsFromPercent(list = []) {
    if (!Array.isArray(list)) throw new Error('lossYearsPercent must be a list, for example [30, 20].');
    if (list.length > MAX_LOSS_YEARS) {
        throw new Error(`lossYearsPercent takes at most ${MAX_LOSS_YEARS} years, got ${list.length}.`);
    }
    const figure = (value, what, i) => {
        const where = `lossYearsPercent year ${i + 1}: the ${what} figure ${String(value)}`;
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${where} is not a number.`);
        if (!Number.isInteger(value)) throw new Error(`${where} is not a whole percentage. Pass 30 for a 30% fall, not 0.3.`);
        if (value < 0) throw new Error(`${where} is negative. A loss is a positive percentage: pass 30 for a 30% fall.`);
        if (value > 100) throw new Error(`${where} is above 100. A loss is at most 100%.`);
        return value;
    };
    const stocks = [], bonds = [];
    list.forEach((entry, i) => {
        if (typeof entry === 'number') {
            stocks.push(figure(entry, 'stock', i));
            bonds.push(0);
            return;
        }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new Error(`lossYearsPercent year ${i + 1} must be a number or { stocks, bonds }.`);
        }
        const unknown = Object.keys(entry).filter((k) => k !== 'stocks' && k !== 'bonds');
        if (unknown.length) {
            throw new Error(`lossYearsPercent year ${i + 1} has unknown field(s) ${unknown.join(', ')}; use stocks and bonds.`);
        }
        if (entry.stocks === undefined) throw new Error(`lossYearsPercent year ${i + 1} needs a stocks figure.`);
        stocks.push(figure(entry.stocks, 'stock', i));
        bonds.push(entry.bonds === undefined ? 0 : figure(entry.bonds, 'bond', i));
    });
    return { count: list.length, stocks, bonds };
}

/** History's worst stock falls, from the market data (1970–2025): the scale line. */
export const WORST_STOCK_FALLS = Object.freeze([
    Object.freeze({ years: 1, span: '2008', fall: 37.0 }),
    Object.freeze({ years: 2, span: '1973–1974', fall: 37.2 }),
    Object.freeze({ years: 3, span: '2000–2002', fall: 37.6 }),
]);

/**
 * The line under the control: what the figures do in this plan, the combined
 * stock fall, and the same scale line whatever is typed.
 */
export function lossYearsLine(lossYears, dates) {
    const record = lossYearsOf(lossYears);
    if (!record.count) return 'Returns as entered in every year of retirement.';
    const { first, years, inside } = lossYearsCalendar(record, dates);
    const scale = ' For scale: since 1970 stocks have never lost more than 37.6% over one, two or three years in a row.';
    if (!inside.length) {
        return `This plan ends before its first loss year, ${first}, so no year is changed.`;
    }
    const idx = inside.map((y) => years.indexOf(y));
    const stocks = idx.map((i) => record.stocks[i]);
    const combined = 1 - stocks.reduce((p, s) => p * (1 - s / 100), 1);
    const over = inside.length > 1 ? `, ${Math.round(combined * 100)}% over the ${NUMBER_WORDS[inside.length]} years` : '';
    const bonded = idx.filter((i) => record.bonds[i] > 0);
    const bondText = bonded.length
        ? ` Bond prices fall ${figuresIn(bonded.map((i) => record.bonds[i]), bonded.map((i) => years[i]))}, and bonds keep paying interest.`
        : ' Bonds keep their price.';
    const cut = inside.length < years.length
        ? ` The plan ends in ${dates.last.year}, so ${years.length - inside.length === 1 ? `${years[years.length - 1]} is` : 'the later years are'} not run.`
        : '';
    return `Stock prices fall ${figuresIn(stocks, inside)}${over}.${bondText}${cut}${scale}`;
}

/**
 * Compact one-line readout for the Test Bench UI, with the historical scale
 * sentence separated into a hover tooltip so the Conditions card stays scannable.
 *
 * @returns {{ text: string, scaleTip: string|null }}
 */
export function lossYearsSummary(lossYears, dates) {
    const record = lossYearsOf(lossYears);
    if (!record.count) return { text: '', scaleTip: null };
    const { first, years, inside } = lossYearsCalendar(record, dates);
    const scaleTip = 'For scale: since 1970 stocks have never lost more than 37.6% over one, two or three years in a row.';
    if (!inside.length) {
        return { text: `Plan ends before ${first} — no years affected`, scaleTip: null };
    }
    const idx = inside.map((y) => years.indexOf(y));
    const stocks = idx.map((i) => record.stocks[i]);
    const combined = Math.round((1 - stocks.reduce((p, s) => p * (1 - s / 100), 1)) * 100);
    const span = inside.length === 1 ? String(inside[0]) : `${inside[0]}–${inside[inside.length - 1]}`;
    const hasBonds = idx.some((i) => record.bonds[i] > 0);
    const parts = [
        span,
        inside.length > 1 ? `Combined stock fall: ${MINUS}${combined}%` : `Stock fall: ${MINUS}${stocks[0]}%`,
        hasBonds ? 'Bonds keep paying interest' : 'Bonds unchanged',
    ];
    if (inside.length < years.length) {
        parts.push(`ends in ${dates.last.year}`);
    }
    return { text: parts.join(' · '), scaleTip };
}
