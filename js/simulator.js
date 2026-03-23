// Simulator — Web Worker for genetic algorithm optimization
//
// Single unified fitness function controlled by fitnessBalance slider:
//   0 (Spending)        → maximize lifetime cash flow
//   100 (Terminal Value) → maximize ending portfolio value
//
// Guardrails are always active during simulation so withdrawal adjustments
// are reflected in both cash flow and terminal value outcomes.
//
// Chromosome layout (phase-aware):
//   [...phase0_ft_genes, ...phase1_ft_genes, ..., withdrawalRate, preservation, prosperity, adjustment]
//   Fund transfer genes: 0–100 (integer percentages), grouped by life event phase
//   Guardrail genes: real-valued within defined ranges

import { Instrument, InstrumentType, InstrumentMeta } from './instruments/instrument.js';
import { LifeEventType } from './life-event.js';
import { ModelAsset } from './model-asset.js';
import { chronometer_run } from './chronometer.js';
import { setActiveTaxTable, global_setBacktestYearDirect } from './globals.js';
import { TaxTable } from './taxes.js';
import { Portfolio } from './portfolio.js';
import { ModelLifeEvent } from './life-event.js';

// Theoretical maximums for normalization (scaling to 0.0–1.0)
const THEORETICAL_MAX_CASHFLOW = 10_000_000;
const THEORETICAL_MAX_PORTFOLIO = 50_000_000;

// Mutability levels per instrument type
// 0 = immutable (contractual obligations), 0.25 = 25% flex, 1 = fully mutable
const INSTRUMENT_MUTABILITY = {
    [Instrument.REAL_ESTATE]:       0,
    [Instrument.MORTGAGE]:          0,
    [Instrument.DEBT]:              0,
    [Instrument.MONTHLY_EXPENSE]:   0.25,
};

function getGeneMutability(instrument) {
    return INSTRUMENT_MUTABILITY[instrument] ?? 1;
}

// Guardrail gene ranges: [min, max]
const GUARDRAIL_RANGES = {
    withdrawalRate: [1, 10],     // 1% – 10%
    preservation:   [5, 50],     // 5% – 50%
    prosperity:     [5, 50],     // 5% – 50%
    adjustment:     [2, 25],     // 2% – 25%
};

self.onmessage = function(event) {

    setActiveTaxTable(new TaxTable());

    const payload = event.data;

    // Apply backtest year so chronometer uses historical returns
    if (payload.backtestYear) {
        global_setBacktestYearDirect(payload.backtestYear);
    }
    const assetModels = (Array.isArray(payload) ? payload : payload.modelAssets)
        .map(obj => ModelAsset.fromJSON(obj));

    const guardrailParams = payload.guardrailParams
        || { withdrawalRate: 4, preservation: 20, prosperity: 20, adjustment: 10 };

    // Slider 0–100: 0 = spending, 100 = terminal value
    // Convert to fitnessBalance 0–1 where 1 = max cash flow weight
    const sliderValue = payload.fitnessBalance ?? 50;
    const fitnessBalance = 1 - (sliderValue / 100);

    console.log('Simulator worker started, fitnessBalance:', fitnessBalance);

    function postCallback(msg) {
        if (msg.data && typeof msg.data !== 'string') {
            msg = { ...msg, data: JSON.parse(JSON.stringify(msg.data)) };
        }
        self.postMessage(msg);
    }

    const portfolio = new Portfolio(assetModels, false);
    if (payload.lifeEvents) {
        portfolio.lifeEvents = payload.lifeEvents.map(e => ModelLifeEvent.fromJSON(e));
    }
    const simulator = new Simulator(portfolio, guardrailParams, fitnessBalance);
    simulator.runGeneticAlgorithm(50, 200, 0.15, postCallback);

}

class Simulator {
    constructor(portfolio, guardrailParams, fitnessBalance) {

        this.guardrailParams = { ...guardrailParams };
        this._originalGuardrailParams = { ...guardrailParams };
        this.fitnessBalance = fitnessBalance;

        // Initial baseline run with history (for first chart render)
        portfolio.guardrailsParams = this.guardrailParams;
        chronometer_run(portfolio);

        this.portfolio = portfolio;
        this.bestPortfolio = portfolio.copy();
        this.bestFitness = this.calculateFitness(portfolio);
        this.bestGuardrailParams = { ...this.guardrailParams };

        // Snapshot baseline per-asset values for recommendations comparison
        this._baselineTerminalValue = portfolio.finishValue().amount;
        this._baselineAssetSnapshot = portfolio.modelAssets.map(a => ({
            name: a.displayName,
            instrument: a.instrument,
            startValue: a.startCurrency.amount,
            endValue: a.finishCurrency.amount,
            isClosed: a.isClosed,
        }));

        // Disable metric history for fitness evaluations (massive memory savings)
        this._setTrackHistory(false);

        // Snapshot original phase transfers before GA mutates them
        this._originalPhaseTransfers = portfolio.lifeEvents.map(e => ({
            displayName: e.displayName,
            phaseTransfers: structuredClone(e.phaseTransfers),
        }));

        // Build gene map across all life event phases
        this.geneMap = [];
        this.ensureAllPhaseTransfers();
        this.buildGeneMap();
    }

    /**
     * Single unified fitness function.
     */
    calculateFitness(portfolio) {
        const endingValue = portfolio.finishValue().amount;

        // Hard constraint: portfolio failed
        if (endingValue <= 0) return 0;

        // Total lifetime cash flow from yearly guardrail snapshots
        const totalCashFlow = portfolio.yearlySnapshots
            .reduce((sum, s) => sum + s.annualExpense, 0);

        // Normalize to 0–1
        const normalizedCashFlow = Math.min(totalCashFlow / THEORETICAL_MAX_CASHFLOW, 1.0);
        const normalizedTerminal = Math.min(endingValue / THEORETICAL_MAX_PORTFOLIO, 1.0);

        // Volatility penalty — preservation cuts indicate unsustainable withdrawals
        let preservationCount = 0;
        for (const evt of portfolio.guardrailEvents) {
            if (evt.type === 'preservation') preservationCount++;
        }
        const totalYears = Math.max(portfolio.yearlySnapshots.length, 1);
        const volatilityPenalty = (preservationCount / totalYears) * 0.1;

        // Penalize individual assets going negative (prevents debt concentration)
        let debtPenalty = 0;
        for (const asset of portfolio.modelAssets) {
            const val = asset.finishCurrency.amount;
            if (val < 0) debtPenalty += Math.abs(val) / THEORETICAL_MAX_PORTFOLIO;
        }

        // Weight by slider position
        const weightCashFlow = this.fitnessBalance;
        const weightValue = 1 - this.fitnessBalance;

        let fitness = (normalizedCashFlow * weightCashFlow) +
                      (normalizedTerminal * weightValue);
        fitness -= volatilityPenalty;
        fitness -= debtPenalty;

        return Math.max(0, fitness);
    }

    // ── Chromosome ↔ Guardrail Gene Helpers ─────────────────────

    /** Number of fund transfer genes (everything before the 4 guardrail genes) */
    get _ftGeneCount() { return this.geneMap.length; }

    /** Extract guardrail params from the last 4 genes of a chromosome */
    _guardrailParamsFromChromosome(chromosome) {
        const i = this._ftGeneCount;
        return {
            withdrawalRate: chromosome[i],
            preservation:   chromosome[i + 1],
            prosperity:     chromosome[i + 2],
            adjustment:     chromosome[i + 3],
        };
    }

    /** Generate a random guardrail gene value within its defined range */
    _randomGuardrailGene(key) {
        const [min, max] = GUARDRAIL_RANGES[key];
        return min + Math.random() * (max - min);
    }

    /** Clamp a guardrail gene to its valid range */
    _clampGuardrailGene(key, value) {
        const [min, max] = GUARDRAIL_RANGES[key];
        return Math.max(min, Math.min(max, value));
    }

    /** Toggle metric history tracking on all assets */
    _setTrackHistory(enabled) {
        for (const asset of this.portfolio.modelAssets) {
            asset.setTrackHistory(enabled);
        }
    }

    // ── Instructions (diff original vs optimized) ─────────────────

    _buildInstructions() {
        const bestEvents = this.bestPortfolio.lifeEvents;
        const spendingPct = Math.round(this.fitnessBalance * 100);
        const terminalPct = 100 - spendingPct;
        const fmt = (v) => '$' + Math.round(v).toLocaleString();
        const pctChange = (from, to) => from === 0
            ? (to > 0 ? '+100' : '0')
            : ((to - from) / Math.abs(from) * 100).toFixed(0);

        let md = '# Maximizer Recommendations\n\n';
        md += `*Fitness objective: ${spendingPct}% Spending / ${terminalPct}% Terminal Value*\n`;
        md += `*Constraints: Real Estate/Mortgage/Debt locked; Expenses +/-25%; Retirement contributions capped (25% accumulation, 10% retirement); all others fully optimized*\n\n`;

        // ── Headline: Baseline vs Optimized ──────────────────────────
        const bestTerminal = this.bestPortfolio.finishValue().amount;
        const baseTerminal = this._baselineTerminalValue;
        const terminalDelta = bestTerminal - baseTerminal;
        const terminalPctChg = pctChange(baseTerminal, bestTerminal);

        md += '## Bottom Line\n\n';
        md += `| | Baseline | Optimized | Change |\n`;
        md += `| :--- | ---: | ---: | ---: |\n`;
        md += `| Terminal Value | ${fmt(baseTerminal)} | ${fmt(bestTerminal)} | ${fmt(terminalDelta)} (${terminalPctChg}%) |\n\n`;

        // ── Per-Asset Comparison ─────────────────────────────────────
        const bestAssets = this.bestPortfolio.modelAssets;
        const assetComps = [];

        for (const base of this._baselineAssetSnapshot) {
            const opt = bestAssets.find(a => a.displayName === base.name);
            if (!opt) continue;
            const optEnd = opt.finishCurrency.amount;
            const delta = optEnd - base.endValue;
            const meta = InstrumentMeta.get(base.instrument);
            assetComps.push({
                name: base.name,
                emoji: meta?.assetEmoji || '',
                instrument: base.instrument,
                baseStart: base.startValue,
                baseEnd: base.endValue,
                optEnd,
                delta,
                absDelta: Math.abs(delta),
            });
        }

        // Sort by absolute impact (biggest movers first)
        assetComps.sort((a, b) => b.absDelta - a.absDelta);

        // Only show assets with meaningful divergence (> $100)
        const meaningful = assetComps.filter(a => a.absDelta > 100);

        if (meaningful.length > 0) {
            md += '## Portfolio Impact by Asset\n\n';
            md += `The optimizer found a different growth path for ${meaningful.length} asset${meaningful.length > 1 ? 's' : ''}. `;
            md += 'Assets are ranked by the magnitude of change from your baseline.\n\n';
            md += '| Asset | Baseline End | Optimized End | Impact |\n';
            md += '| :--- | ---: | ---: | ---: |\n';
            for (const a of meaningful) {
                const sign = a.delta >= 0 ? '+' : '';
                md += `| ${a.emoji} ${a.name} | ${fmt(a.baseEnd)} | ${fmt(a.optEnd)} | ${sign}${fmt(a.delta)} |\n`;
            }
            md += '\n';

            // ── Narrative callouts for top movers ────────────────────
            const callouts = this._buildDivergenceCallouts(meaningful);
            if (callouts.length > 0) {
                md += '### Key Insights\n\n';
                for (const c of callouts) {
                    md += `- ${c}\n`;
                }
                md += '\n';
            }
        }

        // ── Fund Transfer Diffs (per phase) ──────────────────────────
        let hasTransferChanges = false;

        for (let i = 0; i < this._originalPhaseTransfers.length; i++) {
            const orig = this._originalPhaseTransfers[i];
            const best = bestEvents[i];
            if (!best) continue;

            const phaseChanges = [];

            for (const [assetName, origTransfers] of Object.entries(orig.phaseTransfers)) {
                const bestTransfers = best.phaseTransfers?.[assetName] ?? [];

                for (const ot of origTransfers) {
                    const bt = bestTransfers.find(t => t.toDisplayName === ot.toDisplayName);
                    const origVal = Math.round(ot.monthlyMoveValue);
                    const bestVal = bt ? Math.round(bt.monthlyMoveValue) : 0;
                    if (origVal !== bestVal) {
                        phaseChanges.push({ assetName, to: ot.toDisplayName, from: origVal, to_val: bestVal });
                    }
                }

                for (const bt of bestTransfers) {
                    if (!origTransfers.some(t => t.toDisplayName === bt.toDisplayName)) {
                        const bestVal = Math.round(bt.monthlyMoveValue);
                        if (bestVal > 0) {
                            phaseChanges.push({ assetName, to: bt.toDisplayName, from: 0, to_val: bestVal });
                        }
                    }
                }
            }

            if (best.phaseTransfers) {
                for (const [assetName, bestTransfers] of Object.entries(best.phaseTransfers)) {
                    if (orig.phaseTransfers[assetName]) continue;
                    for (const bt of bestTransfers) {
                        const bestVal = Math.round(bt.monthlyMoveValue);
                        if (bestVal > 0) {
                            phaseChanges.push({ assetName, to: bt.toDisplayName, from: 0, to_val: bestVal });
                        }
                    }
                }
            }

            if (phaseChanges.length > 0) {
                hasTransferChanges = true;
                md += `## ${orig.displayName} Phase — Transfer Changes\n\n`;
                md += '| Asset | Transfer To | Current | Recommended |\n';
                md += '| :--- | :--- | ---: | ---: |\n';
                for (const c of phaseChanges) {
                    md += `| ${c.assetName} | ${c.to} | ${c.from}% | ${c.to_val}% |\n`;
                }
                md += '\n';
            }
        }

        // ── Guardrail param diff ─────────────────────────────────────
        const gp = this.bestGuardrailParams;
        const op = this._originalGuardrailParams;
        const grChanges = [];
        if (Math.round(op.withdrawalRate * 10) !== Math.round(gp.withdrawalRate * 10))
            grChanges.push(['Withdrawal Rate', `${op.withdrawalRate.toFixed(1)}%`, `${gp.withdrawalRate.toFixed(1)}%`]);
        if (Math.round(op.preservation) !== Math.round(gp.preservation))
            grChanges.push(['Preservation', `${Math.round(op.preservation)}%`, `${Math.round(gp.preservation)}%`]);
        if (Math.round(op.prosperity) !== Math.round(gp.prosperity))
            grChanges.push(['Prosperity', `${Math.round(op.prosperity)}%`, `${Math.round(gp.prosperity)}%`]);
        if (Math.round(op.adjustment) !== Math.round(gp.adjustment))
            grChanges.push(['Adjustment', `+/-${Math.round(op.adjustment)}%`, `+/-${Math.round(gp.adjustment)}%`]);

        if (grChanges.length > 0) {
            hasTransferChanges = true;
            md += '## Guardrail Parameters\n\n';
            md += '| Parameter | Current | Recommended |\n';
            md += '| :--- | ---: | ---: |\n';
            for (const [name, cur, rec] of grChanges) {
                md += `| ${name} | ${cur} | ${rec} |\n`;
            }
            md += '\n';
        }

        // ── Guardrail Events Summary ─────────────────────────────────
        const preservationCount = this.bestPortfolio.guardrailEvents
            .filter(e => e.type === 'preservation').length;
        const prosperityCount = this.bestPortfolio.guardrailEvents
            .filter(e => e.type === 'prosperity').length;

        if (preservationCount > 0 || prosperityCount > 0) {
            md += '## Guardrail Activity\n\n';
            md += `During the optimized simulation, guardrails triggered ${preservationCount + prosperityCount} time${preservationCount + prosperityCount > 1 ? 's' : ''}`;
            if (preservationCount > 0) {
                md += `: ${preservationCount} preservation cut${preservationCount > 1 ? 's' : ''} (spending reduced in down markets)`;
            }
            if (prosperityCount > 0) {
                md += `${preservationCount > 0 ? ', ' : ': '}${prosperityCount} prosperity raise${prosperityCount > 1 ? 's' : ''} (spending increased in up markets)`;
            }
            md += '.\n';
            if (preservationCount > 3) {
                md += `*Note: ${preservationCount} preservation cuts suggests the withdrawal rate may be aggressive. Consider lowering it for more stability.*\n`;
            }
            md += '\n';
        }

        if (!hasTransferChanges && meaningful.length === 0) {
            md += 'No significant changes recommended. Current allocations are near-optimal.\n';
        }

        md += `\n---\n*Optimized terminal value: ${fmt(bestTerminal)}*\n`;

        return md;
    }

    /**
     * Build human-readable callouts explaining WHY each top-mover diverged.
     * Cross-references transfer changes with asset value impacts.
     */
    _buildDivergenceCallouts(assetComps) {
        const callouts = [];
        const bestEvents = this.bestPortfolio.lifeEvents;
        const top = assetComps.slice(0, 5); // Focus on top 5 movers

        for (const asset of top) {
            const reasons = [];

            // Find transfer changes that flow INTO or OUT OF this asset
            for (let i = 0; i < this._originalPhaseTransfers.length; i++) {
                const orig = this._originalPhaseTransfers[i];
                const best = bestEvents[i];
                if (!best) continue;
                const phaseName = orig.displayName;

                // Transfers FROM other assets INTO this asset
                for (const [sourceName, origTransfers] of Object.entries(orig.phaseTransfers)) {
                    const bestTransfers = best.phaseTransfers?.[sourceName] ?? [];
                    for (const ot of origTransfers) {
                        if (ot.toDisplayName !== asset.name) continue;
                        const bt = bestTransfers.find(t => t.toDisplayName === ot.toDisplayName);
                        const origVal = Math.round(ot.monthlyMoveValue);
                        const bestVal = bt ? Math.round(bt.monthlyMoveValue) : 0;
                        if (origVal !== bestVal) {
                            const direction = bestVal > origVal ? 'increased' : 'decreased';
                            reasons.push(`${sourceName} contributions ${direction} from ${origVal}% to ${bestVal}% (${phaseName})`);
                        }
                    }
                }

                // Transfers FROM this asset to others
                const origOut = orig.phaseTransfers[asset.name] ?? [];
                const bestOut = best.phaseTransfers?.[asset.name] ?? [];
                for (const ot of origOut) {
                    const bt = bestOut.find(t => t.toDisplayName === ot.toDisplayName);
                    const origVal = Math.round(ot.monthlyMoveValue);
                    const bestVal = bt ? Math.round(bt.monthlyMoveValue) : 0;
                    if (origVal !== bestVal) {
                        const direction = bestVal > origVal ? 'increased' : 'decreased';
                        reasons.push(`outflows to ${ot.toDisplayName} ${direction} from ${origVal}% to ${bestVal}% (${phaseName})`);
                    }
                }
            }

            // Build the callout
            const fmt = (v) => '$' + Math.round(v).toLocaleString();
            const sign = asset.delta >= 0 ? '+' : '';
            let callout = `**${asset.emoji} ${asset.name}** (${sign}${fmt(asset.delta)}): `;

            if (reasons.length > 0) {
                callout += reasons.join('; ') + '.';
            } else if (asset.baseEnd < 0 && asset.optEnd >= 0) {
                callout += 'Eliminated negative balance. Avoiding debt prevents compounding losses that accelerate over time.';
            } else if (asset.baseEnd >= 0 && asset.optEnd < 0) {
                callout += 'Went negative under the optimized plan. Review transfers to prevent debt accumulation.';
            } else if (Math.abs(asset.delta) > 100_000) {
                callout += 'Large shift driven by compounding differences in fund transfer routing over the full simulation period.';
            } else {
                callout += 'Minor adjustment from rebalanced transfer percentages.';
            }

            // Extra warning for debt recovery
            if (asset.baseEnd < -1000 && asset.optEnd > 0) {
                callout += ' Negative balances compound against you — even small changes to prevent crossing zero can have outsized impact over decades.';
            }

            callouts.push(callout);
        }

        return callouts;
    }

    // ── Phase-Aware Fund Transfer Management ─────────────────────

    /**
     * For each life event phase, ensure all valid income→fundable and
     * expense→expensable transfers exist in that phase's phaseTransfers JSON.
     * Tracks cumulative closes to determine which assets are alive per phase.
     */
    ensureAllPhaseTransfers() {
        const events = this.portfolio.lifeEvents;
        const closedSoFar = new Set();

        // Compute approximate phase date boundaries from trigger ages
        // birthYear = portfolio start year - first phase's trigger age
        const firstEvent = events[0];
        const portfolioStartYear = this.portfolio.firstDateInt?.year ?? 2026;
        const birthYear = firstEvent ? portfolioStartYear - firstEvent.triggerAge : 1976;

        for (let phaseIdx = 0; phaseIdx < events.length; phaseIdx++) {
            const event = events[phaseIdx];
            // Phase spans from this event's trigger year to the next event's trigger year
            const phaseStartYear = birthYear + event.triggerAge;
            const nextEvent = events[phaseIdx + 1];
            const phaseEndYear = nextEvent
                ? birthYear + nextEvent.triggerAge
                : (this.portfolio.lastDateInt?.year ?? 2070);

            // Apply this phase's closes before building transfers
            for (const name of event.closes) {
                closedSoFar.add(name);
            }

            // Filter: not closed, and asset's active period overlaps this phase
            const active = this.portfolio.modelAssets.filter(a => {
                if (closedSoFar.has(a.displayName)) return false;
                const assetStart = a.startDateInt?.year ?? 0;
                const assetEnd = a.finishDateInt?.year ?? 9999;
                // Asset must start before phase ends and end after phase starts
                return assetStart < phaseEndYear && assetEnd >= phaseStartYear;
            });

            this._ensurePhaseTransfersForAssets(event, active);
        }
    }

    _ensurePhaseTransfersForAssets(event, aliveAssets) {
        if (!event.phaseTransfers) event.phaseTransfers = {};

        for (const anchor of aliveAssets) {
            if (!InstrumentType.isMonthlyIncome(anchor.instrument) &&
                !InstrumentType.isMonthlyExpense(anchor.instrument)) continue;

            if (!event.phaseTransfers[anchor.displayName]) {
                event.phaseTransfers[anchor.displayName] = [];
            }
            const existing = event.phaseTransfers[anchor.displayName];

            for (const target of aliveAssets) {
                if (anchor === target) continue;

                const shouldLink =
                    (InstrumentType.isMonthlyIncome(anchor.instrument) && InstrumentType.isFundable(target.instrument)) ||
                    (InstrumentType.isMonthlyExpense(anchor.instrument) && InstrumentType.isExpensable(target.instrument));

                if (shouldLink && !existing.some(t => t.toDisplayName === target.displayName)) {
                    existing.push({
                        toDisplayName: target.displayName,
                        frequency: 'monthly',
                        monthlyMoveValue: 0,
                        closeMoveValue: 0,
                    });
                }
            }
        }
    }

    /**
     * Build flat geneMap: each entry maps a chromosome gene index to a specific
     * monthlyMoveValue slot in a specific phase's phaseTransfers JSON.
     */
    buildGeneMap() {
        this.geneMap = [];
        // Build a name→instrument lookup from portfolio assets (also used by retirement cap)
        this._instrumentByName = new Map();
        for (const a of this.portfolio.modelAssets) {
            this._instrumentByName.set(a.displayName, a.instrument);
        }

        for (let phaseIdx = 0; phaseIdx < this.portfolio.lifeEvents.length; phaseIdx++) {
            const event = this.portfolio.lifeEvents[phaseIdx];
            if (!event.phaseTransfers) continue;
            for (const [assetName, transfers] of Object.entries(event.phaseTransfers)) {
                const instrument = this._instrumentByName.get(assetName);
                const mutability = getGeneMutability(instrument);
                for (let transferIdx = 0; transferIdx < transfers.length; transferIdx++) {
                    const originalValue = transfers[transferIdx].monthlyMoveValue;
                    this.geneMap.push({ phaseIdx, assetName, transferIdx, mutability, originalValue });
                }
            }
        }
    }

    // ── Genetic Algorithm ───────────────────────────────────────

    generateInitialPopulation(popSize) {
        const population = [];
        for (let i = 0; i < popSize; i++) {
            const chromosome = [
                ...this.geneMap.map(g => this._randomFtGene(g)),
                this._randomGuardrailGene('withdrawalRate'),
                this._randomGuardrailGene('preservation'),
                this._randomGuardrailGene('prosperity'),
                this._randomGuardrailGene('adjustment'),
            ];
            population.push(chromosome);
        }
        return population;
    }

    /** Generate a random fund transfer gene value respecting mutability */
    _randomFtGene(gene) {
        if (gene.mutability === 0) return gene.originalValue;
        if (gene.mutability < 1) {
            // Partial: vary within ±mutability of original, clamped 0–100
            const range = gene.originalValue * gene.mutability;
            const lo = Math.max(0, gene.originalValue - range);
            const hi = Math.min(100, gene.originalValue + range);
            return lo + Math.random() * (hi - lo);
        }
        return Math.random() * 100;
    }

    /** Clamp a fund transfer gene to its allowed range */
    _clampFtGene(gene, value) {
        if (gene.mutability === 0) return gene.originalValue;
        if (gene.mutability < 1) {
            const range = gene.originalValue * gene.mutability;
            return Math.max(0, Math.min(100, Math.max(gene.originalValue - range, Math.min(gene.originalValue + range, value))));
        }
        return Math.max(0, Math.min(100, value));
    }

    /**
     * Write chromosome gene values into phaseTransfers JSON for all phases,
     * then apply stochastic limiting (cap total per asset at 100%).
     */
    setFundTransfersFromChromosome(chromosome) {
        for (let i = 0; i < this.geneMap.length; i++) {
            const gene = this.geneMap[i];
            const transfers = this.portfolio.lifeEvents[gene.phaseIdx].phaseTransfers[gene.assetName];
            // Clamp to allowed range (handles crossover producing out-of-range values)
            transfers[gene.transferIdx].monthlyMoveValue = this._clampFtGene(gene, chromosome[i]);
        }

        // Stochastic limiting: cap each asset's total transfers at 100% per phase
        for (const event of this.portfolio.lifeEvents) {
            if (!event.phaseTransfers) continue;
            for (const transfers of Object.values(event.phaseTransfers)) {
                if (transfers.length <= 1) continue;
                const total = transfers.reduce((sum, t) => sum + t.monthlyMoveValue, 0);
                if (total > 100) {
                    const scale = 100 / total;
                    for (const t of transfers) {
                        t.monthlyMoveValue *= scale;
                    }
                }
            }
        }

        // Retirement account contribution cap per income asset per phase
        // Accumulate: max 25% to retirement accounts; Retire+: max 10%
        for (const event of this.portfolio.lifeEvents) {
            if (!event.phaseTransfers) continue;
            const isAccum = LifeEventType.isAccumulation(event.type);
            const retirementCap = isAccum ? 25 : 10;

            for (const [assetName, transfers] of Object.entries(event.phaseTransfers)) {
                const srcInstrument = this._instrumentByName.get(assetName);
                if (!InstrumentType.isMonthlyIncome(srcInstrument)) continue;

                const retirementTransfers = transfers.filter(t => {
                    const targetInstrument = this._instrumentByName.get(t.toDisplayName);
                    return InstrumentType.isTaxDeferred(targetInstrument) ||
                           InstrumentType.isTaxFree(targetInstrument);
                });

                const retTotal = retirementTransfers.reduce((s, t) => s + t.monthlyMoveValue, 0);
                if (retTotal > retirementCap) {
                    const scale = retirementCap / retTotal;
                    for (const t of retirementTransfers) {
                        t.monthlyMoveValue *= scale;
                    }
                }
            }
        }
    }

    evaluateFitness(chromosome, callback) {
        this.setFundTransfersFromChromosome(chromosome);

        // Extract guardrail params from chromosome genes
        const params = this._guardrailParamsFromChromosome(chromosome);

        // Reset simulation state for fresh run (history disabled for speed)
        this.portfolio.guardrailsParams = params;
        this.portfolio.guardrailEvents = [];
        this.portfolio.yearlySnapshots = [];
        this.portfolio.generatedReports = [];

        chronometer_run(this.portfolio);        
        //console.log('Current history count: ' + this.portfolio.getHistoryCount());

        const fitness = this.calculateFitness(this.portfolio);
        if (fitness > this.bestFitness) {
            this.bestFitness = fitness;
            this.bestGuardrailParams = { ...params };

            // Re-run with history enabled so the chart can render
            this._setTrackHistory(true);
            this.portfolio.guardrailEvents = [];
            this.portfolio.yearlySnapshots = [];
            this.portfolio.generatedReports = [];
            chronometer_run(this.portfolio);
            this._setTrackHistory(false);

            this.bestPortfolio = this.portfolio.copy();
            callback({
                "action": "foundBetter",
                "data": this.bestPortfolio.modelAssets,
                "lifeEvents": this.bestPortfolio.lifeEvents.map(e => e.toJSON()),
                "guardrailParams": this.bestGuardrailParams,
            });
        }
        return fitness;
    }

    selectParents(population, fitnesses, numParents) {
        return population
            .map((chrom, idx) => ({ chrom, fit: fitnesses[idx] }))
            .sort((a, b) => b.fit - a.fit)
            .slice(0, numParents)
            .map(obj => obj.chrom);
    }

    crossover(parentA, parentB) {
        const point = Math.floor(Math.random() * parentA.length);
        return [
            parentA.slice(0, point).concat(parentB.slice(point)),
            parentB.slice(0, point).concat(parentA.slice(point))
        ];
    }

    mutate(chromosome, mutationRate = 0.1) {
        const ftCount = this._ftGeneCount;
        const keys = ['withdrawalRate', 'preservation', 'prosperity', 'adjustment'];

        return chromosome.map((gene, idx) => {
            if (idx < ftCount) {
                const geneInfo = this.geneMap[idx];
                // Immutable genes never change
                if (geneInfo.mutability === 0) return geneInfo.originalValue;
                if (Math.random() >= mutationRate) return gene;
                return this._randomFtGene(geneInfo);
            } else {
                if (Math.random() >= mutationRate) return gene;
                const key = keys[idx - ftCount];
                return this._randomGuardrailGene(key);
            }
        });
    }

    runGeneticAlgorithm(popSize = 50, generations = 200, mutationRate = 0.15, callback) {
        let population = this.generateInitialPopulation(popSize);
        let bestChromosome = null;
        let gen = 0;

        const runGeneration = () => {
            if (gen >= generations) {
                callback({
                    "action": "complete",
                    "data": this.bestPortfolio.modelAssets,
                    "lifeEvents": this.bestPortfolio.lifeEvents.map(e => e.toJSON()),
                    "guardrailParams": this.bestGuardrailParams,
                    "instructions": this._buildInstructions(),
                });
                return;
            }

            // Inject diversity every 50 gens, but keep the top performers
            if (gen > 0 && gen % 50 === 0) {
                const fitnesses = population.map(chrom => this.evaluateFitness(chrom, callback));
                const elite = this.selectParents(population, fitnesses, 5);
                population = this.generateInitialPopulation(popSize - elite.length);
                population.push(...elite);
            }

            const fitnesses = population.map(chrom => this.evaluateFitness(chrom, callback));

            const genBestIdx = fitnesses.indexOf(Math.max(...fitnesses));
            bestChromosome = population[genBestIdx];

            const parents = this.selectParents(population, fitnesses, Math.floor(popSize / 2));

            let newPopulation = [bestChromosome]; // elitism
            while (newPopulation.length < popSize) {
                const [parentA, parentB] = [
                    parents[Math.floor(Math.random() * parents.length)],
                    parents[Math.floor(Math.random() * parents.length)]
                ];
                let [childA, childB] = this.crossover(parentA, parentB);
                childA = this.mutate(childA, mutationRate);
                childB = this.mutate(childB, mutationRate);
                newPopulation.push(childA, childB);
            }
            population = newPopulation.slice(0, popSize);

            callback({
                "action": "iteration",
                "data": "Generation: " + gen.toString() + '\n' + this.portfolio.dnaFundTransfers()
            });

            gen++;
            // Yield to GC every 10 generations to prevent OOM in the worker
            if (gen % 10 === 0) {
                setTimeout(runGeneration, 0);
            } else {
                runGeneration();
            }
        };

        runGeneration();
    }

}
