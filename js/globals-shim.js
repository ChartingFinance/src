/**
 * globals-shim.js
 *
 * Makes bundled npm packages available as window globals.
 * Required because Chart.js and lz-string are referenced as `Chart` and
 * `LZString` throughout the codebase without explicit imports.
 *
 * Imported once at the top of finplan-app.js.
 */

import { Chart, registerables } from 'chart.js';
import LZString from 'lz-string';

Chart.register(...registerables);

window.Chart = Chart;
window.LZString = LZString;