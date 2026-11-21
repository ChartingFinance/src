/**
 * sankey-layout.js — layered Sankey diagram geometry for monthly cash flows.
 *
 * Takes active flow pipelines and computes node column placement, proportional
 * bar heights, instrument colors, and link endpoint coordinates for rendering
 * in the SVG Sankey diagram.
 */

import { getAssetChartColor } from '../asset-groups.js';

/**
 * Compute node rectangles and link endpoints for the monthly cash-flow Sankey.
 *
 * @param {Array<{routes: Array<{active: boolean, monthlyAmount: number, sourceName: string, targetName: string}>}>} pipelines
 * @param {Array<{displayName: string, instrument: string}>} modelAssets
 * @param {number} width   SVG viewport width in pixels
 * @param {number} height  SVG viewport height in pixels
 * @returns {{ nodes: Array<object>, links: Array<object>, maxLayer: number }}
 */
export function buildSankeyLayout(pipelines, modelAssets, width, height) {
    // 1. Gather all active routes with a positive monthly flow.
    const activeRoutes = pipelines.flatMap(p => p.routes).filter(r => r.active && r.monthlyAmount > 0);
    
    if (activeRoutes.length === 0) {
        return { nodes: [], links: [], maxLayer: 0 };
    }

    // 2. Build the node map and accumulate total inflow and outflow per node.
    const nodeMap = new Map();
    const getOrCreateNode = (name) => {
        if (!nodeMap.has(name)) {
            nodeMap.set(name, { name, inflow: 0, outflow: 0, sourceLinks: [], targetLinks: [] });
        }
        return nodeMap.get(name);
    };

    activeRoutes.forEach(route => {
        const source = getOrCreateNode(route.sourceName);
        const target = getOrCreateNode(route.targetName);
        const amount = route.monthlyAmount;

        source.outflow += amount;
        target.inflow += amount;

        const link = { source, target, amount, sourceName: route.sourceName, targetName: route.targetName };
        source.sourceLinks.push(link);
        target.targetLinks.push(link);
    });

    const nodes = Array.from(nodeMap.values());
    nodes.forEach(n => {
        // Node height reflects the larger of its total inflow or outflow.
        n.value = Math.max(n.inflow, n.outflow); 
    });

    // 3. Assign nodes to vertical columns via iterative topological relaxation
    //    (capped at 100 passes so cycles cannot loop forever).
    nodes.forEach(n => n.layer = 0);
    let changed = true;
    let iterations = 0;
    while (changed && iterations < 100) {
        changed = false;
        nodes.forEach(n => {
            n.sourceLinks.forEach(link => {
                if (link.target.layer <= n.layer) {
                    link.target.layer = n.layer + 1;
                    changed = true;
                }
            });
        });
        iterations++;
    }

    const maxLayer = Math.max(0, ...nodes.map(n => n.layer));
    const columns = Array.from({ length: maxLayer + 1 }, () => []);
    nodes.forEach(n => columns[n.layer].push(n));

    // 4. Compute vertical scale and position nodes within each column.
    const padding = 20;
    const nodeWidth = 24;
    const availableHeight = height - padding * 2;
    
    // Find the column with the largest total flow volume.
    let maxColValue = 0;
    columns.forEach(col => {
        const colValue = col.reduce((sum, n) => sum + n.value, 0);
        if (colValue > maxColValue) maxColValue = colValue;
    });

    const maxNodesInCol = Math.max(...columns.map(col => col.length));
    
    // Dollars-to-pixels vertical scaling factor, floored so tiny flows stay visible.
    let ky = maxColValue > 0 ? (availableHeight - (maxNodesInCol - 1) * padding) / maxColValue : 1;
    ky = Math.max(0.1, ky); // Ensure a readable minimum scale

    columns.forEach((col, colIndex) => {
        let currentY = padding;
        // Distribute columns evenly across the SVG width.
        const x = padding + colIndex * ((width - 2 * padding - nodeWidth) / (maxLayer || 1));
        
        // Sort nodes within each column from largest flow to smallest.
        col.sort((a, b) => b.value - a.value);

        col.forEach(node => {
            node.x = x;
            node.y = currentY;
            node.w = nodeWidth;
            node.h = Math.max(4, node.value * ky);
            currentY += node.h + padding;

            // Color each node by its asset's instrument category.
            const ma = modelAssets.find(a => a.displayName === node.name);
            node.color = ma ? getAssetChartColor(ma.instrument) : '#888888';
        });
    });

    // 5. Compute link thickness and stacked y-anchors on source and target nodes.
    const links = [];
    nodes.forEach(n => {
        let sy = n.y; // Source y cursor
        n.sourceLinks.forEach(link => {
            link.thickness = Math.max(1, link.amount * ky);
            link.y0 = sy + link.thickness / 2;
            sy += link.thickness;
        });

        let ty = n.y; // Target y cursor
        n.targetLinks.forEach(link => {
            link.thickness = Math.max(1, link.amount * ky);
            link.y1 = ty + link.thickness / 2;
            ty += link.thickness;
        });
    });

    nodes.forEach(n => {
        n.sourceLinks.forEach(link => {
            links.push({
                sourceName: link.sourceName,
                targetName: link.targetName,
                amount: link.amount,
                thickness: link.thickness,
                x0: link.source.x + link.source.w,
                y0: link.y0,
                x1: link.target.x,
                y1: link.y1,
                sourceColor: link.source.color,
                targetColor: link.target.color
            });
        });
    });

    return {
        nodes: nodes.map(n => ({
            name: n.name,
            x: n.x, y: n.y, w: n.w, h: n.h,
            color: n.color,
            flow: n.value,
            col: n.layer
        })),
        links,
        maxLayer
    };
}