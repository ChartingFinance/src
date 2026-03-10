// Simulator class to run Portfolio test cases

import { InstrumentType, ModelAsset, FundTransfer } from './index.js';
import { chronometer_run } from './chronometer.js';
import { setActiveTaxTable } from './globals.js';
import { TaxTable } from './taxes.js';
import { Portfolio } from './portfolio.js';

self.onmessage = function(event) {

    setActiveTaxTable(new TaxTable());

    const payload = event.data;

    // Support both old format (array) and new format (object with mode)
    let assetModels, mode, guardrailParams, fitnessBalance;
    if (Array.isArray(payload)) {
        assetModels = payload.map(obj => ModelAsset.fromJSON(obj));
        mode = 'maximize';
        guardrailParams = null;
        fitnessBalance = 50;
    } else {
        assetModels = payload.modelAssets.map(obj => ModelAsset.fromJSON(obj));
        mode = payload.mode || 'maximize';
        guardrailParams = payload.guardrailParams || null;
        fitnessBalance = payload.fitnessBalance ?? 50;
    }

    console.log('Simulator worker started, mode:', mode, 'balance:', fitnessBalance);

    function postCallback(msg) {
        if (msg.data && typeof msg.data !== 'string') {
            msg = { ...msg, data: JSON.parse(JSON.stringify(msg.data)) };
        }
        self.postMessage(msg);
    }

    let portfolio = new Portfolio(assetModels, false);
    let simulator = new Simulator(portfolio, mode, guardrailParams, fitnessBalance);

    if (mode === 'both') {
        // Phase 1: Maximize value
        simulator.fitnessMode = 'maximize';
        simulator.runGeneticAlgorithm(50, 200, 0.15, postCallback);

        postCallback({ action: 'phaseComplete', data: 'Phase 1 complete' });

        // Phase 2: Optimize guardrails, seeded with best fund transfers from phase 1
        simulator.fitnessMode = 'guardrails';
        simulator.bestFitness = -Infinity;
        simulator.runGeneticAlgorithm(50, 200, 0.15, postCallback);
    } else {
        simulator.runGeneticAlgorithm(50, 200, 0.15, postCallback);
    }

}

class Simulator {
    constructor(portfolio, mode = 'maximize', guardrailParams = null, fitnessBalance = 50) {

        this.fitnessMode = mode === 'both' ? 'maximize' : mode;
        this.guardrailParams = guardrailParams;
        this.fitnessBalance = fitnessBalance;

        // Run initial simulation (with guardrails if applicable)
        if (this.guardrailParams && this.fitnessMode === 'guardrails') {
            portfolio.guardrailsParams = this.guardrailParams;
        }
        chronometer_run(portfolio);

        this.portfolio = portfolio;
        this._initialPortfolioValue = portfolio.startValue().amount || 1;
        this.bestPortfolio = portfolio.copy();
        this.bestFitness = this._computeFitness(portfolio);

        this.fundTransfers = [];

        this.generateAllFundTransfers();

    }

    _computeFitness(portfolio) {
        if (this.fitnessMode === 'guardrails' && this.guardrailParams) {
            return this._guardrailsFitness(portfolio);
        }
        return portfolio.finishValue().amount;
    }

    /**
     * Guardrails fitness function — normalized weighted-sum approach.
     *
     * Components (each normalized to 0–1):
     *   1. Terminal value:       endingValue / initialValue
     *   2. Cash flow stability:  1 - (withdrawalRate stdDev / targetRate)
     *   3. Event penalty:        1 - (preservationCount / totalYears)
     *
     * Hard constraint: portfolio depletion → fitness 0 (immediate culling).
     */
    _guardrailsFitness(portfolio) {
        const endingValue = portfolio.finishValue().amount;

        // Hard constraint: portfolio failed
        if (endingValue <= 0) return 0;

        const initialValue = this._initialPortfolioValue || 1;
        const targetRate = (this.guardrailParams.withdrawalRate || 4) / 100;
        const totalYears = Math.max(portfolio.yearlySnapshots.length, 1);

        // 1. Terminal value — how much portfolio grew/preserved (capped at 3x for normalization)
        const normalizedTerminal = Math.min(endingValue / initialValue, 3) / 3;

        // 2. Cash flow stability — low withdrawal rate variance is better
        let normalizedStability = 1;
        if (portfolio.yearlySnapshots.length > 1) {
            const rates = portfolio.yearlySnapshots.map(s => s.withdrawalRate);
            const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
            const variance = rates.reduce((a, r) => a + (r - mean) ** 2, 0) / rates.length;
            const stdDev = Math.sqrt(variance);
            // Normalize: stdDev of 0 = perfect (1.0), stdDev >= targetRate = worst (0.0)
            normalizedStability = Math.max(0, 1 - (stdDev / targetRate));
        }

        // 3. Event penalty — fewer preservation cuts is better
        let preservationCount = 0;
        for (const evt of portfolio.guardrailEvents) {
            if (evt.type === 'preservation') preservationCount++;
        }
        const normalizedEvents = 1 - (preservationCount / totalYears);

        // Interpolate weights based on fitnessBalance (0 = spending, 100 = terminal value)
        // At 0:   terminal 0.20, stability 0.50, events 0.30
        // At 50:  terminal 0.50, stability 0.30, events 0.20
        // At 100: terminal 0.80, stability 0.10, events 0.10
        const t = (this.fitnessBalance ?? 50) / 100;
        const weights = {
            terminal:  0.20 + t * 0.60,             // 0.20 → 0.80
            stability: 0.50 - t * 0.40,             // 0.50 → 0.10
            events:    0.30 - t * 0.20,             // 0.30 → 0.10
        };

        return (normalizedTerminal * weights.terminal) +
               (normalizedStability * weights.stability) +
               (normalizedEvents * weights.events);
    }

    generateAllFundTransfers() {

        for (let modelAsset of this.portfolio.modelAssets) {
            if (InstrumentType.isMonthlyIncome(modelAsset.instrument) || InstrumentType.isMonthlyExpense(modelAsset.instrument))
                this.generateAssetFundTransfers(modelAsset);
        }

    }

    ensureFundTransfer(fromModel, toModel) {

        if (!fromModel.hasFundTransfer(toModel.displayName)) {
            let fundTransfer = new FundTransfer(toModel.displayName, false, 0.0);
            fromModel.fundTransfers.push(fundTransfer);
            this.fundTransfers.push(fundTransfer);
        }

    }

    generateAssetFundTransfers(anchorAsset) {

        if (!InstrumentType.isMonthlyIncome(anchorAsset.instrument) && !InstrumentType.isMonthlyExpense(anchorAsset.instrument)) return;

        for (let modelAsset of this.portfolio.modelAssets) {
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

    updateFundTransfers(index, fundTransferStepping) {

        if (index >= this.portfolio.modelAssets.length)
            return false;
        else if (!this.portfolio.modelAssets[index].updateFundTransfers(fundTransferStepping))
            return this.updateFundTransfers(index + 1, fundTransferStepping);
        else
            return true;

    }

    updateFundTransferBindings() {

        for (let modelAsset of this.portfolio.modelAssets) {
            modelAsset.bindFundTransfers(this.portfolio.modelAssets);
        }

    }

    // 1. Generate initial population
    generateInitialPopulation(popSize) {
        const population = [];
        for (let i = 0; i < popSize; i++) {
            const chromosome = this.fundTransfers.map(() => Math.ceil(Math.random() * 100));
            population.push(chromosome);
        }
        return population;
    }

    // 2. Set fund transfers from chromosome
    setFundTransfersFromChromosome(chromosome) {

        for (let i = 0; i < this.fundTransfers.length; i++) {
            this.fundTransfers[i].moveValue = chromosome[i];
        }

        for (let modelAsset of this.portfolio.modelAssets) {
            modelAsset.stochasticLimit(100);
        }

    }

    // 3. Fitness function — delegates to mode-aware _computeFitness
    evaluateFitness(chromosome, callback) {
        this.setFundTransfersFromChromosome(chromosome);

        // Set guardrails params before running if in guardrails mode
        if (this.fitnessMode === 'guardrails' && this.guardrailParams) {
            this.portfolio.guardrailsParams = this.guardrailParams;
            this.portfolio.guardrailEvents = [];
            this.portfolio.yearlySnapshots = [];
        } else {
            this.portfolio.guardrailsParams = null;
        }

        chronometer_run(this.portfolio);
        const fitness = this._computeFitness(this.portfolio);
        if (fitness > this.bestFitness) {
            this.bestFitness = fitness;
            this.bestPortfolio = this.portfolio.copy();
            callback({
                "action": "foundBetter",
                "data": this.bestPortfolio.modelAssets
            });
        }
        return fitness;
    }

    // 4. Selection (e.g., top N)
    selectParents(population, fitnesses, numParents) {
        return population
            .map((chrom, idx) => ({chrom, fit: fitnesses[idx]}))
            .sort((a, b) => b.fit - a.fit)
            .slice(0, numParents)
            .map(obj => obj.chrom);
    }

    // 5. Crossover (single-point)
    crossover(parentA, parentB) {
        const point = Math.floor(Math.random() * parentA.length);
        return [
            parentA.slice(0, point).concat(parentB.slice(point)),
            parentB.slice(0, point).concat(parentA.slice(point))
        ];
    }

    // 6. Mutation
    mutate(chromosome, mutationRate = 0.1) {
        return chromosome.map(gene =>
            Math.random() < mutationRate ? Math.random() : gene
        );
    }

    // 7. Main GA loop
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

            // Evaluate fitness
            const fitnesses = population.map(chrom => this.evaluateFitness(chrom, callback));

            // Track best chromosome
            const genBestIdx = fitnesses.indexOf(Math.max(...fitnesses));
            bestChromosome = population[genBestIdx];

            // Selection
            const parents = this.selectParents(population, fitnesses, Math.floor(popSize / 2));

            // Crossover and mutation to create new population
            let newPopulation = [bestChromosome]; // elitism: always keep the best
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
            "data": this.bestPortfolio.modelAssets
        });

        return this.bestFitness;
    }

}
