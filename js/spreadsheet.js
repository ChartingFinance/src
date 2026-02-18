import { DateInt } from './date-int.js';

// these metric keys reference getters on ModelAsset
export function buildSpreadsheetHTML(portfolio) {
    const metrics = [
        { key: 'monthlyValues',                label: 'Value' },
        { key: 'monthlyGrowths',               label: 'Growth' },
        { key: 'monthlyDividends',             label: 'Dividend' },
        { key: 'monthlyIncomes',               label: 'Income' },
        { key: 'monthlyTaxes',                 label: 'Taxes' },
        { key: 'monthlyEarnings',              label: 'Earning' },
        { key: 'monthlyAfterExpenses',         label: 'After Expense' },
        { key: 'monthlyAccumulateds',           label: 'Accumulated' },
        { key: 'monthlyShortTermCapitalGains',  label: 'ST Cap Gain' },
        { key: 'monthlyLongTermCapitalGains',   label: 'LT Cap Gain' },
        { key: 'monthlyRMDs',                  label: 'RMD' },
        { key: 'monthlySocialSecurities',      label: 'Soc Security' },
        { key: 'monthlyMedicares',             label: 'Medicare' },
        { key: 'monthlyIncomeTaxes',           label: 'Income Tax' },
        { key: 'monthlyMortgagePayments',      label: 'Mortgage Pmt' },
        { key: 'monthlyMortgageInterests',     label: 'Mortgage Int' },
        { key: 'monthlyMortgagePrincipals',    label: 'Mortgage Prin' },
        { key: 'monthlyMortgageEscrows',       label: 'Mort Escrow' },
        { key: 'monthlyEstimatedTaxes',        label: 'Est Tax' },
        { key: 'monthlyIRAContributions',      label: 'IRA Contrib' },
        { key: 'monthlyFour01KContributions',  label: '401K Contrib' },
        { key: 'monthlyIRADistributions',      label: 'IRA Distrib' },
        { key: 'monthlyFour01KDistributions',  label: '401K Distrib' },
        { key: 'monthlyInterestIncomes',       label: 'Interest Inc' },
        { key: 'monthlyCapitalGainsTaxes',     label: 'Cap Gains Tax' },
        { key: 'monthlyCredits',               label: 'Credit' },
    ];

    // Determine which columns to show per asset (only non-zero data)
    const assetColumns = [];
    for (const modelAsset of portfolio.modelAssets) {
        const cols = [];
        for (const metric of metrics) {
            const arr = modelAsset[metric.key];
            if (arr && arr.length > 0 && arr.some(v => v !== 0)) {
                cols.push(metric);
            }
        }
        if (cols.length > 0) {
            assetColumns.push({ asset: modelAsset, metrics: cols });
        }
    }

    if (assetColumns.length === 0) {
        return '<p style="padding: 24px; font-family: DM Sans, sans-serif;">No spreadsheet data available. Run a calculation first.</p>';
    }

    // Build date labels from first to last month
    const dateLabels = [];
    const cursor = new DateInt(portfolio.firstDateInt.toInt());
    while (cursor.toInt() <= portfolio.lastDateInt.toInt()) {
        dateLabels.push(cursor.toHTML());
        cursor.nextMonth();
    }

    let html = '<table class="spreadsheet-table">';

    // Header row 1: Asset display names spanning their metric columns
    html += '<thead>';
    html += '<tr><th rowspan="2" class="spreadsheet-date-col">Date</th>';
    for (const ac of assetColumns) {
        html += '<th colspan="' + ac.metrics.length + '" class="spreadsheet-asset-header">' + ac.asset.displayName + '</th>';
    }
    html += '</tr>';

    // Header row 2: Metric labels
    html += '<tr>';
    for (const ac of assetColumns) {
        for (const metric of ac.metrics) {
            html += '<th class="spreadsheet-metric-header">' + metric.label + '</th>';
        }
    }
    html += '</tr>';
    html += '</thead>';

    // Data rows: one per month
    html += '<tbody>';
    for (let i = 0; i < dateLabels.length; i++) {
        html += '<tr>';
        html += '<td class="spreadsheet-date-col">' + dateLabels[i] + '</td>';
        for (const ac of assetColumns) {
            for (const metric of ac.metrics) {
                const arr = ac.asset[metric.key];
                const val = (arr && i < arr.length) ? arr[i] : 0;
                const formatted = val !== 0
                    ? val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                    : '\u2014';
                const cls = val < 0 ? ' class="spreadsheet-negative"' : '';
                html += '<td' + cls + '>' + formatted + '</td>';
            }
        }
        html += '</tr>';
    }
    html += '</tbody>';
    html += '</table>';

    return html;
}
