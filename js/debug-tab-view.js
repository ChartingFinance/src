/**
 * debug-tab-view.js
 *
 * Builds an HTML view of accumulated debug reports (monthly & yearly)
 * for display as a tab in the Projections section.
 */

import { getReports } from './debug-panel.js';

function fmt(currency) {
    if (currency && typeof currency.toString === 'function') return currency.toString();
    return String(currency);
}

export function buildDebugReportsHTML() {
    const reports = getReports();

    if (reports.length === 0) {
        return '<p style="padding: 24px; font-family: DM Sans, sans-serif;">No debug reports recorded. Enable reports on an asset and run a calculation.</p>';
    }

    let html = '';

    for (const { type, dateLabel, pkg } of reports) {
        const badgeColor = type === 'yearly' ? '#7c3aed' : '#2563eb';
        const badgeLabel = type === 'yearly' ? 'YEARLY' : 'MONTHLY';

        html += '<details style="margin-bottom: 8px; border-bottom: 1px solid #f3f4f6; padding-bottom: 8px;">';
        html += '<summary style="cursor: pointer; font-weight: 600; padding: 4px 0;">';
        html += '<span style="background:' + badgeColor + ';color:#fff;padding:1px 8px;border-radius:6px;font-size:10px;font-weight:600;margin-right:6px;">' + badgeLabel + '</span>';
        html += dateLabel;
        html += '</summary>';

        html += '<table class="spreadsheet-table" style="margin-top: 4px;">';

        const rows = [
            ['Income', fmt(pkg.totalIncome())],
            ['&nbsp;&nbsp;Employed', fmt(pkg.employedIncome)],
            ['&nbsp;&nbsp;Self', fmt(pkg.selfIncome)],
            ['&nbsp;&nbsp;Ordinary', fmt(pkg.ordinaryIncome())],
            ['&nbsp;&nbsp;&nbsp;&nbsp;Social Security', fmt(pkg.socialSecurity)],
            ['&nbsp;&nbsp;&nbsp;&nbsp;IRA Distribution', fmt(pkg.iraDistribution)],
            ['&nbsp;&nbsp;&nbsp;&nbsp;401K Distribution', fmt(pkg.four01KDistribution)],
            ['&nbsp;&nbsp;&nbsp;&nbsp;Short-Term Gains', fmt(pkg.shortTermCapitalGains)],
            ['&nbsp;&nbsp;&nbsp;&nbsp;Interest', fmt(pkg.interestIncome)],
            ['&nbsp;&nbsp;&nbsp;&nbsp;Non-Qual Dividends', fmt(pkg.nonQualifiedDividends)],
            ['&nbsp;&nbsp;Long-Term Gains', fmt(pkg.longTermCapitalGains)],
            ['&nbsp;&nbsp;Non-Taxable', fmt(pkg.nontaxableIncome())],
            ['&nbsp;&nbsp;&nbsp;&nbsp;Roth Distribution', fmt(pkg.rothDistribution)],
            ['&nbsp;&nbsp;&nbsp;&nbsp;Qualified Dividends', fmt(pkg.qualifiedDividends)],
            ['Deductions', fmt(pkg.deductions())],
            ['&nbsp;&nbsp;Traditional IRA', fmt(pkg.iraContribution)],
            ['&nbsp;&nbsp;Traditional 401K', fmt(pkg.four01KContribution)],
            ['&nbsp;&nbsp;Mortgage Interest', fmt(pkg.mortgageInterest)],
            ['&nbsp;&nbsp;Property Tax (Deductible)', fmt(pkg.deductiblePropertyTaxes())],
            ['Taxes', fmt(pkg.totalTaxes())],
            ['&nbsp;&nbsp;FICA', fmt(pkg.fica)],
            ['&nbsp;&nbsp;Income Tax', fmt(pkg.incomeTax)],
            ['&nbsp;&nbsp;LT Cap Gains Tax', fmt(pkg.longTermCapitalGainsTax)],
            ['&nbsp;&nbsp;Property Tax (Total)', fmt(pkg.propertyTaxes)],
            ['&nbsp;&nbsp;Estimated Taxes', fmt(pkg.estimatedTaxes)],
            ['Contributions', fmt(pkg.contributions())],
            ['&nbsp;&nbsp;Traditional IRA', fmt(pkg.iraContribution)],
            ['&nbsp;&nbsp;Traditional 401K', fmt(pkg.four01KContribution)],
            ['&nbsp;&nbsp;Roth IRA', fmt(pkg.rothContribution)],
            ['Debt Paydown', ''],
            ['&nbsp;&nbsp;Mortgage Principal', fmt(pkg.mortgagePrincipal)],
            ['&nbsp;&nbsp;Mortgage Escrow', fmt(pkg.mortgageEscrow)],
            ['Asset Growth', fmt(pkg.growth())],
            ['Expenses', fmt(pkg.expense)],
            ['Total Earning', fmt(pkg.earning())],
            ['Effective Tax Rate', pkg.effectiveTaxRate().toFixed(2) + '%'],
        ];

        for (const [label, value] of rows) {
            const isHeader = !label.startsWith('&nbsp;');
            const bg = isHeader ? 'var(--parchment, #f9fafb)' : '';
            const weight = isHeader ? '600' : '400';
            html += '<tr' + (bg ? ' style="background:' + bg + '"' : '') + '>';
            html += '<td style="padding:2px 6px;font-weight:' + weight + '">' + label + '</td>';
            html += '<td style="padding:2px 6px;text-align:right;font-family:monospace">' + value + '</td>';
            html += '</tr>';
        }

        html += '</table>';
        html += '</details>';
    }

    return html;
}
