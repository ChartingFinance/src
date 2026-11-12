/**
 * <test-bench> — the Test Bench section: "how much can this plan spend?"
 *
 * One question, asked as limits: spend the most that never runs out and leaves
 * at least a floor at the end. The spending solver answers it (spending-
 * solver.js, in the simulation worker), and the answer is shown three ways:
 *
 *   - a curve of monthly spending against what is left, every point an exact
 *     plan run. It is also the control: a click sets the floor to that point
 *     and asks again;
 *   - a table, the plan as entered beside the most it can spend, with each
 *     column's result across simulated markets and under the Guardrails
 *     section's settings;
 *   - one sentence naming what stopped spending from rising.
 *
 * The element changes nothing. "Save as a scenario" asks the app to save the
 * solved amounts as a new scenario; the plan as entered stays as it is.
 *
 * Properties:
 *   planSource  () => plan for runTestBench(), read when a test starts
 *   ready       boolean — there is a plan to test
 *   canSave     boolean — a scenario can be saved now
 *
 * Methods:
 *   markStale()  the plan changed; the result on screen is from before it
 *
 * Dispatches:
 *   'testbench-save'   { detail: { factor } }
 *   'testbench-month'  { detail: { year, month } }
 */

import { LitElement, html, svg, nothing } from 'lit';
import { runTestBench, cancelTestBench, CHECK_SIMULATIONS } from '../test-bench-run.js';
import { whatStopsYou, riseNote, healthNote, resultRows } from '../spending-report.js';
import { formatCompactCurrency, formatCurrency, MINUS } from '../utils/html.js';

// The curve's drawing area, in viewBox units.
const W = 480, H = 200;
const PAD = { left: 52, right: 14, top: 14, bottom: 24 };

class TestBench extends LitElement {
    static properties = {
        ready:     { type: Boolean },
        canSave:   { type: Boolean },
        _floor:    { state: true },
        _status:   { state: true },   // 'idle' | 'running' | 'done' | 'error'
        _result:   { state: true },
        _checks:   { state: true },
        _progress: { state: true },
        _stale:    { state: true },
        _error:    { state: true },
        _hover:    { state: true },
    };

    constructor() {
        super();
        this.planSource = null;
        this.ready = false;
        this.canSave = true;
        this._floor = 0;
        this._status = 'idle';
        this._result = null;
        this._checks = {};
        this._progress = {};
        this._stale = false;
        this._error = '';
        this._hover = null;
    }

    createRenderRoot() { return this; }

    disconnectedCallback() {
        super.disconnectedCallback();
        cancelTestBench();
    }

    /** The plan changed: what is on screen describes the plan before it. */
    markStale() {
        if (this._status === 'running') {
            cancelTestBench();
            this._status = this._result ? 'done' : 'idle';
        }
        if (this._result) this._stale = true;
    }

    async run() {
        const plan = this.planSource?.();
        if (!plan) return;
        this._status = 'running';
        this._error = '';
        this._checks = {};
        this._progress = {};
        this._stale = false;
        const floor = this._floor;
        try {
            await runTestBench(plan, { floor }, {
                solved: (result) => {
                    this._result = result;
                    this._status = 'done';
                    this._hover = null;
                },
                check: (column, check, value) => {
                    this._checks = { ...this._checks, [`${column}.${check}`]: value ?? { failed: true } };
                },
                progress: (column, completed, total) => {
                    this._progress = { ...this._progress, [column]: { completed, total } };
                },
            });
        } catch (err) {
            this._status = 'error';
            this._error = err?.message || String(err);
        }
    }

    _setFloor(value, { rerun = false } = {}) {
        const floor = Math.max(0, Math.round(Number(value) || 0));
        if (floor === this._floor && !rerun) return;
        this._floor = floor;
        if (rerun || this._result) this.run();
    }

    _onFloorInput(ev) {
        const digits = ev.target.value.replace(/[^0-9.]/g, '');
        this._setFloor(digits);
        ev.target.value = this._floor.toLocaleString('en-US');
    }

    // ── The curve ───────────────────────────────────────────────────

    /** The funded points and the scales that place them, or null. */
    _plot() {
        const funded = (this._result?.curve ?? []).filter((p) => !p.runsOut);
        // The answer is refined past the last sampled level that passed, so
        // it is a point of its own on the line.
        const best = this._result?.best;
        if (best && !funded.some((p) => p.factor === best.factor)) {
            funded.push({ factor: best.factor, monthlySpending: best.monthlySpending, endingReal: best.endingReal });
            funded.sort((a, b) => a.factor - b.factor);
        }
        if (funded.length < 2) return null;
        const xs = funded.map((p) => p.monthlySpending);
        const ys = funded.map((p) => p.endingReal);
        const x0 = Math.min(...xs), xLast = Math.max(...xs);
        const hasEdge = this._result.curve.some((p) => p.runsOut);
        // Room on the right for the "runs out" area, when there is an edge.
        const x1 = xLast + (hasEdge ? (xLast - x0) * 0.14 : 0);
        const y0 = Math.min(0, ...ys);
        const y1 = Math.max(...ys, this._result.limits.floor, 1);
        const px = (x) => PAD.left + (x - x0) / ((x1 - x0) || 1) * (W - PAD.left - PAD.right);
        const py = (y) => H - PAD.bottom - (y - y0) / ((y1 - y0) || 1) * (H - PAD.top - PAD.bottom);
        return { funded, x0, x1, xLast, y0, y1, px, py, hasEdge };
    }

    _nearest(ev, plot) {
        const box = ev.currentTarget.getBoundingClientRect();
        const x = (ev.clientX - box.left) / box.width * W;
        let best = 0;
        plot.funded.forEach((p, i) => {
            if (Math.abs(plot.px(p.monthlySpending) - x) < Math.abs(plot.px(plot.funded[best].monthlySpending) - x)) best = i;
        });
        return best;
    }

    _renderCurve() {
        const plot = this._plot();
        if (!plot) return nothing;
        const { funded, px, py, y0, y1, x0, xLast, hasEdge } = plot;
        const r = this._result;
        const line = funded.map((p, i) => `${i ? 'L' : 'M'}${px(p.monthlySpending).toFixed(1)},${py(p.endingReal).toFixed(1)}`).join(' ');
        const bottom = H - PAD.bottom;
        const edgeX = px(xLast);
        const hover = this._hover != null ? funded[this._hover] : null;
        const mark = (column, filled) => {
            if (!column || column.runsOut) return nothing;
            return svg`<circle cx=${px(column.monthlySpending)} cy=${py(column.endingReal)} r="4.5"
                               class=${filled ? 'tb-mark tb-mark-best' : 'tb-mark'}></circle>`;
        };

        return html`
            <div class="tb-curve">
                <svg viewBox="0 0 ${W} ${H}" role="img"
                     aria-label="Monthly spending against what is left at the end. Click a point to set the least to leave."
                     @pointermove=${(ev) => { this._hover = this._nearest(ev, plot); }}
                     @pointerleave=${() => { this._hover = null; }}
                     @click=${(ev) => {
                         const p = funded[this._nearest(ev, plot)];
                         this._setFloor(Math.floor(Math.max(0, p.endingReal) / 1000) * 1000, { rerun: true });
                     }}>
                    <defs>
                        <pattern id="tb-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                            <line x1="0" y1="0" x2="0" y2="6" class="tb-hatch-line"></line>
                        </pattern>
                    </defs>
                    <line x1=${PAD.left} y1=${py(0)} x2=${W - PAD.right} y2=${py(0)} class="tb-axis"></line>
                    <line x1=${PAD.left} y1=${PAD.top} x2=${PAD.left} y2=${bottom} class="tb-axis"></line>
                    ${hasEdge ? svg`
                        <rect x=${edgeX} y=${PAD.top} width=${W - PAD.right - edgeX} height=${bottom - PAD.top} fill="url(#tb-hatch)"></rect>
                        <text x=${(edgeX + W - PAD.right) / 2} y=${PAD.top + 14} text-anchor="middle" class="tb-edge-label">runs out</text>` : nothing}
                    ${r.limits.floor > 0 ? svg`
                        <line x1=${PAD.left} y1=${py(r.limits.floor)} x2=${edgeX} y2=${py(r.limits.floor)} class="tb-floor"></line>` : nothing}
                    <path d=${line} class="tb-line"></path>
                    ${hover ? svg`
                        <line x1=${px(hover.monthlySpending)} y1=${PAD.top} x2=${px(hover.monthlySpending)} y2=${bottom} class="tb-guide"></line>
                        <circle cx=${px(hover.monthlySpending)} cy=${py(hover.endingReal)} r="3.5" class="tb-hover"></circle>` : nothing}
                    ${mark(r.asEntered, false)}
                    ${mark(r.best, true)}
                    <text x=${PAD.left - 6} y=${py(y1) + 4} text-anchor="end" class="tb-tick">${formatCompactCurrency(y1)}</text>
                    <text x=${PAD.left - 6} y=${py(0) + 4} text-anchor="end" class="tb-tick">$0</text>
                    ${y0 < 0 ? svg`<text x=${PAD.left - 6} y=${py(y0) + 4} text-anchor="end" class="tb-tick">${formatCompactCurrency(y0)}</text>` : nothing}
                    <text x=${PAD.left} y=${H - 6} class="tb-tick">${formatCurrency(x0)}/mo</text>
                    <text x=${edgeX} y=${H - 6} text-anchor="end" class="tb-tick">${formatCurrency(xLast)}/mo</text>
                </svg>
                <div class="tb-legend">
                    <span><i class="tb-key"></i>${r.asEntered.runsOut ? 'As entered: runs out' : 'As entered'}</span>
                    ${r.best ? html`<span><i class="tb-key tb-key-best"></i>The most you can spend</span>` : nothing}
                    ${r.limits.floor > 0 ? html`<span><i class="tb-key tb-key-floor"></i>Leaves at least ${formatCompactCurrency(r.limits.floor)}</span>` : nothing}
                </div>
                <div class="tb-readout">
                    ${hover
                        ? html`Spending <strong>${formatCurrency(hover.monthlySpending)}</strong> a month leaves
                               <strong>${formatCompactCurrency(hover.endingReal)}</strong>. Click to leave at least that.`
                        : html`Monthly spending against what is left at the end, in today's dollars. Click the curve to set the least to leave.`}
                </div>
            </div>`;
    }

    // ── The table ───────────────────────────────────────────────────

    _checkCell(column, check) {
        if (column === 'best' && !this._result.best) return '—';
        const value = this._checks[`${column}.${check}`];
        if (!value) {
            const p = check === 'simulations' ? this._progress[column] : null;
            return html`<span class="tb-pending">${p ? `${p.completed} of ${p.total}…` : '…'}</span>`;
        }
        if (value.failed) return html`<span class="tb-pending">could not run</span>`;
        if (check === 'simulations') {
            return html`<span class="tb-tone-${value.tone}">${value.percent}%</span> last`;
        }
        const events = [
            value.cuts ? `${value.cuts} ${value.cuts === 1 ? 'cut' : 'cuts'}` : null,
            value.raises ? `${value.raises} ${value.raises === 1 ? 'raise' : 'raises'}` : null,
        ].filter(Boolean).join(', ') || 'no changes';
        return html`${value.endReal != null ? formatCompactCurrency(value.endReal) : '—'} left
            <span class="tb-sub">${events}</span>`;
    }

    _renderTable() {
        const rows = resultRows(this._result);
        return html`
            <table class="tb-table">
                <thead><tr><th></th><th>As entered</th><th>Spend the most</th></tr></thead>
                <tbody>
                    ${rows.map((row) => html`<tr><th>${row.label}</th><td>${row.entered}</td><td>${row.best}</td></tr>`)}
                    <tr><th>In ${CHECK_SIMULATIONS} simulated markets</th>
                        <td>${this._checkCell('entered', 'simulations')}</td>
                        <td>${this._checkCell('best', 'simulations')}</td></tr>
                    <tr><th title="Under the settings in the Guardrails section, from retirement">With guardrails</th>
                        <td>${this._checkCell('entered', 'guardrails')}</td>
                        <td>${this._checkCell('best', 'guardrails')}</td></tr>
                </tbody>
            </table>
            <div class="tb-caption">Today's dollars. Spending is what the plan pays out to live on; taxes are not in it.</div>`;
    }

    _headline() {
        const { asEntered, best } = this._result;
        if (!best) return html`No spending level tested keeps these limits.`;
        const change = best.monthlySpending - asEntered.monthlySpending;
        const percent = asEntered.monthlySpending ? Math.round(change / asEntered.monthlySpending * 100) : 0;
        const versus = Math.abs(change) < 1
            ? 'the same as you entered'
            : `${formatCurrency(Math.abs(change))} a month ${change > 0 ? 'more' : 'less'} than you entered`
              + ` (${percent > 0 ? '+' : percent < 0 ? MINUS : ''}${Math.abs(percent)}%)`;
        return html`The most this plan can spend is <strong>${formatCurrency(best.monthlySpending)} a month</strong>, ${versus}.`;
    }

    _renderResult() {
        const result = this._result;
        const stops = whatStopsYou(result);
        const notes = [riseNote(result), healthNote(result)].filter(Boolean);
        const saveTitle = !result.best ? 'No spending level kept the limits'
            : this._stale ? 'Run the test again first: the plan or its settings changed'
            : !this.canSave ? 'Save the plan on screen as a scenario first'
            : 'Saves these amounts as a new scenario. The plan on screen is not changed.';
        return html`
            <div class="tb-result ${this._stale ? 'is-stale' : ''}" title=${this._stale ? 'From before your latest change' : ''}>
                <p class="tb-headline">${this._headline()}</p>
                <div class="tb-grid">
                    ${this._renderCurve()}
                    <div>${this._renderTable()}</div>
                </div>
                <p class="tb-stops">
                    <span class="tb-stops-label">What stops it</span>
                    ${stops.text}
                    ${stops.year ? html`<button type="button" class="tb-link"
                        @click=${() => this.dispatchEvent(new CustomEvent('testbench-month',
                            { detail: { year: stops.year, month: stops.month }, bubbles: true }))}>Show that month</button>` : nothing}
                </p>
                ${notes.map((note) => html`<p class="tb-note">${note}</p>`)}
                <div class="tb-actions">
                    <button type="button" class="btn-modern outline text-sm" title=${saveTitle}
                            ?disabled=${!result.best || this._stale || !this.canSave}
                            @click=${() => this.dispatchEvent(new CustomEvent('testbench-save',
                                { detail: { factor: result.best.factor }, bubbles: true }))}>Save as a scenario</button>
                    ${this._stale ? html`<span class="tb-sub">The plan or its settings changed after this test. Run it again.</span>` : nothing}
                </div>
            </div>`;
    }

    render() {
        const running = this._status === 'running';
        return html`
            <div class="tb-ask">
                <span class="tb-ask-text">Spend the most that <strong>never runs out</strong> and leaves at least</span>
                <label class="tb-floor-field">$
                    <input type="text" inputmode="numeric" aria-label="Least to leave at the end, in today's dollars"
                           .value=${this._floor.toLocaleString('en-US')}
                           @change=${this._onFloorInput}>
                </label>
                <span class="tb-ask-text">at the end, in today's dollars.</span>
                <button type="button" class="btn-modern primary text-sm tb-run" ?disabled=${!this.ready || running}
                        title=${this.ready ? '' : 'Add assets to run the test'}
                        @click=${() => this.run()}>${running ? 'Running…' : html`&#9654; Run`}</button>
            </div>
            ${this._status === 'error' ? html`<p class="tb-error">The test failed: ${this._error}</p>` : nothing}
            ${this._result ? this._renderResult()
                : running ? html`<p class="tb-sub">Running the plan at 40 spending levels…</p>`
                : html`<p class="tb-sub">Turns every monthly expense up and down together, health plan included,
                    and finds the highest level the plan can pay for. Nothing in your plan is changed.</p>`}`;
    }
}

customElements.define('test-bench', TestBench);
