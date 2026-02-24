/**
 * <asset-card>
 *
 * Lit component that renders a single financial asset card.
 * Receives a `modelAsset` object and optional `readonly` flag.
 * Dispatches: 'edit-asset', 'remove-asset', 'show-transfers', 'select-asset'
 */

import { LitElement, html } from 'lit';
import { InstrumentMeta } from '../instrument.js';
import { colorRange } from '../html.js';

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
    }

    render() {
        if (!this.modelAsset) return html``;

        const ma = this.modelAsset;
        const color = colorRange[ma.colorId] || colorRange[0];
        const meta = InstrumentMeta.get(ma.instrument);
        const emoji = meta ? meta.emoji : '';

        // Display value: prefer finish value, fall back to start
        const finishVal = ma.finishCurrency ? ma.finishCurrency.toHTML() : '0.0';
        const displayAmount = parseFloat(finishVal) !== 0 ? finishVal : ma.startCurrency.toHTML();
        const valueDisplay = formatCompactCurrency(displayAmount);

        return html`
            <div class="asset glass-card p-4 ${this.selected ? 'selected-card-chart' : ''}"
                 style="--card-color: ${color}; border-left: 4px solid ${color}"
                 @click=${this._onCardClick}>
                ${this.readonly ? '' : html`
                    <span class="asset-action-btn edit" title="Edit" @click=${this._onEdit}>&#x270E;</span>
                    <span class="asset-action-btn transfers" title="Transfers" @click=${this._onTransfers}>&#x21C4;</span>
                `}
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
