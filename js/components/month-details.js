/**
 * <month-details> — the selected month and its calendar year, always on screen.
 *
 * It sits directly under the timeline because the timeline's cursor drives
 * it. Two rows over the same columns, so a figure reads the same over one month
 * and over twelve:
 *
 *   Income · Expenses · Taxes · Cash flow   first, and they reconcile: cash
 *                                           flow is income less the other two
 *   Withdrawn                               what left the accounts to meet
 *                                           obligations; click it for the list
 *   Asset growth · Net worth                net worth is a balance, not a sum
 *
 * Under them, the tax year: what the year's income owed, AGI, MAGI and the two
 * effective rates, from the year's TaxYear record.
 *
 * The numbers come from month-summary.js, which is headless and tested; this
 * file only lays them out. The section heading, date badge, jump links and AI
 * summary button are static HTML in index.html, wired by finplan-app.js, the
 * same as every other section.
 */

import { LitElement, html, nothing } from 'lit';
import {
    monthSummary, yearSummary, zeroTaxWasWithheld, yearSpan, magiLines, settlementParts,
} from '../month-summary.js';
import { formatCurrency, formatSignedCurrency } from '../utils/html.js';
import { MONTH_NAMES } from '../utils/date-int.js';

/** The column headings. The first four are the headline figures. */
const COLUMNS = ['Income', 'Expenses', 'Taxes', 'Cash flow', 'Withdrawn', 'Asset growth', 'Net worth'];
const HEADLINE = 4;

export class MonthDetails extends LitElement {
    static properties = {
        portfolio:     { attribute: false },
        selectedYear:  { type: Number },
        selectedMonth: { type: Number },
        /** Which row's withdrawals list is open: 'month', 'year' or null. */
        _open:         { state: true },
    };

    // Light DOM, like the rest of the app, so index.html's styles apply.
    createRenderRoot() { return this; }

    constructor() {
        super();
        this.portfolio = null;
        this.selectedYear = 0;
        this.selectedMonth = 1;
        this._open = null;
        this._onDocumentClick = (e) => {
            if (this._open && !e.composedPath().some((el) => el.classList?.contains('md-pop-anchor'))) {
                this._open = null;
            }
        };
        this._onKeydown = (e) => { if (e.key === 'Escape') this._open = null; };
    }

    connectedCallback() {
        super.connectedCallback();
        document.addEventListener('click', this._onDocumentClick);
        document.addEventListener('keydown', this._onKeydown);
    }

    disconnectedCallback() {
        document.removeEventListener('click', this._onDocumentClick);
        document.removeEventListener('keydown', this._onKeydown);
        super.disconnectedCallback();
    }

    willUpdate(changed) {
        // A list left open would describe the month the cursor just left.
        if (changed.has('selectedYear') || changed.has('selectedMonth') || changed.has('portfolio')) {
            this._open = null;
        }
    }

    updated() {
        // Keep an open list on screen: when its cell is near the right edge,
        // shift it left by what would overflow.
        const pop = this.querySelector('.md-pop');
        if (!pop) return;
        pop.style.left = '0px';
        const over = pop.getBoundingClientRect().right - (document.documentElement.clientWidth - 8);
        if (over > 0) pop.style.left = `${-over}px`;
    }

    render() {
        const s = monthSummary(this.portfolio, this.selectedYear, this.selectedMonth);
        const y = s && yearSummary(this.portfolio, this.selectedYear);
        if (!s || !y) {
            return html`<div class="glass-card md-card">
                <div class="md-empty">No simulation data for this month</div>
            </div>`;
        }

        const monthName = `${MONTH_NAMES[this.selectedMonth - 1]} ${this.selectedYear}`;
        const span = y.months === 12 ? 'Jan–Dec' : `${yearSpan(y)}, ${y.months} ${y.months === 1 ? 'month' : 'months'}`;

        return html`
            <div class="glass-card md-card">
                <div role="table" aria-label="${monthName} and ${this.selectedYear}">
                    <div class="md-row md-head" role="row">
                        <div role="columnheader"></div>
                        ${COLUMNS.map((c, i) => html`
                            <div role="columnheader" class="md-colhead ${i < HEADLINE ? 'md-key' : ''}">${c}</div>`)}
                    </div>
                    ${this._row('month', monthName, 'this month', s)}
                    ${this._row('year', String(this.selectedYear), span, y)}
                </div>
                ${this._taxYear(y)}
            </div>
        `;
    }

    _row(key, title, span, s) {
        return html`
            <div class="md-row" role="row">
                <div class="md-rowhead" role="rowheader">
                    <div class="md-rowtitle">${title}</div>
                    <div class="md-sub">${span}</div>
                </div>
                ${cell('Income', formatSignedCurrency(s.income))}
                ${cell('Expenses', formatSignedCurrency(s.expense))}
                ${cell('Taxes', formatSignedCurrency(s.taxes))}
                ${cell('Cash flow', formatSignedCurrency(s.cashFlow), tone(s.cashFlow))}
                ${this._withdrawn(key, title, s)}
                ${cell('Asset growth', formatSignedCurrency(s.growth), tone(s.growth))}
                <div class="md-cell" role="cell">
                    <div class="md-label">Net worth</div>
                    <div class="md-val">${formatCurrency(s.value)}</div>
                    <div class="md-delta ${tone(s.netChange)}">${formatSignedCurrency(s.netChange)}</div>
                    ${s.valueReal != null ? html`<div class="md-sub">${formatCurrency(s.valueReal)} in today’s $</div>` : nothing}
                </div>
            </div>`;
    }

    /** The total, as a button that opens the list of obligations it paid. */
    _withdrawn(key, title, s) {
        const d = s.drawn;
        const open = this._open === key;
        return html`
            <div class="md-cell md-pop-anchor" role="cell">
                <div class="md-label">Withdrawn</div>
                <button class="md-drawn-btn" aria-haspopup="dialog" aria-expanded=${open ? 'true' : 'false'}
                        title="Withdrawn from your accounts to meet obligations. Click for the list."
                        @click=${() => { this._open = open ? null : key; }}>
                    ${formatCurrency(d.total)}<span class="md-caret" aria-hidden="true">▾</span>
                </button>
                ${d.unfunded > 0 ? html`<div class="md-hint md-neg">${formatCurrency(d.unfunded)} unfunded</div>` : nothing}
                ${open ? this._obligations(title, s) : nothing}
            </div>`;
    }

    _obligations(title, s) {
        const d = s.drawn;
        const group = (heading, bucket) => {
            const items = d.items.filter((it) => it.bucket === bucket);
            if (!items.length) return nothing;
            const total = items.reduce((t, it) => t + it.amount, 0);
            return html`
                <div class="md-pop-row md-pop-group"><span>${heading}</span><span>${formatCurrency(total)}</span></div>
                ${items.map((it) => html`
                    <div class="md-pop-row md-pop-item"><span>${it.label}</span><span>${formatCurrency(it.amount)}</span></div>`)}`;
        };
        return html`
            <div class="md-pop" role="dialog" aria-label="Withdrawn to meet obligations, ${title}">
                <div class="md-pop-title">Withdrawn to meet obligations</div>
                <div class="md-sub">${title}</div>
                ${group('Spending', 'spending')}
                ${group('Tax', 'tax')}
                <div class="md-pop-row md-pop-total"><span>Total</span><span>${formatCurrency(d.total)}</span></div>
                ${d.unfunded > 0 ? html`
                    <div class="md-pop-row md-neg"><span>Could not fund</span><span>${formatCurrency(d.unfunded)}</span></div>` : nothing}
                ${zeroTaxWasWithheld(s) ? html`
                    <div class="md-pop-note">No tax was withdrawn: the ${formatCurrency(s.withheldAtSource)} of tax
                        paid was withheld at source, from a paycheck, a pension or Social Security, and never
                        passed through an account.</div>` : nothing}
                ${d.items.length === 0 && !(d.unfunded > 0) ? html`
                    <div class="md-pop-note">Nothing was withdrawn to meet obligations.</div>` : nothing}
            </div>`;
    }

    /** What the year's income owed, then AGI, MAGI and the two rates. */
    _taxYear(y) {
        const t = y.taxYear;
        if (!t) {
            return html`<section class="md-taxyear" aria-label="Tax year ${y.year}">
                <div class="md-eyebrow">Tax year ${y.year}</div>
                <div class="md-sub">Not settled inside the plan, so there are no tax-year figures.</div>
            </section>`;
        }
        const parts = settlementParts(t);
        const settled = parts.length
            ? `settled Jan ${y.year + 1}: ${parts.map((p) => `${formatCurrency(p.amount)} ${p.label}`).join(', ')}`
            : `nothing to settle in Jan ${y.year + 1}`;
        const [main, ...others] = magiLines(t);
        const pct = (r) => (r == null ? '—' : `${(r * 100).toFixed(1)}%`);
        return html`
            <section class="md-taxyear" aria-label="Tax year ${y.year}">
                <div class="md-eyebrow">Tax year ${y.year}</div>
                <div class="md-tax-cells">
                    <div class="md-cell md-strong">
                        <div class="md-label">Federal taxes owed</div>
                        <div class="md-val">${formatCurrency(t.federalTax)}</div>
                        <div class="md-sub">${settled}</div>
                    </div>
                    ${cell('AGI', formatCurrency(t.agi), '', false)}
                    <div class="md-cell" title="MAGI for ${main.purposes.join(', ')}">
                        <div class="md-label">MAGI</div>
                        <div class="md-val">${formatCurrency(main.amount)}</div>
                        ${others.map((l) => html`<div class="md-sub">${l.purposes.join(', ')}: ${formatCurrency(l.amount)}</div>`)}
                    </div>
                    ${cell('Effective rate on income', pct(y.effectiveRateOnIncome), '', false)}
                    ${cell('Effective rate on AGI', pct(y.effectiveRateOnAGI), '', false)}
                </div>
            </section>`;
    }
}

function cell(label, value, cls = '', inTable = true) {
    return html`<div class="md-cell ${cls}" role=${inTable ? 'cell' : nothing}>
        <div class="md-label">${label}</div>
        <div class="md-val">${value}</div>
    </div>`;
}

// Whole dollars throughout: this is the detail view, and it has the room.

function tone(amount) {
    const v = Math.round(Number(amount) || 0);
    return v > 0 ? 'md-pos' : v < 0 ? 'md-neg' : '';
}

customElements.define('month-details', MonthDetails);
