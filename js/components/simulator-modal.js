/**
 * <simulator-modal>
 *
 * Lit component that wraps the genetic algorithm simulator popup.
 * Set `modelAssets` and `open` to launch; dispatches 'close' when dismissed.
 * Manages Chart.js instance and Web Worker lifecycle internally.
 */

import { LitElement, html } from 'lit';
import { membrane_jsonObjectsToModelAssets } from '../membrane.js';
import { chronometer_run } from '../chronometer.js';
import { Portfolio } from '../portfolio.js';
import {
    setModelAssetColorIds,
    charting_buildPortfolioMetric,
    charting_buildDateMarkers,
} from '../charting.js';
import './asset-list.js';

class SimulatorModal extends LitElement {

    static properties = {
        open:         { type: Boolean, reflect: true },
        modelAssets:  { type: Array },
        _status:      { state: true },
        _generation:  { state: true },
        _bestValue:   { state: true },
        _displayAssets: { state: true },
    };

    createRenderRoot() { return this; }

    constructor() {
        super();
        this.open = false;
        this.modelAssets = [];
        this._status = 'Starting...';
        this._generation = 'Generation 0 / 600';
        this._bestValue = '';
        this._displayAssets = [];
        this._chart = null;
        this._worker = null;
    }

    render() {
        if (!this.open) return html``;

        return html`
            <div class="sim-overlay" @click=${this._onOverlayClick}>
                <div class="sim-modal" @click=${(e) => e.stopPropagation()}>
                    <div class="sim-header">
                        <span class="sim-title">Simulator</span>
                        <div class="sim-controls">
                            <span class="sim-status">${this._status}</span>
                            <button class="sim-close-btn" title="Close"
                                @click=${this._close}>&times;</button>
                        </div>
                    </div>
                    <div class="sim-body">
                        <div class="sim-chart-area">
                            <canvas></canvas>
                        </div>
                        <div class="sim-assets-panel">
                            <asset-list class="sim-assets-container assets-container"
                                .modelAssets=${this._displayAssets}
                                readonly></asset-list>
                        </div>
                    </div>
                    <div class="sim-footer">
                        <span class="sim-generation">${this._generation}</span>
                        <span class="sim-best-value">${this._bestValue}</span>
                    </div>
                </div>
            </div>
        `;
    }

    updated(changed) {
        if (changed.has('open') && this.open) {
            // Wait one frame for the canvas to be in the DOM
            requestAnimationFrame(() => this._start());
        }
        if (changed.has('open') && !this.open) {
            this._teardown();
        }
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this._teardown();
    }

    // ── Private ──────────────────────────────────────────────────

    _start() {
        const canvas = this.querySelector('canvas');
        if (!canvas) return;

        // Build initial chart from current portfolio
        const portfolio = new Portfolio(this.modelAssets, false);
        chronometer_run(null, portfolio);
        portfolio.buildChartingDisplayData();
        setModelAssetColorIds(portfolio.modelAssets);

        const chartConfig = charting_buildPortfolioMetric(portfolio, 'value', true);
        const markers = charting_buildDateMarkers(portfolio);
        chartConfig.options.plugins.dateMarkers = { markers };
        chartConfig.options.animation = { duration: 300 };

        this._chart = new Chart(canvas, chartConfig);
        this._displayAssets = [...portfolio.modelAssets];

        // Launch the Web Worker
        if (!window.Worker) {
            this._status = 'Web Workers not supported';
            return;
        }

        this._worker = new Worker('js/simulator.js', { type: 'module' });

        // Serialize to plain JSON — ModelAsset instances may contain circular refs
        this._worker.postMessage(JSON.parse(JSON.stringify(this.modelAssets)));

        this._worker.onerror = (err) => {
            console.error('Simulator worker error:', err);
            this._status = 'Error';
        };

        this._worker.onmessage = (event) => {
            const msg = event.data;

            if (msg.action === 'foundBetter') {
                const assetModels = membrane_jsonObjectsToModelAssets(msg.data);
                const p = new Portfolio(assetModels, false);
                chronometer_run(null, p);
                p.buildChartingDisplayData();
                setModelAssetColorIds(p.modelAssets);

                const newConfig = charting_buildPortfolioMetric(p, 'value', true);
                const newData = newConfig.data;

                // Update chart datasets in-place for smooth animation
                for (let i = 0; i < newData.datasets.length; i++) {
                    if (i < this._chart.data.datasets.length) {
                        this._chart.data.datasets[i].data = newData.datasets[i].data;
                        this._chart.data.datasets[i].backgroundColor = newData.datasets[i].backgroundColor;
                    } else {
                        this._chart.data.datasets.push(newData.datasets[i]);
                    }
                }
                this._chart.data.datasets.length = newData.datasets.length;
                this._chart.data.labels = newData.labels;
                this._chart.update();

                this._displayAssets = [...p.modelAssets];

                const bestVal = p.finishValue().amount;
                this._bestValue = 'Best: $' + bestVal.toLocaleString(undefined, {
                    minimumFractionDigits: 0, maximumFractionDigits: 0
                });
            }
            else if (msg.action === 'iteration') {
                const match = msg.data.match(/Generation:\s*(\d+)/);
                if (match) {
                    this._generation = 'Generation ' + (parseInt(match[1]) + 1) + ' / 600';
                }
            }
            else if (msg.action === 'complete') {
                this._status = 'Complete';
                this._generation = 'Generation 600 / 600';
            }
        };

        this._status = 'Running...';
    }

    _teardown() {
        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
        }
        if (this._chart) {
            this._chart.destroy();
            this._chart = null;
        }
        this._status = 'Starting...';
        this._generation = 'Generation 0 / 600';
        this._bestValue = '';
        this._displayAssets = [];
    }

    _close() {
        this.open = false;
        this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
    }

    _onOverlayClick(ev) {
        if (ev.target === ev.currentTarget) this._close();
    }
}

customElements.define('simulator-modal', SimulatorModal);
