/**
 * credit-memo-view.js
 *
 * Builds an HTML table of all credit memos across all assets,
 * sorted chronologically with date and asset columns.
 */

export function buildCreditMemosHTML(portfolio) {
    // Collect all memos with their asset display name
    const rows = [];
    for (const modelAsset of portfolio.modelAssets) {
        if (!modelAsset.creditMemos || modelAsset.creditMemos.length === 0) continue;
        for (const memo of modelAsset.creditMemos) {
            rows.push({
                dateInt: memo.dateInt,
                asset: modelAsset.displayName,
                amount: memo.amount,
                note: memo.note,
            });
        }
    }

    if (rows.length === 0) {
        return '<p style="padding: 24px; font-family: DM Sans, sans-serif;">No credit memos recorded. Run a calculation first.</p>';
    }

    // Sort by date, then by asset name
    rows.sort((a, b) => {
        const da = a.dateInt ? a.dateInt.toInt() : 0;
        const db = b.dateInt ? b.dateInt.toInt() : 0;
        if (da !== db) return da - db;
        return a.asset.localeCompare(b.asset);
    });

    let html = '<table class="spreadsheet-table">';

    // Header
    html += '<thead><tr>';
    html += '<th class="spreadsheet-date-col">Date</th>';
    html += '<th class="spreadsheet-asset-header">Asset</th>';
    html += '<th class="spreadsheet-metric-header">Amount</th>';
    html += '<th class="spreadsheet-metric-header">Note</th>';
    html += '</tr></thead>';

    // Data rows
    html += '<tbody>';
    for (const row of rows) {
        const dateStr = row.dateInt ? row.dateInt.toHTML() : '\u2014';
        const val = row.amount ? row.amount.amount : 0;
        const formatted = val !== 0
            ? val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : '\u2014';
        const cls = val < 0 ? ' class="spreadsheet-negative"' : '';

        html += '<tr>';
        html += '<td class="spreadsheet-date-col">' + dateStr + '</td>';
        html += '<td>' + row.asset + '</td>';
        html += '<td' + cls + '>' + formatted + '</td>';
        html += '<td>' + (row.note || '') + '</td>';
        html += '</tr>';
    }
    html += '</tbody>';
    html += '</table>';

    return html;
}
