/**
 * <finplan-timeline>
 *
 * Sticky timeline component with:
 *  - Year/month dropdown controls + "Viewing" badge
 *  - Phase bar with colored dots, connecting lines, age labels
 *  - Pure HTML/CSS rendering (no Chart.js canvas)
 *
 * Sacred x-axis alignment is handled separately by finplan-app.js
 * reading chartArea.left/right from data charts and applying padding
 * to this component — no canvas needed here.
 *
 * Adapted from <timeline-ledger>'s visual style.
 */

import { LitElement, html } from 'lit';
import { store } from '../finplan-store.js';
import { LifeEventType } from '../life-event.js';

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

    // ── Render ─────────────────────────────────────────────────────

    render() {
        const years = this._getYearRange();

        return html`
            <!-- Controls row -->
            <div class="flex items-center justify-center gap-3 mb-2">
                <select class="text-xs px-2 py-1.5 rounded-lg border border-gray-200 bg-gray-50 text-gray-700 cursor-pointer outline-none"
                    @change=${this._onYearChange}>
                    ${years.map(y => html`
                        <option value=${y} ?selected=${y === this.selectedYear}>${y}</option>
                    `)}
                </select>

                <select class="text-xs px-2 py-1.5 rounded-lg border border-gray-200 bg-gray-50 text-gray-700 cursor-pointer outline-none"
                    @change=${this._onMonthChange}>
                    ${MONTH_NAMES.map((name, i) => html`
                        <option value=${i + 1} ?selected=${(i + 1) === this.selectedMonth}>${name}</option>
                    `)}
                </select>
            </div>

            <!-- Timeline bar -->
            <div class="flex items-center px-2 gap-0 mb-1">
                <!-- Start anchor -->
                <div class="flex flex-col items-center flex-shrink-0" style="width: 28px;">
                    <div class="w-5 h-5 rounded text-xs font-bold flex items-center justify-center"
                        style="background: rgba(0,0,0,0.08); color: rgba(0,0,0,0.4);">S</div>
                </div>

                <div class="h-0.5 flex-1 rounded-full" style="background: rgba(0,0,0,0.12);"></div>

                <!-- Event dots -->
                ${this.lifeEvents.map((ev, i) => html`
                    <div class="flex flex-col items-center flex-shrink-0 cursor-pointer"
                         style="width: 28px;"
                         title="${ev.displayName}"
                         @click=${() => this._onSelectPhase(i)}>
                        <div class="rounded-full transition-transform"
                            style="width: ${this.selectedIndex === i ? '16px' : '12px'};
                                   height: ${this.selectedIndex === i ? '16px' : '12px'};
                                   background: ${LifeEventType.color(ev.type)};
                                   border: 2px solid ${LifeEventType.colorAccent(ev.type)};
                                   ${this.selectedIndex === i ? 'box-shadow: 0 0 0 3px white, 0 0 0 5px ' + LifeEventType.color(ev.type) + ';' : ''}">
                        </div>
                    </div>
                    ${i < this.lifeEvents.length - 1 ? html`
                        <div class="h-0.5 flex-1 rounded-full"
                            style="background: ${i < this.selectedIndex ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.08)'};"></div>
                    ` : ''}
                `)}

                <div class="h-0.5 flex-1 rounded-full" style="background: rgba(0,0,0,0.08);"></div>

                <!-- Finish anchor -->
                <div class="flex flex-col items-center flex-shrink-0" style="width: 28px;">
                    <div class="w-5 h-5 rounded text-xs font-bold flex items-center justify-center"
                        style="background: rgba(0,0,0,0.08); color: rgba(0,0,0,0.4);">F</div>
                </div>
            </div>

            <!-- Timeline labels -->
            <div class="flex items-start px-2 gap-0">
                <div class="flex flex-col items-center flex-shrink-0" style="width: 28px;">
                    <span class="text-xs text-gray-400">${this.startAge}</span>
                </div>
                <div class="flex-1"></div>
                ${this.lifeEvents.map((ev, i) => html`
                    <div class="flex flex-col items-center flex-shrink-0 cursor-pointer" style="width: 28px;"
                         @click=${() => this._onSelectPhase(i)}>
                        <span class="text-xs font-medium whitespace-nowrap"
                            style="color: ${this.selectedIndex === i ? LifeEventType.colorAccent(ev.type) : 'rgb(107,114,128)'};">
                            ${ev.displayName}
                        </span>
                        <span class="text-xs text-gray-400">${ev.triggerAge}</span>
                    </div>
                    ${i < this.lifeEvents.length - 1 ? html`<div class="flex-1"></div>` : ''}
                `)}
                <div class="flex-1"></div>
                <div class="flex flex-col items-center flex-shrink-0" style="width: 28px;">
                    <span class="text-xs text-gray-400">${this.finishAge}</span>
                </div>
            </div>
        `;
    }

    // ── Helpers ────────────────────────────────────────────────────

    _getYearRange() {
        const now = new Date().getFullYear();
        const birthYear = now - this.startAge;
        const startYear = birthYear + this.startAge;
        const finishYear = birthYear + this.finishAge;
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
            detail: { event: this.lifeEvents[index], index },
        }));
    }
}

customElements.define('finplan-timeline', FinplanTimeline);
