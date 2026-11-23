/**
 * <spreadsheet-view>
 *
 * Lit component for the Spreadsheet detail tab. Renders a month-by-month table
 * with columns grouped by asset, automatically omitting metrics that stay zero
 * across the entire plan. Also builds matching RFC 4180 CSV exports.
 *
 * Properties:
 *   portfolio - simulated Portfolio containing monthly asset metric arrays
 *
 * Methods:
 *   scrollToDate(year, month) - scrolls to and briefly highlights that month's row
 *   toCSV()                   - returns the rendered table as a CSV string
 */

import { LitElement, html, nothing } from 'lit';
import { formatCurrency } from '../utils/html.js';
import { visibleWindow, rowScrollTop, DEFAULT_ROW_HEIGHT } from '../utils/virtual-window.js';

const FALLBACK_VIEWPORT = 560;

const metrics = [
    { key: 'monthlyValues',                label: 'Value' },
    { key: 'monthlyGrowths',               label: 'Growth' },
    { key: 'monthlyQualifiedDividends',     label: 'Qual. Div' },
    { key: 'monthlyNonQualifiedDividends', label: 'Non-Q Div' },
    { key: 'monthlyIncomes',               label: 'Income' },
    { key: 'monthlyTaxes',                 label: 'Taxes' },
    { key: 'monthlyCashFlows',              label: 'Cash Flow' },
    { key: 'monthlyCashFlowAccumulateds',   label: 'Accumulated' },
    { key: 'monthlyShortTermCapitalGains',  label: 'ST Cap Gain' },
    { key: 'monthlyLongTermCapitalGains',   label: 'LT Cap Gain' },
    { key: 'monthlyRMDs',                  label: 'RMD' },
    { key: 'monthlySocialSecurityTaxes',    label: 'SS Tax' },
    { key: 'monthlySocialSecurityIncomes', label: 'SS Income' },
    { key: 'monthlyPensionIncomes',       label: 'Pension Inc' },
    { key: 'monthlyMedicareTaxes',         label: 'Medicare Tax' },
    { key: 'monthlyIncomeTaxes',           label: 'Income Tax' },
    { key: 'monthlyMortgagePayments',      label: 'Mortgage Pmt' },
    { key: 'monthlyMortgageInterests',     label: 'Mortgage Int' },
    { key: 'monthlyMortgagePrincipals',    label: 'Mortgage Prin' },
    { key: 'monthlyEstimatedTaxes',        label: 'Est Tax' },
    { key: 'monthlyTradIRAContributions',  label: 'IRA Contrib' },
    { key: 'monthlyRothIRAContributions',  label: 'Roth Contrib' },
    { key: 'monthlyFour01KContributions',  label: '401K Contrib' },
    { key: 'monthlyTradIRADistributions',  label: 'IRA Distrib' },
    { key: 'monthlyRothIRADistributions',  label: 'Roth Distrib' },
    { key: 'monthlyFour01KDistributions',  label: '401K Distrib' },
    { key: 'monthlyInterestIncomes',       label: 'Interest Inc' },
    { key: 'monthlyCapitalGainsTaxes',     label: 'Cap Gains Tax' },
    { key: 'monthlyNIIT',                  label: 'NIIT' },
    { key: 'monthlyHealthPremiums',        label: 'Health Premium' },
    { key: 'monthlyPremiumTaxCredits',     label: 'Advance PTC' },
    { key: 'monthlyPTCReconciliations',    label: 'PTC Settled' },
    { key: 'monthlyCredits',               label: 'Credit' },
];

/**
 * One CSV cell (RFC 4180): quoted when it holds a comma, a quote or a line
 * break, with quotes doubled. An asset called "Savings, joint" otherwise
 * became two cells and shifted every column after it.
 */
export function csvCell(text) {
    const s = String(text ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

class SpreadsheetView extends LitElement {

    static properties = {
        portfolio:     { type: Object },
        _winStart:     { state: true },
        _winEnd:       { state: true },
        _highlightIdx: { state: true },
    };

    createRenderRoot() { return this; }

    constructor() {
        super();
        this.portfolio = null;
        this._assetColumns = [];
        this._dateLabels = [];
        this._dateIndex = new Map();
        this._scrollTop = 0;
        this._rowHeight = DEFAULT_ROW_HEIGHT;
        this._headerHeight = 0;
        this._measured = false;
        this._winStart = 0;
        this._winEnd = 0;
        this._highlightIdx = -1;
        this._flashTimer = null;
        this._rafId = 0;
        this._scroller = null;
        this._onScroll = () => this._scheduleScrollSync();
    }

    connectedCallback() {
        super.connectedCallback();
        this._attachScroller();
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this._detachScroller();
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = 0;
        }
        clearTimeout(this._flashTimer);
        this._flashTimer = null;
    }

    willUpdate(changed) {
        if (changed.has('portfolio')) {
            this._rebuildCache();
            this._measured = false;
            this._highlightIdx = -1;
            const win = this._computeWindow(this._scrollTop);
            this._winStart = win.start;
            this._winEnd = win.end;
        }
    }

    updated() {
        this._attachScroller();
        if (!this._measured && this._dateLabels.length > 0) {
            const thead = this.querySelector('thead');
            const dataRow = this.querySelector('tbody tr[data-row]');
            if (dataRow) {
                const rh = dataRow.getBoundingClientRect().height;
                const hh = thead ? thead.getBoundingClientRect().height : 0;
                if (rh > 0) {
                    this._measured = true;
                    const changed = Math.abs(rh - this._rowHeight) > 0.5 || Math.abs(hh - this._headerHeight) > 0.5;
                    this._rowHeight = rh;
                    this._headerHeight = hh;
                    if (changed) this._syncWindow();
                }
            }
        }
    }

    _attachScroller() {
        const next = this.closest?.('.overflow-auto') ?? null;
        if (next === this._scroller) return;
        this._detachScroller();
        this._scroller = next;
        if (this._scroller) {
            this._scroller.addEventListener('scroll', this._onScroll, { passive: true });
        }
    }

    _detachScroller() {
        if (this._scroller) {
            this._scroller.removeEventListener('scroll', this._onScroll);
            this._scroller = null;
        }
    }

    _scheduleScrollSync() {
        if (this._rafId) return;
        this._rafId = requestAnimationFrame(() => {
            this._rafId = 0;
            this._syncWindow();
        });
    }

    _computeWindow(scrollTop) {
        const viewH = this._scroller?.clientHeight || 0;
        return visibleWindow(this._dateLabels.length, scrollTop, viewH, {
            rowHeight: this._rowHeight,
            headerHeight: this._headerHeight,
            fallbackViewport: FALLBACK_VIEWPORT,
        });
    }

    _syncWindow() {
        this._scrollTop = this._scroller ? this._scroller.scrollTop : this._scrollTop;
        const win = this._computeWindow(this._scrollTop);
        if (win.start !== this._winStart || win.end !== this._winEnd) {
            this._winStart = win.start;
            this._winEnd = win.end;
        }
    }

    render() {
        if (!this.portfolio) {
            return html`<p class="vt-empty">
                No spreadsheet data available. Run a calculation first.
            </p>`;
        }

        const assetColumns = this._assetColumns;
        if (assetColumns.length === 0) {
            return html`<p class="vt-empty">
                No spreadsheet data available. Run a calculation first.
            </p>`;
        }

        const totalCols = 1 + assetColumns.reduce((sum, ac) => sum + ac.metrics.length, 0);
        const { start, end, topPad, bottomPad } = this._computeWindow(this._scrollTop);
        const visible = [];
        for (let i = start; i < end; i++) {
            const dateLabel = this._dateLabels[i];
            visible.push(html`
                <tr data-row="${i}" class="${i === this._highlightIdx ? 'vt-flash' : ''}">
                    <td class="spreadsheet-date-col">${dateLabel}</td>
                    ${assetColumns.map(ac => ac.metrics.map(m => {
                        const arr = ac.asset[m.key];
                        const val = (arr && i < arr.length) ? arr[i] : 0;
                        const formatted = val !== 0
                            ? formatCurrency(val, { cents: true })
                            : '\u2014';
                        return html`<td class="${val < 0 ? 'spreadsheet-negative' : ''}">${formatted}</td>`;
                    }))}
                </tr>
            `);
        }

        return html`
            <table class="spreadsheet-table vt-table">
                <thead>
                    <tr>
                        <th rowspan="2" class="spreadsheet-date-col">Date</th>
                        ${assetColumns.map(ac => html`
                            <th colspan="${ac.metrics.length}" class="spreadsheet-asset-header">${ac.asset.displayName}</th>
                        `)}
                    </tr>
                    <tr>
                        ${assetColumns.map(ac => ac.metrics.map(m => html`
                            <th class="spreadsheet-metric-header">${m.label}</th>
                        `))}
                    </tr>
                </thead>
                <tbody>
                    ${topPad > 0 ? html`<tr class="vt-spacer" aria-hidden="true"><td colspan="${totalCols}" style="height:${topPad}px"></td></tr>` : nothing}
                    ${visible}
                    ${bottomPad > 0 ? html`<tr class="vt-spacer" aria-hidden="true"><td colspan="${totalCols}" style="height:${bottomPad}px"></td></tr>` : nothing}
                </tbody>
            </table>
        `;
    }

    _rebuildCache() {
        this._assetColumns = this._buildAssetColumns(this.portfolio);
        this._dateLabels = this._buildDateLabels(this.portfolio);
        this._dateIndex = new Map();
        for (let i = 0; i < this._dateLabels.length; i++) {
            this._dateIndex.set(this._dateLabels[i], i);
        }
    }

    _buildAssetColumns(portfolio = this.portfolio) {
        if (!portfolio) return [];
        const result = [];
        for (const modelAsset of portfolio.modelAssets) {
            const cols = [];
            for (const metric of metrics) {
                const arr = modelAsset[metric.key];
                if (arr && arr.length > 0 && arr.some(v => v !== 0)) {
                    cols.push(metric);
                }
            }
            if (cols.length > 0) {
                result.push({ asset: modelAsset, metrics: cols });
            }
        }
        return result;
    }

    _buildDateLabels(portfolio = this.portfolio) {
        if (!portfolio?.firstDateInt || !portfolio?.lastDateInt) return [];
        const DateInt = portfolio.firstDateInt.constructor;
        const labels = [];
        const cursor = new DateInt(portfolio.firstDateInt.toInt());
        while (cursor.toInt() <= portfolio.lastDateInt.toInt()) {
            labels.push(cursor.toHTML());
            cursor.nextMonth();
        }
        return labels;
    }

    scrollToDate(year, month) {
        const target = `${year}-${String(month).padStart(2, '0')}`;
        const idx = this._dateIndex.get(target);
        if (idx === undefined) return;
        const container = this._scroller ?? this.closest?.('.overflow-auto') ?? null;
        const top = rowScrollTop(idx, container?.clientHeight || 0, {
            rowHeight: this._rowHeight,
            headerHeight: this._headerHeight,
            fallbackViewport: FALLBACK_VIEWPORT,
        });
        this._scrollTop = top;
        const win = this._computeWindow(top);
        this._winStart = win.start;
        this._winEnd = win.end;
        this._highlightIdx = idx;
        if (container) container.scrollTop = top;
        clearTimeout(this._flashTimer);
        this._flashTimer = setTimeout(() => { this._highlightIdx = -1; }, 1500);
    }

    /** Build CSV string from the portfolio's full data (works even while collapsed). */
    toCSV(portfolio = this.portfolio) {
        if (!portfolio) return '';
        const assetColumns = this._buildAssetColumns(portfolio);
        if (assetColumns.length === 0) return '';
        const dateLabels = this._buildDateLabels(portfolio);

        // Header row 1: Date + asset names spanning their metric columns
        const h1 = ['Date'];
        for (const ac of assetColumns) {
            h1.push(csvCell(ac.asset.displayName));
            for (let i = 1; i < ac.metrics.length; i++) h1.push('');
        }

        // Header row 2: empty + metric labels
        const h2 = [''];
        for (const ac of assetColumns) {
            for (const m of ac.metrics) h2.push(csvCell(m.label));
        }

        const rows = [h1.join(','), h2.join(',')];

        for (let i = 0; i < dateLabels.length; i++) {
            const cells = [dateLabels[i]];
            for (const ac of assetColumns) {
                for (const m of ac.metrics) {
                    const arr = ac.asset[m.key];
                    const val = (arr && i < arr.length) ? arr[i] : 0;
                    cells.push(val !== 0 ? val.toFixed(2) : '0');
                }
            }
            rows.push(cells.join(','));
        }

        return rows.join('\n');
    }
}

customElements.define('spreadsheet-view', SpreadsheetView);
