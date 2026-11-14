// routing-experiment.mjs: spec 15 §8.7, how rugged is the routing search?
//
// Runs the routing search's parts on the eight quick-start profiles, five
// seeds each, with the clock pinned, and writes one JSON line per result:
// the climb from the plan, the genetic search from the plan and from random
// routings (each followed by a climb and a prune), and, with the arms
// `polish-random,polish-near`, climbs from other starting points.
//
// Not a test: it takes about an hour on 18 cores.
//
// Usage: node tests/tools/routing-experiment.mjs <repo src> <out.jsonl> [workers] [profiles] [arms]
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = isMainThread ? process.argv[2] : workerData.root;
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const RealDate = Date;
const ISO = '2026-11-15T12:00:00Z';
globalThis.Date = class extends RealDate {
    constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(ISO); }
    static now() { return new RealDate(ISO).getTime(); }
};
const out = console.log.bind(console);
console.log = () => {};
await imp('tests/tools/localstorage-polyfill.js');
const { planFromProfile, simConfigFromPlanSpec, listProfiles } = await imp('js/mcp/run-plan.js');
const { solveSpending } = await imp('js/spending-solver.js');
const R = await imp('js/routing-search.js');

const planOf = (key) => {
    const spec = planFromProfile(key);
    return { modelAssets: spec.modelAssets, lifeEvents: spec.lifeEvents ?? [], config: simConfigFromPlanSpec(spec) };
};

function worth(plan, map, values) {
    const routed = { ...plan, lifeEvents: R.applyRouting(plan, map, values) };
    const solved = solveSpending(routed);
    return {
        spendable: solved.best?.monthlySpending ?? 0,
        factor: solved.best?.factor ?? 0,
        endEntered: solved.asEntered.endingReal,
        endBest: solved.best?.endingReal ?? 0,
        boundBy: solved.boundBy.kind,
    };
}

if (!isMainThread) {
    parentPort.on('message', (job) => {
        const t0 = RealDate.now();
        const plan = planOf(job.profile);
        const map = R.routingGenes(plan);
        const ranker = R.makeRanker(plan, map);
        const changed = (values) => values.filter((v, i) => v !== ranker.entered[i]).length;
        const record = (label, values) => ({
            ...job, arm: label, runs: ranker.runs, ms: RealDate.now() - t0,
            edge: ranker.edge, enteredLevel: ranker.enteredLevel,
            changed: changed(values), values, ...worth(plan, map, values),
        });
        const results = [];
        if (job.arm === 'entered') {
            results.push(record('entered', ranker.entered));
        } else if (job.arm === 'polish') {
            R.climb(map, ranker);
            results.push(record('polish', ranker.values));
            results.push(record('polish+prune', R.prune(map, ranker)));
        } else if (job.arm === 'polish-random' || job.arm === 'polish-near') {
            // A restart: polish from somewhere else. Random, or the plan with every
            // percentage moved by up to 30 points.
            const random = R.seededRandom(job.seed);
            ranker.startFrom(job.arm === 'polish-random'
                ? map.genes.map(() => random() * 100)
                : ranker.entered.map((v) => v + (random() * 2 - 1) * 30));
            const startLevel = ranker.edge;
            R.climb(map, ranker);
            results.push({ ...record(job.arm, ranker.values), startLevel });
            results.push(record(job.arm + '+prune', R.prune(map, ranker)));
        } else {
            const gains = [];
            let last = ranker.edge;
            const generations = R.geneticSearch(map, ranker, {
                seed: job.seed, start: job.arm.startsWith('ga-random') ? 'random' : 'plan',
                onGeneration: (g, rk) => { if (rk.edge !== last) { last = rk.edge; gains.push([g, rk.edge, rk.runs]); } },
            });
            results.push({ ...record(job.arm, ranker.values), generations, gains });
            R.climb(map, ranker);
            results.push(record(job.arm + '+polish', ranker.values));
            results.push(record(job.arm + '+polish+prune', R.prune(map, ranker)));
        }
        parentPort.postMessage(results);
    });
} else {
    const outFile = process.argv[3];
    const workers = Number(process.argv[4] ?? 16);
    const only = process.argv[5] ? process.argv[5].split(',') : null;
    const arms = process.argv[6] ? process.argv[6].split(',') : ['ga-plan', 'ga-random'];
    fs.writeFileSync(outFile, '');
    const jobs = [];
    for (const { key } of listProfiles()) {
        if (only && !only.includes(key)) continue;
        jobs.push({ profile: key, arm: 'entered', seed: 0 });
        if (!arms.some((a) => a.startsWith('polish-'))) jobs.push({ profile: key, arm: 'polish', seed: 0 });
        for (let seed = 1; seed <= 5; seed++) for (const arm of arms) jobs.push({ profile: key, arm, seed });
    }
    const order = { entered: 0, polish: 1, 'ga-plan-stall30': 2, 'ga-plan': 3, 'ga-random': 4 };
    jobs.sort((a, b) => (order[a.arm] ?? 1) - (order[b.arm] ?? 1));
    let done = 0;
    const total = jobs.length;
    await new Promise((resolve) => {
        let live = 0;
        for (let w = 0; w < Math.min(workers, total); w++) {
            const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { root } });
            live++;
            const next = () => {
                const job = jobs.shift();
                if (!job) { worker.terminate(); if (--live === 0) resolve(); return; }
                worker.postMessage(job);
            };
            worker.on('message', (results) => {
                for (const r of results) fs.appendFileSync(outFile, JSON.stringify(r) + '\n');
                done++;
                out(`[${done}/${total}] ${results[0].profile} ${results[0].arm} seed ${results[0].seed}: ${results.map((r) => `${r.arm} $${Math.round(r.spendable)}/mo x${r.factor.toFixed(3)} chg ${r.changed} runs ${r.runs}`).join(' | ')}`);
                next();
            });
            worker.on('error', (err) => { out('WORKER ERROR ' + err.stack); next(); });
            next();
        }
    });
    out('EXPERIMENT DONE');
}
