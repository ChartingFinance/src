import { Currency } from './currency.js';
import { InstrumentType } from './instrument.js';

const SVG_NS = "http://www.w3.org/2000/svg";

export class HydraulicVisualizer {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.svg = null;
        this.nodesMap = new Map(); // Store node DOM elements for quick updates
        this.edgesMap = new Map(); // Store edge DOM elements for quick updates
        
        // Layout configuration
        this.width = 1000;
        this.height = 700;
        this.cols = {
            INCOME: 100,
            HUB: 400,
            RESERVOIR: 700
        };
        this.rowSpacing = 120;
    }

    /**
     * Call this ONCE before the chronometer starts to build the SVG layout.
     */
    init(graphLayout) {
        this.container.innerHTML = ''; // Clear container
        this.nodesMap.clear();
        this.edgesMap.clear();

        this.svg = document.createElementNS(SVG_NS, 'svg');
        this.svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
        this.svg.style.backgroundColor = '#1e1e2e';
        this.svg.style.fontFamily = 'sans-serif';
        this.svg.style.width = '100%';
        this.svg.style.height = '100%';

        this._injectDefs();
        this._calculateLayout(graphLayout.nodes);

        // Group to hold pipes (drawn first so they are behind nodes)
        const pipeGroup = document.createElementNS(SVG_NS, 'g');
        this.svg.appendChild(pipeGroup);

        // Group to hold nodes
        const nodeGroup = document.createElementNS(SVG_NS, 'g');
        this.svg.appendChild(nodeGroup);

        // Draw Edges (Pipes)
        for (const edge of graphLayout.edges) {
            this._drawEdge(edge, pipeGroup);
        }

        // Draw Nodes
        for (const node of graphLayout.nodes) {
            this._drawNode(node, nodeGroup);
        }

        this.container.appendChild(this.svg);
    }

    /**
     * Call this inside chronometer_run() every month to animate flows and update balances.
     */
    update(graphLayout, portfolio) {
        if (!this.svg) return;

        // 1. Update Pipe Flows
        for (const edge of graphLayout.edges) {
            const edgeElements = this.edgesMap.get(`${edge.source}->${edge.target}`);
            if (!edgeElements) continue;

            const { flowPath, flowAnim } = edgeElements;
            
            if (edge.flowAmount > 0) {
                flowPath.style.opacity = '1';
                // Higher flow = faster animation (lower duration)
                // Cap speed between 0.1s (fast) and 2.0s (slow)
                let speed = Math.max(0.1, 2.0 - (edge.flowAmount / 5000));
                flowAnim.setAttribute('dur', `${speed}s`);
                
                // Thickness based on volume
                let width = Math.min(12, Math.max(4, edge.flowAmount / 1000));
                flowPath.setAttribute('stroke-width', width);
            } else {
                // Turn off the flow animation if no water moved this month
                flowPath.style.opacity = '0'; 
            }
        }

        // 2. Update Node Balances (Reservoir Levels & Text)
        for (const asset of portfolio.modelAssets) {
            const nodeElements = this.nodesMap.get(asset.displayName);
            if (!nodeElements) continue;

            // Update subtext to show current value/balance
            let displayValue = asset.finishCurrency;
            if (InstrumentType.isMonthlyIncome(asset.instrument)) {
                displayValue = asset.incomeCurrency; // Show monthly flow for income
            }
            nodeElements.valText.textContent = displayValue.toCurrency();

            // Animate Reservoir Water Level
            if (nodeElements.waterRect && asset.accumulatedCurrency.amount > 0) {
                // For prototype, assume a max visual capacity of $1,000,000 to scale the rect
                // You can make this dynamic by tracking max portfolio value
                const fillPct = Math.min(1.0, asset.finishCurrency.amount / 1000000); 
                const maxHeight = 68; // Based on our SVG rect size
                const newHeight = Math.max(2, maxHeight * fillPct);
                const newY = 180 + (maxHeight - newHeight); // Push Y down so it fills from bottom
                
                nodeElements.waterRect.setAttribute('height', newHeight);
                nodeElements.waterRect.setAttribute('y', newY);
            }
        }
    }

    // --- Private Render Helpers ---

    _calculateLayout(nodes) {
        // Group nodes by their column assignments
        const columns = { income: [], hub: [], reservoir: [], drains: [] };

        for (const node of nodes) {
            if (node.category === 'IncomeLake') columns.income.push(node);
            else if (node.category === 'CheckingHub') columns.hub.push(node);
            else if (node.category.includes('Drain')) columns.drains.push(node);
            else columns.reservoir.push(node);
        }

        // Assign coordinates
        const assignCoords = (arr, startX, startY) => {
            arr.forEach((node, i) => {
                node.x = startX;
                node.y = startY + (i * this.rowSpacing);
            });
        };

        assignCoords(columns.income, this.cols.INCOME, 150);
        assignCoords(columns.hub, this.cols.HUB, 200);
        assignCoords(columns.reservoir, this.cols.RESERVOIR, 100);
        
        // Spread drains along the bottom
        const drainSpacing = this.width / (columns.drains.length + 1);
        columns.drains.forEach((node, i) => {
            node.x = drainSpacing * (i + 1);
            node.y = this.height - 100; // Bottom row
        });
    }

    _drawNode(node, group) {
        const g = document.createElementNS(SVG_NS, 'g');
        let waterRect = null;

        if (node.category === 'IncomeLake') {
            const el = document.createElementNS(SVG_NS, 'ellipse');
            el.setAttribute('cx', node.x); el.setAttribute('cy', node.y);
            el.setAttribute('rx', 60); el.setAttribute('ry', 35);
            el.setAttribute('fill', 'url(#waterGrad)');
            g.appendChild(el);
        } 
        else if (node.category.includes('Drain')) {
            const el = document.createElementNS(SVG_NS, 'rect');
            el.setAttribute('x', node.x - 50); el.setAttribute('y', node.y - 20);
            el.setAttribute('width', 100); el.setAttribute('height', 40);
            el.setAttribute('rx', 8);
            el.setAttribute('fill', 'url(#drainGrad)');
            g.appendChild(el);
        } 
        else {
            // Reservoir or Hub (Tanks)
            const bg = document.createElementNS(SVG_NS, 'rect');
            bg.setAttribute('x', node.x - 40); bg.setAttribute('y', node.y - 50);
            bg.setAttribute('width', 80); bg.setAttribute('height', 100);
            bg.setAttribute('rx', 5); bg.setAttribute('fill', '#2a2a3b');
            bg.setAttribute('stroke', '#555'); bg.setAttribute('stroke-width', 2);
            g.appendChild(bg);

            waterRect = document.createElementNS(SVG_NS, 'rect');
            waterRect.setAttribute('x', node.x - 38); 
            waterRect.setAttribute('y', node.y + 48); // Start empty at bottom
            waterRect.setAttribute('width', 76); 
            waterRect.setAttribute('height', 0);
            
            // Color code based on tax status
            let fill = 'url(#waterGrad)';
            if (node.category === 'TaxFreeReservoir') fill = 'url(#wealthGrad)';
            if (node.category === 'CheckingHub') fill = '#aaa';
            
            waterRect.setAttribute('fill', fill);
            waterRect.style.transition = 'all 0.3s ease'; // Smooth filling
            g.appendChild(waterRect);
        }

        // Labels
        const title = document.createElementNS(SVG_NS, 'text');
        title.setAttribute('x', node.x); title.setAttribute('y', node.category.includes('Drain') ? node.y + 5 : node.y - 65);
        title.setAttribute('fill', '#fff'); title.setAttribute('font-size', '14px');
        title.setAttribute('font-weight', 'bold'); title.setAttribute('text-anchor', 'middle');
        title.textContent = node.label;
        g.appendChild(title);

        const valText = document.createElementNS(SVG_NS, 'text');
        valText.setAttribute('x', node.x); valText.setAttribute('y', node.category.includes('Drain') ? node.y + 20 : node.y + 70);
        valText.setAttribute('fill', '#aaa'); valText.setAttribute('font-size', '12px');
        valText.setAttribute('text-anchor', 'middle');
        valText.textContent = "$0";
        g.appendChild(valText);

        group.appendChild(g);
        
        // Save references for the update loop
        this.nodesMap.set(node.id, { waterRect, valText });
    }

    _drawEdge(edge, group) {
        // Find source and target nodes to get coordinates
        const srcNode = Array.from(this.nodesMap.keys()).map(k => this._findNodeLayout(k)); // Need to pass nodes array to class or find another way
        // Let's attach x, y directly to the edge object in the mapper, or search the DOM.
        // For simplicity, we assume graphLayout.nodes is available in this scope.
    }
    
    // Helper to find layout coords
    _getCoords(nodeId, nodes) {
        const n = nodes.find(n => n.id === nodeId);
        return n ? { x: n.x, y: n.y } : { x: 0, y: 0 };
    }

    _drawEdge(edge, group) {
        // Note: this relies on node x/y being assigned in _calculateLayout
        const sourceNode = this.nodes.find(n => n.id === edge.source);
        const targetNode = this.nodes.find(n => n.id === edge.target);
        
        if (!sourceNode || !targetNode) return;

        // Create an elbow-joint path
        const midX = (sourceNode.x + targetNode.x) / 2;
        const d = `M ${sourceNode.x} ${sourceNode.y} L ${midX} ${sourceNode.y} L ${midX} ${targetNode.y} L ${targetNode.x} ${targetNode.y}`;

        // Static Background Pipe
        const bgPath = document.createElementNS(SVG_NS, 'path');
        bgPath.setAttribute('d', d);
        bgPath.setAttribute('stroke', '#333');
        bgPath.setAttribute('stroke-width', 10);
        bgPath.setAttribute('fill', 'none');
        bgPath.setAttribute('stroke-linejoin', 'round');
        group.appendChild(bgPath);

        // Animated Flow Water
        const flowPath = document.createElementNS(SVG_NS, 'path');
        flowPath.setAttribute('d', d);
        
        const isTax = edge.type === 'Tax' || targetNode.category.includes('Drain');
        flowPath.setAttribute('stroke', isTax ? '#ffb199' : '#00f2fe');
        
        flowPath.setAttribute('stroke-width', 6);
        flowPath.setAttribute('fill', 'none');
        flowPath.setAttribute('stroke-linejoin', 'round');
        flowPath.setAttribute('stroke-dasharray', '12 12');
        flowPath.style.opacity = '0'; // Hidden initially

        const anim = document.createElementNS(SVG_NS, 'animate');
        anim.setAttribute('attributeName', 'stroke-dashoffset');
        anim.setAttribute('from', '24');
        anim.setAttribute('to', '0');
        anim.setAttribute('dur', '1s');
        anim.setAttribute('repeatCount', 'indefinite');
        flowPath.appendChild(anim);

        group.appendChild(flowPath);

        this.edgesMap.set(`${edge.source}->${edge.target}`, { flowPath, flowAnim: anim });
    }

    _injectDefs() {
        const defs = document.createElementNS(SVG_NS, 'defs');
        defs.innerHTML = `
            <linearGradient id="waterGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#4facfe" />
                <stop offset="100%" stop-color="#00f2fe" />
            </linearGradient>
            <linearGradient id="wealthGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#43e97b" />
                <stop offset="100%" stop-color="#38f9d7" />
            </linearGradient>
            <linearGradient id="drainGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#ff0844" />
                <stop offset="100%" stop-color="#ffb199" />
            </linearGradient>
        `;
        this.svg.appendChild(defs);
    }
}
