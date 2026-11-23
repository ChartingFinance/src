/**
 * test-bench-loss-years.test.js — regression checks for <test-bench> loss-year
 * edge cases (invalid-figure run guards, Reset to as entered, and date refresh
 * on markStale).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const defined = {};
globalThis.customElements = { define: (name, cls) => { defined[name] = cls; } };

const runTestBenchMock = vi.fn(() => Promise.resolve());
const runRoutingTestMock = vi.fn(() => Promise.resolve());

vi.mock('lit', () => {
    class LitElement {
        constructor() { this._updateCalls = 0; }
        requestUpdate() { this._updateCalls++; }
        querySelector() { return null; }
    }
    const tag = (strings, ...values) => ({ strings, values });
    return { LitElement, html: tag, svg: tag, nothing: Symbol('nothing') };
});

vi.mock('../../js/test-bench-run.js', () => ({
    runTestBench: runTestBenchMock,
    cancelTestBench: vi.fn(),
    CHECK_SIMULATIONS: 300,
    marketsData: () => ({ dataMode: 'calibrated', firstYear: 1970, lastYear: 2025 }),
    runRoutingTest: runRoutingTestMock,
    runRoutingChecks: vi.fn(),
    cancelRouting: vi.fn(),
    routingCost: vi.fn(() => ({ searches: 1, ms: 10 })),
    benchPlan: vi.fn((p) => p),
}));

await import('../../js/components/test-bench.js');
const TestBench = defined['test-bench'];

function makeSource(retirementDateInt = 203101) {
    return {
        modelAssets: [],
        lifeEvents: [],
        guardrailParams: {},
        retirementDateInt,
        firstDateInt: 202601,
        lastDateInt: 206012,
    };
}

describe('<test-bench> loss years edge cases', () => {
    let el;

    beforeEach(() => {
        runTestBenchMock.mockClear();
        runRoutingTestMock.mockClear();
        el = new TestBench();
        el.ready = true;
        el.planSource = () => makeSource(203101);
    });

    it('refuses run(), runRouting(), and curve-click rerun while a loss-year figure is invalid', async () => {
        el._setLossCount(1);
        el._setLossFigure('stocks', 0, '150');
        expect(el._lossInvalid()).toBe(true);

        await el.run();
        expect(runTestBenchMock).not.toHaveBeenCalled();

        await el.runRouting();
        expect(runRoutingTestMock).not.toHaveBeenCalled();

        // Curve click path: floor still updates, but rerun does not fire with stale valid figures.
        el._setFloor(250000, { rerun: true });
        expect(el._floor).toBe(250000);
        expect(runTestBenchMock).not.toHaveBeenCalled();
    });

    it('clears invalid loss-year text on Reset to as entered', () => {
        el._setLossCount(1);
        el._setLossFigure('stocks', 0, '35');
        el._setLossFigure('stocks', 0, '150');
        expect(el._lossInvalid()).toBe(true);

        el._resetConditions();
        expect(el._lossCount).toBe(0);

        el._setLossCount(1);
        expect(el._lossInvalid()).toBe(false);
        expect(el._lossText.stocks[0]).toBe('35');
    });

    it('requests an update in markStale() so loss-year dates refresh while idle or already stale', () => {
        el.willUpdate();
        expect(el._dates.retirement.toInt()).toBe(203101);

        // Plan retirement date changes while the Test Bench has never been run (_result === null).
        el.planSource = () => makeSource(203406);
        const before = el._updateCalls;
        el.markStale();
        expect(el._updateCalls).toBeGreaterThan(before);
        expect(el._dates).toBeNull();

        el.willUpdate();
        expect(el._dates.retirement.toInt()).toBe(203406);

        // Also refreshes if a result is already marked stale.
        el._result = {};
        el._stale = true;
        el.planSource = () => makeSource(203701);
        const beforeStale = el._updateCalls;
        el.markStale();
        expect(el._updateCalls).toBeGreaterThan(beforeStale);
        el.willUpdate();
        expect(el._dates.retirement.toInt()).toBe(203701);
    });
});
