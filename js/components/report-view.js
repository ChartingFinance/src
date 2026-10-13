/**
 * <report-view>
 *
 * Lit component that renders accumulated reports (monthly & yearly)
 * as collapsible <details> sections with financial tables.
 *
 * Usage:
 *   <report-view></report-view>
 *   const view = document.querySelector('report-view');
 *   view.taxYears = portfolio.taxYears;
 *   view.reports = portfolio.generatedReports;
 */

import { LitElement, html, css } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { formatCurrency } from '../utils/html.js';
import { MagiPurpose } from '../tax-basis.js';

/**
 * The rows of one report, as [label, formatted value]. Leading spaces in a
 * label mark a sub-row; a label without them is a heading.
 *
 * A yearly report also shows the year's AGI and the modified AGI each rule
 * measures against. They come from the year's TaxYear record, never from the
 * package: the record is what the annual pass measured. A yearly report fires
 * on New Year's Day, so it matches the record for `coversYear`, not the year it
 * is dated. A monthly report has none, because every MAGI rule is annual and a
 * month ×12 is not a year.
 *
 * @param {{type: string, coversYear?: number, pkg: FinancialPackage}} report
 * @param {TaxYear[]} [taxYears]  Portfolio.taxYears
 * @returns {Array<[string, string]>}
 */
export function reportRows({ type, coversYear, pkg }, taxYears = []) {
    return [
        ['Income', fmt(pkg.totalIncome())],
        ['  Ordinary', fmt(pkg.ordinaryIncome())],
        ['    Employed', fmt(pkg.employedIncome)],
        ['    Self', fmt(pkg.selfIncome)],
        ['    Social Security', fmt(pkg.socialSecurityIncome)],
        ['    Pension', fmt(pkg.pensionIncome)],
        ['    Interest', fmt(pkg.interestIncome)],
        ['    Short-Term Gains', fmt(pkg.shortTermCapitalGains)],
        ['    Non-Qual Dividends', fmt(pkg.nonQualifiedDividends)],
        ['    Taxable Distribution', fmt(pkg.taxableDistribution())],
        ['      IRA Distribution', fmt(pkg.tradIRADistribution)],
        ['      401K Distribution', fmt(pkg.four01KDistribution)],
        ['  Capital Gain', fmt(pkg.capitalGain())],
        ['  Tax-Free Distribution', fmt(pkg.taxFreeDistribution())],
        ['    Roth Distribution', fmt(pkg.rothIRADistribution)],
        ['  Qualified Dividends', fmt(pkg.qualifiedDividends)],
        ['Deductions', fmt(pkg.deductions())],
        ['  Traditional IRA', fmt(pkg.tradIRAContribution)],
        ['  Traditional 401K', fmt(pkg.four01KContribution)],
        ['  Mortgage Interest', fmt(pkg.mortgageInterest)],
        ['  Property Tax (Deductible)', fmt(pkg.deductiblePropertyTaxes())],
        ...(type === 'yearly' ? agiRows(taxYears.find((t) => t.year === coversYear)) : []),
        ...federalTaxRows(pkg),
        ['Local Taxes', fmt(pkg.saltTaxes())],
        ['  Property Tax (Total)', fmt(pkg.propertyTaxes)],
        ['Contributions', fmt(pkg.contributions())],
        ['  Pre-Tax', fmt(pkg.preTaxContribution())],
        ['    401K', fmt(pkg.four01KContribution)],
        ['    Traditional IRA', fmt(pkg.tradIRAContribution)],
        ['  Post-Tax', fmt(pkg.postTaxContribution())],
        ['    Roth IRA', fmt(pkg.rothIRAContribution)],
        ['Debt Paydown', fmt(pkg.totalDebtPaydown())],
        ['  Mortgage Principal', fmt(pkg.mortgagePrincipal)],
        ['Cash Flow', fmt(pkg.cashFlow())],
        ['  Cash In', fmt(pkg.cashInFlow())],
        ['  Cash Out', fmt(pkg.cashOutFlow())],
        ['    Taxes', fmt(pkg.totalTaxes())],
        ['    Expenses', fmt(pkg.expense)],
        ['Effective Tax Rate', pkg.effectiveTaxRate().toFixed(2) + '%'],
        ['Asset Growth', fmt(pkg.growth())],
        ['Wealth Growth', fmt(pkg.wealth())],
    ];
}

/**
 * NIIT, IRMAA and the senior deduction all measure AGI unchanged in this model,
 * so they share one row; tests/report-agi-rows.mjs fails if they ever differ.
 * The other three each add or remove something (see tax-basis.js). A yearly
 * report with no record shows a dash rather than a $0.00 nobody could explain.
 */
function agiRows(taxYear) {
    const show = (amount) => (taxYear ? fmt(amount) : '—');
    return [
        ['Adjusted Gross Income (AGI)', show(taxYear?.agi)],
        ['  MAGI (NIIT, IRMAA, Senior Deduction)', show(taxYear?.magi[MagiPurpose.NIIT])],
        ['  MAGI (IRA Deduction)', show(taxYear?.magi[MagiPurpose.IRA_DEDUCTION])],
        ['  MAGI (Roth Contribution)', show(taxYear?.magi[MagiPurpose.ROTH_CONTRIBUTION])],
        ['  MAGI (ACA Premium Credit)', show(taxYear?.magi[MagiPurpose.ACA])],
    ];
}

/**
 * What the period paid, which is not what its income owed. The annual pass
 * settles a year on the following January 1, so the true-up and NIIT in a
 * package always belong to the previous tax year: a yearly report shows them
 * beside the next year's AGI. They get their own sub-total for that reason.
 * The sub-rows sum to the heading, as federalTaxes() sums FEDERAL_TAX_FIELDS.
 */
function federalTaxRows(pkg) {
    return [
        ['Federal Taxes Paid', fmt(pkg.federalTaxes())],
        ['  FICA', fmt(pkg.fica())],
        ['  Income Tax', fmt(pkg.incomeTax)],
        ['  LT Cap Gains Tax', fmt(pkg.longTermCapitalGainsTax)],
        ['  Estimated Taxes', fmt(pkg.estimatedTaxes)],
        ['  Prior-Year Settlement', fmt(pkg.taxTrueUp.amount + pkg.niit.amount)],
        ['    Annual True-Up', fmt(pkg.taxTrueUp)],
        ['    Net Investment Income Tax', fmt(pkg.niit)],
    ];
}

/** Full, with cents, like the ledger and the spreadsheet it sits beside. */
function fmt(currency) {
    return formatCurrency(currency?.amount ?? currency, { cents: true });
}

class ReportView extends LitElement {

    static properties = {
        reports: { type: Array },
        taxYears: { type: Array },
    };

    // Opt out of Shadow DOM so parent page styles (Tailwind, etc.) apply
    createRenderRoot() { return this; }

    constructor() {
        super();
        this.reports = [];
        this.taxYears = [];
    }

    render() {
        if (this.reports.length === 0) {
            return html`<p style="padding: 24px; font-family: DM Sans, sans-serif;">
                No reports recorded. Enable reports on an asset and run a calculation.
            </p>`;
        }

        return html`${this.reports.map((report) => {
            const { type, dateLabel } = report;
            const badgeColor = type === 'yearly' ? '#7c3aed' : '#2563eb';
            const badgeLabel = type === 'yearly' ? 'YEARLY' : 'MONTHLY';

            const rows = reportRows(report, this.taxYears);

            return html`
                <details style="margin-bottom: 8px; border-bottom: 1px solid #f3f4f6; padding-bottom: 8px;">
                    <summary style="cursor: pointer; font-weight: 600; padding: 4px 0;">
                        <span style="background:${badgeColor};color:#fff;padding:1px 8px;border-radius:6px;font-size:10px;font-weight:600;margin-right:6px;">${badgeLabel}</span>
                        ${type === 'yearly' ? report.coversYear : dateLabel}
                    </summary>
                    <table class="spreadsheet-table" style="margin-top: 4px;">
                        ${rows.map(([label, value]) => {
                            const isHeader = !label.startsWith(' ');
                            const bg = isHeader ? 'var(--parchment, #f9fafb)' : '';
                            const weight = isHeader ? '600' : '400';
                            // Only the indent is non-breaking: a long label
                            // may wrap on a narrow screen.
                            const displayLabel = label.replace(/^ +/, (indent) => ' '.repeat(indent.length));
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
}

customElements.define('report-view', ReportView);
