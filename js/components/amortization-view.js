/**
 * <amortization-view>
 *
 * Lit component that renders a Chart.js mixed chart for mortgage amortization.
 * Shows stacked bars (principal vs interest) and a line for remaining balance.
 *
 * Properties:
 *   portfolio — Portfolio object (after chronometer_run)
 */

import { LitElement, html } from 'lit';
import { Metric } from '../model-asset.js';
import { InstrumentType } from '../instruments/instrument.js';
import { charting_buildDisplayLabels } from '../charting.js';

class AmortizationView extends LitElement {

  static properties = {
    portfolio: { type: Object },
  };

  createRenderRoot() { return this; }

  constructor() {
    super();
    this.portfolio = null;
    this._chart = null;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._destroyChart();
  }

  updated(changed) {
    if (changed.has('portfolio')) {
      this._buildChart();
    }
  }

  _findMortgage() {
    if (!this.portfolio) return null;
    return this.portfolio.modelAssets.find(a => InstrumentType.isMortgage(a.instrument)) ?? null;
  }

  _destroyChart() {
    if (this._chart) {
      this._chart.destroy();
      this._chart = null;
    }
  }

  _buildChart() {
    this._destroyChart();
    const mortgage = this._findMortgage();
    if (!mortgage || !this.portfolio) return;

    const canvas = this.querySelector('#amortizationCanvas');
    if (!canvas) return;

    const labels = charting_buildDisplayLabels(this.portfolio.firstDateInt, this.portfolio.lastDateInt);
    const principal = mortgage.getDisplayHistory(Metric.MORTGAGE_PRINCIPAL);
    const interest = mortgage.getDisplayHistory(Metric.MORTGAGE_INTEREST);
    const balance = mortgage.getDisplayHistory(Metric.VALUE);

    // Balance is stored as negative (liability convention) — flip to positive for display
    const balancePositive = balance.map(v => Math.abs(v));

    this._chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Principal',
            data: principal,
            backgroundColor: 'rgba(59, 130, 246, 0.75)',
            borderRadius: 2,
            stack: 'payment',
            yAxisID: 'y',
            order: 2,
          },
          {
            label: 'Interest',
            data: interest,
            backgroundColor: 'rgba(239, 68, 68, 0.6)',
            borderRadius: 2,
            stack: 'payment',
            yAxisID: 'y',
            order: 2,
          },
          {
            label: 'Remaining Balance',
            data: balancePositive,
            type: 'line',
            borderColor: 'rgba(16, 185, 129, 0.9)',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            fill: true,
            tension: 0.3,
            yAxisID: 'y1',
            order: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          legend: {
            position: 'top',
            labels: { usePointStyle: true, boxWidth: 8, font: { size: 11 } },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const val = ctx.parsed.y;
                return `${ctx.dataset.label}: $${Math.round(val).toLocaleString()}`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { font: { size: 10 }, maxRotation: 45 },
          },
          y: {
            position: 'left',
            stacked: true,
            title: { display: true, text: 'Monthly Payment', font: { size: 11 } },
            ticks: {
              callback: (v) => `$${Math.round(v).toLocaleString()}`,
              font: { size: 10 },
            },
            grid: { color: 'rgba(0,0,0,0.04)' },
          },
          y1: {
            position: 'right',
            title: { display: true, text: 'Remaining Balance', font: { size: 11 } },
            ticks: {
              callback: (v) => {
                if (v >= 1000000) return `$${(v / 1000000).toFixed(1)}M`;
                if (v >= 1000) return `$${Math.round(v / 1000)}K`;
                return `$${Math.round(v)}`;
              },
              font: { size: 10 },
            },
            grid: { drawOnChartArea: false },
          },
        },
      },
    });
  }

  render() {
    const mortgage = this._findMortgage();
    if (!mortgage) {
      return html`<div class="flex items-center justify-center h-full text-gray-400 text-sm">No mortgage in portfolio</div>`;
    }
    return html`
      <div style="width: 100%; height: 100%; position: relative;">
        <canvas id="amortizationCanvas"></canvas>
      </div>
    `;
  }
}

customElements.define('amortization-view', AmortizationView);
