/**
 * <credit-memo-view>
 *
 * Lit component for the Ledger / Credit Memos detail tab. Renders all recorded
 * credit memos across every asset in chronological order with Date, Asset,
 * Amount, and Note columns, distinguishing informational NON-CASH entries from
 * cash-moving transactions.
 *
 * Properties:
 *   portfolio - simulated Portfolio containing assets with creditMemos[]
 *
 * Methods:
 *   scrollToDate(year, month) - scrolls to and briefly highlights the first entry for that month
 */

import { LitElement, html, nothing } from 'lit';
import { formatCurrency } from '../utils/html.js';
import { visibleWindow, rowScrollTop, DEFAULT_ROW_HEIGHT } from '../utils/virtual-window.js';

const FALLBACK_VIEWPORT = 440;

class CreditMemoView extends LitElement {

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
        this._rows = [];
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
        if (!this._measured && this._rows.length > 0) {
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
        return visibleWindow(this._rows.length, scrollTop, viewH, {
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
                No credit memos recorded. Run a calculation first.
            </p>`;
        }

        if (this._rows.length === 0) {
            return html`<p class="vt-empty">
                No credit memos recorded. Run a calculation first.
            </p>`;
        }

        const { start, end, topPad, bottomPad } = this._computeWindow(this._scrollTop);
        const visible = [];
        for (let i = start; i < end; i++) {
            const row = this._rows[i];
            const dateStr = row.dateInt ? row.dateInt.toHTML() : '\u2014';
            const val = row.amount ? row.amount.amount : 0;
            const formatted = val !== 0 ? formatCurrency(val, { cents: true }) : '\u2014';
            // Info memos (gain recognition, attributed costs, escrow
            // accruals) moved no cash on this asset — mute the amount
            // and badge them so the ledger visibly reconciles.
            const isInfo = row.kind === 'info';
            const amtClass = isInfo ? 'cm-info' : (val < 0 ? 'spreadsheet-negative' : '');
            visible.push(html`
                <tr data-row="${i}" class="${i === this._highlightIdx ? 'vt-flash' : ''}">
                    <td class="spreadsheet-date-col">${dateStr}</td>
                    <td>${row.asset}</td>
                    <td class="${amtClass}">${formatted}</td>
                    <td>${row.note || ''}${isInfo ? html` <span class="cm-noncash"
                        title="Recognition or attribution entry \u2014 no cash moved on this asset. Excluded from cash reconciliation.">NON-CASH</span>` : nothing}</td>
                </tr>
            `);
        }

        return html`
            <table class="spreadsheet-table vt-table cm-table">
                <thead>
                    <tr>
                        <th class="spreadsheet-date-col cm-col-date">Date</th>
                        <th class="spreadsheet-asset-header cm-col-asset">Asset</th>
                        <th class="spreadsheet-metric-header cm-col-amount">Amount</th>
                        <th class="spreadsheet-metric-header">Note</th>
                    </tr>
                </thead>
                <tbody>
                    ${topPad > 0 ? html`<tr class="vt-spacer" aria-hidden="true"><td colspan="4" style="height:${topPad}px"></td></tr>` : nothing}
                    ${visible}
                    ${bottomPad > 0 ? html`<tr class="vt-spacer" aria-hidden="true"><td colspan="4" style="height:${bottomPad}px"></td></tr>` : nothing}
                </tbody>
            </table>
        `;
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

    _rebuildCache() {
        this._rows = this._collectRows();
        this._dateIndex = new Map();
        for (let i = 0; i < this._rows.length; i++) {
            const d = this._rows[i].dateInt;
            if (!d) continue;
            const key = d.toHTML();
            if (!this._dateIndex.has(key)) this._dateIndex.set(key, i);
        }
    }

    _collectRows() {
        if (!this.portfolio) return [];
        const rows = [];
        for (const modelAsset of this.portfolio.modelAssets) {
            if (!modelAsset.creditMemos || modelAsset.creditMemos.length === 0) continue;
            for (const memo of modelAsset.creditMemos) {
                rows.push({
                    dateInt: memo.dateInt,
                    asset: modelAsset.displayName,
                    amount: memo.amount,
                    note: memo.note,
                    kind: memo.kind,
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
