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

import { InstrumentType } from './instruments/instrument.js';
import { ModelAsset } from './model-asset.js';
import { chronometer_run } from './chronometer.js';
import { setActiveTaxTable } from './globals.js';
import { TaxTable } from './taxes.js';
import { Portfolio } from './portfolio.js';
import { ModelLifeEvent } from './life-event.js';

// Theoretical maximums for normalization (scaling to 0.0–1.0)
const THEORETICAL_MAX_CASHFLOW = 10_000_000;
const THEORETICAL_MAX_PORTFOLIO = 50_000_000;

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
        this.fitnessBalance = fitnessBalance;

        // Always run with guardrails so we capture cash flow + event data
        portfolio.guardrailsParams = this.guardrailParams;
        chronometer_run(portfolio);

        this.portfolio = portfolio;
        this.bestPortfolio = portfolio.copy();
        this.bestFitness = this.calculateFitness(portfolio);
        this.bestGuardrailParams = { ...this.guardrailParams };

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

        // Weight by slider position
        const weightCashFlow = this.fitnessBalance;
        const weightValue = 1 - this.fitnessBalance;

        let fitness = (normalizedCashFlow * weightCashFlow) +
                      (normalizedTerminal * weightValue);
        fitness -= volatilityPenalty;

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

    // ── Phase-Aware Fund Transfer Management ─────────────────────

    /**
     * For each life event phase, ensure all valid income→fundable and
     * expense→expensable transfers exist in that phase's phaseTransfers JSON.
     * Tracks cumulative closes to determine which assets are alive per phase.
     */
    ensureAllPhaseTransfers() {
        const closedSoFar = new Set();
        for (let phaseIdx = 0; phaseIdx < this.portfolio.lifeEvents.length; phaseIdx++) {
            const event = this.portfolio.lifeEvents[phaseIdx];
            const alive = this.portfolio.modelAssets.filter(a => !closedSoFar.has(a.displayName));
            this._ensurePhaseTransfersForAssets(event, alive);
            for (const name of event.closes) {
                closedSoFar.add(name);
            }
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
        for (let phaseIdx = 0; phaseIdx < this.portfolio.lifeEvents.length; phaseIdx++) {
            const event = this.portfolio.lifeEvents[phaseIdx];
            if (!event.phaseTransfers) continue;
            for (const [assetName, transfers] of Object.entries(event.phaseTransfers)) {
                for (let transferIdx = 0; transferIdx < transfers.length; transferIdx++) {
                    this.geneMap.push({ phaseIdx, assetName, transferIdx });
                }
            }
        }
    }

    // ── Genetic Algorithm ───────────────────────────────────────

    generateInitialPopulation(popSize) {
        const population = [];
        for (let i = 0; i < popSize; i++) {
            const chromosome = [
                ...this.geneMap.map(() => Math.ceil(Math.random() * 100)),
                this._randomGuardrailGene('withdrawalRate'),
                this._randomGuardrailGene('preservation'),
                this._randomGuardrailGene('prosperity'),
                this._randomGuardrailGene('adjustment'),
            ];
            population.push(chromosome);
        }
        return population;
    }

    /**
     * Write chromosome gene values into phaseTransfers JSON for all phases,
     * then apply stochastic limiting (cap total per asset at 100%).
     */
    setFundTransfersFromChromosome(chromosome) {
        for (let i = 0; i < this.geneMap.length; i++) {
            const { phaseIdx, assetName, transferIdx } = this.geneMap[i];
            const transfers = this.portfolio.lifeEvents[phaseIdx].phaseTransfers[assetName];
            transfers[transferIdx].monthlyMoveValue = chromosome[i];
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
    }

    evaluateFitness(chromosome, callback) {
        this.setFundTransfersFromChromosome(chromosome);

        // Extract guardrail params from chromosome genes
        const params = this._guardrailParamsFromChromosome(chromosome);

        // Reset simulation state for fresh run
        this.portfolio.guardrailsParams = params;
        this.portfolio.guardrailEvents = [];
        this.portfolio.yearlySnapshots = [];
        this.portfolio.generatedReports = [];

        chronometer_run(this.portfolio);

        const fitness = this.calculateFitness(this.portfolio);
        if (fitness > this.bestFitness) {
            this.bestFitness = fitness;
            this.bestPortfolio = this.portfolio.copy();
            this.bestGuardrailParams = { ...params };
            callback({
                "action": "foundBetter",
                "data": this.bestPortfolio.modelAssets,
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
            if (Math.random() >= mutationRate) return gene;

            if (idx < ftCount) {
                // Fund transfer gene: random 0–100
                return Math.random() * 100;
            } else {
                // Guardrail gene: random within range, clamped
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
                    "guardrailParams": this.bestGuardrailParams,
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
