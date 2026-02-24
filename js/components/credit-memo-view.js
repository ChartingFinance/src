/**
 * <credit-memo-view>
 *
 * Lit component that renders credit memos across all assets,
 * sorted chronologically with date and asset columns.
 * Receives a `portfolio` object as a property.
 */

import { LitElement, html } from 'lit';

class CreditMemoView extends LitElement {

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
                No credit memos recorded. Run a calculation first.
            </p>`;
        }

        const rows = this._collectRows();
        if (rows.length === 0) {
            return html`<p style="padding: 24px; font-family: DM Sans, sans-serif;">
                No credit memos recorded. Run a calculation first.
            </p>`;
        }

        return html`
            <table class="spreadsheet-table">
                <thead>
                    <tr>
                        <th class="spreadsheet-date-col">Date</th>
                        <th class="spreadsheet-asset-header">Asset</th>
                        <th class="spreadsheet-metric-header">Amount</th>
                        <th class="spreadsheet-metric-header">Note</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(row => {
                        const dateStr = row.dateInt ? row.dateInt.toHTML() : '\u2014';
                        const val = row.amount ? row.amount.amount : 0;
                        const formatted = val !== 0
                            ? val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                            : '\u2014';
                        return html`
                            <tr>
                                <td class="spreadsheet-date-col">${dateStr}</td>
                                <td>${row.asset}</td>
                                <td class="${val < 0 ? 'spreadsheet-negative' : ''}">${formatted}</td>
                                <td>${row.note || ''}</td>
                            </tr>
                        `;
                    })}
                </tbody>
            </table>
        `;
    }

    _collectRows() {
        const rows = [];
        for (const modelAsset of this.portfolio.modelAssets) {
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

        rows.sort((a, b) => {
            const da = a.dateInt ? a.dateInt.toInt() : 0;
            const db = b.dateInt ? b.dateInt.toInt() : 0;
            if (da !== db) return da - db;
            return a.asset.localeCompare(b.asset);
        });

        return rows;
    }
}

customElements.define('credit-memo-view', CreditMemoView);
