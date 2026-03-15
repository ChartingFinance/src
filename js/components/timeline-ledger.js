/**
 * <timeline-ledger>
 *
 * Lit component that replaces <portfolio-ledger>.
 * Renders a horizontal timeline with life event dots, a phase summary bar
 * with inline ledger stats (opening, closing, CAGR), and dispatches events
 * when the user selects a phase.
 *
 * Dispatches:
 *   'phase-select'     — { detail: { event: ModelLifeEvent, index: number } }
 *   'event-edit'       — { detail: { event: ModelLifeEvent, index: number } }
 *   'event-add'        — { detail: {} }
 *   'ledger-metric1-change' — { detail: { metricName } }  (backward compat)
 *
 * Properties:
 *   portfolio   — Portfolio object (after chronometer_run)
 *   lifeEvents  — ModelLifeEvent[] sorted by triggerAge
 *   metricName  — current metric for ledger stats (default: 'value')
 *   selectedIndex — index of currently selected phase (default: 0)
 *   startAge    — from global settings (immutable anchor)
 *   finishAge   — from global settings (immutable anchor)
 */

import { LitElement, html } from 'lit';
import { Metric, MetricLabel } from '../model-asset.js';
import { LifeEventMeta, LifeEventType } from '../life-event.js';

class TimelineLedger extends LitElement {

  static properties = {
    portfolio:     { type: Object },
    lifeEvents:    { type: Array },
    metricName:    { type: String },
    selectedIndex: { type: Number },
    startAge:      { type: Number },
    finishAge:     { type: Number },
  };

  createRenderRoot() { return this; }

  constructor() {
    super();
    this.portfolio     = null;
    this.lifeEvents    = [];
    this.metricName    = Metric.VALUE;
    this.selectedIndex = 0;
    this.startAge      = 35;
    this.finishAge     = 90;
  }

  // ── Computed helpers ──────────────────────────────────────────

  get selectedEvent() {
    return this.lifeEvents[this.selectedIndex] ?? null;
  }

  get nextEvent() {
    return this.lifeEvents[this.selectedIndex + 1] ?? null;
  }

  _phaseLabel() {
    const ev = this.selectedEvent;
    if (!ev) return '';
    return ev.displayName;
  }

  _phaseSpan() {
    const ev = this.selectedEvent;
    if (!ev) return '';
    const startAge = ev.triggerAge;
    const endAge = this.nextEvent ? this.nextEvent.triggerAge : this.finishAge;
    return `Ages ${startAge}\u2013${endAge}`;
  }

  _phaseColor() {
    const ev = this.selectedEvent;
    return ev ? LifeEventType.color(ev.type) : '#888780';
  }

  _phaseColorAccent() {
    const ev = this.selectedEvent;
    return ev ? LifeEventType.colorAccent(ev.type) : '#5F5E5A';
  }

  // ── Ledger metric computation ─────────────────────────────────

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

  // ── Render ────────────────────────────────────────────────────

  render() {
    const startMetric  = this._computeMetricAtIndex(0);
    const finishMetric = this._computeMetricAtIndex(-1);
    const cagr         = this._computeCAGR(startMetric, finishMetric);
    const cagrPositive = cagr >= 0;

    return html`
      <div class="glass-card p-5 mb-8">

        <!-- Header row -->
        <div class="flex items-center justify-between mb-3">
          <div class="text-sm font-semibold text-gray-900">Your financial story</div>
          <div class="flex items-center gap-2">
            <select class="text-xs px-2 py-1 rounded-lg border border-gray-200 bg-gray-50 text-gray-500 cursor-pointer outline-none"
              @change=${this._onMetricChange}>
              ${Object.values(Metric).map(m => html`
                <option value=${m} ?selected=${m === this.metricName}>${MetricLabel[m]}</option>
              `)}
            </select>
            <button class="w-6 h-6 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-500 text-xs font-bold flex items-center justify-center transition-colors"
              title="Add life event"
              @click=${this._onAddEvent}>+</button>
          </div>
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
        <div class="flex items-start px-2 gap-0 mb-3">
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

        <!-- Phase summary bar -->
        <div class="flex items-center gap-3 px-3 py-2 rounded-xl"
          style="background: ${this._phaseColor()}12;">

          <span class="text-xs font-medium px-2.5 py-0.5 rounded-full cursor-pointer"
            style="background: ${this._phaseColor()}25; color: ${this._phaseColorAccent()};"
            @click=${this._onEditSelectedEvent}>
            ${this._phaseLabel()}
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

      </div>
    `;
  }

  // ── Event handlers ────────────────────────────────────────────

  _onSelectPhase(index) {
    this.selectedIndex = index;
    this.dispatchEvent(new CustomEvent('phase-select', {
      bubbles: true, composed: true,
      detail: { event: this.lifeEvents[index], index },
    }));
  }

  _onEditSelectedEvent() {
    if (!this.selectedEvent) return;
    this.dispatchEvent(new CustomEvent('event-edit', {
      bubbles: true, composed: true,
      detail: { event: this.selectedEvent, index: this.selectedIndex },
    }));
  }

  _onAddEvent() {
    this.dispatchEvent(new CustomEvent('event-add', {
      bubbles: true, composed: true,
      detail: {},
    }));
  }

  _onMetricChange(e) {
    this.metricName = e.target.value;
    this.dispatchEvent(new CustomEvent('ledger-metric1-change', {
      bubbles: true, composed: true,
      detail: { metricName: this.metricName },
    }));
  }
}

customElements.define('timeline-ledger', TimelineLedger);
