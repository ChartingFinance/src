/**
 * <funding-modal>
 *
 * Lit component for configuring real estate purchase funding.
 * Guides the user through outright purchase vs. down payment + mortgage.
 *
 * Properties:
 *   open         - boolean
 *   modelAssets  - ModelAsset[] (existing portfolio assets for source selection)
 *   purchasePrice - number (the real estate startValue)
 *   startDate    - string (the real estate start date as YYYY-MM)
 *
 * Dispatches:
 *   'funding-confirmed' { detail: { purchaseType, sourceDisplayName, downPaymentPercent } }
 *   'funding-cancelled'
 *   'close'
 */

import { LitElement, html } from 'lit';
import { InstrumentType, InstrumentMeta } from '../instruments/instrument.js';
import { colorRange } from '../utils/html.js';

class FundingModal extends LitElement {

    static properties = {
        open:           { type: Boolean, reflect: true },
        modelAssets:    { type: Array },
        purchasePrice:  { type: Number },
        startDate:      { type: String },
        _purchaseType:  { state: true },
        _selectedSource: { state: true },
        _downPaymentPercent: { state: true },
    };

    createRenderRoot() { return this; }

    constructor() {
        super();
        this.open = false;
        this.modelAssets = [];
        this.purchasePrice = 0;
        this.startDate = '';
        this._purchaseType = 'downPayment';
        this._selectedSource = null;
        this._downPaymentPercent = 20;
    }

    updated(changed) {
        if (changed.has('open') && this.open) {
            this._purchaseType = 'downPayment';
            this._selectedSource = null;
            this._downPaymentPercent = 20;
        }
    }

    render() {
        if (!this.open) return html``;

        const fundableAssets = this._getFundableAssets();
        const downAmount = this.purchasePrice * (this._downPaymentPercent / 100);
        const mortgageAmount = this.purchasePrice - downAmount;
        const isOutright = this._purchaseType === 'outright';
        const canConfirm = this._selectedSource != null;

        return html`
            <div class="popup fixed inset-0 z-50 flex items-center justify-center p-4"
                 @click=${this._onOverlayClick}>
                <div class="popup-content glass-card p-8 w-full max-w-2xl relative"
                     @click=${(e) => e.stopPropagation()}>
                    <button class="closeBtn absolute top-4 right-4 text-gray-400 hover:text-gray-800 text-2xl"
                        @click=${this._onCancel}>&times;</button>

                    <div class="mb-6">
                        <h2 class="text-2xl font-bold flex items-center gap-2">
                            🏡 Purchase Funding
                        </h2>
                        <p class="text-gray-500 text-sm mt-1">
                            Purchase price: <strong>$${this.purchasePrice.toLocaleString()}</strong>
                            ${this.startDate ? html` &middot; Starting: <strong>${this.startDate}</strong>` : ''}
                        </p>
                    </div>

                    <!-- Purchase type toggle -->
                    <div class="flex gap-3 mb-6">
                        <button type="button"
                            class="flex-1 p-4 rounded-xl border-2 text-center transition cursor-pointer
                                ${!isOutright ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'}"
                            @click=${() => this._purchaseType = 'downPayment'}>
                            <div class="text-lg font-bold mb-1">Down Payment + Mortgage</div>
                            <div class="text-xs">Fund a portion, finance the rest</div>
                        </button>
                        <button type="button"
                            class="flex-1 p-4 rounded-xl border-2 text-center transition cursor-pointer
                                ${isOutright ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'}"
                            @click=${() => this._purchaseType = 'outright'}>
                            <div class="text-lg font-bold mb-1">Outright Purchase</div>
                            <div class="text-xs">Pay full amount from one account</div>
                        </button>
                    </div>

                    <!-- Down payment percentage (only for downPayment type) -->
                    ${!isOutright ? html`
                        <div class="mb-6 p-4 bg-gray-50 rounded-xl border border-gray-100">
                            <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Down Payment Percentage</label>
                            <div class="flex items-center gap-4">
                                <input type="range" class="flex-1" min="1" max="99" step="1"
                                    .value=${String(this._downPaymentPercent)}
                                    @input=${(e) => this._downPaymentPercent = parseInt(e.target.value, 10)} />
                                <input type="number" class="fin-input w-20 text-center text-sm"
                                    min="1" max="99" step="1"
                                    .value=${String(this._downPaymentPercent)}
                                    @input=${(e) => this._downPaymentPercent = parseInt(e.target.value, 10) || 20} />
                                <span class="text-sm text-gray-400">%</span>
                            </div>
                            <div class="flex justify-between mt-2 text-sm">
                                <span class="text-gray-500">Down payment: <strong>$${downAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong></span>
                                <span class="text-gray-500">Mortgage: <strong>$${mortgageAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong></span>
                            </div>
                        </div>
                    ` : ''}

                    <!-- Funding source selection -->
                    <div class="mb-6">
                        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                            Select Funding Source
                        </label>
                        <div class="scrollable-y overflow-y-auto max-h-[250px] pr-2 space-y-3">
                            ${fundableAssets.length > 0
                                ? fundableAssets.map(ma => this._renderSourceCard(ma))
                                : html`<p class="text-gray-400 text-sm p-4">No fundable assets in portfolio. Add a savings or investment account first.</p>`
                            }
                        </div>
                    </div>

                    <!-- Confirm / Cancel -->
                    <div class="flex justify-center gap-4 pt-4 border-t border-gray-100">
                        <button class="btn-modern cursor-pointer"
                            @click=${this._onCancel}>
                            Cancel
                        </button>
                        <button class="btn-modern primary cursor-pointer"
                            ?disabled=${!canConfirm}
                            @click=${this._onConfirm}>
                            Confirm Funding
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    _getFundableAssets() {
        return this.modelAssets.filter(ma =>
            InstrumentType.isFundable(ma.instrument)
        );
    }

    _renderSourceCard(ma) {
        const color = colorRange[ma.colorId] || colorRange[0];
        const meta = InstrumentMeta.get(ma.instrument);
        const emoji = meta ? meta.emoji : '';
        const label = meta ? meta.label : '';
        const isSelected = this._selectedSource === ma.displayName;

        return html`
            <div class="glass-card p-4 cursor-pointer transition
                ${isSelected ? 'ring-2 ring-blue-500 bg-blue-50' : 'hover:bg-gray-50'}"
                style="border-left: 4px solid ${color}"
                @click=${() => this._selectedSource = ma.displayName}>
                <div class="flex items-center gap-3">
                    <div class="text-2xl">${emoji}</div>
                    <div class="flex-1 min-w-0">
                        <div class="text-sm font-semibold text-gray-800 truncate">${ma.displayName}</div>
                        <div class="text-xs text-gray-400">${label}</div>
                    </div>
                    <div class="text-sm font-semibold text-gray-600 whitespace-nowrap">${ma.startCurrency.toString()}</div>
                    ${isSelected ? html`<span class="text-blue-500 text-lg">&#x2713;</span>` : ''}
                </div>
            </div>
        `;
    }

    _onConfirm() {
        if (!this._selectedSource) return;

        const isOutright = this._purchaseType === 'outright';
        this.dispatchEvent(new CustomEvent('funding-confirmed', {
            bubbles: true, composed: true,
            detail: {
                purchaseType: this._purchaseType,
                sourceDisplayName: this._selectedSource,
                downPaymentPercent: isOutright ? 100 : this._downPaymentPercent,
            },
        }));

        this._close();
    }

    _onCancel() {
        this.open = false;
        this.dispatchEvent(new CustomEvent('funding-cancelled', { bubbles: true, composed: true }));
    }

    _close() {
        this.open = false;
        this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
    }

    _onOverlayClick(ev) {
        if (ev.target === ev.currentTarget) this._onCancel();
    }
}

customElements.define('funding-modal', FundingModal);
