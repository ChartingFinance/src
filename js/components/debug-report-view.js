/**
 * <debug-report-view>
 *
 * Lit component that renders accumulated debug reports (monthly & yearly)
 * as collapsible <details> sections with financial tables.
 *
 * Usage:
 *   <debug-report-view></debug-report-view>
 *   document.querySelector('debug-report-view').reports = getReports();
 */

import { LitElement, html, css } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

class DebugReportView extends LitElement {

    static properties = {
        reports: { type: Array },
    };

    // Opt out of Shadow DOM so parent page styles (Tailwind, etc.) apply
    createRenderRoot() { return this; }

    constructor() {
        super();
        this.reports = [];
    }

    render() {
        if (this.reports.length === 0) {
            return html`<p style="padding: 24px; font-family: DM Sans, sans-serif;">
                No debug reports recorded. Enable reports on an asset and run a calculation.
            </p>`;
        }

        return html`${this.reports.map(({ type, dateLabel, pkg }) => {
            const badgeColor = type === 'yearly' ? '#7c3aed' : '#2563eb';
            const badgeLabel = type === 'yearly' ? 'YEARLY' : 'MONTHLY';

            const rows = [
                ['Income', this._fmt(pkg.totalIncome())],
                ['  Employed', this._fmt(pkg.employedIncome)],
                ['  Self', this._fmt(pkg.selfIncome)],
                ['  Ordinary', this._fmt(pkg.ordinaryIncome())],
                ['    Social Security', this._fmt(pkg.socialSecurity)],
                ['    IRA Distribution', this._fmt(pkg.iraDistribution)],
                ['    401K Distribution', this._fmt(pkg.four01KDistribution)],
                ['    Short-Term Gains', this._fmt(pkg.shortTermCapitalGains)],
                ['    Interest', this._fmt(pkg.interestIncome)],
                ['    Non-Qual Dividends', this._fmt(pkg.nonQualifiedDividends)],
                ['  Long-Term Gains', this._fmt(pkg.longTermCapitalGains)],
                ['  Non-Taxable', this._fmt(pkg.nontaxableIncome())],
                ['    Roth Distribution', this._fmt(pkg.rothDistribution)],
                ['    Qualified Dividends', this._fmt(pkg.qualifiedDividends)],
                ['Deductions', this._fmt(pkg.deductions())],
                ['  Traditional IRA', this._fmt(pkg.iraContribution)],
                ['  Traditional 401K', this._fmt(pkg.four01KContribution)],
                ['  Mortgage Interest', this._fmt(pkg.mortgageInterest)],
                ['  Property Tax (Deductible)', this._fmt(pkg.deductiblePropertyTaxes())],
                ['Taxes', this._fmt(pkg.totalTaxes())],
                ['  FICA', this._fmt(pkg.fica)],
                ['  Income Tax', this._fmt(pkg.incomeTax)],
                ['  LT Cap Gains Tax', this._fmt(pkg.longTermCapitalGainsTax)],
                ['  Property Tax (Total)', this._fmt(pkg.propertyTaxes)],
                ['  Estimated Taxes', this._fmt(pkg.estimatedTaxes)],
                ['Contributions', this._fmt(pkg.contributions())],
                ['  Traditional IRA', this._fmt(pkg.iraContribution)],
                ['  Traditional 401K', this._fmt(pkg.four01KContribution)],
                ['  Roth IRA', this._fmt(pkg.rothContribution)],
                ['Debt Paydown', ''],
                ['  Mortgage Principal', this._fmt(pkg.mortgagePrincipal)],
                ['  Mortgage Escrow', this._fmt(pkg.mortgageEscrow)],
                ['Asset Growth', this._fmt(pkg.growth())],
                ['Expenses', this._fmt(pkg.expense)],
                ['Total Cash Flow', this._fmt(pkg.cashFlow())],
                ['Effective Tax Rate', pkg.effectiveTaxRate().toFixed(2) + '%'],
            ];

            return html`
                <details style="margin-bottom: 8px; border-bottom: 1px solid #f3f4f6; padding-bottom: 8px;">
                    <summary style="cursor: pointer; font-weight: 600; padding: 4px 0;">
                        <span style="background:${badgeColor};color:#fff;padding:1px 8px;border-radius:6px;font-size:10px;font-weight:600;margin-right:6px;">${badgeLabel}</span>
                        ${dateLabel}
                    </summary>
                    <table class="spreadsheet-table" style="margin-top: 4px;">
                        ${rows.map(([label, value]) => {
                            const isHeader = !label.startsWith(' ');
                            const bg = isHeader ? 'var(--parchment, #f9fafb)' : '';
                            const weight = isHeader ? '600' : '400';
                            const displayLabel = label.replace(/ /g, '\u00a0');
                            return html`
                                <tr style="${bg ? `background:${bg}` : ''}">
                                    <td style="padding:2px 6px;font-weight:${weight}">${displayLabel}</td>
                                    <td style="padding:2px 6px;text-align:right;font-family:monospace">${value}</td>
                                </tr>`;
                        })}
                    </table>
                </details>`;
        })}`;
    }

    _fmt(currency) {
        if (currency && typeof currency.toString === 'function') return currency.toString();
        return String(currency);
    }
}

customElements.define('debug-report-view', DebugReportView);
