/**
 * <windfall-modal>
 *
 * Lit component for managing windfalls (one-time lump sums) on an asset.
 * Provides full CRUD: add, edit, delete.
 *
 * Properties:
 *   open        - boolean
 *   modelAsset  - ModelAsset
 *
 * Dispatches:
 *   'save-windfalls' { detail: { displayName, windfalls } }
 *   'close'
 */

import { LitElement, html } from 'lit';
import { Windfall } from '../windfall.js';
import { Currency } from '../utils/currency.js';
import { DateInt } from '../utils/date-int.js';

class WindfallModal extends LitElement {

    static properties = {
        open:        { type: Boolean, reflect: true },
        modelAsset:  { type: Object },
        _windfalls:  { state: true },
        _editIndex:  { state: true },  // null = list, -1 = adding, >=0 = editing
    };

    createRenderRoot() { return this; }

    constructor() {
        super();
        this.open = false;
        this.modelAsset = null;
        this._windfalls = [];
        this._editIndex = null;
    }

    updated(changed) {
        if (changed.has('open') && this.open && this.modelAsset) {
            this._windfalls = (this.modelAsset.windfalls || []).map(w =>
                new Windfall(
                    new DateInt(w.dateInt.toInt()),
                    w.amount.copy(),
                    w.note
                )
            );
            this._editIndex = null;
        }
    }

    render() {
        if (!this.open || !this.modelAsset) return html``;

        const ma = this.modelAsset;
        const total = this._windfalls.reduce((s, w) => s + w.amount.amount, 0);

        return html`
            <div class="popup fixed inset-0 z-50 flex items-center justify-center p-4"
                 @click=${this._onOverlayClick}>
                <div class="popup-content glass-card p-8 w-full max-w-2xl relative"
                     @click=${(e) => e.stopPropagation()}>
                    <button class="closeBtn absolute top-4 right-4 text-gray-400 hover:text-gray-800 text-2xl"
                        @click=${this._close}>&times;</button>

                    <div class="mb-6">
                        <h2 class="text-2xl font-bold flex items-center gap-2">
                            💰 Windfalls
                        </h2>
                        <p class="text-gray-500 text-sm mt-1">
                            ${ma.displayName}
                            ${total > 0 ? html` · Total: <strong>$${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>` : ''}
                        </p>
                    </div>

                    <!-- Windfall list -->
                    <div class="space-y-2 mb-6">
                        ${this._windfalls.length > 0
                            ? this._windfalls.map((w, i) => this._renderRow(w, i))
                            : html`<p class="text-gray-400 text-sm p-4">No windfalls yet.</p>`
                        }
                    </div>

                    <!-- Add/Edit form -->
                    ${this._editIndex !== null
                        ? this._renderForm()
                        : html`
                            <button type="button" class="btn-modern w-full cursor-pointer"
                                @click=${() => this._editIndex = -1}>
                                + Add Windfall
                            </button>
                        `
                    }
                </div>
            </div>
        `;
    }

    _renderRow(w, index) {
        return html`
            <div class="flex items-center gap-3 p-3 rounded-xl bg-gray-50 border border-gray-100">
                <div class="flex-1 min-w-0">
                    <div class="text-sm font-semibold text-gray-800">
                        $${w.amount.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                    <div class="text-xs text-gray-400">
                        ${w.dateInt.toHTML()} ${w.note ? html`· ${w.note}` : ''}
                    </div>
                </div>
                <button type="button" class="text-gray-400 hover:text-blue-600 text-sm cursor-pointer"
                    @click=${() => this._editIndex = index}>&#x270E;</button>
                <button type="button" class="text-gray-400 hover:text-red-600 text-sm cursor-pointer"
                    @click=${() => this._onDelete(index)}>&times;</button>
            </div>
        `;
    }

    _renderForm() {
        const isNew = this._editIndex === -1;
        const w = isNew ? null : this._windfalls[this._editIndex];

        return html`
            <div class="p-4 rounded-xl bg-blue-50 border border-blue-200">
                <div class="text-xs font-semibold text-blue-600 uppercase tracking-wider mb-3">
                    ${isNew ? 'New Windfall' : 'Edit Windfall'}
                </div>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div>
                        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Date</label>
                        <input type="month" class="fin-input" name="wfDate"
                            .value=${w ? w.dateInt.toHTML() : DateInt.today().toHTML()} />
                    </div>
                    <div>
                        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Amount</label>
                        <input type="number" class="fin-input" name="wfAmount"
                            .value=${w ? w.amount.toHTML() : ''}
                            step="0.01" placeholder="$0.00" />
                    </div>
                    <div>
                        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Note</label>
                        <input type="text" class="fin-input" name="wfNote"
                            .value=${w ? w.note : ''}
                            placeholder="e.g. Year-end bonus" />
                    </div>
                </div>
                <div class="flex justify-end gap-3 mt-3">
                    <button type="button" class="btn-modern text-sm cursor-pointer"
                        @click=${() => this._editIndex = null}>Cancel</button>
                    <button type="button" class="btn-modern primary text-sm cursor-pointer"
                        @click=${this._onSaveEntry}>${isNew ? 'Add' : 'Save'}</button>
                </div>
            </div>
        `;
    }

    _onSaveEntry() {
        const container = this.querySelector('.popup-content');
        const dateInput = container.querySelector('[name="wfDate"]');
        const amountInput = container.querySelector('[name="wfAmount"]');
        const noteInput = container.querySelector('[name="wfNote"]');

        const dateVal = dateInput?.value;
        const amountVal = parseFloat(amountInput?.value);
        if (!dateVal || isNaN(amountVal) || amountVal === 0) return;

        const windfall = new Windfall(
            DateInt.parse(dateVal),
            new Currency(amountVal),
            noteInput?.value?.trim() || ''
        );

        const updated = [...this._windfalls];
        if (this._editIndex === -1) {
            updated.push(windfall);
        } else {
            updated[this._editIndex] = windfall;
        }

        // Sort by date
        updated.sort((a, b) => a.dateInt.toInt() - b.dateInt.toInt());
        this._windfalls = updated;
        this._editIndex = null;
        this._dispatchSave();
    }

    _onDelete(index) {
        const updated = [...this._windfalls];
        updated.splice(index, 1);
        this._windfalls = updated;
        this._dispatchSave();
    }

    _dispatchSave() {
        this.dispatchEvent(new CustomEvent('save-windfalls', {
            bubbles: true, composed: true,
            detail: {
                displayName: this.modelAsset.displayName,
                windfalls: this._windfalls,
            },
        }));
    }

    _close() {
        this.open = false;
        this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
    }

    _onOverlayClick(ev) {
        if (ev.target === ev.currentTarget) this._close();
    }
}

customElements.define('windfall-modal', WindfallModal);
