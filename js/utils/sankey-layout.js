// js/utils/sankey-layout.js

import { getAssetChartColor } from '../asset-groups.js';

export function buildSankeyLayout(pipelines, modelAssets, width, height) {
    // 1. Gather all active routes with a positive flow
    const activeRoutes = pipelines.flatMap(p => p.routes).filter(r => r.active && r.monthlyAmount > 0);
    
    if (activeRoutes.length === 0) {
        return { nodes: [], links: [], maxLayer: 0 };
    }

    // 2. Build the Node Map and accumulate flows
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
        // The visual height requirement is based on the larger of inflow or outflow
        n.value = Math.max(n.inflow, n.outflow); 
    });

    // 3. Topological Sort to assign Nodes to vertical Layers (Columns)
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

    // 4. Calculate Scaling and Position Nodes
    const padding = 20;
    const nodeWidth = 24;
    const availableHeight = height - padding * 2;
    
    // Find the column that requires the most vertical space
    let maxColValue = 0;
    columns.forEach(col => {
        const colValue = col.reduce((sum, n) => sum + n.value, 0);
        if (colValue > maxColValue) maxColValue = colValue;
    });

    const maxNodesInCol = Math.max(...columns.map(col => col.length));
    
    // Determine proportional scaling factor (ky)
    let ky = maxColValue > 0 ? (availableHeight - (maxNodesInCol - 1) * padding) / maxColValue : 1;
    ky = Math.max(0.1, ky); // Ensure minimum scaling

    columns.forEach((col, colIndex) => {
        let currentY = padding;
        // Distribute columns evenly across the SVG width
        const x = padding + colIndex * ((width - 2 * padding - nodeWidth) / (maxLayer || 1));
        
        // Sort nodes within the column descending by flow volume
        col.sort((a, b) => b.value - a.value);

        col.forEach(node => {
            node.x = x;
            node.y = currentY;
            node.w = nodeWidth;
            node.h = Math.max(4, node.value * ky);
            currentY += node.h + padding;

            // Resolve the visual color based on the asset instrument type
            const ma = modelAssets.find(a => a.displayName === node.name);
            node.color = ma ? getAssetChartColor(ma.instrument) : '#888888';
        });
    });

    // 5. Compute Link Path Origins and Destinations
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