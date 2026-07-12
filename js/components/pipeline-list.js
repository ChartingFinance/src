/**
 * <pipeline-list>
 *
 * Lit component that renders fund transfer pipelines in horizontal columns
 * grouped by source asset group. Each column contains pipeline cards showing
 * where money flows from that source group to target groups.
 *
 * Dispatches: pipeline-toggle
 */

import { LitElement, html, nothing } from 'lit';
import { AssetGroupMeta } from '../asset-groups.js';
import { groupPipelinesBySource } from '../flow-pipelines.js';

import { formatCompactCurrency } from '../utils/html.js';

/** Source group display order */
const SOURCE_GROUP_ORDER = ['income', 'capital', 'retirement'];

class PipelineList extends LitElement {

    static properties = {
        pipelines:         { type: Array },
        expandedPipelines: { type: Object },  // Set<pipeline key>
    };

    createRenderRoot() { return this; }

    constructor() {
        super();
        this.pipelines = [];
        this.expandedPipelines = null;
    }

    render() {
        if (!this.pipelines || this.pipelines.length === 0) {
            return html`<div class="text-sm text-gray-400 text-center p-8">No fund transfers configured. Add transfers to see money flow.</div>`;
        }

        const grouped = groupPipelinesBySource(this.pipelines);
        const expanded = this.expandedPipelines || new Set();

        return html`
            <div class="pipeline-columns">
                ${SOURCE_GROUP_ORDER.map(sourceGroup => {
                    const pipelines = grouped.get(sourceGroup);
                    if (!pipelines || pipelines.length === 0) return nothing;
                    return this._renderSourceColumn(sourceGroup, pipelines, expanded);
                })}
            </div>
        `;
    }

    _renderSourceColumn(sourceGroup, pipelines, expanded) {
        const meta = AssetGroupMeta.get(sourceGroup);
        const columnTotal = pipelines.reduce((sum, p) => sum + p.monthlyTotal, 0);

        return html`
            <div class="pipeline-source-column">
                <div class="pipeline-source-header" style="background: ${meta.headerBg}; color: ${meta.headerFg}">
                    <span class="pipeline-source-emoji">${meta.groupEmoji}</span>
                    <span class="pipeline-source-label">From ${meta.label}</span>
                    <span class="pipeline-source-total">${formatCompactCurrency(columnTotal)}/mo</span>
                </div>
                <div class="pipeline-card-list">
                    ${pipelines.map(p => this._renderPipelineCard(p, expanded.has(p.key)))}
                </div>
            </div>
        `;
    }

    _renderPipelineCard(pipeline, isExpanded) {
        const sourceMeta = AssetGroupMeta.get(pipeline.sourceGroup);
        const targetMeta = AssetGroupMeta.get(pipeline.targetGroup);
        const inactive = !pipeline.active && !pipeline.missing;
        const cardClass = pipeline.missing ? 'pipeline-card pipeline-warning'
                        : inactive ? 'pipeline-card pipeline-inactive'
                        : 'pipeline-card';

        return html`
            <div class="${cardClass}">
                <div class="pipeline-card-header" @click=${() => this._onToggle(pipeline.key)}>
                    <span class="pipeline-card-emoji">${sourceMeta?.groupEmoji ?? '?'} → ${targetMeta?.groupEmoji ?? '?'}</span>
                    <span class="pipeline-card-label">${targetMeta?.label ?? pipeline.targetGroup}</span>
                    <span class="pipeline-card-total">${pipeline.missing ? '' : formatCompactCurrency(pipeline.monthlyTotal) + '/mo'}</span>
                    <span class="pipeline-card-chevron ${isExpanded ? 'expanded' : ''}">&#x25B6;</span>
                </div>
                ${pipeline.missing && pipeline.warnIfMissing ? html`
                    <div class="pipeline-warning-text">&#x26A0; ${pipeline.warningText || 'Not configured'}</div>
                ` : ''}
                <div class="pipeline-routes ${isExpanded ? '' : 'collapsed'}">
                    ${pipeline.routes.map(r => this._renderRoute(r))}
                </div>
            </div>
        `;
    }

    _renderRoute(route) {
        const pctLabel = route.percentage != null ? `${Math.round(route.percentage)}%` : 'auto';
        const typeClass = route.type === 'system' ? 'pipeline-route pipeline-route-system' : 'pipeline-route';
        const activeClass = route.active ? '' : 'pipeline-route-inactive';
        const clickable = route.type === 'user' && route.ownerName;

        return html`
            <div class="${typeClass} ${activeClass} ${clickable ? 'pipeline-route-clickable' : ''}"
                 @click=${clickable ? () => this._onRouteClick(route) : null}
                 title=${clickable ? `Click to edit transfers on ${route.ownerName}` : ''}>
                <span class="pipeline-route-source">${route.sourceName}</span>
                <span class="pipeline-route-arrow">→</span>
                <span class="pipeline-route-target">${route.targetName}${route.detail ? ` (${route.detail})` : ''}</span>
                <span class="pipeline-route-pct">${pctLabel}</span>
                <span class="pipeline-route-amount">${formatCompactCurrency(route.monthlyAmount)}</span>
            </div>
        `;
    }

    _onRouteClick(route) {
        this.dispatchEvent(new CustomEvent('edit-transfers', {
            bubbles: true, composed: true,
            detail: { displayName: route.ownerName },
        }));
    }

    _onToggle(pipelineKey) {
        this.dispatchEvent(new CustomEvent('pipeline-toggle', {
            bubbles: true, composed: true,
            detail: { pipeline: pipelineKey },
        }));
    }
}

customElements.define('pipeline-list', PipelineList);
