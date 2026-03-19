class SOP821ReportEngine {
    /**
     * Generates an SOP 82-1 Statement of Changes in Net Worth for a given period.
     * * @param {Object} metrics - A key-value map of metric snapshots for the period.
     * @param {number} previousUnrealizedTax - The Account 2500 balance from the prior period.
     * @param {number} currentUnrealizedTax - The Account 2500 balance for the current period.
     * @returns {Object} The formatted SOP 82-1 statement.
     */
    static generateStatement(metrics, previousUnrealizedTax = 0, currentUnrealizedTax = 0) {

        // --- 1. THE INCOME INTERCEPT (Removing Transfers) ---
        // Your DAG rolls distributions into INCOME. We must subtract them out
        // because moving money from an IRA to a Checking account does not increase Net Worth.
        const totalIncomeRollup = metrics.INCOME || 0;

        const wealthTransfersIn =
            (metrics.TRAD_IRA_DISTRIBUTION || 0) +
            (metrics.FOUR_01K_DISTRIBUTION || 0) +
            (metrics.ROTH_IRA_DISTRIBUTION || 0);

        const realizedIncreases = totalIncomeRollup - wealthTransfersIn;

        // --- 2. THE EXPENSE INTERCEPT (Removing Balance Sheet Reductions) ---
        // Your DAG rolls Mortgage Principal into EXPENSE. We must subtract it out
        // because paying down debt reduces cash (asset) but also reduces the loan (liability),
        // resulting in a net-zero change to Net Worth.
        const totalExpenseRollup = metrics.EXPENSE || 0;
        const totalTaxes = (metrics.INCOME_TAX || 0) + (metrics.CAPITAL_GAIN_TAX || 0);

        const balanceSheetReductions = metrics.MORTGAGE_PRINCIPAL || 0;

        const realizedDecreases = (totalExpenseRollup + totalTaxes) - balanceSheetReductions;

        // --- 3. UNREALIZED CHANGES (Paper Wealth) ---
        // Growth is naturally tracked by your DAG.
        const unrealizedAppreciation = metrics.GROWTH || 0;

        // Calculate the change in the hypothetical tax burden (Account 2500)
        const provisionForUnrealizedTaxes = currentUnrealizedTax - previousUnrealizedTax;

        // --- 4. CALCULATE TOTAL CHANGE ---
        const changeInNetWorth =
            realizedIncreases
            - realizedDecreases
            + unrealizedAppreciation
            - provisionForUnrealizedTaxes;

        // --- Return the Structured Statement ---
        return {
            realizedIncreases: {
                total: realizedIncreases,
                grossIncomeRollup: totalIncomeRollup,
                lessTransfers: wealthTransfersIn
            },
            realizedDecreases: {
                total: realizedDecreases,
                grossExpenseAndTaxes: totalExpenseRollup + totalTaxes,
                lessPrincipalPayments: balanceSheetReductions
            },
            unrealizedChanges: {
                total: unrealizedAppreciation - provisionForUnrealizedTaxes,
                assetAppreciation: unrealizedAppreciation,
                changeInEstimatedTaxLiability: provisionForUnrealizedTaxes
            },
            netChange: changeInNetWorth
        };
    }
}

// Example Usage:
// const statement = SOP821ReportEngine.generateStatement(currentMonthMetrics, 15000, 15500);
// console.log(`Net Worth changed by: $${statement.netChange}`);
