import { InstrumentType } from './instrument.js';

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
            { id: 'Sink_PropertyTax', label: 'Property Tax', category: 'TaxDrain' }
        ];
        nodes.push(...sinks);

        // 2. Iterate Model Assets to build Nodes and Implicit Edges
        for (const asset of portfolio.modelAssets) {
            
            // Determine the visual category based on InstrumentType
            let category = 'Unknown';
            if (InstrumentType.isMonthlyIncome(asset.instrument)) {
                category = 'IncomeLake';
                
                // Implicit Edge: Income generates FICA and Income Tax withholding
                if (!InstrumentType.isSocialSecurity(asset.instrument)) {
                    edges.push({ source: asset.displayName, target: 'Sink_FICA', type: 'Tax' });
                }
                edges.push({ source: asset.displayName, target: 'Sink_IncomeTax', type: 'Tax' });

            } else if (InstrumentType.isMonthlyExpense(asset.instrument)) {
                category = 'ExpenseDrain';
            } else if (InstrumentType.isMortgage(asset.instrument)) {
                category = 'DebtDrain';
            } else if (InstrumentType.isHome(asset.instrument)) {
                category = 'IlliquidAsset';
                // Implicit Edge: Homes generate Property Tax
                edges.push({ source: asset.displayName, target: 'Sink_PropertyTax', type: 'Tax' });
            } else if (InstrumentType.isExpensable(asset.instrument)) {
                category = 'CheckingHub';
            } else if (InstrumentType.isTaxDeferred(asset.instrument)) { // 401K, IRA
                category = 'TaxDeferredReservoir';
                // Implicit Edge: Distributions trigger ordinary income tax
                edges.push({ source: asset.displayName, target: 'Sink_IncomeTax', type: 'Tax' });
            } else if (InstrumentType.isTaxFree(asset.instrument)) { // Roth
                category = 'TaxFreeReservoir';
            } else if (InstrumentType.isTaxableAccount(asset.instrument) || InstrumentType.isCapital(asset.instrument)) {
                category = 'TaxableReservoir';
                // Implicit Edge: Selling triggers capital gains tax
                edges.push({ source: asset.displayName, target: 'Sink_CapGainsTax', type: 'Tax' });
            }

            // Add the Asset Node
            nodes.push({
                id: asset.displayName,
                label: asset.displayName,
                category: category
            });

            // 3. Extract Explicit Edges (Fund Transfers)
            if (asset.fundTransfers && asset.fundTransfers.length > 0) {
                for (const ft of asset.fundTransfers) {
                    edges.push({
                        source: asset.displayName,
                        target: ft.toDisplayName,
                        type: ft.moveOnFinishDate ? 'ClosureTransfer' : 'MonthlyTransfer',
                        weight: ft.moveValue // The percentage or amount
                    });
                }
            }
        }

        return { nodes, edges };
    }
}