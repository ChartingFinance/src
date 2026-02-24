/**
 * <debug-panel-element>
 *
 * Floating, draggable debug panel that displays monthly and yearly
 * financial reports. Replaces the imperative DOM construction in debug-panel.js.
 */

import { LitElement, html, css } from 'lit';

class DebugPanelElement extends LitElement {

    static properties = {
        reports: { type: Array },
        visible: { type: Boolean, reflect: true },
    };

    static styles = css`
        :host {
            position: fixed;
            bottom: 80px;
            right: 20px;
            width: 480px;
            max-height: 70vh;
            background: #ffffff;
            border-radius: 16px;
            box-shadow: 0 20px 60px -10px rgba(0,0,0,0.2);
            border: 1px solid #e5e7eb;
            z-index: 9999;
            display: none;
            font-family: 'Poppins', sans-serif;
            font-size: 12px;
            overflow: hidden;
        }
        :host([visible]) {
            display: block;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 16px;
            background: #111827;
            color: #ffffff;
            cursor: grab;
            user-select: none;
            border-radius: 16px 16px 0 0;
        }
        .title {
            font-weight: 600;
            font-size: 13px;
            letter-spacing: 0.04em;
        }
        .controls {
            display: flex;
            gap: 6px;
        }
        .controls button {
            background: rgba(255,255,255,0.15);
            border: none;
            color: #ffffff;
            padding: 2px 10px;
            border-radius: 8px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
        }
        .content {
            padding: 12px 16px;
            overflow-y: auto;
            max-height: calc(70vh - 44px);
            color: #374151;
            line-height: 1.6;
        }
        details {
            margin-bottom: 8px;
            border-bottom: 1px solid #f3f4f6;
            padding-bottom: 8px;
        }
        summary {
            cursor: pointer;
            font-weight: 600;
            padding: 4px 0;
        }
        .badge {
            color: #fff;
            padding: 1px 8px;
            border-radius: 6px;
            font-size: 10px;
            font-weight: 600;
            margin-right: 6px;
        }
        .badge.monthly { background: #2563eb; }
        .badge.yearly { background: #7c3aed; }
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 14px;
            margin-top: 4px;
        }
        td {
            padding: 2px 6px;
        }
        td:last-child {
            text-align: right;
            font-family: monospace;
        }
        tr.header-row {
            background: #f9fafb;
        }
        tr.header-row td {
            font-weight: 600;
        }
    `;

    constructor() {
        super();
        this.reports = [];
        this.visible = false;
        this._isDragging = false;
        this._dragOffsetX = 0;
        this._dragOffsetY = 0;
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
    }

    connectedCallback() {
        super.connectedCallback();
        document.addEventListener('mousemove', this._onMouseMove);
        document.addEventListener('mouseup', this._onMouseUp);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        document.removeEventListener('mousemove', this._onMouseMove);
        document.removeEventListener('mouseup', this._onMouseUp);
    }

    render() {
        // Reverse so newest reports appear first
        const reversed = [...this.reports].reverse();

        return html`
            <div class="header" @mousedown=${this._onMouseDown}>
                <span class="title">Debug Reports</span>
                <div class="controls">
                    <button @click=${this._onClear} title="Clear">Clear</button>
                    <button @click=${this._onClose} title="Close">&times;</button>
                </div>
            </div>
            <div class="content">
                ${reversed.map(({ type, dateLabel, pkg }) => html`
                    <details>
                        <summary>
                            <span class="badge ${type}">${type === 'yearly' ? 'YEARLY' : 'MONTHLY'}</span>
                            ${dateLabel}
                        </summary>
                        <table>
                            ${this._buildRows(pkg).map(([label, value, isHeader]) => html`
                                <tr class="${isHeader ? 'header-row' : ''}">
                                    <td>${label}</td>
                                    <td>${value}</td>
                                </tr>
                            `)}
                        </table>
                    </details>
                `)}
            </div>
        `;
    }

    _buildRows(pkg) {
        const f = (c) => (c && typeof c.toString === 'function') ? c.toString() : String(c);
        return [
            ['Income', f(pkg.totalIncome()), true],
            ['\u00a0\u00a0Employed', f(pkg.employedIncome), false],
            ['\u00a0\u00a0Self', f(pkg.selfIncome), false],
            ['\u00a0\u00a0Ordinary', f(pkg.ordinaryIncome()), false],
            ['\u00a0\u00a0\u00a0\u00a0Social Security', f(pkg.socialSecurity), false],
            ['\u00a0\u00a0\u00a0\u00a0IRA Distribution', f(pkg.iraDistribution), false],
            ['\u00a0\u00a0\u00a0\u00a0401K Distribution', f(pkg.four01KDistribution), false],
            ['\u00a0\u00a0\u00a0\u00a0Short-Term Gains', f(pkg.shortTermCapitalGains), false],
            ['\u00a0\u00a0\u00a0\u00a0Interest', f(pkg.interestIncome), false],
            ['\u00a0\u00a0\u00a0\u00a0Non-Qual Dividends', f(pkg.nonQualifiedDividends), false],
            ['\u00a0\u00a0Long-Term Gains', f(pkg.longTermCapitalGains), false],
            ['\u00a0\u00a0Non-Taxable', f(pkg.nontaxableIncome()), false],
            ['\u00a0\u00a0\u00a0\u00a0Roth Distribution', f(pkg.rothDistribution), false],
            ['\u00a0\u00a0\u00a0\u00a0Qualified Dividends', f(pkg.qualifiedDividends), false],
            ['Deductions', f(pkg.deductions()), true],
            ['\u00a0\u00a0Traditional IRA', f(pkg.iraContribution), false],
            ['\u00a0\u00a0Traditional 401K', f(pkg.four01KContribution), false],
            ['\u00a0\u00a0Mortgage Interest', f(pkg.mortgageInterest), false],
            ['\u00a0\u00a0Property Tax (Deductible)', f(pkg.deductiblePropertyTaxes()), false],
            ['Taxes', f(pkg.totalTaxes()), true],
            ['\u00a0\u00a0FICA', f(pkg.fica), false],
            ['\u00a0\u00a0Income Tax', f(pkg.incomeTax), false],
            ['\u00a0\u00a0LT Cap Gains Tax', f(pkg.longTermCapitalGainsTax), false],
            ['\u00a0\u00a0Property Tax (Total)', f(pkg.propertyTaxes), false],
            ['\u00a0\u00a0Estimated Taxes', f(pkg.estimatedTaxes), false],
            ['Contributions', f(pkg.contributions()), true],
            ['\u00a0\u00a0Traditional IRA', f(pkg.iraContribution), false],
            ['\u00a0\u00a0Traditional 401K', f(pkg.four01KContribution), false],
            ['\u00a0\u00a0Roth IRA', f(pkg.rothContribution), false],
            ['Debt Paydown', '', true],
            ['\u00a0\u00a0Mortgage Principal', f(pkg.mortgagePrincipal), false],
            ['\u00a0\u00a0Mortgage Escrow', f(pkg.mortgageEscrow), false],
            ['Asset Growth', f(pkg.growth()), true],
            ['Expenses', f(pkg.expense), true],
            ['Total Earning', f(pkg.earning()), true],
            ['Effective Tax Rate', pkg.effectiveTaxRate().toFixed(2) + '%', true],
        ];
    }

    // ── Drag handling ─────────────────────────────────────────

    _onMouseDown(ev) {
        if (ev.target.closest('.content')) return;
        this._isDragging = true;
        this._dragOffsetX = ev.clientX - this.offsetLeft;
        this._dragOffsetY = ev.clientY - this.offsetTop;
        ev.preventDefault();
    }

    _onMouseMove(ev) {
        if (!this._isDragging) return;
        this.style.left = (ev.clientX - this._dragOffsetX) + 'px';
        this.style.top = (ev.clientY - this._dragOffsetY) + 'px';
        this.style.right = 'auto';
        this.style.bottom = 'auto';
    }

    _onMouseUp() {
        this._isDragging = false;
    }

    // ── Button handlers ───────────────────────────────────────

    _onClear() {
        this.reports = [];
        this.dispatchEvent(new CustomEvent('panel-clear'));
    }

    _onClose() {
        this.visible = false;
        this.dispatchEvent(new CustomEvent('panel-close'));
    }
}

customElements.define('debug-panel-element', DebugPanelElement);
