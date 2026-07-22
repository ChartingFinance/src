/**
 * flow-pipelines.js
 *
 * Computes flow pipelines for the Flows view in Your Portfolio.
 * A pipeline groups fund transfers by source-group → target-group corridor.
 *
 * Three data sources:
 *  1. User-configured: modelAsset.fundTransfers (already reflect active phase)
 *  2. System/implicit: mortgage payments, property tax, carrying costs
 *  3. Close transfers: on-close fund transfers (shown when closeMoveValue > 0)
 *
 * Predefined pipelines always appear (even if empty/missing).
 * Dynamic pipelines auto-generated for flows outside the predefined set.
 */

import { AssetGroup, AssetGroupMeta, classifyAssetGroup } from './asset-groups.js';
import { InstrumentType } from './instruments/instrument.js';
import { FundTransfer } from './fund-transfer.js';
import { Metric } from './metric.js';

// ── Predefined pipelines ────────────────────────────────────────────

const PREDEFINED = [
    {
        key: 'income→retirement',
        sourceGroup: AssetGroup.INCOME,
        targetGroup: AssetGroup.RETIREMENT,
        label: 'Income → Retirement',
        warnIfMissing: true,
        warnOnlyDuring: 'accumulate', // only warn during accumulation phase
        warningText: 'No retirement savings configured',
    },
    {
        key: 'income→capital',
        sourceGroup: AssetGroup.INCOME,
        targetGroup: AssetGroup.CAPITAL,
        label: 'Income → Capital',
        warnIfMissing: false,
    },
    {
        key: 'capital→realestate',
        sourceGroup: AssetGroup.CAPITAL,
        targetGroup: AssetGroup.REAL_ESTATE,
        label: 'Capital → Housing',
        warnIfMissing: false,
    },
    {
        key: 'capital→expenses',
        sourceGroup: AssetGroup.CAPITAL,
        targetGroup: AssetGroup.EXPENSES,
        label: 'Capital → Expenses',
        warnIfMissing: false,
    },
    {
        key: 'retirement→capital',
        sourceGroup: AssetGroup.RETIREMENT,
        targetGroup: AssetGroup.CAPITAL,
        label: 'Retirement → Capital',
        warnIfMissing: false,
    },
];

function pipelineEmoji(sourceGroup, targetGroup) {
    const src = AssetGroupMeta.get(sourceGroup)?.groupEmoji ?? '?';
    const tgt = AssetGroupMeta.get(targetGroup)?.groupEmoji ?? '?';
    return `${src}→${tgt}`;
}

function pipelineKey(sourceGroup, targetGroup) {
    return `${sourceGroup}→${targetGroup}`;
}

// ── Metric helper ───────────────────────────────────────────────────

function atIdx(asset, metricName, idx) {
    const h = asset.getHistory?.(metricName);
    return (h && idx >= 0 && idx < h.length) ? (h[idx] ?? 0) : 0;
}

/** Check if an asset is closed/inactive at a given history index */
function isClosedAt(asset, historyIndex) {
    if (!asset) return true;
    if (asset.closedDateInt && asset.startDateInt) {
        const closedInt = asset.closedDateInt.toInt();
        const curYear = asset.startDateInt.year + Math.floor(historyIndex / 12);
        const curMonth = ((asset.startDateInt.month - 1 + historyIndex) % 12) + 1;
        const curInt = curYear * 100 + curMonth;
        return curInt >= closedInt;
    }
    return asset._isClosedAtDate ?? false;
}

// ── Build pipelines ─────────────────────────────────────────────────

/**
 * Build the pipeline data structure for the Flows view.
 *
 * @param {Portfolio} portfolio — post-simulation portfolio
 * @param {number} historyIndex — "you are here" cursor
 * @returns {Pipeline[]}
 */
export function buildPipelines(portfolio, historyIndex, isRetired = false) {
    const assets = portfolio.modelAssets;
    if (!assets || assets.length === 0) return [];

    // Map of pipelineKey → { ...pipelineDef, routes: [] }
    const pipelineMap = new Map();

    // Seed predefined pipelines
    for (const def of PREDEFINED) {
        pipelineMap.set(def.key, {
            ...def,
            emoji: pipelineEmoji(def.sourceGroup, def.targetGroup),
            routes: [],
            monthlyTotal: 0,
            active: false,
            expected: true,
            missing: false,
        });
    }

    // 1. User-configured transfers (already reflect active phase)
    // Note: Expense and mortgage fund transfers are data-modeled as expense→fundingAccount,
    // but money flows the opposite direction (fundingAccount→expense). We reverse these
    // so pipelines reflect the direction of money flow.
    // Monthly fund transfers execute during simulation for:
    // - Income assets (payroll engine)
    // - Expense assets (expense engine)
    // - Mortgage assets (expense engine)
    // - Fundable capital assets (rebalance engine — bank, taxableEquity, bond, retirement)
    // Real estate fund transfers specify funding sources for system debits, not actual transfers.
    const MONTHLY_EXECUTABLE = (inst) =>
        InstrumentType.isMonthlyIncome(inst)
        || InstrumentType.isMonthlyExpense(inst)
        || InstrumentType.isMortgage(inst)
        || (InstrumentType.isFundable(inst) && !InstrumentType.isRealEstate(inst));

    for (const asset of assets) {
        if (!asset.fundTransfers?.length) continue;

        const assetGroup = classifyAssetGroup(asset.instrument);
        const isReversed = InstrumentType.isMonthlyExpense(asset.instrument)
                        || InstrumentType.isMortgage(asset.instrument);

        for (const ft of asset.fundTransfers) {
            // Only show recurring transfers for instruments that actually execute them
            if (!ft.hasRecurring || !MONTHLY_EXECUTABLE(asset.instrument)) continue;

            ft.bind(asset, assets);
            if (!ft.toModel) continue;

            // Skip if asset lifespans don't overlap (e.g., SS starts after CompanyStock closes)
            const assetStart = asset.startDateInt?.year ?? 0;
            const assetEnd = asset.finishDateInt?.year ?? 9999;
            const targetStart = ft.toModel.startDateInt?.year ?? 0;
            const targetEnd = ft.toModel.finishDateInt?.year ?? 9999;
            if (assetStart >= targetEnd || targetStart >= assetEnd) continue;

            const ftTargetGroup = classifyAssetGroup(ft.toModel.instrument);

            // For expenses/mortgage: money flows FROM the funding account TO the expense
            const sourceGroup = isReversed ? ftTargetGroup : assetGroup;
            const targetGroup = isReversed ? assetGroup : ftTargetGroup;
            const sourceName  = isReversed ? ft.toModel.displayName : asset.displayName;
            const targetName  = isReversed ? asset.displayName : ft.toModel.displayName;
            const key = pipelineKey(sourceGroup, targetGroup);

            let monthlyAmount = 0;
            if (historyIndex >= 0) {
                if (isReversed) {
                    // For expenses/mortgage, the percentage means "what fraction of the
                    // payment comes from this funding source." The payment amount is the
                    // asset's value (expense amount) or the mortgage payment metric.
                    const payment = InstrumentType.isMortgage(asset.instrument)
                        ? Math.abs(atIdx(asset, Metric.MORTGAGE_PAYMENT, historyIndex))
                        : Math.abs(atIdx(asset, Metric.VALUE, historyIndex));
                    monthlyAmount = payment * ft.monthlyMoveValue / 100;
                } else {
                    const sourceValue = Math.abs(atIdx(asset, Metric.VALUE, historyIndex));
                    monthlyAmount = sourceValue * ft.monthlyMoveValue / 100;
                }
            }

            const route = {
                type: 'user',
                sourceName,
                targetName,
                ownerName: asset.displayName, // asset that owns the fundTransfer (for editing)
                sourceInstrument: isReversed ? ft.toModel.instrument : asset.instrument,
                targetInstrument: isReversed ? asset.instrument : ft.toModel.instrument,
                percentage: ft.monthlyMoveValue,
                monthlyAmount,
                active: !isClosedAt(asset, historyIndex) && !isClosedAt(ft.toModel, historyIndex),
            };

            ensurePipeline(pipelineMap, key, sourceGroup, targetGroup);
            pipelineMap.get(key).routes.push(route);
        }
    }

    // 2. System/implicit transfers
    addSystemTransfers(pipelineMap, assets, historyIndex);

    // 3. Finalize: compute totals, mark active/missing
    const result = [];
    for (const pipeline of pipelineMap.values()) {
        pipeline.monthlyTotal = pipeline.routes.reduce((sum, r) => sum + r.monthlyAmount, 0);
        pipeline.active = pipeline.routes.some(r => r.active && r.monthlyAmount > 0);
        const phaseMatch = !pipeline.warnOnlyDuring
            || (pipeline.warnOnlyDuring === 'accumulate' && !isRetired)
            || (pipeline.warnOnlyDuring === 'retire' && isRetired);
        pipeline.missing = pipeline.expected && pipeline.routes.length === 0 && phaseMatch;

        // Only include predefined pipelines (even if empty) and dynamic ones with routes
        if (pipeline.expected || pipeline.routes.length > 0) {
            result.push(pipeline);
        }
    }

    // Sort: predefined first (in definition order), then dynamic
    const predefinedOrder = PREDEFINED.map(p => p.key);
    result.sort((a, b) => {
        const aIdx = predefinedOrder.indexOf(a.key);
        const bIdx = predefinedOrder.indexOf(b.key);
        if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
        if (aIdx >= 0) return -1;
        if (bIdx >= 0) return 1;
        return a.key.localeCompare(b.key);
    });

    return result;
}

// ── Helpers ─────────────────────────────────────────────────────────

function ensurePipeline(map, key, sourceGroup, targetGroup) {
    if (map.has(key)) return;
    map.set(key, {
        key,
        sourceGroup,
        targetGroup,
        emoji: pipelineEmoji(sourceGroup, targetGroup),
        label: `${AssetGroupMeta.get(sourceGroup)?.label ?? sourceGroup} → ${AssetGroupMeta.get(targetGroup)?.label ?? targetGroup}`,
        routes: [],
        monthlyTotal: 0,
        active: false,
        expected: false,
        missing: false,
        warnIfMissing: false,
    });
}

function addSystemTransfers(pipelineMap, assets, historyIndex) {
    // Find funding sources (same logic used by expense-engine/tax-engine at simulation time)
    const expensable = FundTransfer.resolveExpensable(assets);
    const taxable = FundTransfer.resolveTaxable(assets);

    for (const asset of assets) {
        if (asset.isClosed) continue;

        // Mortgage payment — Capital → Housing
        if (InstrumentType.isMortgage(asset.instrument)) {
            const payment = Math.abs(atIdx(asset, Metric.MORTGAGE_PAYMENT, historyIndex));
            if (payment > 0 && taxable) {
                const sourceGroup = classifyAssetGroup(taxable.instrument);
                const targetGroup = AssetGroup.REAL_ESTATE;
                const key = pipelineKey(sourceGroup, targetGroup);

                // Skip if user already has explicit transfers covering this corridor for this asset
                if (!hasUserRouteForTarget(pipelineMap, key, asset.displayName)) {
                    ensurePipeline(pipelineMap, key, sourceGroup, targetGroup);
                    pipelineMap.get(key).routes.push({
                        type: 'system',
                        sourceName: taxable.displayName,
                        targetName: asset.displayName,
                        sourceInstrument: taxable.instrument,
                        targetInstrument: asset.instrument,
                        percentage: null,
                        monthlyAmount: payment,
                        active: true,
                    });
                }
            }
        }

        // Real estate: property tax, maintenance, insurance — Capital → Housing
        if (InstrumentType.isRealEstate(asset.instrument)) {
            const propTax = Math.abs(atIdx(asset, Metric.PROPERTY_TAX, historyIndex));
            const maint = Math.abs(atIdx(asset, Metric.MAINTENANCE, historyIndex));
            const ins = Math.abs(atIdx(asset, Metric.INSURANCE, historyIndex));
            const carryingTotal = propTax + maint + ins;

            if (carryingTotal > 0) {
                const costs = [];
                if (propTax > 0) costs.push({ amount: propTax, detail: 'Property tax' });
                if (maint > 0)   costs.push({ amount: maint,   detail: 'Maintenance' });
                if (ins > 0)     costs.push({ amount: ins,     detail: 'Insurance' });

                for (const cost of costs) {
                    const fundingSource = resolveCarryingCostSource(asset, cost.amount, assets) || expensable || taxable;
                    if (!fundingSource) continue;
                    const sourceGroup = classifyAssetGroup(fundingSource.instrument);
                    const targetGroup = AssetGroup.REAL_ESTATE;
                    const key = pipelineKey(sourceGroup, targetGroup);
                    ensurePipeline(pipelineMap, key, sourceGroup, targetGroup);
                    pipelineMap.get(key).routes.push({
                        type: 'system',
                        sourceName: fundingSource.displayName,
                        targetName: asset.displayName,
                        sourceInstrument: fundingSource.instrument,
                        targetInstrument: asset.instrument,
                        percentage: null,
                        monthlyAmount: cost.amount,
                        active: true,
                        detail: cost.detail,
                    });
                }
            }
        }
    }
}

/**
 * Mirror simulation logic: if the real estate asset has an explicit fund transfer,
 * use its target as the funding source for carrying costs / property tax.
 */
function resolveCarryingCostSource(realEstateAsset, costAmount, allAssets) {
    if (!realEstateAsset.fundTransfers?.length) return null;
    for (const ft of realEstateAsset.fundTransfers) {
        if (ft.monthlyMoveValue <= 0) continue;
        const target = allAssets.find(a => a.displayName === ft.toDisplayName && !a.isClosed);
        if (target) return target;
    }
    return null;
}

function hasUserRouteForTarget(pipelineMap, key, targetName) {
    const pipeline = pipelineMap.get(key);
    if (!pipeline) return false;
    return pipeline.routes.some(r => r.type === 'user' && r.targetName === targetName);
}

/**
 * Group pipelines by source group for horizontal column layout.
 * Returns Map<AssetGroup, Pipeline[]>
 */
export function groupPipelinesBySource(pipelines) {
    const groups = new Map();
    for (const p of pipelines) {
        if (!groups.has(p.sourceGroup)) groups.set(p.sourceGroup, []);
        groups.get(p.sourceGroup).push(p);
    }
    return groups;
}
