/**
 * <finplan-timeline>  — rev B: "the timeline becomes the chart"
 *
 * One SVG wealth arc replaces the old band + labels + cursor rows:
 *  - Phase tint bands with the phase growth rate as the headline label
 *  - Total-metric value curve with per-phase area fills
 *  - Asset milestones pinned to the curve (buy/sell, payoff, income starts)
 *  - Start/end values on the curve endpoints; checkpoint values at interior
 *    phase boundaries (e.g. value at retirement)
 *  - Scrubbable "you are here" cursor (pointer drag + arrow keys) that drives
 *    the app-wide viewing date through the store
 *  - Year/month dropdown controls + play-through (unchanged behavior)
 *  - Slim phase chips below the arc: name + age range + edit
 *
 * Phase visibility rules:
 *  - If currentAge < retirementAge → both Accumulate and Retire visible
 *  - If currentAge >= retirementAge → only Retire visible
 *
 * Timeline span:
 *  - S = min(startAge - 1, portfolio start age)
 *  - F = finishAge + 1
 *  - Everything positions proportionally within S–F
 */

import { LitElement, html, svg, nothing } from 'lit';
import { store } from '../finplan-store.js';
import { LifeEvent, LifeEventType } from '../life-event.js';
import { InstrumentType } from '../instruments/instrument.js';
import { MetricLabel } from '../metric.js';
import { DateInt, MONTH_NAMES } from '../utils/date-int.js';

// ── Arc geometry (viewBox units; the SVG scales to container width) ──
const ARC_W = 1000;
const ARC_H = 210;
const PAD_L = 10;
const PAD_R = 10;
const PAD_T = 70;   // room for band labels, pins, and the cursor chip
const PAD_B = 30;   // room for the age axis
const PLOT_W = ARC_W - PAD_L - PAD_R;
const PLOT_H = ARC_H - PAD_T - PAD_B;
const BASE_Y = ARC_H - PAD_B;

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
        this._scrubbing = false;

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

    get _birthYear() {
        return new Date().getFullYear() - this.startAge;
    }

    get _timelineStartAge() {
        let sAge = Math.min(this.startAge, this.retirementAge) - 1;
        if (this.portfolio?.firstDateInt) {
            const portfolioStartAge = this.portfolio.firstDateInt.year - this._birthYear;
            sAge = Math.min(sAge, portfolioStartAge);
        }
        return sAge;
    }

    get _timelineFinishAge() {
        return this.finishAge + 1;
    }

    /** Map an age to an x position in viewBox units. */
    _ageToX(age) {
        const sAge = this._timelineStartAge;
        const span = Math.max(1e-6, this._timelineFinishAge - sAge);
        return PAD_L + ((age - sAge) / span) * PLOT_W;
    }

    // ── Visible events (phases: Accumulate + Retire) ─────────────────

    get _visibleEvents() {
        const events = this.lifeEvents.filter(ev => LifeEventType.isPhase(ev.type));
        if (this.startAge >= this.retirementAge) {
            return events.filter(ev => ev.type !== LifeEvent.ACCUMULATE);
        }
        return events;
    }

    /** Phases with resolved [startAge, endAge] spans. */
    get _phaseSpans() {
        const visible = this._visibleEvents;
        return visible.map((ev, i) => ({
            event: ev,
            index: i,
            startAge: ev.triggerAge,
            endAge: i < visible.length - 1 ? visible[i + 1].triggerAge : this.finishAge,
        }));
    }

    // ── Asset annotations (lifecycle markers) ────────────────────────
    //
    // Returns array of { asset, age, emoji, label, type } for asset lifecycle
    // events. Includes: real estate buy/sell, mortgage payoff, retirement
    // income start, pension start.

    get _assetAnnotations() {
        if (!this.portfolio?.modelAssets) return [];
        const birthYear = this._birthYear;
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
        return (this.selectedYear - this._birthYear) + (this.selectedMonth - 1) / 12;
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

    // ── Metric computation ──────────────────────────────────────────

    /**
     * Build the total-metric series across the full history.
     * Returns { vals, min, max, lastIdx } or null when there is no history.
     */
    _buildSeries() {
        if (!this.portfolio?.firstDateInt) return null;
        const lastIdx = this._lastHistoryIndex();
        if (lastIdx < 1) return null;

        const vals = new Array(lastIdx + 1);
        let min = Infinity, max = -Infinity;
        for (let i = 0; i <= lastIdx; i++) {
            const v = this._metricAtIndex(i);
            vals[i] = v;
            if (v < min) min = v;
            if (v > max) max = v;
        }
        if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
        if (max === min) max = min + 1;   // avoid a zero-height range
        return { vals, min, max, lastIdx };
    }

    /** Age (fractional) at a given history index. */
    _ageAtIndex(i) {
        const fd = this.portfolio?.firstDateInt;
        if (!fd) return this._timelineStartAge;
        const year = fd.year + Math.floor((fd.month - 1 + i) / 12);
        const month = ((fd.month - 1 + i) % 12) + 1;
        return (year - this._birthYear) + (month - 1) / 12;
    }

    /** Nearest history index for a fractional age (clamped to history). */
    _indexForAgeFrac(age, lastIdx) {
        const i = Math.round((age - this._ageAtIndex(0)) * 12);
        return Math.max(0, Math.min(lastIdx, i));
    }

    /**
     * Compute the history index for a given age (year boundary).
     */
    _historyIndexForAge(age) {
        if (!this.portfolio?.firstDateInt) return -1;
        const targetYear = this._birthYear + age;
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

        return html`
            <!-- Date controls (right-aligned above the arc) -->
            <div class="flex items-center justify-end gap-2 mb-1">
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

            <!-- The wealth arc -->
            ${this._renderArc(visible)}

            <!-- Phase chips: name + age range + edit -->
            ${this._renderPhaseChips(visible)}
        `;
    }

    // ── Arc rendering ───────────────────────────────────────────────

    _renderArc(visible) {
        const sAge = this._timelineStartAge;
        const fAge = this._timelineFinishAge;
        const series = this._buildSeries();
        const spans = this._phaseSpans;

        const Y = series
            ? (v) => BASE_Y - ((v - series.min) / (series.max - series.min)) * PLOT_H
            : () => BASE_Y;

        const metricLabel = MetricLabel[this.metricName] ?? this.metricName;

        return html`
            <div class="timeline-arc"
                 tabindex="0"
                 role="slider"
                 aria-label="${metricLabel} over your timeline — drag or use arrow keys to move the viewing date"
                 aria-valuemin=${this._birthYear + sAge}
                 aria-valuemax=${this._birthYear + fAge}
                 aria-valuenow=${this.selectedYear}
                 aria-valuetext="${MONTH_NAMES[this.selectedMonth - 1]} ${this.selectedYear}, ${this._formatCurrency(this._computeCursorMetric())}"
                 @pointerdown=${this._onArcPointerDown}
                 @pointermove=${this._onArcPointerMove}
                 @pointerup=${this._onArcPointerUp}
                 @pointercancel=${this._onArcPointerUp}
                 @keydown=${this._onArcKeyDown}>
                <svg viewBox="0 0 ${ARC_W} ${ARC_H}" xmlns="http://www.w3.org/2000/svg">
                    ${this._svgPhaseBands(spans, series)}
                    ${series ? this._svgAreasAndCurve(spans, series, Y) : nothing}
                    ${this._svgAxis(sAge, fAge, series)}
                    ${series ? this._svgEndpoints(series, Y) : nothing}
                    ${series ? this._svgCheckpoints(spans, series, Y) : nothing}
                    ${this._svgBoundaryDots(spans)}
                    ${series ? this._svgPins(series, Y) : nothing}
                    ${this._svgCursor(series, Y, sAge, fAge)}
                </svg>
                ${this._renderCursorChip(sAge, fAge)}
            </div>
        `;
    }

    /** Phase background tints + headline labels (name + growth rate). */
    _svgPhaseBands(spans, series) {
        const parts = [];
        for (const span of spans) {
            const color = LifeEventType.color(span.event.type);
            const accent = LifeEventType.colorAccent(span.event.type);
            const x0 = this._ageToX(Math.max(span.startAge, this._timelineStartAge));
            const x1 = this._ageToX(Math.min(span.endAge, this._timelineFinishAge));
            if (x1 - x0 < 4) continue;

            const isSelected = this.selectedIndex === span.index;
            parts.push(svg`
                <rect x=${x0.toFixed(1)} y=${PAD_T - 14} width=${(x1 - x0).toFixed(1)} height=${BASE_Y - PAD_T + 14}
                      fill="${color}${isSelected ? '14' : '0E'}" rx="6"></rect>
            `);

            // Interior boundary marker (e.g. retirement line)
            if (span.index > 0) {
                parts.push(svg`
                    <line x1=${x0.toFixed(1)} y1=${PAD_T - 14} x2=${x0.toFixed(1)} y2=${BASE_Y}
                          stroke="${color}" stroke-width="1" stroke-dasharray="2 4" opacity="0.45"></line>
                `);
            }

            // Headline: NAME (caps) + growth rate (large)
            const labelX = x0 + 10;
            parts.push(svg`
                <text x=${labelX.toFixed(1)} y=${PAD_T - 2} font-size="9" font-weight="600"
                      letter-spacing="1.2" fill="${accent}" opacity="0.8">${span.event.displayName.toUpperCase()}</text>
            `);
            if (series && x1 - x0 > 80) {
                const startIdx = Math.max(0, this._historyIndexForAge(span.startAge));
                const isLast = span.index === spans.length - 1;
                const endIdx = isLast ? series.lastIdx : this._historyIndexForAge(span.endAge);
                const cagr = this._computeCAGRBetween(startIdx, Math.max(startIdx + 1, endIdx));
                parts.push(svg`
                    <text x=${labelX.toFixed(1)} y=${PAD_T + 16} font-size="16" font-weight="700"
                          fill="${accent}">${cagr.toFixed(1)}%/yr</text>
                `);
            }
        }
        return parts;
    }

    /** Per-phase area fills + the single value curve on top. */
    _svgAreasAndCurve(spans, series, Y) {
        const { vals, lastIdx } = series;
        const step = Math.max(1, Math.floor(vals.length / 240));

        const pointAt = (i) => `${this._ageToX(this._ageAtIndex(i)).toFixed(1)},${Y(vals[i]).toFixed(1)}`;

        const curveIdxs = [];
        for (let i = 0; i <= lastIdx; i += step) curveIdxs.push(i);
        if (curveIdxs[curveIdxs.length - 1] !== lastIdx) curveIdxs.push(lastIdx);

        const parts = [];

        // Area fill per phase (clip the curve segment falling inside the phase)
        for (const span of spans) {
            const color = LifeEventType.color(span.event.type);
            const i0 = this._indexForAgeFrac(Math.max(span.startAge, this._ageAtIndex(0)), lastIdx);
            const i1 = span.index === spans.length - 1
                ? lastIdx
                : this._indexForAgeFrac(span.endAge, lastIdx);
            if (i1 <= i0) continue;

            const seg = [];
            for (let i = i0; i <= i1; i += step) seg.push(pointAt(i));
            seg.push(pointAt(i1));
            const x0 = this._ageToX(this._ageAtIndex(i0)).toFixed(1);
            const x1 = this._ageToX(this._ageAtIndex(i1)).toFixed(1);
            parts.push(svg`
                <path d="M${x0},${BASE_Y} L${seg.join(' L')} L${x1},${BASE_Y} Z"
                      fill="${color}1F" stroke="none"></path>
            `);
        }

        // Zero gridline when the series crosses zero
        if (series.min < 0 && series.max > 0) {
            const y0 = Y(0).toFixed(1);
            parts.push(svg`
                <line x1=${PAD_L} y1=${y0} x2=${ARC_W - PAD_R} y2=${y0}
                      stroke="#d1d5db" stroke-width="1" stroke-dasharray="3 4" opacity="0.7"></line>
            `);
        }

        // The curve itself
        parts.push(svg`
            <path d="M${curveIdxs.map(pointAt).join(' L')}"
                  fill="none" stroke="#111827" stroke-width="2" stroke-linecap="round"
                  stroke-linejoin="round" opacity="0.8"></path>
        `);

        return parts;
    }

    /** Baseline + age ticks + extreme-year labels. */
    _svgAxis(sAge, fAge, series) {
        const parts = [];
        parts.push(svg`
            <line x1=${PAD_L} y1=${BASE_Y} x2=${ARC_W - PAD_R} y2=${BASE_Y}
                  stroke="#e5e7eb" stroke-width="1"></line>
        `);

        for (let age = Math.ceil(sAge / 5) * 5; age <= fAge; age += 5) {
            const tx = this._ageToX(age).toFixed(1);
            parts.push(svg`
                <line x1=${tx} y1=${BASE_Y} x2=${tx} y2=${BASE_Y + 4} stroke="#d1d5db" stroke-width="1"></line>
                <text x=${tx} y=${BASE_Y + 16} font-size="9.5" fill="#9ca3af" text-anchor="middle">${age}</text>
            `);
        }

        parts.push(svg`
            <text x=${PAD_L} y=${BASE_Y + 16} font-size="9.5" fill="#c3c7cf" text-anchor="start">${this._birthYear + sAge}</text>
            <text x=${ARC_W - PAD_R} y=${BASE_Y + 16} font-size="9.5" fill="#c3c7cf" text-anchor="end">${this._birthYear + fAge}</text>
        `);
        return parts;
    }

    /** Open/close values on the curve endpoints. */
    _svgEndpoints(series, Y) {
        const { vals, lastIdx } = series;
        const x0 = this._ageToX(this._ageAtIndex(0));
        const y0 = Y(vals[0]);
        const x1 = this._ageToX(this._ageAtIndex(lastIdx));
        const y1 = Y(vals[lastIdx]);
        return svg`
            <circle cx=${x0.toFixed(1)} cy=${y0.toFixed(1)} r="3.5" fill="#fff" stroke="#111827" stroke-width="1.5"></circle>
            <text x=${(x0 + 7).toFixed(1)} y=${(y0 - 7).toFixed(1)} font-size="11" fill="#6b7280" font-weight="500">${this._formatCurrency(vals[0])}</text>
            <circle cx=${x1.toFixed(1)} cy=${y1.toFixed(1)} r="4" fill="#111827"></circle>
            <text x=${(x1 - 8).toFixed(1)} y=${(y1 + 4).toFixed(1)} font-size="13" font-weight="700"
                  fill="#111827" text-anchor="end">${this._formatCurrency(vals[lastIdx])}</text>
        `;
    }

    /** Value checkpoints at interior phase boundaries (e.g. at retirement). */
    _svgCheckpoints(spans, series, Y) {
        const parts = [];
        for (const span of spans) {
            if (span.index === 0) continue;
            const accent = LifeEventType.colorAccent(span.event.type);
            const idx = this._indexForAgeFrac(span.startAge, series.lastIdx);
            const cx = this._ageToX(this._ageAtIndex(idx));
            const cy = Y(series.vals[idx]);
            parts.push(svg`
                <circle cx=${cx.toFixed(1)} cy=${cy.toFixed(1)} r="3.5" fill="#fff" stroke="${accent}" stroke-width="1.5"></circle>
                <text x=${(cx + 8).toFixed(1)} y=${(cy - 8).toFixed(1)} font-size="10.5" font-weight="600"
                      fill="${accent}">${this._formatCurrency(series.vals[idx])}</text>
            `);
        }
        return parts;
    }

    /** Phase-start dots on the axis — click to select the phase. */
    _svgBoundaryDots(spans) {
        return spans.map(span => {
            const color = LifeEventType.color(span.event.type);
            const accent = LifeEventType.colorAccent(span.event.type);
            const cx = this._ageToX(span.startAge).toFixed(1);
            const isSelected = this.selectedIndex === span.index;
            return svg`
                <g style="cursor: pointer;"
                   @pointerdown=${(e) => e.stopPropagation()}
                   @click=${(e) => { e.stopPropagation(); this._onSelectPhase(span.index); }}>
                    <title>${span.event.displayName} — ages ${span.startAge}–${span.endAge}</title>
                    ${isSelected ? svg`<circle cx=${cx} cy=${BASE_Y} r="10" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.5"></circle>` : nothing}
                    <circle cx=${cx} cy=${BASE_Y} r="6" fill="${color}" stroke="${accent}" stroke-width="2"></circle>
                </g>
            `;
        });
    }

    /** Asset milestones pinned to the curve. */
    _svgPins(series, Y) {
        const stacked = this._clusterAnnotations(this._assetAnnotations);
        const sAge = this._timelineStartAge;
        const fAge = this._timelineFinishAge;

        return stacked.map(ann => {
            if (ann.age < sAge || ann.age > fAge) return nothing;
            const px = this._ageToX(ann.age);
            const idx = this._indexForAgeFrac(ann.age, series.lastIdx);
            const curveY = Y(series.vals[idx]);
            const py = Math.max(PAD_T - 4, curveY - 22 - ann.stackIndex * 26);
            return svg`
                <g class="timeline-pin"
                   @pointerdown=${(e) => e.stopPropagation()}
                   @click=${(e) => { e.stopPropagation(); this._onEditAsset(ann.asset); }}>
                    <title>${ann.label} (age ${Math.round(ann.age)})</title>
                    <line x1=${px.toFixed(1)} y1=${py.toFixed(1)} x2=${px.toFixed(1)} y2=${(curveY - 4).toFixed(1)}
                          stroke="#d1d5db" stroke-width="1"></line>
                    <circle cx=${px.toFixed(1)} cy=${py.toFixed(1)} r="11" fill="#fff" stroke="#e5e7eb" stroke-width="1"></circle>
                    <text x=${px.toFixed(1)} y=${(py + 1).toFixed(1)} font-size="11" text-anchor="middle"
                          dominant-baseline="middle">${ann.emoji}</text>
                </g>
            `;
        });
    }

    /** The "you are here" cursor line + dot. */
    _svgCursor(series, Y, sAge, fAge) {
        const age = Math.max(sAge, Math.min(fAge, this._selectedAge));
        const cx = this._ageToX(age);
        const dotY = series
            ? Y(series.vals[this._indexForAgeFrac(age, series.lastIdx)])
            : BASE_Y;
        return svg`
            <line x1=${cx.toFixed(1)} y1=${PAD_T - 14} x2=${cx.toFixed(1)} y2=${BASE_Y}
                  stroke="#111827" stroke-width="1.25" opacity="0.7"></line>
            <circle cx=${cx.toFixed(1)} cy=${dotY.toFixed(1)} r="4.5" fill="#111827" stroke="#fff" stroke-width="1.5"></circle>
        `;
    }

    /** HTML overlay chip above the cursor: date · age — value. */
    _renderCursorChip(sAge, fAge) {
        if (!this.portfolio?.firstDateInt) return nothing;
        const age = Math.max(sAge, Math.min(fAge, this._selectedAge));
        const pct = ((this._ageToX(age) / ARC_W) * 100).toFixed(2);
        const color = this._cursorColor();
        const accent = this._cursorColorAccent();
        return html`
            <div class="timeline-cursor-chip"
                 style="left: clamp(80px, ${pct}%, calc(100% - 80px)); background: #ffffff; border: 1px solid ${color}40; color: ${accent};">
                ${MONTH_NAMES[this.selectedMonth - 1]} ${this.selectedYear} · Age ${Math.floor(this._selectedAge)}
                — <strong>${this._formatCurrency(this._computeCursorMetric())}</strong>
            </div>
        `;
    }

    // ── Phase chips ────────────────────────────────────────────────

    _renderPhaseChips(visible) {
        if (!visible.length) return nothing;
        const spans = this._phaseSpans;

        return html`
            <div class="flex gap-2 items-center" style="margin-top: 10px;">
                ${spans.map(span => {
                    const color = LifeEventType.color(span.event.type);
                    const accent = LifeEventType.colorAccent(span.event.type);
                    const isSelected = this.selectedIndex === span.index;
                    return html`
                        <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full cursor-pointer hover:opacity-90 transition-opacity text-xs"
                             style="background: ${color}12; border: 1px solid ${color}${isSelected ? '55' : '20'};"
                             @click=${() => this._onSelectPhase(span.index)}>
                            <span style="width: 8px; height: 8px; border-radius: 50%; background: ${color};"></span>
                            <span class="font-semibold" style="color: ${accent};">${span.event.displayName}</span>
                            <span class="text-gray-400" style="font-size: 11.5px;">${span.startAge}–${span.endAge}</span>
                            <span class="text-xs rounded-full hover:bg-white/60 transition-colors flex items-center justify-center"
                                  style="color: ${accent}; width: 18px; height: 18px; opacity: 0.75;"
                                  title="Edit phase"
                                  @click=${(e) => { e.stopPropagation(); this._onEditPhase(span.index); }}>
                                <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
                                    <path d="M9.1 1.2L10.8 2.9 3.6 10.1 1.2 10.8 1.9 8.4z"/>
                                </svg>
                            </span>
                        </div>
                    `;
                })}

                <span class="text-xs font-medium px-2 py-0.5 rounded-full cursor-pointer hover:bg-gray-200 transition-colors flex items-center"
                    style="color: #666;"
                    title="Add life event"
                    @click=${this._onAddEvent}>+ Life event</span>
            </div>
        `;
    }

    // ── Cursor scrubbing ────────────────────────────────────────────

    _onArcPointerDown(e) {
        this._stopPlayback();
        this._scrubbing = true;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic events lack a pointerId */ }
        this._scrubToEvent(e);
    }

    _onArcPointerMove(e) {
        if (this._scrubbing) this._scrubToEvent(e);
    }

    _onArcPointerUp() {
        this._scrubbing = false;
    }

    /** Map a pointer event to a (year, month) and push it to the store. */
    _scrubToEvent(e) {
        const svgEl = e.currentTarget.querySelector('svg');
        if (!svgEl) return;
        const rect = svgEl.getBoundingClientRect();
        if (rect.width <= 0) return;

        const vx = ((e.clientX - rect.left) / rect.width) * ARC_W;
        const fraction = Math.max(0, Math.min(1, (vx - PAD_L) / PLOT_W));

        const sAge = this._timelineStartAge;
        const age = sAge + fraction * (this._timelineFinishAge - sAge);
        const year = this._birthYear + Math.floor(age);
        const month = Math.max(1, Math.min(12, Math.floor((age % 1) * 12) + 1));

        // Only dispatch when the month actually changes — keeps drag cheap
        if (year !== store.selectedYear || month !== store.selectedMonth) {
            store.setSelectedYearMonth(year, month);
        }
    }

    _onArcKeyDown(e) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        this._stopPlayback();

        const delta = (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 12 : 1);
        let year = this.selectedYear;
        let month = this.selectedMonth + delta;
        while (month > 12) { month -= 12; year++; }
        while (month < 1) { month += 12; year--; }

        const years = this._getYearRange();
        const minYear = years[0], maxYear = years[years.length - 1];
        if (year < minYear) { year = minYear; month = 1; }
        if (year > maxYear) { year = maxYear; month = 12; }

        store.setSelectedYearMonth(year, month);
    }

    // ── Helpers ────────────────────────────────────────────────────

    _getYearRange() {
        const birthYear = this._birthYear;
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

    _onSelectPhase(index) {
        this.selectedIndex = index;
        const ev = this._visibleEvents[index];
        if (ev) {
            const year = this._birthYear + ev.triggerAge;
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
