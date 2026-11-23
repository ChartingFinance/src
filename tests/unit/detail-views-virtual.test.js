/**
 * detail-views-virtual.test.js — regression and windowing tests for the
 * virtualized/lazy detail components (<report-view>, <credit-memo-view>,
 * <spreadsheet-view>) and js/utils/virtual-window.js.
 */

import { describe, it, expect, vi } from 'vitest';
import { visibleWindow, rowScrollTop, DEFAULT_ROW_HEIGHT } from '../../js/utils/virtual-window.js';
import { DateInt } from '../../js/utils/date-int.js';
import { Currency } from '../../js/utils/currency.js';
import { FinancialPackage } from '../../js/financial-package.js';

const defined = {};
globalThis.customElements = { define: (name, cls) => { defined[name] = cls; } };

vi.mock('lit', () => {
    class LitElement {
        requestUpdate() {}
        get updateComplete() { return Promise.resolve(true); }
        querySelector() { return null; }
        querySelectorAll() { return []; }
        closest() { return null; }
    }
    const tag = (strings, ...values) => ({ strings, values });
    return { LitElement, html: tag, svg: tag, nothing: Symbol('nothing') };
});

await import('../../js/components/report-view.js');
await import('../../js/components/credit-memo-view.js');
await import('../../js/components/spreadsheet-view.js');

const ReportView = defined['report-view'];
const CreditMemoView = defined['credit-memo-view'];
const SpreadsheetView = defined['spreadsheet-view'];

/** Recursively count TemplateResults matching a static-string substring. */
function countTemplates(node, needle) {
    if (!node || typeof node !== 'object') return 0;
    if (Array.isArray(node)) return node.reduce((n, item) => n + countTemplates(item, needle), 0);
    let n = 0;
    if (Array.isArray(node.strings)) {
        if (node.strings.join('').includes(needle)) n++;
        for (const v of node.values) n += countTemplates(v, needle);
    }
    return n;
}

describe('visibleWindow and rowScrollTop', () => {
    it('handles empty lists and preserves total height across spacer + visible rows', () => {
        expect(visibleWindow(0, 0, 440)).toEqual({ start: 0, end: 0, topPad: 0, bottomPad: 0 });

        const total = 20000;
        const rh = 24;
        for (const scrollTop of [0, 500, 120000, 479900]) {
            const w = visibleWindow(total, scrollTop, 440, { rowHeight: rh, overscan: 10 });
            expect(w.end - w.start).toBeLessThanOrEqual(45);
            expect(w.topPad + (w.end - w.start) * rh + w.bottomPad).toBe(total * rh);
        }
    });

    it('clamps when totalRows shrinks below an old scrollTop', () => {
        const w = visibleWindow(100, 500000, 440, { rowHeight: 24, overscan: 5 });
        expect(w.end).toBe(100);
        expect(w.start).toBeLessThan(100);
        expect(w.end - w.start).toBeGreaterThan(10);
    });

    it('centers the requested index in rowScrollTop', () => {
        expect(rowScrollTop(0, 440, { rowHeight: 24 })).toBe(0);
        expect(rowScrollTop(100, 440, { rowHeight: 24, headerHeight: 30 })).toBe(Math.round(30 + 100 * 24 - 220 + 12));
    });
});

describe('<report-view> lazy <details> rendering', () => {
    function makeReports(months = 120) {
        const list = [];
        const cur = DateInt.from(2026, 1);
        for (let i = 0; i < months; i++) {
            list.push({ type: 'monthly', coversMonth: cur.toHTML(), pkg: new FinancialPackage() });
            cur.nextMonth();
        }
        return list;
    }

    it('renders zero report tables when all <details> are closed', () => {
        const view = new ReportView();
        view.reports = makeReports(240);
        view.willUpdate(new Map([['reports', []]]));

        const tree = view.render();
        expect(countTemplates(tree, '<details')).toBe(240);
        expect(countTemplates(tree, '<table')).toBe(0);
    });

    it('mounts only opened tables and replaces auto-opened reports on scrollToDate', () => {
        const view = new ReportView();
        view.reports = makeReports(36);
        view.willUpdate(new Map([['reports', []]]));

        // User manually opens report 0
        view._onToggle(0, true);
        expect(countTemplates(view.render(), '<table')).toBe(1);

        // Timeline jumps to 2027-06 (idx 17) — opens 17, keeps manual 0
        view.scrollToDate(2027, 6);
        expect(view._open.has(0)).toBe(true);
        expect(view._open.has(17)).toBe(true);
        expect(countTemplates(view.render(), '<table')).toBe(2);

        // Programmatic toggle echo does not convert auto-opened 17 into manual
        view._onToggle(17, true);
        expect(view._manualOpen.has(17)).toBe(false);

        // Timeline jumps to 2028-01 (idx 24) — closes auto-opened 17, keeps manual 0
        view.scrollToDate(2028, 1);
        expect(view._open.has(0)).toBe(true);
        expect(view._open.has(17)).toBe(false);
        expect(view._open.has(24)).toBe(true);
        expect(countTemplates(view.render(), '<table')).toBe(2);

        // Replacing reports resets open state
        view.reports = makeReports(12);
        view.willUpdate(new Map([['reports', []]]));
        expect(view._open.size).toBe(0);
        expect(countTemplates(view.render(), '<table')).toBe(0);
    });
});

describe('<credit-memo-view> virtualized rendering', () => {
    it('renders only a small window of rows for 10,000 credit memos and jumps via scrollToDate', () => {
        const memos = [];
        const cur = DateInt.from(2026, 1);
        for (let m = 0; m < 500; m++) {
            for (let k = 0; k < 20; k++) {
                memos.push({ dateInt: cur.copy(), amount: new Currency(100), note: `Entry ${k}`, kind: 'cash' });
            }
            cur.nextMonth();
        }

        const view = new CreditMemoView();
        view.portfolio = { modelAssets: [{ displayName: 'Checking', creditMemos: memos }] };
        view.willUpdate(new Map([['portfolio', null]]));

        const initial = view.render();
        const initialRows = countTemplates(initial, '<tr data-row=');
        expect(view._rows.length).toBe(10000);
        expect(initialRows).toBeGreaterThan(15);
        expect(initialRows).toBeLessThan(60);

        // Jump to month 250 (2046-11, first memo at index 5000)
        view.scrollToDate(2046, 11);
        expect(view._highlightIdx).toBe(5000);
        expect(view._winStart).toBeLessThanOrEqual(5000);
        expect(view._winEnd).toBeGreaterThan(5000);
        const afterJump = view.render();
        expect(countTemplates(afterJump, '<tr data-row=')).toBeLessThan(60);
        expect(countTemplates(afterJump, 'class="vt-spacer"')).toBe(2);
    });
});

describe('<spreadsheet-view> virtualized rendering and collapsed CSV export', () => {
    function makePortfolio(months = 600) {
        const start = DateInt.from(2026, 1);
        const end = start.copy();
        for (let i = 1; i < months; i++) end.nextMonth();
        const values = Array.from({ length: months }, (_, i) => 1000 + i);
        return {
            firstDateInt: start,
            lastDateInt: end,
            modelAssets: [{ displayName: 'Brokerage', monthlyValues: values }],
        };
    }

    it('renders only a viewport slice of a 600-month plan and centers on scrollToDate', () => {
        const view = new SpreadsheetView();
        view.portfolio = makePortfolio(600);
        view.willUpdate(new Map([['portfolio', null]]));

        const initialRows = countTemplates(view.render(), '<tr data-row=');
        expect(view._dateLabels.length).toBe(600);
        expect(initialRows).toBeGreaterThan(20);
        expect(initialRows).toBeLessThan(65);

        view.scrollToDate(2050, 6);
        const expectedIdx = (2050 - 2026) * 12 + (6 - 1);
        expect(view._highlightIdx).toBe(expectedIdx);
        expect(view._winStart).toBeLessThanOrEqual(expectedIdx);
        expect(view._winEnd).toBeGreaterThan(expectedIdx);
    });

    it('exports all 600 months via toCSV(portfolio) even when collapsed (this.portfolio === null)', () => {
        const view = new SpreadsheetView();
        expect(view.portfolio).toBeNull();
        const csv = view.toCSV(makePortfolio(600));
        const lines = csv.split('\n');
        expect(lines.length).toBe(602); // 2 header rows + 600 monthly rows
        expect(lines[2]).toBe('2026-01,1000.00');
        expect(lines[601]).toBe('2075-12,1599.00');
    });
});
