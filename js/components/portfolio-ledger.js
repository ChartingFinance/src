/**
 * <portfolio-ledger>
 *
 * Lit component that displays the portfolio summary ledger.
 * Receives a `portfolio` object after chronometer_run and renders
 * the opening/closing/growth metrics directly — no hidden form inputs.
 */

import { LitElement, html } from 'lit';
import { Metric, MetricLabel } from '../model-asset.js';

class PortfolioLedger extends LitElement {

    static properties = {
        portfolio:  { type: Object },
        metricName: { type: String },
    };

    createRenderRoot() { return this; }

    constructor() {
        super();
        this.portfolio = null;
        this.metricName = Metric.VALUE;
    }

    render() {
        const p = this.portfolio;

        const startDate = p ? this._formatDate(p.firstDateInt) : '\u2014';
        const finishDate = p ? this._formatDate(p.lastDateInt) : '\u2014';

        const metricLabel = MetricLabel[this.metricName] || 'Value';
        const startMetric = p ? this._computeMetricAtIndex(p, this.metricName, 0) : 0;
        const finishMetric = p ? this._computeMetricAtIndex(p, this.metricName, -1) : 0;
        const startMetricDisplay = this._formatCurrency(startMetric);
        const finishMetricDisplay = this._formatCurrency(finishMetric);
        const annualReturn = p ? this._computeCAGR(startMetric, finishMetric, p) : 0;
        const cagrPositive = annualReturn >= 0;

        return html`
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">

                <!-- Opening -->
                <div class="glass-card p-6 bg-slate-100 border-slate-200">
                    <div class="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4">Opening Chapter</div>
                    <div class="space-y-3">
                        <div class="flex justify-between items-center pb-2 border-b border-slate-200">
                            <span class="text-sm text-slate-500">Start Date</span>
                            <span class="font-semibold text-slate-800">${startDate}</span>
                        </div>
                        <div class="flex justify-between items-center pt-2">
                            <span class="text-sm text-slate-500">Starting ${metricLabel}</span>
                            <span class="font-semibold text-slate-800">${startMetricDisplay}</span>
                        </div>
                    </div>
                </div>

                <!-- Closing -->
                <div class="glass-card p-6 bg-slate-100 border-slate-200">
                    <div class="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4">Closing Chapter</div>
                    <div class="space-y-3">
                        <div class="flex justify-between items-center pb-2 border-b border-slate-200">
                            <span class="text-sm text-slate-500">Finish Date</span>
                            <span class="font-semibold text-slate-800">${finishDate}</span>
                        </div>
                        <div class="flex justify-between items-center pt-2">
                            <span class="text-sm text-slate-500">Finishing ${metricLabel}</span>
                            <span class="font-semibold text-slate-800">${finishMetricDisplay}</span>
                        </div>
                    </div>
                </div>

                <!-- CAGR -->
                <div class="glass-card p-6 bg-gradient-to-br ${cagrPositive ? 'from-green-50 border-green-100' : 'from-pink-50 border-pink-100'} to-white">
                    <div class="flex flex-col items-center justify-center h-full">
                        <span class="text-4xl font-bold ${cagrPositive ? 'text-green-600' : 'text-pink-600'}">CAGR</span>
                        <span class="text-4xl font-bold ${cagrPositive ? 'text-green-600' : 'text-pink-600'}">${annualReturn.toFixed(2)}%</span>
                    </div>
                </div>

            </div>
        `;
    }

    _formatCurrency(amount) {
        const val = parseFloat(amount) || 0;
        return `$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    _formatDate(dateInt) {
        if (!dateInt) return '\u2014';
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];
        return `${monthNames[dateInt.month - 1]} ${dateInt.year}`;
    }

    _computeMetricAtIndex(portfolio, metricName, index) {
        let total = 0;
        for (const asset of portfolio.modelAssets) {
            const history = asset.getHistory(metricName);
            if (history?.length > 0) {
                const i = index < 0 ? history.length + index : index;
                total += history[i] ?? 0;
            }
        }
        return total;
    }

    _computeCAGR(startVal, finishVal, portfolio) {
        const start = portfolio.firstDateInt;
        const finish = portfolio.lastDateInt;
        if (!startVal || startVal === 0 || !start || !finish) return 0;
        const years = (finish.year + (finish.month - 1) / 12) - (start.year + (start.month - 1) / 12);
        if (years <= 0) return 0;
        return (Math.pow(finishVal / startVal, 1 / years) - 1) * 100;
    }
}

customElements.define('portfolio-ledger', PortfolioLedger);
