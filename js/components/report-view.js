/**
 * <report-view>
 *
 * Lit component that renders accumulated reports (monthly & yearly)
 * as collapsible <details> sections with financial tables.
 *
 * Usage:
 *   <report-view></report-view>
 *   document.querySelector('report-view').reports = getReports();
 */

import { LitElement, html, css } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

class ReportView extends LitElement {

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
                No reports recorded. Enable reports on an asset and run a calculation.
            </p>`;
        }

        return html`${this.reports.map(({ type, dateLabel, pkg }) => {
            const badgeColor = type === 'yearly' ? '#7c3aed' : '#2563eb';
            const badgeLabel = type === 'yearly' ? 'YEARLY' : 'MONTHLY';

            const rows = [
                ['Income', this._fmt(pkg.totalIncome())],
                ['  Ordinary', this._fmt(pkg.ordinaryIncome())],
                ['    Employed', this._fmt(pkg.employedIncome)],
                ['    Self', this._fmt(pkg.selfIncome)],
                ['    Social Security', this._fmt(pkg.socialSecurityIncome)],
                ['    Interest', this._fmt(pkg.interestIncome)],
                ['    Short-Term Gains', this._fmt(pkg.shortTermCapitalGains)],
                ['    Non-Qual Dividends', this._fmt(pkg.nonQualifiedDividends)],
                ['    Taxable Distribution', this._fmt(pkg.taxableDistribution())],
                ['      IRA Distribution', this._fmt(pkg.tradIRADistribution)],
                ['      401K Distribution', this._fmt(pkg.four01KDistribution)],
                ['  Capital Gain', this._fmt(pkg.capitalGain())],
                ['  Tax-Free Distribution', this._fmt(pkg.taxFreeDistribution())],
                ['    Roth Distribution', this._fmt(pkg.rothIRADistribution)],
                ['  Qualified Dividends', this._fmt(pkg.qualifiedDividends)],
                ['Deductions', this._fmt(pkg.deductions())],
                ['  Traditional IRA', this._fmt(pkg.tradIRAContribution)],
                ['  Traditional 401K', this._fmt(pkg.four01KContribution)],
                ['  Mortgage Interest', this._fmt(pkg.mortgageInterest)],
                ['  Property Tax (Deductible)', this._fmt(pkg.deductiblePropertyTaxes())],
                ['Federal Taxes', this._fmt(pkg.federalTaxes())],
                ['  FICA', this._fmt(pkg.fica())],
                ['  Income Tax', this._fmt(pkg.incomeTax)],
                ['  LT Cap Gains Tax', this._fmt(pkg.longTermCapitalGainsTax)],
                ['  Estimated Taxes', this._fmt(pkg.estimatedTaxes)],
                ['Local Taxes', this._fmt(pkg.saltTaxes())],
                ['  Property Tax (Total)', this._fmt(pkg.propertyTaxes)],
                ['Contributions', this._fmt(pkg.contributions())],
                ['  Pre-Tax', this._fmt(pkg.preTaxContribution())],
                ['    401K', this._fmt(pkg.four01KContribution)],
                ['    Traditional IRA', this._fmt(pkg.tradIRAContribution)],
                ['  Post-Tax', this._fmt(pkg.postTaxContribution())],
                ['    Roth IRA', this._fmt(pkg.rothIRAContribution)],
                ['Debt Paydown', this._fmt(pkg.totalDebtPaydown())],
                ['  Mortgage Principal', this._fmt(pkg.mortgagePrincipal)],               
                ['Cash Flow', this._fmt(pkg.cashFlow())],
                ['  Cash In', this._fmt(pkg.cashInFlow())],
                ['  Cash Out', this._fmt(pkg.cashOutFlow())],
                ['    Taxes', this._fmt(pkg.totalTaxes())],
                ['    Expenses', this._fmt(pkg.expense)],
                ['Effective Tax Rate', pkg.effectiveTaxRate().toFixed(2) + '%'],
                ['Asset Growth', this._fmt(pkg.growth())],
                ['Wealth Growth', this._fmt(pkg.wealth())],
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

    scrollToDate(year, month) {
        const target = `${year}-${String(month).padStart(2, '0')}`;
        const container = this.closest('.overflow-auto');
        const details = this.querySelectorAll('details');
        for (const el of details) {
            const summary = el.querySelector('summary');
            if (summary && summary.textContent.includes(target)) {
                el.open = true;
                if (container) {
                    container.scrollTop = el.offsetTop - container.offsetTop - container.clientHeight / 2;
                }
                el.style.background = '#FAECE7';
                setTimeout(() => el.style.background = '', 1500);
                return;
            }
        }
    }

    _fmt(currency) {
        if (currency && typeof currency.toString === 'function') return currency.toString();
        return String(currency);
    }
}

customElements.define('report-view', ReportView);
