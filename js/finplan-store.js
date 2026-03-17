/**
 * finplan-store.js
 *
 * Reactive state store for the FinPlan UI.
 * Three pieces of global state drive the entire page:
 *
 *  1. selectedDateInt  — the "explore" date (year + month)
 *  2. activeMetric     — which metric the charts display
 *  3. assetVisibility  — per-asset boolean for chart line toggling
 *
 * Each mutator dispatches a CustomEvent so any component can subscribe:
 *   store.addEventListener('date-change', (e) => { ... });
 *
 * Exported as a singleton — import { store } from './finplan-store.js';
 */

import { DateInt } from './utils/date-int.js';
import { Metric } from './model-asset.js';

const MONTH_NAMES = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

class FinPlanStore extends EventTarget {

    #selectedDateInt;
    #activeMetric;
    #assetVisibility;
    #retirementDateInt;

    constructor() {
        super();
        this.#selectedDateInt = DateInt.today();
        this.#activeMetric = Metric.VALUE;
        this.#assetVisibility = new Map();
        this.#retirementDateInt = null;
    }

    // ── Configuration (call once at init) ──────────────────────

    /** Set the retirement DateInt so the store can determine phase. */
    setRetirementDate(dateInt) {
        this.#retirementDateInt = dateInt;
    }

    // ── Getters ────────────────────────────────────────────────

    get selectedDateInt() { return this.#selectedDateInt; }

    get selectedYear() { return this.#selectedDateInt.year; }

    get selectedMonth() { return this.#selectedDateInt.month; }

    get selectedMonthName() { return MONTH_NAMES[this.#selectedDateInt.month - 1]; }

    get activeMetric() { return this.#activeMetric; }

    /** True if the selected date is at or after retirement. */
    get isRetirementPhase() {
        if (!this.#retirementDateInt) return false;
        return !this.#selectedDateInt.isBefore(this.#retirementDateInt);
    }

    isAssetVisible(displayName) {
        const v = this.#assetVisibility.get(displayName);
        return v !== false;  // default visible
    }

    // ── Mutators (dispatch events) ─────────────────────────────

    setSelectedDate(dateInt) {
        this.#selectedDateInt = dateInt;
        this.dispatchEvent(new CustomEvent('date-change', {
            detail: { dateInt, year: dateInt.year, month: dateInt.month },
        }));
    }

    setSelectedYearMonth(year, month) {
        this.setSelectedDate(DateInt.from(year, month));
    }

    setActiveMetric(metricKey) {
        if (metricKey === this.#activeMetric) return;
        this.#activeMetric = metricKey;
        this.dispatchEvent(new CustomEvent('metric-change', {
            detail: { metric: metricKey },
        }));
    }

    toggleAssetVisibility(displayName) {
        const current = this.isAssetVisible(displayName);
        this.#assetVisibility.set(displayName, !current);
        this.dispatchEvent(new CustomEvent('visibility-change', {
            detail: { displayName, visible: !current },
        }));
    }

    setAssetVisible(displayName, visible) {
        this.#assetVisibility.set(displayName, visible);
        this.dispatchEvent(new CustomEvent('visibility-change', {
            detail: { displayName, visible },
        }));
    }
}

export const store = new FinPlanStore();
