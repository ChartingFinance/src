/**
 * baseline-vs-ga-analysis.mjs
 *
 * Runs the Quick Start simulation baseline, then runs the GA optimizer
 * and compares year-by-year portfolio values.
 *
 * Usage:  node src/tests/baseline-vs-ga-analysis.mjs   (from repo root)
 */

// ── Mock browser globals ──────────────────────────────────────────────
const store = {};
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;
if (typeof globalThis.self === 'undefined') {
  globalThis.self = globalThis;
}

// ── Imports ───────────────────────────────────────────────────────────
import { ModelAsset } from '../js/model-asset.js';
import { Portfolio } from '../js/portfolio.js';
import { chronometer_run } from '../js/chronometer.js';
import { TaxTable } from '../js/taxes.js';
import {
  setActiveTaxTable,
  global_setUserStartAge,
  global_setUserRetirementAge,
  global_setUserFinishAge,
  global_getUserStartAge,
  global_getUserRetirementAge,
  global_getUserFinishAge,
} from '../js/globals.js';
import { ModelLifeEvent, LifeEvent, LifeEventType } from '../js/life-event.js';
import { Instrument, InstrumentType } from '../js/instruments/instrument.js';

// ── Set global age settings ────────────────────────────────────────────
global_setUserStartAge(50);
global_setUserRetirementAge(62);
global_setUserFinishAge(87);
global_getUserStartAge();
global_getUserRetirementAge();
global_getUserFinishAge();

// ── Date anchors (matching quick-start.js logic) ───────────────────────
const currentYear = new Date().getFullYear();
const currentMonth = new Date().getMonth() + 1;
const birthYear = currentYear - 50;
const retireYear = birthYear + 62;
const finishYear = birthYear + 87;

const d = {
  now:    { year: currentYear, month: currentMonth },
  retire: { year: retireYear, month: 1 },
  finish: { year: finishYear, month: 1 },
  plus(years) { return { year: currentYear + years, month: currentMonth }; },
};

// ── Quick Start asset data ─────────────────────────────────────────────
const QUICK_START_DATA = [
  {
    instrument: 'workingIncome',
    displayName: 'Salary',
    startDateInt: d.now,
    finishDateInt: d.retire,
    startCurrency: { amount: 6500 },
    annualReturnRate: { rate: 0.025 },
  },
  {
    instrument: 'retirementIncome',
    displayName: 'Social Security',
    startDateInt: d.retire,
    startCurrency: { amount: 2500 },
    annualReturnRate: { rate: 0.025 },
  },
  {
    instrument: '401K',
    displayName: '401K',
    startDateInt: d.now,
    startCurrency: { amount: 100000 },
    annualReturnRate: { rate: 0.09 },
  },
  {
    instrument: 'rothIRA',
    displayName: 'Roth IRA',
    startDateInt: d.now,
    startCurrency: { amount: 50000 },
    annualReturnRate: { rate: 0.09 },
  },
  {
    instrument: 'taxableEquity',
    displayName: 'Brokerage',
    startDateInt: d.now,
    startCurrency: { amount: 50000 },
    startBasisCurrency: { amount: 25000 },
    annualReturnRate: { rate: 0.09 },
  },
  {
    instrument: 'realEstate',
    displayName: 'Home',
    startDateInt: d.now,
    finishDateInt: d.plus(10),
    startCurrency: { amount: 400000 },
    startBasisCurrency: { amount: 400000 },
    annualReturnRate: { rate: 0.03 },
    annualTaxRate: { rate: 0.012 },
  },
  {
    instrument: 'mortgage',
    displayName: 'Mortgage',
    startDateInt: d.now,
    finishDateInt: d.plus(10),
    startCurrency: { amount: -320000 },
    annualReturnRate: { rate: 0.065 },
    monthsRemaining: 360,
  },
  {
    instrument: 'monthlyExpense',
    displayName: 'Rent',
    startDateInt: d.plus(10),
    startCurrency: { amount: -3000 },
  },
  {
    instrument: 'monthlyExpense',
    displayName: 'Living Expenses',
    startDateInt: d.now,
    startCurrency: { amount: -3000 },
  },
];

// ── Life events (matching quick-start.js for startAge=50, retirementAge=62) ──
function buildLifeEvents() {
  const accumulate = ModelLifeEvent.createDefault(LifeEvent.ACCUMULATE, 50);
  accumulate.phaseTransfers = {
    'Salary': [
      { toDisplayName: '401K', frequency: 'monthly', monthlyMoveValue: 5, closeMoveValue: 0 },
      { toDisplayName: 'Roth IRA', frequency: 'monthly', monthlyMoveValue: 2, closeMoveValue: 0 },
      { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 93, closeMoveValue: 0 },
    ],
    'Home': [
      { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 100, closeMoveValue: 0 },
    ],
    'Mortgage': [
      { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 100, closeMoveValue: 0 },
    ],
    'Rent': [
      { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 100, closeMoveValue: 0 },
    ],
    'Living Expenses': [
      { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 100, closeMoveValue: 0 },
    ],
  };

  const retire = ModelLifeEvent.createDefault(LifeEvent.RETIRE, 62);
  retire.phaseTransfers = {
    'Social Security': [
      { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 100, closeMoveValue: 0 },
    ],
    'Rent': [
      { toDisplayName: 'Roth IRA', frequency: 'monthly', monthlyMoveValue: 30, closeMoveValue: 0 },
      { toDisplayName: '401K', frequency: 'monthly', monthlyMoveValue: 10, closeMoveValue: 0 },
      { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 60, closeMoveValue: 0 },
    ],
    'Living Expenses': [
      { toDisplayName: '401K', frequency: 'monthly', monthlyMoveValue: 40, closeMoveValue: 0 },
      { toDisplayName: 'Brokerage', frequency: 'monthly', monthlyMoveValue: 60, closeMoveValue: 0 },
    ],
  };

  return [accumulate, retire];
}

// ── Helpers ───────────────────────────────────────────────────────────
const fmt = (n) => {
  if (n == null || isNaN(n)) return '$0';
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

const fmtPct = (n) => {
  if (n == null || isNaN(n)) return '0.0%';
  const sign = n >= 0 ? '+' : '';
  return sign + (n * 100).toFixed(1) + '%';
};

function captureSnapshot(portfolio) {
  const assets = {};
  let total = 0;
  for (const a of portfolio.modelAssets) {
    if (InstrumentType.isAsset(a.instrument)) {
      assets[a.displayName] = a.finishCurrency.amount;
      total += a.finishCurrency.amount;
    }
  }
  return { total, assets };
}

async function runWithYearlyCapture(portfolio) {
  const snapshots = [];
  const origYearlyChron = portfolio.yearlyChron.bind(portfolio);

  portfolio.yearlyChron = function(currentDateInt) {
    snapshots.push({
      year: currentDateInt.year - 1,
      ...captureSnapshot(portfolio),
    });
    origYearlyChron(currentDateInt);
  };

  await chronometer_run(portfolio);

  // Capture final partial year
  snapshots.push({
    year: portfolio.lastDateInt.year,
    ...captureSnapshot(portfolio),
  });

  return snapshots;
}

// ── GA Constants (from simulator.js) ──────────────────────────────────
const THEORETICAL_MAX_CASHFLOW = 10_000_000;
const THEORETICAL_MAX_PORTFOLIO = 50_000_000;

const INSTRUMENT_MUTABILITY = {
  [Instrument.REAL_ESTATE]:     0,
  [Instrument.MORTGAGE]:        0,
  [Instrument.DEBT]:            0,
  [Instrument.MONTHLY_EXPENSE]: 0.25,
};

function getGeneMutability(instrument) {
  return INSTRUMENT_MUTABILITY[instrument] ?? 1;
}

const GUARDRAIL_RANGES = {
  withdrawalRate: [1, 10],
  preservation:   [5, 50],
  prosperity:     [5, 50],
  adjustment:     [2, 25],
};

// ── Inline Simulator (replicated from simulator.js, which does not export the class) ──

class InlineSimulator {
  constructor(portfolio, guardrailParams, fitnessBalance) {
    this.guardrailParams = { ...guardrailParams };
    this._originalGuardrailParams = { ...guardrailParams };
    this.fitnessBalance = fitnessBalance;

    portfolio.guardrailsParams = this.guardrailParams;
    chronometer_run(portfolio);

    this.portfolio = portfolio;
    this.bestPortfolio = portfolio.copy();
    this.bestFitness = this.calculateFitness(portfolio);
    this.bestGuardrailParams = { ...this.guardrailParams };

    this._setTrackHistory(false);

    this._originalPhaseTransfers = portfolio.lifeEvents.map(e => ({
      displayName: e.displayName,
      phaseTransfers: structuredClone(e.phaseTransfers),
    }));

    this.geneMap = [];
    this.ensureAllPhaseTransfers();
    this.buildGeneMap();
  }

  calculateFitness(portfolio) {
    const endingValue = portfolio.finishValue().amount;
    if (endingValue <= 0) return 0;

    const totalCashFlow = portfolio.yearlySnapshots
      .reduce((sum, s) => sum + s.annualExpense, 0);

    const normalizedCashFlow = Math.min(totalCashFlow / THEORETICAL_MAX_CASHFLOW, 1.0);
    const normalizedTerminal = Math.min(endingValue / THEORETICAL_MAX_PORTFOLIO, 1.0);

    let preservationCount = 0;
    for (const evt of portfolio.guardrailEvents) {
      if (evt.type === 'preservation') preservationCount++;
    }
    const totalYears = Math.max(portfolio.yearlySnapshots.length, 1);
    const volatilityPenalty = (preservationCount / totalYears) * 0.1;

    let debtPenalty = 0;
    for (const asset of portfolio.modelAssets) {
      const val = asset.finishCurrency.amount;
      if (val < 0) debtPenalty += Math.abs(val) / THEORETICAL_MAX_PORTFOLIO;
    }

    const weightCashFlow = this.fitnessBalance;
    const weightValue = 1 - this.fitnessBalance;

    let fitness = (normalizedCashFlow * weightCashFlow) +
                  (normalizedTerminal * weightValue);
    fitness -= volatilityPenalty;
    fitness -= debtPenalty;

    return Math.max(0, fitness);
  }

  get _ftGeneCount() { return this.geneMap.length; }

  _guardrailParamsFromChromosome(chromosome) {
    const i = this._ftGeneCount;
    return {
      withdrawalRate: chromosome[i],
      preservation:   chromosome[i + 1],
      prosperity:     chromosome[i + 2],
      adjustment:     chromosome[i + 3],
    };
  }

  _randomGuardrailGene(key) {
    const [min, max] = GUARDRAIL_RANGES[key];
    return min + Math.random() * (max - min);
  }

  _clampGuardrailGene(key, value) {
    const [min, max] = GUARDRAIL_RANGES[key];
    return Math.max(min, Math.min(max, value));
  }

  _setTrackHistory(enabled) {
    for (const asset of this.portfolio.modelAssets) {
      asset.setTrackHistory(enabled);
    }
  }

  ensureAllPhaseTransfers() {
    const events = this.portfolio.lifeEvents;
    const closedSoFar = new Set();
    const firstEvent = events[0];
    const portfolioStartYear = this.portfolio.firstDateInt?.year ?? 2026;
    const bYear = firstEvent ? portfolioStartYear - firstEvent.triggerAge : 1976;

    for (let phaseIdx = 0; phaseIdx < events.length; phaseIdx++) {
      const event = events[phaseIdx];
      const phaseStartYear = bYear + event.triggerAge;
      const nextEvent = events[phaseIdx + 1];
      const phaseEndYear = nextEvent
        ? bYear + nextEvent.triggerAge
        : (this.portfolio.lastDateInt?.year ?? 2070);

      for (const name of event.closes) {
        closedSoFar.add(name);
      }

      const active = this.portfolio.modelAssets.filter(a => {
        if (closedSoFar.has(a.displayName)) return false;
        const assetStart = a.startDateInt?.year ?? 0;
        const assetEnd = a.finishDateInt?.year ?? 9999;
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

  buildGeneMap() {
    this.geneMap = [];
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

  _randomFtGene(gene) {
    if (gene.mutability === 0) return gene.originalValue;
    if (gene.mutability < 1) {
      const range = gene.originalValue * gene.mutability;
      const lo = Math.max(0, gene.originalValue - range);
      const hi = Math.min(100, gene.originalValue + range);
      return lo + Math.random() * (hi - lo);
    }
    return Math.random() * 100;
  }

  _clampFtGene(gene, value) {
    if (gene.mutability === 0) return gene.originalValue;
    if (gene.mutability < 1) {
      const range = gene.originalValue * gene.mutability;
      return Math.max(0, Math.min(100, Math.max(gene.originalValue - range, Math.min(gene.originalValue + range, value))));
    }
    return Math.max(0, Math.min(100, value));
  }

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

  setFundTransfersFromChromosome(chromosome) {
    for (let i = 0; i < this.geneMap.length; i++) {
      const gene = this.geneMap[i];
      const transfers = this.portfolio.lifeEvents[gene.phaseIdx].phaseTransfers[gene.assetName];
      transfers[gene.transferIdx].monthlyMoveValue = this._clampFtGene(gene, chromosome[i]);
    }

    // Stochastic limiting: cap each asset's total transfers at 100%
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

  evaluateFitness(chromosome) {
    this.setFundTransfersFromChromosome(chromosome);

    const params = this._guardrailParamsFromChromosome(chromosome);
    this.portfolio.guardrailsParams = params;
    this.portfolio.guardrailEvents = [];
    this.portfolio.yearlySnapshots = [];
    this.portfolio.generatedReports = [];

    chronometer_run(this.portfolio);

    const fitness = this.calculateFitness(this.portfolio);
    if (fitness > this.bestFitness) {
      this.bestFitness = fitness;
      this.bestGuardrailParams = { ...params };

      this._setTrackHistory(true);
      this.portfolio.guardrailEvents = [];
      this.portfolio.yearlySnapshots = [];
      this.portfolio.generatedReports = [];
      chronometer_run(this.portfolio);
      this._setTrackHistory(false);

      this.bestPortfolio = this.portfolio.copy();
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
      parentB.slice(0, point).concat(parentA.slice(point)),
    ];
  }

  mutate(chromosome, mutationRate = 0.1) {
    const ftCount = this._ftGeneCount;
    const keys = ['withdrawalRate', 'preservation', 'prosperity', 'adjustment'];

    return chromosome.map((gene, idx) => {
      if (idx < ftCount) {
        const geneInfo = this.geneMap[idx];
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

  runGA(popSize, generations, mutationRate = 0.15) {
    let population = this.generateInitialPopulation(popSize);
    let bestChromosome = null;

    for (let gen = 0; gen < generations; gen++) {
      // Inject diversity every 50 gens
      if (gen > 0 && gen % 50 === 0) {
        const fitnesses = population.map(chrom => this.evaluateFitness(chrom));
        const elite = this.selectParents(population, fitnesses, 5);
        population = this.generateInitialPopulation(popSize - elite.length);
        population.push(...elite);
      }

      const fitnesses = population.map(chrom => this.evaluateFitness(chrom));
      const genBestIdx = fitnesses.indexOf(Math.max(...fitnesses));
      bestChromosome = population[genBestIdx];

      const parents = this.selectParents(population, fitnesses, Math.floor(popSize / 2));

      let newPopulation = [bestChromosome];
      while (newPopulation.length < popSize) {
        const parentA = parents[Math.floor(Math.random() * parents.length)];
        const parentB = parents[Math.floor(Math.random() * parents.length)];
        let [childA, childB] = this.crossover(parentA, parentB);
        childA = this.mutate(childA, mutationRate);
        childB = this.mutate(childB, mutationRate);
        newPopulation.push(childA, childB);
      }
      population = newPopulation.slice(0, popSize);

      if ((gen + 1) % 10 === 0) {
        process.stdout.write(`  Generation ${gen + 1}/${generations}, best fitness: ${this.bestFitness.toFixed(6)}\n`);
      }
    }

    return this.bestPortfolio;
  }
}

// ══════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Baseline vs GA Optimizer Analysis ===\n');
console.log(`Age settings: Start=50, Retirement=62, Finish=87`);
console.log(`Portfolio dates: ${d.now.year}-${d.now.month} to ${finishYear}-1\n`);

// ── 1. Run Baseline Simulation ─────────────────────────────────────────
setActiveTaxTable(new TaxTable());

const baselineAssets = QUICK_START_DATA.map(obj => ModelAsset.fromJSON(obj));
const baselinePortfolio = new Portfolio(baselineAssets, false);
baselinePortfolio.lifeEvents = buildLifeEvents();

console.log('Running baseline simulation...');
const baselineSnapshots = await runWithYearlyCapture(baselinePortfolio);
console.log(`  Baseline complete. Terminal value: ${fmt(baselinePortfolio.finishValue().amount)}`);
console.log(`  Captured ${baselineSnapshots.length} year-end snapshots.\n`);

// ── 2. Run GA Optimizer ─────────────────────────────────────────────────
// fitnessBalance=0 (slider=100) means 100% terminal value weight
const gaGuardrailParams = { withdrawalRate: 4, preservation: 20, prosperity: 20, adjustment: 10 };
const gaFitnessBalance = 0; // 1 - (slider/100) where slider=100

console.log('Running GA optimizer (pop=30, gen=100, 100% terminal value objective)...');

setActiveTaxTable(new TaxTable());

const gaAssets = QUICK_START_DATA.map(obj => ModelAsset.fromJSON(obj));
const gaPortfolio = new Portfolio(gaAssets, false);
gaPortfolio.lifeEvents = buildLifeEvents();

const simulator = new InlineSimulator(gaPortfolio, gaGuardrailParams, gaFitnessBalance);
console.log(`  Gene map size: ${simulator.geneMap.length} fund transfer genes + 4 guardrail genes`);
const bestPortfolio = simulator.runGA(30, 100, 0.15);

console.log(`\n  GA complete. Best terminal value: ${fmt(bestPortfolio.finishValue().amount)}\n`);

// ── 3. Re-run best portfolio with yearly capture ─────────────────────────
console.log('Re-running optimized portfolio for yearly snapshots...');
setActiveTaxTable(new TaxTable());

const gaFinalAssets = QUICK_START_DATA.map(obj => ModelAsset.fromJSON(obj));
const gaFinalPortfolio = new Portfolio(gaFinalAssets, false);
gaFinalPortfolio.lifeEvents = bestPortfolio.lifeEvents.map(e => e.copy());
gaFinalPortfolio.guardrailsParams = simulator.bestGuardrailParams;

const gaSnapshots = await runWithYearlyCapture(gaFinalPortfolio);
console.log(`  Captured ${gaSnapshots.length} year-end snapshots.\n`);

// ── 4. Build comparison table ───────────────────────────────────────────
const allYears = new Set([
  ...baselineSnapshots.map(s => s.year),
  ...gaSnapshots.map(s => s.year),
]);
const sortedYears = [...allYears].sort((a, b) => a - b);

const allAssetNames = new Set();
for (const s of [...baselineSnapshots, ...gaSnapshots]) {
  for (const name of Object.keys(s.assets)) {
    allAssetNames.add(name);
  }
}
const assetNames = [...allAssetNames].sort();

// ── Print year-by-year comparison ──────────────────────────────────────
const COL = { year: 6, value: 14, delta: 14, pct: 9, contributor: 40 };
const sep = '-'.repeat(COL.year + COL.value * 2 + COL.delta + COL.pct + COL.contributor + 10);

console.log('=== Year-by-Year Comparison: Baseline vs GA Optimized ===\n');
console.log(
  'Year'.padEnd(COL.year) + ' | ' +
  'Baseline'.padStart(COL.value) + ' | ' +
  'GA Optimized'.padStart(COL.value) + ' | ' +
  'Delta'.padStart(COL.delta) + ' | ' +
  'Pct'.padStart(COL.pct) + ' | ' +
  'Top Diverging Assets'
);
console.log(sep);

for (const year of sortedYears) {
  const bSnap = baselineSnapshots.find(s => s.year === year);
  const gSnap = gaSnapshots.find(s => s.year === year);

  const bTotal = bSnap?.total ?? 0;
  const gTotal = gSnap?.total ?? 0;
  const delta = gTotal - bTotal;
  const pctChange = bTotal !== 0 ? delta / Math.abs(bTotal) : 0;

  // Find which assets contribute most to the divergence
  const assetDeltas = [];
  for (const name of assetNames) {
    const bVal = bSnap?.assets?.[name] ?? 0;
    const gVal = gSnap?.assets?.[name] ?? 0;
    const aDelta = gVal - bVal;
    if (Math.abs(aDelta) > 1) {
      assetDeltas.push({ name, delta: aDelta });
    }
  }
  assetDeltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const topContributors = assetDeltas.slice(0, 2)
    .map(a => `${a.name}(${a.delta >= 0 ? '+' : ''}${fmt(a.delta)})`)
    .join(', ');

  console.log(
    String(year).padEnd(COL.year) + ' | ' +
    fmt(bTotal).padStart(COL.value) + ' | ' +
    fmt(gTotal).padStart(COL.value) + ' | ' +
    fmt(delta).padStart(COL.delta) + ' | ' +
    fmtPct(pctChange).padStart(COL.pct) + ' | ' +
    topContributors
  );
}

console.log(sep);

// ── Summary ──────────────────────────────────────────────────────────────
const bFinal = baselineSnapshots[baselineSnapshots.length - 1];
const gFinal = gaSnapshots[gaSnapshots.length - 1];
const finalDelta = (gFinal?.total ?? 0) - (bFinal?.total ?? 0);
const finalPct = bFinal?.total ? finalDelta / Math.abs(bFinal.total) : 0;

console.log(`\n=== Summary ===`);
console.log(`  Baseline terminal value:  ${fmt(bFinal?.total ?? 0)}`);
console.log(`  GA optimized terminal:    ${fmt(gFinal?.total ?? 0)}`);
console.log(`  Improvement:              ${fmt(finalDelta)} (${fmtPct(finalPct)})`);
console.log(`  Best guardrail params:    WR=${simulator.bestGuardrailParams.withdrawalRate.toFixed(1)}%, ` +
  `Pres=${simulator.bestGuardrailParams.preservation.toFixed(0)}%, ` +
  `Prosp=${simulator.bestGuardrailParams.prosperity.toFixed(0)}%, ` +
  `Adj=${simulator.bestGuardrailParams.adjustment.toFixed(0)}%`);

// ── Per-asset final comparison ────────────────────────────────────────
console.log(`\n=== Per-Asset Final Values ===\n`);
console.log(
  'Asset'.padEnd(20) + ' | ' +
  'Baseline'.padStart(14) + ' | ' +
  'GA Optimized'.padStart(14) + ' | ' +
  'Delta'.padStart(14)
);
console.log('-'.repeat(70));

for (const name of assetNames) {
  const bVal = bFinal?.assets?.[name] ?? 0;
  const gVal = gFinal?.assets?.[name] ?? 0;
  const aDelta = gVal - bVal;
  console.log(
    name.padEnd(20) + ' | ' +
    fmt(bVal).padStart(14) + ' | ' +
    fmt(gVal).padStart(14) + ' | ' +
    fmt(aDelta).padStart(14)
  );
}

console.log('-'.repeat(70));
console.log('\nDone.');