/**
 * <share-modal>
 *
 * Lit component for sharing a portfolio via email.
 * Compresses the full portfolio state into a URL using lz-string,
 * then opens a mailto: link with the share URL embedded.
 *
 * Properties:
 *   open            - boolean
 *   modelAssets     - ModelAsset[]
 *   portfolioName   - string
 *   globalSettings  - { inflationRate, taxYear, filingAs, startAge, retirementAge, finishAge }
 *
 * Dispatches:
 *   'close'
 */

import { LitElement, html } from 'lit';

class ShareModal extends LitElement {

    static properties = {
        open:           { type: Boolean, reflect: true },
        modelAssets:    { type: Array },
        portfolioName:  { type: String },
        globalSettings: { type: Object },
        _name:          { state: true },
        _email:         { state: true },
        _shareUrl:      { state: true },
        _copied:        { state: true },
    };

    createRenderRoot() { return this; }

    constructor() {
        super();
        this.open = false;
        this.modelAssets = [];
        this.portfolioName = '';
        this.globalSettings = {};
        this._name = '';
        this._email = '';
        this._shareUrl = '';
        this._copied = false;
    }

    updated(changed) {
        if (changed.has('open') && this.open) {
            this._name = this.portfolioName || '';
            this._email = '';
            this._shareUrl = '';
            this._copied = false;
        }
    }

    _buildShareUrl() {
        // Clean model assets for serialization (remove circular refs)
        const cleanAssets = (this.modelAssets || []).map(a => {
            const copy = { ...a };
            delete copy.fromModel;
            delete copy.toModel;
            delete copy.metrics;
            delete copy.creditMemos;
            // Clean fund transfers too
            if (copy.fundTransfers) {
                copy.fundTransfers = copy.fundTransfers.map(ft => {
                    const ftCopy = { ...ft };
                    delete ftCopy.fromModel;
                    delete ftCopy.toModel;
                    return ftCopy;
                });
            }
            return copy;
        });

        const payload = {
            name: this._name,
            settings: this.globalSettings,
            modelAssets: cleanAssets,
        };

        const json = JSON.stringify(payload);
        const compressed = LZString.compressToEncodedURIComponent(json);
        const base = window.location.origin + window.location.pathname;
        return `${base}?portfolio=${compressed}`;
    }

    _onGenerate(ev) {
        ev.preventDefault();
        this._shareUrl = this._buildShareUrl();
        this._copied = false;
    }

    _onSend(ev) {
        ev.preventDefault();
        if (!this._shareUrl) {
            this._shareUrl = this._buildShareUrl();
        }

        const subject = encodeURIComponent(`Charting Finance Portfolio: ${this._name}`);
        const body = encodeURIComponent(
            `Hi,\n\nI'd like to share my financial portfolio "${this._name}" with you.\n\n` +
            `Click the link below to view it in Charting Finance:\n${this._shareUrl}\n\n` +
            `Best regards`
        );
        const mailto = `mailto:${encodeURIComponent(this._email)}?subject=${subject}&body=${body}`;
        window.open(mailto, '_blank');
    }

    async _onCopy() {
        try {
            await navigator.clipboard.writeText(this._shareUrl);
            this._copied = true;
        } catch {
            // Fallback for older browsers
            const textarea = document.createElement('textarea');
            textarea.value = this._shareUrl;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            this._copied = true;
        }
    }

    _onOverlayClick(ev) {
        if (ev.target === ev.currentTarget) this._close();
    }

    _close() {
        this.open = false;
        this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
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

                    <div class="text-4xl mb-4 text-center">📤</div>
                    <h2 class="text-2xl font-bold tracking-tight mb-2 text-center">Share Portfolio</h2>
                    <p class="text-gray-500 mb-6 text-sm text-center">
                        Share your portfolio with a CPA or financial advisor. All data is encoded in the link.
                    </p>

                    <form @submit=${this._onSend}>
                        <div class="flex flex-col gap-4">
                            <div class="flex flex-col gap-1">
                                <label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Portfolio Name</label>
                                <input type="text" class="fin-input" required
                                    .value=${this._name}
                                    @input=${(e) => { this._name = e.target.value; this._shareUrl = ''; this._copied = false; }}
                                    placeholder="e.g. Retirement Plan 2026">
                            </div>

                            <div class="flex flex-col gap-1">
                                <label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Recipient Email</label>
                                <input type="email" class="fin-input" required
                                    .value=${this._email}
                                    @input=${(e) => this._email = e.target.value}
                                    placeholder="advisor@example.com">
                            </div>

                            <div class="flex gap-2">
                                <button type="button" class="btn-modern outline flex-1"
                                    @click=${this._onGenerate}>
                                    Generate Link
                                </button>
                                <button type="submit" class="btn-modern primary flex-1">
                                    Send Email
                                </button>
                            </div>

                            ${this._shareUrl ? html`
                                <div class="flex flex-col gap-2 mt-2">
                                    <label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Share Link</label>
                                    <div class="flex gap-2">
                                        <input type="text" class="fin-input text-xs" readonly
                                            .value=${this._shareUrl}>
                                        <button type="button" class="btn-modern outline small whitespace-nowrap"
                                            @click=${this._onCopy}>
                                            ${this._copied ? 'Copied!' : 'Copy'}
                                        </button>
                                    </div>
                                </div>
                            ` : ''}
                        </div>
                    </form>
                </div>
            </div>
        `;
    }
}

customElements.define('share-modal', ShareModal);
