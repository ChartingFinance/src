/**
 * audit-credit-memos.mjs
 *
 * Standalone Node.js script to run the financial simulation on the test dataset
 * and produce a credit memo audit report through March 2027.
 *
 * Usage:  node src/tests/audit-credit-memos.mjs   (from repo root)
 */

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
import { DateInt } from '../js/utils/date-int.js';

// ── Test dataset ──────────────────────────────────────────────────────
const testData = [
    {
        "instrument": "home",
        "displayName": "My House",
        "startDateInt": { "year": 2026, "month": 2 },
        "startCurrency": { "amount": 1250000 },
        "startBasisCurrency": { "amount": 1185000 },
        "finishDateInt": { "year": 2029, "month": 7 },
        "monthsRemaining": 0,
        "annualDividendRate": { "annualReturnRate": 0 },
        "longTermCapitalHoldingPercentage": { "annualReturnRate": 0 },
        "annualReturnRate": { "annualReturnRate": 0.03 },
        "fundTransfers": [
            { "toDisplayName": "Taxable Assets", "moveValue": 100, "closeMoveValue": 100 }
        ],
        "isSelfEmployed": false,
        "annualTaxRate": { "annualReturnRate": 0.01 }
    },
    {
        "instrument": "mortgage",
        "displayName": "Mortgage",
        "startDateInt": { "year": 2026, "month": 2 },
        "startCurrency": { "amount": -638731 },
        "startBasisCurrency": { "amount": 0 },
        "finishDateInt": { "year": 2029, "month": 7 },
        "monthsRemaining": 307,
        "annualDividendRate": { "annualReturnRate": 0 },
        "longTermCapitalHoldingPercentage": { "annualReturnRate": 0 },
        "annualReturnRate": { "annualReturnRate": 0.0275 },
        "fundTransfers": [
            { "toDisplayName": "Taxable Assets", "moveValue": 0, "closeMoveValue": 100 }
        ],
        "isSelfEmployed": false,
        "annualTaxRate": { "annualReturnRate": 0 }
    },
    {
        "instrument": "monthlySalary",
        "displayName": "Consulting",
        "startDateInt": { "year": 2026, "month": 2 },
        "startCurrency": { "amount": 1000 },
        "startBasisCurrency": { "amount": 0 },
        "finishDateInt": { "year": 2027, "month": 12 },
        "monthsRemaining": 0,
        "annualDividendRate": { "annualReturnRate": 0 },
        "longTermCapitalHoldingPercentage": { "annualReturnRate": 0 },
        "annualReturnRate": { "annualReturnRate": 0.03 },
        "fundTransfers": [],
        "isSelfEmployed": true,
        "annualTaxRate": { "annualReturnRate": 0 }
    },
    {
        "instrument": "monthlySocialSecurity",
        "displayName": "Social Security",
        "startDateInt": { "year": 2031, "month": 4 },
        "startCurrency": { "amount": 2000 },
        "startBasisCurrency": { "amount": 0 },
        "finishDateInt": { "year": 2035, "month": 7 },
        "monthsRemaining": 0,
        "annualDividendRate": { "annualReturnRate": 0 },
        "longTermCapitalHoldingPercentage": { "annualReturnRate": 0 },
        "annualReturnRate": { "annualReturnRate": 0.03 },
        "fundTransfers": [],
        "isSelfEmployed": false,
        "annualTaxRate": { "annualReturnRate": 0 }
    },
    {
        "instrument": "usBond",
        "displayName": "Treasuries",
        "startDateInt": { "year": 2026, "month": 2 },
        "startCurrency": { "amount": 40000 },
        "startBasisCurrency": { "amount": 0 },
        "finishDateInt": { "year": 2035, "month": 7 },
        "monthsRemaining": 0,
        "annualDividendRate": { "annualReturnRate": 0 },
        "longTermCapitalHoldingPercentage": { "annualReturnRate": 0 },
        "annualReturnRate": { "annualReturnRate": 0.04 },
        "fundTransfers": [],
        "isSelfEmployed": false,
        "annualTaxRate": { "annualReturnRate": 0 }
    },
    {
        "instrument": "bank",
        "displayName": "Savings",
        "startDateInt": { "year": 2026, "month": 2 },
        "startCurrency": { "amount": 13000 },
        "startBasisCurrency": { "amount": 0 },
        "finishDateInt": { "year": 2035, "month": 7 },
        "monthsRemaining": 0,
        "annualDividendRate": { "annualReturnRate": 0 },
        "longTermCapitalHoldingPercentage": { "annualReturnRate": 0 },
        "annualReturnRate": { "annualReturnRate": 0.04 },
        "fundTransfers": [],
        "isSelfEmployed": false,
        "annualTaxRate": { "annualReturnRate": 0 }
    },
    {
        "instrument": "rothIRA",
        "displayName": "Roth IRA",
        "startDateInt": { "year": 2026, "month": 2 },
        "startCurrency": { "amount": 264000 },
        "startBasisCurrency": { "amount": 0 },
        "finishDateInt": { "year": 2035, "month": 7 },
        "monthsRemaining": 0,
        "annualDividendRate": { "annualReturnRate": 0 },
        "longTermCapitalHoldingPercentage": { "annualReturnRate": 0 },
        "annualReturnRate": { "annualReturnRate": 0.09 },
        "fundTransfers": [],
        "isSelfEmployed": false,
        "annualTaxRate": { "annualReturnRate": 0 }
    },
    {
        "instrument": "ira",
        "displayName": "IRA",
        "startDateInt": { "year": 2026, "month": 2 },
        "startCurrency": { "amount": 852000 },
        "startBasisCurrency": { "amount": 0 },
        "finishDateInt": { "year": 2035, "month": 7 },
        "monthsRemaining": 0,
        "annualDividendRate": { "annualReturnRate": 0 },
        "longTermCapitalHoldingPercentage": { "annualReturnRate": 0 },
        "annualReturnRate": { "annualReturnRate": 0.09 },
        "fundTransfers": [],
        "isSelfEmployed": false,
        "annualTaxRate": { "annualReturnRate": 0 }
    },
    {
        "instrument": "taxableEquity",
        "displayName": "Taxable Assets",
        "startDateInt": { "year": 2026, "month": 2 },
        "startCurrency": { "amount": 638000 },
        "startBasisCurrency": { "amount": 300000 },
        "finishDateInt": { "year": 2035, "month": 7 },
        "monthsRemaining": 0,
        "annualDividendRate": { "annualReturnRate": 0.01 },
        "longTermCapitalHoldingPercentage": { "annualReturnRate": 0 },
        "annualReturnRate": { "annualReturnRate": 0.09 },
        "fundTransfers": [],
        "isSelfEmployed": false,
        "annualTaxRate": { "annualReturnRate": 0 }
    },
    {
        "instrument": "taxableEquity",
        "displayName": "TaxCloud",
        "startDateInt": { "year": 2026, "month": 2 },
        "startCurrency": { "amount": 300000 },
        "startBasisCurrency": { "amount": 57000 },
        "finishDateInt": { "year": 2028, "month": 12 },
        "monthsRemaining": 0,
        "annualDividendRate": { "annualReturnRate": 0 },
        "longTermCapitalHoldingPercentage": { "annualReturnRate": 0 },
        "annualReturnRate": { "annualReturnRate": 0.2 },
        "fundTransfers": [
            { "toDisplayName": "Taxable Assets", "moveValue": 0, "closeMoveValue": 100 }
        ],
        "isSelfEmployed": false,
        "annualTaxRate": { "annualReturnRate": 0 }
    },
    {
        "instrument": "monthlyExpense",
        "displayName": "Average Expenses",
        "startDateInt": { "year": 2026, "month": 2 },
        "startCurrency": { "amount": -7500 },
        "startBasisCurrency": { "amount": 0 },
        "finishDateInt": { "year": 2035, "month": 7 },
        "monthsRemaining": 0,
        "annualDividendRate": { "annualReturnRate": 0 },
        "longTermCapitalHoldingPercentage": { "annualReturnRate": 0 },
        "annualReturnRate": { "annualReturnRate": 0.03 },
        "fundTransfers": [
            { "toDisplayName": "IRA", "moveValue": 80, "closeMoveValue": 0 },
            { "toDisplayName": "Taxable Assets", "moveValue": 20, "closeMoveValue": 0 }
        ],
        "isSelfEmployed": false,
        "annualTaxRate": { "annualReturnRate": 0 }
    }
];

// ── Run ───────────────────────────────────────────────────────────────

// Initialize the tax table (uses defaults from globals.js: Single, 2025)
setActiveTaxTable(new TaxTable());

const modelAssets = testData.map(obj => ModelAsset.fromJSON(obj));
const portfolio = new Portfolio(modelAssets, true);
await chronometer_run(portfolio);

// ── Filter memos through March 2027 ──────────────────────────────────

const cutoff = DateInt.from(2027, 3);

const allMemos = [];
for (const asset of portfolio.modelAssets) {
    for (const memo of asset.creditMemos) {
        if (memo.dateInt && memo.dateInt.toInt() <= cutoff.toInt()) {
            allMemos.push({
                date: memo.dateInt,
                asset: asset.displayName,
                instrument: asset.instrument,
                note: memo.note,
                amount: memo.amount.amount,
                kind: memo.kind,
            });
        }
    }
}

// Sort chronologically, then by asset name
allMemos.sort((a, b) => {
    const d = a.date.toInt() - b.date.toInt();
    if (d !== 0) return d;
    return a.asset.localeCompare(b.asset);
});

// ── Group by category (note) ──────────────────────────────────────────

const categories = {};
for (const m of allMemos) {
    if (!categories[m.note]) {
        categories[m.note] = { memos: [], total: 0, kind: m.kind };
    }
    categories[m.note].memos.push(m);
    categories[m.note].total += m.amount;
}

// ── Output report ─────────────────────────────────────────────────────

const fmt = (n) => {
    const sign = n < 0 ? '-' : '';
    return sign + '$' + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

const dateStr = (d) => `${d.year}-${String(d.month).padStart(2, '0')}`;

console.log('='.repeat(100));
console.log('CREDIT MEMO AUDIT REPORT');
console.log(`Period: Feb 2026 – Mar 2027 (${allMemos.length} memos total)`);
console.log('='.repeat(100));

// Summary table
console.log('\n── SUMMARY BY CATEGORY ──────────────────────────────────────\n');
const sortedCats = Object.entries(categories).sort((a, b) => Math.abs(b[1].total) - Math.abs(a[1].total));
console.log(`${'Category'.padEnd(45)} ${'Count'.padStart(6)} ${'Total'.padStart(15)}`);
console.log('-'.repeat(68));
for (const [note, data] of sortedCats) {
    const label = data.kind === 'info' ? `${note} (non-cash)` : note;
    console.log(`${label.padEnd(45)} ${String(data.memos.length).padStart(6)} ${fmt(data.total).padStart(15)}`);
}
console.log('-'.repeat(68));
const cashMemos = allMemos.filter(m => m.kind !== 'info');
console.log(`${'CASH TOTAL (excludes non-cash)'.padEnd(45)} ${String(cashMemos.length).padStart(6)} ${fmt(cashMemos.reduce((s, m) => s + m.amount, 0)).padStart(15)}`);
console.log(`${'GRAND TOTAL'.padEnd(45)} ${String(allMemos.length).padStart(6)} ${fmt(allMemos.reduce((s, m) => s + m.amount, 0)).padStart(15)}`);

// Detail by category
for (const [note, data] of sortedCats) {
    console.log(`\n${'─'.repeat(100)}`);
    console.log(`CATEGORY: ${note}`);
    console.log(`Count: ${data.memos.length}  |  Total: ${fmt(data.total)}`);
    console.log(`${'─'.repeat(100)}`);
    console.log(`${'Date'.padEnd(10)} ${'Asset'.padEnd(25)} ${'Instrument'.padEnd(20)} ${'Amount'.padStart(15)}`);
    console.log('-'.repeat(72));
    for (const m of data.memos) {
        console.log(`${dateStr(m.date).padEnd(10)} ${m.asset.padEnd(25)} ${m.instrument.padEnd(20)} ${fmt(m.amount).padStart(15)}`);
    }
}

// Also output a chronological view
console.log(`\n${'='.repeat(100)}`);
console.log('CHRONOLOGICAL VIEW (all memos)');
console.log(`${'='.repeat(100)}`);
console.log(`${'Date'.padEnd(10)} ${'Asset'.padEnd(25)} ${'Category'.padEnd(40)} ${'Amount'.padStart(15)}`);
console.log('-'.repeat(92));

let currentMonth = null;
let monthTotal = 0;
for (const m of allMemos) {
    const ds = dateStr(m.date);
    if (currentMonth && currentMonth !== ds) {
        console.log(`${''.padEnd(75)} ${fmt(monthTotal).padStart(15)}  ← month net`);
        console.log('');
        monthTotal = 0;
    }
    currentMonth = ds;
    monthTotal += m.amount;
    console.log(`${ds.padEnd(10)} ${m.asset.padEnd(25)} ${m.note.padEnd(40)} ${fmt(m.amount).padStart(15)}`);
}
if (currentMonth) {
    console.log(`${''.padEnd(75)} ${fmt(monthTotal).padStart(15)}  ← month net`);
}

// Asset balance reconciliation — CASH memos only: info memos (recognition,
// attribution, escrow accrual) move no money and would break the ledger.
console.log(`\n${'='.repeat(100)}`);
console.log('ASSET BALANCE RECONCILIATION (start value + sum of CASH memos through Mar 2027)');
console.log(`${'='.repeat(100)}`);
console.log(`${'Asset'.padEnd(25)} ${'Start Value'.padStart(15)} ${'Cash Memos'.padStart(15)} ${'Expected'.padStart(15)} ${'Actual'.padStart(15)} ${'Delta'.padStart(12)}`);
console.log('-'.repeat(100));

for (const asset of portfolio.modelAssets) {
    const assetMemos = allMemos.filter(m => m.asset === asset.displayName && m.kind !== 'info');
    const memoSum = assetMemos.reduce((s, m) => s + m.amount, 0);
    const startVal = asset.startCurrency.amount;
    const expected = startVal + memoSum;
    const actual = asset.finishCurrency.amount;
    // Note: actual is the final sim value (2035), not Mar 2027, so delta is expected for long-running assets
    console.log(
        `${asset.displayName.padEnd(25)} ${fmt(startVal).padStart(15)} ${fmt(memoSum).padStart(15)} ${fmt(expected).padStart(15)} ${fmt(actual).padStart(15)} ${fmt(actual - expected).padStart(12)}`
    );
}
