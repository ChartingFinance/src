/**
 * <month-details> — the selected month, always on screen.
 *
 * It sits directly under the timeline because the timeline's cursor drives
 * it. Three equal regions, each its own panel, so the three kinds of number
 * cannot run together:
 *
 *   Net worth          the balance, with the month's change and today's dollars
 *   This month         the single month's flows
 *   Withdrawn …        the trailing twelve months — a different cadence, so it
 *                      gets its own label
 *
 * The numbers come from month-summary.js, which is headless and tested; this
 * file only lays them out. The section heading, date badge, jump links and AI
 * summary button are static HTML in index.html, wired by finplan-app.js, the
 * same as every other section.
 */

import { LitElement, html, nothing } from 'lit';
import { monthSummary, zeroTaxWasWithheld } from '../month-summary.js';

const WITHHELD_TOOLTIP =
    'Tax that left one of your accounts. Tax withheld at source — from a ' +
    'paycheck, a pension or Social Security — never passes through an ' +
    'account, so it is not counted here.';

export class MonthDetails extends LitElement {
    static properties = {
        portfolio:     { attribute: false },
        selectedYear:  { type: Number },
        selectedMonth: { type: Number },
    };

    // Light DOM, like the rest of the app, so index.html's styles apply.
    createRenderRoot() { return this; }

    constructor() {
        super();
        this.portfolio = null;
        this.selectedYear = 0;
        this.selectedMonth = 1;
    }

    render() {
        const s = monthSummary(this.portfolio, this.selectedYear, this.selectedMonth);
        if (!s) {
            return html`<div class="glass-card md-card">
                <div class="md-empty">No simulation data for this month</div>
            </div>`;
        }

        const d = s.drawn;
        const span = d.complete ? 'Past 12 months'
            : `${d.months} ${d.months === 1 ? 'month' : 'months'} so far`;
        // "$0" is correct in a working year and looks like a bug. Say why — but
        // only when it is true; see zeroTaxWasWithheld for the three conditions.
        const withheld = zeroTaxWasWithheld(s);

        // Three equal regions, each led by its own time frame. They are three
        // different kinds of number — a balance, one month's flows, and a
        // trailing twelve months — and sharing a row made the third read as
        // more of the second.
        return html`
            <div class="glass-card md-card">
                <div class="md-regions">
                    <section class="md-region md-nw" aria-label="Net worth">
                        <div class="md-eyebrow">Net worth</div>
                        <div class="md-nw-val">${money(s.value)}</div>
                        <div class="md-nw-delta ${tone(s.netChange)}">${signed(s.netChange)} this month</div>
                        ${s.valueReal != null ? html`
                            <div class="md-sub">${money(s.valueReal)} in today’s $</div>
                        ` : nothing}
                    </section>

                    <section class="md-region" aria-label="This month">
                        <div class="md-eyebrow">This month</div>
                        <div class="md-cells">
                            ${cell('Income', signed(s.income))}
                            ${cell('Expenses', signed(s.expense))}
                            ${cell('Taxes', signed(s.taxes))}
                            ${cell('Cash flow', signed(s.cashFlow), tone(s.cashFlow))}
                            ${cell('Asset growth', signed(s.growth), tone(s.growth))}
                        </div>
                    </section>

                    <section class="md-region md-drawn" aria-label="Withdrawn to meet obligations, ${span.toLowerCase()}">
                        <div class="md-eyebrow">${span}</div>
                        <div class="md-region-title">Withdrawn to meet obligations</div>
                        <div class="md-cells">
                            ${cell('Spending', money(d.spending))}
                            <div class="md-cell" title=${WITHHELD_TOOLTIP}>
                                <div class="md-label">Tax <span class="md-info" aria-label=${WITHHELD_TOOLTIP}>ⓘ</span></div>
                                <div class="md-val">${money(d.tax)}</div>
                                ${withheld ? html`<div class="md-hint">withheld at source</div>` : nothing}
                            </div>
                            ${cell('Total', money(d.total), 'md-strong')}
                            ${d.unfunded > 0 ? html`
                                <div class="md-cell md-unfunded" title="Obligations the plan could not fund from any account">
                                    <div class="md-label">Could not fund</div>
                                    <div class="md-val">${money(d.unfunded)}</div>
                                </div>
                            ` : nothing}
                        </div>
                    </section>
                </div>
            </div>
        `;
    }
}

function cell(label, value, cls = '') {
    return html`<div class="md-cell ${cls}">
        <div class="md-label">${label}</div>
        <div class="md-val">${value}</div>
    </div>`;
}

/**
 * Whole dollars. The popover abbreviated ($705K) because it was 236px wide;
 * this is the detail view, and it has the room.
 */
function money(amount) {
    const v = Math.round(Number(amount) || 0);
    const s = `$${Math.abs(v).toLocaleString('en-US')}`;
    return v < 0 ? `−${s}` : s;
}

function signed(amount) {
    const v = Math.round(Number(amount) || 0);
    return v > 0 ? `+${money(v)}` : money(v);
}

function tone(amount) {
    const v = Math.round(Number(amount) || 0);
    return v > 0 ? 'md-pos' : v < 0 ? 'md-neg' : '';
}

customElements.define('month-details', MonthDetails);
