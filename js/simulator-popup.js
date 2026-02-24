/**
 * simulator-popup.js
 *
 * Modal popup that runs the genetic algorithm and displays a live-updating
 * Value chart as the GA finds better portfolio configurations.
 */

import { membrane_jsonObjectsToModelAssets } from './membrane.js';
import { chronometer_run } from './chronometer.js';
import { Portfolio } from './portfolio.js';
import {
    setModelAssetColorIds,
    charting_buildPortfolioMetric,
    charting_buildDateMarkers,
} from './charting.js';
import './components/asset-list.js';

let overlayElement = null;
let simChart = null;
let worker = null;

export function openSimulatorPopup(modelAssets) {
    if (overlayElement) return; // already open

    // Build the modal DOM
    overlayElement = document.createElement('div');
    overlayElement.className = 'sim-overlay';
    overlayElement.innerHTML = `
        <div class="sim-modal">
            <div class="sim-header">
                <span class="sim-title">Simulator</span>
                <div class="sim-controls">
                    <span class="sim-status">Starting...</span>
                    <button class="sim-close-btn" title="Close">&times;</button>
                </div>
            </div>
            <div class="sim-body">
                <div class="sim-chart-area">
                    <canvas id="simChart"></canvas>
                </div>
                <div class="sim-assets-panel">
                    <asset-list class="sim-assets-container assets-container" readonly></asset-list>
                </div>
            </div>
            <div class="sim-footer">
                <span class="sim-generation">Generation 0 / 600</span>
                <span class="sim-best-value"></span>
            </div>
        </div>
    `;

    document.documentElement.appendChild(overlayElement);

    // Close button
    overlayElement.querySelector('.sim-close-btn').addEventListener('click', closeSimulatorPopup);

    // Close on overlay click (outside modal)
    overlayElement.addEventListener('click', (ev) => {
        if (ev.target === overlayElement) closeSimulatorPopup();
    });

    // Build initial chart from current portfolio
    let portfolio = new Portfolio(modelAssets, false);
    chronometer_run(null, portfolio);
    portfolio.buildChartingDisplayData();
    setModelAssetColorIds(portfolio.modelAssets);
    let chartConfig = charting_buildPortfolioMetric(portfolio, 'value', true);
    const markers = charting_buildDateMarkers(portfolio);
    chartConfig.options.plugins.dateMarkers = { markers };
    chartConfig.options.animation = { duration: 300 };

    const canvas = overlayElement.querySelector('#simChart');
    simChart = new Chart(canvas, chartConfig);

    // Populate initial asset cards
    const assetListEl = overlayElement.querySelector('asset-list');
    assetListEl.modelAssets = [...portfolio.modelAssets];

    // Launch the Web Worker
    if (!window.Worker) {
        updateStatus('Web Workers not supported');
        return;
    }

    worker = new Worker('js/simulator.js', { type: 'module' });

    // Serialize to plain JSON objects — ModelAsset instances after chronometer_run
    // contain circular refs (FundTransfer.fromModel/toModel) and heavy computed data.
    // The worker reconstructs via ModelAsset.fromJSON().
    worker.postMessage(JSON.parse(JSON.stringify(modelAssets)));

    worker.onerror = function(err) {
        console.error('Simulator worker error:', err);
        updateStatus('Error');
    };

    worker.onmessage = function(event) {
        const msg = event.data;

        if (msg.action === 'foundBetter') {
            let assetModels = membrane_jsonObjectsToModelAssets(msg.data);
            let p = new Portfolio(assetModels, false);
            chronometer_run(null, p);
            p.buildChartingDisplayData();
            setModelAssetColorIds(p.modelAssets);

            let newConfig = charting_buildPortfolioMetric(p, 'value', true);
            let newData = newConfig.data;

            // Update existing datasets in-place so Chart.js can animate the transition
            for (let i = 0; i < newData.datasets.length; i++) {
                if (i < simChart.data.datasets.length) {
                    simChart.data.datasets[i].data = newData.datasets[i].data;
                    simChart.data.datasets[i].backgroundColor = newData.datasets[i].backgroundColor;
                } else {
                    simChart.data.datasets.push(newData.datasets[i]);
                }
            }
            // Remove extra datasets if the new config has fewer
            simChart.data.datasets.length = newData.datasets.length;
            simChart.data.labels = newData.labels;
            simChart.update();

            // Update asset cards
            const al = overlayElement.querySelector('asset-list');
            if (al) {
                al.modelAssets = [...p.modelAssets];
            }

            // Update best value display
            const bestVal = p.finishValue().amount;
            const formatted = bestVal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
            updateBestValue('Best: $' + formatted);
        }
        else if (msg.action === 'iteration') {
            // Extract generation number from "Generation: N\n..."
            const match = msg.data.match(/Generation:\s*(\d+)/);
            if (match) {
                const gen = parseInt(match[1]);
                updateGeneration('Generation ' + (gen + 1) + ' / 600');
            }
        }
        else if (msg.action === 'complete') {
            updateStatus('Complete');
            updateGeneration('Generation 600 / 600');
        }
    };

    updateStatus('Running...');
}

export function closeSimulatorPopup() {
    if (worker) {
        worker.terminate();
        worker = null;
    }
    if (simChart) {
        simChart.destroy();
        simChart = null;
    }
    if (overlayElement) {
        overlayElement.remove();
        overlayElement = null;
    }
}

function updateStatus(text) {
    if (!overlayElement) return;
    const el = overlayElement.querySelector('.sim-status');
    if (el) el.textContent = text;
}

function updateGeneration(text) {
    if (!overlayElement) return;
    const el = overlayElement.querySelector('.sim-generation');
    if (el) el.textContent = text;
}

function updateBestValue(text) {
    if (!overlayElement) return;
    const el = overlayElement.querySelector('.sim-best-value');
    if (el) el.textContent = text;
}
