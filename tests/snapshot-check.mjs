/**
 * snapshot-check.mjs
 *
 * Runs the total-state snapshot as part of the ordinary suite, so that a change
 * which moves a simulated number cannot land unnoticed just because nobody
 * thought to run the tool.
 *
 * This file is deliberately a thin wrapper around tests/tools/snapshot.mjs
 * rather than a copy of it: the tool owns the corpus, the formatting and the
 * blessing rules, and there must be exactly one of each.
 *
 * A FAILURE HERE IS NOT NECESSARILY A BUG. It means the engine now produces
 * different numbers than the committed baselines. That is either what you
 * predicted — in which case:
 *
 *     git diff tests/baselines/                review what actually moved
 *     node tests/tools/snapshot.mjs --bless    accept it into the PR
 *
 * — or it is a surprise, which is the entire point of the check.
 *
 * Usage:  node src/tests/snapshot-check.mjs   (from repo root)
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'tools', 'snapshot.mjs');

console.log('\n── Total-state snapshot ──\n');

const result = spawnSync(process.execPath, [TOOL], { encoding: 'utf8' });

if (result.error) {
  console.log('  ✗ could not run tests/tools/snapshot.mjs');
  console.log(`    ${result.error.message}`);
  process.exit(1);
}

// The tool already prints a per-fixture ok/DRIFT line and a remediation
// footer. Reprint it rather than summarising, because the first divergence it
// reports is the most useful thing on screen.
process.stdout.write(result.stdout ?? '');
if (result.stderr) process.stderr.write(result.stderr);

const drifted = result.status !== 0;

console.log(`${'─'.repeat(55)}`);
if (drifted) {
  console.log('  ✗ baselines drifted — see above');
  console.log('  0 passed, 1 failed');
} else {
  console.log('  ✓ every fixture matches its committed baseline');
  console.log('  1 passed, 0 failed');
}
console.log(`${'─'.repeat(55)}\n`);

process.exit(drifted ? 1 : 0);
