/**
 * sankey-layout.js
 *
 * Computes a three-column Sankey layout from pipeline data.
 * Columns: Sources (left) → Dual-role (middle) → Sinks (right)
 * Node height is proportional to FLOW VOLUME (money moving through),
 * not asset value.
 *
 * Returns { nodes, links } ready for SVG rendering.
 */

import { AssetGroupMeta, classifyAssetGroup } from '../asset-groups.js';

/**
 * Build Sankey layout from pipeline routes.
 *
 * @param {Pipeline[]} pipelines — from buildPipelines()
 * @param {ModelAsset[]} modelAssets — for instrument classification
 * @param {number} width — SVG viewBox width
 * @param {number} height — SVG viewBox height
 * @returns {{ nodes: SankeyNode[], links: SankeyLink[] }}
 */
export function buildSankeyLayout(pipelines, modelAssets, width = 700, height = 400) {
    // 1. Collect all active routes with non-zero amounts
    const routes = [];
    for (const p of pipelines) {
        for (const r of p.routes) {
            if (r.monthlyAmount > 0 && r.active) {
                routes.push(r);
            }
        }
    }

    if (routes.length === 0) return { nodes: [], links: [] };

    // 2. Compute flow volume per node (sum of all flows through it)
    const outFlow = new Map();  // total money leaving this node
    const inFlow = new Map();   // total money entering this node
    for (const r of routes) {
        outFlow.set(r.sourceName, (outFlow.get(r.sourceName) || 0) + r.monthlyAmount);
        inFlow.set(r.targetName, (inFlow.get(r.targetName) || 0) + r.monthlyAmount);
    }

    // 3. Classify nodes: source-only, target-only, or dual
    const allNames = new Set([...outFlow.keys(), ...inFlow.keys()]);
    const leftNames = [];
    const middleNames = [];
    const rightNames = [];

    for (const name of allNames) {
        const sends = outFlow.has(name);
        const receives = inFlow.has(name);
        if (sends && receives) middleNames.push(name);
        else if (sends) leftNames.push(name);
        else rightNames.push(name);
    }

    // Node flow = max of inbound or outbound (for sizing)
    const nodeFlow = new Map();
    for (const name of allNames) {
        nodeFlow.set(name, Math.max(outFlow.get(name) || 0, inFlow.get(name) || 0));
    }

    // 4. Asset lookup for colors
    const assetMap = new Map();
    for (const a of modelAssets) assetMap.set(a.displayName, a);

    // 5. Layout parameters
    const PAD_Y = 24;
    const NODE_W = 28;
    const NODE_GAP = 12;
    const MIN_NODE_H = 14;
    const LABEL_MARGIN = 90;

    const hasMiddle = middleNames.length > 0;

    const colX = hasMiddle
        ? [LABEL_MARGIN, width / 2, width - LABEL_MARGIN]
        : [LABEL_MARGIN, width - LABEL_MARGIN];

    // 6. Stack nodes vertically, height proportional to flow volume
    function layoutColumn(names, x, colIndex) {
        if (names.length === 0) return [];

        const sorted = [...names].sort((a, b) => nodeFlow.get(b) - nodeFlow.get(a));
        const totalFlow = sorted.reduce((s, n) => s + nodeFlow.get(n), 0);
        const totalGap = (sorted.length - 1) * NODE_GAP;
        const availH = height - 2 * PAD_Y - totalGap;

        const nodes = [];
        let y = PAD_Y;

        for (const name of sorted) {
            const flow = nodeFlow.get(name);
            const h = Math.max(MIN_NODE_H, (flow / totalFlow) * availH);
            const asset = assetMap.get(name);
            const group = asset ? classifyAssetGroup(asset.instrument) : null;
            const meta = group ? AssetGroupMeta.get(group) : null;

            nodes.push({
                name,
                x,
                y,
                w: NODE_W,
                h,
                col: colIndex,
                color: meta?.chartColor || '#6B7280',
                emoji: meta?.groupEmoji || '',
                flow,
            });
            y += h + NODE_GAP;
        }

        // Center the column vertically if it doesn't fill the height
        const totalUsed = y - NODE_GAP - PAD_Y;
        if (totalUsed < availH + totalGap) {
            const offset = (height - 2 * PAD_Y - totalUsed) / 2;
            for (const n of nodes) n.y += offset;
        }

        return nodes;
    }

    const leftNodes = layoutColumn(leftNames, colX[0], 0);
    const middleNodes = hasMiddle ? layoutColumn(middleNames, colX[1], 1) : [];
    const rightNodes = layoutColumn(rightNames, colX[hasMiddle ? 2 : 1], hasMiddle ? 2 : 1);

    const allNodes = [...leftNodes, ...middleNodes, ...rightNodes];
    const nodeByName = new Map();
    for (const n of allNodes) nodeByName.set(n.name, n);

    // 7. Aggregate routes by source→target pair for cleaner Sankey links
    const aggregated = new Map();
    for (const r of routes) {
        const key = `${r.sourceName}→${r.targetName}`;
        if (aggregated.has(key)) {
            aggregated.get(key).monthlyAmount += r.monthlyAmount;
        } else {
            aggregated.set(key, { ...r, monthlyAmount: r.monthlyAmount });
        }
    }
    const mergedRoutes = [...aggregated.values()].sort((a, b) => b.monthlyAmount - a.monthlyAmount);

    // 8. Build links with y-offsets within each node
    const sourceOffset = new Map();
    const targetOffset = new Map();
    for (const n of allNodes) {
        sourceOffset.set(n.name, 0);
        targetOffset.set(n.name, 0);
    }

    const MIN_LINK = 3;

    const links = [];
    for (const r of mergedRoutes) {
        const srcNode = nodeByName.get(r.sourceName);
        const tgtNode = nodeByName.get(r.targetName);
        if (!srcNode || !tgtNode) continue;

        // Link thickness proportional to flow relative to the node it exits
        const srcTotal = outFlow.get(r.sourceName) || 1;
        const linkH = Math.max(MIN_LINK, (r.monthlyAmount / srcTotal) * srcNode.h);

        const srcY = srcNode.y + sourceOffset.get(r.sourceName);
        const tgtY = tgtNode.y + targetOffset.get(r.targetName);

        sourceOffset.set(r.sourceName, sourceOffset.get(r.sourceName) + linkH);
        targetOffset.set(r.targetName, targetOffset.get(r.targetName) + linkH);

        const srcAsset = assetMap.get(r.sourceName);
        const tgtAsset = assetMap.get(r.targetName);
        const srcGroup = srcAsset ? classifyAssetGroup(srcAsset.instrument) : null;
        const tgtGroup = tgtAsset ? classifyAssetGroup(tgtAsset.instrument) : null;

        links.push({
            sourceName: r.sourceName,
            targetName: r.targetName,
            x0: srcNode.x + NODE_W / 2,
            y0: srcY + linkH / 2,
            x1: tgtNode.x - NODE_W / 2,
            y1: tgtY + linkH / 2,
            thickness: linkH,
            amount: r.monthlyAmount,
            type: r.type,
            sourceColor: AssetGroupMeta.get(srcGroup)?.chartColor || '#6B7280',
            targetColor: AssetGroupMeta.get(tgtGroup)?.chartColor || '#6B7280',
        });
    }

    return { nodes: allNodes, links, colX, hasMiddle };
}
