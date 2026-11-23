/**
 * virtual-window.js
 *
 * Pure row-window math for virtualized detail tables (<credit-memo-view> and
 * <spreadsheet-view>). Keeps large multi-decade tables to ~30–50 live DOM rows
 * instead of tens of thousands while preserving native scrolling and exact
 * scrollToDate positioning.
 */

export const DEFAULT_ROW_HEIGHT = 24;
export const DEFAULT_OVERSCAN = 12;

/**
 * Compute the slice [start, end) of rows to render and the spacer heights that
 * stand in for the rows above and below the viewport.
 *
 * @param {number} totalRows
 * @param {number} scrollTop       container.scrollTop, clamped to >= 0
 * @param {number} viewportHeight  container.clientHeight (falls back to fallbackViewport if 0)
 * @param {object} [opts]
 * @param {number} [opts.rowHeight]
 * @param {number} [opts.overscan]
 * @param {number} [opts.headerHeight]     height of sticky <thead> above the first body row
 * @param {number} [opts.fallbackViewport] viewport height before layout / in headless tests
 * @returns {{ start: number, end: number, topPad: number, bottomPad: number }}
 */
export function visibleWindow(totalRows, scrollTop, viewportHeight, {
    rowHeight = DEFAULT_ROW_HEIGHT,
    overscan = DEFAULT_OVERSCAN,
    headerHeight = 0,
    fallbackViewport = 440,
} = {}) {
    if (totalRows <= 0) return { start: 0, end: 0, topPad: 0, bottomPad: 0 };
    const rh = Math.max(1, rowHeight || DEFAULT_ROW_HEIGHT);
    const view = Math.max(viewportHeight > 0 ? viewportHeight : fallbackViewport, rh);
    const bodyScroll = Math.max(0, (scrollTop || 0) - headerHeight);
    const visibleCount = Math.ceil(view / rh);
    const maxFirst = Math.max(0, totalRows - visibleCount);
    const first = Math.min(maxFirst, Math.floor(bodyScroll / rh));
    const start = Math.max(0, first - overscan);
    const end = Math.min(totalRows, first + visibleCount + overscan);
    return {
        start,
        end,
        topPad: start * rh,
        bottomPad: (totalRows - end) * rh,
    };
}

/**
 * Target scrollTop that centers `index` inside the scroll container.
 *
 * @param {number} index
 * @param {number} viewportHeight
 * @param {object} [opts]
 * @param {number} [opts.rowHeight]
 * @param {number} [opts.headerHeight]
 * @param {number} [opts.fallbackViewport]
 * @returns {number}
 */
export function rowScrollTop(index, viewportHeight, {
    rowHeight = DEFAULT_ROW_HEIGHT,
    headerHeight = 0,
    fallbackViewport = 440,
} = {}) {
    const rh = Math.max(1, rowHeight || DEFAULT_ROW_HEIGHT);
    const view = viewportHeight > 0 ? viewportHeight : fallbackViewport;
    return Math.max(0, Math.round(headerHeight + index * rh - view / 2 + rh / 2));
}
