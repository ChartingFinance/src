import { InstrumentType } from './instruments/instrument.js';

export class GraphMapper {
    
    /**
     * Builds a static node and edge map from the current Portfolio configuration.
     * @param {Portfolio} portfolio 
     * @returns {Object} { nodes: Array, edges: Array }
     */
    static buildGraph(portfolio) {
        const nodes = [];
        const edges = [];

        // 1. Define the Global Sink Nodes (The Drains)
        // We create explicit nodes for taxes so we can route the "little outflows" to them.
        const sinks = [
            { id: 'Sink_FICA', label: 'FICA / Medicare', category: 'TaxDrain' },
            { id: 'Sink_IncomeTax', label: 'Income Tax', category: 'TaxDrain' },
            { id: 'Sink_CapGainsTax', label: 'Capital Gains Tax', category: 'TaxDrain' },
            { id: 'Sink_PropertyTax', label: 'Property Tax', category: 'TaxDrain' },
            { id: 'Sink_MortgageInterest', label: 'Mortgage Interest', category: 'DebtDrain' }
        ];
        nodes.push(...sinks);

        nodes.push({ id: 'Global_Wealth', label: 'Wealth', category: 'WealthLake' });

        // 2. Iterate Model Assets to build Nodes and Implicit Edges
        for (const asset of portfolio.modelAssets) {

            // Determine the visual category based on InstrumentType
            let category = 'Unknown';
            if (InstrumentType.isMonthlyIncome(asset.instrument)) {
                category = 'IncomeLake';
            } else if (InstrumentType.isMonthlyExpense(asset.instrument)) {
                category = 'ExpenseDrain';
            } else if (InstrumentType.isMortgage(asset.instrument)) {
                category = 'DebtDrain';
            } else if (InstrumentType.isRealEstate(asset.instrument)) {
                category = 'IlliquidAsset';
            } else if (InstrumentType.isTaxDeferred(asset.instrument)) {
                category = 'TaxDeferredReservoir';
            } else if (InstrumentType.isTaxFree(asset.instrument)) {
                category = 'TaxFreeReservoir';
            } else if (InstrumentType.isTaxableAccount(asset.instrument)) {
                category = 'TaxableReservoir';
            } else if (InstrumentType.isExpensable(asset.instrument)) {
                category = 'CheckingHub';
            }

            // Tax edges — independent of category so nothing gets skipped
            if (InstrumentType.isWorkingIncome(asset.instrument)) {
                edges.push({ source: asset.displayName, target: 'Sink_FICA', type: 'Tax' });
            }
            if (InstrumentType.isMonthlyIncome(asset.instrument)) {
                edges.push({ source: asset.displayName, target: 'Sink_IncomeTax', type: 'Tax' });
            }
            if (InstrumentType.isRealEstate(asset.instrument)) {
                edges.push({ source: asset.displayName, target: 'Sink_PropertyTax', type: 'Tax' });
            }
            if (InstrumentType.isTaxDeferred(asset.instrument)) {
                edges.push({ source: asset.displayName, target: 'Sink_IncomeTax', type: 'Tax' });
            }
            if (InstrumentType.isBasisable(asset.instrument)) {
                // Taxable equity and real estate generate capital gains on sale
                edges.push({ source: asset.displayName, target: 'Sink_CapGainsTax', type: 'Tax' });
            }

            // Add the Asset Node
            nodes.push({
                id: asset.displayName,
                label: asset.displayName,
                category: category
            });

            // 3. Extract Explicit Edges (Fund Transfers)
            let hasMortgageMonthlyEdge = false;
            if (asset.fundTransfers && asset.fundTransfers.length > 0) {
                for (const ft of asset.fundTransfers) {
                    // Expenses and Debt drain from their targets, so the flow of money is reversed
                    const isPull = InstrumentType.isMonthlyExpense(asset.instrument) ||
                       InstrumentType.isMortgage(asset.instrument);

                    const isCloseOnly = !ft.hasRecurring && ft.hasClose;

                    // Skip close-only transfers for mortgages — we'll add an implicit monthly edge
                    if (InstrumentType.isMortgage(asset.instrument) && isCloseOnly) continue;

                    if (InstrumentType.isMortgage(asset.instrument) && ft.hasRecurring) {
                        hasMortgageMonthlyEdge = true;
                        // Interest drain: funding source → Sink_MortgageInterest
                        edges.push({
                            source: ft.toDisplayName,
                            target: 'Sink_MortgageInterest',
                            type: 'MortgageInterest'
                        });
                    }

                    edges.push({
                        source: isPull ? ft.toDisplayName : asset.displayName,
                        target: isPull ? asset.displayName : ft.toDisplayName,
                        type: isCloseOnly ? 'ClosureTransfer'
                            : InstrumentType.isMortgage(asset.instrument) ? 'MortgagePayment'
                            : 'MonthlyTransfer',
                        weight: ft.monthlyMoveValue
                    });
                }
            }

            // 3b. Implicit mortgage edge: if no monthly fund transfer, payments come from first taxable
            if (InstrumentType.isMortgage(asset.instrument) && !hasMortgageMonthlyEdge) {
                const taxable = portfolio.modelAssets.find(
                    a => InstrumentType.isTaxableAccount(a.instrument) && !a.isClosed
                );
                if (taxable) {
                    edges.push({
                        source: taxable.displayName,
                        target: asset.displayName,
                        type: 'MortgagePayment',
                        weight: 0
                    });
                    edges.push({
                        source: taxable.displayName,
                        target: 'Sink_MortgageInterest',
                        type: 'MortgageInterest'
                    });
                }
            }
        }

        return { nodes, edges };
    }

    static lastYearMonth = 0;
    static tick = 1;

    /**
     * Attaches monthly flow amounts to the structural edges by parsing CreditMemos.
     * @param {Portfolio} portfolio 
     * @param {DateInt} currentDateInt 
     * @param {Array} edges - The edges array generated by buildGraph()
     * @returns {Array} The edges array with `.flowAmount` populated
     */
    static calculateFlows(portfolio, currentDateInt, edges) {

        if (this.lastYearMonth != currentDateInt.toInt()) {
            this.lastYearMonth = currentDateInt.toInt();
            this.tick = 1;
        }
        else
            ++this.tick;

        // 1. Reset flows ONLY if their tick cycle has completed (exactly 1 month later)
        for (const edge of edges) {
            if (edge.updateTick === this.tick) {
                edge.flowAmount = 0;
            }
        }

        // 2. Helper to find and add flow to a specific edge
        const addFlow = (sourceId, targetId, amount) => {
            const edge = edges.find(e => e.source === sourceId && e.target === targetId);
            if (!edge) return; // no structural edge for this flow (e.g., delayed capital gains)
            if (!edge.updateTick) {
                edge.updateTick = this.tick;
            }
            if (edge.updateTick == this.tick) {
                edge.flowAmount += Math.abs(amount);
            }
        };

        // 3. Scan the CreditMemos for EXACTLY this tick (matching year AND day)
        for (const asset of portfolio.modelAssets) {
            
            const currentMemos = asset.creditMemos.filter(
                memo => memo.dateInt && 
                memo.dateInt.toInt() === currentDateInt.toInt()
            );

            for (const memo of currentMemos) {
                const amount = memo.amount.amount;
                if (amount === 0) continue;

                if (memo.note === 'FICA withholding') {
                    addFlow(asset.displayName, 'Sink_FICA', amount);
                }
                else if (memo.note === 'Income tax withholding') {
                    addFlow(asset.displayName, 'Sink_IncomeTax', amount);
                }
                else if (memo.note === 'Capital gains tax withholding') {
                    addFlow(asset.displayName, 'Sink_CapGainsTax', amount);
                }
                else if (memo.note === 'Property tax' || memo.note === 'Property tax escrow') {
                    addFlow(asset.displayName, 'Sink_PropertyTax', amount);
                }
                else if (memo.note.includes('→')) {
                    if (amount < 0) {
                        const match = memo.note.match(/(.*?)\s+→\s+(.*?)\s+\(/);
            
                        if (match && match[1] && match[2]) {
                            const configSource = match[1].trim();
                            const configTarget = match[2].trim();
              
                            const sourceAsset = portfolio.modelAssets.find(a => a.displayName === configSource);
                            const isPull = sourceAsset && (
                                InstrumentType.isMonthlyExpense(sourceAsset.instrument) || 
                                InstrumentType.isMortgage(sourceAsset.instrument)
                            );
              
                            const actualSource = isPull ? configTarget : configSource;
                            const actualTarget = isPull ? configSource : configTarget;

                            addFlow(actualSource, actualTarget, amount);
                        }
                    }
                }
            }
        }

        // 4. Split mortgage flows into principal (→ Mortgage) and interest (→ Sink)
        for (const asset of portfolio.modelAssets) {
            if (!InstrumentType.isMortgage(asset.instrument)) continue;

            const principal = Math.abs(asset.mortgagePrincipalCurrency.amount);
            const interest = Math.abs(asset.mortgageInterestCurrency.amount);

            for (const edge of edges) {
                if (edge.type === 'MortgagePayment' && edge.target === asset.displayName) {
                    // Replace total payment with just the principal portion
                    edge.flowAmount = principal;
                    edge.principalDominant = true;
                }
                if (edge.type === 'MortgageInterest' && edge.target === 'Sink_MortgageInterest') {
                    // Route interest to the drain
                    edge.flowAmount = interest;
                    if (!edge.updateTick) edge.updateTick = this.tick;
                }
            }
        }

        return edges;
    }

}