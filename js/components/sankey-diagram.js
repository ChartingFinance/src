/**
 * <sankey-diagram>
 *
 * Lit component that renders a Sankey diagram of fund transfers as inline SVG.
 * Three columns: Sources (left) → Dual-role (middle) → Sinks (right).
 * Node height is proportional to flow volume, not asset value.
 * Updates reactively to "you are here" cursor via pipeline data.
 *
 * Properties:
 *   pipelines   — Pipeline[] from buildPipelines()
 *   modelAssets — ModelAsset[] for instrument classification
 */

import { LitElement, html, svg, nothing } from 'lit';
import { buildSankeyLayout } from '../utils/sankey-layout.js';

function formatCompactCurrency(amount) {
    const num = parseFloat(amount);
    if (isNaN(num)) return '$0';
    const abs = Math.abs(num);
    const sign = num < 0 ? '-' : '';
    if (abs >= 1000000) return sign + '$' + (abs / 1000000).toFixed(1) + 'M';
    if (abs >= 1000) return sign + '$' + Math.round(abs / 1000).toLocaleString() + 'K';
    return sign + '$' + Math.round(abs);
}

const SVG_W = 700;
const SVG_H = 400;

class SankeyDiagram extends LitElement {

    static properties = {
        pipelines:   { type: Array },
        modelAssets: { type: Array },
    };

    createRenderRoot() { return this; }

    constructor() {
        super();
        this.pipelines = [];
        this.modelAssets = [];
    }

    render() {
        if (!this.pipelines?.length || !this.modelAssets?.length) {
            return html`<div class="text-sm text-gray-400 text-center p-8">No fund transfers configured. Add transfers to see the Sankey diagram.</div>`;
        }

        const layout = buildSankeyLayout(
            this.pipelines, this.modelAssets, SVG_W, SVG_H
        );

        if (layout.nodes.length === 0) {
            return html`<div class="text-sm text-gray-400 text-center p-8">No active flows at this date.</div>`;
        }

        // Build gradient defs for links
        const gradients = layout.links.map((link, i) => svg`
            <linearGradient id="sg${i}" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0%" stop-color="${link.sourceColor}" stop-opacity="0.5" />
                <stop offset="100%" stop-color="${link.targetColor}" stop-opacity="0.5" />
            </linearGradient>
        `);

        return html`
            <div class="sankey-container">
                <svg viewBox="0 0 ${SVG_W} ${SVG_H}"
                     style="width: 100%; height: auto; display: block; max-height: 500px;">
                    <defs>${gradients}</defs>
                    ${layout.links.map((link, i) => this._renderLink(link, i))}
                    ${layout.nodes.map(node => this._renderNode(node, layout.hasMiddle))}
                </svg>
            </div>
        `;
    }

    _renderLink(link, index) {
        // Filled ribbon: two bezier curves forming a band
        const half = link.thickness / 2;
        const midX = (link.x0 + link.x1) / 2;

        const d = [
            `M ${link.x0},${link.y0 - half}`,
            `C ${midX},${link.y0 - half} ${midX},${link.y1 - half} ${link.x1},${link.y1 - half}`,
            `L ${link.x1},${link.y1 + half}`,
            `C ${midX},${link.y1 + half} ${midX},${link.y0 + half} ${link.x0},${link.y0 + half}`,
            'Z',
        ].join(' ');

        return svg`
            <path d="${d}"
                  fill="url(#sg${index})"
                  class="sankey-link">
                <title>${link.sourceName} → ${link.targetName}: ${formatCompactCurrency(link.amount)}/mo</title>
            </path>
        `;
    }

    _renderNode(node, hasMiddle) {
        const isLeft = node.col === 0;
        const isMiddle = hasMiddle && node.col === 1;
        const isRight = hasMiddle ? node.col === 2 : node.col === 1;

        // Label to the left for left-column, right for right-column, right for middle
        const labelX = isLeft ? node.x - node.w / 2 - 6 : node.x + node.w / 2 + 6;
        const labelAnchor = isLeft ? 'end' : 'start';
        const labelY = node.y + node.h / 2 - 5;
        const amountY = labelY + 13;

        const displayName = node.name.length > 16 ? node.name.slice(0, 15) + '\u2026' : node.name;

        return svg`
            <g class="sankey-node">
                <rect x="${node.x - node.w / 2}" y="${node.y}"
                      width="${node.w}" height="${Math.max(4, node.h)}"
                      rx="4" fill="${node.color}">
                    <title>${node.name}: ${formatCompactCurrency(node.flow)}/mo total flow</title>
                </rect>
                <text x="${labelX}" y="${labelY}"
                      text-anchor="${labelAnchor}" dominant-baseline="central"
                      class="sankey-label" fill="#374151">
                    ${displayName}
                </text>
                <text x="${labelX}" y="${amountY}"
                      text-anchor="${labelAnchor}" dominant-baseline="central"
                      class="sankey-amount" fill="#9ca3af">
                    ${formatCompactCurrency(node.flow)}/mo
                </text>
            </g>
        `;
    }
}

customElements.define('sankey-diagram', SankeyDiagram);
