/**
 * <asset-list>
 *
 * Lit component that renders a list of asset cards.
 * Receives `modelAssets` array as a property.
 * Re-dispatches events from child <asset-card> elements.
 *
 * Also supports `readonly` mode (for simulator popup).
 */

import { LitElement, html } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { colorRange } from '../html.js';
import './asset-card.js';

class AssetList extends LitElement {

    static properties = {
        modelAssets: { type: Array },
        readonly: { type: Boolean },
        highlightName: { type: String, attribute: 'highlight-name' },
    };

    createRenderRoot() { return this; }

    constructor() {
        super();
        this.modelAssets = [];
        this.readonly = false;
        this.highlightName = null;
    }

    render() {
        if (!this.modelAssets || this.modelAssets.length === 0) {
            return html`
                <div class="flex flex-col items-center justify-center gap-4 py-16 text-center">
                    <div class="text-5xl">🚀</div>
                    <div class="text-lg font-semibold text-slate-700">Get started in seconds</div>
                    <div class="text-sm text-slate-400">Load an example portfolio to explore the simulator</div>
                    <button class="w-48 h-12 bg-black text-white rounded-full shadow-xl hover:scale-105 transition-transform font-medium text-base"
                        @click=${this._onQuickStart}>
                        Quick Start
                    </button>
                </div>
            `;
        }

        // Ensure colorIds are assigned
        this._assignColorIds();

        return html`
            ${repeat(
                this.modelAssets,
                (ma) => ma.displayName,
                (ma) => html`
                    <asset-card
                        .modelAsset=${ma}
                        ?readonly=${this.readonly}
                        ?selected=${this.highlightName === ma.displayName}
                    ></asset-card>
                `
            )}
        `;
    }

    _onQuickStart() {
        this.dispatchEvent(new CustomEvent('quick-start', { bubbles: true, composed: true }));
    }

    _assignColorIds() {
        let colorId = 0;
        for (const ma of this.modelAssets) {
            if (ma.colorId == null) {
                ma.colorId = colorId;
            }
            colorId = (colorId + 1) % colorRange.length;
        }
    }
}

customElements.define('asset-list', AssetList);
