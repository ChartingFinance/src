/**
 * <asset-form-modal>
 *
 * Lit component for creating and editing financial assets.
 * Handles both create and edit modes via the `mode` property.
 *
 * Properties:
 *   mode        - 'create' | 'edit'
 *   open        - boolean
 *   modelAsset  - ModelAsset (for edit mode pre-fill)
 *
 * Dispatches:
 *   'save-asset'  { detail: { modelAsset, mode } }
 *   'close'
 */

import { LitElement, html } from 'lit';
import { InstrumentType } from '../instrument.js';
import { membrane_htmlElementToAssetModel } from '../membrane.js';
import { DateInt } from '../date-int.js';

class AssetFormModal extends LitElement {

    static properties = {
        mode:           { type: String },
        open:           { type: Boolean, reflect: true },
        modelAsset:     { type: Object },
        _instrument:    { state: true },
    };

    createRenderRoot() { return this; }

    constructor() {
        super();
        this.mode = 'create';
        this.open = false;
        this.modelAsset = null;
        this._instrument = null;
    }

    updated(changed) {
        if (changed.has('open') && this.open) {
            // Set initial instrument for conditional fields
            if (this.mode === 'edit' && this.modelAsset) {
                this._instrument = this.modelAsset.instrument;
            } else {
                this._instrument = null;
            }
        }
    }

    render() {
        if (!this.open) return html``;

        const isEdit = this.mode === 'edit';
        const ma = this.modelAsset;
        const instruments = InstrumentType.all();

        // Pre-fill values for edit mode
        const displayName = isEdit && ma ? ma.displayName : '';
        const startDate = isEdit && ma ? ma.startDateInt.toHTML() : DateInt.today().toHTML();
        const startValue = isEdit && ma ? ma.startCurrency.toHTML() : '';
        const finishDate = isEdit && ma ? ma.finishDateInt.toHTML() : '';
        const finishValue = isEdit && ma && ma.finishCurrency ? ma.finishCurrency.toHTML() : '0.0';
        const annualReturn = isEdit && ma ? ma.annualReturnRate.toHTML() : '';
        const selectedInstrument = this._instrument || (isEdit && ma ? ma.instrument : '');

        return html`
            <div class="popup fixed inset-0 z-50 flex items-center justify-center p-4"
                 @click=${this._onOverlayClick}>
                <div class="popup-content glass-card p-8 w-full max-w-3xl relative"
                     @click=${(e) => e.stopPropagation()}>
                    <button class="closeBtn absolute top-4 right-4 text-gray-400 hover:text-gray-800 text-2xl"
                        @click=${this._close}>&times;</button>
                    <div class="mb-6">
                        <h2 class="text-2xl font-bold flex items-center gap-2">
                            ${isEdit ? '✏️ Edit Instrument' : '✨ Add New Instrument'}
                        </h2>
                        <p class="text-gray-500 text-sm mt-1">
                            ${isEdit
                                ? 'Modify the details of your financial instrument below.'
                                : 'Finish value and returns are computed on simulation run.'}
                        </p>
                    </div>
                    <form @submit=${this._onSubmit}>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Instrument</label>
                                <select class="fin-input" name="instrument"
                                    @change=${this._onInstrumentChange}>
                                    ${instruments.map(inst => html`
                                        <option value=${inst.key}
                                            ?selected=${inst.key === selectedInstrument}
                                        >${inst.label}</option>
                                    `)}
                                </select>
                            </div>
                            <div>
                                <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Familiar Name</label>
                                <input type="text" class="fin-input" name="displayName"
                                    .value=${displayName}
                                    placeholder="e.g. Dream House" />
                            </div>
                            <div>
                                <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Start Date</label>
                                <input type="month" class="fin-input" name="startDate"
                                    .value=${startDate} required />
                            </div>
                            <div>
                                <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Start Value</label>
                                <input type="number" class="fin-input" name="startValue"
                                    .value=${startValue}
                                    step="0.01" placeholder="$0.00" required />
                            </div>
                            <div>
                                <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Finish Date</label>
                                <input type="month" class="fin-input" name="finishDate"
                                    .value=${finishDate} required />
                            </div>
                            <div>
                                <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Finish Value</label>
                                <input type="number" class="fin-input bg-gray-100 text-gray-400" name="finishValue"
                                    .value=${finishValue}
                                    step="0.01" placeholder="Computed automatically" disabled />
                            </div>
                            <div>
                                <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Annual Return %</label>
                                <input type="number" class="fin-input" name="annualReturnRate"
                                    .value=${annualReturn}
                                    step="0.01" placeholder="e.g. 0.07" required />
                            </div>
                        </div>
                        ${this._renderInstrumentFields(selectedInstrument, ma)}
                        <div class="mt-8 flex justify-end">
                            <input type="submit" class="btn-modern primary cursor-pointer"
                                .value=${isEdit ? 'Save Changes ✨' : 'Add to Stack 🚀'} />
                        </div>
                    </form>
                </div>
            </div>
        `;
    }

    _renderInstrumentFields(instrument, ma) {
        if (!instrument) return html``;

        if (InstrumentType.isMonthlyIncome(instrument)) {
            const checked = ma && ma.isSelfEmployed;
            return html`
                <div class="instrument-fields mt-6 border-t border-gray-100 pt-6">
                    <div class="instrument-fields-grid">
                        <div class="form-field">
                            <label class="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" name="isSelfEmployed" ?checked=${checked} />
                                Self-Employed
                            </label>
                        </div>
                    </div>
                </div>
            `;
        }

        if (InstrumentType.isMonthsRemainingAble(instrument)) {
            const monthsVal = ma ? ma.monthsRemaining : 0;
            return html`
                <div class="instrument-fields mt-6 border-t border-gray-100 pt-6">
                    <div class="instrument-fields-grid">
                        <div class="form-field">
                            <label>Months Remaining</label>
                            <input type="number" class="width-full" name="monthsRemaining"
                                .value=${String(monthsVal)} placeholder="months" />
                        </div>
                    </div>
                </div>
            `;
        }

        if (InstrumentType.isTaxableAccount(instrument)) {
            const basisVal = ma ? ma.basisCurrency.toHTML() : '0';
            const divVal = ma ? ma.annualDividendRate.toHTML() : '0';
            const ltVal = ma ? ma.longTermCapitalGainRate.toHTML() : '0';
            return html`
                <div class="instrument-fields mt-6 border-t border-gray-100 pt-6">
                    <div class="instrument-fields-grid">
                        <div class="form-field">
                            <label>Basis Value</label>
                            <input type="number" class="width-full" name="basisValue"
                                .value=${basisVal} step="0.01" placeholder="original cost" />
                        </div>
                        <div class="form-field">
                            <label>Dividend Rate %</label>
                            <input type="number" class="width-full" name="dividendRate"
                                .value=${divVal} step="0.01" placeholder="annual %" />
                        </div>
                        <div class="form-field">
                            <label>Long-Term Rate %</label>
                            <input type="number" class="width-full" name="longTermRate"
                                .value=${ltVal} step="0.01" placeholder="annual %" />
                        </div>
                    </div>
                </div>
            `;
        }

        if (InstrumentType.isHome(instrument)) {
            const basisVal = ma ? ma.basisCurrency.toHTML() : '0';
            return html`
                <div class="instrument-fields mt-6 border-t border-gray-100 pt-6">
                    <div class="instrument-fields-grid">
                        <div class="form-field">
                            <label>Basis Value</label>
                            <input type="number" class="width-full" name="basisValue"
                                .value=${basisVal} step="0.01" placeholder="original cost" />
                        </div>
                    </div>
                </div>
            `;
        }

        return html``;
    }

    _onInstrumentChange(ev) {
        this._instrument = ev.target.value;
    }

    _onSubmit(ev) {
        ev.preventDefault();
        const form = ev.target;
        const assetModel = membrane_htmlElementToAssetModel(form);

        this.dispatchEvent(new CustomEvent('save-asset', {
            bubbles: true, composed: true,
            detail: { modelAsset: assetModel, mode: this.mode },
        }));

        if (this.mode === 'create') {
            form.reset();
        }

        this._close();
    }

    _close() {
        this.open = false;
        this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
    }

    _onOverlayClick(ev) {
        if (ev.target === ev.currentTarget) this._close();
    }
}

customElements.define('asset-form-modal', AssetFormModal);
