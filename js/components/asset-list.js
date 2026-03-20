/**
 * <asset-list>
 *
 * Lit component that renders assets grouped by financial category.
 * Groups have collapsible headers with emoji, contextual label, roll-up total, and chevron.
 * Individual assets render as <asset-card> children with stable group-derived colors.
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
    GROUP_ORDER_ACCUMULATE, GROUP_ORDER_RETIRE,
} from '../asset-groups.js';
import {
    PropertyGroupMeta, PROPERTY_ORDER_ACCUMULATE, PROPERTY_ORDER_RETIRE,
    ASSET_LESS_GROUPS,
    classifyAssetsByProperty, getPrimaryMetric, computePropertyRollupAtIndex,
} from '../property-groups.js';
import { LifeEventType } from '../life-event.js';
import { MetricLabel } from '../metric.js';
import './asset-card.js';

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
        viewMode: { type: String },        // 'assets' | 'properties'
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
        this.viewMode = 'assets';
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

        // Branch on view mode
        if (this.viewMode === 'properties') {
            return this._renderPropertiesView();
        }
        return this._renderAssetsView();
    }

    _renderAssetsView() {
        const groups = classifyAssets(this.modelAssets, this.atDateInt);
        const expanded = this.expandedGroups || new Set();
        const isRetired = this.activeLifeEvent?.event
            ? LifeEventType.isRetirement(this.activeLifeEvent.event)
            : false;
        const order = isRetired ? GROUP_ORDER_RETIRE : GROUP_ORDER_ACCUMULATE;

        return html`
            <div class="flex flex-col gap-3 w-full">
                ${order.map(groupKey => {
                    if (groupKey === AssetGroup.TAXES) {
                        return this._renderTaxesGroup(expanded.has(groupKey));
                    }
                    const assets = groups.get(groupKey);
                    if (!assets || assets.length === 0) return nothing;
                    return this._renderGroup(groupKey, assets, expanded.has(groupKey));
                })}
            </div>
        `;
    }

    _renderPropertiesView() {
        // Set closed-at-date flag for ghosting
        const atInt = this.atDateInt?.toInt?.();
        for (const asset of this.modelAssets) {
            if (atInt != null) {
                const start = asset.startDateInt.toInt();
                const finish = asset.effectiveFinishDateInt.toInt();
                // Ghost if before start, after declared finish, or after early closure by life event
                const closedEarly = asset.closedDateInt && atInt >= asset.closedDateInt.toInt();
                asset._isClosedAtDate = atInt < start || atInt > finish || closedEarly;
            } else {
                asset._isClosedAtDate = asset.isClosed;
            }
        }

        const groups = classifyAssetsByProperty(this.modelAssets);
        const expanded = this.expandedGroups || new Set();
        const isRetired = this.activeLifeEvent?.event
            ? LifeEventType.isRetirement(this.activeLifeEvent.event)
            : false;
        const order = isRetired ? PROPERTY_ORDER_RETIRE : PROPERTY_ORDER_ACCUMULATE;

        return html`
            <div class="flex flex-col gap-3 w-full">
                ${order.map(groupKey => {
                    if (ASSET_LESS_GROUPS.has(groupKey)) {
                        return this._renderAssetLessPropertyGroup(groupKey, expanded.has(groupKey));
                    }
                    const assets = groups.get(groupKey);
                    if (!assets || assets.length === 0) return nothing;
                    return this._renderPropertyGroup(groupKey, assets, expanded.has(groupKey));
                })}
            </div>
        `;
    }

    _renderPropertyGroup(groupKey, assets, isExpanded) {
        const meta = PropertyGroupMeta.get(groupKey);
        const total = computePropertyRollupAtIndex(assets, groupKey, this.historyIndex);

        return html`
            <div>
                <div class="asset-group-header"
                     style="background: ${meta.headerBg}; color: ${meta.headerFg}"
                     @click=${() => this._onGroupToggle(groupKey)}>
                    <span class="asset-group-emoji">${meta.groupEmoji}</span>
                    <span class="asset-group-label">${meta.label}</span>
                    <span class="asset-group-total">${formatCompactCurrency(total)}</span>
                    <span class="asset-group-chevron ${isExpanded ? 'expanded' : ''}">&#x25B6;</span>
                </div>
                ${isExpanded ? html`
                    <div class="asset-group-children">
                        ${repeat(
                            assets,
                            (ma) => ma.displayName + ':' + groupKey,
                            (ma) => {
                                const metric = getPrimaryMetric(ma, groupKey);
                                const shade = meta.assetShades?.get(ma.instrument) ?? meta.chartColor;
                                return html`
                                    <asset-card
                                        .modelAsset=${ma}
                                        .groupColor=${shade}
                                        .metricValue=${this._getMetricValueForMetric(ma, metric)}
                                        .metricLabel=${MetricLabel[metric] || ''}
                                        ?ghost=${ma._isClosedAtDate}
                                        .closedEmoji=${ma._isClosedAtDate ? '⛔' : ''}
                                        ?selected=${this.highlightName === ma.displayName}
                                    ></asset-card>
                                `;
                            }
                        )}
                    </div>
                ` : nothing}
            </div>
        `;
    }

    _renderAssetLessPropertyGroup(groupKey, isActive) {
        const meta = PropertyGroupMeta.get(groupKey);
        const total = computePropertyRollupAtIndex([], groupKey, this.historyIndex, this.modelAssets);

        return html`
            <div>
                <div class="asset-group-header"
                     style="background: ${meta.headerBg}; color: ${meta.headerFg}"
                     @click=${() => this._onGroupToggle(groupKey)}>
                    <span class="asset-group-emoji">${meta.groupEmoji}</span>
                    <span class="asset-group-label">${meta.label}</span>
                    <span class="asset-group-total">${formatCompactCurrency(total)}</span>
                    <span class="asset-group-spotlight" title="Spotlight in Micro chart">${isActive ? '🔦' : '🔅'}</span>
                </div>
            </div>
        `;
    }

    /** Get metric value for a specific metric at current historyIndex */
    _getMetricValueForMetric(asset, metricName) {
        if (!metricName || this.historyIndex < 0) return null;
        const history = asset.getHistory?.(metricName);
        if (!history || this.historyIndex >= history.length) return null;
        const entry = history[this.historyIndex];
        if (entry == null) return null;
        if (entry.amount != null) return entry.amount;
        if (typeof entry === 'number') return entry;
        const parsed = parseFloat(entry);
        return isNaN(parsed) ? null : parsed;
    }

    _renderGroup(groupKey, assets, isExpanded) {
        const meta = AssetGroupMeta.get(groupKey);
        const label = getGroupLabel(groupKey, this.activeLifeEvent);
        const total = this._computeRollupTotal(groupKey, assets);

        return html`
            <div>
                <div class="asset-group-header"
                     style="background: ${meta.headerBg}; color: ${meta.headerFg}"
                     @click=${() => this._onGroupToggle(groupKey)}>
                    <span class="asset-group-emoji">${meta.groupEmoji}</span>
                    <span class="asset-group-label">${label}</span>
                    <span class="asset-group-total">${total}</span>
                    <span class="asset-group-chevron ${isExpanded ? 'expanded' : ''}">&#x25B6;</span>
                </div>
                ${isExpanded ? html`
                    <div class="asset-group-children">
                        ${repeat(
                            assets,
                            (ma) => ma.displayName,
                            (ma) => html`
                                <asset-card
                                    .modelAsset=${ma}
                                    .groupColor=${getAssetChartColor(ma.instrument)}
                                    .metricValue=${this._getMetricValue(ma)}
                                    ?ghost=${ma._isClosedAtDate}
                                    .closedEmoji=${ma._isClosedAtDate ? '⛔' : ''}
                                    ?selected=${this.highlightName === ma.displayName}
                                ></asset-card>
                            `
                        )}
                    </div>
                ` : nothing}
            </div>
        `;
    }

    _renderTaxesGroup(isExpanded) {
        if (!this.portfolio) return nothing;

        const taxItems = this._computeTaxItems();
        if (taxItems.length === 0) return nothing;

        const meta = AssetGroupMeta.get(AssetGroup.TAXES);
        const label = getGroupLabel(AssetGroup.TAXES, this.activeLifeEvent);
        const total = taxItems.reduce((sum, t) => sum + t.amount, 0);

        return html`
            <div>
                <div class="asset-group-header"
                     style="background: ${meta.headerBg}; color: ${meta.headerFg}"
                     @click=${() => this._onGroupToggle(AssetGroup.TAXES)}>
                    <span class="asset-group-emoji">${meta.groupEmoji}</span>
                    <span class="asset-group-label">${label}</span>
                    <span class="asset-group-total">${formatCompactCurrency(total)}/yr</span>
                    <span class="asset-group-chevron ${isExpanded ? 'expanded' : ''}">&#x25B6;</span>
                </div>
                ${isExpanded ? html`
                    <div class="asset-group-children">
                        ${taxItems.map(t => html`
                            <div class="tax-item-pill">
                                <span class="tax-item-emoji">${t.emoji}</span>
                                <span class="tax-item-label">${t.label}</span>
                                <span class="tax-item-value">${formatCompactCurrency(t.amount)}/yr</span>
                            </div>
                        `)}
                    </div>
                ` : nothing}
            </div>
        `;
    }

    _computeTaxItems() {
        const items = [];
        const assets = this.portfolio?.modelAssets;
        if (!assets) return items;

        let ficaTotal = 0, incomeTaxTotal = 0, capGainsTotal = 0, propertyTaxTotal = 0;

        for (const a of assets) {
            if (a.isClosed) continue;
            ficaTotal += (a.withheldFicaTaxCurrency?.amount ?? 0);
            incomeTaxTotal += (a.incomeTaxCurrency?.amount ?? 0);
            capGainsTotal += (a.capitalGainTaxCurrency?.amount ?? 0);
            propertyTaxTotal += (a.propertyTaxCurrency?.amount ?? 0);
        }

        // Annualize monthly values (these are monthly snapshots)
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

    _onQuickStart() {
        this.dispatchEvent(new CustomEvent('quick-start', { bubbles: true, composed: true }));
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
