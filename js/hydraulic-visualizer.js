import { Currency } from './currency.js';
import { InstrumentType } from './instrument.js';

const SVG_NS = "http://www.w3.org/2000/svg";

export class HydraulicVisualizer {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.svg = null;
        this.nodesMap = new Map(); 
        this.edgesMap = new Map(); 
        this.width = 1000;
        this.height = 700;
    }

    init(graphLayout, portfolio) {
        this.portfolio = portfolio; 
        this.container.innerHTML = ''; 
        this.nodesMap.clear();
        this.edgesMap.clear();

        this.svg = document.createElementNS(SVG_NS, 'svg');
        this.svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
        this.svg.style.backgroundColor = '#1e1e2e';
        this.svg.style.fontFamily = 'sans-serif';
        this.svg.style.width = '100%';
        this.svg.style.height = '100%';

        this._injectDefs();
        this.nodes = graphLayout.nodes;
        this._calculateLayout(graphLayout.nodes);

        // 1. Draw Background Main Pipe
        const bgGroup = document.createElementNS(SVG_NS, 'g');
        this.svg.appendChild(bgGroup);
        this._drawMainPipe(bgGroup);

        // 2. Draw Transfer Pipes
        const pipeGroup = document.createElementNS(SVG_NS, 'g');
        this.svg.appendChild(pipeGroup);

        // 3. Draw Nodes (Tanks, Lakes, Drains)
        const nodeGroup = document.createElementNS(SVG_NS, 'g');
        this.svg.appendChild(nodeGroup);

        for (const edge of graphLayout.edges) {
            this._drawEdge(edge, pipeGroup);
        }

        for (const node of graphLayout.nodes) {
            this._drawNode(node, nodeGroup);
        }

        this.container.appendChild(this.svg);
    }
    
    _drawMainPipe(group) {
        // Thick outer pipe structure
        const pipe = document.createElementNS(SVG_NS, 'path');
        pipe.setAttribute('d', 'M 60 180 L 850 520'); // The core diagonal
        pipe.setAttribute('stroke', '#333');
        pipe.setAttribute('stroke-width', '44');
        pipe.setAttribute('stroke-linecap', 'round');
        group.appendChild(pipe);

        // Inner channel for depth
        const pipeInner = document.createElementNS(SVG_NS, 'path');
        pipeInner.setAttribute('d', 'M 60 180 L 850 520');
        pipeInner.setAttribute('stroke', '#1e1e2e');
        pipeInner.setAttribute('stroke-width', '28');
        pipeInner.setAttribute('stroke-linecap', 'round');
        group.appendChild(pipeInner);
        
        // Subtle animated underlying flow indicating system activity
        const mainFlow = document.createElementNS(SVG_NS, 'path');
        mainFlow.setAttribute('d', 'M 60 180 L 850 520');
        mainFlow.setAttribute('stroke', 'rgba(0, 242, 254, 0.15)');
        mainFlow.setAttribute('stroke-width', '8');
        mainFlow.setAttribute('stroke-linecap', 'round');
        mainFlow.setAttribute('stroke-dasharray', '16 16');
        
        const anim = document.createElementNS(SVG_NS, 'animate');
        anim.setAttribute('attributeName', 'stroke-dashoffset');
        anim.setAttribute('from', '32');
        anim.setAttribute('to', '0');
        anim.setAttribute('dur', '2s'); 
        anim.setAttribute('repeatCount', 'indefinite');
        mainFlow.appendChild(anim);
        group.appendChild(mainFlow);
    }

    _calculateLayout(nodes) {
        const income = [], expense = [], assetsAbove = [], drainsBelow = [], wealth = [];

        for (const node of nodes) {
            if (node.category === 'IncomeLake') income.push(node);
            else if (node.category === 'ExpenseDrain') expense.push(node);
            else if (node.category === 'TaxDrain' || node.category === 'DebtDrain') drainsBelow.push(node);
            else if (node.category === 'WealthLake') wealth.push(node);
            else assetsAbove.push(node); 
        }

        // Pipe Equation: M 60 180 L 850 520  =>  Y = 180 + (340 / 790) * (X - 60)
        const getPipeY = (x) => 180 + (340 / 790) * (x - 60);

        // Income clusters near the top-left start of the pipe
        income.forEach((n, i) => { n.x = 80 + i * 110; n.y = 50; });
        
        // Spread Assets evenly above the main pipe
        const aboveSpacing = 650 / Math.max(1, assetsAbove.length + 1);
        assetsAbove.forEach((n, i) => {
            n.x = 200 + (i + 1) * aboveSpacing;
            n.y = getPipeY(n.x) - 160; // Consistently 160px above the pipe
        });

        // Spread Taxes below the pipe (left half)
        const taxSpacing = 400 / Math.max(1, drainsBelow.length + 1);
        drainsBelow.forEach((n, i) => {
            n.x = 150 + (i + 1) * taxSpacing;
            n.y = getPipeY(n.x) + 140; // Consistently 140px below the pipe
        });

        // Spread Expenses below the pipe (right half)
        const expSpacing = 200 / Math.max(1, expense.length + 1);
        expense.forEach((n, i) => {
            n.x = 550 + (i + 1) * expSpacing;
            n.y = getPipeY(n.x) + 140; 
        });

        // Growth Lake placed precisely at the exit of the pipe
        wealth.forEach((n, i) => { n.x = 850; n.y = 600; });
    }

    _drawEdge(edge, group) {
        const sourceNode = this.nodes.find(n => n.id === edge.source);
        const targetNode = this.nodes.find(n => n.id === edge.target);
        if (!sourceNode || !targetNode) return;

        // Hash offset creates parallel "lanes" so pipes don't overwrite each other
        const offsetHash = ((sourceNode.id.charCodeAt(0) + targetNode.id.charCodeAt(0)) % 7) - 3;
        const offset = offsetHash * 4; 

        const getPipeY = (x) => 180 + (340 / 790) * (x - 60);

        let startYOffset = 20;
        if (sourceNode.category.includes('Drain') || sourceNode.category === 'WealthLake') startYOffset = -20;
        else if (sourceNode.category === 'IncomeLake') startYOffset = 30;

        let endYOffset = 20;
        if (targetNode.category.includes('Drain') || targetNode.category === 'ExpenseDrain' || targetNode.category === 'WealthLake') endYOffset = -20;

        const startX = sourceNode.x;
        const startY = sourceNode.y + startYOffset;
        const endX = targetNode.x;
        const endY = targetNode.y + endYOffset;

        // Intersection points with the main diagonal pipe
        const pipeY1 = getPipeY(startX) + offset;
        const pipeY2 = getPipeY(endX) + offset;

        const vOffsetX1 = offsetHash * 2;
        const vOffsetX2 = -offsetHash * 2;

        // Drop in -> slide down pipe -> drop out
        const d = `M ${startX + vOffsetX1} ${startY} 
                   L ${startX + vOffsetX1} ${pipeY1} 
                   L ${endX + vOffsetX2} ${pipeY2} 
                   L ${endX + vOffsetX2} ${endY}`;

        const bgPath = document.createElementNS(SVG_NS, 'path');
        bgPath.setAttribute('d', d);
        bgPath.setAttribute('stroke', 'rgba(0,0,0,0.4)');
        bgPath.setAttribute('stroke-width', 6);
        bgPath.setAttribute('fill', 'none');
        bgPath.setAttribute('stroke-linejoin', 'round');
        group.appendChild(bgPath);

        const flowPath = document.createElementNS(SVG_NS, 'path');
        flowPath.setAttribute('d', d);
        
        const isTax = edge.type === 'Tax' || targetNode.category.includes('Drain');
        flowPath.setAttribute('stroke', isTax ? '#ffb199' : '#00f2fe');
        flowPath.setAttribute('stroke-width', 4);
        flowPath.setAttribute('fill', 'none');
        flowPath.setAttribute('stroke-linejoin', 'round');
        flowPath.setAttribute('stroke-dasharray', '12 12');
        flowPath.style.opacity = '0'; 

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

    _drawNode(node, group) {
        const g = document.createElementNS(SVG_NS, 'g');
        let waterRect = null;
        let capacity = null;

        const asset = this.portfolio.modelAssets.find(a => a.displayName === node.id);

        if (node.category === 'IncomeLake') {
            const el = document.createElementNS(SVG_NS, 'ellipse');
            el.setAttribute('cx', node.x); el.setAttribute('cy', node.y);
            el.setAttribute('rx', 50); el.setAttribute('ry', 30);
            el.setAttribute('fill', 'url(#waterGrad)');
            g.appendChild(el);
        } 
        else if (node.category.includes('Drain')) {
            const el = document.createElementNS(SVG_NS, 'rect');
            el.setAttribute('x', node.x - 45); el.setAttribute('y', node.y - 15);
            el.setAttribute('width', 90); el.setAttribute('height', 30);
            el.setAttribute('rx', 8);
            el.setAttribute('fill', 'url(#drainGrad)');
            g.appendChild(el);
        } 
        else {
            const bg = document.createElementNS(SVG_NS, 'rect');
            bg.setAttribute('x', node.x - 40); bg.setAttribute('y', node.y - 50);
            bg.setAttribute('width', 80); bg.setAttribute('height', 100);
            bg.setAttribute('rx', 5); bg.setAttribute('fill', '#2a2a3b');
            bg.setAttribute('stroke', '#555'); bg.setAttribute('stroke-width', 2);
            g.appendChild(bg);

            waterRect = document.createElementNS(SVG_NS, 'rect');
            waterRect.setAttribute('x', node.x - 38); 
            
            // Set capacity so normal tanks start exactly half full based on starting value
            let startAmount = asset ? asset.startCurrency.amount : 0;
            if (node.category === 'WealthLake') {
                startAmount = this.portfolio.startValue().amount;
            }

            capacity = Math.max(50000, Math.abs(startAmount) * 2); 
            
            const fillPct = Math.min(1.0, Math.max(0, startAmount / capacity));
            const maxHeight = 96; 
            const initialHeight = Math.max(2, maxHeight * fillPct);
            const bottomY = node.y + 48; 

            waterRect.setAttribute('y', bottomY - initialHeight);
            waterRect.setAttribute('width', 76); 
            waterRect.setAttribute('height', initialHeight);
            
            let fill = 'url(#waterGrad)';
            if (node.category === 'TaxFreeReservoir' || node.category === 'WealthLake') fill = 'url(#wealthGrad)';
            if (node.category === 'CheckingHub') fill = '#aaa';
            
            waterRect.setAttribute('fill', fill);
            waterRect.style.transition = 'all 0.3s ease'; 
            g.appendChild(waterRect);
        }

        let labelY = node.y - 60;
        if (node.category === 'IncomeLake') labelY = node.y - 45;
        if (node.category.includes('Drain')) labelY = node.y + 35;

        const title = document.createElementNS(SVG_NS, 'text');
        title.setAttribute('x', node.x); title.setAttribute('y', labelY);
        title.setAttribute('fill', '#fff'); title.setAttribute('font-size', '12px');
        title.setAttribute('font-weight', 'bold'); title.setAttribute('text-anchor', 'middle');
        title.textContent = node.label;
        g.appendChild(title);

        const valText = document.createElementNS(SVG_NS, 'text');
        valText.setAttribute('x', node.x); valText.setAttribute('y', labelY + 14);
        valText.setAttribute('fill', '#aaa'); valText.setAttribute('font-size', '11px');
        valText.setAttribute('text-anchor', 'middle');
        valText.textContent = "$0";
        g.appendChild(valText);

        group.appendChild(g);
        this.nodesMap.set(node.id, { waterRect, valText, capacity, y: node.y });
    }

    update(graphLayout, portfolio) {
        if (!this.svg) return;

        // 1. Update Pipes
        for (const edge of graphLayout.edges) {
            const edgeElements = this.edgesMap.get(`${edge.source}->${edge.target}`);
            if (!edgeElements) continue;

            const { flowPath, flowAnim } = edgeElements;
            
            if (edge.flowAmount > 0) {
                flowPath.style.opacity = '1';
                let speed = Math.max(0.1, 2.0 - (edge.flowAmount / 5000));
                flowAnim.setAttribute('dur', `${speed}s`);
                let width = Math.min(12, Math.max(4, edge.flowAmount / 1000));
                flowPath.setAttribute('stroke-width', width);
            } else {
                flowPath.style.opacity = '0'; 
            }
        }

        // 2. Update Standard Assets
        for (const asset of portfolio.modelAssets) {
            const nodeElements = this.nodesMap.get(asset.displayName);
            if (!nodeElements) continue;

            let displayValue = asset.finishCurrency;
            if (InstrumentType.isMonthlyIncome(asset.instrument)) displayValue = asset.incomeCurrency;
            else if (InstrumentType.isMonthlyExpense(asset.instrument) || InstrumentType.isDebt(asset.instrument) || InstrumentType.isMortgage(asset.instrument)) {
                displayValue = asset.accumulatedCurrency;
            }

            nodeElements.valText.textContent = displayValue.toCurrency();

            if (nodeElements.waterRect && nodeElements.capacity) {
                const fillPct = Math.max(0, Math.min(1.0, asset.finishCurrency.amount / nodeElements.capacity));
                const maxHeight = 96;
                const newHeight = Math.max(2, maxHeight * fillPct);
                nodeElements.waterRect.setAttribute('height', newHeight);
                nodeElements.waterRect.setAttribute('y', nodeElements.y + 48 - newHeight);
            }
        }

        // 3. Update Growth Lake
        const wealthElements = this.nodesMap.get('Global_Wealth');
        if (wealthElements) {
            const accValue = portfolio.accumulatedValue().amount;
            wealthElements.valText.textContent = '$' + accValue.toLocaleString(undefined, { maximumFractionDigits: 0 });
            
            if (this.baselineWealth === undefined) {
                this.baselineWealth = portfolio.startValue().amount;
            }
            
            // Swing capacity ensures it starts half full, and fills/drains based on growth vs starting wealth
            const swingCapacity = Math.max(50000, Math.abs(this.baselineWealth) * 2);
            const currentDiff = accValue - this.baselineWealth;
            
            let fillPct = 0.5 + (currentDiff / swingCapacity);
            fillPct = Math.max(0, Math.min(1.0, fillPct));

            const maxHeight = 96;
            const newHeight = Math.max(2, maxHeight * fillPct);
            wealthElements.waterRect.setAttribute('height', newHeight);
            wealthElements.waterRect.setAttribute('y', wealthElements.y + 48 - newHeight);
            
            // Color feedback: Green if portfolio has grown, Red if shrinking
            wealthElements.waterRect.setAttribute('fill', currentDiff >= 0 ? 'url(#wealthGrad)' : 'url(#drainGrad)');
        }
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