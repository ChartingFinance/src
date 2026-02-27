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
        const totalCashFlow = p ? p.total.cashFlow().amount : 0;
        const totalExpenses = p ? p.total.expense.amount + p.total.totalTaxes().amount + p.total.mortgageInterest.amount : 0;
        const accumulated = p ? p.accumulatedValue().amount : 0;
        const annualReturn = p ? this._computeCAGR(p) : 0;

        const totalCashFlowFormatted = this._formatCurrency(Math.abs(totalCashFlow));
        const totalCashFlowDisplay = totalCashFlow >= 0
            ? `+${totalCashFlowFormatted.substring(1)}`
            : `-${totalCashFlowFormatted.substring(1)}`;

        const totalExpensesDisplay = this._formatCurrency(Math.abs(totalExpenses));

        const accFormatted = this._formatCurrency(Math.abs(accumulated));
        const accDisplay = accumulated >= 0
            ? `+${accFormatted.substring(1)}`
            : `-${accFormatted.substring(1)}`;

        const valClass = accumulated > 0 ? 'val-positive'
            : accumulated < 0 ? 'val-negative' : 'val-neutral';

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
                        <div class="flex justify-between items-center pb-2 border-b border-slate-200">
                            <span class="text-sm text-slate-500">Starting Capital</span>
                            <span class="font-semibold text-slate-800">${startValue}</span>
                        </div>
                        <div class="flex justify-between items-end pt-2">
                            <span class="text-sm font-medium text-slate-600">Lifetime Contributions</span>
                            <span class="text-2xl font-bold text-slate-900">${startValue}</span>
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
                        <div class="flex justify-between items-center pb-2 border-b border-slate-200">
                            <span class="text-sm text-slate-500">Total Cash Flow</span>
                            <span class="font-semibold text-slate-800 ledger-item-value ${valClass}">${totalCashFlowDisplay}</span>
                        </div>
                        <div class="flex justify-between items-end pt-2">
                            <span class="text-sm font-medium text-slate-600">Closing Position</span>
                            <span class="text-2xl font-bold text-slate-900 ledger-item-value total ${valClass}">${finishValue}</span>
                        </div>
                    </div>
                </div>

                <!-- Growth -->
                <div class="glass-card p-6 bg-gradient-to-br ${accumulated >= 0 ? 'from-green-50 border-green-100' : 'from-pink-50 border-pink-100'} to-white">
                    <div class="text-xs font-bold ${accumulated >= 0 ? 'text-green-500' : 'text-pink-400'} uppercase tracking-widest mb-4">Growth Metrics</div>
                    <div class="space-y-3">
                        <div class="flex justify-between items-center pb-2 border-b ${accumulated >= 0 ? 'border-green-100/50' : 'border-pink-100/50'}">
                            <span class="text-sm text-gray-500">Total Expenses</span>
                            <span class="font-semibold text-gray-800">${totalExpensesDisplay}</span>
                        </div>
                        <div class="flex justify-between items-center pb-2 border-b ${accumulated >= 0 ? 'border-green-100/50' : 'border-pink-100/50'}">
                            <span class="text-sm text-gray-500">Accumulated Value</span>
                            <span class="font-semibold text-gray-800 ledger-item-value ${valClass}">${accDisplay}</span>
                        </div>
                        <div class="flex justify-between items-end pt-2">
                            <span class="text-sm font-medium ${accumulated >= 0 ? 'text-green-700' : 'text-pink-700'}">CAGR</span>
                            <span class="text-2xl font-bold ${accumulated >= 0 ? 'text-green-600' : 'text-pink-600'} ledger-item-value total ${valClass}">${annualReturn.toFixed(2)}%</span>
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
        const start = portfolio.firstDateInt;
        const finish = portfolio.lastDateInt;
        if (!sv || !start || !finish || sv === 0) return 0;
        const years = (finish.year + (finish.month - 1) / 12) - (start.year + (start.month - 1) / 12);
        if (years <= 0) return 0;
        return (Math.pow(fv / sv, 1 / years) - 1) * 100;
    }
}

customElements.define('portfolio-ledger', PortfolioLedger);
