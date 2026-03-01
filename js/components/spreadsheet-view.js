/**
 * <spreadsheet-view>
 *
 * Lit component that renders the monthly financial spreadsheet table.
 * Receives a `portfolio` object as a property.
 */

import { LitElement, html } from 'lit';

const metrics = [
    { key: 'monthlyValues',                label: 'Value' },
    { key: 'monthlyGrowths',               label: 'Growth' },
    { key: 'monthlyDividends',             label: 'Dividend' },
    { key: 'monthlyIncomes',               label: 'Income' },
    { key: 'monthlyTaxes',                 label: 'Taxes' },
    { key: 'monthlyCashFlows',              label: 'Cash Flow' },
    { key: 'monthlyCashFlowAccumulateds',   label: 'Accumulated' },
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
    { key: 'monthlyTradIRAContributions',  label: 'IRA Contrib' },
    { key: 'monthlyRothIRAContributions',  label: 'Roth Contrib' },
    { key: 'monthlyFour01KContributions',  label: '401K Contrib' },
    { key: 'monthlyTradIRADistributions',  label: 'IRA Distrib' },
    { key: 'monthlyRothIRADistributions',  label: 'Roth Distrib' },
    { key: 'monthlyFour01KDistributions',  label: '401K Distrib' },
    { key: 'monthlyInterestIncomes',       label: 'Interest Inc' },
    { key: 'monthlyCapitalGainsTaxes',     label: 'Cap Gains Tax' },
    { key: 'monthlyCredits',               label: 'Credit' },
];

class SpreadsheetView extends LitElement {

    static properties = {
        portfolio: { type: Object },
    };

    createRenderRoot() { return this; }

    constructor() {
        super();
        this.portfolio = null;
    }

    render() {
        if (!this.portfolio) {
            return html`<p style="padding: 24px; font-family: DM Sans, sans-serif;">
                No spreadsheet data available. Run a calculation first.
            </p>`;
        }

        const assetColumns = this._buildAssetColumns();
        if (assetColumns.length === 0) {
            return html`<p style="padding: 24px; font-family: DM Sans, sans-serif;">
                No spreadsheet data available. Run a calculation first.
            </p>`;
        }

        const dateLabels = this._buildDateLabels();

        return html`
            <table class="spreadsheet-table">
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
                    ${dateLabels.map((dateLabel, i) => html`
                        <tr>
                            <td class="spreadsheet-date-col">${dateLabel}</td>
                            ${assetColumns.map(ac => ac.metrics.map(m => {
                                const arr = ac.asset[m.key];
                                const val = (arr && i < arr.length) ? arr[i] : 0;
                                const formatted = val !== 0
                                    ? val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                                    : '\u2014';
                                return html`<td class="${val < 0 ? 'spreadsheet-negative' : ''}">${formatted}</td>`;
                            }))}
                        </tr>
                    `)}
                </tbody>
            </table>
        `;
    }

    _buildAssetColumns() {
        const result = [];
        for (const modelAsset of this.portfolio.modelAssets) {
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

    _buildDateLabels() {
        const { DateInt } = this._getDateInt();
        const labels = [];
        const cursor = new DateInt(this.portfolio.firstDateInt.toInt());
        while (cursor.toInt() <= this.portfolio.lastDateInt.toInt()) {
            labels.push(cursor.toHTML());
            cursor.nextMonth();
        }
        return labels;
    }

    _getDateInt() {
        // Import cached — DateInt is needed for date iteration
        if (!this._dateIntModule) {
            // We import synchronously since the module is already loaded
            this._dateIntModule = { DateInt: this.portfolio.firstDateInt.constructor };
        }
        return this._dateIntModule;
    }
}

customElements.define('spreadsheet-view', SpreadsheetView);
