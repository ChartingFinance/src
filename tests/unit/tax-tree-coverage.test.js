/**
 * tax-tree-coverage.test.js — every tax the engine can charge must have a row.
 *
 * WHY THIS EXISTS
 *
 * `TAX_TREE` in js/components/asset-list.js is the household's tax breakdown —
 * the "Taxes" column under Your Portfolio. It is a HARDCODED list, unlike the
 * asset View modal, which builds itself from `MetricRollups` and therefore picks
 * up a new tax metric on its own.
 *
 * That difference cost a release. NIIT shipped in #37, its reporting was fixed
 * in #38, and the tax breakdown a user actually reads STILL did not mention it,
 * because nothing connects a new tax metric to this list. The engine collected
 * the tax, the report view showed it, the asset modal showed it, and this
 * screen — the one the user was looking at — did not. It was found by reading
 * the screen, which is not a test strategy.
 *
 * So: derive the set of taxes from the rollup DAG (the engine's own definition
 * of what a tax is) and assert the hardcoded list covers it. A new leaf metric
 * that reaches Metric.TAXES now fails here instead of being silently absent
 * from the UI.
 *
 * The reverse direction matters too — a row whose metric no longer exists would
 * render a permanent $0.00 line nobody can explain.
 */

import { describe, it, expect } from 'vitest';

function mockLocalStorage() {
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}
mockLocalStorage();
globalThis.window = globalThis;

const { Metric, MetricRollups } = await import('../../js/metric.js');
const { TAX_TREE } = await import('../../js/components/asset-list.js');

/** Does `m` roll up into `target` along the DAG? */
function reaches(m, target, seen = new Set()) {
  if (m === target) return true;
  if (seen.has(m)) return false;
  seen.add(m);
  return (MetricRollups[m] ?? []).some((p) => reaches(p, target, seen));
}

/**
 * The engine's own definition of "a tax the household pays": a metric that
 * reaches TAXES and has nothing rolling into it. Aggregates like INCOME_TAX and
 * FEDERAL_TAXES are excluded — they are sums of these, and TAX_TREE shows them
 * as parent rows built from their children's metrics.
 */
const hasChildren = new Set(Object.values(MetricRollups).flat());
const LEAF_TAX_METRICS = Object.values(Metric)
  .filter((m) => m !== Metric.TAXES && reaches(m, Metric.TAXES) && !hasChildren.has(m));

/** Every metric named anywhere in the tree, at any depth. */
function treeMetrics(nodes, acc = new Set()) {
  for (const n of nodes) {
    for (const m of (n.amountMetrics ?? [])) acc.add(m);
    if (n.children) treeMetrics(n.children, acc);
  }
  return acc;
}
const COVERED = treeMetrics(TAX_TREE);

describe('TAX_TREE covers every tax the engine charges', () => {
  it('found some leaf tax metrics to check', () => {
    // Guard against the DAG walk silently returning nothing, which would make
    // every assertion below vacuously true.
    expect(LEAF_TAX_METRICS.length).toBeGreaterThan(5);
  });

  it.each(LEAF_TAX_METRICS)('%s has a row', (metric) => {
    expect(
      COVERED.has(metric),
      `Metric "${metric}" rolls up into TAXES but appears in no TAX_TREE node. `
      + 'The engine can charge it and the Taxes breakdown under Your Portfolio '
      + 'will never show it. TAX_TREE in js/components/asset-list.js is hardcoded '
      + '— add a node (or a child of an existing one) with this metric in its '
      + 'amountMetrics.',
    ).toBe(true);
  });

  it('names no metric that does not exist', () => {
    const known = new Set(Object.values(Metric));
    const unknown = [...COVERED].filter((m) => !known.has(m));
    expect(
      unknown,
      `TAX_TREE references metric(s) that are not in Metric: ${unknown.join(', ')}. `
      + 'Those rows can only ever render $0.00.',
    ).toEqual([]);
  });

  it('marks NIIT as annual-cadence so it is not extrapolated from one month', () => {
    // The Taxes column reads ONE month and multiplies by 12. NIIT is booked
    // once a year by applyAnnualNIIT, so without this flag the row is pruned in
    // the eleven months the metric is zero and reports 12x the real charge in
    // the twelfth. Measured on Early Career: $38,662 of NIIT lands in 16 single
    // months of a 665-month plan — invisible 97% of the time, wrong the rest.
    const niitNode = TAX_TREE.find((n) => (n.amountMetrics ?? []).includes(Metric.NIIT));
    expect(niitNode?.annualCadence).toBe(true);
  });

  it('does not mark the monthly flows as annual-cadence', () => {
    // Withholding and FICA accrue every month and annualise correctly by
    // multiplication. Flagging them would change figures that are already right.
    const monthly = [Metric.WITHHELD_INCOME_TAX, Metric.SOCIAL_SECURITY_TAX, Metric.MEDICARE_TAX];
    const walk = (nodes) => nodes.flatMap((n) => [n, ...walk(n.children ?? [])]);
    for (const node of walk(TAX_TREE)) {
      if ((node.amountMetrics ?? []).some((m) => monthly.includes(m))) {
        expect(node.annualCadence, `${node.id} is a monthly flow`).toBeFalsy();
      }
    }
  });

  it('gives NIIT a row of its own, not a child of income or capital gains', () => {
    // §1411 is a separate levy on a separate base — Metric.NIIT rolls straight
    // to FEDERAL_TAXES, never through INCOME_TAX. Nesting it under either would
    // contradict the DAG and double-count that parent's total.
    const top = TAX_TREE.find((n) => (n.amountMetrics ?? []).includes(Metric.NIIT));
    expect(top, 'NIIT must be a top-level TAX_TREE node').toBeTruthy();

    const nestedUnder = TAX_TREE.filter((n) =>
      (n.children ?? []).some((c) => (c.amountMetrics ?? []).includes(Metric.NIIT)));
    expect(nestedUnder.map((n) => n.id)).toEqual([]);
  });
});
