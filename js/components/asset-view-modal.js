/**
 * <asset-view-modal>
 *
 * READ SURFACE for a single asset — the counterpart to <asset-form-modal>,
 * which is write-only.  Nothing here is editable, and nothing here is ever fed
 * back into a ModelAsset: every number is simulation output, read from metric
 * history at the date the user is exploring.
 *
 * Three nested windows over the same metric set, all ending at the month the
 * user is exploring:
 *   month  — the selected month
 *   year   — Jan of the selected year through the selected month
 *   total  — plan start through the selected month
 *
 * Windows combine per metricKind() (metric.js): balances snapshot, flows sum,
 * running totals difference.  aggregateMetric() owns that rule so this
 * component never decides it.
 *
 * Properties:
 *   open         - boolean
 *   modelAsset   - ModelAsset
 *   firstDateInt - DateInt of history index 0 (portfolio.firstDateInt)
 *   atDateInt    - DateInt the user is exploring
 *   historyIndex - month offset of atDateInt into history
 *
 * Dispatches: 'close'
 */

import { LitElement, html, nothing } from 'lit';
import {
    Metric, MetricLabel, MetricKind, metricKind, aggregateMetric, MetricRollups,
} from '../metric.js';
import { InstrumentMeta, InstrumentType } from '../instruments/instrument.js';
import { global_home_sale_capital_gains_discount } from '../globals.js';
import { DateInt, MONTH_NAMES } from '../utils/date-int.js';
import { formatCurrency } from '../utils/html.js';

const TABS = [
    { key: 'month', label: 'This month' },
    { key: 'year',  label: 'This year' },
    { key: 'total', label: 'Life to date' },
];

/**
 * MetricLabel is written for the portfolio rollup, where VALUE is the sum of
 * everything and "Net Worth" is right.  On one asset it is that asset's
 * balance, so override here rather than changing the shared label.
 */
const PER_ASSET_LABEL = Object.freeze({
    [Metric.VALUE]: 'Value',
    [Metric.CASH_FLOW_ACCUMULATED]: 'Cash Flow (accumulated)',
});

function labelFor(metricName) {
    return PER_ASSET_LABEL[metricName] ?? MetricLabel[metricName] ?? metricName;
}

/**
 * What VALUE means for this instrument.
 *
 * On a balance-sheet asset finishCurrency is a balance that carries forward.
 * On a monthly income or expense it is the recurring amount for that month —
 * a rate, not a stock — so calling the section "Balance" would misread the
 * one number most people look at first.
 */
function levelSectionTitle(instrument) {
    if (InstrumentType.isMonthlyIncome(instrument))  return 'Monthly amount';
    if (InstrumentType.isMonthlyExpense(instrument)) return 'Monthly amount';
    return 'Balance at this month';
}

class AssetViewModal extends LitElement {

    static properties = {
        open:         { type: Boolean, reflect: true },
        modelAsset:   { type: Object },
        modelAssets:  { type: Array },      // siblings — needed to name where tax was settled
        firstDateInt: { type: Object },
        atDateInt:    { type: Object },
        historyIndex: { type: Number },
        _tab:         { state: true },
    };

    createRenderRoot() { return this; }

    constructor() {
        super();
        this.open = false;
        this.modelAsset = null;
        this.modelAssets = [];
        this.firstDateInt = null;
        this.atDateInt = null;
        this.historyIndex = -1;
        this._tab = 'month';
    }

    updated(changed) {
        // Always open on the month tab.  The modal is anchored to the date the
        // user is exploring, so the narrowest window is the natural entry point;
        // silently reopening on a window they chose several assets ago makes the
        // headline numbers look wrong.
        if (changed.has('open') && this.open) this._tab = 'month';
    }

    // ── Derived data ─────────────────────────────────────────────────

    get _historyLength() {
        return this.modelAsset?.getHistory?.(Metric.VALUE)?.length ?? 0;
    }

    /**
     * Metrics worth a row: those this instrument tracks AND that are non-zero
     * somewhere in the plan.  Filtering on the whole history rather than on the
     * selected month keeps the row set stable as the user scrubs dates — a
     * table that grows and shrinks under the cursor is unreadable.
     *
     * Balances first, then flows; original relevantMetrics() order within each.
     */
    get _rows() {
        const ma = this.modelAsset;
        if (!ma?.behavior) return [];

        const used = [];
        for (const name of ma.behavior.relevantMetrics()) {
            const history = ma.getHistory(name);
            if (!history || history.length === 0) continue;
            if (!history.some(v => (v ?? 0) !== 0)) continue;
            used.push({ name, kind: metricKind(name), history });
        }

        const isBalance = (r) => r.kind !== MetricKind.FLOW;
        return [...used.filter(isBalance), ...used.filter(r => !isBalance(r))];
    }

    /**
     * Arrange rows into the rollup DAG's own shape: each metric nested under
     * the parent it feeds, when that parent is also on screen for this asset.
     *
     * The engine already knows these edges — MetricRollups is what addToMetric()
     * propagates along — so a total and its parts stack up visually instead of
     * repeating the same figure on four unrelated-looking lines.
     *
     * Two shapes in the table need care: a metric may declare several parents
     * (it is a DAG, not a tree), so a row is nested under the first parent that
     * is on screen and appears once. Self-edges and cycles are skipped — the
     * table has none today, but a walk that trusts it would hang rather than
     * misrender, so the guards stay.
     */
    _tree(rows) {
        const shown = new Map(rows.map(r => [r.name, r]));
        const children = new Map();
        const nested = new Set();

        for (const row of rows) {
            for (const parent of (MetricRollups[row.name] ?? [])) {
                if (parent === row.name || !shown.has(parent)) continue;
                if (!children.has(parent)) children.set(parent, []);
                children.get(parent).push(row);
                nested.add(row.name);
                break;
            }
        }

        return { roots: rows.filter(r => !nested.has(r.name)), children };
    }

    /**
     * Inclusive [from, to] history window for the active tab.
     *
     * The three windows nest — month ⊆ year ⊆ life — all ending at the month
     * the user is exploring.  The year window is year-to-date rather than the
     * full calendar year for that reason: a tab that reached past the cursor
     * into months the user has not scrubbed to would not agree with the others.
     */
    _window() {
        const to = Math.min(this.historyIndex, this._historyLength - 1);
        if (this._tab === 'month') return [to, to];
        if (this._tab === 'year') {
            const jan = (this.firstDateInt && this.atDateInt)
                ? DateInt.diffMonths(this.firstDateInt, DateInt.from(this.atDateInt.year, 1))
                : 0;
            return [Math.max(0, jan), to];
        }
        return [0, to];
    }

    /** First calendar month the year window actually covers (plan may start mid-year). */
    get _yearStartMonth() {
        if (!this.atDateInt || !this.firstDateInt) return 1;
        return this.atDateInt.year === this.firstDateInt.year ? this.firstDateInt.month : 1;
    }

    /**
     * Runtime confirmation that a tax rule fired.
     *
     * A rule that works silently is indistinguishable from a rule that never
     * ran — a Roth showing no tax looks identical to a bug, and a pension
     * showing no tax looks identical to evasion. Say which it is, in the place
     * the number is missing.
     *
     * Every note is derived from recorded history, never recomputed: a note may
     * only describe an amount the engine actually booked. Splitting the
     * household true-up across the incomes that caused it would be inventing an
     * allocation the engine never made, so these notes name the counterparty and
     * stop there.
     */
    _ruleNotes(from, to) {
        const ma = this.modelAsset;
        if (!ma) return [];

        const notes = [];
        const total = (metric) => aggregateMetric(ma.getHistory(metric), metric, from, to);
        const income = total(Metric.INCOME);
        const taxes = total(Metric.TAXES);

        // Whether something above has already accounted for an absent tax. A
        // second note offering a different reason for the same zero reads as a
        // contradiction, so the specific explanation wins over the general one.
        let zeroTaxExplained = false;

        // Roth: no tax is the feature, not an omission.
        if (InstrumentType.isTaxFree(ma.instrument) && income !== 0) {
            notes.push({
                emoji: '\u{1F6E1}\u{FE0F}',
                text: 'Qualified Roth withdrawals are tax-free — no income tax is due on this money, and none was charged.',
            });
            zeroTaxExplained = true;
        }

        // Primary-home exclusion: only reachable after 24 months (taxes.js:454),
        // and only visible once a gain has actually been realised. It explains a
        // missing tax only when the gain fell entirely inside the exclusion.
        if (InstrumentType.isRealEstate(ma.instrument) && ma.isPrimaryHome
            && total(Metric.LONG_TERM_CAPITAL_GAIN) !== 0) {
            notes.push({
                emoji: '\u{1F3E1}',
                text: `Primary home sold after more than two years — the first ${formatCurrency(global_home_sale_capital_gains_discount)} of gain is excluded before capital gains tax.`,
            });
            if (taxes === 0) zeroTaxExplained = true;
        }

        // Income whose tax was settled somewhere else entirely.
        if (income !== 0 && taxes === 0 && !zeroTaxExplained) {
            const settlers = this._settlingAccounts(from, to);
            const where = settlers.length === 1 ? settlers[0].displayName
                        : settlers.length > 1 ? 'your funding accounts'
                        : null;
            notes.push({
                emoji: '\u{1F9FE}',
                text: where
                    ? `Tax is not withheld from this income. The household's tax on it is settled from ${where}.`
                    : 'Tax is not withheld from this income. The household\'s tax on it is settled at the annual true-up.',
            });
        }

        return notes;
    }

    /**
     * Assets that paid estimated income tax in this window — the true-up debits
     * the funding account and books ESTIMATED_INCOME_TAX there, so a non-zero
     * value IS the settlement, resolved per month rather than guessed from
     * today's account list.
     */
    _settlingAccounts(from, to) {
        const out = [];
        for (const a of (this.modelAssets ?? [])) {
            if (a === this.modelAsset) continue;
            const h = a.getHistory?.(Metric.ESTIMATED_INCOME_TAX);
            if (!h) continue;
            if (aggregateMetric(h, Metric.ESTIMATED_INCOME_TAX, from, to) !== 0) out.push(a);
        }
        return out;
    }

    /** "Jan–Jun 2033", or "Jun 2033" when the window is a single month. */
    get _yearRangeLabel() {
        if (!this.atDateInt) return '';
        const from = this._yearStartMonth;
        const to = this.atDateInt.month;
        const year = this.atDateInt.year;
        return from === to
            ? `${MONTH_NAMES[to - 1]} ${year}`
            : `${MONTH_NAMES[from - 1]}–${MONTH_NAMES[to - 1]} ${year}`;
    }

    // ── Render ───────────────────────────────────────────────────────

    render() {
        if (!this.open || !this.modelAsset) return html``;

        const ma = this.modelAsset;
        const emoji = InstrumentMeta.get(ma.instrument)?.emoji ?? '';
        const dateLabel = this.atDateInt
            ? `${MONTH_NAMES[this.atDateInt.month - 1]} ${this.atDateInt.year}`
            : null;

        return html`
            <div class="popup fixed inset-0 z-50 flex items-center justify-center p-4"
                 @click=${this._onOverlayClick}>
                <div class="popup-content glass-card p-8 w-full max-w-3xl relative"
                     @click=${(e) => e.stopPropagation()}>
                    <button class="closeBtn absolute top-4 right-4 text-gray-400 hover:text-gray-800 text-2xl"
                        @click=${this._close}>&times;</button>

                    <div class="mb-6">
                        <h2 class="text-2xl font-bold flex items-center gap-2">
                            <span>${emoji}</span>
                            <span>${ma.displayName}</span>
                            ${dateLabel ? html`
                                <span class="badge-phase" style="background: #f3f4f6; color: #6b7280;">
                                    &#x1F552; ${dateLabel}
                                </span>
                            ` : nothing}
                        </h2>
                        <p class="text-gray-500 text-sm mt-1">
                            Simulation results. To change the plan, use Edit on the card.
                        </p>
                    </div>

                    ${this._renderBody()}
                </div>
            </div>
        `;
    }

    _renderBody() {
        if (this._historyLength === 0) {
            return html`
                <p class="text-gray-500 text-sm py-8 text-center">
                    No results yet — run a calculation to see values for this asset.
                </p>
            `;
        }

        return html`
            <div class="flex gap-1 border-b border-gray-200 mb-4">
                ${TABS.map(t => html`
                    <button type="button"
                        class="px-4 py-2 text-sm font-semibold border-b-2 -mb-px cursor-pointer transition
                               ${this._tab === t.key
                                    ? 'border-gray-900 text-gray-900'
                                    : 'border-transparent text-gray-400 hover:text-gray-600'}"
                        @click=${() => { this._tab = t.key; }}>${t.label}</button>
                `)}
            </div>
            ${this._renderMetricList()}
        `;
    }

    /** One layout for all three tabs — same rows, different window. */
    _renderMetricList() {
        const rows = this._rows;
        if (rows.length === 0) {
            return html`<p class="text-gray-500 text-sm py-8 text-center">Nothing recorded for this asset.</p>`;
        }

        const [from, to] = this._window();
        if (to < 0) {
            return html`
                <p class="text-gray-500 text-sm py-8 text-center">
                    This plan starts in ${MONTH_NAMES[this.firstDateInt.month - 1]} ${this.firstDateInt.year} —
                    nothing to show for the selected date.
                </p>
            `;
        }
        const balances = rows.filter(r => r.kind !== MetricKind.FLOW);
        const flows = rows.filter(r => r.kind === MetricKind.FLOW);

        const section = (title, list, [f, t], asTree) => list.length === 0 ? nothing : html`
            <div class="mb-5">
                <div class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">${title}</div>
                <div class="divide-y divide-gray-100">
                    ${asTree ? this._renderTree(list, f, t) : list.map(r => this._renderRow(r, f, t))}
                </div>
            </div>
        `;

        // A balance is always "as of this month", never "during the window" —
        // so it reads from plan start on every tab.  For a LEVEL that is the
        // same number either way; for a RUNNING total it is the difference
        // between a lifetime figure and one month's delta.
        const activityTitle =
            this._tab === 'month' ? 'Activity this month'
            : this._tab === 'year' ? `Activity · ${this._yearRangeLabel}`
            : 'Totals since plan start';

        // Balances carry no rollup edges — a flat list. Flows are the DAG.
        return html`
            ${section(levelSectionTitle(this.modelAsset.instrument), balances, [0, to], false)}
            ${section(activityTitle, flows, [from, to], true)}
            ${this._renderRuleNotes(from, to)}
        `;
    }

    _renderRuleNotes(from, to) {
        const notes = this._ruleNotes(from, to);
        if (notes.length === 0) return nothing;

        return html`
            <div class="mt-4 pt-4 border-t border-gray-100 flex flex-col gap-2">
                ${notes.map(n => html`
                    <p class="text-xs text-gray-500 flex items-start gap-2 leading-relaxed">
                        <span aria-hidden="true">${n.emoji}</span>
                        <span>${n.text}</span>
                    </p>
                `)}
            </div>
        `;
    }

    /** Depth-first walk of the rollup forest; totals above their parts. */
    _renderTree(rows, from, to) {
        const { roots, children } = this._tree(rows);
        const seen = new Set();

        const walk = (row, depth) => {
            if (seen.has(row.name)) return nothing;   // cycle guard
            seen.add(row.name);
            const kids = children.get(row.name) ?? [];
            return html`
                ${this._renderRow(row, from, to, depth, kids.length > 0)}
                ${kids.map(kid => walk(kid, depth + 1))}
            `;
        };

        return roots.map(r => walk(r, 0));
    }

    _renderRow(row, from, to, depth = 0, hasChildren = false) {
        const amount = aggregateMetric(row.history, row.name, from, to);
        const tone = amount < 0 ? 'text-red-600' : amount > 0 ? 'text-gray-900' : 'text-gray-400';

        return html`
            <div class="flex items-baseline justify-between py-1.5 gap-4">
                <span class="text-sm ${depth === 0 ? 'text-gray-700 font-medium' : 'text-gray-500'}"
                      style="padding-left: ${depth * 16}px"
                      title=${hasChildren ? 'Total of the rows indented below' : ''}>
                    ${labelFor(row.name)}
                </span>
                <span class="text-sm font-mono tabular-nums ${tone}">${formatCurrency(amount)}</span>
            </div>
        `;
    }

    // ── Events ───────────────────────────────────────────────────────

    _close() {
        this.open = false;
        this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
    }

    _onOverlayClick(ev) {
        if (ev.target === ev.currentTarget) this._close();
    }
}

customElements.define('asset-view-modal', AssetViewModal);
