/**
 * html.js
 *
 * Shared display helpers and color constants used across components,
 * charting, and the app shell.
 */

export const positiveBackgroundColor = '#76ad76';
export const negativeBackgroundColor = '#ad7676';

/**
 * Compact currency for tight UI: $2.4M, $610K, $42.
 * The single canonical implementation — do not copy into components.
 */
export function formatCompactCurrency(amount) {
    const num = typeof amount === 'number' ? amount : parseFloat(amount);
    if (isNaN(num)) return '$0';
    const abs = Math.abs(num);
    const sign = num < 0 ? '-' : '';
    if (abs >= 1000000) return sign + '$' + (abs / 1000000).toFixed(1) + 'M';
    if (abs >= 1000) return sign + '$' + Math.round(abs / 1000).toLocaleString() + 'K';
    return sign + '$' + Math.round(abs);
}

export const colorRange = ['#3366cc', '#dc3912', '#ff9900', '#109618', '#990099', '#3b3eac', '#0099c6','#dd4477', '#66aa00', '#b82e2e', '#316395', '#994499', '#22aa99', '#aaaa11','#6633cc', '#e67300', '#8b0707', '#329262', '#5574a6', '#651067'];
