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

import { LitElement, html, svg, nothing } from 'lit';
import { store } from '../finplan-store.js';
import { LifeEvent, LifeEventType } from '../life-event.js';
import { InstrumentType } from '../instruments/instrument.js';
import { MetricLabel } from '../metric.js';
import { DateInt, MONTH_NAMES } from '../utils/date-int.js';

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
        _playing:       { state: true },
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
        this._playing = false;
        this._playInterval = null;

        this._onDateChange = (e) => {
            this.selectedYear = e.detail.year;
            this.selectedMonth = e.detail.month;
            // Auto-select the phase that the cursor now falls within
            const phaseIndex = this._cursorPhaseIndex;
            if (phaseIndex !== this.selectedIndex) {
                this.selectedIndex = phaseIndex;
                this.dispatchEvent(new CustomEvent('phase-select', {
                    bubbles: true, composed: true,
                    detail: { event: this._visibleEvents[phaseIndex], index: phaseIndex },
                }));
            }
        };
    }

    connectedCallback() {
        super.connectedCallback();
        store.addEventListener('date-change', this._onDateChange);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        store.removeEventListener('date-change', this._onDateChange);
        this._stopPlayback();
    }

    // ── Timeline span ───────────────────────────────────────────────

    get _timelineStartAge() {
        let sAge = Math.min(this.startAge, this.retirementAge) - 1;
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

    // ── Visible events (phases: Accumulate + Retire) ─────────────────

    get _visibleEvents() {
        const events = this.lifeEvents.filter(ev => LifeEventType.isPhase(ev.type));
        if (this.startAge >= this.retirementAge) {
            return events.filter(ev => ev.type !== LifeEvent.ACCUMULATE);
        }
        return events;
    }

    // ── Asset annotations (lifecycle markers) ────────────────────────
    //
    // Returns array of { asset, age, emoji, label, type } for asset lifecycle
    // events. Includes: real estate buy/sell, mortgage payoff, retirement
    // income start, pension start.

    get _assetAnnotations() {
        if (!this.portfolio?.modelAssets) return [];
        const birthYear = new Date().getFullYear() - this.startAge;
        const annotations = [];

        const ageFromDate = (di) => di.year - birthYear + (di.month - 1) / 12;
        const emojiFor = (inst) => InstrumentType.assetEmoji(inst);

        for (const asset of this.portfolio.modelAssets) {
            const inst = asset.instrument;
            const assetEmoji = emojiFor(inst);

            // Real estate: buy/sell
            if (InstrumentType.isRealEstate(inst)) {
                if (asset.startDateInt) {
                    annotations.push({
                        asset, age: ageFromDate(asset.startDateInt),
                        emoji: assetEmoji,
                        label: `Buy ${asset.displayName}`,
                        type: 'buy',
                    });
                }
                if (asset.finishDateInt) {
                    annotations.push({
                        asset, age: ageFromDate(asset.finishDateInt),
                        emoji: assetEmoji,
                        label: `Sell ${asset.displayName}`,
                        type: 'sell',
                    });
                }
            }

            // Mortgage: start and payoff markers
            else if (InstrumentType.isMortgage(inst)) {
                if (asset.startDateInt) {
                    annotations.push({
                        asset, age: ageFromDate(asset.startDateInt),
                        emoji: assetEmoji,
                        label: `Open ${asset.displayName}`,
                        type: 'mortgage-start',
                    });
                }
                const payoffAge = this._mortgagePayoffAge(asset, birthYear);
                if (payoffAge != null) {
                    annotations.push({
                        asset, age: payoffAge,
                        emoji: assetEmoji,
                        label: `${asset.displayName} paid off`,
                        type: 'payoff',
                    });
                }
            }

            // Retirement income (Social Security) start
            else if (InstrumentType.isRetirementIncome(inst) && !InstrumentType.isPension(inst)) {
                if (asset.startDateInt) {
                    annotations.push({
                        asset, age: ageFromDate(asset.startDateInt),
                        emoji: assetEmoji,
                        label: `${asset.displayName} starts`,
                        type: 'income-start',
                    });
                }
            }

            // Pension start
            else if (InstrumentType.isPension(inst)) {
                if (asset.startDateInt) {
                    annotations.push({
                        asset, age: ageFromDate(asset.startDateInt),
                        emoji: assetEmoji,
                        label: `${asset.displayName} starts`,
                        type: 'pension-start',
                    });
                }
            }
        }

        return annotations;
    }

    /**
     * Group annotations that share a near-same age and assign stack indices.
     * Annotations within CLUSTER_TOLERANCE years of each other are stacked
     * vertically. Each gets a `stackIndex` (0 = base, 1 = above, etc.).
     */
    _clusterAnnotations(annotations) {
        const CLUSTER_TOLERANCE = 0.4; // years — ~5 months
        const sorted = [...annotations].sort((a, b) => a.age - b.age);
        const result = [];
        let currentCluster = [];
        let clusterAnchor = null;

        const flushCluster = () => {
            currentCluster.forEach((ann, idx) => {
                result.push({ ...ann, stackIndex: idx });
            });
            currentCluster = [];
            clusterAnchor = null;
        };

        for (const ann of sorted) {
            if (clusterAnchor == null || Math.abs(ann.age - clusterAnchor) > CLUSTER_TOLERANCE) {
                flushCluster();
                clusterAnchor = ann.age;
            }
            currentCluster.push(ann);
        }
        flushCluster();

        return result;
    }

    /**
     * Find the age at which a mortgage reaches zero balance.
     * Scans the value history for the first month where balance is >= 0 (paid off).
     */
    _mortgagePayoffAge(asset, birthYear) {
        const history = asset.getHistory?.('value');
        if (!history?.length || !this.portfolio?.firstDateInt) return null;

        const startYear = this.portfolio.firstDateInt.year;
        const startMonth = this.portfolio.firstDateInt.month;

        for (let i = 0; i < history.length; i++) {
            // Mortgage balance is stored as negative; paid off when >= 0
            if (history[i] >= 0) {
                const monthsOffset = i;
                const year = startYear + Math.floor((startMonth - 1 + monthsOffset) / 12);
                const month = ((startMonth - 1 + monthsOffset) % 12) + 1;
                return (year - birthYear) + (month - 1) / 12;
            }
        }
        return null;
    }

    // ── Selected date as fractional age ────────────────────────────

    get _selectedAge() {
        const birthYear = new Date().getFullYear() - this.startAge;
        return (this.selectedYear - birthYear) + (this.selectedMonth - 1) / 12;
    }

    // ── Cursor phase (which phase the selected date falls within) ──

    get _cursorPhaseIndex() {
        const age = this._selectedAge;
        const visible = this._visibleEvents;
        for (let i = visible.length - 1; i >= 0; i--) {
            if (age >= visible[i].triggerAge) return i;
        }
        return 0;
    }

    get _cursorPhase() {
        return this._visibleEvents[this._cursorPhaseIndex] ?? null;
    }

    _cursorColor() {
        const phase = this._cursorPhase;
        return phase ? LifeEventType.color(phase.type) : '#888780';
    }

    _cursorColorAccent() {
        const phase = this._cursorPhase;
        return phase ? LifeEventType.colorAccent(phase.type) : '#5F5E5A';
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

    /**
     * Compute the history index for a given age (year boundary).
     */
    _historyIndexForAge(age) {
        if (!this.portfolio?.firstDateInt) return -1;
        const birthYear = new Date().getFullYear() - this.startAge;
        const targetYear = birthYear + age;
        return DateInt.diffMonths(this.portfolio.firstDateInt, DateInt.from(targetYear, 1));
    }

    /**
     * Compute portfolio metric total at a specific history index.
     */
    _metricAtIndex(idx) {
        if (!this.portfolio || idx < 0) return 0;
        let total = 0;
        for (const asset of this.portfolio.modelAssets) {
            const history = asset.getHistory(this.metricName);
            if (history && idx >= 0 && idx < history.length) {
                total += history[idx] ?? 0;
            }
        }
        return total;
    }

    /**
     * Compute the "you are here" metric value at the cursor position.
     */
    _computeCursorMetric() {
        if (!this.portfolio?.firstDateInt) return 0;
        const idx = DateInt.diffMonths(this.portfolio.firstDateInt, DateInt.from(this.selectedYear, this.selectedMonth));
        return this._metricAtIndex(idx);
    }

    /**
     * Compute CAGR between two history indices.
     */
    _computeCAGRBetween(startIdx, endIdx) {
        const startVal = this._metricAtIndex(startIdx);
        const endVal = this._metricAtIndex(endIdx);
        if (!startVal || startVal === 0) return 0;
        const months = endIdx - startIdx;
        if (months <= 0) return 0;
        const years = months / 12;
        return (Math.pow(endVal / startVal, 1 / years) - 1) * 100;
    }

    /**
     * Build per-phase sparkline data (array of metric values for each month in the phase).
     */
    _phaseSparklineData(phaseStartAge, phaseEndAge) {
        if (!this.portfolio?.firstDateInt) return [];
        const startIdx = Math.max(0, this._historyIndexForAge(phaseStartAge));
        const endIdx = this._historyIndexForAge(phaseEndAge);
        const data = [];
        for (let i = startIdx; i <= endIdx; i++) {
            data.push(this._metricAtIndex(i));
        }
        return data;
    }

    /**
     * Get the last valid history index from the portfolio.
     */
    _lastHistoryIndex() {
        if (!this.portfolio) return 0;
        for (const asset of this.portfolio.modelAssets) {
            const h = asset.getHistory(this.metricName);
            if (h?.length > 0) return h.length - 1;
        }
        return 0;
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
            <!-- Portfolio Open/Close (upper left/right) -->
            <div class="flex items-center justify-between px-2 mb-2">
                <span class="text-xs text-gray-400">
                    <span class="font-medium">OPEN</span>
                    <span class="text-sm font-semibold text-gray-700 ml-1">${this._formatCurrency(startMetric)}</span>
                </span>
                <span class="text-xs text-gray-400">
                    <span class="text-sm font-semibold text-gray-700 mr-1">${this._formatCurrency(finishMetric)}</span>
                    <span class="font-medium">CLOSE</span>
                </span>
            </div>

            <!-- Controls row with cursor value -->
            <div class="flex items-center justify-center gap-3 mb-3">
                <select class="text-xs px-2 py-1.5 rounded-lg cursor-pointer outline-none font-medium"
                    style="background: ${this._cursorColor()}20; color: ${this._cursorColorAccent()}; border: 1px solid ${this._cursorColor()}30;"
                    @change=${this._onYearChange}>
                    ${years.map(y => html`
                        <option value=${y} ?selected=${y === this.selectedYear}>${y}</option>
                    `)}
                </select>

                <select class="text-xs px-2 py-1.5 rounded-lg cursor-pointer outline-none font-medium"
                    style="background: ${this._cursorColor()}20; color: ${this._cursorColorAccent()}; border: 1px solid ${this._cursorColor()}30;"
                    @change=${this._onMonthChange}>
                    ${MONTH_NAMES.map((name, i) => html`
                        <option value=${i + 1} ?selected=${(i + 1) === this.selectedMonth}>${name}</option>
                    `)}
                </select>

                <button class="timeline-play-btn"
                    style="background: ${this._cursorColor()}20; color: ${this._cursorColorAccent()}; border: 1px solid ${this._cursorColor()}30;"
                    @click=${this._onPlayPause}
                    title=${this._playing ? 'Pause' : 'Play through timeline'}>
                    ${this._playing ? '⏸' : '▶'}
                </button>
            </div>

            <!-- Timeline bar (flex with proportional spacers) -->
            ${this._renderTimelineBar(visible, sAge, fAge)}

            <!-- Timeline labels (flex with proportional spacers) -->
            ${this._renderTimelineLabels(visible, sAge, fAge)}

            <!-- Cursor indicator below timeline -->
            ${this._renderCursorRow(visible, sAge, fAge)}

            <!-- Per-phase summary bars -->
            ${this._renderPhaseBars(visible)}
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
                const cursorVal = this._computeCursorMetric();
                items.push(html`
                    <div class="flex flex-col items-center flex-shrink-0" style="width: 0;">
                        <span style="font-size: 12px; font-weight: 900; color: ${this._cursorColorAccent()}; line-height: 1; margin-bottom: -1px;">&#9650;</span>
                        <span style="font-size: 10px; font-weight: 700; background: ${this._cursorColor()}20; color: ${this._cursorColorAccent()};
                                     padding: 1px 6px; border-radius: 8px; line-height: 1.3;
                                     white-space: nowrap;">You are Here · ${this._formatCurrency(cursorVal)}</span>
                        <span style="font-size: 12px; font-weight: 900; color: ${this._cursorColorAccent()}; line-height: 1; margin-top: -1px;">&#9660;</span>
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
            <div class="flex items-start px-2" style="height: 40px; margin-top: -10px; margin-bottom: 5px;">
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
                         @click=${(e) => { e.stopPropagation(); this._onSelectPhase(i); }}>
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

        // Asset annotation emojis — cluster by near-same age and stack vertically
        const stackedAnnotations = this._clusterAnnotations(this._assetAnnotations);

        // Compute the max stack depth for vertical space allocation
        const maxStack = stackedAnnotations.reduce((m, a) => Math.max(m, a.stackIndex), 0);
        const annotationLaneHeight = 30 + maxStack * 18;

        return html`
            <div class="flex items-center px-2 mb-1"
                 style="cursor: pointer; position: relative; margin-top: ${annotationLaneHeight}px;"
                 @click=${this._onTimelineBarClick}>
                ${items}
                ${stackedAnnotations.map(ann => {
                    const pct = ((ann.age - sAge) / (fAge - sAge)) * 100;
                    if (pct < 0 || pct > 100) return nothing;
                    const stackOffset = ann.stackIndex * 18; // 18px per stack level
                    return html`
                        <div class="timeline-annotation"
                             style="left: ${pct}%; top: ${-18 - stackOffset}px;"
                             title="${ann.label} (age ${Math.round(ann.age)})"
                             @click=${(e) => { e.stopPropagation(); this._onEditAsset(ann.asset); }}>
                            ${ann.emoji}
                        </div>
                    `;
                })}
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

    _renderPhaseBars(visible) {
        if (!visible.length) return nothing;

        return html`
            <div class="flex gap-2">
                ${visible.map((ev, i) => {
                    const phaseStartAge = ev.triggerAge;
                    const isLastPhase = i === visible.length - 1;
                    const startIdx = Math.max(0, this._historyIndexForAge(phaseStartAge));
                    // Last phase: use the actual last history index to match portfolio close
                    const endIdx = isLastPhase ? this._lastHistoryIndex() : this._historyIndexForAge(visible[i + 1].triggerAge);
                    const openVal = this._metricAtIndex(startIdx);
                    const closeVal = this._metricAtIndex(Math.max(0, endIdx));
                    const cagr = this._computeCAGRBetween(startIdx, Math.max(startIdx + 1, endIdx));
                    const cagrPositive = cagr >= 0;
                    const color = LifeEventType.color(ev.type);
                    const accent = LifeEventType.colorAccent(ev.type);
                    return html`
                        <div class="flex-1 flex items-center gap-2 px-3 py-1.5 rounded-xl cursor-pointer hover:opacity-90 transition-opacity"
                             style="background: ${color}12; border: 1px solid ${color}20;"
                             @click=${() => this._onSelectPhase(i)}>

                            <span class="text-xs font-semibold" style="color: ${accent};">${ev.displayName}</span>

                            <span class="text-xs rounded-full hover:bg-white/60 transition-colors flex items-center justify-center"
                                  style="color: ${accent}; width: 18px; height: 18px; opacity: 0.75;"
                                  title="Edit phase"
                                  @click=${(e) => { e.stopPropagation(); this._onEditPhase(i); }}>
                                <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
                                    <path d="M9.1 1.2L10.8 2.9 3.6 10.1 1.2 10.8 1.9 8.4z"/>
                                </svg>
                            </span>

                            <span class="flex-1"></span>

                            <span class="text-xs text-gray-400">
                                ${this._formatCurrency(openVal)}
                                <span style="color: ${accent};">→</span>
                                ${this._formatCurrency(closeVal)}
                            </span>

                            <span class="text-xs font-semibold ${cagrPositive ? 'text-green-600' : 'text-pink-600'}">
                                ${cagr.toFixed(1)}%
                            </span>
                        </div>
                    `;
                })}

                <span class="text-xs font-medium px-1.5 py-0.5 rounded-full cursor-pointer hover:bg-gray-200 transition-colors flex items-center"
                    style="color: #666;"
                    title="Add life event"
                    @click=${this._onAddEvent}>+</span>
            </div>
        `;
    }

    _renderPhaseSparkline(data, color) {
        if (!data || data.length < 2) return nothing;

        const W = 80;
        const H = 16;
        const PAD = 1;

        let min = Infinity, max = -Infinity;
        for (const v of data) {
            if (v < min) min = v;
            if (v > max) max = v;
        }
        const range = max - min || 1;

        const points = [];
        for (let k = 0; k < data.length; k++) {
            const x = PAD + (k / (data.length - 1)) * (W - 2 * PAD);
            const y = H - PAD - ((data[k] - min) / range) * (H - 2 * PAD);
            points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
        }

        return html`
            <svg viewBox="0 0 ${W} ${H}" style="width: 100%; height: 16px; display: block; opacity: 0.5;">
                ${svg`<polyline points="${points.join(' ')}"
                    fill="none" stroke="${color}" stroke-width="1.5"
                    stroke-linejoin="round" stroke-linecap="round" />`}
            </svg>
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
        this._stopPlayback();
        const year = parseInt(e.target.value, 10);
        store.setSelectedYearMonth(year, this.selectedMonth);
    }

    _onMonthChange(e) {
        this._stopPlayback();
        const month = parseInt(e.target.value, 10);
        store.setSelectedYearMonth(this.selectedYear, month);
    }

    _onPlayPause() {
        if (this._playing) {
            this._stopPlayback();
        } else {
            this._startPlayback();
        }
    }

    _startPlayback() {
        this._playing = true;
        this._playInterval = setInterval(() => {
            const years = this._getYearRange();
            const maxYear = years[years.length - 1];

            let nextMonth = this.selectedMonth + 1;
            let nextYear = this.selectedYear;
            if (nextMonth > 12) {
                nextMonth = 1;
                nextYear++;
            }

            if (nextYear > maxYear) {
                this._stopPlayback();
                return;
            }

            store.setSelectedYearMonth(nextYear, nextMonth);
        }, 1000);
    }

    _stopPlayback() {
        this._playing = false;
        if (this._playInterval) {
            clearInterval(this._playInterval);
            this._playInterval = null;
        }
    }

    _onTimelineBarClick(e) {
        this._stopPlayback();
        const bar = e.currentTarget;
        const rect = bar.getBoundingClientRect();
        const padding = 8; // px-2
        const innerWidth = rect.width - padding * 2;
        if (innerWidth <= 0) return;
        const clickX = e.clientX - rect.left - padding;
        const fraction = Math.max(0, Math.min(1, clickX / innerWidth));

        const sAge = this._timelineStartAge;
        const fAge = this._timelineFinishAge;
        const age = sAge + fraction * (fAge - sAge);

        const birthYear = new Date().getFullYear() - this.startAge;
        const year = birthYear + Math.floor(age);
        const month = Math.max(1, Math.min(12, Math.floor((age % 1) * 12) + 1));

        store.setSelectedYearMonth(year, month);
    }

    _onSelectPhase(index) {
        this.selectedIndex = index;
        const ev = this._visibleEvents[index];
        if (ev) {
            const birthYear = new Date().getFullYear() - this.startAge;
            const year = birthYear + ev.triggerAge;
            store.setSelectedYearMonth(year, 1);
        }
        this.dispatchEvent(new CustomEvent('phase-select', {
            bubbles: true, composed: true,
            detail: { event: ev, index },
        }));
    }

    _onAddEvent() {
        this.dispatchEvent(new CustomEvent('event-create', {
            bubbles: true, composed: true,
        }));
    }

    _onEditSelectedEvent() {
        if (!this.selectedEvent) return;
        const realIndex = this.lifeEvents.indexOf(this.selectedEvent);
        this.dispatchEvent(new CustomEvent('event-edit', {
            bubbles: true, composed: true,
            detail: { event: this.selectedEvent, index: realIndex },
        }));
    }

    _onEditPhase(visibleIndex) {
        this._onSelectPhase(visibleIndex);
        const ev = this._visibleEvents[visibleIndex];
        if (!ev) return;
        const realIndex = this.lifeEvents.indexOf(ev);
        this.dispatchEvent(new CustomEvent('event-edit', {
            bubbles: true, composed: true,
            detail: { event: ev, index: realIndex },
        }));
    }

    _onEditAsset(asset) {
        this.dispatchEvent(new CustomEvent('edit-asset', {
            bubbles: true, composed: true,
            detail: { modelAsset: asset },
        }));
    }
}

customElements.define('finplan-timeline', FinplanTimeline);
