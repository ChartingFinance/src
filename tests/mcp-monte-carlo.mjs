/**
 * mcp-monte-carlo.mjs — the MCP tools' `monteCarlo` option runs.
 *
 * It did not: runMonteCarloFor asked a config built straight from the spec for
 * the retirement date, and that date is derived from a birth year only a
 * Portfolio attaches. Every profile threw "config has no birthYear", and no
 * suite called the function, so nothing noticed.
 *
 * This calls it exactly as mcp-server.js does — runPlanCached, then
 * runMonteCarloFor on the same spec — for every built-in profile.
 */

import assert from 'node:assert/strict';
import './tools/localstorage-polyfill.js';
import { planFromProfile, listProfiles, runPlanCached, runMonteCarloFor } from '../js/mcp/run-plan.js';

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); failed++; }
}

for (const profile of listProfiles()) {
    const key = profile.key ?? profile;
    await test(`${key}: Monte Carlo runs after the plan`, async () => {
        const spec = planFromProfile(key);
        await runPlanCached(spec);
        const mc = await runMonteCarloFor(spec, { numSimulations: 20 });

        assert.ok(mc, 'a result');
        assert.ok(mc.labels.length > 0, 'month labels');
        assert.equal(mc.bandData.length, mc.bands.length, 'one series per percentile band');
        for (const band of mc.bandData) {
            assert.equal(band.length, mc.labels.length, 'a value for every month');
            assert.ok(band.every(Number.isFinite), 'every value finite');
        }
    });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
