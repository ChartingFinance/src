// Simulator — Web Worker for genetic algorithm optimization
//
// Single unified fitness function controlled by fitnessBalance slider:
//   0 (Spending)        → maximize lifetime cash flow
//   100 (Terminal Value) → maximize ending portfolio value
//
// Guardrails are always active during simulation so withdrawal adjustments
// are reflected in both cash flow and terminal value outcomes.
//
// Chromosome layout:
//   [...fundTransferMoveValues, withdrawalRate, preservation, prosperity, adjustment]
//   Fund transfer genes: 0–100 (integer percentages)
//   Guardrail genes: real-valued within defined ranges

import { InstrumentType, ModelAsset, FundTransfer } from './index.js';
import { Frequency } from './fund-transfer.js';
import { chronometer_run } from './chronometer.js';
import { setActiveTaxTable } from './globals.js';
import { TaxTable } from './taxes.js';
import { Portfolio } from './portfolio.js';

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

        this.fundTransfers = [];
        this.generateAllFundTransfers();

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
    get _ftGeneCount() { return this.fundTransfers.length; }

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

    // ── Fund Transfer Management ────────────────────────────────

    generateAllFundTransfers() {
        for (const modelAsset of this.portfolio.modelAssets) {
            if (InstrumentType.isMonthlyIncome(modelAsset.instrument) ||
                InstrumentType.isMonthlyExpense(modelAsset.instrument))
                this.generateAssetFundTransfers(modelAsset);
        }
    }

    ensureFundTransfer(fromModel, toModel) {
        if (!fromModel.hasFundTransfer(toModel.displayName)) {
            const fundTransfer = new FundTransfer(toModel.displayName, Frequency.MONTHLY, 0.0);
            fromModel.fundTransfers.push(fundTransfer);
            this.fundTransfers.push(fundTransfer);
        }
    }

    generateAssetFundTransfers(anchorAsset) {
        if (!InstrumentType.isMonthlyIncome(anchorAsset.instrument) &&
            !InstrumentType.isMonthlyExpense(anchorAsset.instrument)) return;

        for (const modelAsset of this.portfolio.modelAssets) {
            if (anchorAsset == modelAsset) continue;

            if (InstrumentType.isMonthlyIncome(anchorAsset.instrument)) {
                if (InstrumentType.isFundable(modelAsset.instrument))
                    this.ensureFundTransfer(anchorAsset, modelAsset);
            }
            else if (InstrumentType.isMonthlyExpense(anchorAsset.instrument)) {
                if (InstrumentType.isExpensable(modelAsset.instrument))
                    this.ensureFundTransfer(anchorAsset, modelAsset);
            }
        }
    }

    // ── Genetic Algorithm ───────────────────────────────────────

    generateInitialPopulation(popSize) {
        const population = [];
        for (let i = 0; i < popSize; i++) {
            const chromosome = [
                ...this.fundTransfers.map(() => Math.ceil(Math.random() * 100)),
                this._randomGuardrailGene('withdrawalRate'),
                this._randomGuardrailGene('preservation'),
                this._randomGuardrailGene('prosperity'),
                this._randomGuardrailGene('adjustment'),
            ];
            population.push(chromosome);
        }
        return population;
    }

    setFundTransfersFromChromosome(chromosome) {
        for (let i = 0; i < this.fundTransfers.length; i++) {
            this.fundTransfers[i].monthlyMoveValue = chromosome[i];
        }
        for (const modelAsset of this.portfolio.modelAssets) {
            modelAsset.stochasticLimit(100);
        }
    }

    evaluateFitness(chromosome, callback) {
        this.setFundTransfersFromChromosome(chromosome);

        // Extract guardrail params from chromosome genes
        const params = this._guardrailParamsFromChromosome(chromosome);

        // Reset guardrail state for fresh simulation
        this.portfolio.guardrailsParams = params;
        this.portfolio.guardrailEvents = [];
        this.portfolio.yearlySnapshots = [];

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

        for (let gen = 0; gen < generations; gen++) {

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
        }

        callback({
            "action": "complete",
            "data": this.bestPortfolio.modelAssets,
            "guardrailParams": this.bestGuardrailParams,
        });

        return this.bestFitness;
    }

}
