/**
 * <flows-view> — Your Portfolio → Flows: where the money went, and the rules
 * that sent it.
 *
 *   Where the money went   one bar per source of money, over the selected
 *                          month or its year. A bar's parts are where its
 *                          money went, colored by what it did: into the
 *                          household's accounts, spent, or paid in tax. Each
 *                          part carries its destination's group icon, as on
 *                          the Assets view.
 *
 *   Rules in force         each transfer rule of the phase in force, its
 *                          setting beside what it moved; then the money that
 *                          moved by itself (tax withheld, required
 *                          distributions, take-home pay no rule claims).
 *
 * Hovering or focusing a bar part lights the rule that made it, and a rule
 * lights its parts. Clicking a rule opens its owner's transfers in the phase
 * that set it.
 *
 * The numbers come from money-flows.js, which is headless and tested; this file
 * only lays them out.
 *
 * Dispatches: edit-transfers { displayName, phase }
 */

import { LitElement, html, nothing } from 'lit';
import { moneyFlows, rulesInForce, monthWindow, yearWindow, FlowKind, FlowVia, SourceRole, UnpaidKind } from '../money-flows.js';
import { AssetGroupMeta } from '../asset-groups.js';
import { formatCurrency, formatSignedCurrency } from '../utils/html.js';
import { DateInt, MONTH_NAMES } from '../utils/date-int.js';

const KIND_LABEL = Object.freeze({
    [FlowKind.ACCOUNTS]: 'Into your accounts',
    [FlowKind.SPENT]:    'Spent',
    [FlowKind.TAX]:      'Tax',
});

/** What a part's route was, when it was not a rule. Shown beside its name. */
const VIA_NOTE = Object.freeze({
    leftover: 'leftover pay',
    rmd: 'RMD',
    close: 'at close',
    ruleAtClose: 'at close',
    opening: 'at opening',
    spillover: 'covering a shortfall',
    backstop: 'no rule',
    provision: 'on the draw',
    withheld: 'withheld',
    estimated: 'estimated',
    oneTime: 'one-time',
});

const UNPAID_LABEL = Object.freeze({
    [UnpaidKind.SPENT]:  'bills',
    [UnpaidKind.TAX]:    'tax',
    [UnpaidKind.INCOME]: 'income with no account to go to',
    [UnpaidKind.MOVE]:   'transfers with nowhere to go',
});

const icon = (group) => AssetGroupMeta.get(group)?.groupEmoji ?? '';

export class FlowsView extends LitElement {
    static properties = {
        portfolio:     { attribute: false },
        selectedYear:  { type: Number },
        selectedMonth: { type: Number },
        /** 'month' or 'year'. */
        period:        { type: String },
        /** Part ids lit by a hover or focus, or null. */
        _hot:          { state: true },
        _showIdle:     { state: true },
    };

    // Light DOM, like the rest of the app, so index.html's styles apply.
    createRenderRoot() { return this; }

    constructor() {
        super();
        this.portfolio = null;
        this.selectedYear = 0;
        this.selectedMonth = 1;
        this.period = 'month';
        this._hot = null;
        this._showIdle = false;
        this._cache = null;
    }

    willUpdate(changed) {
        // A highlight belongs to the bars it was made on.
        if (['portfolio', 'selectedYear', 'selectedMonth', 'period'].some((k) => changed.has(k))) this._hot = null;
    }

    /** The flows and rules for the current inputs, computed once per change. */
    _model() {
        const { portfolio: p, selectedYear: y, selectedMonth: m, period } = this;
        const c = this._cache;
        if (c && c.p === p && c.y === y && c.m === m && c.period === period) return c.model;
        let model = null;
        const window = !p ? null : period === 'year' ? yearWindow(p, y) : monthWindow(p, y, m);
        if (window) {
            try {
                const flows = moneyFlows(p, window.from, window.to);
                model = { window, flows, rules: rulesInForce(p, flows) };
            } catch (err) {
                // Bars that cannot be drawn are said to be missing; the last
                // period's must not stay on screen as if they were this one's.
                console.error('Flows could not read this period:', err);
                model = { window, error: err };
            }
        }
        this._cache = { p, y, m, period, model };
        return model;
    }

    _periodLabel(window) {
        const first = this.portfolio.firstDateInt;
        const at = (i) => { const d = DateInt.from(first.year, first.month); d.addMonths(i); return d; };
        const a = at(window.from), b = at(window.to);
        if (this.period === 'month') return `${MONTH_NAMES[a.month - 1]} ${a.year}`;
        if (a.month === 1 && b.month === 12) return String(a.year);
        return `${MONTH_NAMES[a.month - 1].slice(0, 3)}–${MONTH_NAMES[b.month - 1].slice(0, 3)} ${a.year}`;
    }

    render() {
        const model = this._model();
        if (!model) return html`<div class="fl-empty">Run a plan to see where its money goes.</div>`;
        const { window, flows, rules, error } = model;
        return html`
            <div class="fl-view">
                <div class="fl-head">
                    <div class="fl-title">Where the money went</div>
                    <div class="fl-period">${this._periodLabel(window)}</div>
                    <div class="fl-toggle" role="group" aria-label="Period">
                        ${['month', 'year'].map((p) => html`
                            <button class=${this.period === p ? 'active' : ''} aria-pressed=${this.period === p}
                                    @click=${() => { this.period = p; }}>${p === 'month' ? 'Month' : 'Year'}</button>`)}
                    </div>
                </div>
                ${error
                    ? html`<div class="fl-note fl-warn">⚠ Flows could not be drawn for this period. The details are in the browser console.</div>`
                    : html`
                        ${this._renderTiles(flows)}
                        ${this._renderBars(flows)}
                        ${this._renderRules(rules)}`}
            </div>
        `;
    }

    _renderTiles(flows) {
        const t = flows.totals;
        const unpaid = flows.unpaid.reduce((s, u) => s + u.amount, 0);
        const oneTime = [
            ...flows.sources.filter((s) => s.role === SourceRole.ONE_TIME).map((s) => `${s.name} ${formatSignedCurrency(s.total)}`),
            ...flows.sources.flatMap((s) => (s.role === SourceRole.ONE_TIME ? [] : s.parts))
                .filter((p) => p.via === FlowVia.ONE_TIME).map((p) => `${p.to} ${formatSignedCurrency(-p.amount)}`),
        ];
        return html`
            <div class="fl-tiles">
                <div class="fl-tile">
                    <div class="fl-tile-label">Came in</div>
                    <div class="fl-tile-val">${formatCurrency(t.income)}</div>
                    <div class="fl-tile-sub">pay, benefits, dividends, interest</div>
                </div>
                <div class="fl-tile">
                    <div class="fl-tile-label"><i class="fl-dot fl-k-spent"></i>Spent</div>
                    <div class="fl-tile-val">${formatCurrency(t.spent)}</div>
                    <div class="fl-tile-sub">bills, mortgage, property costs</div>
                </div>
                <div class="fl-tile" title=${taxTitle(t)}>
                    <div class="fl-tile-label"><i class="fl-dot fl-k-tax"></i>Tax paid</div>
                    <div class="fl-tile-val">${formatCurrency(t.taxes)}</div>
                    <div class="fl-tile-sub">${t.refunds ? `after a ${formatCurrency(t.refunds)} refund` : 'withheld, settled, property'}</div>
                </div>
                <div class="fl-tile">
                    <div class="fl-tile-label"><i class="fl-dot fl-k-accounts"></i>Into your accounts</div>
                    <div class="fl-tile-val ${t.intoAccounts < 0 ? 'fl-neg' : ''}">${formatSignedCurrency(t.intoAccounts)}</div>
                    <div class="fl-tile-sub">came in, less spent and tax</div>
                </div>
            </div>
            ${oneTime.length ? html`<div class="fl-note">One-time items are in the bars, not the figures above: ${oneTime.join('; ')}.</div>` : nothing}
            ${unpaid ? html`<div class="fl-note fl-warn">⚠ ${formatCurrency(unpaid)} could not be paid or placed, and is not in the bars:
                ${unpaidByKind(flows.unpaid).map(([label, amount], i) => `${i ? '; ' : ''}${label} ${formatCurrency(amount)}`)}.</div>` : nothing}
        `;
    }

    _renderBars(flows) {
        if (!flows.sources.length) return html`<div class="fl-empty">No money moved in this period.</div>`;
        const max = Math.max(...flows.sources.map((s) => s.total));
        const hot = this._hot;
        return html`
            <div class="fl-legend">
                ${[FlowKind.ACCOUNTS, FlowKind.SPENT, FlowKind.TAX].map((k) => html`
                    <span><i class="fl-dot fl-k-${k}"></i>${KIND_LABEL[k]}</span>`)}
            </div>
            <div class="fl-bars ${hot ? 'fl-has-hot' : ''}">
                ${flows.sources.map((s) => html`
                    <div class="fl-source">
                        <div class="fl-source-name" title=${s.name}><span class="fl-icon">${icon(s.group)}</span>${s.name}</div>
                        <div class="fl-track">
                            <div class="fl-bar" style="width: ${(s.total / max) * 100}%">
                                ${s.parts.map((p) => html`
                                    <div class="fl-seg fl-k-${p.kind} ${hot?.has(p.id) ? 'fl-hot' : ''}"
                                         style="flex-grow: ${p.amount}"
                                         title="${s.name} → ${p.to}: ${formatCurrency(p.amount)}"
                                         @mouseenter=${() => this._hoverPart(p.id)}
                                         @mouseleave=${() => this._hoverPart(null)}></div>`)}
                            </div>
                        </div>
                        <div class="fl-source-total">${formatCurrency(s.total)}</div>
                        <div class="fl-chips">
                            ${s.parts.map((p) => html`
                                <span class="fl-chip ${hot?.has(p.id) ? 'fl-hot' : ''}"
                                      @mouseenter=${() => this._hoverPart(p.id)}
                                      @mouseleave=${() => this._hoverPart(null)}>
                                    <i class="fl-dot fl-k-${p.kind}"></i><span class="fl-icon">${icon(p.toGroup)}</span>${p.to}${
                                    p.detail ? html` <span class="fl-chip-note">${p.detail}</span>` : nothing}${
                                    VIA_NOTE[p.via] ? html` <span class="fl-chip-note">${VIA_NOTE[p.via]}</span>` : nothing}
                                    <b>${formatCurrency(p.amount)}</b>
                                </span>`)}
                        </div>
                    </div>`)}
            </div>
        `;
    }

    _renderRules(rules) {
        const first = this.portfolio.firstDateInt;
        const monthOf = (i) => { const d = DateInt.from(first.year, first.month); d.addMonths(i); return `${MONTH_NAMES[d.month - 1].slice(0, 3)} ${d.year}`; };
        const spansPhases = rules.phases.filter((p) => p.inWindow).length > 1;
        const moved = rules.rules.filter((r) => r.moved > 0);
        const idle = rules.rules.filter((r) => r.moved === 0);
        const hot = this._hot;
        const rowHot = (ids) => hot && ids.some((id) => hot.has(id));
        // Hover and keyboard focus light the same parts.
        const linking = (ids) => ({
            enter: () => this._hoverIds(ids),
            leave: () => this._hoverIds(null),
        });

        const ruleRow = (r) => {
            const link = linking(r.partIds);
            return html`
            <div class="fl-rule ${r.moved ? '' : 'fl-zero'} ${rowHot(r.partIds) ? 'fl-hot' : ''}"
                 role="button" tabindex="0" title="Edit the transfers on ${r.owner}"
                 @click=${() => this._edit(r)}
                 @keydown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._edit(r); } }}
                 @mouseenter=${link.enter} @mouseleave=${link.leave} @focus=${link.enter} @blur=${link.leave}>
                <i class="fl-dot fl-k-${r.kind}"></i>
                <span class="fl-route"><span class="fl-icon">${icon(r.payerGroup)}</span>${r.payer}<span class="fl-arrow">→</span><span class="fl-icon">${icon(r.payeeGroup)}</span>${r.payee}</span>
                <span class="fl-setting">${r.setting}${spansPhases && r.phases.length ? html` <span class="fl-phase-tag">${r.phases.join(', ')}</span>` : nothing}</span>
                <span class="fl-moved">${formatCurrency(r.moved)}</span>
            </div>`;
        };

        return html`
            <div class="fl-rules-head">
                <div class="fl-title">Rules in force</div>
                ${rules.phases.length ? html`
                    <div class="fl-phases">
                        ${rules.phases.map((p) => html`
                            <span class="fl-pill ${p.inWindow ? 'active' : ''}">${p.phase} · from ${monthOf(p.fromIndex)}</span>`)}
                    </div>` : nothing}
            </div>
            ${spansPhases ? html`<div class="fl-note">This year changes phase, so it shows each phase’s rules, and what each moved over the whole year.</div>` : nothing}
            <div class="fl-rules ${hot ? 'fl-has-hot' : ''}">
                <div class="fl-rule fl-rule-head"><span></span><span>From → to</span><span>Setting</span><span class="fl-moved">Moved</span></div>
                ${moved.length ? moved.map(ruleRow) : html`<div class="fl-empty">No transfer rule moved money in this period.</div>`}
                ${idle.length ? html`
                    <button class="fl-more" aria-expanded=${this._showIdle ? 'true' : 'false'}
                            @click=${() => { this._showIdle = !this._showIdle; }}>
                        ${this._showIdle ? '▾' : '▸'} ${idle.length} ${idle.length === 1 ? 'rule' : 'rules'} moved nothing in this period
                    </button>
                    ${this._showIdle ? idle.map(ruleRow) : nothing}` : nothing}
                ${rules.automatic.length ? html`
                    <div class="fl-subhead">Moved automatically</div>
                    ${rules.automatic.map((a) => {
                        const link = linking(a.partIds);
                        return html`
                        <div class="fl-rule fl-auto ${rowHot(a.partIds) ? 'fl-hot' : ''}" tabindex="0"
                             title=${a.items.map((i) => `${i.source} → ${i.to}: ${formatCurrency(i.amount)}`).join('\n')}
                             @mouseenter=${link.enter} @mouseleave=${link.leave} @focus=${link.enter} @blur=${link.leave}>
                            <i class="fl-dot fl-k-${dominantKind(a.items)}"></i>
                            <span class="fl-route">${a.label}</span>
                            <span class="fl-setting">${autoDetail(a)}</span>
                            <span class="fl-moved">${formatCurrency(a.amount)}</span>
                        </div>`;
                    })}` : nothing}
            </div>
        `;
    }

    /** Light one part, and every part of the row that claims it. */
    _hoverPart(id) {
        if (!id) { this._hot = null; return; }
        const { rules } = this._model();
        const row = [...rules.rules, ...rules.automatic].find((r) => r.partIds.includes(id));
        this._hot = new Set([id, ...(row?.partIds ?? [])]);
    }

    _hoverIds(ids) {
        this._hot = ids?.length ? new Set(ids) : null;
    }

    /** Open the rule's transfers in the latest phase it was in force in. */
    _edit(rule) {
        this.dispatchEvent(new CustomEvent('edit-transfers', {
            bubbles: true, composed: true,
            detail: { displayName: rule.owner, phase: rule.phases[rule.phases.length - 1] ?? null },
        }));
    }
}

/** The Tax paid tile's explanation, with the escrow's difference when there is one. */
function taxTitle(t) {
    const base = 'Tax that left a paycheck or an account in this period.';
    if (!t.propertyTaxLag) return base;
    return `${base} Property tax is drawn the month after it accrues, so this is ` +
        `${formatCurrency(Math.abs(t.propertyTaxLag))} ${t.propertyTaxLag > 0 ? 'less' : 'more'} than Taxes in Month & Year Details.`;
}

/** Unpaid amounts by what they were, as [label, amount]. */
function unpaidByKind(unpaid) {
    const by = new Map();
    for (const u of unpaid) by.set(u.kind, (by.get(u.kind) ?? 0) + u.amount);
    return [...by].map(([kind, amount]) => [UNPAID_LABEL[kind] ?? kind, amount]);
}

/** The kind most of an automatic row's money was. */
function dominantKind(items) {
    const by = {};
    for (const i of items) by[i.kind] = (by[i.kind] ?? 0) + i.amount;
    return Object.entries(by).sort((a, b) => b[1] - a[1])[0]?.[0] ?? FlowKind.ACCOUNTS;
}

/** An automatic row's sources and destinations, briefly. */
function autoDetail(a) {
    const sources = [...new Set(a.items.map((i) => i.source))];
    const targets = [...new Set(a.items.map((i) => i.to))];
    if (sources.length === 1 && targets.length === 1) return `${sources[0]} → ${targets[0]}`;
    if (sources.length === 1) return `from ${sources[0]}`;
    if (targets.length === 1) return `to ${targets[0]}`;
    return `${sources.length} accounts`;
}

customElements.define('flows-view', FlowsView);
