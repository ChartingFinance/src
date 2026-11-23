/**
 * <report-view>
 *
 * Lit component for the Reports detail tab. Renders accumulated monthly and
 * yearly financial summaries as collapsible <details> tables, including annual
 * AGI/MAGI breakdowns and ACA Premium Tax Credit figures from TaxYear records.
 *
 * Properties:
 *   reports  - generated monthly/yearly report objects (portfolio.generatedReports)
 *   taxYears - annual TaxYear records (portfolio.taxYears) for yearly AGI/credit rows
 *
 * Methods:
 *   scrollToDate(year, month) - opens, scrolls to, and briefly highlights that month's report
 */

import { LitElement, html, nothing } from 'lit';
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
        ...(type === 'yearly' ? creditRows(taxYears.find((t) => t.year === coversYear)) : []),
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
        // Paid by the Treasury toward the period's premiums. Expenses below
        // are already net of it, so it is a row of its own, not a part of them.
        ...(pkg.premiumTaxCredit.amount !== 0
            ? [['Premium Tax Credit Advanced', fmt(pkg.premiumTaxCredit)]] : []),
        // Income received less expenses and taxes: the rule Month & Year
        // Details and the per-account Cash Flow metric use too.
        ['Cash Flow', fmt(pkg.cashFlow())],
        ['  Income Received', fmt(pkg.cashInFlow())],
        ['  Cash Out', fmt(pkg.cashOutFlow())],
        ['    Taxes', fmt(pkg.totalTaxes())],
        ['    Expenses', fmt(pkg.cashExpenses())],
        ['Effective Tax Rate', pkg.effectiveTaxRate().toFixed(2) + '%'],
        ['Asset Growth', fmt(pkg.growth())],
        ['Wealth Growth', fmt(pkg.wealth())],
    ];
}

/**
 * What a report is headed by and matched on: the month or year its package
 * holds. Never `dateLabel`, which is when the report fired, the first of the
 * following month (see Portfolio.reportMonthly and reportYearly).
 */
export function coverLabel(report) {
    return report.type === 'yearly' ? String(report.coversYear) : report.coversMonth;
}

/** The index of the monthly report holding a month, or -1. */
export function monthlyReportIndex(reports, year, month) {
    const target = `${year}-${String(month).padStart(2, '0')}`;
    return reports.findIndex((r) => r.type === 'monthly' && r.coversMonth === target);
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
 * The tax year's premium tax credit, from its TaxYear record, for a year a
 * health-insurance card covered; none otherwise. What the year allowed is what
 * was advanced during it plus what the return settled the following January.
 */
function creditRows(taxYear) {
    if (taxYear?.fplPercent == null) return [];
    return [
        ['Premium Tax Credit (Tax Year)', fmt(taxYear.ptc)],
        ['  Advanced During the Year', fmt(taxYear.aptc)],
        ['  Settled on the Return', fmt(taxYear.ptcReconciliation)],
        [taxYear.ptcOnEstimate ? '  Estimate, % of Poverty Line' : '  ACA MAGI, % of Poverty Line',
            `${taxYear.fplPercent}%`],
    ];
}

/**
 * What the period paid, which is not what its income owed. The annual pass
 * settles a year on the following January 1, so the true-up, NIIT and the
 * premium tax credit in a package always belong to the previous tax year: a
 * yearly report shows them beside the next year's AGI. They get their own
 * sub-total for that reason. The sub-rows sum to the heading, as
 * federalTaxes() sums FEDERAL_TAX_FIELDS.
 */
function federalTaxRows(pkg) {
    return [
        ['Federal Taxes Paid', fmt(pkg.federalTaxes())],
        ['  FICA', fmt(pkg.fica())],
        ['  Income Tax', fmt(pkg.incomeTax)],
        ['  LT Cap Gains Tax', fmt(pkg.longTermCapitalGainsTax)],
        ['  Estimated Taxes', fmt(pkg.estimatedTaxes)],
        ['  Prior-Year Settlement', fmt(pkg.taxTrueUp.amount + pkg.niit.amount + pkg.ptcReconciliation.amount)],
        ['    Annual True-Up', fmt(pkg.taxTrueUp)],
        ['    Net Investment Income Tax', fmt(pkg.niit)],
        ['    Premium Tax Credit', fmt(pkg.ptcReconciliation)],
    ];
}

/** Full, with cents, like the ledger and the spreadsheet it sits beside. */
function fmt(currency) {
    return formatCurrency(currency?.amount ?? currency, { cents: true });
}

class ReportView extends LitElement {

    static properties = {
        reports:   { type: Array },
        taxYears:  { type: Array },
        _open:     { state: true },
        _flashIdx: { state: true },
    };

    // Opt out of Shadow DOM so parent page styles (Tailwind, etc.) apply
    createRenderRoot() { return this; }

    constructor() {
        super();
        this.reports = [];
        this.taxYears = [];
        this._open = new Set();
        this._manualOpen = new Set();
        this._autoOpenedIdx = null;
        this._flashIdx = -1;
        this._flashTimer = null;
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        clearTimeout(this._flashTimer);
        this._flashTimer = null;
    }

    willUpdate(changed) {
        if (changed.has('reports')) {
            this._open = new Set();
            this._manualOpen = new Set();
            this._autoOpenedIdx = null;
            this._flashIdx = -1;
        }
    }

    _onToggle(idx, isOpen) {
        // Ignore the browser's toggle echo from our own programmatic open/close.
        if (this._open.has(idx) === isOpen) return;
        const next = new Set(this._open);
        if (isOpen) {
            next.add(idx);
            this._manualOpen.add(idx);
        } else {
            next.delete(idx);
            this._manualOpen.delete(idx);
            if (this._autoOpenedIdx === idx) this._autoOpenedIdx = null;
        }
        this._open = next;
    }

    _renderTable(report) {
        const rows = reportRows(report, this.taxYears);
        return html`
            <table class="spreadsheet-table rv-table">
                ${rows.map(([label, value]) => {
                    const isHeader = !label.startsWith(' ');
                    // Only the indent is non-breaking: a long label
                    // may wrap on a narrow screen.
                    const displayLabel = label.replace(/^ +/, (indent) => '\u00a0'.repeat(indent.length));
                    return html`
                        <tr class="${isHeader ? 'rv-row-head' : ''}">
                            <td class="rv-label">${displayLabel}</td>
                            <td class="rv-val">${value}</td>
                        </tr>`;
                })}
            </table>`;
    }

    render() {
        if (this.reports.length === 0) {
            return html`<p class="vt-empty">
                No reports recorded. Enable reports on an asset and run a calculation.
            </p>`;
        }

        return html`${this.reports.map((report, idx) => {
            const { type } = report;
            const badgeLabel = type === 'yearly' ? 'YEARLY' : 'MONTHLY';
            const isOpen = this._open.has(idx);

            return html`
                <details class="rv-item ${idx === this._flashIdx ? 'vt-flash' : ''}"
                         ?open=${isOpen}
                         @toggle=${(ev) => this._onToggle(idx, ev.currentTarget.open)}>
                    <summary class="rv-summary">
                        <span class="rv-badge rv-badge-${type}">${badgeLabel}</span>
                        ${coverLabel(report)}
                    </summary>
                    ${isOpen ? this._renderTable(report) : nothing}
                </details>`;
        })}`;
    }

    /** Open and centre the monthly report holding the selected month. */
    scrollToDate(year, month) {
        const idx = monthlyReportIndex(this.reports, year, month);
        if (idx < 0) return;

        // Close the previous auto-opened report (unless the user opened it
        // themselves) so scrubbing across months keeps only one table mounted.
        const next = new Set(this._open);
        if (this._autoOpenedIdx !== null && this._autoOpenedIdx !== idx && !this._manualOpen.has(this._autoOpenedIdx)) {
            next.delete(this._autoOpenedIdx);
        }
        next.add(idx);
        if (!this._manualOpen.has(idx)) this._autoOpenedIdx = idx;
        this._open = next;
        this._flashIdx = idx;
        clearTimeout(this._flashTimer);
        this._flashTimer = setTimeout(() => { this._flashIdx = -1; }, 1500);

        this.updateComplete?.then(() => {
            const el = this.querySelectorAll?.('details')?.[idx];
            if (!el) return;
            const container = this.closest?.('.overflow-auto');
            if (container) {
                container.scrollTop = el.offsetTop - container.offsetTop - container.clientHeight / 2;
            }
        });
    }
}

customElements.define('report-view', ReportView);
