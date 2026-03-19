/**
 * <transfer-modal>
 *
 * Lit component for managing fund transfers between assets.
 * Shows tabbed charts for the selected asset and transferrable asset cards.
 *
 * Properties:
 *   open             - boolean
 *   currentDisplayName - string (name of the asset to configure transfers for)
 *   modelAssets      - ModelAsset[] (all assets)
 *
 * Dispatches:
 *   'save-transfers' { detail: { displayName, fundTransfers } }
 *   'close'
 */

import { LitElement, html } from 'lit';
import { InstrumentType, InstrumentMeta } from '../instruments/instrument.js';
import { FundTransfer, Frequency } from '../fund-transfer.js';
import { colorRange } from '../utils/html.js';
import { chronometer_run } from '../chronometer.js';
import { Portfolio } from '../portfolio.js';
import { findByName } from '../asset-queries.js';
import { Metric } from '../metric.js';
import {
    charting_buildFromModelAsset,
    charting_jsonMetricChartConfigIndividual,
} from '../charting.js';

class TransferModal extends LitElement {

    static properties = {
        open:               { type: Boolean, reflect: true },
        currentDisplayName: { type: String },
        modelAssets:        { type: Array },
        phaseTransfers:     { type: Object },
        _activeTab:         { state: true },
    };

    createRenderRoot() { return this; }

    constructor() {
        super();
        this.open = false;
        this.currentDisplayName = '';
        this.modelAssets = [];
        this.phaseTransfers = {};
        this._activeTab = 0;
        this._chart = null;
        this._portfolio = null;
        this._tabs = [];
    }

    render() {
        if (!this.open || !this.currentDisplayName) return html``;

        const transferrableAssets = this._getTransferrableAssets();

        return html`
            <div class="popup fixed inset-0 z-50 flex items-center justify-center p-4"
                 @click=${this._onOverlayClick}>
                <div class="popup-content glass-card p-8 w-full max-w-4xl relative"
                     @click=${(e) => e.stopPropagation()}>
                    <button class="closeBtn absolute top-4 right-4 text-gray-400 hover:text-gray-800 text-2xl"
                        @click=${this._close}>&times;</button>
                    <div class="flex flex-col md:flex-row gap-8 mt-4">
                        <div class="flex-1">
                            <h3 class="text-lg font-bold mb-4">${this.currentDisplayName}</h3>
                            ${this._tabs.length > 1 ? html`
                                <div class="flex flex-wrap gap-2 mb-4 bg-gray-50 p-1 rounded-xl w-max">
                                    ${this._tabs.map((tab, i) => html`
                                        <button class="chart-tab px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-900 transition rounded-xl ${this._activeTab === i ? 'active' : ''}"
                                            @click=${() => this._switchTab(i)}>${tab.label}</button>
                                    `)}
                                </div>
                            ` : html``}
                            <div class="bg-gray-50 rounded-2xl p-4 border border-gray-100">
                                <canvas id="chart-canvas"></canvas>
                            </div>
                        </div>
                        <div class="flex-1">
                            <h3 class="text-lg font-bold mb-4 flex items-center gap-2">
                                &#x1F504; Transferrable Cards
                            </h3>
                            <div class="scrollable-y overflow-y-auto max-h-[400px] pr-2 space-y-3">
                                ${transferrableAssets.map(ta => this._renderTransferCard(ta))}
                            </div>
                        </div>
                    </div>
                    <div class="text-center pt-6 mt-6 border-t border-gray-100">
                        <button class="btn-modern primary" @click=${this._onSave}>Save Transfers</button>
                    </div>
                </div>
            </div>
        `;
    }

    updated(changed) {
        if (changed.has('open') && this.open) {
            this._activeTab = 0;
            requestAnimationFrame(() => this._buildChart());
        }
        if (changed.has('open') && !this.open) {
            this._teardownChart();
        }
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this._teardownChart();
    }

    _getChartTabs(currentAsset) {
        if (!currentAsset) return [{ label: 'Growth', metric: Metric.CASH_FLOW }];

        if (InstrumentType.isRealEstate(currentAsset.instrument)) {
            return [
                { label: 'Growth', metric: Metric.CASH_FLOW },
                { label: 'Expenses', metric: Metric.PROPERTY_TAX },
            ];
        }
        if (InstrumentType.isMonthlyIncome(currentAsset.instrument)) {
            return [{ label: 'Income', metric: Metric.CASH_FLOW }];
        }
        if (InstrumentType.isMonthlyExpense(currentAsset.instrument)) {
            return [{ label: 'Expenses', metric: Metric.EXPENSE }];
        }
        return [{ label: 'Growth', metric: Metric.CASH_FLOW }];
    }

    _getTransferrableAssets() {
        if (!this._portfolio) {
            this._portfolio = new Portfolio(this.modelAssets, false);
            chronometer_run(this._portfolio);
            this._portfolio.buildChartingDisplayData();
        }

        const currentAsset = findByName(this._portfolio.modelAssets, this.currentDisplayName);
        if (!currentAsset) return [];

        this._tabs = this._getChartTabs(currentAsset);

        // Look up existing transfers from the active phase
        const existingTransfers = this.phaseTransfers[this.currentDisplayName] || [];

        return this._portfolio.modelAssets.filter(ma =>
            InstrumentType.isFundable(ma.instrument) &&
            ma.displayName !== this.currentDisplayName
        ).map(ma => {
            const existing = existingTransfers.find(
                ft => (ft.toDisplayName ?? ft.toDisplayName) === ma.displayName
            );
            return {
                modelAsset: ma,
                monthlyMoveValue: existing ? existing.monthlyMoveValue : 0,
                closeMoveValue: existing ? existing.closeMoveValue : 0,
            };
        });
    }

    _renderTransferCard(ta) {
        const ma = ta.modelAsset;
        const color = colorRange[ma.colorId] || colorRange[0];
        const meta = InstrumentMeta.get(ma.instrument);
        const emoji = meta ? meta.emoji : '';
        const label = meta ? meta.label : '';
        return html`
            <form class="fund-transfer glass-card p-4" style="border-left: 4px solid ${color}">
                <div class="flex items-center gap-3 mb-3">
                    <div class="text-2xl">${emoji}</div>
                    <div class="flex-1 min-w-0">
                        <div class="text-sm font-semibold text-gray-800 truncate">${ma.displayName}</div>
                        <div class="text-xs text-gray-400">${label}</div>
                    </div>
                    <div class="text-sm font-semibold text-gray-600 whitespace-nowrap">${ma.startCurrency.toString()}</div>
                </div>
                <input type="hidden" name="toDisplayName" .value=${ma.displayName} />
                <div class="flex items-center gap-4 mb-2">
                    <div class="flex flex-col ml-auto">
                        <label class="text-xs text-gray-400 mb-1">Monthly %</label>
                        <input type="number" class="fin-input w-20 text-center text-sm"
                            name="monthlyMoveValue" .value=${String(ta.monthlyMoveValue)} step="0.1" />
                    </div>
                </div>
                <div class="flex items-center gap-4">
                    <div class="flex flex-col ml-auto">
                        <label class="text-xs text-gray-400 mb-1">Close %</label>
                        <input type="number" class="fin-input w-20 text-center text-sm"
                            name="closeMoveValue" .value=${String(ta.closeMoveValue)} step="0.1" />
                    </div>
                </div>
            </form>
        `;
    }

    _switchTab(index) {
        if (index === this._activeTab) return;
        this._activeTab = index;
        this._renderActiveChart();
    }

    _renderActiveChart() {
        const canvas = this.querySelector('#chart-canvas');
        if (!canvas || !this._portfolio || !this._tabs.length) return;

        if (this._chart) {
            this._chart.destroy();
            this._chart = null;
        }

        const tab = this._tabs[this._activeTab];
        charting_buildFromModelAsset(this._portfolio, this.currentDisplayName, tab.metric);
        if (charting_jsonMetricChartConfigIndividual != null) {
            this._chart = new Chart(canvas, charting_jsonMetricChartConfigIndividual);
        }
    }

    _buildChart() {
        this._portfolio = new Portfolio(this.modelAssets, false);
        chronometer_run(this._portfolio);
        this._portfolio.buildChartingDisplayData();

        const currentAsset = findByName(this._portfolio.modelAssets, this.currentDisplayName);
        this._tabs = this._getChartTabs(currentAsset);

        this._renderActiveChart();
    }

    _teardownChart() {
        if (this._chart) {
            this._chart.destroy();
            this._chart = null;
        }
        this._portfolio = null;
        this._tabs = [];
    }

    _onSave() {
        const forms = this.querySelectorAll('.fund-transfer');
        const fundTransfers = [];

        for (const form of forms) {
            const toDisplayName = form.querySelector('[name="toDisplayName"]').value;
            const monthlyMoveValue = parseInt(form.querySelector('[name="monthlyMoveValue"]').value, 10) || 0;
            const closeMoveValue = parseInt(form.querySelector('[name="closeMoveValue"]').value, 10) || 0;

            if (monthlyMoveValue > 0 || closeMoveValue > 0) {
                fundTransfers.push(new FundTransfer(toDisplayName, Frequency.MONTHLY, monthlyMoveValue, closeMoveValue));
            }
        }

        this.dispatchEvent(new CustomEvent('save-transfers', {
            bubbles: true, composed: true,
            detail: {
                displayName: this.currentDisplayName,
                fundTransfers,
            },
        }));

        this._close();
    }

    _close() {
        this.open = false;
        this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
    }

    _onOverlayClick(ev) {
        if (ev.target === ev.currentTarget) this._close();
    }
}

customElements.define('transfer-modal', TransferModal);
