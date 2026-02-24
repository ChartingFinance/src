/**
 * debug-panel.js
 *
 * Floating, draggable HTML debug panel that displays monthly and yearly
 * financial reports. Toggle via the 🐞 button or `window.debugPanel.toggle()`.
 */

let panelElement = null;
let contentElement = null;
let isVisible = false;

// ── Drag state ───────────────────────────────────────────────
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

function onMouseDown(ev) {
    if (ev.target.closest('.debug-panel-content')) return;
    isDragging = true;
    dragOffsetX = ev.clientX - panelElement.offsetLeft;
    dragOffsetY = ev.clientY - panelElement.offsetTop;
    ev.preventDefault();
}

function onMouseMove(ev) {
    if (!isDragging) return;
    panelElement.style.left = (ev.clientX - dragOffsetX) + 'px';
    panelElement.style.top  = (ev.clientY - dragOffsetY) + 'px';
    panelElement.style.right = 'auto';
    panelElement.style.bottom = 'auto';
}

function onMouseUp() {
    isDragging = false;
}

// ── Panel creation ───────────────────────────────────────────

function createPanel() {
    panelElement = document.createElement('div');
    panelElement.id = 'debugPanel';
    panelElement.innerHTML = `
        <div class="debug-panel-header">
            <span class="debug-panel-title">Debug Reports</span>
            <div class="debug-panel-controls">
                <button class="debug-panel-btn" id="debugPanelClear" title="Clear">Clear</button>
                <button class="debug-panel-btn" id="debugPanelClose" title="Close">&times;</button>
            </div>
        </div>
        <div class="debug-panel-content"></div>
    `;

    // Inline styles so the panel is self-contained
    Object.assign(panelElement.style, {
        position: 'fixed',
        bottom: '80px',
        right: '20px',
        width: '480px',
        maxHeight: '70vh',
        background: '#ffffff',
        borderRadius: '16px',
        boxShadow: '0 20px 60px -10px rgba(0,0,0,0.2)',
        border: '1px solid #e5e7eb',
        zIndex: '9999',
        display: 'none',
        fontFamily: "'Poppins', sans-serif",
        fontSize: '12px',
        overflow: 'hidden',
    });

    const header = panelElement.querySelector('.debug-panel-header');
    Object.assign(header.style, {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '10px 16px',
        background: '#111827',
        color: '#ffffff',
        cursor: 'grab',
        userSelect: 'none',
        borderRadius: '16px 16px 0 0',
    });

    const title = panelElement.querySelector('.debug-panel-title');
    Object.assign(title.style, {
        fontWeight: '600',
        fontSize: '13px',
        letterSpacing: '0.04em',
    });

    const controls = panelElement.querySelector('.debug-panel-controls');
    Object.assign(controls.style, { display: 'flex', gap: '6px' });

    panelElement.querySelectorAll('.debug-panel-btn').forEach(btn => {
        Object.assign(btn.style, {
            background: 'rgba(255,255,255,0.15)',
            border: 'none',
            color: '#ffffff',
            padding: '2px 10px',
            borderRadius: '8px',
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: '600',
        });
    });

    contentElement = panelElement.querySelector('.debug-panel-content');
    Object.assign(contentElement.style, {
        padding: '12px 16px',
        overflowY: 'auto',
        maxHeight: 'calc(70vh - 44px)',
        color: '#374151',
        lineHeight: '1.6',
    });

    document.body.appendChild(panelElement);

    // Dragging
    header.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    // Close / Clear
    panelElement.querySelector('#debugPanelClose').addEventListener('click', hide);
    panelElement.querySelector('#debugPanelClear').addEventListener('click', clear);
}

// ── Public API ───────────────────────────────────────────────

function show() {
    if (!panelElement) createPanel();
    panelElement.style.display = 'block';
    isVisible = true;
}

function hide() {
    if (panelElement) panelElement.style.display = 'none';
    isVisible = false;
}

function toggle() {
    isVisible ? hide() : show();
}

function clear() {
    if (contentElement) contentElement.innerHTML = '';
}

/**
 * Append a monthly or yearly FinancialPackage report to the panel.
 * @param {'monthly'|'yearly'} type
 * @param {string} dateLabel    e.g. "2026-03"
 * @param {FinancialPackage} pkg
 */
function appendReport(type, dateLabel, pkg) {
    if (!panelElement) createPanel();

    const section = document.createElement('details');
    section.style.marginBottom = '8px';
    section.style.borderBottom = '1px solid #f3f4f6';
    section.style.paddingBottom = '8px';

    const badge = type === 'yearly'
        ? '<span style="background:#7c3aed;color:#fff;padding:1px 8px;border-radius:6px;font-size:10px;font-weight:600;margin-right:6px;">YEARLY</span>'
        : '<span style="background:#2563eb;color:#fff;padding:1px 8px;border-radius:6px;font-size:10px;font-weight:600;margin-right:6px;">MONTHLY</span>';

    const summary = document.createElement('summary');
    summary.style.cursor = 'pointer';
    summary.style.fontWeight = '600';
    summary.style.padding = '4px 0';
    summary.innerHTML = badge + dateLabel;
    section.appendChild(summary);

    const table = document.createElement('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.style.fontSize = '14px';
    table.style.marginTop = '4px';

    const rows = [
        ['Income', fmt(pkg.totalIncome())],
        ['&nbsp;&nbsp;Employed', fmt(pkg.employedIncome)],
        ['&nbsp;&nbsp;Self', fmt(pkg.selfIncome)],
        ['&nbsp;&nbsp;Ordinary', fmt(pkg.ordinaryIncome())],
        ['&nbsp;&nbsp;&nbsp;&nbsp;Social Security', fmt(pkg.socialSecurity)],
        ['&nbsp;&nbsp;&nbsp;&nbsp;IRA Distribution', fmt(pkg.iraDistribution)],
        ['&nbsp;&nbsp;&nbsp;&nbsp;401K Distribution', fmt(pkg.four01KDistribution)],
        ['&nbsp;&nbsp;&nbsp;&nbsp;Short-Term Gains', fmt(pkg.shortTermCapitalGains)],
        ['&nbsp;&nbsp;&nbsp;&nbsp;Interest', fmt(pkg.interestIncome)],
        ['&nbsp;&nbsp;&nbsp;&nbsp;Non-Qual Dividends', fmt(pkg.nonQualifiedDividends)],
        ['&nbsp;&nbsp;Long-Term Gains', fmt(pkg.longTermCapitalGains)],
        ['&nbsp;&nbsp;Non-Taxable', fmt(pkg.nontaxableIncome())],
        ['Deductions', fmt(pkg.deductions())],
        ['&nbsp;&nbsp;iraContribution', fmt(pkg.iraContribution)],
        ['&nbsp;&nbsp;401K Contribution', fmt(pkg.four01KContribution)],
        ['&nbsp;&nbsp;Mortgage Interest', fmt(pkg.mortgageInterest)],
        ['&nbsp;&nbsp;Property Taxes', fmt(pkg.propertyTaxes)],
        ['Taxes', fmt(pkg.totalTaxes())],
        ['&nbsp;&nbsp;FICA', fmt(pkg.fica)],
        ['&nbsp;&nbsp;Income Tax', fmt(pkg.incomeTax)],
        ['&nbsp;&nbsp;LT Cap Gains Tax', fmt(pkg.longTermCapitalGainsTax)],
        ['&nbsp;&nbsp;Property Taxes', fmt(pkg.propertyTaxes)],
        ['&nbsp;&nbsp;Estimated Taxes', fmt(pkg.estimatedTaxes)],
        ['Contributions', fmt(pkg.contributions())],
        ['&nbsp;&nbsp;Roth Contribution', fmt(pkg.rothContribution)],
        ['&nbsp;&nbsp;Mortgage Principal', fmt(pkg.mortgagePrincipal)],
        ['Asset Growth', fmt(pkg.growth())],
        ['Earning', fmt(pkg.earning())],
        ['Effective Tax Rate', pkg.effectiveTaxRate().toFixed(2) + '%'],
        ['Expenses', fmt(pkg.expense)],
    ];

    let html = '';
    for (const [label, value] of rows) {
        const isHeader = !label.startsWith('&nbsp;');
        const bg = isHeader ? '#f9fafb' : '#ffffff';
        const weight = isHeader ? '600' : '400';
        html += `<tr style="background:${bg}"><td style="padding:2px 6px;font-weight:${weight}">${label}</td><td style="padding:2px 6px;text-align:right;font-family:monospace">${value}</td></tr>`;
    }
    table.innerHTML = html;
    section.appendChild(table);

    contentElement.prepend(section);

    // Auto-show if hidden
    if (!isVisible) show();
}

function fmt(currency) {
    if (currency && typeof currency.toString === 'function') return currency.toString();
    return String(currency);
}

// Expose on window for console use
if (typeof window !== 'undefined') {
    window.debugPanel = { show, hide, toggle, clear, appendReport };
}

export { show, hide, toggle, clear, appendReport };
