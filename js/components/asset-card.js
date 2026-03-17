/**
 * <asset-card>
 *
 * Lit component that renders a single financial asset card.
 * Receives a `modelAsset` object and optional `readonly` flag.
 * Dispatches: 'edit-asset', 'remove-asset', 'show-transfers', 'select-asset'
 */

import { LitElement, html } from 'lit';
import { InstrumentMeta, InstrumentType } from '../instruments/instrument.js';
import { colorRange } from '../utils/html.js';

function formatCompactCurrency(amount) {
    const num = parseFloat(amount);
    if (isNaN(num)) return '$0';
    const abs = Math.abs(num);
    const sign = num < 0 ? '-' : '';
    if (abs >= 1000000) return sign + '$' + (abs / 1000000).toFixed(1) + 'M';
    if (abs >= 1000) return sign + '$' + Math.round(abs / 1000).toLocaleString() + 'K';
    return sign + '$' + Math.round(abs);
}

class AssetCard extends LitElement {

    static properties = {
        modelAsset: { type: Object },
        readonly: { type: Boolean },
        selected: { type: Boolean, reflect: true },
        groupColor: { type: String },
        ghost: { type: Boolean },
        future: { type: Boolean },
        metricValue: { type: Number },  // override display value from history
        closedEmoji: { type: String },  // e.g. '⛔' when asset is closed at selected date
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
    }

    render() {
        if (!this.modelAsset) return html``;

        const ma = this.modelAsset;
        // Use stable group color when provided, fall back to legacy colorRange for simulator modal
        const color = this.groupColor || colorRange[ma.colorId] || colorRange[0];
        // Use single assetEmoji when groupColor is set (grouped sidebar), else legacy 2-char emoji
        const emoji = this.groupColor
            ? InstrumentType.assetEmoji(ma.instrument)
            : (InstrumentMeta.get(ma.instrument)?.emoji ?? '');

        // Display value: use metric history value if provided, else fall back to finish/start
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

        return html`
            <div class="asset glass-card p-4 ${this.selected ? 'selected-card-chart' : ''} ${stateClass}"
                 style="--card-color: ${color}; border-bottom: 4px solid ${color}"
                 @click=${this._onCardClick}>
                ${this.readonly ? '' : html`
                    <span class="asset-action-btn edit" title="Edit" @click=${this._onEdit}>&#x270E;</span>
                    <span class="asset-action-btn transfers" title="Transfers" @click=${this._onTransfers}>&#x21C4;</span>
                `}
                ${this.closedEmoji ? html`<div class="asset-card-icon" style="font-size: 12px; margin-right: -4px;">${this.closedEmoji}</div>` : ''}
                <div class="asset-card-icon">${emoji}</div>
                <div class="asset-card-name">${ma.displayName}</div>
                <div class="asset-card-value">${valueDisplay}</div>
                ${this.readonly ? '' : html`
                    <span class="asset-action-btn remove" title="Remove" @click=${this._onRemove}>&#x2715;</span>
                `}
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
