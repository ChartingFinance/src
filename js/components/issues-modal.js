/**
 * <issues-modal>
 *
 * Lit component for submitting a bug report / feature request via mailto.
 *
 * Properties:
 *   open  - boolean
 *
 * Dispatches:
 *   'close'
 */

import { LitElement, html } from 'lit';

const ISSUES_EMAIL = 'john@charting.finance';

class IssuesModal extends LitElement {

    static properties = {
        open:    { type: Boolean, reflect: true },
        _title:  { state: true },
        _body:   { state: true },
    };

    createRenderRoot() { return this; }

    constructor() {
        super();
        this.open = false;
        this._title = '';
        this._body = '';
    }

    updated(changed) {
        if (changed.has('open') && this.open) {
            this._title = '';
            this._body = '';
        }
    }

    _onSend(ev) {
        ev.preventDefault();
        const subject = encodeURIComponent(this._title);
        const bodyText = encodeURIComponent(this._body);
        window.open(`mailto:${ISSUES_EMAIL}?subject=${subject}&body=${bodyText}`, '_blank');
        this._close();
    }

    _close() {
        this.open = false;
        this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
    }

    _onOverlayClick(ev) {
        if (ev.target === ev.currentTarget) this._close();
    }

    render() {
        if (!this.open) return html``;

        return html`
            <div class="popup fixed inset-0 z-50 flex items-center justify-center p-4"
                 @click=${this._onOverlayClick}>
                <div class="popup-content glass-card p-8 w-full max-w-md relative"
                     @click=${(e) => e.stopPropagation()}>
                    <button class="closeBtn absolute top-4 right-4 text-gray-400 hover:text-gray-800 text-2xl"
                        @click=${this._close}>&times;</button>

                    <div class="text-4xl mb-4 text-center">🐛</div>
                    <h2 class="text-2xl font-bold tracking-tight mb-2 text-center">Report an Issue</h2>
                    <p class="text-gray-500 mb-6 text-sm text-center">
                        Found a bug or have a suggestion? Send it directly to the team.
                    </p>

                    <form @submit=${this._onSend}>
                        <div class="flex flex-col gap-4">
                            <div class="flex flex-col gap-1">
                                <label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Title</label>
                                <input type="text" class="fin-input" required
                                    .value=${this._title}
                                    @input=${(e) => this._title = e.target.value}
                                    placeholder="Brief summary of the issue" />
                            </div>
                            <div class="flex flex-col gap-1">
                                <label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Description</label>
                                <textarea class="fin-input" rows="5" required
                                    .value=${this._body}
                                    @input=${(e) => this._body = e.target.value}
                                    placeholder="Steps to reproduce, expected vs. actual behavior, etc."></textarea>
                            </div>
                            <div class="flex gap-2 mt-2">
                                <button type="button" class="btn-modern outline flex-1"
                                    @click=${this._close}>Cancel</button>
                                <button type="submit" class="btn-modern primary flex-1">Send 📨</button>
                            </div>
                        </div>
                    </form>
                </div>
            </div>
        `;
    }
}

customElements.define('issues-modal', IssuesModal);