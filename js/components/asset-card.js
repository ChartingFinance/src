/**
 * <asset-card>
 *
 * Lit component that renders a single financial asset card.
 * Three-row design: identity (emoji + name + value), sparkline, flow row.
 * Receives a `modelAsset` object and optional `readonly` flag.
 * Dispatches: 'edit-asset', 'remove-asset', 'show-transfers', 'select-asset'
 */

import { LitElement, html, svg, nothing } from 'lit';
import { InstrumentMeta, InstrumentType } from '../instruments/instrument.js';
import { colorRange, formatCompactCurrency } from '../utils/html.js';

function hexToRgba25(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.25)`;
}

class AssetCard extends LitElement {

    static properties = {
        modelAsset: { type: Object },
        readonly: { type: Boolean },
        selected: { type: Boolean, reflect: true },
        groupColor: { type: String },
        ghost: { type: Boolean },
        future: { type: Boolean },
        metricValue: { type: Number },
        closedEmoji: { type: String },
        valueHistory: { type: Array },      // full VALUE history (numbers) for sparkline
        historyIndex: { type: Number },     // cursor position for "you are here" dot
        inflow:  { type: Number },          // monthly inflow at cursor (green)
        growth:  { type: Number },          // monthly growth at cursor (blue)
        outflow: { type: Number },          // monthly outflow at cursor (red)
        taxHighlight: { type: Boolean },    // pulse animation from tax item click
    };

    createRenderRoot() { return this; }

    connectedCallback() {
        super.connectedCallback();
        this.style.display = 'contents';
    }

    constructor() {
        super();
        this.modelAsset = null;
        this.readonly = false;
        this.selected = false;
        this.groupColor = null;
        this.ghost = false;
        this.future = false;
        this.closedEmoji = '';
        this.valueHistory = null;
        this.historyIndex = -1;
        this.inflow = 0;
        this.growth = 0;
        this.outflow = 0;
        this.taxHighlight = false;
    }

    render() {
        if (!this.modelAsset) return html``;

        const ma = this.modelAsset;
        const color = this.groupColor || colorRange[ma.colorId] || colorRange[0];
        const emoji = this.groupColor
            ? InstrumentType.assetEmoji(ma.instrument)
            : (InstrumentMeta.get(ma.instrument)?.emoji ?? '');

        let displayAmount;
        if (this.metricValue != null) {
            displayAmount = this.metricValue;
        } else if (ma.isClosed && ma.closedValue) {
            displayAmount = ma.closedValue.toHTML();
        } else {
            const finishVal = ma.finishCurrency ? ma.finishCurrency.toHTML() : '0.0';
            displayAmount = parseFloat(finishVal) !== 0 ? finishVal : ma.startCurrency.toHTML();
        }
        const valueDisplay = formatCompactCurrency(displayAmount);

        const stateClass = this.ghost ? 'asset-ghost' : this.future ? 'asset-future' : '';

        const selectedStyle = this.selected
            ? `border-color: ${color}; box-shadow: 0 0 0 3px ${hexToRgba25(color)};`
            : '';
        return html`
            <div class="asset glass-card p-4 ${this.selected ? 'selected-card-chart' : ''} ${stateClass} ${this.taxHighlight ? 'tax-highlight-pulse' : ''}"
                 style="border-bottom: 4px solid ${color}; ${selectedStyle}"
                 @click=${this._onCardClick}>
                ${this.readonly ? '' : html`
                    <span class="asset-action-btn edit" title="Edit" @click=${this._onEdit}>&#x270E;</span>
                    <span class="asset-action-btn transfers" title="Transfers" @click=${this._onTransfers}>&#x21C4;</span>
                `}
                ${(this.closedEmoji || this.modelAsset.oneTimeEvents?.length) ? html`
                    <div class="asset-card-icon" style="display: flex; gap: 3px; justify-content: center; font-size: 12px;">
                        ${this.closedEmoji ? html`<span title="${this.closedEmoji === '⚠️' ? 'Account depleted — balance clamped to $0' : 'Closed'}">${this.closedEmoji}</span>` : ''}
                        ${this.modelAsset.oneTimeEvents?.length ? html`<span title="One-Time Events" style="cursor: pointer;" @click=${this._onOneTime}>&#x1F4B0;</span>` : ''}
                    </div>
                ` : ''}
                <div class="asset-card-icon">${emoji}</div>
                <div class="asset-card-name">${ma.displayName}</div>
                <div class="asset-card-value">${valueDisplay}</div>
                ${this._renderSparkline(color)}
                ${this._renderFlowRow()}
                ${this.readonly ? '' : html`
                    <span class="asset-action-btn remove" title="Remove" @click=${this._onRemove}>&#x2715;</span>
                `}
            </div>
        `;
    }

    _renderSparkline(color) {
        const data = this.valueHistory;
        if (!data || data.length < 2 || this.readonly) return nothing;

        const W = 100;
        const H = 32;
        const PAD = 3;

        let min = Infinity, max = -Infinity;
        for (let k = 0; k < data.length; k++) {
            const v = data[k];
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

        const dotIdx = Math.max(0, Math.min(this.historyIndex, data.length - 1));
        const dotX = PAD + (dotIdx / (data.length - 1)) * (W - 2 * PAD);
        const dotY = H - PAD - ((data[dotIdx] - min) / range) * (H - 2 * PAD);

        return html`
            <div class="asset-card-sparkline">
                <svg viewBox="0 0 ${W} ${H}"
                     style="width: 100%; height: 32px; display: block;">
                    ${svg`
                        <polyline points="${points.join(' ')}"
                                  fill="none" stroke="${color}" stroke-width="1.5"
                                  stroke-linejoin="round" stroke-linecap="round" />
                        <circle cx="${dotX}" cy="${dotY}" r="3"
                                fill="${color}" stroke="white" stroke-width="1" />
                    `}
                </svg>
            </div>
        `;
    }

    _renderFlowRow() {
        if (this.readonly) return nothing;
        const { inflow, growth, outflow } = this;
        if (!inflow && !growth && !outflow) return nothing;

        return html`
            <div class="asset-card-flows">
                ${inflow  ? html`<span class="flow-in"  title="Monthly inflow: ${formatCompactCurrency(inflow)}">↗${formatCompactCurrency(inflow)}</span>` : ''}
                ${growth  ? html`<span class="flow-grow" title="Monthly growth: ${formatCompactCurrency(growth)}">↑${formatCompactCurrency(growth)}</span>` : ''}
                ${outflow ? html`<span class="flow-out"  title="Monthly outflow: ${formatCompactCurrency(outflow)}">↙${formatCompactCurrency(outflow)}</span>` : ''}
            </div>
        `;
    }

    _onEdit(ev) {
        ev.stopPropagation();
        this.dispatchEvent(new CustomEvent('edit-asset', {
            bubbles: true, composed: true,
            detail: { modelAsset: this.modelAsset },
        }));
    }

    _onTransfers(ev) {
        ev.stopPropagation();
        this.dispatchEvent(new CustomEvent('show-transfers', {
            bubbles: true, composed: true,
            detail: { modelAsset: this.modelAsset },
        }));
    }

    _onOneTime(ev) {
        ev.stopPropagation();
        this.dispatchEvent(new CustomEvent('show-one-times', {
            bubbles: true, composed: true,
            detail: { modelAsset: this.modelAsset },
        }));
    }

    _onRemove(ev) {
        ev.stopPropagation();
        this.dispatchEvent(new CustomEvent('remove-asset', {
            bubbles: true, composed: true,
            detail: { modelAsset: this.modelAsset },
        }));
    }

    _onCardClick(ev) {
        if (ev.target.closest('.asset-action-btn')) return;
        this.dispatchEvent(new CustomEvent('select-asset', {
            bubbles: true, composed: true,
            detail: { modelAsset: this.modelAsset },
        }));
    }
}

customElements.define('asset-card', AssetCard);
