/**
 * hydraulic-visualizer.js
 *
 * Renders a reactive SVG visualization of portfolio fund flows.
 * Layout: income (left) → horizontal conduit → capital/retirement (above) + expenses/housing/taxes (below).
 * Wealth tank (right) shows context based on active mode.
 *
 * Three modes:
 *   cashflow — lines show monthly transfer amounts, wealth tank shows net monthly cash flow
 *   value    — lines show asset balance as share of portfolio, wealth tank shows total portfolio value
 *   growth   — lines show month-over-month value change, wealth tank shows net portfolio growth
 *
 * Driven by the "you are here" timeline cursor.
 */

import { classifyAssetGroup, AssetGroup, AssetGroupMeta } from './asset-groups.js';
import { buildPipelines } from './flow-pipelines.js';
import { Metric, MetricLabel } from './metric.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function formatCompact(amount) {
    const abs = Math.abs(amount);
    const sign = amount < 0 ? '-' : '';
    if (abs >= 1000000) return sign + '$' + (abs / 1000000).toFixed(1) + 'M';
    if (abs >= 1000) return sign + '$' + Math.round(abs / 1000).toLocaleString() + 'K';
    return sign + '$' + Math.round(abs);
}

function flowWidth(amount, maxW = 18) {
    if (amount <= 0) return 0;
    return Math.min(maxW, Math.max(1.5, Math.log10(amount + 1) * 4));
}

function blendColor(ratio) {
    const r = ratio < 0 ? 1 : 1 - ratio;
    const g = ratio > 0 ? 1 : 1 + ratio;
    return `rgb(${Math.round(r * 220)}, ${Math.round(g * 200)}, 80)`;
}

function atIdx(asset, metric, historyIndex) {
    const h = asset.getHistory?.(metric);
    return (h && historyIndex >= 0 && historyIndex < h.length) ? (h[historyIndex] ?? 0) : 0;
}

export class HydraulicVisualizer {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.svg = null;
        this.width = 1000;
        this.height = 600;
        this._elements = new Map();
        this._nodePositions = new Map();
        this._flowGroup = null;
        this._nodeGroup = null;
    }

    init(portfolio) {
        if (!this.container) return;
        this.container.innerHTML = '';
        this._elements.clear();
        this._nodePositions.clear();
        this.portfolio = portfolio;

        this.svg = document.createElementNS(SVG_NS, 'svg');
        this.svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
        this.svg.style.backgroundColor = '#1e1e2e';
        this.svg.style.fontFamily = "'DM Sans', sans-serif";
        this.svg.style.width = '100%';
        this.svg.style.height = '100%';

        this._injectDefs();
        this._computeValueRange(portfolio);
        this._buildLayout(portfolio);
        this.container.appendChild(this.svg);
    }

    _computeValueRange(portfolio) {
        const assets = portfolio.modelAssets;
        if (!assets.length) { this._valueMin = 0; this._valueMax = 1; return; }

        let histLen = 0;
        for (const a of assets) {
            const h = a.getHistory?.('value');
            if (h && h.length > histLen) histLen = h.length;
        }

        let min = Infinity, max = -Infinity;
        for (let idx = 0; idx < histLen; idx++) {
            let total = 0;
            for (const a of assets) {
                const h = a.getHistory?.('value');
                if (h && idx < h.length) total += h[idx];
            }
            if (total < min) min = total;
            if (total > max) max = total;
        }

        this._valueMin = min === Infinity ? 0 : min;
        this._valueMax = max === -Infinity ? 1 : max;
    }

    // ── Main update (dispatches to mode-specific logic) ──────────────

    update(historyIndex, isRetired = false, metricName = Metric.VALUE) {
        if (!this.svg || !this.portfolio) return;

        this._updateClosedState(historyIndex);

        if (this._flowGroup) this._flowGroup.remove();
        this._flowGroup = document.createElementNS(SVG_NS, 'g');
        this.svg.insertBefore(this._flowGroup, this._nodeGroup);

        let totalPositive = 0;
        let totalNegative = 0;
        let wealthLabel = '';

        if (this._wealthLabel) {
            this._wealthLabel.textContent = MetricLabel[metricName] || 'Value';
        }

        if (metricName === Metric.CASH_FLOW) {
            const result = this._updateCashFlow(historyIndex, isRetired);
            totalPositive = result.totalInflow;
            totalNegative = result.totalOutflow;
            const net = result.totalInflow - result.totalOutflow;
            wealthLabel = (net >= 0 ? '+' : '') + formatCompact(net) + '/mo';
        } else if (metricName === Metric.VALUE) {
            const result = this._updateValue(historyIndex);
            totalPositive = result.portfolioValue;
            totalNegative = 0;
            wealthLabel = formatCompact(result.portfolioValue);
        } else {
            // Generic metric mode: read metric history per asset, show positive/negative
            const result = this._updateGenericMetric(historyIndex, metricName);
            totalPositive = result.totalPositive;
            totalNegative = result.totalNegative;
            const net = result.totalPositive - result.totalNegative;
            wealthLabel = (net >= 0 ? '+' : '') + formatCompact(net) + '/mo';
        }

        // Update conduit blend and tooltip
        if (this._conduit) {
            const net = totalPositive - totalNegative;
            const maxFlow = Math.max(totalPositive, totalNegative, 1);
            const ratio = Math.max(-1, Math.min(1, net / maxFlow));
            this._conduit.setAttribute('stroke', blendColor(ratio));
            this._conduitGlow.setAttribute('stroke', blendColor(ratio));
            this._conduitGlow.style.opacity = Math.min(0.4, Math.abs(ratio) * 0.5);

            // Compute net change since last month for tooltip
            let curTotal = 0, prevTotal = 0;
            for (const a of this.portfolio.modelAssets) {
                curTotal += atIdx(a, 'value', historyIndex);
                prevTotal += atIdx(a, 'value', historyIndex - 1);
            }
            const delta = curTotal - prevTotal;
            const deltaStr = (delta >= 0 ? '+' : '') + formatCompact(delta);

            // Update tooltip on the hit-target overlay
            if (this._conduitHit) {
                const existing = this._conduitHit.querySelector('title');
                if (existing) existing.remove();
                const title = document.createElementNS(SVG_NS, 'title');
                title.textContent = `Net change since last month: ${deltaStr}\nPortfolio: ${formatCompact(curTotal)}`;
                this._conduitHit.appendChild(title);
            }
        }

        // Update wealth tank
        this._updateWealthTank(historyIndex, wealthLabel);
    }

    // ── Cash Flow mode ───────────────────────────────────────────────

    _updateCashFlow(historyIndex, isRetired) {
        const pipelines = buildPipelines(this.portfolio, historyIndex, isRetired);

        const flowMap = new Map();
        for (const p of pipelines) {
            for (const r of p.routes) {
                if (r.monthlyAmount <= 0 || !r.active) continue;
                const key = `${r.sourceName}→${r.targetName}`;
                flowMap.set(key, (flowMap.get(key) || 0) + r.monthlyAmount);
            }
        }

        // Compute taxes
        let totalTaxes = 0;
        for (const a of this.portfolio.modelAssets) {
            totalTaxes += Math.abs(atIdx(a, 'socialSecurityTax', historyIndex))
                        + Math.abs(atIdx(a, 'medicareTax', historyIndex))
                        + Math.abs(atIdx(a, 'withheldIncomeTax', historyIndex))
                        + Math.abs(atIdx(a, 'estimatedIncomeTax', historyIndex))
                        + Math.abs(atIdx(a, 'longTermCapitalGainTax', historyIndex))
                        + Math.abs(atIdx(a, 'shortTermCapitalGainTax', historyIndex))
                        + Math.abs(atIdx(a, 'propertyTax', historyIndex));
        }

        const taxEl = this._elements.get('Taxes');
        if (taxEl) taxEl.valueText.textContent = totalTaxes > 0 ? formatCompact(totalTaxes) + '/mo' : '';

        // Per-asset flow totals and route details
        const assetInflow = new Map();
        const assetOutflow = new Map();
        const assetInRoutes = new Map();
        const assetOutRoutes = new Map();

        for (const [key, amount] of flowMap) {
            const [sourceName, targetName] = key.split('→');
            assetOutflow.set(sourceName, (assetOutflow.get(sourceName) || 0) + amount);
            assetInflow.set(targetName, (assetInflow.get(targetName) || 0) + amount);
            if (!assetOutRoutes.has(sourceName)) assetOutRoutes.set(sourceName, []);
            assetOutRoutes.get(sourceName).push({ to: targetName, amount });
            if (!assetInRoutes.has(targetName)) assetInRoutes.set(targetName, []);
            assetInRoutes.get(targetName).push({ from: sourceName, amount });
        }

        // Update node value labels with monthly flow
        for (const asset of this.portfolio.modelAssets) {
            const el = this._elements.get(asset.displayName);
            if (!el) continue;
            const inAmt = assetInflow.get(asset.displayName) || 0;
            const outAmt = assetOutflow.get(asset.displayName) || 0;
            const net = inAmt - outAmt;
            if (inAmt > 0 || outAmt > 0) {
                el.valueText.textContent = (net >= 0 ? '+' : '') + formatCompact(net) + '/mo';
            } else {
                el.valueText.textContent = '';
            }
        }

        // Draw dual lines
        let totalInflow = 0, totalOutflow = 0;
        const LINE_OFFSET = 8;

        for (const [assetName, pos] of this._nodePositions) {
            const inAmt = assetInflow.get(assetName) || 0;
            const outAmt = assetOutflow.get(assetName) || 0;
            if (inAmt <= 0 && outAmt <= 0) continue;

            totalInflow += inAmt;
            totalOutflow += outAmt;

            const conduitX = pos.zone === 'left' ? this._conduitX0
                : Math.max(this._conduitX0, Math.min(this._conduitX1, pos.cx));
            const isHorizontal = pos.zone === 'left';

            if (inAmt > 0) {
                const inRoutes = assetInRoutes.get(assetName) || [];
                const tip = `${assetName}: +${formatCompact(inAmt)}/mo inflow\n` +
                    inRoutes.map(r => `  ${r.from} → ${assetName}: ${formatCompact(r.amount)}`).join('\n');
                this._drawFlowLine(pos, conduitX, isHorizontal, -LINE_OFFSET, inAmt, '#43e97b', tip);
            }
            if (outAmt > 0) {
                const outRoutes = assetOutRoutes.get(assetName) || [];
                const tip = `${assetName}: -${formatCompact(outAmt)}/mo outflow\n` +
                    outRoutes.map(r => `  ${assetName} → ${r.to}: ${formatCompact(r.amount)}`).join('\n');
                this._drawFlowLine(pos, conduitX, isHorizontal, LINE_OFFSET, outAmt, '#ff6b6b', tip);
            }
        }

        // Taxes line
        if (totalTaxes > 0) {
            const taxPos = this._nodePositions.get('Taxes');
            if (taxPos) {
                totalOutflow += totalTaxes;
                const conduitX = Math.max(this._conduitX0, Math.min(this._conduitX1, taxPos.cx));
                this._drawFlowLine(taxPos, conduitX, false, 0, totalTaxes, '#ff6b6b', `Taxes: ${formatCompact(totalTaxes)}/mo`);
            }
        }

        return { totalInflow, totalOutflow };
    }

    // ── Value mode ───────────────────────────────────────────────────

    _updateValue(historyIndex) {
        let portfolioValue = 0;
        const assetValues = new Map();

        for (const asset of this.portfolio.modelAssets) {
            const val = atIdx(asset, 'value', historyIndex);
            assetValues.set(asset.displayName, val);
            portfolioValue += val;

            const el = this._elements.get(asset.displayName);
            if (el) el.valueText.textContent = formatCompact(val);
        }

        const taxEl = this._elements.get('Taxes');
        if (taxEl) taxEl.valueText.textContent = '';

        // Draw single line per asset, width proportional to share of portfolio
        const absTotal = Math.max(1, Math.abs(portfolioValue));

        for (const [assetName, pos] of this._nodePositions) {
            if (assetName === 'Taxes') continue;
            const val = assetValues.get(assetName) || 0;
            if (val === 0) continue;

            const share = Math.abs(val) / absTotal;
            const w = Math.max(1.5, share * 24);
            const color = val >= 0 ? '#4facfe' : '#ff6b6b';

            const conduitX = pos.zone === 'left' ? this._conduitX0
                : Math.max(this._conduitX0, Math.min(this._conduitX1, pos.cx));

            this._drawFlowLine(pos, conduitX, pos.zone === 'left', 0, null, color,
                `${assetName}: ${formatCompact(val)} (${(share * 100).toFixed(1)}%)`, w);
        }

        return { portfolioValue };
    }

    // ── Generic metric mode ─────────────────────────────────────────
    // Works for growth, income, net income, contribution, expense, taxes, credit, etc.
    // For 'growth', aggregates growth + interestIncome + dividends to cover all instrument types.

    _updateGenericMetric(historyIndex, metricName) {
        let totalPositive = 0, totalNegative = 0;
        const metricLabel = MetricLabel[metricName] || metricName;

        // Compute taxes for tax-related display on the Taxes virtual node
        let totalTaxes = 0;
        if (metricName === Metric.GROWTH || metricName === Metric.TAXES) {
            for (const a of this.portfolio.modelAssets) {
                totalTaxes += Math.abs(atIdx(a, 'socialSecurityTax', historyIndex))
                            + Math.abs(atIdx(a, 'medicareTax', historyIndex))
                            + Math.abs(atIdx(a, 'withheldIncomeTax', historyIndex))
                            + Math.abs(atIdx(a, 'estimatedIncomeTax', historyIndex))
                            + Math.abs(atIdx(a, 'longTermCapitalGainTax', historyIndex))
                            + Math.abs(atIdx(a, 'shortTermCapitalGainTax', historyIndex))
                            + Math.abs(atIdx(a, 'propertyTax', historyIndex));
            }
        }

        const taxEl = this._elements.get('Taxes');
        if (taxEl) taxEl.valueText.textContent = totalTaxes > 0 ? '-' + formatCompact(totalTaxes) + '/mo' : '';

        // Read metric value per asset
        const assetMetric = new Map();
        for (const asset of this.portfolio.modelAssets) {
            let val;
            if (metricName === Metric.GROWTH) {
                // Growth: aggregate growth + interest income + dividends
                val = atIdx(asset, 'growth', historyIndex)
                    + atIdx(asset, 'interestIncome', historyIndex)
                    + atIdx(asset, 'qualifiedDividend', historyIndex)
                    + atIdx(asset, 'nonQualifiedDividend', historyIndex);
            } else {
                val = atIdx(asset, metricName, historyIndex);
            }

            assetMetric.set(asset.displayName, val);

            const el = this._elements.get(asset.displayName);
            if (el) {
                if (val !== 0) {
                    el.valueText.textContent = (val >= 0 ? '+' : '') + formatCompact(val) + '/mo';
                } else {
                    el.valueText.textContent = '';
                }
            }

            if (val > 0) totalPositive += val;
            else totalNegative += Math.abs(val);
        }

        // Draw lines
        const LINE_OFFSET = 8;

        for (const [assetName, pos] of this._nodePositions) {
            if (assetName === 'Taxes') continue;
            const val = assetMetric.get(assetName) || 0;
            if (val === 0) continue;

            const conduitX = pos.zone === 'left' ? this._conduitX0
                : Math.max(this._conduitX0, Math.min(this._conduitX1, pos.cx));
            const isHorizontal = pos.zone === 'left';
            const absVal = Math.abs(val);

            if (val > 0) {
                this._drawFlowLine(pos, conduitX, isHorizontal, -LINE_OFFSET, absVal, '#43e97b',
                    `${assetName}: +${formatCompact(val)}/mo ${metricLabel}`);
            }
            if (val < 0) {
                this._drawFlowLine(pos, conduitX, isHorizontal, LINE_OFFSET, absVal, '#ff6b6b',
                    `${assetName}: ${formatCompact(val)}/mo ${metricLabel}`);
            }
        }

        // Taxes drain (for growth and taxes metrics)
        if (totalTaxes > 0) {
            totalNegative += totalTaxes;
            const taxPos = this._nodePositions.get('Taxes');
            if (taxPos) {
                const conduitX = Math.max(this._conduitX0, Math.min(this._conduitX1, taxPos.cx));
                this._drawFlowLine(taxPos, conduitX, false, 0, totalTaxes, '#ff6b6b',
                    `Taxes: -${formatCompact(totalTaxes)}/mo`);
            }
        }

        return { totalPositive, totalNegative };
    }

    // ── Shared drawing helpers ────────────────────────────────────────

    _drawFlowLine(pos, conduitX, isHorizontal, offset, amount, color, tooltip, forceWidth) {
        const w = forceWidth ?? flowWidth(amount);
        if (w <= 0) return;

        const ox = isHorizontal ? 0 : offset;
        const oy = isHorizontal ? offset : 0;

        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', pos.cx + ox);
        line.setAttribute('y1', pos.cy + oy);
        line.setAttribute('x2', conduitX + ox);
        line.setAttribute('y2', this._conduitY + oy);
        line.setAttribute('stroke', color);
        line.setAttribute('stroke-width', w);
        line.setAttribute('stroke-linecap', 'round');
        line.style.opacity = '0.7';

        if (tooltip) {
            const title = document.createElementNS(SVG_NS, 'title');
            title.textContent = tooltip;
            line.appendChild(title);
        }
        this._flowGroup.appendChild(line);

        // Endpoint dot on conduit
        const dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('cx', conduitX + ox);
        dot.setAttribute('cy', this._conduitY + oy);
        dot.setAttribute('r', w / 2 + 2);
        dot.setAttribute('fill', color);
        dot.style.opacity = '0.85';
        this._flowGroup.appendChild(dot);
    }

    _updateClosedState(historyIndex) {
        const portfolio = this.portfolio;
        if (!portfolio?.firstDateInt) return;

        // Compute cursor date from portfolio start + historyIndex
        const startYear = portfolio.firstDateInt.year;
        const startMonth = portfolio.firstDateInt.month;
        const curMonth = ((startMonth - 1 + historyIndex) % 12) + 1;
        const curYear = startYear + Math.floor((startMonth - 1 + historyIndex) / 12);
        const curInt = curYear * 100 + curMonth;

        for (const asset of portfolio.modelAssets) {
            const el = this._elements.get(asset.displayName);
            if (!el) continue;

            // Before start date
            const assetStartInt = asset.startDateInt?.toInt() ?? 0;
            const beforeStart = curInt < assetStartInt;

            // After finish date (declared end)
            const assetFinishInt = asset.finishDateInt?.toInt() ?? 999912;
            const afterFinish = curInt > assetFinishInt;

            // Early closure during simulation
            const closedEarly = asset.closedDateInt ? curInt >= asset.closedDateInt.toInt() : false;

            const isInactive = beforeStart || afterFinish || closedEarly;

            el.group.style.opacity = isInactive ? '0.3' : '1';
            if (el.closedEmoji) {
                el.closedEmoji.style.display = isInactive ? '' : 'none';
            }
        }
    }

    _updateWealthTank(historyIndex, label) {
        if (!this._wealthFill) return;

        let portfolioValue = 0;
        for (const asset of this.portfolio.modelAssets) {
            portfolioValue += atIdx(asset, 'value', historyIndex);
        }

        const wealthEl = this._elements.get('_Wealth');
        if (wealthEl) wealthEl.valueText.textContent = label;

        // Fill level based on portfolio value within simulation range
        const range = this._valueMax - this._valueMin || 1;
        const fillPct = Math.max(0, Math.min(1, (portfolioValue - this._valueMin) / range));
        const fillH = Math.max(2, fillPct * this._wealthTankH);

        this._wealthFill.setAttribute('height', fillH);
        this._wealthFill.setAttribute('y', this._wealthTankBottom - fillH);

        let fillColor;
        if (fillPct < 0.15) fillColor = '#ff4444';
        else if (fillPct < 0.50) fillColor = '#4facfe';
        else fillColor = '#43e97b';
        this._wealthFill.setAttribute('fill', fillColor);
    }

    // ── Layout ───────────────────────────────────────────────────────

    _buildLayout(portfolio) {
        const assets = portfolio.modelAssets;

        const leftAssets = [];
        const aboveAssets = [];
        const belowAssets = [];

        for (const asset of assets) {
            const group = classifyAssetGroup(asset.instrument);
            if (group === AssetGroup.INCOME) leftAssets.push(asset);
            else if (group === AssetGroup.CAPITAL || group === AssetGroup.RETIREMENT) aboveAssets.push(asset);
            else belowAssets.push(asset);
        }

        const taxNode = { displayName: 'Taxes', _virtual: true, instrument: null };
        belowAssets.push(taxNode);

        const CONDUIT_Y = this.height * 0.48;
        const CONDUIT_X0 = 140;
        const CONDUIT_X1 = this.width - 200;
        const NODE_W = 80;
        const NODE_H = 50;

        this._conduitY = CONDUIT_Y;
        this._conduitX0 = CONDUIT_X0;
        this._conduitX1 = CONDUIT_X1;

        this._drawConduit(CONDUIT_Y, CONDUIT_X0, CONDUIT_X1);

        this._nodeGroup = document.createElementNS(SVG_NS, 'g');
        this.svg.appendChild(this._nodeGroup);

        // Wealth node
        const WEALTH_W = NODE_W * 2;
        const WEALTH_H = (NODE_H + 20) * 2;
        const wealthX = this.width - 90;
        this._drawWealthNode(wealthX, CONDUIT_Y, WEALTH_W, WEALTH_H);

        // Left (income)
        const leftGap = (CONDUIT_Y * 2) / Math.max(1, leftAssets.length + 1);
        leftAssets.forEach((asset, i) => {
            const cx = 70, cy = leftGap * (i + 1);
            this._drawAssetNode(asset, cx, cy, NODE_W, NODE_H, 'left');
            this._nodePositions.set(asset.displayName, { cx, cy, zone: 'left' });
        });

        // Above (capital/retirement)
        const aboveSpacing = (CONDUIT_X1 - CONDUIT_X0) / Math.max(1, aboveAssets.length + 1);
        aboveAssets.forEach((asset, i) => {
            const cx = CONDUIT_X0 + aboveSpacing * (i + 1), cy = CONDUIT_Y - 120;
            this._drawAssetNode(asset, cx, cy, NODE_W, NODE_H, 'above');
            this._nodePositions.set(asset.displayName, { cx, cy, zone: 'above' });
        });

        // Below (expenses/housing/taxes)
        const belowSpacing = (CONDUIT_X1 - CONDUIT_X0) / Math.max(1, belowAssets.length + 1);
        belowAssets.forEach((asset, i) => {
            const cx = CONDUIT_X0 + belowSpacing * (i + 1), cy = CONDUIT_Y + 120;
            this._drawAssetNode(asset, cx, cy, NODE_W, NODE_H, 'below');
            this._nodePositions.set(asset.displayName, { cx, cy, zone: 'below' });
        });
    }

    _drawConduit(y, x0, x1) {
        const group = document.createElementNS(SVG_NS, 'g');

        const outer = document.createElementNS(SVG_NS, 'line');
        outer.setAttribute('x1', x0); outer.setAttribute('y1', y);
        outer.setAttribute('x2', x1); outer.setAttribute('y2', y);
        outer.setAttribute('stroke', '#333');
        outer.setAttribute('stroke-width', '24');
        outer.setAttribute('stroke-linecap', 'round');
        group.appendChild(outer);

        const inner = document.createElementNS(SVG_NS, 'line');
        inner.setAttribute('x1', x0); inner.setAttribute('y1', y);
        inner.setAttribute('x2', x1); inner.setAttribute('y2', y);
        inner.setAttribute('stroke', '#1e1e2e');
        inner.setAttribute('stroke-width', '16');
        inner.setAttribute('stroke-linecap', 'round');
        group.appendChild(inner);

        const flow = document.createElementNS(SVG_NS, 'line');
        flow.setAttribute('x1', x0); flow.setAttribute('y1', y);
        flow.setAttribute('x2', x1); flow.setAttribute('y2', y);
        flow.setAttribute('stroke', '#555');
        flow.setAttribute('stroke-width', '10');
        flow.setAttribute('stroke-linecap', 'round');
        group.appendChild(flow);
        this._conduit = flow;

        const glow = document.createElementNS(SVG_NS, 'line');
        glow.setAttribute('x1', x0); glow.setAttribute('y1', y);
        glow.setAttribute('x2', x1); glow.setAttribute('y2', y);
        glow.setAttribute('stroke', '#555');
        glow.setAttribute('stroke-width', '12');
        glow.setAttribute('stroke-linecap', 'round');
        glow.style.opacity = '0';
        glow.style.filter = 'blur(4px)';
        group.appendChild(glow);
        this._conduitGlow = glow;

        // Invisible hit-target on top for hover tooltip
        const hit = document.createElementNS(SVG_NS, 'line');
        hit.setAttribute('x1', x0); hit.setAttribute('y1', y);
        hit.setAttribute('x2', x1); hit.setAttribute('y2', y);
        hit.setAttribute('stroke', 'transparent');
        hit.setAttribute('stroke-width', '24');
        hit.style.cursor = 'default';
        group.appendChild(hit);
        this._conduitHit = hit;

        this.svg.appendChild(group);
    }

    _drawAssetNode(asset, cx, cy, w, h, zone) {
        const g = document.createElementNS(SVG_NS, 'g');

        const group = asset._virtual ? AssetGroup.TAXES : classifyAssetGroup(asset.instrument);
        const meta = AssetGroupMeta.get(group);
        const color = meta?.chartColor || '#6B7280';

        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', cx - w / 2); rect.setAttribute('y', cy - h / 2);
        rect.setAttribute('width', w); rect.setAttribute('height', h);
        rect.setAttribute('rx', 8);
        rect.setAttribute('fill', '#2a2a3b');
        rect.setAttribute('stroke', color);
        rect.setAttribute('stroke-width', 2);
        g.appendChild(rect);

        const emoji = document.createElementNS(SVG_NS, 'text');
        emoji.setAttribute('x', cx); emoji.setAttribute('y', cy - 8);
        emoji.setAttribute('text-anchor', 'middle');
        emoji.setAttribute('dominant-baseline', 'central');
        emoji.setAttribute('font-size', '16px');
        emoji.textContent = meta?.groupEmoji || '';
        g.appendChild(emoji);

        const name = document.createElementNS(SVG_NS, 'text');
        name.setAttribute('x', cx); name.setAttribute('y', cy + 8);
        name.setAttribute('text-anchor', 'middle');
        name.setAttribute('dominant-baseline', 'central');
        name.setAttribute('fill', '#fff');
        name.setAttribute('font-size', '10px');
        name.setAttribute('font-weight', '600');
        const displayName = asset.displayName.length > 12
            ? asset.displayName.slice(0, 11) + '\u2026' : asset.displayName;
        name.textContent = displayName;
        g.appendChild(name);

        const valText = document.createElementNS(SVG_NS, 'text');
        const valY = zone === 'above' ? cy - h / 2 - 8 : cy + h / 2 + 14;
        valText.setAttribute('x', cx); valText.setAttribute('y', valY);
        valText.setAttribute('text-anchor', 'middle');
        valText.setAttribute('fill', '#9ca3af');
        valText.setAttribute('font-size', '10px');
        valText.textContent = asset._virtual ? '' : '$0';
        g.appendChild(valText);

        // Closed emoji (hidden by default, shown when asset is closed)
        const closedEmoji = document.createElementNS(SVG_NS, 'text');
        closedEmoji.setAttribute('x', cx); closedEmoji.setAttribute('y', cy - h / 2 - 6);
        closedEmoji.setAttribute('text-anchor', 'middle');
        closedEmoji.setAttribute('font-size', '14px');
        closedEmoji.textContent = '\u26D4';
        closedEmoji.style.display = 'none';
        g.appendChild(closedEmoji);

        this._nodeGroup.appendChild(g);
        this._elements.set(asset.displayName, { group: g, valueText: valText, closedEmoji });
    }

    _drawWealthNode(cx, cy, w, h) {
        const g = document.createElementNS(SVG_NS, 'g');

        const tank = document.createElementNS(SVG_NS, 'rect');
        tank.setAttribute('x', cx - w / 2); tank.setAttribute('y', cy - h / 2);
        tank.setAttribute('width', w); tank.setAttribute('height', h);
        tank.setAttribute('rx', 8);
        tank.setAttribute('fill', '#2a2a3b');
        tank.setAttribute('stroke', '#43e97b');
        tank.setAttribute('stroke-width', 2);
        g.appendChild(tank);

        const fill = document.createElementNS(SVG_NS, 'rect');
        fill.setAttribute('x', cx - w / 2 + 3);
        fill.setAttribute('width', w - 6);
        fill.setAttribute('height', 0);
        fill.setAttribute('y', cy + h / 2 - 3);
        fill.setAttribute('rx', 5);
        fill.setAttribute('fill', '#43e97b');
        fill.style.transition = 'all 0.3s ease';
        g.appendChild(fill);

        const label = document.createElementNS(SVG_NS, 'text');
        label.setAttribute('x', cx); label.setAttribute('y', cy - 10);
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('dominant-baseline', 'central');
        label.setAttribute('fill', '#fff');
        label.setAttribute('font-size', '16px');
        label.setAttribute('font-weight', '700');
        label.textContent = 'Cash Flow';
        g.appendChild(label);
        this._wealthLabel = label;

        const valText = document.createElementNS(SVG_NS, 'text');
        valText.setAttribute('x', cx); valText.setAttribute('y', cy + 14);
        valText.setAttribute('text-anchor', 'middle');
        valText.setAttribute('dominant-baseline', 'central');
        valText.setAttribute('fill', '#9ca3af');
        valText.setAttribute('font-size', '14px');
        valText.setAttribute('font-weight', '600');
        valText.textContent = '$0';
        g.appendChild(valText);

        this._nodeGroup.appendChild(g);

        this._wealthFill = fill;
        this._wealthTankH = h - 6;
        this._wealthTankBottom = cy + h / 2 - 3;
        this._elements.set('_Wealth', { group: g, valueText: valText });
    }

    _injectDefs() {
        const defs = document.createElementNS(SVG_NS, 'defs');
        defs.innerHTML = `
            <filter id="glow">
                <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
                <feMerge>
                    <feMergeNode in="coloredBlur"/>
                    <feMergeNode in="SourceGraphic"/>
                </feMerge>
            </filter>
        `;
        this.svg.appendChild(defs);
    }
}
