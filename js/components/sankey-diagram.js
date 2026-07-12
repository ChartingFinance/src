// js/components/sankey-diagram.js

import { LitElement, html, svg } from 'lit';
import { buildSankeyLayout } from '../utils/sankey-layout.js';
import { formatCompactCurrency } from '../utils/html.js';

const SVG_W = 900;
const SVG_H = 300;

class SankeyDiagram extends LitElement {

    static properties = {
        pipelines:   { type: Array },
        modelAssets: { type: Array },
        _hoverNode:  { state: true },
    };

    createRenderRoot() { return this; }

    constructor() {
        super();
        this.pipelines = [];
        this.modelAssets = [];
        this._hoverNode = null;
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

        const gradients = layout.links.map((link, i) => svg`
            <linearGradient id="sg${i}" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0%" stop-color="${link.sourceColor}" />
                <stop offset="100%" stop-color="${link.targetColor}" />
            </linearGradient>
        `);

        return html`
            <div class="sankey-container">
                <svg viewBox="0 0 ${SVG_W} ${SVG_H}"
                     style="width: 100%; height: auto; display: block; max-height: 350px;"
                     @mouseleave=${() => this._hoverNode = null}>
                    <defs>${gradients}</defs>
                    ${layout.links.map((link, i) => this._renderLink(link, i))}
                    ${layout.nodes.map(node => this._renderNode(node, layout))}
                </svg>
            </div>
        `;
    }

    _getLinkOpacity(link) {
        if (!this._hoverNode) return 0.4;
        if (link.sourceName === this._hoverNode || link.targetName === this._hoverNode) return 0.8;
        return 0.05;
    }

    _getNodeOpacity(node, links) {
        if (!this._hoverNode) return 1.0;
        if (node.name === this._hoverNode) return 1.0;
        
        const isConnected = links.some(l => 
            (l.sourceName === this._hoverNode && l.targetName === node.name) ||
            (l.targetName === this._hoverNode && l.sourceName === node.name)
        );
        return isConnected ? 1.0 : 0.2;
    }

    _renderLink(link, index) {
        const half = link.thickness / 2;
        const midX = (link.x0 + link.x1) / 2;

        const d = [
            `M ${link.x0},${link.y0 - half}`,
            `C ${midX},${link.y0 - half} ${midX},${link.y1 - half} ${link.x1},${link.y1 - half}`,
            `L ${link.x1},${link.y1 + half}`,
            `C ${midX},${link.y1 + half} ${midX},${link.y0 + half} ${link.x0},${link.y0 + half}`,
            'Z',
        ].join(' ');

        const opacity = this._getLinkOpacity(link);

        return svg`
            <path d="${d}"
                  fill="url(#sg${index})"
                  style="opacity: ${opacity}; transition: opacity 0.2s ease;"
                  class="sankey-link"
                  @mouseenter=${() => this._hoverNode = link.sourceName}>
                <title>${link.sourceName} → ${link.targetName}: ${formatCompactCurrency(link.amount)}/mo</title>
            </path>
        `;
    }

    _renderNode(node, layout) {
        const isRight = node.col === layout.maxLayer;
        
        const labelX = isRight ? node.x - 8 : node.x + node.w + 8;
        const labelAnchor = isRight ? 'end' : 'start';
        const labelY = node.y + node.h / 2 - 5;
        const amountY = labelY + 13;

        const displayName = node.name.length > 16 ? node.name.slice(0, 15) + '\u2026' : node.name;
        const opacity = this._getNodeOpacity(node, layout.links);

        return svg`
            <g class="sankey-node" 
               style="opacity: ${opacity}; transition: opacity 0.2s ease; cursor: pointer;"
               @mouseenter=${() => this._hoverNode = node.name}>
                <rect x="${node.x - node.w / 2}" y="${node.y}"
                      width="${node.w}" height="${Math.max(4, node.h)}"
                      rx="4" fill="${node.color}">
                    <title>${node.name}: ${formatCompactCurrency(node.flow)}/mo total flow</title>
                </rect>
                <text x="${labelX}" y="${labelY}"
                      text-anchor="${labelAnchor}" dominant-baseline="central"
                      class="sankey-label" fill="#374151" style="font-weight: 600; font-size: 12px; pointer-events: none;">
                    ${displayName}
                </text>
                <text x="${labelX}" y="${amountY}"
                      text-anchor="${labelAnchor}" dominant-baseline="central"
                      class="sankey-amount" fill="#9ca3af" style="font-size: 11px; pointer-events: none;">
                    ${formatCompactCurrency(node.flow)}/mo
                </text>
            </g>
        `;
    }
}

customElements.define('sankey-diagram', SankeyDiagram);