/**
 * <test-bench> — the Test Bench section. Two tests of the plan on screen.
 *
 * ── Spending: "how much can this plan spend?" ────────────────────────
 *
 * One question, asked as limits: spend the most that never runs out, leaves
 * at least a floor at the end and, unless switched off, lasts in at least a
 * stated share of simulated markets. The spending solver answers it
 * (spending-solver.js and success-limit.js, in the simulation worker), and
 * the answer is shown three ways:
 *
 *   - a curve of monthly spending against what is left, every point an exact
 *     plan run. It is also the control: a click sets the floor to that point
 *     and asks again;
 *   - a table, the plan as entered beside the most it can spend, with each
 *     column's result across simulated markets and under the Guardrails
 *     section's settings;
 *   - one sentence naming what stopped spending from rising.
 *
 * ── Routing: "is there a better way to route this plan's money?" ─────
 *
 * The user picks a depth, with what it costs shown beside it, and runs it.
 * Each depth is a list of searches (routing-search.js); the result is all of
 * them, ranked by what the plan could spend under the routing each found.
 * The selected one is shown as a table of its changes and as a third column
 * of the spending table.
 *
 * The element changes nothing. "Save as a scenario" asks the app to save the
 * solved amounts, the selected routing, or both as a new scenario; the plan
 * as entered stays as it is.
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
 *   'testbench-save'   { detail: { factor, lifeEvents? } }  `lifeEvents` when a
 *                      routing is saved: the plan's, with the routing written in
 *   'testbench-month'  { detail: { year, month } }
 */

import { LitElement, html, svg, nothing } from 'lit';
import { runTestBench, cancelTestBench, CHECK_SIMULATIONS,
         runRoutingTest, runRoutingChecks, cancelRouting, routingCost } from '../test-bench-run.js';
import { whatStopsYou, riseNote, healthNote, successNote, resultRows, spendingHeadline } from '../spending-report.js';
import { DEPTHS, DEFAULT_DEPTH, rankSearches } from '../routing-search.js';
import { startsLabel, costLine, agreementLine, changeRows, versusEntered, routingHeadline,
         isLoneBest, LONE_BEST_NOTE, DEPTH_NOTES } from '../routing-report.js';
import { formatCompactCurrency, formatCurrency } from '../utils/html.js';

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
        _successOn:      { state: true },
        _successPercent: { state: true },
        _solving:        { state: true },   // { tested, completed, total } while the limit is tested
        _depth:     { state: true },
        _rStatus:   { state: true },   // 'idle' | 'running' | 'done' | 'error'
        _searches:  { state: true },   // [{ start, seed, state, progress, result }]
        _selected:  { state: true },   // the selected row's key; null is the top row
        _rChecks:   { state: true },
        _rProgress: { state: true },
        _rStale:    { state: true },
        _rError:    { state: true },
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
        this._successOn = true;
        this._successPercent = 90;
        this._solving = null;
        this._depth = DEFAULT_DEPTH;
        this._rStatus = 'idle';
        this._searches = null;
        this._selected = null;
        this._rChecks = {};
        this._rProgress = null;
        this._rStale = false;
        this._rError = '';
        this._rFloor = 0;          // the floor the routing test on screen was run with
        this._rPlan = null;        // and the plan it was run on
        this._rRun = null;         // identifies the routing test in flight
        this._rAsked = 0;          // how many searches the test on screen set out to run
        this._rCheckCache = new Map();
        this._cost = null;         // routingCost() of the depth; null means work it out
    }

    createRenderRoot() { return this; }

    disconnectedCallback() {
        super.disconnectedCallback();
        cancelTestBench();
        cancelRouting();
    }

    willUpdate() {
        if (this._cost !== null || !this.ready) return;
        try {
            const plan = this.planSource?.();
            this._cost = plan ? routingCost(plan, this._depth) : undefined;
        } catch {
            this._cost = undefined;
        }
    }

    /** The plan changed: what is on screen describes the plan before it. */
    markStale() {
        if (this._status === 'running') {
            cancelTestBench();
            this._status = this._result ? 'done' : 'idle';
        }
        if (this._result) this._stale = true;
        this._routingOutdated();
        this._cost = null;
    }

    /** The routing test on screen no longer describes the plan or the floor. */
    _routingOutdated() {
        this._stopRouting();
        if (this._searches) this._rStale = true;
    }

    /** Stop the routing test in flight, keeping the searches that finished. */
    _stopRouting() {
        cancelRouting();
        this._rRun = null;
        if (this._rStatus !== 'running') return;
        const finished = (this._searches ?? []).filter((s) => s.result);
        this._searches = finished.length ? finished : null;
        this._rStatus = finished.length ? 'done' : 'idle';
    }

    /** The Stop button: the list so far stands, and its top routing is checked. */
    _onStop() {
        this._stopRouting();
        this._cost = null;
        if (this._rStatus === 'done') this._checkSelected();
    }

    async run() {
        const plan = this.planSource?.();
        if (!plan) return;
        this._status = 'running';
        this._error = '';
        this._checks = {};
        this._progress = {};
        this._solving = null;
        this._stale = false;
        const floor = this._floor;
        const success = this._successOn ? this._successPercent / 100 : 0;
        // A routing is ranked against a floor: another floor, another test.
        if (this._searches && floor !== this._rFloor) this._routingOutdated();
        try {
            await runTestBench(plan, { floor, success }, {
                solving: (tested, completed, total) => { this._solving = { tested, completed, total }; },
                solved: (result) => {
                    this._cost = null;   // a plan run has been timed
                    this._result = result;
                    this._status = 'done';
                    this._solving = null;
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

    // ── The routing test ────────────────────────────────────────────

    async runRouting() {
        const plan = this.planSource?.();
        if (!plan) return;
        // The list is read against the spending test's columns, at this floor.
        if (!this._result || this._stale || this._result.limits.floor !== this._floor) this.run();

        const run = (this._rRun = {});
        this._rStatus = 'running';
        this._rError = '';
        this._rStale = false;
        this._rFloor = this._floor;
        this._rPlan = plan;
        this._searches = [];
        this._selected = null;
        this._rChecks = {};
        this._rProgress = null;
        this._rCheckCache = new Map();
        const patch = (index, change) => {
            if (this._rRun !== run) return;
            this._searches = this._searches.map((s, i) => (i === index ? { ...s, ...change } : s));
        };
        try {
            await runRoutingTest(plan, { floor: this._rFloor }, this._depth, {
                started: (searches) => {
                    this._rAsked = searches.length;
                    this._searches = searches.map((s) => ({ ...s, state: 'waiting' }));
                },
                progress: (index, progress) => patch(index, { state: 'running', progress }),
                found: (index, result) => patch(index, result ? { state: 'done', result } : { state: 'failed' }),
            });
            if (this._rRun !== run) return;
            this._rStatus = 'done';
            this._cost = null;   // a search has been timed: the estimate is better now
            this._checkSelected();
        } catch (err) {
            if (this._rRun !== run) return;
            this._rStatus = 'error';
            this._rError = err?.message || String(err);
        }
    }

    /** The finished searches, ranked, and the row on show. */
    _ranked() {
        const ranked = rankSearches((this._searches ?? []).filter((s) => s.result).map((s) => s.result));
        const row = ranked.rows.find((r) => r.key === this._selected) ?? ranked.rows[0] ?? null;
        return { ranked, row };
    }

    /** The selected routing as a column of the table, when it changes anything. */
    _routedColumn() {
        const { row } = this._ranked();
        return row && row.result.best && row.result.changes.length ? row : null;
    }

    /**
     * The most the plan can spend as entered on its own path of returns, when
     * the spending test on screen is for this floor. Routings are ranked on that
     * path, so they are compared with the figure from it, not with the answer
     * the simulated-markets limit lowered.
     */
    _enteredMonthly() {
        const r = this._result;
        const most = r?.fixedBest ?? r?.best;
        return most && !this._stale && r.limits.floor === this._rFloor ? most.monthlySpending : 0;
    }

    _select(key) {
        this._selected = key;
        if (this._rStatus === 'done') this._checkSelected();
    }

    /** Run the selected routing under guardrails and across simulated markets. */
    _checkSelected() {
        const row = this._routedColumn();
        this._rProgress = null;
        if (!row) { this._rChecks = {}; return; }
        const cached = this._rCheckCache.get(row.key);
        if (cached) { this._rChecks = cached; return; }
        this._rChecks = {};
        const run = this._rRun;
        const mine = () => this._rRun === run && this._routedColumn()?.key === row.key;
        runRoutingChecks(this._rPlan, row.result, {
            check: (check, value) => {
                if (!mine()) return;
                this._rChecks = { ...this._rChecks, [check]: value ?? { failed: true } };
                if (this._rChecks.guardrails && this._rChecks.simulations) this._rCheckCache.set(row.key, this._rChecks);
            },
            progress: (completed, total) => { if (mine()) this._rProgress = { completed, total }; },
        });
    }

    _setFloor(value, { rerun = false } = {}) {
        const floor = Math.max(0, Math.round(Number(value) || 0));
        if (floor === this._floor && !rerun) return;
        this._floor = floor;
        if (rerun || this._result) this.run();
    }

    _setSuccess(on, percent) {
        const clamped = Math.max(50, Math.min(99, Math.round(Number(percent) || 90)));
        if (on === this._successOn && clamped === this._successPercent) return;
        this._successOn = on;
        this._successPercent = clamped;
        if (this._result) this.run();
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
        // So is the plan's own-path answer, when the markets limit lowered it.
        for (const best of [this._result?.best, this._result?.fixedBest]) {
            if (best && !funded.some((p) => p.factor === best.factor)) {
                funded.push({ factor: best.factor, monthlySpending: best.monthlySpending, endingReal: best.endingReal });
                funded.sort((a, b) => a.factor - b.factor);
            }
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
                    ${r.fixedBest && r.best ? svg`<circle cx=${px(r.fixedBest.monthlySpending)} cy=${py(r.fixedBest.endingReal)}
                        r="4" class="tb-mark tb-mark-fixed"></circle>` : nothing}
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
                    ${r.fixedBest && r.best ? html`<span><i class="tb-key tb-key-fixed"></i>The most on the plan's own path</span>` : nothing}
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
        const routed = column === 'routed';
        const value = routed ? this._rChecks[check] : this._checks[`${column}.${check}`];
        if (!value) {
            // The routing's checks start once every search has finished.
            if (routed && this._rStatus === 'running') return html`<span class="tb-pending">after the searches</span>`;
            const p = check !== 'simulations' ? null : routed ? this._rProgress : this._progress[column];
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
        // The routing's column belongs beside these only at the floor they share.
        const routed = !this._rStale && this._result.limits.floor === this._rFloor ? this._routedColumn() : null;
        const rows = resultRows(this._result, routed?.result.best);
        const third = (cell) => (routed ? html`<td>${cell()}</td>` : nothing);
        return html`
            <table class="tb-table">
                <thead><tr><th></th><th>As entered</th><th>Spend the most</th>
                    ${routed ? html`<th>With this routing</th>` : nothing}</tr></thead>
                <tbody>
                    ${rows.map((row) => html`<tr><th>${row.label}</th><td>${row.entered}</td><td>${row.best}</td>
                        ${third(() => row.routed)}</tr>`)}
                    <tr><th>In ${CHECK_SIMULATIONS} simulated markets</th>
                        <td>${this._checkCell('entered', 'simulations')}</td>
                        <td>${this._checkCell('best', 'simulations')}</td>
                        ${third(() => this._checkCell('routed', 'simulations'))}</tr>
                    <tr><th title="Under the settings in the Guardrails section, from retirement">With guardrails</th>
                        <td>${this._checkCell('entered', 'guardrails')}</td>
                        <td>${this._checkCell('best', 'guardrails')}</td>
                        ${third(() => this._checkCell('routed', 'guardrails'))}</tr>
                </tbody>
            </table>
            <div class="tb-caption">Today's dollars. Spending is what the plan pays out to live on; taxes are not in it.</div>`;
    }

    /** spendingHeadline()'s sentence, with the figure in bold. */
    _headline() {
        const best = this._result.best;
        const text = spendingHeadline(this._result);
        if (!best) return text;
        const figure = `${formatCurrency(best.monthlySpending)} a month`;
        const [before, after] = text.split(figure);
        return html`${before}<strong>${figure}</strong>${after}`;
    }

    _renderResult() {
        const result = this._result;
        const stops = whatStopsYou(result);
        const confirm = this._checks['best.confirm'];
        const confirmNote = !result.success || !result.best ? null
            : !confirm ? `Running the answer across 1,000 simulated markets${this._progress.confirm
                ? ` (${this._progress.confirm.completed} of ${this._progress.confirm.total})` : ''}…`
            : confirm.failed ? null
            : `Across 1,000 simulated markets the answer lasts in ${confirm.percent}%.`;
        const notes = [successNote(result), confirmNote, riseNote(result), healthNote(result)].filter(Boolean);
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

    // ── The routing test, drawn ─────────────────────────────────────

    _renderRoutingList(ranked, selected) {
        const entered = this._enteredMonthly();
        const waiting = (this._searches ?? []).filter((s) => !s.result);
        // Marked once every search is in: early in a test the first result is always alone.
        const lone = this._rStatus === 'done' && isLoneBest(ranked);
        const pending = (s) => (s.state === 'failed' ? 'could not run'
            : s.state === 'waiting' || !s.progress?.runs ? (s.state === 'waiting' ? 'waiting for a free core' : 'starting…')
            : `${s.progress.runs.toLocaleString('en-US')} plan runs`
              + (s.progress.gain > 0.0005 ? `, +${(s.progress.gain * 100).toFixed(1)}% so far` : ''));
        return html`
            <table class="tb-table tb-list">
                <thead><tr><th></th><th>Search started from</th><th>The plan could spend</th>
                    <th>Against yours</th><th>Changes</th></tr></thead>
                <tbody>
                    ${ranked.rows.map((row, i) => html`
                        <tr class="${row === selected ? 'is-selected' : ''} ${lone && i === 0 ? 'is-lone' : ''}"
                            @click=${() => this._select(row.key)}>
                            <td><input type="radio" name="tb-routing" aria-label="Show routing ${i + 1}"
                                       .checked=${row === selected} @change=${() => this._select(row.key)}></td>
                            <th>${startsLabel(row.starts)}
                                ${lone && i === 0 ? html`<span class="tb-lone" title=${LONE_BEST_NOTE}>Alone at the top</span>` : nothing}</th>
                            <td>${row.result.best ? `${formatCurrency(row.monthly)}/mo` : 'runs out'}</td>
                            <td>${versusEntered(row.monthly, entered) || '—'}</td>
                            <td>${row.result.changes.length || 'none'}</td>
                        </tr>`)}
                    ${waiting.map((s) => html`
                        <tr class="tb-list-pending"><td></td><th>${startsLabel([s])}</th>
                            <td colspan="3"><span class="tb-pending">${pending(s)}</span></td></tr>`)}
                </tbody>
            </table>`;
    }

    _renderChanges(row) {
        const result = row.result;
        const rows = changeRows(result.changes);
        const blocked = this._rStale || this._rStatus !== 'done' || !this.canSave;
        const why = this._rStale ? 'Run the routing test again first: the plan, its settings or the floor changed'
            : this._rStatus !== 'done' ? 'The searches are still running'
            : !this.canSave ? 'Save the plan on screen as a scenario first'
            : 'Saves a new scenario. The plan on screen is not changed.';
        const save = (factor) => this.dispatchEvent(new CustomEvent('testbench-save',
            { detail: { factor, lifeEvents: result.lifeEvents }, bubbles: true }));
        return html`
            <p class="tb-headline tb-routing-headline">${routingHeadline(result, this._enteredMonthly())}</p>
            ${rows.length ? html`
                <table class="tb-table tb-changes">
                    <thead><tr><th>Phase</th><th>From</th><th>To</th><th>Now</th><th>Proposed</th></tr></thead>
                    <tbody>${rows.map((c) => html`<tr><th>${c.phase}</th><td>${c.from}</td><td>${c.to}</td>
                        <td>${c.now}</td><td>${c.proposed}</td></tr>`)}</tbody>
                </table>
                <div class="tb-caption">The share of each income paid into an account, and of each expense paid from one.
                    Draws on retirement accounts before 60 are left as you entered them. Routings are found and compared on
                    the plan's own path of returns; the simulated-markets limit is not applied to them.</div>
                <div class="tb-actions">
                    <button type="button" class="btn-modern outline text-sm" title=${why} ?disabled=${blocked}
                            @click=${() => save(1)}>Save this routing as a scenario</button>
                    ${result.best ? html`<button type="button" class="btn-modern outline text-sm" title=${why}
                            ?disabled=${blocked} @click=${() => save(result.best.factor)}>Save it with its spending</button>` : nothing}
                </div>` : nothing}`;
    }

    _renderRouting() {
        const running = this._rStatus === 'running';
        const cost = this._cost;
        const nothingToRoute = cost && cost.genes === 0;
        const { ranked, row } = this._ranked();
        const total = this._searches?.length ?? 0;
        return html`
            <div class="tb-routing">
                <div class="slot-heading tb-routing-heading">Routing: is there a better way to route this plan's money?</div>
                <div class="tb-ask">
                    <label class="tb-depth">Depth
                        <select aria-label="How many searches to run" ?disabled=${running}
                                @change=${(ev) => { this._depth = Number(ev.target.value); this._cost = null; }}>
                            ${DEPTHS.map((d) => html`<option value=${d} ?selected=${d === this._depth}>${d}</option>`)}
                        </select>
                    </label>
                    <span class="tb-ask-text">${nothingToRoute
                        ? 'This plan has no income or expense the search could route differently.'
                        : cost ? html`<strong>${costLine(cost)}.</strong> ${DEPTH_NOTES[this._depth]}` : DEPTH_NOTES[this._depth]}</span>
                    ${running
                        ? html`<button type="button" class="btn-modern outline text-sm tb-run"
                                       @click=${() => this._onStop()}>Stop</button>`
                        : html`<button type="button" class="btn-modern primary text-sm tb-run"
                                       ?disabled=${!this.ready || nothingToRoute}
                                       title=${this.ready ? '' : 'Add assets to run the test'}
                                       @click=${() => this.runRouting()}>&#9654; Search</button>`}
                </div>
                ${this._rStatus === 'error' ? html`<p class="tb-error">The test failed: ${this._rError}</p>` : nothing}
                ${this._searches ? html`
                    <div class="tb-result ${this._rStale ? 'is-stale' : ''}" title=${this._rStale ? 'From before your latest change' : ''}>
                        <div class="tb-routing-body">
                            ${this._renderRoutingList(ranked, row)}
                            <p class="tb-note">${running
                                ? `${ranked.searches} of ${total} searches finished. The list is ranked as they come in.`
                                : (total < this._rAsked ? `Stopped with ${total} of ${this._rAsked} searches finished. ` : '')
                                  + agreementLine(ranked)}</p>
                            ${row ? this._renderChanges(row) : nothing}
                        </div>
                        ${this._rStale ? html`<p class="tb-sub">The plan, its settings or the floor changed after this test. Search again.</p>` : nothing}
                    </div>`
                : html`<p class="tb-sub">Tries other ways to split each income across accounts and to pay each expense, and ranks
                    them by what the plan could then spend. A deeper test runs more searches and takes longer; it all runs on this
                    machine. Nothing in your plan is changed.</p>`}
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
                <span class="tb-ask-text">at the end, in today's dollars,</span>
                <label class="tb-success-field">
                    <input type="checkbox" aria-label="Require the plan to last in a share of simulated markets"
                           .checked=${this._successOn}
                           @change=${(ev) => this._setSuccess(ev.target.checked, this._successPercent)}>
                    and lasts in
                    <input type="text" inputmode="numeric" aria-label="Share of simulated markets, percent"
                           ?disabled=${!this._successOn} .value=${String(this._successPercent)}
                           @change=${(ev) => { this._setSuccess(this._successOn, ev.target.value.replace(/[^0-9]/g, ''));
                                               ev.target.value = String(this._successPercent); }}>%
                    of simulated markets.
                </label>
                <button type="button" class="btn-modern primary text-sm tb-run" ?disabled=${!this.ready || running}
                        title=${this.ready ? '' : 'Add assets to run the test'}
                        @click=${() => this.run()}>${running ? 'Running…' : html`&#9654; Run`}</button>
            </div>
            ${this._status === 'error' ? html`<p class="tb-error">The test failed: ${this._error}</p>` : nothing}
            ${running && this._solving ? html`<p class="tb-sub tb-solving">Testing spending level ${this._solving.tested + 1}
                across ${this._solving.total} simulated markets (${this._solving.completed} of ${this._solving.total}).
                Each level takes about ten seconds; at most ten are tested.</p>` : nothing}
            ${this._result ? this._renderResult()
                : running ? (this._solving ? nothing : html`<p class="tb-sub">Running the plan at 40 spending levels…</p>`)
                : html`<p class="tb-sub">Turns every monthly expense up and down together, health plan included,
                    and finds the highest level the plan can pay for. With the simulated-markets limit on, it then
                    tests levels across 300 simulated markets, which takes from ten seconds to about two minutes.
                    Nothing in your plan is changed.</p>`}
            ${this._renderRouting()}`;
    }
}

customElements.define('test-bench', TestBench);
