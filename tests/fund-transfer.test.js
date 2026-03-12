// @vitest-environment happy-dom

import { test, expect, beforeEach, vi } from 'vitest';
import { Portfolio } from '../js/portfolio.js';
import { ModelAsset } from '../js/model-asset.js';
import { FundTransfer, Frequency } from '../js/fund-transfer.js';
import { Instrument } from '../js/instruments/instrument.js';
import { Currency } from '../js/utils/currency.js';
import { DateInt } from '../js/utils/date-int.js';
import { activeTaxTable } from '../js/globals.js'; // Note: removed setActiveTaxTable
import { chronometer_run } from '../js/chronometer.js';

// 1. Intercept globals and dynamically inject the dependency
vi.mock('../js/globals.js', async (importOriginal) => {
    const actual = await importOriginal();
    
    // Dynamically import TaxTable INSIDE the mock to bypass the hoisting issue
    const { TaxTable } = await import('../js/taxes.js'); 
    
    return { 
        ...actual, 
        activeTaxTable: new TaxTable() 
    };
});

beforeEach(() => {
    activeTaxTable.initializeChron();
});

test('Explicit Transfer: Routes net income to a Savings Account', async () => {
    const incomeAsset = new ModelAsset({
        instrument: Instrument.WORKING_INCOME,
        displayName: 'Job',
        startDateInt: DateInt.parse('2026-01'),
        finishDateInt: DateInt.parse('2026-12'),
        startCurrency: new Currency(10000), 
    });

    const savingsAsset = new ModelAsset({
        instrument: Instrument.BANK,
        displayName: 'High Yield Savings',
        startDateInt: DateInt.parse('2026-01'),
        finishDateInt: DateInt.parse('2040-01'),
        startCurrency: new Currency(0),
    });

    // Move 20% of income post-tax
    const transfer = new FundTransfer('High Yield Savings', Frequency.MONTHLY, 20, 0);
    incomeAsset.fundTransfers = [transfer];

    const portfolio = new Portfolio([incomeAsset, savingsAsset], false);
    portfolio.firstDateInt = DateInt.parse('2026-01');
    portfolio.lastDateInt = DateInt.parse('2026-01');
    
    await chronometer_run(portfolio);

    // Read the snapshotted metrics from history arrays
    const netIncome = incomeAsset.getHistory('netIncome')[0];
    const savedValue = savingsAsset.getHistory('value')[0];

    // Assertions
    expect(netIncome).toBeLessThan(10000); // Verify taxes were withheld
    
    const expectedTransfer = netIncome * 0.20;
    expect(savedValue).toBeCloseTo(expectedTransfer, 2);
});

test('Implicit Transfer: Gross-up shortfall from Taxable Account', async () => {
    // 1. Inject a high-income job to push the user out of the 0% LTCG bracket
    const incomeAsset = new ModelAsset({
        instrument: Instrument.WORKING_INCOME,
        displayName: 'Job',
        startDateInt: DateInt.parse('2026-01'),
        finishDateInt: DateInt.parse('2026-12'),
        startCurrency: new Currency(20000), 
    });

    const expenseAsset = new ModelAsset({
        instrument: Instrument.MONTHLY_EXPENSE,
        displayName: 'Lifestyle',
        startDateInt: DateInt.parse('2026-01'),
        finishDateInt: DateInt.parse('2026-12'),
        startCurrency: new Currency(-5000), 
    });

    const taxableBrokerage = new ModelAsset({
        instrument: Instrument.TAXABLE_EQUITY,
        displayName: 'Brokerage',
        startDateInt: DateInt.parse('2026-01'),
        finishDateInt: DateInt.parse('2040-01'),
        startCurrency: new Currency(100000),
        startBasisCurrency: new Currency(50000), // 50% embedded gain
    });

    const portfolio = new Portfolio([incomeAsset, expenseAsset, taxableBrokerage], false);
    portfolio.firstDateInt = DateInt.parse('2026-01');
    portfolio.lastDateInt = DateInt.parse('2026-01');

    await chronometer_run(portfolio);

    // 2. Isolate the exact withdrawal by reading the Credit Memos (avoids asset growth masking)
    const debits = taxableBrokerage.creditMemos.filter(cm => cm.amount.amount < 0);
    const exactWithdrawal = Math.abs(debits[0].amount.amount);

    // Assertions
    expect(exactWithdrawal).toBeGreaterThan(5000); // Proof the gross-up occurred
});