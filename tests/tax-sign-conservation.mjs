/**
 * tax-sign-conservation.mjs
 *
 * The metric DAG and the FinancialPackage must agree on TAXES, and every tax
 * metric must obey the codebase's sign convention: negative == money out.
 *
 * The bug this guards against (present since the DAG migration of 2026-03-20,
 * commit 3ddebd1): FICA is flipped negative IN PLACE before its metric write
 * (tax-engine.recordFICAWithholding), while withheld/estimated income tax is
 * flipped only on a COPY for the FinancialPackage and the credit memo
 * (tax-engine.recordIncomeTaxWithholding), leaving the asset metric positive
 * (payroll-engine.applyNetIncome). Before the DAG the two lived in separately
 * ASSIGNED fields and never met. After it, both roll into INCOME_TAX ->
 * FEDERAL_TAXES -> TAXES, where they partially cancel: a worker withholding
 * $1,636/mo reported +$412 of tax.
 *
 * The FinancialPackage was always right; only the per-asset metric DAG was
 * wrong. That is why double-entry-income.mjs never caught it — it compares
 * INCOME and never TAXES.
 *
 * Scenario C guards a second defect of the same family, in the short-term
 * capital-gains branch of applyCapitalGainsTax: the metric write passed
 * `capitalGains` where it meant `amountToTax`, so SHORT_TERM_CAPITAL_GAIN_TAX
 * held the GAIN — positive, and several times the size of the tax — and the
 * same figure landed in both INCOME and TAXES. Unlike the sign bugs above,
 * nothing downstream compensated: a metric that never held the tax cannot be
 * recovered from. The long-term branch one line up was always correct.
 *
 * Scenarios use zero growth and zero returns so every figure is exact.
 *   Scenario W — W2 employee: FICA + withheld income tax.
 *   Scenario S — self-employed: estimated income tax (the sibling call site).
 *   Scenario C — short-term capital gain realised on close.
 *
 * Usage:  node src/tests/tax-sign-conservation.mjs   (from repo root)
 */

import assert from 'node:assert/strict';

// ── Mock browser globals ──────────────────────────────────────────────
const store = {};
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

// ── Imports ───────────────────────────────────────────────────────────
import { ModelAsset } from '../js/model-asset.js';
import { Portfolio } from '../js/portfolio.js';
import { chronometer_run } from '../js/chronometer.js';
import { TaxTable } from '../js/taxes.js';
import { setActiveTaxTable } from '../js/globals.js';
import { Metric } from '../js/metric.js';

// ── Helpers ───────────────────────────────────────────────────────────
const fmt = (n) => {
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};
let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${label}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}

const TOL = 0.01;
const histVal = (e) => {
  if (e == null) return 0;
  if (typeof e === 'number') return e;
  if (e.amount != null) return e.amount;
  const p = parseFloat(e);
  return isNaN(p) ? 0 : p;
};
const at = (asset, metric, i) => histVal(asset.getHistory(metric)?.[i]);

function buildPortfolio(selfEmployed) {
  const data = [
    {
      instrument: 'workingIncome',
      displayName: 'Salary',
      startDateInt: { year: 2026, month: 1 },
      finishDateInt: { year: 2027, month: 12 },
      startCurrency: { amount: 8000 },
      startBasisCurrency: { amount: 0 },
      annualReturnRate: { rate: 0 },
      isSelfEmployed: selfEmployed,
      fundTransfers: [{ toDisplayName: 'Savings', monthlyMoveValue: 100, closeMoveValue: 0 }],
    },
    {
      instrument: 'bank',
      displayName: 'Savings',
      startDateInt: { year: 2026, month: 1 },
      finishDateInt: { year: 2027, month: 12 },
      startCurrency: { amount: 10000 },
      startBasisCurrency: { amount: 10000 },
      annualReturnRate: { rate: 0 },
    },
  ];
  const portfolio = new Portfolio(data.map(o => ModelAsset.fromJSON(o)), true);
  return portfolio;
}

setActiveTaxTable(new TaxTable());

// ══ Scenario W — W2 employee ═════════════════════════════════════════
console.log('\n── Scenario W: W2 employee (FICA + withheld income tax) ──\n');

const pW = buildPortfolio(false);
await chronometer_run(pW);
const salaryW = pW.modelAssets.find(a => a.displayName === 'Salary');
const monthsW = pW.monthlyPackages.length;

check('W1: withheld income tax is negative (money out), every month', () => {
  const bad = [];
  for (let i = 0; i < monthsW; i++) {
    const v = at(salaryW, Metric.WITHHELD_INCOME_TAX, i);
    if (v > TOL) bad.push(`month ${i}: ${fmt(v)}`);
  }
  assert.equal(bad.length, 0,
    `${bad.length} month(s) with positive withheld income tax:\n      ` + bad.slice(0, 5).join('\n      '));
});

check('W2: FICA leaves are negative, every month', () => {
  const bad = [];
  for (let i = 0; i < monthsW; i++) {
    const ss = at(salaryW, Metric.SOCIAL_SECURITY_TAX, i);
    const mc = at(salaryW, Metric.MEDICARE_TAX, i);
    if (ss > TOL || mc > TOL) bad.push(`month ${i}: ss=${fmt(ss)} mc=${fmt(mc)}`);
  }
  assert.equal(bad.length, 0, `${bad.length} month(s) with positive FICA`);
});

check('W3: INCOME_TAX == withheld FICA + withheld income tax (DAG sums, no cancellation)', () => {
  const bad = [];
  for (let i = 0; i < monthsW; i++) {
    const fica = at(salaryW, Metric.WITHHELD_FICA_TAX, i);
    const wit  = at(salaryW, Metric.WITHHELD_INCOME_TAX, i);
    const it   = at(salaryW, Metric.INCOME_TAX, i);
    if (Math.abs(it - (fica + wit)) > TOL) {
      bad.push(`month ${i}: incomeTax ${fmt(it)} != fica ${fmt(fica)} + withheld ${fmt(wit)}`);
    }
  }
  assert.equal(bad.length, 0, `${bad.length} divergence(s):\n      ` + bad.slice(0, 5).join('\n      '));
});

check('W4: TAXES equals the magnitude actually withheld, negated', () => {
  const bad = [];
  for (let i = 0; i < monthsW; i++) {
    const withheld = Math.abs(at(salaryW, Metric.SOCIAL_SECURITY_TAX, i))
                   + Math.abs(at(salaryW, Metric.MEDICARE_TAX, i))
                   + Math.abs(at(salaryW, Metric.WITHHELD_INCOME_TAX, i));
    const taxes = at(salaryW, Metric.TAXES, i);
    if (Math.abs(taxes - -withheld) > TOL) {
      bad.push(`month ${i}: taxes ${fmt(taxes)}, actually withheld ${fmt(-withheld)}, off by ${fmt(taxes + withheld)}`);
    }
  }
  assert.equal(bad.length, 0, `${bad.length} divergence(s):\n      ` + bad.slice(0, 5).join('\n      '));
});

check('W5: DAG TAXES agrees with FinancialPackage totalTaxes(), every month', () => {
  const bad = [];
  for (let i = 0; i < monthsW; i++) {
    let dag = 0;
    for (const a of pW.modelAssets) dag += at(a, Metric.TAXES, i);
    const fp = pW.monthlyPackages[i].totalTaxes().amount;
    if (Math.abs(dag - fp) > TOL) {
      bad.push(`month ${i}: DAG ${fmt(dag)} vs FP ${fmt(fp)} — residual ${fmt(dag - fp)}`);
    }
  }
  assert.equal(bad.length, 0, `${bad.length} divergence(s):\n      ` + bad.slice(0, 5).join('\n      '));
});

check('W6: cash flow == income + taxes (the compensating reader stays correct)', () => {
  const bad = [];
  for (let i = 0; i < monthsW; i++) {
    const cf  = at(salaryW, Metric.CASH_FLOW, i);
    const inc = at(salaryW, Metric.INCOME, i);
    const tax = at(salaryW, Metric.TAXES, i);
    if (Math.abs(cf - (inc + tax)) > TOL) {
      bad.push(`month ${i}: cashFlow ${fmt(cf)} != income ${fmt(inc)} + taxes ${fmt(tax)}`);
    }
  }
  assert.equal(bad.length, 0, `${bad.length} divergence(s):\n      ` + bad.slice(0, 5).join('\n      '));
});

// ══ Scenario S — self-employed ═══════════════════════════════════════
console.log('\n── Scenario S: self-employed (estimated income tax) ──\n');

const pS = buildPortfolio(true);
await chronometer_run(pS);
const salaryS = pS.modelAssets.find(a => a.displayName === 'Salary');
const monthsS = pS.monthlyPackages.length;

check('S1: estimated income tax is negative (money out), every month', () => {
  const bad = [];
  for (let i = 0; i < monthsS; i++) {
    const v = at(salaryS, Metric.ESTIMATED_INCOME_TAX, i);
    if (v > TOL) bad.push(`month ${i}: ${fmt(v)}`);
  }
  assert.equal(bad.length, 0,
    `${bad.length} month(s) with positive estimated income tax:\n      ` + bad.slice(0, 5).join('\n      '));
});

check('S2: TAXES equals the magnitude actually withheld, negated', () => {
  const bad = [];
  for (let i = 0; i < monthsS; i++) {
    const withheld = Math.abs(at(salaryS, Metric.SOCIAL_SECURITY_TAX, i))
                   + Math.abs(at(salaryS, Metric.MEDICARE_TAX, i))
                   + Math.abs(at(salaryS, Metric.ESTIMATED_INCOME_TAX, i));
    const taxes = at(salaryS, Metric.TAXES, i);
    if (Math.abs(taxes - -withheld) > TOL) {
      bad.push(`month ${i}: taxes ${fmt(taxes)}, actually withheld ${fmt(-withheld)}`);
    }
  }
  assert.equal(bad.length, 0, `${bad.length} divergence(s):\n      ` + bad.slice(0, 5).join('\n      '));
});

check('S3: DAG TAXES agrees with FinancialPackage totalTaxes(), every month', () => {
  const bad = [];
  for (let i = 0; i < monthsS; i++) {
    let dag = 0;
    for (const a of pS.modelAssets) dag += at(a, Metric.TAXES, i);
    const fp = pS.monthlyPackages[i].totalTaxes().amount;
    if (Math.abs(dag - fp) > TOL) {
      bad.push(`month ${i}: DAG ${fmt(dag)} vs FP ${fmt(fp)} — residual ${fmt(dag - fp)}`);
    }
  }
  assert.equal(bad.length, 0, `${bad.length} divergence(s):\n      ` + bad.slice(0, 5).join('\n      '));
});

// ══ Scenario C — short-term capital gain on close ════════════════════
console.log('\n── Scenario C: short-term capital gain (held 9 months) ──\n');

// Held under 12 months, so applyCapitalGainsTax takes the short-term branch.
// $200k value against $100k basis realises a $100k gain on close.
const GAIN = 100000;
const pC = new Portfolio([
  {
    instrument: 'taxableEquity',
    displayName: 'Flip',
    startDateInt: { year: 2026, month: 1 },
    finishDateInt: { year: 2026, month: 9 },
    startCurrency: { amount: 200000 },
    startBasisCurrency: { amount: 100000 },
    annualReturnRate: { rate: 0 },
    fundTransfers: [{ toDisplayName: 'Savings', monthlyMoveValue: 0, closeMoveValue: 100 }],
  },
  {
    instrument: 'bank',
    displayName: 'Savings',
    startDateInt: { year: 2026, month: 1 },
    finishDateInt: { year: 2027, month: 12 },
    startCurrency: { amount: 1000 },
    startBasisCurrency: { amount: 1000 },
    annualReturnRate: { rate: 0 },
  },
].map(o => ModelAsset.fromJSON(o)), true);
await chronometer_run(pC);
const flip = pC.modelAssets.find(a => a.displayName === 'Flip');
const monthsC = pC.monthlyPackages.length;
const total = (asset, metric) =>
  (asset.getHistory(metric) ?? []).reduce((s, v) => s + histVal(v), 0);

check('C1: the gain is still recorded as a gain', () => {
  assert.ok(Math.abs(total(flip, Metric.SHORT_TERM_CAPITAL_GAIN) - GAIN) < TOL,
    `short-term capital gain ${fmt(total(flip, Metric.SHORT_TERM_CAPITAL_GAIN))}, expected ${fmt(GAIN)}`);
});

check('C2: the tax metric holds a tax, not the gain', () => {
  const t = total(flip, Metric.SHORT_TERM_CAPITAL_GAIN_TAX);
  assert.ok(Math.abs(t - GAIN) > TOL,
    `short-term capital gain TAX is ${fmt(t)} — that is the gain, not the tax`);
});

check('C3: the tax metric is negative (money out)', () => {
  const t = total(flip, Metric.SHORT_TERM_CAPITAL_GAIN_TAX);
  assert.ok(t < 0, `short-term capital gain tax ${fmt(t)}, expected a negative amount`);
});

check('C4: the tax metric equals what the close actually deducted', () => {
  // applyCapitalGainsTax deducts the tax from the closing balance itself
  // (finishCurrency.add(amountToTax)), so the balance drop below the pre-tax
  // value IS the tax. The metric must report that same number.
  const deducted = total(flip, Metric.SHORT_TERM_CAPITAL_GAIN_TAX);
  const memo = flip.creditMemos.find(m => m.note === 'Income tax withholding');
  assert.ok(memo, 'no income-tax-withholding credit memo on the close');
  assert.ok(Math.abs(Math.abs(memo.amount.amount) - Math.abs(deducted)) < TOL,
    `metric ${fmt(deducted)} disagrees with the close memo ${fmt(memo.amount.amount)}`);
});

check('C5: DAG TAXES agrees with FinancialPackage totalTaxes() in the close month', () => {
  // Scoped to the close month on purpose. A separate, unrelated gap breaks the
  // all-months form here: applyAnnualTaxTrueUp records the settlement on the
  // asset metric and the balance (tax-engine.js:335-342) but never on the
  // package, so any month a true-up fires diverges by the settled amount. That
  // is why scenarios W and S — steady salary, withholding exact, true-up
  // returns early under its $1 threshold — can assert every month and this one
  // cannot. Widen this to all months once the true-up is booked to the package.
  const closeMonth = 8; // Jan 2026 + 8 = Sep 2026, the finishDateInt
  let dag = 0;
  for (const a of pC.modelAssets) dag += at(a, Metric.TAXES, closeMonth);
  const fp = pC.monthlyPackages[closeMonth].totalTaxes().amount;
  assert.ok(Math.abs(dag - fp) < TOL,
    `close month: DAG ${fmt(dag)} vs FP ${fmt(fp)} — residual ${fmt(dag - fp)}`);
});

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
