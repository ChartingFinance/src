/**
 * <simulator-modal>
 *
 * Lit component that wraps the genetic algorithm simulator popup.
 * Set `modelAssets` and `open` to launch; dispatches 'close' when dismissed.
 * Manages Chart.js instance and Web Worker lifecycle internally.
 *
 * Properties:
 *   mode: 'maximize' | 'guardrails' | 'both'
 *   guardrailParams: { withdrawalRate, preservation, prosperity, adjustment }
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

const MODE_LABELS = {
    maximize:   'Maximize Value',
    guardrails: 'Optimize Guardrails',
    both:       'Maximize and Optimize',
};

class SimulatorModal extends LitElement {

    static properties = {
        open:             { type: Boolean, reflect: true },
        modelAssets:      { type: Array },
        mode:             { type: String },
        guardrailParams:  { type: Object },
        _status:          { state: true },
        _generation:      { state: true },
        _bestValue:       { state: true },
        _displayAssets:   { state: true },
        _selectedMode:    { state: true },
        _runComplete:     { state: true },
        _fitnessBalance:  { state: true },
    };

    createRenderRoot() { return this; }

    constructor() {
        super();
        this.open = false;
        this.modelAssets = [];
        this.mode = 'maximize';
        this.guardrailParams = null;
        this._status = 'Starting...';
        this._generation = 'Generation 0 / 200';
        this._bestValue = '';
        this._displayAssets = [];
        this._selectedMode = 'maximize';
        this._runComplete = false;
        this._fitnessBalance = 50;
        this._chart = null;
        this._worker = null;
    }

    render() {
        if (!this.open) return html``;

        const modeDisabled = !this._runComplete;
        const showBothWarning = this._selectedMode === 'both';

        return html`
            <div class="sim-overlay" @click=${this._onOverlayClick}>
                <div class="sim-modal" @click=${(e) => e.stopPropagation()}>
                    <div class="sim-header">
                        <span class="sim-title">Simulator</span>
                        <select class="fin-input text-sm font-medium py-1 px-2 rounded-xl"
                            .value=${this._selectedMode}
                            ?disabled=${!this._runComplete}
                            @change=${this._onModeChange}>
                            <option value="maximize">Maximize Value</option>
                            <option value="guardrails" ?disabled=${!this.guardrailParams}>Optimize Guardrails</option>
                            <option value="both" ?disabled=${!this.guardrailParams}>Maximize and Optimize</option>
                        </select>
                        <div class="sim-controls">
                            <span class="sim-status">${this._status}</span>
                            <button class="sim-close-btn" title="Close"
                                @click=${this._close}>&times;</button>
                        </div>
                    </div>
                    ${showBothWarning && this._runComplete ? html`
                        <div class="text-xs text-amber-600 px-4 pt-2 font-medium">
                            This will run both fitness functions sequentially and may take a while.
                            <button class="btn-modern outline small ml-2" @click=${this._startBothRun}>Run</button>
                        </div>
                    ` : html`
                        <div class="text-xs text-gray-400 px-4 pt-2">
                            Results saved as "${this._scenarioLabel}" in the portfolio scenario dropdown.
                        </div>
                    `}
                    ${this._showSlider ? html`
                        <div class="flex items-center gap-3 px-4 pt-2 text-xs">
                            <span class="text-gray-500 font-semibold whitespace-nowrap">Spending</span>
                            <input type="range" min="0" max="100" step="5"
                                .value=${String(this._fitnessBalance)}
                                class="flex-grow"
                                style="accent-color: #333;"
                                @input=${this._onBalanceInput}
                                @change=${this._onBalanceChange}>
                            <span class="text-gray-500 font-semibold whitespace-nowrap">Terminal Value</span>
                        </div>
                    ` : ''}
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

    get _showSlider() {
        return (this._selectedMode === 'guardrails' || this._selectedMode === 'both')
            && this.guardrailParams;
    }

    get _scenarioLabel() {
        if (this._selectedMode === 'maximize') return 'Fittest Value';
        if (this._selectedMode === 'guardrails') return 'Fittest Guardrail';
        return 'Fittest Overall';
    }

    get _scenarioKey() {
        if (this._selectedMode === 'maximize') return 'FittestValue';
        if (this._selectedMode === 'guardrails') return 'FittestGuardrail';
        return 'FittestOverall';
    }

    updated(changed) {
        if (changed.has('open') && this.open) {
            this._selectedMode = this.mode;
            this._runComplete = false;
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

    _onModeChange(e) {
        this._selectedMode = e.target.value;
        if (this._selectedMode !== 'both') {
            this._restartWithMode(this._selectedMode);
        }
    }

    _startBothRun() {
        this._restartWithMode('both');
    }

    _onBalanceInput(e) {
        this._fitnessBalance = parseInt(e.target.value);
    }

    _onBalanceChange() {
        // Re-run with new balance if a run already completed
        if (this._runComplete) {
            this._restartWithMode(this._selectedMode);
        }
    }

    _restartWithMode(mode) {
        this._teardown();
        this._selectedMode = mode;
        this._runComplete = false;
        this._status = 'Starting...';
        this._generation = 'Generation 0 / 200';
        this._bestValue = '';
        requestAnimationFrame(() => this._start());
    }

    _start() {
        const canvas = this.querySelector('canvas');
        if (!canvas) return;

        // Build initial chart from current portfolio
        const portfolio = new Portfolio(this.modelAssets, false);
        chronometer_run(portfolio);
        portfolio.buildChartingDisplayData();
        setModelAssetColorIds(portfolio.modelAssets);

        const chartConfig = charting_buildPortfolioMetric(portfolio, 'value', true);
        const markers = charting_buildDateMarkers(portfolio);
        chartConfig.options.plugins.dateMarkers = { markers };
        chartConfig.options.animation = { duration: 300 };
        chartConfig.options.maintainAspectRatio = false;

        this._chart = new Chart(canvas, chartConfig);
        this._displayAssets = [...portfolio.modelAssets];

        if (!window.Worker) {
            this._status = 'Web Workers not supported';
            return;
        }

        this._worker = new Worker('js/simulator.js', { type: 'module' });

        const workerMode = this._selectedMode;
        const workerPayload = {
            modelAssets: JSON.parse(JSON.stringify(this.modelAssets)),
            mode: workerMode,
            guardrailParams: (workerMode === 'guardrails' || workerMode === 'both')
                ? this.guardrailParams : null,
            fitnessBalance: this._fitnessBalance,
        };
        this._worker.postMessage(workerPayload);

        this._worker.onerror = (err) => {
            console.error('Simulator worker error:', err);
            this._status = 'Error';
        };

        this._pendingBetter = null;
        this._updateTimer = null;
        this._bothPhase = (workerMode === 'both') ? 1 : 0;

        this._worker.onmessage = (event) => {
            const msg = event.data;

            if (msg.action === 'foundBetter') {
                this._pendingBetter = msg.data;

                this.dispatchEvent(new CustomEvent('found-fittest', {
                    bubbles: true, composed: true,
                    detail: { modelAssets: msg.data, scenarioKey: this._scenarioKey },
                }));

                if (!this._updateTimer) {
                    this._updateTimer = setTimeout(() => {
                        this._processPendingBetter();
                        this._updateTimer = null;
                    }, 500);
                }
            }
            else if (msg.action === 'iteration') {
                const match = msg.data.match(/Generation:\s*(\d+)/);
                if (match) {
                    const gen = parseInt(match[1]) + 1;
                    const phaseLabel = this._bothPhase === 1 ? ' (Value)' :
                                       this._bothPhase === 2 ? ' (Guardrails)' : '';
                    this._generation = `Generation ${gen} / 200${phaseLabel}`;
                }
            }
            else if (msg.action === 'phaseComplete') {
                // 'both' mode: first phase done, second phase starting
                this._bothPhase = 2;
                if (this._pendingBetter) this._processPendingBetter();
                this._status = 'Running phase 2...';
            }
            else if (msg.action === 'complete') {
                if (this._pendingBetter) this._processPendingBetter();
                this._status = 'Complete';
                this._generation = 'Generation 200 / 200';
                this._runComplete = true;
            }
        };

        this._status = 'Running...';
    }

    _processPendingBetter() {
        if (!this._pendingBetter || !this._chart) return;
        const data = this._pendingBetter;
        this._pendingBetter = null;

        const assetModels = membrane_jsonObjectsToModelAssets(data);
        const p = new Portfolio(assetModels, false);
        chronometer_run(p);
        p.buildChartingDisplayData();
        setModelAssetColorIds(p.modelAssets);

        const newConfig = charting_buildPortfolioMetric(p, 'value', true);
        const newData = newConfig.data;

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

    _teardown() {
        if (this._updateTimer) {
            clearTimeout(this._updateTimer);
            this._updateTimer = null;
        }
        this._pendingBetter = null;
        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
        }
        if (this._chart) {
            this._chart.destroy();
            this._chart = null;
        }
        this._status = 'Starting...';
        this._generation = 'Generation 0 / 200';
        this._bestValue = '';
        this._displayAssets = [];
    }

    _close() {
        this.open = false;
        this.dispatchEvent(new CustomEvent('close', {
            bubbles: true, composed: true,
            detail: { scenarioKey: this._scenarioKey },
        }));
    }

    _onOverlayClick(ev) {
        if (ev.target === ev.currentTarget) this._close();
    }
}

customElements.define('simulator-modal', SimulatorModal);
