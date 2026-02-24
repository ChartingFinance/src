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
            return html``;
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
