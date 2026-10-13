/**
 * <month-details> — the selected month and its calendar year, always on screen.
 *
 * It sits directly under the timeline because the timeline's cursor drives
 * it. Two rows over the same columns, so a figure reads the same over one month
 * and over twelve:
 *
 *   Income received · Expenses · Taxes ·    first, and they reconcile: cash
 *   Cash flow                               flow is income less the other two
 *   Withdrawn                               what left the accounts to meet
 *                                           obligations
 *   Asset growth · Net worth                net worth is a balance, not a sum
 *
 * Expenses, Taxes and Withdrawn are buttons: each opens the list behind its
 * figure, in whole dollars that add up to it.
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
    headlineAsShown, drawnAsShown, expensesAsShown, taxesAsShown,
} from '../month-summary.js';
import { formatCurrency, formatSignedCurrency } from '../utils/html.js';
import { MONTH_NAMES } from '../utils/date-int.js';

/** The column headings. The first four are the headline figures. */
const COLUMNS = ['Income received', 'Expenses', 'Taxes', 'Cash flow', 'Withdrawn', 'Asset growth', 'Net worth'];
const HEADLINE = 4;

export class MonthDetails extends LitElement {
    static properties = {
        portfolio:     { attribute: false },
        selectedYear:  { type: Number },
        selectedMonth: { type: Number },
        /** Which list is open, as "row:figure" ('year:taxes'), or null. */
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
        // Whole dollars that add up: cash flow is the sum of the three beside
        // it, and each list ends on the figure it was opened from.
        const h = headlineAsShown(s);
        const expenses = expensesAsShown(s);
        const taxes = taxesAsShown(s);
        const drawn = drawnAsShown(s.drawn);
        return html`
            <div class="md-row" role="row">
                <div class="md-rowhead" role="rowheader">
                    <div class="md-rowtitle">${title}</div>
                    <div class="md-sub">${span}</div>
                </div>
                ${cell('Income received', formatSignedCurrency(h.income))}
                ${this._listCell(`${key}:expenses`, 'Expenses', formatSignedCurrency(h.expense), nothing,
                    () => this._list('Expenses', title, expenses, formatSignedCurrency, expenseNotes(expenses)))}
                ${this._listCell(`${key}:taxes`, 'Taxes', formatSignedCurrency(h.taxes), nothing,
                    () => this._list('Taxes paid', title, taxes, formatSignedCurrency, taxNotes(taxes)))}
                ${cell('Cash flow', formatSignedCurrency(h.cashFlow), tone(h.cashFlow))}
                ${this._listCell(`${key}:withdrawn`, 'Withdrawn', formatCurrency(drawn.total),
                    drawn.unfunded > 0 ? html`<div class="md-hint md-neg">${formatCurrency(drawn.unfunded)} unfunded</div>` : nothing,
                    () => this._list('Withdrawn to meet obligations', title, drawnView(drawn), formatCurrency, drawnNotes(s, drawn)))}
                ${cell('Asset growth', formatSignedCurrency(s.growth), tone(s.growth))}
                <div class="md-cell" role="cell">
                    <div class="md-label">Net worth</div>
                    <div class="md-val">${formatCurrency(s.value)}</div>
                    <div class="md-delta ${tone(s.netChange)}">${formatSignedCurrency(s.netChange)}</div>
                    ${s.valueReal != null ? html`<div class="md-sub">${formatCurrency(s.valueReal)} in today’s $</div>` : nothing}
                </div>
            </div>`;
    }

    /** A figure as a button that opens the list behind it. */
    _listCell(id, label, value, below, list) {
        const open = this._open === id;
        return html`
            <div class="md-cell md-pop-anchor" role="cell">
                <div class="md-label">${label}</div>
                <button class="md-pop-btn" aria-haspopup="dialog" aria-expanded=${open ? 'true' : 'false'}
                        title="${label}: click for the list"
                        @click=${() => { this._open = open ? null : id; }}>
                    ${value}<span class="md-caret" aria-hidden="true">▾</span>
                </button>
                ${below}
                ${open ? list() : nothing}
            </div>`;
    }

    /**
     * A list in whole dollars that add up: lines to groups to the total. A
     * group of one line is one row; a group marked `list` always shows its
     * lines under its heading.
     */
    _list(title, subtitle, view, money, notes) {
        const row = (cls, label, amount) =>
            html`<div class="md-pop-row ${cls}"><span>${label}</span><span>${money(amount)}</span></div>`;
        return html`
            <div class="md-pop" role="dialog" aria-label="${title}, ${subtitle}">
                <div class="md-pop-title">${title}</div>
                <div class="md-sub">${subtitle}</div>
                ${view.groups.map((g) => g.items.length === 1 && !g.list
                    ? row('md-pop-group', g.items[0].label ? `${g.heading}: ${g.items[0].label}` : g.heading, g.total)
                    : html`${row('md-pop-group', g.heading, g.total)}
                        ${g.items.map((it) => row('md-pop-item', it.label, it.amount))}`)}
                ${view.groups.length ? row('md-pop-total', 'Total', view.total) : nothing}
                ${notes}
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
                    <div class="md-cell">
                        <div class="md-label">Effective rate on total income</div>
                        <div class="md-val">${pct(y.effectiveRateOnIncome)}</div>
                        <div class="md-sub">of ${formatCurrency(y.totalIncome)}, withdrawals included</div>
                    </div>
                    ${cell('Effective rate on AGI', pct(y.effectiveRateOnAGI), '', false)}
                </div>
            </section>`;
    }
}

/** The withdrawals list in the shape _list draws: spending, then tax. */
function drawnView(drawn) {
    const groups = [
        { heading: 'Spending', list: true, ...drawn.spending },
        { heading: 'Tax', list: true, ...drawn.tax },
    ].filter((g) => g.items.length);
    return { groups, total: drawn.total };
}

function drawnNotes(s, drawn) {
    return html`
        ${drawn.unfunded > 0 ? html`
            <div class="md-pop-row md-neg"><span>Could not fund</span><span>${formatCurrency(drawn.unfunded)}</span></div>` : nothing}
        ${zeroTaxWasWithheld(s) ? html`
            <div class="md-pop-note">No tax was withdrawn: the ${formatCurrency(s.withheldAtSource)} of tax
                paid was withheld at source, from a paycheck, a pension or Social Security, and never
                passed through an account.</div>` : nothing}
        ${s.drawn.items.length === 0 && !(drawn.unfunded > 0) ? html`
            <div class="md-pop-note">Nothing was withdrawn to meet obligations.</div>` : nothing}`;
}

function expenseNotes(view) {
    const principal = view.groups.some((g) => g.items.some((it) => it.label === 'Principal'));
    return html`
        ${view.groups.length ? nothing : html`<div class="md-pop-note">No expenses.</div>`}
        ${principal ? html`<div class="md-pop-note">Mortgage principal is counted: it is money paid out,
            though not an accounting expense.</div>` : nothing}`;
}

function taxNotes(view) {
    const st = view.settlement;
    return html`
        ${view.groups.length ? nothing : html`<div class="md-pop-note">No taxes paid.</div>`}
        ${st && st.parts.length ? html`<div class="md-pop-note">Includes January’s settlement of ${st.year}:
            ${st.parts.map((p) => `${formatCurrency(p.amount)} ${p.label}`).join(', ')}.</div>` : nothing}`;
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
