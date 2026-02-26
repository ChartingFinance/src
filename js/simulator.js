// Simulator class to run Portfolio test cases

import { InstrumentType, ModelAsset, FundTransfer } from './index.js';
import { chronometer_run } from './chronometer.js';
import { setActiveTaxTable } from './globals.js';
import { logger, LogCategory } from './logger.js';
import { TaxTable } from './taxes.js';
import { Portfolio } from './portfolio.js';

self.onmessage = function(event) {

    //global_initialize();
    setActiveTaxTable(new TaxTable());

    console.log('Received message from main thread:', event.data);
    let assetModels = event.data.map(obj => ModelAsset.fromJSON(obj));
    let portfolio = new Portfolio(assetModels, false);
    let simulator = new Simulator(portfolio);

    /*
    simulator.runTestCases(10, function(assetModels) {
        console.log('Simulation Update');
        self.postMessage(assetModels);
    });
    */

    // Run the genetic algorithm
    simulator.runGeneticAlgorithm(100, 600, 0.1, function(assetModels) {
        self.postMessage(assetModels);
    });

}

class Simulator {
    constructor(portfolio) {

        chronometer_run(portfolio);

        this.portfolio = portfolio; // Portfolio object to simulate
        this.bestPortfolio = portfolio.copy(); // Best observed portfolio

        this.fundTransfers = [];
        this.bestFundTransfers = null;;

        this.generateAllFundTransfers(); // Generate fund transfers for all model assets

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

        // first version -- only do income and expense assets
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
            return false; // No more fund transfers to update
        else if (!this.portfolio.modelAssets[index].updateFundTransfers(fundTransferStepping))
            return this.updateFundTransfers(index + 1, fundTransferStepping);
        else
            return true;

    }

    // Method to run a single test case
    runTestCase(iteration, callback) {

        let richMessage = {
            "action": "iteration",
            "data": "Iteration: " + iteration.toString() + '\n' + this.portfolio.dnaFundTransfers()
        }
        callback(richMessage);
        chronometer_run(this.portfolio);

    }

    // Method to run multiple test cases
    runTestCases(fundTransferStepping, callback) {

        logger.log(LogCategory.GENERAL, 'Replicating current assets...');
        chronometer_run(this.portfolio);
        callback(this.portfolio.modelAssets);
        this.bestPortfolio = this.portfolio.copy(); // Copy the current portfolio as the best portfolio

        this.portfolio.zeroFundTransfersMoveValues();

        /*

        if (this.fundTransfers?.length > 0) {

            this.portfolio.zeroFundTransfersMoveValues();

            let iteration = 0;

            do {

                this.runTestCase(++iteration, callback);
                this.evaluateResults(callback);

            }
            while (this.updateFundTransfers(0, fundTransferStepping));

        }
        */
    }

    evaluateResults(callback) {

        if (this.bestPortfolio == null || this.portfolio.finishValue() > this.bestPortfolio.finishValue()) {
            this.bestPortfolio = this.portfolio.copy();
            let richMessage = {
                "action": "foundBetter",
                "data": this.portfolio.modelAssets
            }
            callback(richMessage);
        }


    }

    updateFundTransferBindings() {

        // do this because when we use the modelAssets to html transform, it removes the toModel and fromModel references
        for (let modelAsset of this.portfolio.modelAssets) {
            modelAsset.bindFundTransfers(this.portfolio.modelAssets);
        }

    }

    // 1. Generate initial population
    generateInitialPopulation(popSize) {
        const population = [];
        for (let i = 0; i < popSize; i++) {
            const chromosome = this.fundTransfers.map(() => Math.ceil(Math.random() * 100)); // random moveValue [0,100]
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

    // 3. Fitness function
    evaluateFitness(chromosome, callback) {
        this.setFundTransfersFromChromosome(chromosome);
        chronometer_run(this.portfolio);
        if (this.portfolio.finishValue().amount > this.bestPortfolio.finishValue().amount) {
            this.bestPortfolio = this.portfolio.copy();
            let richMessage = {
                "action": "foundBetter",
                "data": this.bestPortfolio.modelAssets
            }
            callback(richMessage);
        }
        return this.portfolio.finishValue().amount; // or whatever metric you want
    }

    // 4. Selection (e.g., top N)
    selectParents(population, fitnesses, numParents) {
        // Pair chromosomes with fitness, sort, and select top
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
    runGeneticAlgorithm(popSize = 100, generations = 600, mutationRate = 0.1, callback) {
        let population = this.generateInitialPopulation(popSize);

        for (let gen = 0; gen < generations; gen++) {

            if (gen % 30 == 0) {
                // try a new population every 30 generations
                population = this.generateInitialPopulation(popSize);
            }

            // Evaluate fitness
            const fitnesses = population.map(chrom => this.evaluateFitness(chrom, callback));

            // Selection
            const parents = this.selectParents(population, fitnesses, Math.floor(popSize / 2));

            // Crossover and mutation to create new population
            let newPopulation = [];
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

        // Final evaluation
        const fitnesses = population.map(chrom => this.evaluateFitness(chrom, callback));
        const bestIdx = fitnesses.indexOf(Math.max(...fitnesses));
        this.setFundTransfersFromChromosome(population[bestIdx]);

        callback({
            "action": "complete",
            "data": this.bestPortfolio.modelAssets
        });

        return this.portfolio.finishValue();
    }

}
