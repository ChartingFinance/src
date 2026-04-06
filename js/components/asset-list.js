/**
 * <asset-list>
 *
 * Lit component that renders assets grouped by financial category in horizontal columns.
 * Groups: Income, Capital, Real Estate, Retirement, Expenses, Taxes.
 * Each column has a header with emoji, label, roll-up total, and chevron toggle.
 * Individual assets render as <asset-card> children stacked vertically within each column.
 *
 * Also supports `readonly` mode (for simulator popup) — renders flat list with legacy colors.
 *
 * Dispatches: group-toggle, quick-start (re-dispatches child card events)
 */

import { LitElement, html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { colorRange } from '../utils/html.js';
import {
    AssetGroup, AssetGroupMeta, TaxItem, TaxItemMeta,
    classifyAssets, getGroupLabel, getAssetChartColor,
} from '../asset-groups.js';
import { LifeEventType } from '../life-event.js';

import { computeAssetFlows } from '../utils/asset-flow.js';
import './asset-card.js';

/** Standard group order for horizontal columns */
const HORIZONTAL_GROUP_ORDER = [
    AssetGroup.INCOME,
    AssetGroup.CAPITAL,
    AssetGroup.REAL_ESTATE,
    AssetGroup.RETIREMENT,
    AssetGroup.EXPENSES,
    AssetGroup.TAXES,
];

function formatCompactCurrency(amount) {
    const num = typeof amount === 'number' ? amount : parseFloat(amount);
    if (isNaN(num)) return '$0';
    const abs = Math.abs(num);
    const sign = num < 0 ? '-' : '';
    if (abs >= 1000000) return sign + '$' + (abs / 1000000).toFixed(1) + 'M';
    if (abs >= 1000) return sign + '$' + Math.round(abs / 1000).toLocaleString() + 'K';
    return sign + '$' + Math.round(abs);
}

class AssetList extends LitElement {

    static properties = {
        modelAssets: { type: Array },
        readonly: { type: Boolean },
        highlightName: { type: String, attribute: 'highlight-name' },
        expandedGroups: { type: Object },   // Set<AssetGroup key>
        activeLifeEvent: { type: Object },  // ModelLifeEvent — for contextual group labels
        portfolio: { type: Object },        // Portfolio — for Taxes group metrics
        atDateInt: { type: Object },        // DateInt — classify active/closed at this date
        metricName: { type: String },       // Metric key — look up history value at historyIndex
        historyIndex: { type: Number },     // Month offset into history[] for metric display
    };

    createRenderRoot() { return this; }

    constructor() {
        super();
        this.modelAssets = [];
        this.readonly = false;
        this.highlightName = null;
        this.expandedGroups = null;
        this.activeLifeEvent = null;
        this.portfolio = null;
        this.atDateInt = null;
        this.metricName = null;
        this.historyIndex = -1;
    }

    render() {
        if (!this.modelAssets || this.modelAssets.length === 0) {
            return nothing;
        }

        // Readonly mode (simulator popup): flat list with legacy colors
        if (this.readonly) {
            this._assignColorIds();
            return html`
                ${repeat(
                    this.modelAssets,
                    (ma) => ma.displayName,
                    (ma) => html`
                        <asset-card
                            .modelAsset=${ma}
                            ?readonly=${true}
                            ?selected=${this.highlightName === ma.displayName}
                        ></asset-card>
                    `
                )}
            `;
        }

        return this._renderHorizontalGroups();
    }

    _renderHorizontalGroups() {
        const groups = classifyAssets(this.modelAssets, this.atDateInt);
        const expanded = this.expandedGroups || new Set();

        return html`
            <div class="asset-group-columns">
                ${HORIZONTAL_GROUP_ORDER.map(groupKey => {
                    if (groupKey === AssetGroup.TAXES) {
                        return this._renderTaxesColumn(expanded.has(groupKey));
                    }
                    const assets = groups.get(groupKey);
                    if (!assets || assets.length === 0) return nothing;
                    return this._renderGroupColumn(groupKey, assets, expanded.has(groupKey));
                })}
            </div>
        `;
    }

    _renderGroupColumn(groupKey, assets, isExpanded) {
        const meta = AssetGroupMeta.get(groupKey);
        const label = getGroupLabel(groupKey, this.activeLifeEvent);
        const total = this._computeRollupTotal(groupKey, assets);

        return html`
            <div class="asset-group-column">
                <div class="asset-group-header"
                     style="background: ${meta.headerBg}; color: ${meta.headerFg}"
                     @click=${() => this._onGroupToggle(groupKey)}>
                    <span class="asset-group-emoji">${meta.groupEmoji}</span>
                    <span class="asset-group-label">${label}</span>
                    <span class="asset-group-total">${total}</span>
                    <span class="asset-group-chevron ${isExpanded ? 'expanded' : ''}">&#x25B6;</span>
                </div>
                <div class="asset-group-children ${isExpanded ? '' : 'collapsed'}">
                    ${repeat(
                        assets,
                        (ma) => ma.displayName,
                        (ma) => {
                            const history = ma.getHistory?.('value') || [];
                            const flows = isExpanded ? computeAssetFlows(ma, this.historyIndex) : { inflow: 0, growth: 0, outflow: 0 };
                            return html`
                                <asset-card
                                    .modelAsset=${ma}
                                    .groupColor=${getAssetChartColor(ma.instrument)}
                                    .metricValue=${this._getMetricValue(ma)}
                                    .valueHistory=${history}
                                    .historyIndex=${this.historyIndex}
                                    .inflow=${flows.inflow}
                                    .growth=${flows.growth}
                                    .outflow=${flows.outflow}
                                    ?ghost=${ma._isClosedAtDate}
                                    .closedEmoji=${ma._isClosedAtDate ? '⛔' : ma.isDepleted ? '⚠️' : ''}
                                    ?selected=${this.highlightName === ma.displayName}
                                ></asset-card>
                            `;
                        }
                    )}
                </div>
            </div>
        `;
    }

    _renderTaxesColumn(isExpanded) {
        if (!this.portfolio) return nothing;

        const taxItems = this._computeTaxItems();
        if (taxItems.length === 0) return nothing;

        const meta = AssetGroupMeta.get(AssetGroup.TAXES);
        const label = getGroupLabel(AssetGroup.TAXES, this.activeLifeEvent);
        const total = taxItems.reduce((sum, t) => sum + t.amount, 0);

        return html`
            <div class="asset-group-column">
                <div class="asset-group-header"
                     style="background: ${meta.headerBg}; color: ${meta.headerFg}"
                     @click=${() => this._onGroupToggle(AssetGroup.TAXES)}>
                    <span class="asset-group-emoji">${meta.groupEmoji}</span>
                    <span class="asset-group-label">${label}</span>
                    <span class="asset-group-total">${formatCompactCurrency(total)}/yr</span>
                    <span class="asset-group-chevron ${isExpanded ? 'expanded' : ''}">&#x25B6;</span>
                </div>
                <div class="asset-group-children ${isExpanded ? '' : 'collapsed'}">
                    ${taxItems.map(t => html`
                        <div class="tax-item-pill">
                            <span class="tax-item-emoji">${t.emoji}</span>
                            <span class="tax-item-label">${t.label}</span>
                            <span class="tax-item-value">${formatCompactCurrency(t.amount)}/yr</span>
                        </div>
                    `)}
                </div>
            </div>
        `;
    }

    _computeTaxItems() {
        const items = [];
        const assets = this.portfolio?.modelAssets;
        if (!assets) return items;

        let ficaTotal = 0, incomeTaxTotal = 0, capGainsTotal = 0, propertyTaxTotal = 0;

        const idx = this.historyIndex;
        const atIdx = (asset, metricName) => {
            const h = asset.getHistory?.(metricName);
            return (h && idx < h.length) ? (h[idx] ?? 0) : 0;
        };

        for (const a of assets) {
            ficaTotal += atIdx(a, 'socialSecurityTax') + atIdx(a, 'medicareTax');
            incomeTaxTotal += atIdx(a, 'withheldIncomeTax') + atIdx(a, 'estimatedIncomeTax');
            capGainsTotal += atIdx(a, 'longTermCapitalGainTax') + atIdx(a, 'shortTermCapitalGainTax');
            propertyTaxTotal += atIdx(a, 'propertyTax');
        }

        // Annualize monthly values
        ficaTotal *= 12;
        incomeTaxTotal *= 12;
        capGainsTotal *= 12;
        propertyTaxTotal *= 12;

        const ficaMeta = TaxItemMeta.get(TaxItem.FICA);
        const incomeMeta = TaxItemMeta.get(TaxItem.INCOME_TAX);
        const capMeta = TaxItemMeta.get(TaxItem.CAPITAL_GAINS);
        const propMeta = TaxItemMeta.get(TaxItem.PROPERTY_TAX);

        if (ficaTotal !== 0) items.push({ ...ficaMeta, amount: ficaTotal });
        if (incomeTaxTotal !== 0) items.push({ ...incomeMeta, amount: incomeTaxTotal });
        if (capGainsTotal !== 0) items.push({ ...capMeta, amount: capGainsTotal });
        if (propertyTaxTotal !== 0) items.push({ ...propMeta, amount: propertyTaxTotal });

        return items;
    }

    /** Get metric value for a single asset at the current historyIndex */
    _getMetricValue(asset) {
        if (!this.metricName || this.historyIndex < 0) return null;
        const history = asset.getHistory?.(this.metricName);
        if (!history || this.historyIndex >= history.length) return null;
        const entry = history[this.historyIndex];
        if (entry == null) return null;
        if (entry.amount != null) return entry.amount;       // Currency object
        if (typeof entry === 'number') return entry;         // plain number
        const parsed = parseFloat(entry);                    // string from toCurrency()
        return isNaN(parsed) ? null : parsed;
    }

    _computeRollupTotal(groupKey, assets) {
        let sum = 0;
        for (const a of assets) {
            const mv = this._getMetricValue(a);
            if (mv != null) {
                sum += mv;
            } else {
                const val = a.finishCurrency?.amount ?? a.startCurrency?.amount ?? 0;
                sum += val;
            }
        }

        if (groupKey === AssetGroup.INCOME || groupKey === AssetGroup.EXPENSES) {
            return formatCompactCurrency(sum) + '/mo';
        }
        return formatCompactCurrency(sum);
    }

    _onGroupToggle(groupKey) {
        this.dispatchEvent(new CustomEvent('group-toggle', {
            bubbles: true, composed: true,
            detail: { group: groupKey },
        }));
    }

    // Legacy colorId assignment for readonly/simulator mode
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
