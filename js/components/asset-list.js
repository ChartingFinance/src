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
    AssetGroup, AssetGroupMeta,
    classifyAssets, classifyAssetGroup, getGroupLabel, getAssetChartColor,
} from '../asset-groups.js';
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

/**
 * Hierarchical tax tree. Each node has:
 *   - amountMetrics: leaf metrics summed to compute the node's dollar amount
 *   - highlightMetrics: metrics that identify "contributing" assets (broader —
 *     includes the income/activity metrics that generate the tax, since the
 *     tax may be recorded on a different asset)
 *   - children: optional sub-nodes
 *
 * Amounts and highlights are computed per-node; zero-amount nodes are pruned.
 */
const TAX_TREE = [
    {
        id: 'fica',
        label: 'FICA / Medicare',
        emoji: '🏥',
        amountMetrics: ['socialSecurityTax', 'medicareTax'],
        highlightMetrics: ['socialSecurityTax', 'medicareTax', 'employedIncome', 'selfIncome'],
        children: [
            { id: 'ssTax', label: 'Social Security', emoji: '👴',
              amountMetrics: ['socialSecurityTax'],
              highlightMetrics: ['socialSecurityTax', 'employedIncome', 'selfIncome'] },
            { id: 'medicareTax', label: 'Medicare', emoji: '⚕️',
              amountMetrics: ['medicareTax'],
              highlightMetrics: ['medicareTax', 'employedIncome', 'selfIncome'] },
        ],
    },
    {
        id: 'incomeTax',
        label: 'Income Tax',
        emoji: '📄',
        amountMetrics: ['withheldIncomeTax', 'estimatedIncomeTax'],
        highlightMetrics: ['withheldIncomeTax', 'estimatedIncomeTax', 'income', 'qualifiedDividend', 'nonQualifiedDividend', 'interestIncome'],
        children: [
            { id: 'withheldIT', label: 'Withheld', emoji: '💼',
              amountMetrics: ['withheldIncomeTax'],
              highlightMetrics: ['withheldIncomeTax', 'employedIncome'] },
            { id: 'estimatedIT', label: 'Estimated', emoji: '📝',
              amountMetrics: ['estimatedIncomeTax'],
              highlightMetrics: ['estimatedIncomeTax', 'qualifiedDividend', 'nonQualifiedDividend', 'interestIncome', 'selfIncome', 'socialSecurityIncome', 'pensionIncome'] },
        ],
    },
    {
        id: 'capGains',
        label: 'Capital Gains',
        emoji: '📉',
        amountMetrics: ['longTermCapitalGainTax', 'shortTermCapitalGainTax'],
        highlightMetrics: ['longTermCapitalGainTax', 'shortTermCapitalGainTax', 'longTermCapitalGain', 'shortTermCapitalGain'],
        children: [
            { id: 'ltcg', label: 'Long Term', emoji: '📈',
              amountMetrics: ['longTermCapitalGainTax'],
              highlightMetrics: ['longTermCapitalGainTax', 'longTermCapitalGain'] },
            { id: 'stcg', label: 'Short Term', emoji: '⚡',
              amountMetrics: ['shortTermCapitalGainTax'],
              highlightMetrics: ['shortTermCapitalGainTax', 'shortTermCapitalGain'] },
        ],
    },
    {
        id: 'propertyTax',
        label: 'Property Tax',
        emoji: '🏘️',
        amountMetrics: ['propertyTax'],
        highlightMetrics: ['propertyTax'],
    },
];

/** Union of every highlightMetric across the whole tree — used when clicking the Taxes column header. */
const ALL_TAX_HIGHLIGHT_METRICS = (() => {
    const s = new Set();
    const walk = (nodes) => nodes.forEach(n => {
        n.highlightMetrics.forEach(m => s.add(m));
        if (n.children) walk(n.children);
    });
    walk(TAX_TREE);
    return [...s];
})();

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
        this._taxHighlightAssets = new Set(); // displayNames of assets to highlight
        this._taxHighlightGroups = new Set(); // group keys to highlight (when collapsed)
        this._expandedTaxNodes = new Set();   // tax tree node ids currently expanded
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
        const headerHighlight = this._taxHighlightGroups.has(groupKey);

        return html`
            <div class="asset-group-column">
                <div class="asset-group-header ${headerHighlight ? 'tax-highlight-pulse' : ''}"
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
                            const taxHl = this._taxHighlightAssets.has(ma.displayName);
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
                                    ?taxHighlight=${taxHl}
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

        const nodes = this._computeTaxTree();
        if (nodes.length === 0) return nothing;

        const meta = AssetGroupMeta.get(AssetGroup.TAXES);
        const label = getGroupLabel(AssetGroup.TAXES, this.activeLifeEvent);
        const total = nodes.reduce((sum, n) => sum + n.amount, 0);

        return html`
            <div class="asset-group-column">
                <div class="asset-group-header"
                     style="background: ${meta.headerBg}; color: ${meta.headerFg}"
                     @click=${() => { this._onGroupToggle(AssetGroup.TAXES); this._highlightAssetsForMetrics(ALL_TAX_HIGHLIGHT_METRICS); }}>
                    <span class="asset-group-emoji">${meta.groupEmoji}</span>
                    <span class="asset-group-label">${label}</span>
                    <span class="asset-group-total">${formatCompactCurrency(total)}/yr</span>
                    <span class="asset-group-chevron ${isExpanded ? 'expanded' : ''}">&#x25B6;</span>
                </div>
                <div class="asset-group-children ${isExpanded ? '' : 'collapsed'}">
                    ${nodes.map(n => this._renderTaxNode(n, 0))}
                </div>
            </div>
        `;
    }

    _renderTaxNode(node, depth) {
        const hasChildren = node.children && node.children.length > 0;
        const isExpanded = this._expandedTaxNodes.has(node.id);
        const indent = depth * 14;

        return html`
            <div>
                <div class="tax-item-pill" style="margin-left: ${indent}px;">
                    <span class="tax-item-body"
                          title="Click to highlight contributing assets"
                          @click=${() => this._highlightAssetsForMetrics(node.highlightMetrics)}>
                        <span class="tax-item-emoji">${node.emoji}</span>
                        <span class="tax-item-label">${node.label}</span>
                        <span class="tax-item-value">${formatCompactCurrency(node.amount)}/yr</span>
                    </span>
                    ${hasChildren ? html`
                        <span class="tax-item-chevron"
                              title="Expand / collapse"
                              @click=${() => this._onTaxNodeToggle(node.id)}>
                            <span class="tax-item-chevron-glyph ${isExpanded ? 'expanded' : ''}">&#x25B6;</span>
                        </span>
                    ` : nothing}
                </div>
                ${hasChildren && isExpanded ? html`
                    <div class="tax-item-children">
                        ${node.children.map(c => this._renderTaxNode(c, depth + 1))}
                    </div>
                ` : nothing}
            </div>
        `;
    }

    _computeTaxTree() {
        const assets = this.portfolio?.modelAssets;
        if (!assets) return [];

        const idx = this.historyIndex;
        const atIdx = (asset, metricName) => {
            const h = asset.getHistory?.(metricName);
            return (h && idx < h.length) ? (h[idx] ?? 0) : 0;
        };

        // Sum a list of metrics across all assets, annualized.
        const sumMetrics = (metrics) => {
            let total = 0;
            for (const a of assets) {
                for (const m of metrics) total += atIdx(a, m);
            }
            return total * 12;
        };

        // Walk the tree, compute amounts, prune zero nodes and zero children.
        const walk = (node) => {
            const amount = sumMetrics(node.amountMetrics);
            if (amount === 0) return null;
            const out = { ...node, amount };
            if (node.children) {
                out.children = node.children.map(walk).filter(Boolean);
            }
            return out;
        };

        return TAX_TREE.map(walk).filter(Boolean);
    }

    /** Get metric value for a single asset at the current historyIndex */
    _getMetricValue(asset) {
        if (!this.metricName || this.historyIndex < 0) return null;
        const history = asset.getHistory?.(this.metricName);
        if (!history || this.historyIndex >= history.length) return null;
        const entry = history[this.historyIndex];
        if (entry == null) return null;
        if (entry.amount != null) return entry.amount;
        if (typeof entry === 'number') return entry;
        const parsed = parseFloat(entry);
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

    _onTaxNodeToggle(nodeId) {
        if (this._expandedTaxNodes.has(nodeId)) {
            this._expandedTaxNodes.delete(nodeId);
        } else {
            this._expandedTaxNodes.add(nodeId);
        }
        this.requestUpdate();
    }

    _highlightAssetsForMetrics(metrics) {
        if (!metrics || metrics.length === 0) return;

        const assets = this.portfolio?.modelAssets;
        if (!assets) return;

        const idx = this.historyIndex;
        const atIdx = (asset, metricName) => {
            const h = asset.getHistory?.(metricName);
            return (h && idx >= 0 && idx < h.length) ? (h[idx] ?? 0) : 0;
        };

        // Find contributing assets
        const highlightNames = new Set();
        for (const a of assets) {
            const total = metrics.reduce((sum, m) => sum + Math.abs(atIdx(a, m)), 0);
            if (total > 0) highlightNames.add(a.displayName);
        }

        if (highlightNames.size === 0) return;

        // Determine which groups to highlight (for collapsed groups)
        const expanded = this.expandedGroups || new Set();
        const highlightGroups = new Set();
        for (const a of assets) {
            if (!highlightNames.has(a.displayName)) continue;
            const group = classifyAssetGroup(a.instrument);
            if (!expanded.has(group)) {
                highlightGroups.add(group);
            }
        }

        this._taxHighlightAssets = highlightNames;
        this._taxHighlightGroups = highlightGroups;
        this.requestUpdate();

        // Clear after animation
        setTimeout(() => {
            this._taxHighlightAssets = new Set();
            this._taxHighlightGroups = new Set();
            this.requestUpdate();
        }, 1500);
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
