/**
 * dividend-basis.mjs — reinvested dividends must create new basis in taxable
 * accounts. They are taxed as dividend income in the year received; if they
 * don't raise basis, the same dollars are taxed AGAIN as capital gain on
 * sale (double taxation). Tax-advantaged accounts are unaffected.
 *
 * Run: node src/tests/dividend-basis.mjs
 */
import assert from 'node:assert/strict';

const store = {};
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

import { ModelAsset } from '../js/model-asset.js';
import { Portfolio } from '../js/portfolio.js';
import { TaxTable } from '../js/taxes.js';
import { setActiveTaxTable } from '../js/globals.js';
import { chronometer_run } from '../js/chronometer.js';

let passed = 0;
function ok(cond, label) {
    assert.ok(cond, label);
    passed++;
    console.log(`  PASS  ${label}`);
}

// ── Unit: one month of dividends on a taxable asset ──────────────

const makeAsset = (instrument) => ModelAsset.fromJSON({
    instrument, displayName: instrument,
    startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 12 },
    startCurrency: { amount: 120000 }, startBasisCurrency: { amount: 60000 },
    annualReturnRate: { rate: 0.0 }, annualDividendRate: { rate: 0.02 },
});

setActiveTaxTable(new TaxTable());

{
    const a = makeAsset('taxableEquity');
    a.initializeChron();
    a.finishCurrency.amount = 120000;   // mid-simulation live value
    const result = a.applyMonthly();
    const div = result.qualifiedDividend.amount + result.nonQualifiedDividend.amount;
    ok(div > 0, `taxable: dividend paid ($${div.toFixed(2)})`);
    ok(Math.abs(a.finishBasisCurrency.amount - (60000 + div)) < 0.01,
        `taxable: basis grew by the dividend (${a.finishBasisCurrency.toFixed()})`);
}

{
    const a = makeAsset('rothIRA');
    a.initializeChron();
    a.finishCurrency.amount = 120000;   // mid-simulation live value
    const before = a.finishBasisCurrency.amount;
    a.applyMonthly();
    ok(a.finishBasisCurrency.amount === before,
        'tax-advantaged (Roth IRA): basis unchanged by dividends');
}

// ── Integration: gain ratio must FALL over a dividend year ───────
// Zero growth, 2% dividend, monthly withdrawals. Pro-rata withdrawals
// preserve the gain ratio; dividends add equal $ to value and basis, which
// lowers it. Pre-fix (no basis credit) the ratio ROSE instead.

setActiveTaxTable(new TaxTable());
const assets = [
    { instrument: 'taxableEquity', displayName: 'Brokerage',
      startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 12 },
      startCurrency: { amount: 500000 }, startBasisCurrency: { amount: 250000 },
      annualReturnRate: { rate: 0.0 }, annualDividendRate: { rate: 0.02 } },
    { instrument: 'monthlyExpense', displayName: 'Living',
      startDateInt: { year: 2026, month: 1 }, finishDateInt: { year: 2026, month: 12 },
      startCurrency: { amount: -10000 }, startBasisCurrency: { amount: 0 },
      annualReturnRate: { rate: 0.0 },
      fundTransfers: [{ toDisplayName: 'Brokerage', monthlyMoveValue: 100, closeMoveValue: 0 }] },
].map(o => ModelAsset.fromJSON(o));

const portfolio = new Portfolio(assets, false);
portfolio.lifeEvents = [];
await chronometer_run(portfolio);

const b = assets[0];
const endRatio = b.getUnrealizedGainRatio();
ok(endRatio < 0.50,
    `year of dividends lowers the gain ratio (${(endRatio * 100).toFixed(2)}% < 50%)`);

console.log(`\ndividend-basis OK — ${passed} assertions`);
