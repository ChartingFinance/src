/**
 * <portfolio-ledger>
 *
 * Lit component that displays the portfolio summary ledger.
 * Receives a `portfolio` object after chronometer_run and renders
 * the opening/closing/growth metrics directly — no hidden form inputs.
 */

import { LitElement, html } from 'lit';

class PortfolioLedger extends LitElement {

    static properties = {
        portfolio: { type: Object },
    };

    createRenderRoot() { return this; }

    constructor() {
        super();
        this.portfolio = null;
    }

    render() {
        const p = this.portfolio;

        const startDate = p ? this._formatDate(p.firstDateInt) : '\u2014';
        const finishDate = p ? this._formatDate(p.lastDateInt) : '\u2014';
        const startValue = p ? this._formatCurrency(p.startValue().amount) : '$0.00';
        const finishValue = p ? this._formatCurrency(p.finishValue().amount) : '$0.00';
        const accumulated = p ? p.accumulatedValue().amount : 0;
        const totalMonths = p ? p.totalMonths : 0;
        const annualReturn = p ? this._computeCAGR(p) : 0;

        const accFormatted = this._formatCurrency(Math.abs(accumulated));
        const accDisplay = accumulated >= 0
            ? `+${accFormatted.substring(1)}`
            : `-${accFormatted.substring(1)}`;

        const valClass = accumulated > 0 ? 'val-positive'
            : accumulated < 0 ? 'val-negative' : 'val-neutral';

        return html`
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">

                <!-- Opening -->
                <div class="glass-card p-6 bg-gradient-to-br from-gray-50 to-white">
                    <div class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4">Opening Chapter</div>
                    <div class="space-y-3">
                        <div class="flex justify-between items-center pb-2 border-b border-gray-100">
                            <span class="text-sm text-gray-500">Start Date</span>
                            <span class="font-semibold text-gray-800">${startDate}</span>
                        </div>
                        <div class="flex justify-between items-center pb-2 border-b border-gray-100">
                            <span class="text-sm text-gray-500">Starting Capital</span>
                            <span class="font-semibold text-gray-800">${startValue}</span>
                        </div>
                        <div class="flex justify-between items-end pt-2">
                            <span class="text-sm font-medium text-gray-600">Lifetime Contributions</span>
                            <span class="text-2xl font-bold text-gray-900">${startValue}</span>
                        </div>
                    </div>
                </div>

                <!-- Closing -->
                <div class="glass-card p-6 bg-gradient-to-br from-purple-50 to-white border-purple-100">
                    <div class="text-xs font-bold text-purple-400 uppercase tracking-widest mb-4">Closing Chapter</div>
                    <div class="space-y-3">
                        <div class="flex justify-between items-center pb-2 border-b border-purple-100/50">
                            <span class="text-sm text-gray-500">Finish Date</span>
                            <span class="font-semibold text-gray-800">${finishDate}</span>
                        </div>
                        <div class="flex justify-between items-center pb-2 border-b border-purple-100/50">
                            <span class="text-sm text-gray-500">Total Value Created</span>
                            <span class="font-semibold text-gray-800 ledger-item-value ${valClass}">${finishValue}</span>
                        </div>
                        <div class="flex justify-between items-end pt-2">
                            <span class="text-sm font-medium text-purple-700">Closing Position</span>
                            <span class="text-2xl font-bold text-purple-900 ledger-item-value total ${valClass}">${finishValue}</span>
                        </div>
                    </div>
                </div>

                <!-- Growth -->
                <div class="glass-card p-6 bg-gradient-to-br from-pink-50 to-white border-pink-100">
                    <div class="text-xs font-bold text-pink-400 uppercase tracking-widest mb-4">Growth Metrics</div>
                    <div class="space-y-3">
                        <div class="flex justify-between items-center pb-2 border-b border-pink-100/50">
                            <span class="text-sm text-gray-500">Duration</span>
                            <span class="font-semibold text-gray-800">${totalMonths} months</span>
                        </div>
                        <div class="flex justify-between items-center pb-2 border-b border-pink-100/50">
                            <span class="text-sm text-gray-500">Accumulated</span>
                            <span class="font-semibold text-gray-800 ledger-item-value ${valClass}">${accDisplay}</span>
                        </div>
                        <div class="flex justify-between items-end pt-2">
                            <span class="text-sm font-medium text-pink-700">CAGR</span>
                            <span class="text-2xl font-bold text-pink-600 ledger-item-value total ${valClass}">${annualReturn.toFixed(2)}%</span>
                        </div>
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

    _computeCAGR(portfolio) {
        const sv = portfolio.startValue().amount;
        const fv = portfolio.finishValue().amount;
        const months = portfolio.totalMonths;
        if (!sv || !months || sv === 0) return 0;
        const years = months / 12;
        return (Math.pow(fv / sv, 1 / years) - 1) * 100;
    }
}

customElements.define('portfolio-ledger', PortfolioLedger);
