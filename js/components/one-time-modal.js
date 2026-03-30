/**
 * <one-time-modal>
 *
 * Lit component for managing one-time events (bonuses, gifts, weddings, tuition, etc.)
 * on an asset. Inline row editing — no third popup.
 *
 * Properties:
 *   open        - boolean
 *   modelAsset  - ModelAsset
 *
 * Dispatches:
 *   'save-one-times' { detail: { displayName, oneTimeEvents } }
 *   'close'
 */

import { LitElement, html } from 'lit';
import { OneTimeEvent } from '../one-time.js';
import { Currency } from '../utils/currency.js';
import { DateInt } from '../utils/date-int.js';

// Row shape:
//   event:      OneTimeEvent | null   (null = new, uncommitted row)
//   editing:    boolean
//   initDate:   string  (YYYY-MM — seed value for date input when entering edit mode)
//   initAmount: string  (seed value for amount input)
//   initNote:   string  (seed value for note input)

class OneTimeModal extends LitElement {

    static properties = {
        open:        { type: Boolean, reflect: true },
        modelAsset:  { type: Object },
        defaultDate: { type: String },
        _rows:       { state: true },
    };

    createRenderRoot() { return this; }

    constructor() {
        super();
        this.open = false;
        this.modelAsset = null;
        this.defaultDate = null;
        this._rows = [];
    }

    updated(changed) {
        if (changed.has('open') && this.open && this.modelAsset) {
            const existing = (this.modelAsset.oneTimeEvents || []).map(e => ({
                event: e,
                editing: false,
                initDate: e.dateInt.toHTML(),
                initAmount: e.amount.toHTML(),
                initNote: e.note,
            }));
            // Start with one empty edit row ready to fill in
            this._rows = [
                ...existing,
                { event: null, editing: true, initDate: this.defaultDate || DateInt.today().toHTML(), initAmount: '', initNote: '' },
            ];
        }
    }

    render() {
        if (!this.open || !this.modelAsset) return html``;
        const ma = this.modelAsset;
        const committed = this._rows.filter(r => !r.editing && r.event);
        const net = committed.reduce((s, r) => s + r.event.amount.amount, 0);

        return html`
            <div class="popup fixed inset-0 z-[60] flex items-center justify-center p-4"
                 @click=${this._onOverlayClick}>
                <div class="popup-content glass-card p-8 w-full max-w-2xl relative"
                     @click=${(e) => e.stopPropagation()}>
                    <button class="closeBtn absolute top-4 right-4 text-gray-400 hover:text-gray-800 text-2xl"
                        @click=${this._close}>&times;</button>

                    <!-- Header -->
                    <div class="mb-6">
                        <h2 class="text-2xl font-bold flex items-center gap-2">
                            💰 One-Time Events
                        </h2>
                        <p class="text-gray-500 text-sm mt-1">
                            ${ma.displayName}
                            ${net !== 0 ? html` · Net: <strong class="${net >= 0 ? '' : 'text-red-600'}">$${net.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>` : ''}
                        </p>
                    </div>

                    <!-- Rows + floating + button -->
                    <div class="relative mb-6" style="min-height: 48px;">
                        <div class="space-y-2 pr-10">
                            ${this._rows.length > 0
                                ? this._rows.map((row, i) => row.editing ? this._renderEditRow(row, i) : this._renderViewRow(row, i))
                                : html`<p class="text-gray-400 text-sm py-2">No one-time events yet.</p>`
                            }
                        </div>
                        <!-- Floating + button -->
                        <button type="button"
                            class="absolute bottom-0 right-0 w-8 h-8 rounded-full bg-blue-500 hover:bg-blue-600 text-white text-lg flex items-center justify-center shadow-md cursor-pointer"
                            title="Add one-time event"
                            @click=${this._onAddRow}>+</button>
                    </div>

                    <!-- Footer -->
                    <div class="flex justify-end pt-4 border-t border-gray-100">
                        <button type="button" class="btn-modern primary cursor-pointer"
                            @click=${this._onSaveAndClose}>
                            Save Changes ✨
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    _renderViewRow(row, index) {
        const e = row.event;
        const isNeg = e.amount.amount < 0;
        return html`
            <div class="flex items-center gap-3 p-3 rounded-xl bg-gray-50 border border-gray-100">
                <div class="flex-1 min-w-0">
                    <div class="text-sm font-semibold ${isNeg ? 'text-red-600' : 'text-gray-800'}">
                        $${e.amount.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                    <div class="text-xs text-gray-400">
                        ${e.dateInt.toHTML()}${e.note ? html` · ${e.note}` : ''}
                    </div>
                </div>
                <button type="button" class="text-gray-400 hover:text-blue-600 text-sm cursor-pointer"
                    title="Edit" @click=${() => this._onEditRow(index)}>&#x270E;</button>
                <button type="button" class="text-gray-400 hover:text-red-600 text-sm cursor-pointer"
                    title="Delete" @click=${() => this._onDeleteRow(index)}>&times;</button>
            </div>
        `;
    }

    _renderEditRow(row, index) {
        const isNew = row.event === null;
        return html`
            <div class="p-3 rounded-xl bg-blue-50 border border-blue-200" data-row="${index}">
                <div class="grid grid-cols-3 gap-2 mb-2">
                    <div>
                        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Date</label>
                        <input type="month" class="fin-input text-sm" name="otDate"
                            .value=${row.initDate} />
                    </div>
                    <div>
                        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Amount</label>
                        <input type="number" class="fin-input text-sm" name="otAmount"
                            .value=${row.initAmount}
                            step="0.01" placeholder="negative to debit" />
                    </div>
                    <div>
                        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Note</label>
                        <input type="text" class="fin-input text-sm" name="otNote"
                            .value=${row.initNote}
                            placeholder="e.g. Year-end bonus" />
                    </div>
                </div>
                <div class="flex justify-end gap-2">
                    <button type="button" class="btn-modern text-xs cursor-pointer" style="padding: 4px 10px;"
                        @click=${() => this._onCancelRow(index)}>
                        ${isNew ? 'Remove' : 'Cancel'}
                    </button>
                    <button type="button" class="btn-modern primary text-xs cursor-pointer" style="padding: 4px 10px;"
                        @click=${() => this._onSaveRow(index)}>
                        Save
                    </button>
                </div>
            </div>
        `;
    }

    // ── Row actions ───────────────────────────────────────────

    _onAddRow() {
        this._rows = [
            ...this._rows,
            { event: null, editing: true, initDate: this.defaultDate || DateInt.today().toHTML(), initAmount: '', initNote: '' },
        ];
    }

    _onEditRow(index) {
        const row = this._rows[index];
        this._rows = this._rows.map((r, i) => i === index
            ? { ...r, editing: true, initDate: row.event.dateInt.toHTML(), initAmount: row.event.amount.toHTML(), initNote: row.event.note }
            : r
        );
    }

    _onSaveRow(index) {
        const container = this.querySelector(`[data-row="${index}"]`);
        const dateVal   = container?.querySelector('[name="otDate"]')?.value;
        const amountVal = parseFloat(container?.querySelector('[name="otAmount"]')?.value);
        const noteVal   = container?.querySelector('[name="otNote"]')?.value?.trim() || '';

        if (!dateVal || isNaN(amountVal) || amountVal === 0) return;

        const event = new OneTimeEvent(DateInt.parse(dateVal), new Currency(amountVal), noteVal);
        this._rows = this._rows.map((r, i) => i === index
            ? { event, editing: false, initDate: dateVal, initAmount: String(amountVal), initNote: noteVal }
            : r
        );
    }

    _onCancelRow(index) {
        const row = this._rows[index];
        if (!row.event) {
            // New row — remove it
            this._rows = this._rows.filter((_, i) => i !== index);
        } else {
            // Existing row — revert to view
            this._rows = this._rows.map((r, i) => i === index ? { ...r, editing: false } : r);
        }
    }

    _onDeleteRow(index) {
        this._rows = this._rows.filter((_, i) => i !== index);
    }

    // ── Modal-level actions ───────────────────────────────────

    _onSaveAndClose() {
        // Collect only committed (non-editing) rows, sorted by date
        const events = this._rows
            .filter(r => !r.editing && r.event)
            .map(r => r.event)
            .sort((a, b) => a.dateInt.toInt() - b.dateInt.toInt());

        this.dispatchEvent(new CustomEvent('save-one-times', {
            bubbles: true, composed: true,
            detail: { displayName: this.modelAsset.displayName, oneTimeEvents: events },
        }));
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

customElements.define('one-time-modal', OneTimeModal);