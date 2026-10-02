/**
 * html.js
 *
 * Shared display helpers and color constants used across components,
 * charting, and the app shell.
 */

export const positiveBackgroundColor = '#76ad76';
export const negativeBackgroundColor = '#ad7676';

// ── Money ────────────────────────────────────────────────────────────
//
// Every amount of money shown in the app goes through one of these. Two forms:
//
//   compact   $4.7M · $287K · $950 · $1.2B   cards, chips, tiles, chart axes
//   full      $1,234,567                     anything read closely
//             $1,234.56   (cents: true)      the ledger and the spreadsheet
//
// Always a $, always grouped en-US whatever the browser's locale (these are
// US dollars), and a negative amount always takes the minus sign U+2212
// before the $: −$320K. An amount that rounds to zero shows no sign.
// tests/money-format.mjs pins the rules and fails on a private copy.

/** The minus sign every negative amount is written with. */
export const MINUS = '−';

function toAmount(amount) {
    const num = typeof amount === 'number' ? amount : parseFloat(amount);
    return Number.isFinite(num) ? num : 0;
}

const signed = (negative, body) => (negative && /[1-9]/.test(body) ? MINUS : '') + '$' + body;

// Built once. toLocaleString builds a formatter on every call, and these run
// thousands of times per plan (Currency.toString in log messages that are
// assembled whether or not the category is on): per call, it tripled the time
// of a whole run.
const WHOLE = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const CENTS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const TENTHS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * Compact currency for tight UI: $2.4M, $610K, $42.
 *
 * Each unit is chosen after rounding, so $999,600 reads $1.0M rather than
 * $1,000K.
 */
export function formatCompactCurrency(amount) {
    const num = toAmount(amount);
    const abs = Math.abs(num);
    let body;
    if (Math.round(abs) < 1000) body = String(Math.round(abs));
    else if (Math.round(abs / 1e3) < 1000) body = Math.round(abs / 1e3) + 'K';
    else if (Number((abs / 1e6).toFixed(1)) < 1000) body = (abs / 1e6).toFixed(1) + 'M';
    else body = TENTHS.format(Number((abs / 1e9).toFixed(1))) + 'B';
    return signed(num < 0, body);
}

/**
 * Full currency for detail views: $1,234,567, or $1,234.56 with cents.
 *
 * Whole dollars by default: over a multi-decade plan cents are noise. The
 * ledger and the spreadsheet keep cents, because they reconcile to the cent.
 */
export function formatCurrency(amount, { cents = false } = {}) {
    const num = toAmount(amount);
    const abs = Math.abs(num);
    const body = cents ? CENTS.format(abs) : WHOLE.format(Math.round(abs));
    return signed(num < 0, body);
}

/** A change: +$1,234 / −$1,234 / $0. Compact on request: +$12K. */
export function formatSignedCurrency(amount, { compact = false } = {}) {
    const s = compact ? formatCompactCurrency(amount) : formatCurrency(amount);
    return toAmount(amount) > 0 && /[1-9]/.test(s) ? '+' + s : s;
}

export const colorRange = ['#3366cc', '#dc3912', '#ff9900', '#109618', '#990099', '#3b3eac', '#0099c6','#dd4477', '#66aa00', '#b82e2e', '#316395', '#994499', '#22aa99', '#aaaa11','#6633cc', '#e67300', '#8b0707', '#329262', '#5574a6', '#651067'];
