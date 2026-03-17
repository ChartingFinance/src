/**
 * <finplan-timeline>
 *
 * Timeline component with:
 *  - Year/month dropdown controls (coral styled)
 *  - Proportionally positioned phase dots (Accumulate + Retire)
 *  - Phase summary bar with selected phase name, age range, OPEN/CLOSE/CAGR
 *  - Pure HTML/CSS rendering (no Chart.js canvas)
 *
 * Phase visibility rules:
 *  - If currentAge < retirementAge → both Accumulate and Retire visible
 *  - If currentAge >= retirementAge → only Retire visible
 *
 * Timeline span:
 *  - S = min(startAge - 1, portfolio start age)
 *  - F = finishAge + 1
 *  - Dots positioned proportionally within S–F
 */

import { LitElement, html } from 'lit';
import { store } from '../finplan-store.js';
import { LifeEvent, LifeEventType } from '../life-event.js';

const MONTH_NAMES = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

class FinplanTimeline extends LitElement {

    static properties = {
        startAge:       { type: Number, attribute: 'start-age' },
        retirementAge:  { type: Number, attribute: 'retirement-age' },
        finishAge:      { type: Number, attribute: 'finish-age' },
        lifeEvents:     { type: Array },
        portfolio:      { type: Object },
        metricName:     { type: String },
        selectedYear:   { type: Number },
        selectedMonth:  { type: Number },
        selectedIndex:  { type: Number },
    };

    createRenderRoot() { return this; }

    constructor() {
        super();
        this.startAge = 30;
        this.retirementAge = 67;
        this.finishAge = 85;
        this.lifeEvents = [];
        this.portfolio = null;
        this.metricName = 'value';
        this.selectedYear = new Date().getFullYear();
        this.selectedMonth = new Date().getMonth() + 1;
        this.selectedIndex = 0;

        this._onDateChange = (e) => {
            this.selectedYear = e.detail.year;
            this.selectedMonth = e.detail.month;
        };
    }

    connectedCallback() {
        super.connectedCallback();
        store.addEventListener('date-change', this._onDateChange);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        store.removeEventListener('date-change', this._onDateChange);
    }

    // ── Timeline span ───────────────────────────────────────────────

    get _timelineStartAge() {
        let sAge = this.startAge - 1;
        if (this.portfolio?.firstDateInt) {
            const birthYear = new Date().getFullYear() - this.startAge;
            const portfolioStartAge = this.portfolio.firstDateInt.year - birthYear;
            sAge = Math.min(sAge, portfolioStartAge);
        }
        return sAge;
    }

    get _timelineFinishAge() {
        return this.finishAge + 1;
    }

    // ── Visible events (only Accumulate + Retire) ───────────────────

    get _visibleEvents() {
        const events = this.lifeEvents.filter(ev =>
            ev.type === LifeEvent.ACCUMULATE || ev.type === LifeEvent.RETIRE
        );
        // If current age >= retirement age, hide Accumulate
        if (this.startAge >= this.retirementAge) {
            return events.filter(ev => ev.type !== LifeEvent.ACCUMULATE);
        }
        return events;
    }

    // ── Selected date as fractional age ────────────────────────────

    get _selectedAge() {
        const birthYear = new Date().getFullYear() - this.startAge;
        return (this.selectedYear - birthYear) + (this.selectedMonth - 1) / 12;
    }

    // ── Selected phase helpers ──────────────────────────────────────

    get selectedEvent() {
        const visible = this._visibleEvents;
        return visible[this.selectedIndex] ?? visible[0] ?? null;
    }

    get nextEvent() {
        return this._visibleEvents[this.selectedIndex + 1] ?? null;
    }

    _phaseLabel() {
        return this.selectedEvent?.displayName ?? '';
    }

    _phaseSpan() {
        const ev = this.selectedEvent;
        if (!ev) return '';
        const phaseStart = ev.triggerAge;
        const phaseEnd = this.nextEvent ? this.nextEvent.triggerAge : this.finishAge;
        return `Ages ${phaseStart}\u2013${phaseEnd}`;
    }

    _phaseColor() {
        return this.selectedEvent ? LifeEventType.color(this.selectedEvent.type) : '#888780';
    }

    _phaseColorAccent() {
        return this.selectedEvent ? LifeEventType.colorAccent(this.selectedEvent.type) : '#5F5E5A';
    }

    // ── Metric computation ──────────────────────────────────────────

    _computeMetricAtIndex(index) {
        if (!this.portfolio) return 0;
        let total = 0;
        for (const asset of this.portfolio.modelAssets) {
            const history = asset.getHistory(this.metricName);
            if (history?.length > 0) {
                const i = index < 0 ? history.length + index : index;
                total += history[i] ?? 0;
            }
        }
        return total;
    }

    _computeCAGR(startVal, finishVal) {
        if (!this.portfolio || !startVal || startVal === 0) return 0;
        const start = this.portfolio.firstDateInt;
        const finish = this.portfolio.lastDateInt;
        if (!start || !finish) return 0;
        const years = (finish.year + (finish.month - 1) / 12) - (start.year + (start.month - 1) / 12);
        if (years <= 0) return 0;
        return (Math.pow(finishVal / startVal, 1 / years) - 1) * 100;
    }

    _formatCurrency(amount) {
        const val = parseFloat(amount) || 0;
        const abs = Math.abs(val);
        const sign = val < 0 ? '-' : '';
        if (abs >= 1000000) return `${sign}$${(abs / 1000000).toFixed(1)}M`;
        if (abs >= 1000) return `${sign}$${Math.round(abs / 1000).toLocaleString()}K`;
        return `${sign}$${Math.round(abs)}`;
    }

    // ── Render ─────────────────────────────────────────────────────

    render() {
        const years = this._getYearRange();
        const visible = this._visibleEvents;
        const startMetric = this._computeMetricAtIndex(0);
        const finishMetric = this._computeMetricAtIndex(-1);
        const cagr = this._computeCAGR(startMetric, finishMetric);
        const cagrPositive = cagr >= 0;

        const sAge = this._timelineStartAge;
        const fAge = this._timelineFinishAge;

        return html`
            <!-- Controls row -->
            <div class="flex items-center justify-center gap-3 mb-2">
                <select class="text-xs px-2 py-1.5 rounded-lg cursor-pointer outline-none font-medium"
                    style="background: #FAECE7; color: #993C1D; border: 1px solid #F5D0C5;"
                    @change=${this._onYearChange}>
                    ${years.map(y => html`
                        <option value=${y} ?selected=${y === this.selectedYear}>${y}</option>
                    `)}
                </select>

                <select class="text-xs px-2 py-1.5 rounded-lg cursor-pointer outline-none font-medium"
                    style="background: #FAECE7; color: #993C1D; border: 1px solid #F5D0C5;"
                    @change=${this._onMonthChange}>
                    ${MONTH_NAMES.map((name, i) => html`
                        <option value=${i + 1} ?selected=${(i + 1) === this.selectedMonth}>${name}</option>
                    `)}
                </select>
            </div>

            <!-- Cursor indicator above timeline -->
            ${this._renderCursorRow(visible, sAge, fAge)}

            <!-- Timeline bar (flex with proportional spacers) -->
            ${this._renderTimelineBar(visible, sAge, fAge)}

            <!-- Timeline labels (flex with proportional spacers) -->
            ${this._renderTimelineLabels(visible, sAge, fAge)}

            <!-- Phase summary bar -->
            <div class="flex items-center gap-3 px-3 py-2 rounded-xl"
                style="background: ${this._phaseColor()}12;">

                <span class="text-xs font-medium px-2.5 py-1 rounded-full cursor-pointer hover:opacity-80 transition-opacity flex items-center gap-1"
                    style="background: ${this._phaseColor()}25; color: ${this._phaseColorAccent()};"
                    title="Edit life event"
                    @click=${this._onEditSelectedEvent}>
                    ${this._phaseLabel()}
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" style="opacity: 0.7;">
                        <path d="M9.1 1.2L10.8 2.9 3.6 10.1 1.2 10.8 1.9 8.4z"/>
                    </svg>
                </span>

                <span class="text-xs text-gray-500">${this._phaseSpan()}</span>

                <span class="flex-1"></span>

                <span class="text-xs font-medium text-gray-400 tracking-wide">OPEN</span>
                <span class="text-sm font-semibold text-gray-800">${this._formatCurrency(startMetric)}</span>

                <span class="text-gray-200">|</span>

                <span class="text-xs font-medium text-gray-400 tracking-wide">CLOSE</span>
                <span class="text-sm font-semibold text-gray-800">${this._formatCurrency(finishMetric)}</span>

                <span class="text-gray-200">|</span>

                <span class="text-xs font-medium text-gray-400 tracking-wide">CAGR</span>
                <span class="text-sm font-semibold ${cagrPositive ? 'text-green-600' : 'text-pink-600'}">
                    ${cagr.toFixed(1)}%
                </span>
            </div>
        `;
    }

    // ── Timeline bar/label rendering ────────────────────────────────

    /**
     * Build an ordered list of anchor points: S, visible events, cursor, F.
     * Each point has { age, type: 'start'|'event'|'cursor'|'finish', event?, eventIndex? }.
     * The cursor is inserted at the selected year/month position, clamped to [sAge, fAge].
     */
    _buildAnchorPoints(visible, sAge, fAge) {
        const points = [{ age: sAge, type: 'start' }];
        visible.forEach((ev, i) => {
            points.push({ age: ev.triggerAge, type: 'event', event: ev, eventIndex: i });
        });
        points.push({ age: fAge, type: 'finish' });

        // Insert cursor — clamp to timeline range
        const cursorAge = Math.max(sAge, Math.min(fAge, this._selectedAge));
        const cursor = { age: cursorAge, type: 'cursor' };

        // Find insertion index (after any point with age <= cursorAge)
        let insertAt = 1; // after S
        for (let i = 1; i < points.length; i++) {
            if (points[i].age <= cursorAge) insertAt = i + 1;
            else break;
        }
        points.splice(insertAt, 0, cursor);

        return points;
    }

    _renderCursorRow(visible, sAge, fAge) {
        const points = this._buildAnchorPoints(visible, sAge, fAge);
        const items = [];

        for (let p = 0; p < points.length; p++) {
            const pt = points[p];

            if (pt.type === 'cursor') {
                items.push(html`
                    <div class="flex flex-col items-center flex-shrink-0" style="width: 0;">
                        <span style="font-size: 10px; font-weight: 700; color: #111827; line-height: 1;
                                     white-space: nowrap;">${MONTH_NAMES[this.selectedMonth - 1]} ${this.selectedYear}</span>
                        <span style="font-size: 12px; font-weight: 900; color: #111827; line-height: 1; margin-top: -1px;">&#9660;</span>
                    </div>
                `);
            } else if (pt.type === 'start' || pt.type === 'finish') {
                items.push(html`<div class="flex-shrink-0" style="width: 24px;"></div>`);
            } else {
                items.push(html`<div class="flex-shrink-0" style="width: 24px;"></div>`);
            }

            if (p < points.length - 1) {
                const gap = points[p + 1].age - pt.age;
                items.push(html`<div style="flex: ${gap};"></div>`);
            }
        }

        return html`
            <div class="flex items-end px-2" style="height: 28px;">
                ${items}
            </div>
        `;
    }

    _renderTimelineBar(visible, sAge, fAge) {
        const points = this._buildAnchorPoints(visible, sAge, fAge);
        const items = [];

        for (let p = 0; p < points.length; p++) {
            const pt = points[p];

            // Render the anchor/dot
            if (pt.type === 'start' || pt.type === 'finish') {
                const letter = pt.type === 'start' ? 'S' : 'F';
                items.push(html`
                    <div class="flex flex-col items-center flex-shrink-0" style="width: 24px;">
                        <div class="rounded text-xs font-bold flex items-center justify-center"
                            style="width: 20px; height: 20px; background: rgba(0,0,0,0.08); color: rgba(0,0,0,0.4);">${letter}</div>
                    </div>
                `);
            } else if (pt.type === 'cursor') {
                // Cursor rendered in its own row above; just a zero-width spacer here
                items.push(html`<div class="flex-shrink-0" style="width: 0;"></div>`);
            } else {
                const ev = pt.event;
                const i = pt.eventIndex;
                const isSelected = this.selectedIndex === i;
                const size = isSelected ? 16 : 12;
                items.push(html`
                    <div class="flex flex-col items-center flex-shrink-0 cursor-pointer" style="width: 24px;"
                         title="${ev.displayName}"
                         @click=${() => this._onSelectPhase(i)}>
                        <div class="rounded-full transition-all"
                            style="width: ${size}px; height: ${size}px;
                                   background: ${LifeEventType.color(ev.type)};
                                   border: 2px solid ${LifeEventType.colorAccent(ev.type)};
                                   ${isSelected ? 'box-shadow: 0 0 0 3px white, 0 0 0 5px ' + LifeEventType.color(ev.type) + ';' : ''}">
                        </div>
                    </div>
                `);
            }

            // Spacer to next point (proportional flex)
            if (p < points.length - 1) {
                const gap = points[p + 1].age - pt.age;
                // Determine segment color: if this segment falls within a phase, color it
                const phaseEvent = this._phaseForSegment(pt, visible);
                const segColor = phaseEvent
                    ? LifeEventType.color(phaseEvent.type)
                    : 'rgba(0,0,0,0.10)';
                const segOpacity = phaseEvent
                    ? (this.selectedIndex === visible.indexOf(phaseEvent) ? 0.5 : 0.25)
                    : 1;
                items.push(html`
                    <div style="flex: ${gap}; height: 2px; border-radius: 1px; align-self: center;
                                background: ${segColor}; opacity: ${segOpacity};"></div>
                `);
            }
        }

        return html`
            <div class="flex items-center px-2 mb-1">
                ${items}
            </div>
        `;
    }

    /**
     * Determine which phase event (if any) "owns" the segment starting at a given anchor point.
     * A segment from an event dot to the next belongs to that event's phase.
     * A segment from S to the first event is pre-phase (gray).
     */
    _phaseForSegment(fromPoint, visible) {
        if (fromPoint.type === 'event') return fromPoint.event;
        if (fromPoint.type === 'start') return null; // S to first event = gray
        return null;
    }

    _renderTimelineLabels(visible, sAge, fAge) {
        const points = this._buildAnchorPoints(visible, sAge, fAge);
        const items = [];

        for (let p = 0; p < points.length; p++) {
            const pt = points[p];

            if (pt.type === 'start' || pt.type === 'finish') {
                // S/F labels: just match the width, no text
                items.push(html`
                    <div class="flex-shrink-0" style="width: 24px;"></div>
                `);
            } else if (pt.type === 'cursor') {
                // Cursor label rendered in its own row above; zero-width here
                items.push(html`<div class="flex-shrink-0" style="width: 0;"></div>`);
            } else {
                const ev = pt.event;
                const i = pt.eventIndex;
                const isSelected = this.selectedIndex === i;
                items.push(html`
                    <div class="flex flex-col items-center flex-shrink-0 cursor-pointer" style="width: 24px;"
                         @click=${() => this._onSelectPhase(i)}>
                        <span class="text-xs font-medium whitespace-nowrap"
                            style="color: ${isSelected ? LifeEventType.colorAccent(ev.type) : 'rgb(107,114,128)'};">
                            ${ev.displayName}
                        </span>
                        <span class="text-xs text-gray-400">${ev.triggerAge}</span>
                    </div>
                `);
            }

            // Proportional spacer
            if (p < points.length - 1) {
                const gap = points[p + 1].age - pt.age;
                items.push(html`<div style="flex: ${gap};"></div>`);
            }
        }

        return html`
            <div class="flex items-start px-2 mb-3">
                ${items}
            </div>
        `;
    }

    // ── Helpers ────────────────────────────────────────────────────

    _getYearRange() {
        const now = new Date().getFullYear();
        const birthYear = now - this.startAge;
        const startYear = birthYear + this._timelineStartAge;
        const finishYear = birthYear + this._timelineFinishAge;
        const years = [];
        for (let y = startYear; y <= finishYear; y++) {
            years.push(y);
        }
        return years;
    }

    _onYearChange(e) {
        const year = parseInt(e.target.value, 10);
        store.setSelectedYearMonth(year, this.selectedMonth);
    }

    _onMonthChange(e) {
        const month = parseInt(e.target.value, 10);
        store.setSelectedYearMonth(this.selectedYear, month);
    }

    _onSelectPhase(index) {
        this.selectedIndex = index;
        this.dispatchEvent(new CustomEvent('phase-select', {
            bubbles: true, composed: true,
            detail: { event: this._visibleEvents[index], index },
        }));
    }

    _onEditSelectedEvent() {
        if (!this.selectedEvent) return;
        // Find the real index in lifeEvents (not _visibleEvents)
        const realIndex = this.lifeEvents.indexOf(this.selectedEvent);
        this.dispatchEvent(new CustomEvent('event-edit', {
            bubbles: true, composed: true,
            detail: { event: this.selectedEvent, index: realIndex },
        }));
    }
}

customElements.define('finplan-timeline', FinplanTimeline);
