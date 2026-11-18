/**
 * <event-form-modal>
 *
 * Lit component for creating and editing life events on the timeline.
 * Handles create, edit, and delete modes.
 *
 * Properties:
 *   mode        - 'create' | 'edit'
 *   open        - boolean
 *   lifeEvent   - ModelLifeEvent (for edit mode pre-fill)
 *   editIndex   - number (index in appState.lifeEvents array)
 *   modelAssets - ModelAsset[] (for closes multi-select)
 *
 * Dispatches:
 *   'save-life-event'    { detail: { lifeEvent, index, mode } }
 *   'delete-life-event'  { detail: { index } }
 *   'close'
 */

import { LitElement, html } from 'lit';
import { LifeEvent, LifeEventMeta, ModelLifeEvent, isCloseTemplate } from '../life-event.js';
import { InstrumentMeta } from '../instruments/instrument.js';
import { global_user_startAge, global_user_finishAge } from '../globals.js';

class EventFormModal extends LitElement {

    static properties = {
        mode:           { type: String },
        open:           { type: Boolean, reflect: true },
        lifeEvent:      { type: Object },
        editIndex:      { type: Number },
        eventCount:     { type: Number },
        modelAssets:    { type: Array },
        _selectedType:  { state: true },
        _closes:        { state: true },
    };

    createRenderRoot() { return this; }

    constructor() {
        super();
        this.mode = 'create';
        this.open = false;
        this.lifeEvent = null;
        this.editIndex = -1;
        this.eventCount = 1;
        this.modelAssets = [];
        this._selectedType = null;
        this._closes = [];
    }

    updated(changed) {
        if (changed.has('open') && this.open) {
            if (this.mode === 'edit' && this.lifeEvent) {
                this._selectedType = this.lifeEvent.type;
                this._closes = structuredClone(this.lifeEvent.closes);
            } else {
                this._selectedType = null;
                this._closes = [];
            }
        }
    }

    render() {
        if (!this.open) return html``;

        const isEdit = this.mode === 'edit';
        const le = this.lifeEvent;
        const meta = this._selectedType ? LifeEventMeta.get(this._selectedType) : null;

        return html`
            <div class="popup fixed inset-0 z-50 flex items-center justify-center p-4"
                 @click=${this._onOverlayClick}>
                <div class="popup-content glass-card p-8 w-full max-w-lg relative"
                     @click=${(e) => e.stopPropagation()}>
                    <button class="closeBtn absolute top-4 right-4 text-gray-400 hover:text-gray-800 text-2xl"
                        @click=${this._close}>&times;</button>
                    <div class="mb-6">
                        <h2 class="text-2xl font-bold flex items-center gap-2">
                            ${isEdit ? 'Edit Life Event' : 'Add Life Event'}
                        </h2>
                        <p class="text-gray-500 text-sm mt-1">
                            ${isEdit
                                ? 'Modify this event on your financial timeline.'
                                : 'Add a new event to your financial timeline.'}
                        </p>
                    </div>

                    ${this._renderTypeSelector(isEdit, le)}

                    ${this._selectedType ? this._renderForm(isEdit, le, meta) : html``}
                </div>
            </div>
        `;
    }

    _renderTypeSelector(isEdit, le) {
        const types = [...LifeEventMeta.entries()];

        if (isEdit) {
            const meta = LifeEventMeta.get(le.type);
            return html`
                <div class="mb-6">
                    <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Event Type</label>
                    <span class="inline-block px-4 py-2 rounded-xl text-sm font-semibold text-white"
                        style="background: ${meta.color}">${meta.label}</span>
                </div>
            `;
        }

        return html`
            <div class="mb-6">
                <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Event Type</label>
                <div class="flex flex-wrap gap-2">
                    ${types.map(([key, meta]) => html`
                        <button type="button"
                            class="px-4 py-2 rounded-xl text-sm font-semibold transition cursor-pointer"
                            style="background: ${this._selectedType === key ? meta.color : '#f3f4f6'};
                                   color: ${this._selectedType === key ? 'white' : '#374151'};
                                   outline: ${this._selectedType === key ? `2px solid ${meta.colorAccent}` : 'none'}"
                            @click=${() => this._onTypeSelect(key)}>
                            ${meta.label}
                        </button>
                    `)}
                </div>
            </div>
        `;
    }

    _renderForm(isEdit, le, meta) {
        const displayName = isEdit && le ? le.displayName : meta.label;
        const triggerAge = isEdit && le ? le.triggerAge : global_user_startAge;
        const assets = this.modelAssets || [];

        return html`
            <form @submit=${this._onSubmit}>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Display Name</label>
                        <input type="text" class="fin-input" name="displayName"
                            .value=${displayName} required />
                    </div>
                    <div>
                        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Trigger Age</label>
                        <input type="number" class="fin-input" name="triggerAge"
                            .value=${String(triggerAge)}
                            min=${global_user_startAge} max=${global_user_finishAge}
                            ?disabled=${isEdit && le?.type === LifeEvent.ACCUMULATE} required />
                    </div>
                </div>

                ${assets.length > 0 ? html`
                    <div class="mt-6 border-t border-gray-100 pt-6">
                        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Close Assets on Event</label>
                        <div class="flex flex-wrap gap-2 mb-2">
                            ${this._closeTypes(assets).map(instrument => html`
                                <label class="flex items-center gap-2 px-3 py-2 rounded-xl text-sm cursor-pointer transition
                                    ${this._closesType(instrument)
                                        ? 'bg-red-50 text-red-700 border border-red-200'
                                        : 'bg-gray-50 text-gray-600 border border-gray-100 hover:bg-gray-100'}"
                                    title="Every ${InstrumentMeta.get(instrument)?.label ?? instrument} asset already running when this event happens, whatever it is called">
                                    <input type="checkbox" class="rounded"
                                        .checked=${this._closesType(instrument)}
                                        @change=${(e) => this._onCloseTypeToggle(instrument, e.target.checked)} />
                                    Every ${InstrumentMeta.get(instrument)?.label ?? instrument}
                                </label>
                            `)}
                        </div>
                        <div class="flex flex-wrap gap-2">
                            ${assets.map(a => {
                                // Covered by a template: closed when the event
                                // happens if it is running then, without a tick of its own.
                                const byType = this._closesType(a.instrument);
                                const closed = byType || this._closes.includes(a.id);
                                return html`
                                <label class="flex items-center gap-2 px-3 py-2 rounded-xl text-sm transition
                                    ${byType ? 'cursor-default' : 'cursor-pointer'}
                                    ${closed
                                        ? 'bg-red-50 text-red-700 border border-red-200'
                                        : 'bg-gray-50 text-gray-600 border border-gray-100 hover:bg-gray-100'}"
                                    title=${byType ? `Closed by "Every ${InstrumentMeta.get(a.instrument)?.label ?? a.instrument}", if it is running then` : ''}>
                                    <input type="checkbox" class="rounded"
                                        .checked=${closed}
                                        ?disabled=${byType}
                                        @change=${(e) => this._onCloseToggle(a.id, e.target.checked)} />
                                    ${a.displayName}
                                </label>
                            `;
                            })}
                        </div>
                    </div>
                ` : html``}

                <div class="mt-8 flex ${isEdit && this.eventCount > 1 ? 'justify-between' : 'justify-end'} items-center">
                    ${isEdit && this.eventCount > 1 ? html`
                        <button type="button" class="text-sm text-red-500 hover:text-red-700 font-semibold cursor-pointer"
                            @click=${this._onDelete}>Delete Event</button>
                    ` : html``}
                    <input type="submit" class="btn-modern primary cursor-pointer"
                        .value=${isEdit ? 'Save Changes' : 'Add Event'} />
                </div>
            </form>
        `;
    }

    _onTypeSelect(type) {
        this._selectedType = type;
        const meta = LifeEventMeta.get(type);
        // The phase holds ids and templates; a default that names an asset is
        // turned into its id. A template is copied, not shared with the meta.
        const idOf = (name) => (this.modelAssets || []).find((a) => a.displayName === name)?.id ?? name;
        this._closes = (meta.defaultMutations.closes || [])
            .map((entry) => (typeof entry === 'string' ? idOf(entry) : structuredClone(entry)));
    }

    /**
     * The asset types offered as templates: each type among the plan's assets,
     * in the usual order, and any type the phase already closes.
     */
    _closeTypes(assets) {
        const types = new Set(assets.map((a) => a.instrument));
        for (const entry of this._closes) if (isCloseTemplate(entry)) types.add(entry.instrument);
        const order = (t) => InstrumentMeta.get(t)?.sortOrder ?? 99;
        return [...types].sort((a, b) => order(a) - order(b));
    }

    /** True when the phase closes every asset of this type (a template). */
    _closesType(instrument) {
        return this._closes.some((entry) => isCloseTemplate(entry) && entry.instrument === instrument);
    }

    _onCloseTypeToggle(instrument, checked) {
        const others = this._closes.filter((entry) => !(isCloseTemplate(entry) && entry.instrument === instrument));
        this._closes = checked ? [...others, { instrument }] : others;
    }

    /** Closes are held by asset id (plan-ids.js). */
    _onCloseToggle(id, checked) {
        if (checked) {
            this._closes = [...this._closes, id];
        } else {
            this._closes = this._closes.filter(entry => entry !== id);
        }
    }

    _onSubmit(ev) {
        ev.preventDefault();
        const form = ev.target;

        const editing = this.mode === 'edit' && this.lifeEvent;
        const lifeEvent = new ModelLifeEvent({
            // An edit is the same phase under new settings, so it keeps its id.
            id: editing ? this.lifeEvent.id : null,
            type: this._selectedType,
            displayName: form.querySelector('[name=displayName]').value.trim(),
            triggerAge: parseInt(form.querySelector('[name=triggerAge]').value, 10),
            closes: [...this._closes],
            phaseTransfers: editing ? this.lifeEvent.phaseTransfers : {},
            globalOverrides: editing ? this.lifeEvent.globalOverrides : {},
        });

        this.dispatchEvent(new CustomEvent('save-life-event', {
            bubbles: true, composed: true,
            detail: { lifeEvent, index: this.editIndex, mode: this.mode },
        }));

        this._close();
    }

    _onDelete() {
        this.dispatchEvent(new CustomEvent('delete-life-event', {
            bubbles: true, composed: true,
            detail: { index: this.editIndex },
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

customElements.define('event-form-modal', EventFormModal);
