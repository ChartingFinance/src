/**
 * <test-bench> — the Test Bench section. Two tests of the plan on screen.
 *
 * ── The layout (spec 18) ─────────────────────────────────────────────
 *
 * Three kinds of lever, three places (test-bench-view.js):
 *
 *   - CONDITIONS, about the world, sit in a card above both tests: the market
 *     outlook and loss years. A new condition is one more row of the card. On
 *     a phone the card collapses to one line, with an Edit button;
 *   - LIMITS belong to the spending test, as a short form on its tab;
 *   - EFFORT (Depth) belongs to the routing test, on its tab.
 *
 * The two tests are tabs of one card. The chart sits under the tabs, never in
 * one, because Chart.js draws at zero size in a hidden element.
 *
 * Nothing runs by itself. Run runs the spending test, Search the routing test,
 * and a click on the curve sets the floor and runs at once. A changed lever
 * dims every result it affects, with one line saying so, until it is run
 * again. Every result opens with a "Found under" line naming the conditions
 * it was found under; nothing else on the page restates them.
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
 * ── The chart: "what does the plan hold over the years?" ──────────────
 *
 * Under both tests, one column of the result table drawn as Macro
 * Projection's bars: what each top-level group holds at the end of each
 * period, in today's dollars, so the last bar's total is the column's "Left
 * at the end" (test-bench-chart.js). A picker over the table's columns
 * chooses which. It opens on the newest answer, and the routing column
 * follows the row selected in the list. Every column shares one y-axis, so
 * switching shows what changed.
 *
 * The workers report no run, only the recipe for one, so the chart runs each
 * column again here, from the plan the test ran on (benchPlan), once each.
 *
 * ── The market outlook ───────────────────────────────────────────────
 *
 * Pessimistic, Moderate or Optimistic: stock and bond returns 1% a year lower,
 * as entered, or higher (market-outlook.js). A test reads the plan once, at its
 * start, and puts it under the outlook then (outlookPlan), so both tests, their
 * checks and the chart all run the same copy. The plan on screen is not
 * changed, and a save sends only amounts and a routing, never the copy's rates.
 * Changing it starts nothing: the results found under another outlook dim.
 *
 * ── Loss years ───────────────────────────────────────────────────────
 *
 * None, 1, 2 or 3 years from the first January of retirement, each with a
 * stock and a bond figure the user types (loss-years.js). The plan a test runs
 * carries them as the engine's `returnSchedule` (conditionedPlan), so every
 * job and the chart run them. Changing the count keeps the figures typed; a
 * figure that is not 0–100 is refused under the fields, and Run waits.
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
 *   'testbench-save'   { detail: { factor, lifeEvents?, clause } }  `lifeEvents`
 *                      when a routing is saved: the plan's, with the routing
 *                      written in. `clause` names the conditions the result was
 *                      found under, or is null (conditionsClause)
 *   'testbench-month'  { detail: { year, month } }
 */

import { LitElement, html, svg, nothing } from 'lit';
import { Chart } from 'chart.js';
import { runTestBench, cancelTestBench, CHECK_SIMULATIONS, marketsData,
         runRoutingTest, runRoutingChecks, cancelRouting, routingCost, benchPlan } from '../test-bench-run.js';
import { columnSeries, stackedRange, chartConfig, CHART_COLUMNS, periodWord } from '../test-bench-chart.js';
import { DateInt, monthLabel } from '../utils/date-int.js';
import { whatStopsYou, riseNote, healthNote, successNote, resultRows, spendingHeadline } from '../spending-report.js';
import { DEPTHS, DEFAULT_DEPTH, rankSearches } from '../routing-search.js';
import { startsLabel, costLine, agreementLine, changeRows, versusEntered, routingHeadline,
         isLoneBest, LONE_BEST_NOTE, DEPTH_NOTES } from '../routing-report.js';
import { formatCompactCurrency, formatCurrency } from '../utils/html.js';
import { MarketOutlook, OUTLOOKS, outlookLabel, returnShift } from '../market-outlook.js';
import { NEUTRAL_CONDITIONS, conditionsOf, isNeutral, sameConditions, conditionChips, foundUnderChips, foundUnderText,
         spendingChanges, routingChanges, changedLine, tabColumn, conditionedPlan, conditionsClause } from '../test-bench-view.js';
import { MAX_LOSS_YEARS, NO_LOSS_YEARS, parseLossFigure, lossYearsCalendar, lossYearsLine } from '../loss-years.js';

/** The line under the outlook control. */
function outlookLine(outlook) {
    const shift = returnShift(outlook);
    if (!shift) return 'Stock and bond returns as you entered them.';
    return `Stock and bond returns 1% a year ${shift > 0 ? 'higher' : 'lower'} than you entered.`
        + ' Inflation, wages and cash stay as entered.';
}

const TABS = Object.freeze([
    { id: 'spending', label: 'Spending', title: 'How much can this plan spend?' },
    { id: 'routing', label: 'Routing', title: "Is there a better way to route this plan's money?" },
]);

/**
 * The plan's dates the loss years count from: its retirement date, first and
 * last months, each { year, month } (DateInt). Retirement may be null.
 */
function datesOf(plan) {
    const at = (int) => (int ? new DateInt(int) : null);
    return { retirement: at(plan.retirementDateInt), first: at(plan.firstDateInt), last: at(plan.lastDateInt) };
}

/** A Found under line, one chip each. */
function foundUnderLine(chips) {
    return html`<p class="tb-found"><span class="tb-found-label">Found under</span>${chips.map((c) =>
        html`<span class="tb-chip">${c}</span>`)}</p>`;
}

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
        _outlook:        { state: true },   // the market outlook the next test runs under
        _lossCount:      { state: true },   // loss years: 0 to 3
        _lossFigures:    { state: true },   // { stocks: [n,n,n], bonds: [n,n,n] }, the last valid of each
        _lossText:       { state: true },   // the same as typed, with errors kept: { stocks: [..], bonds: [..] }
        _solving:        { state: true },   // { tested, completed, total } while the limit is tested
        _depth:     { state: true },
        _rStatus:   { state: true },   // 'idle' | 'running' | 'done' | 'error'
        _searches:  { state: true },   // [{ start, seed, state, progress, result }]
        _selected:  { state: true },   // the selected row's key; null is the top row
        _rChecks:   { state: true },
        _rProgress: { state: true },
        _rStale:    { state: true },
        _rError:    { state: true },
        _chartColumn: { state: true },   // the table column the chart shows: 'entered' | 'best' | 'routed'
        _tab:            { state: true },   // the test on show: 'spending' | 'routing'
        _conditionsOpen: { state: true },   // on a phone, the Conditions card is open
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
        this._outlook = MarketOutlook.MODERATE;
        this._lossCount = 0;
        this._lossFigures = { stocks: [...NO_LOSS_YEARS.stocks], bonds: [...NO_LOSS_YEARS.bonds] };
        this._lossText = { stocks: NO_LOSS_YEARS.stocks.map(String), bonds: NO_LOSS_YEARS.bonds.map(String) };
        this._dates = null;        // the plan's { retirement, first, last }; null means read them again
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
        this._rConditions = conditionsOf();   // and the conditions
        this._rClause = null;      // and their clause, for a save
        this._rPlan = null;        // and the plan it was run on
        this._rRun = null;         // identifies the routing test in flight
        this._rAsked = 0;          // how many searches the test on screen set out to run
        this._rCheckCache = new Map();
        this._cost = null;         // routingCost() of the depth; null means work it out
        this._chartColumn = 'best';
        this._tab = 'spending';
        this._conditionsOpen = false;
        this._under = null;        // the levers the spending result on screen was found under
        this._chartPlan = null;    // benchPlan() of the spending test on screen
        this._rChartPlan = null;   // and of the routing test on screen
        this._series = new Map();  // columnSeries() of the spending test's columns, by key
        this._rSeries = new Map(); // and of the routing test's
        this._chart = null;        // the Chart.js chart
        this._drawn = null;        // what it shows: { canvas, series, min, max }
        this._chartTimer = null;   // the runs waiting for the next tick
    }

    createRenderRoot() { return this; }

    disconnectedCallback() {
        super.disconnectedCallback();
        cancelTestBench();
        cancelRouting();
        clearTimeout(this._chartTimer);
        this._chartTimer = null;
        this._dropChart();
    }

    updated() {
        this._syncChart();
    }

    willUpdate() {
        if (this._dates === null && this.ready) {
            const plan = this.planSource?.();
            this._dates = plan ? datesOf(plan) : undefined;
        }
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
        this._dates = null;
    }

    /** The routing test on screen no longer describes the plan, the floor or the outlook. */
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
        if (this._rStatus === 'done') {
            this._checkSelected();
            this._chartNewest();
        }
    }

    // ── The levers ──────────────────────────────────────────────────

    /** The conditions on screen. */
    _conditions() {
        return conditionsOf({
            outlook: this._outlook,
            lossYears: { count: this._lossCount, stocks: this._lossFigures.stocks, bonds: this._lossFigures.bonds },
        });
    }

    /** Whether a loss-year figure on show is one the page refused. Run waits for it. */
    _lossInvalid() {
        return ['stocks', 'bonds'].some((kind) =>
            this._lossText[kind].slice(0, this._lossCount).some((text) => 'error' in parseLossFigure(text)));
    }

    _setLossCount(count) {
        // The figures stay as typed: 3 → 1 → 3 brings years 2 and 3 back.
        this._lossCount = count;
    }

    /** A typed figure: kept as typed, and taken as the figure when it is 0–100. */
    _setLossFigure(kind, index, text) {
        const parsed = parseLossFigure(text);
        const shown = 'value' in parsed ? String(parsed.value) : text;
        this._lossText = { ...this._lossText, [kind]: this._lossText[kind].map((t, i) => (i === index ? shown : t)) };
        if ('value' in parsed) {
            this._lossFigures = { ...this._lossFigures,
                [kind]: this._lossFigures[kind].map((v, i) => (i === index ? parsed.value : v)) };
        }
    }

    /** The spending test's limits on screen. */
    _limits() {
        return { floor: this._floor, successOn: this._successOn, successPercent: this._successPercent };
    }

    /**
     * The line over the spending result when it no longer describes the
     * levers on screen, or null. A rerun in flight says so instead.
     */
    _spendingChanged() {
        if (!this._result) return null;
        if (this._stale) return 'The plan or its settings changed after this test. Run it again.';
        const line = changedLine(spendingChanges(this._under,
            { conditions: this._conditions(), limits: this._limits() }), 'Run');
        return line && this._status === 'running' ? 'Running the test again…' : line;
    }

    /** The same, for the routing list on screen. */
    _routingChanged() {
        if (!this._searches) return null;
        if (this._rStale) return 'The plan or its settings changed after this test. Search again.';
        return changedLine(routingChanges({ conditions: this._rConditions, floor: this._rFloor },
            { conditions: this._conditions(), floor: this._floor }), 'Search');
    }

    /**
     * Whether Search must run the spending test first: routings are compared
     * with its answer, at the floor and conditions on screen.
     */
    _spendingNeededForRouting() {
        const r = this._result;
        return !r || this._stale || r.limits.floor !== this._floor || !sameConditions(this._under.conditions, this._conditions());
    }

    _setTab(tab) {
        if (tab === this._tab) return;
        this._tab = tab;
        // Each tab opens the chart on its own column (spec 18, §3.4).
        this._chartColumn = tabColumn(tab);
    }

    /** Arrow keys move between the tabs, as a tab list's do. */
    _onTabKey(ev) {
        const at = TABS.findIndex((t) => t.id === this._tab);
        const to = ev.key === 'ArrowRight' ? (at + 1) % TABS.length
            : ev.key === 'ArrowLeft' ? (at + TABS.length - 1) % TABS.length
            : ev.key === 'Home' ? 0 : ev.key === 'End' ? TABS.length - 1 : -1;
        if (to < 0) return;
        ev.preventDefault();
        this._setTab(TABS[to].id);
        this.updateComplete.then(() => this.querySelector(`#tb-tab-${TABS[to].id}`)?.focus());
    }

    /** The Routing tab's link to the floor, which lives on the Spending tab. */
    async _editFloor() {
        this._setTab('spending');
        await this.updateComplete;
        this.querySelector('.tb-floor-field input')?.focus();
    }

    async run() {
        const source = this.planSource?.();
        if (!source) return;
        // The plan under the conditions, once: every job and the chart run this copy.
        const conditions = this._conditions();
        const dates = datesOf(source);
        const plan = conditionedPlan(source, conditions, dates);
        // What the result will have been found under: the levers as Run was clicked.
        const under = { conditions, limits: this._limits(), data: marketsData(), clause: conditionsClause(conditions, dates) };
        this._status = 'running';
        this._error = '';
        this._checks = {};
        this._progress = {};
        this._solving = null;
        this._stale = false;
        const floor = this._floor;
        const success = this._successOn ? this._successPercent / 100 : 0;
        // The plan as it is now: a test is cancelled if it changes, so the
        // answer that comes back is for this one.
        const chartPlan = benchPlan(plan);
        try {
            await runTestBench(plan, { floor, success }, {
                solving: (tested, completed, total) => { this._solving = { tested, completed, total }; },
                solved: (result) => {
                    this._cost = null;   // a plan run has been timed
                    this._result = result;
                    this._under = under;
                    this._status = 'done';
                    this._solving = null;
                    this._hover = null;
                    this._chartPlan = chartPlan;
                    this._series = new Map();
                    this._chartColumn = tabColumn(this._tab);
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
        const source = this.planSource?.();
        if (!source) return;
        const conditions = this._conditions();
        const dates = datesOf(source);
        const plan = conditionedPlan(source, conditions, dates);
        // The list is read against the spending test's columns, at this floor
        // and these conditions, so Search runs that test too when its answer is not for them.
        if (this._spendingNeededForRouting()) this.run();

        const run = (this._rRun = {});
        this._rStatus = 'running';
        this._rError = '';
        this._rStale = false;
        this._rFloor = this._floor;
        this._rConditions = conditions;
        this._rClause = conditionsClause(conditions, dates);
        this._rPlan = plan;
        this._searches = [];
        this._selected = null;
        this._rChecks = {};
        this._rProgress = null;
        this._rCheckCache = new Map();
        this._rChartPlan = benchPlan(plan);
        this._rSeries = new Map();
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
            this._chartNewest();
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
     * The routing column the result table shows. It belongs beside the
     * spending test's columns only at the floor and outlook they share.
     */
    _tableRouted() {
        const r = this._result;
        return r && !this._rStale && r.limits.floor === this._rFloor && sameConditions(this._under.conditions, this._rConditions)
            ? this._routedColumn() : null;
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
        return most && !this._stale && r.limits.floor === this._rFloor && sameConditions(this._under.conditions, this._rConditions)
            ? most.monthlySpending : 0;
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

    // A changed lever starts nothing: the results it affects dim until they
    // are run again (spec 18, §3.5). Only a click on the curve runs at once.

    _setFloor(value, { rerun = false } = {}) {
        const floor = Math.max(0, Math.round(Number(value) || 0));
        if (floor === this._floor && !rerun) return;
        this._floor = floor;
        if (rerun) this.run();
    }

    _setOutlook(outlook) {
        if (outlook === this._outlook) return;
        this._outlook = outlook;
    }

    /** Reset to as entered: every condition at its neutral setting. */
    _resetConditions() {
        this._setOutlook(NEUTRAL_CONDITIONS.outlook);
        this._setLossCount(0);
    }

    _setSuccess(on, percent) {
        const clamped = Math.max(50, Math.min(99, Math.round(Number(percent) || 90)));
        if (on === this._successOn && clamped === this._successPercent) return;
        this._successOn = on;
        this._successPercent = clamped;
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
        const routed = this._tableRouted();
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

    /** spendingHeadline()'s sentence, with the figure in bold. Found under names the conditions. */
    _headline() {
        const best = this._result.best;
        const text = spendingHeadline(this._result, { withConditions: false });
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
        const notes = [successNote(result, { withConditions: false }), confirmNote, riseNote(result), healthNote(result)]
            .filter(Boolean);
        const changed = this._spendingChanged();
        const saveTitle = !result.best ? 'No spending level kept the limits'
            : changed ? changed
            : !this.canSave ? 'Save the plan on screen as a scenario first'
            : 'Saves these amounts as a new scenario. The plan on screen is not changed.';
        // The table always holds a simulated-markets row, so the line names their data.
        const chips = foundUnderChips({ conditions: this._under.conditions, data: this._under.data });
        return html`
            <div class="tb-result ${changed ? 'is-stale' : ''}" title=${changed ? 'Found under other settings than the ones shown' : ''}>
                ${changed ? html`<p class="tb-changed" role="status">${changed}</p>` : nothing}
                ${foundUnderLine(chips)}
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
                            ?disabled=${!result.best || !!changed || !this.canSave}
                            @click=${() => this.dispatchEvent(new CustomEvent('testbench-save',
                                { detail: { factor: result.best.factor, clause: this._under.clause }, bubbles: true }))}>Save as a scenario</button>
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
        const changed = this._routingChanged();
        const blocked = !!changed || this._rStatus !== 'done' || !this.canSave;
        const why = changed ? changed
            : this._rStatus !== 'done' ? 'The searches are still running'
            : !this.canSave ? 'Save the plan on screen as a scenario first'
            : 'Saves a new scenario. The plan on screen is not changed.';
        const save = (factor) => this.dispatchEvent(new CustomEvent('testbench-save',
            { detail: { factor, lifeEvents: result.lifeEvents, clause: this._rClause }, bubbles: true }));
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
        const changed = this._routingChanged();
        return html`
            <div class="tb-routing">
                ${this._floor > 0 ? html`
                    <p class="tb-floor-note">Routings are ranked by what each lets the plan spend while it leaves at least
                        <strong>${formatCurrency(this._floor)}</strong> at the end.
                        <button type="button" class="tb-link" @click=${() => this._editFloor()}>Change it on Spending</button></p>`
                    : nothing}
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
                                       ?disabled=${!this.ready || nothingToRoute || this._lossInvalid()}
                                       title=${this.ready ? '' : 'Add assets to run the test'}
                                       @click=${() => this.runRouting()}>&#9654; Search</button>`}
                </div>
                ${!running && this._status !== 'running' && this.ready && !nothingToRoute && this._spendingNeededForRouting()
                    ? html`<p class="tb-sub tb-search-note">Search runs the Spending test too: routings are compared with its
                        answer, at this floor and these conditions.</p>` : nothing}
                ${this._rStatus === 'error' ? html`<p class="tb-error">The test failed: ${this._rError}</p>` : nothing}
                ${this._searches ? html`
                    <div class="tb-result ${changed ? 'is-stale' : ''}" title=${changed ? 'Found under other settings than the ones shown' : ''}>
                        ${changed ? html`<p class="tb-changed" role="status">${changed}</p>` : nothing}
                        ${foundUnderLine(foundUnderChips({ conditions: this._rConditions, floor: this._rFloor }))}
                        <div class="tb-routing-body">
                            ${this._renderRoutingList(ranked, row)}
                            <p class="tb-note">${running
                                ? `${ranked.searches} of ${total} searches finished. The list is ranked as they come in.`
                                : (total < this._rAsked ? `Stopped with ${total} of ${this._rAsked} searches finished. ` : '')
                                  + agreementLine(ranked)}</p>
                            ${row ? this._renderChanges(row) : nothing}
                        </div>
                    </div>`
                : html`<p class="tb-sub">Tries other ways to split each income across accounts and to pay each expense, and ranks
                    them by what the plan could then spend. A deeper test runs more searches and takes longer; it all runs on this
                    machine. Nothing in your plan is changed.</p>`}
            </div>`;
    }

    // ── The chart ───────────────────────────────────────────────────

    /** Show the routing, when a routing test has just finished on its tab with one in the table. */
    _chartNewest() {
        if (this._tab === 'routing' && this._tableRouted()) this._chartColumn = 'routed';
    }

    /**
     * The table's columns, each with the run that draws it: the plan its test
     * ran on, its spending level and, for a routing, its life events. `key`
     * names the run, so each is made once.
     */
    _chartColumns() {
        const r = this._result;
        if (!r || !this._chartPlan) return [];
        const columns = [{ id: 'entered', key: 'entered', figures: r.asEntered, plan: this._chartPlan, factor: 1 }];
        if (r.best) columns.push({ id: 'best', key: 'best', figures: r.best, plan: this._chartPlan, factor: r.best.factor });
        const routed = this._tableRouted();
        if (routed && this._rChartPlan) {
            columns.push({
                id: 'routed', key: `routed:${routed.key}`, figures: routed.result.best,
                plan: this._rChartPlan, factor: routed.result.best.factor, lifeEvents: routed.result.lifeEvents,
            });
        }
        for (const c of columns) c.label = CHART_COLUMNS.find((x) => x.id === c.id).label;
        return columns;
    }

    _shownColumn(columns) {
        return columns.find((c) => c.id === this._chartColumn) ?? columns.find((c) => c.id === 'best') ?? columns[0];
    }

    /** A column's series when it has been made, else undefined. */
    _cached(column) {
        return (column.id === 'routed' ? this._rSeries : this._series).get(column.key);
    }

    _makeSeries(column) {
        const store = column.id === 'routed' ? this._rSeries : this._series;
        if (store.has(column.key)) return;
        try {
            store.set(column.key, columnSeries(column.plan, column.factor,
                { lifeEvents: column.lifeEvents ?? null, ages: column.plan.ages }));
        } catch (err) {
            store.set(column.key, { failed: err?.message || String(err) });
        }
    }

    /**
     * Draw the column on show, on an axis that holds every column on offer.
     * A column not yet run is run on the next tick, so the table paints first;
     * each run is about 30 ms.
     */
    _syncChart() {
        const canvas = this.querySelector('.tb-chart canvas');
        const columns = canvas ? this._chartColumns() : [];
        if (!columns.length) { this._dropChart(); return; }
        if (columns.some((c) => !this._cached(c))) {
            this._chartTimer ??= setTimeout(() => {
                this._chartTimer = null;
                for (const c of this._chartColumns()) this._makeSeries(c);
                this.requestUpdate();
            }, 0);
            return;
        }
        const all = columns.map((c) => this._cached(c));
        if (all.some((s) => s.failed)) { this._dropChart(); return; }
        const series = this._cached(this._shownColumn(columns));
        const { min, max } = stackedRange(all);
        const d = this._drawn;
        if (this._chart && d.canvas === canvas && d.series === series && d.min === min && d.max === max) return;

        const config = chartConfig(series, { min, max });
        if (this._chart && d.canvas === canvas) {
            // The same chart, another column: the bars move to their new heights.
            this._chart.data = config.data;
            this._chart.options = config.options;
            this._chart.update();
        } else {
            this._dropChart();
            this._chart = new Chart(canvas, config);
        }
        this._drawn = { canvas, series, min, max };
    }

    _dropChart() {
        this._chart?.destroy();
        this._chart = null;
        this._drawn = null;
    }

    _renderChart() {
        const columns = this._chartColumns();
        if (!columns.length) return nothing;
        const shown = this._shownColumn(columns);
        const series = this._cached(shown);
        const f = shown.figures;
        const period = periodWord(series?.periodMonths ?? 12);
        // The column's own result: what it was found under, and whether it is out of date.
        const routed = shown.id === 'routed';
        const changed = routed ? this._routingChanged() : this._spendingChanged();
        const found = routed ? foundUnderText({ conditions: this._rConditions, floor: this._rFloor })
            : foundUnderText({ conditions: this._under.conditions });
        return html`
            <div class="tb-chart">
                <div class="slot-heading tb-routing-heading">Chart: what the plan holds over the years</div>
                <div class="tb-ask">
                    <div class="tb-columns" role="radiogroup" aria-label="Which column of the table to chart">
                        ${columns.map((c) => html`
                            <label class="tb-column ${c === shown ? 'is-on' : ''}">
                                <input type="radio" name="tb-chart-column" .checked=${c === shown}
                                       @change=${() => { this._chartColumn = c.id; }}>${c.label}</label>`)}
                    </div>
                    <span class="tb-ask-text">Left at the end <strong>${formatCompactCurrency(f.endingReal)}</strong>${f.runsOut
                        ? html`, and runs out in ${monthLabel(DateInt.from(f.runsOut.year, f.runsOut.month))}` : nothing}</span>
                </div>
                <div class="tb-result ${changed ? 'is-stale' : ''}" title=${changed ? 'Found under other settings than the ones shown' : ''}>
                    <div class="tb-chart-body">
                        <div class="tb-chart-wrap">
                            <canvas role="img"
                                    aria-label=${`${shown.label}: what each part of the plan holds at the end of each ${period}, in today's dollars`}></canvas>
                            ${!series ? html`<div class="tb-chart-status">Drawing…</div>`
                                : series.failed ? html`<div class="tb-chart-status">The chart could not be drawn: ${series.failed}</div>`
                                : nothing}
                        </div>
                    </div>
                    <div class="tb-caption">Today's dollars. Each bar is the end of its ${period}, and the last is the plan's last
                        month, so its total is the column's &ldquo;Left at the end&rdquo;. Every column is drawn on the same scale.
                        As in Macro Projection, income and expenses count one month's amount. ${found}.</div>
                </div>
            </div>`;
    }

    // ── The layout ──────────────────────────────────────────────────

    /** The Conditions card: about the world, above both tests. */
    _renderConditions() {
        const now = this._conditions();
        const neutral = isNeutral(now);
        const open = this._conditionsOpen;
        return html`
            <section class="tb-conditions ${open ? 'is-open' : ''}" aria-labelledby="tb-conditions-title">
                <div class="tb-conditions-head">
                    <div class="tb-conditions-titles">
                        <h3 id="tb-conditions-title" class="tb-conditions-title">Conditions</h3>
                        <span class="tb-conditions-summary">${conditionChips(now).join(' · ') || 'As entered'}</span>
                        <span class="tb-sub tb-conditions-sub">Apply to every test and the chart. Your plan is not changed.</span>
                    </div>
                    <button type="button" class="tb-link tb-reset" ?disabled=${neutral}
                            title=${neutral ? 'Every condition is as entered' : 'Put every condition back as entered'}
                            @click=${() => this._resetConditions()}>Reset to as entered</button>
                    <button type="button" class="tb-link tb-conditions-edit" aria-expanded=${open ? 'true' : 'false'}
                            aria-controls="tb-condition-rows"
                            @click=${() => { this._conditionsOpen = !open; }}>${open ? 'Done' : 'Edit'}</button>
                </div>
                <div id="tb-condition-rows" class="tb-condition-rows">
                    <div class="tb-condition">
                        <span class="tb-condition-label" id="tb-outlook-label">Market returns</span>
                        <div class="tb-condition-control">
                            <div class="tb-columns" role="radiogroup" aria-labelledby="tb-outlook-label">
                                ${OUTLOOKS.map((o) => html`
                                    <label class="tb-column ${o === this._outlook ? 'is-on' : ''}">
                                        <input type="radio" name="tb-outlook" .checked=${o === this._outlook}
                                               @change=${() => this._setOutlook(o)}>${outlookLabel(o)}</label>`)}
                            </div>
                            <span class="tb-sub">${outlookLine(this._outlook)}</span>
                        </div>
                    </div>
                    ${this._renderLossYears()}
                </div>
            </section>`;
    }

    /** The Loss years row: the count, a stock and a bond figure per year, and its line. */
    _renderLossYears() {
        const count = this._lossCount;
        const record = this._conditions().lossYears;
        const dates = this._dates || null;
        const years = dates ? lossYearsCalendar(record, dates).years : null;
        const yearLabel = (i) => (years ? String(years[i]) : `Year ${i + 1}`);
        const field = (kind, i) => {
            const text = this._lossText[kind][i];
            const bad = 'error' in parseLossFigure(text);
            const what = kind === 'stocks' ? 'Stock' : 'Bond';
            return html`
                <label class="tb-loss-field ${bad ? 'is-bad' : ''}">
                    <span class="tb-loss-sign" aria-hidden="true">${'\u2212'}</span>
                    <input type="text" inputmode="numeric" .value=${text} aria-invalid=${bad ? 'true' : 'false'}
                           aria-label=${`${what} price fall in ${yearLabel(i)}, percent`}
                           @change=${(ev) => { this._setLossFigure(kind, i, ev.target.value);
                                               ev.target.value = this._lossText[kind][i]; }}>%</label>`;
        };
        const columns = Array.from({ length: count }, (_, i) => i);
        return html`
            <div class="tb-condition">
                <span class="tb-condition-label" id="tb-loss-label">Loss years</span>
                <div class="tb-condition-control">
                    <div class="tb-columns" role="radiogroup" aria-labelledby="tb-loss-label">
                        ${Array.from({ length: MAX_LOSS_YEARS + 1 }, (_, n) => html`
                            <label class="tb-column ${n === count ? 'is-on' : ''}">
                                <input type="radio" name="tb-loss-count" .checked=${n === count}
                                       @change=${() => this._setLossCount(n)}>${n === 0 ? 'None' : n}</label>`)}
                    </div>
                    ${count ? html`
                        <div class="tb-loss-grid" style=${`grid-template-columns: auto repeat(${count}, auto)`}>
                            <span></span>
                            ${columns.map((i) => html`<span class="tb-loss-year">${yearLabel(i)}</span>`)}
                            <span class="tb-loss-kind">Stocks</span>
                            ${columns.map((i) => field('stocks', i))}
                            <span class="tb-loss-kind">Bonds</span>
                            ${columns.map((i) => field('bonds', i))}
                        </div>
                        ${this._lossInvalid() ? html`<p class="tb-error tb-loss-error" role="alert">A loss is 0% to 100%.
                            Run waits until each figure is a whole number from 0 to 100.</p>` : nothing}` : nothing}
                    <span class="tb-sub tb-loss-line">${dates ? lossYearsLine(record, dates) : ''}</span>
                </div>
            </div>`;
    }

    /** The tab list: one tab per test, with a word while one runs. */
    _renderTabs() {
        const busy = { spending: this._status === 'running' ? 'running…' : '',
                       routing: this._rStatus === 'running' ? 'searching…' : '' };
        return html`
            <div class="tb-tabs" role="tablist" aria-label="Tests" @keydown=${(ev) => this._onTabKey(ev)}>
                ${TABS.map((t) => html`
                    <button type="button" role="tab" id="tb-tab-${t.id}" class="tb-tab ${t.id === this._tab ? 'is-on' : ''}"
                            aria-selected=${t.id === this._tab ? 'true' : 'false'} aria-controls="tb-panel-${t.id}"
                            tabindex=${t.id === this._tab ? '0' : '-1'} title=${t.title}
                            @click=${() => this._setTab(t.id)}>${t.label}${busy[t.id]
                                ? html`<span class="tb-tab-busy">${busy[t.id]}</span>` : nothing}</button>`)}
            </div>`;
    }

    /** The spending test's limits, one control each. */
    _renderLimits() {
        const running = this._status === 'running';
        return html`
            <div class="tb-limits">
                <div class="tb-limit">
                    <span class="tb-limit-label">Never runs out</span>
                    <span class="tb-limit-value" title="Every bill is paid, every month. This limit is always on.">Always on</span>
                </div>
                <div class="tb-limit">
                    <label class="tb-limit-label" for="tb-floor">Leaves at least</label>
                    <span class="tb-limit-value"><span class="tb-floor-field">$<input id="tb-floor" type="text"
                           inputmode="numeric" aria-describedby="tb-floor-sub"
                           .value=${this._floor.toLocaleString('en-US')}
                           @change=${this._onFloorInput}></span>
                        <span class="tb-sub" id="tb-floor-sub">at the end<span class="tb-wide">, in today's dollars</span></span></span>
                </div>
                <div class="tb-limit tb-success-field">
                    <label class="tb-limit-label"><input type="checkbox" .checked=${this._successOn}
                           @change=${(ev) => this._setSuccess(ev.target.checked, this._successPercent)}>Lasts in</label>
                    <span class="tb-limit-value"><input type="text" inputmode="numeric" aria-label="Share of simulated markets, percent"
                           ?disabled=${!this._successOn} .value=${String(this._successPercent)}
                           @change=${(ev) => { this._setSuccess(this._successOn, ev.target.value.replace(/[^0-9]/g, ''));
                                               ev.target.value = String(this._successPercent); }}>%
                        <span class="tb-sub">of simulated markets</span></span>
                </div>
                <button type="button" class="btn-modern primary text-sm tb-run" ?disabled=${!this.ready || running || this._lossInvalid()}
                        title=${!this.ready ? 'Add assets to run the test' : this._lossInvalid() ? 'A loss year\'s figure must be 0% to 100%' : ''}
                        @click=${() => this.run()}>${running ? 'Running…' : html`&#9654; Run`}</button>
            </div>`;
    }

    _renderSpending() {
        const running = this._status === 'running';
        return html`
            ${this._renderLimits()}
            ${this._status === 'error' ? html`<p class="tb-error">The test failed: ${this._error}</p>` : nothing}
            ${running && this._solving ? html`<p class="tb-sub tb-solving">Testing spending level ${this._solving.tested + 1}
                across ${this._solving.total} simulated markets (${this._solving.completed} of ${this._solving.total}).
                Each level takes about ten seconds; at most ten are tested.</p>` : nothing}
            ${this._result ? this._renderResult()
                : running ? (this._solving ? nothing : html`<p class="tb-sub">Running the plan at 40 spending levels…</p>`)
                : html`<p class="tb-sub">Turns every monthly expense up and down together, health plan included,
                    and finds the highest level the plan can pay for. With the simulated-markets limit on, it then
                    tests levels across 300 simulated markets, which takes from ten seconds to about two minutes.
                    Nothing in your plan is changed.</p>`}`;
    }

    render() {
        return html`
            ${this._renderConditions()}
            <div class="tb-tests">
                ${this._renderTabs()}
                <div id="tb-panel-spending" class="tb-panel" role="tabpanel" aria-labelledby="tb-tab-spending"
                     ?hidden=${this._tab !== 'spending'}>${this._renderSpending()}</div>
                <div id="tb-panel-routing" class="tb-panel" role="tabpanel" aria-labelledby="tb-tab-routing"
                     ?hidden=${this._tab !== 'routing'}>${this._renderRouting()}</div>
            </div>
            ${this._renderChart()}`;
    }
}

customElements.define('test-bench', TestBench);
