# FinPlan UI specification — implementation guide

## Document purpose
This is the authoritative design specification for the FinPlan financial planning tool UI. It captures architectural decisions, interaction patterns, and implementation status. Hand this to Claude Code as the source of truth.

---

## 1. Design philosophy

### Core principle: everything visible, scroll = detail
The entire UI is a single vertical page. There are no tabs, no hidden panels. Every tool and dataset is visible on load. Scroll position determines information density — summary at top, raw data at bottom.

### Information architecture
The page reads top-to-bottom as a progressive density gradient. Each section is a named region with its own heading, glass-card container, and "Viewing" badge.

```
Header              → app identity + recalculate action
Settings            → global assumptions (full-width glass-card)
─── Timeline + Portfolio (75/25 side-by-side) ───
  Your Timeline     → temporal navigation (year/month dropdowns, phase dots)
  Your Portfolio    → grouped asset hierarchy + add asset
─── Projections (full-width) ───
  Macro + Micro     → side-by-side charts in one glass-card
─── Simulations (full-width) ───
  Monte Carlo + Guardrails → side-by-side, on-demand (Run buttons)
─── Details (full-width) ───
  Spreadsheet + Report → side-by-side, scrollable containers
─── Tools (full-width) ───
  Visualizer        → hydraulic flow animation (on-demand Run button)
  Maximizer         → genetic algorithm optimizer (on-demand Run button)
Footer
```

### No tabs, no accordions
We explicitly rejected tabbed navigation and collapsible panels. Both force the user to hold mental state across hidden views. The vertical scroll model means the user's position on the page *is* their level of detail.

### On-demand execution
Expensive operations (Monte Carlo, Guardrails, Visualizer, Maximizer) are triggered by explicit Run buttons rather than auto-running on every recalculation. This keeps the page responsive and gives the user control over when to spend computation.

---

## 2. Design system: Modern1

### Visual language
- **Font**: Poppins (400/500/600/700)
- **Body background**: #fcfcfd
- **Text**: #111827
- **Borders/grays**: #e5e7eb / #f3f4f6
- **Glass-card**: white bg, 24px border-radius, subtle shadow (`0 20px 40px -15px rgba(0,0,0,0.05)`), 1px border
- **Inputs** (`fin-input`): #f3f4f6 bg, 12px border-radius, purple focus ring
- **Buttons** (`btn-modern`): primary = black bg, outline = white with gray border
- **Gradient text**: purple-to-pink gradient for brand accent
- **Badge (coral)**: background #FAECE7, text #993C1D, pill shape, 11px font
- **Scrollbars**: thin (8px), gray thumb, transparent track
- **Max width**: 1400px centered with responsive padding

### Not Tidewater
The original index.html used a design system internally called "Tidewater" (DM Sans/Fraunces fonts, CSS vars like `--cream`, `--ink`, `--rule`). FinPlan uses Modern1 exclusively. Do not reference Tidewater tokens or link index.css.

---

## 3. Layout structure

### Header
Full-width. Contains app title ("Charting Finance.") with gradient text accent, tagline, and Recalculate button. Separated from settings by a bottom border. Scrolls away — not sticky.

### Settings row
Full-width glass-card with 6-column grid: Current Age, Retirement Age, Finish Age, Filing As, Inflation, Backtest from Year. All use `fin-input` styling. Changes trigger recalculation.

### Timeline + Portfolio (75/25 split)
Side-by-side in a flex row with `gap: 32px` and fixed height (360px).

**Left (flex: 3) — Your Timeline:**
- Section heading with clock emoji
- Glass-card containing `<finplan-timeline>` component
- Year/month dropdown selectors styled in coral (#FAECE7 bg, #993C1D text) to match badges
- Dropdowns centered horizontally
- Phase bar: colored dots for life events with connecting lines, S/F anchors, age labels
- Pure HTML/CSS rendering (no Chart.js canvas)

**Right (flex: 1) — Your Portfolio:**
- Section heading with briefcase emoji
- "Viewing: [Month] [Year]" badge centered at top of the glass-card
- `<asset-list>` component with grouped assets (collapsible group headers)
- Floating black circle "+" button (bottom-right) for adding assets
- Independent vertical scroll within container

### Projections (full-width)
Section heading with chart emoji + "Viewing" badge (right-aligned).

Glass-card containing Macro and Micro charts **side-by-side** in a flex row with `gap: 24px`:
- **Macro Projection**: grouped stacked bar chart (asset groups with stable colors)
- **Micro Projection**: cash flow rollup chart

Both charts use `finplan-chart-canvas-wrap` (375px height). Chart.js with `responsive: true`, `maintainAspectRatio: false`.

### Simulations (full-width)
Section heading with dice emoji + "Viewing" badge.

Glass-card containing Monte Carlo and Guardrails **side-by-side**, each with its own slot heading row containing a `Run` button:
- **Monte Carlo**: 1,000-simulation fan chart with P10/P25/P50/P75/P90 percentile bands, deterministic baseline, retirement annotation line. Renders into a container div (creates its own canvas).
- **Guardrails**: Guyton-Klinger dual-axis chart — portfolio value (left axis, blue) + annual withdrawal (right axis, red step-line) with preservation/prosperity event markers.

Both are **on-demand** — triggered by their respective Run buttons, not auto-run on recalculate.

### Details (full-width)
Section heading with clipboard emoji + "Viewing" badge.

Two glass-cards **side-by-side**, each with `max-height: 440px` and `overflow: auto`:
- **Spreadsheet**: `<spreadsheet-view>` — monthly tabular data for all assets and metrics. Sticky heading within scroll container.
- **Report**: `<report-view>` — collapsible monthly/yearly financial reports with income/tax/cash flow breakdowns. Sticky heading within scroll container.

Both auto-scroll to the selected year/month when the timeline date changes (scrolls within container, not the page). Matched row/entry gets a temporary coral highlight.

### Visualizer (full-width)
Section heading with faucet emoji.

Glass-card with date display header, Run button, and dark container (`#1e1e2e`, 600px height, 12px border-radius) for the hydraulic SVG animation. On-demand via Run button. Uses `chronometer_run_animated()` to step through the simulation with 80ms animated ticks, rendering asset tanks, flow pipes, and value changes.

### Maximizer (full-width)
Section heading with crystal ball emoji.

Glass-card with description text and Run button. Launches `<simulator-modal>` overlay — a genetic algorithm that optimizes fund transfer allocations and guardrail parameters. Population of 50, 200 generations, with live progress display.

### Footer
Simple footer with app name and version label.

---

## 4. Dropped concepts

### Sacred x-axis alignment
The original spec required pixel-perfect alignment between the timeline and all chart x-axes. This was attempted with a Chart.js canvas timeline sharing a `FORCED_Y_AXIS_WIDTH = 60px` via `afterFit` callbacks. The result looked worse than a clean HTML timeline. **Dropped in favor of visual quality.** Charts are now full-width in their own section, decoupled from the timeline.

### Sticky timeline
The timeline was originally sticky-positioned (`position: sticky; top: 0`). With the layout change to timeline + portfolio side-by-side, stickiness was dropped. The timeline scrolls with the page. The "Viewing" badges on each section provide continuity.

### 80/20 chart/sidebar split
The original spec had charts in an 80% column with the portfolio sidebar in a 20% column running the full chart zone height. This created empty space in the sidebar and constrained chart widths. **Replaced with:** timeline + portfolio at 75/25 at the top, charts full-width below. Charts get more horizontal space; portfolio is visible where it matters (near the timeline).

---

## 5. Badge system

### Badge purpose
Badges are small inline coral indicators that echo the selected timeline date across sections. They let the user see temporal context without scrolling back to the timeline.

### Badge visual design
- **Color scheme**: coral — background #FAECE7, text #993C1D, border #F5D0C5
- **Shape**: pill/rounded rectangle, `border-radius: 999px`
- **Typography**: 11px, font-weight 500
- **Placement**: right-aligned in section heading rows (via `ml-auto` in flex container)

### Current badge placements

| Location | Badge content | Updates on |
|----------|--------------|------------|
| Your Portfolio (in glass-card) | "Viewing: [Month] [Year]" | Date change |
| Projections heading | "Viewing: [Month] [Year]" | Date change |
| Simulations heading | "Viewing: [Month] [Year]" | Date change |
| Details heading | "Viewing: [Month] [Year]" | Date change |

### Future badge enhancements
- Macro badge: active metric + aggregate value at selected date
- Micro badge: top asset values at selected date
- Monte Carlo badge: success probability at selected date
- Guardrails state badge: "Above floor" / "Near floor" / "Below floor" with semantic colors
- Report/spreadsheet carry-down badges echoing the active chart metric

---

## 6. Timeline date sync

The selected timeline date (via year/month dropdowns) is global state managed by `FinPlanStore` (an `EventTarget` singleton). It drives:

1. **Timeline dropdowns** — coral-styled selects update store
2. **All "Viewing" badges** — update text across all sections
3. **Spreadsheet** — auto-scrolls within its container to the matching month row, coral highlight
4. **Report** — auto-scrolls within its container to the matching entry, opens it, coral highlight

### Future date sync targets
- Chart crosshair/highlight at the selected date
- Monte Carlo percentile values recalculated at selected date
- Guardrails status assessed at selected date
- Phase-aware metric toggle adjusting priorities based on accumulation vs retirement

---

## 7. Metric system (future)

### Available metrics (5 total)

| Metric | Description | Primary phase |
|--------|-------------|---------------|
| **Wealth** | Net worth trajectory | Accumulation |
| **Balance** | Raw account balances | Both |
| **Growth** | Rate of return / growth percentage | Both |
| **Income** | Portfolio-generated income streams | Retirement |
| **Withdrawal** | Distribution amounts from accounts | Retirement |

### Current state
The macro chart uses a grouped stacked bar driven by `activeMetricName` (defaults to `Metric.VALUE`). The micro chart shows cash flow rollup. No metric toggle UI exists yet.

### Future implementation
- Metric toggle UI with all five metrics, placed in the Projections section
- Phase-aware toggle: visually prioritize metrics relevant to the current timeline phase
- Metric sync: changing metric propagates to macro, micro, Monte Carlo, and guardrails
- Monte Carlo and guardrails respond to metric changes (recompute per metric)

---

## 8. State management

Three pieces of global state in `FinPlanStore` (`js/finplan-store.js`):

1. **Selected date** (`#selectedDateInt`) — DateInt, drives timeline, badges, detail scrolling
2. **Active metric** (`#activeMetric`) — Metric enum value, drives chart rendering
3. **Asset visibility** (`#assetVisibility`) — Map<string, boolean>, drives chart line toggling

Mutators dispatch CustomEvents: `date-change`, `metric-change`, `visibility-change`.

Additionally, `#retirementDateInt` is set at init to determine phase boundaries.

---

## 9. Implementation status

### Done
- [x] Header with app identity and recalculate button
- [x] Settings row (6 fields in glass-card)
- [x] Timeline with year/month dropdowns (coral styled) and phase dot bar
- [x] Portfolio sidebar with grouped assets, collapsible headers, add-asset button
- [x] Timeline + Portfolio side-by-side (75/25 at fixed 360px)
- [x] "Viewing" badges on Portfolio, Projections, Simulations, Details headings
- [x] Macro chart (grouped stacked bar)
- [x] Micro chart (cash flow rollup)
- [x] Monte Carlo fan chart with Run button
- [x] Guardrails dual-axis chart with Run button
- [x] Spreadsheet view (live data, scrollable container)
- [x] Report view (live data, scrollable container)
- [x] Detail auto-scroll to selected month with coral highlight
- [x] Visualizer (hydraulic animation with Run button)
- [x] Maximizer (genetic algorithm optimizer with Run button)
- [x] Modern1 design system throughout
- [x] Reactive state store (FinPlanStore)
- [x] Footer

### Remaining
- [ ] Metric toggle UI (5 metrics with phase-aware prioritization)
- [ ] Metric sync across all chart layers
- [ ] Rich badges (metric values, success probability, guardrails state)
- [ ] Report summary cards (4-column grid above detail table)
- [ ] "Now" marker on timeline and charts
- [ ] Chart crosshair at selected timeline date
- [ ] Responsive collapse (< 1024px)

---

## 10. Technical notes

### File structure
- `finplan.html` — layout skeleton, Modern1 styles, all section containers
- `js/finplan-app.js` — orchestrator (globals, simulation, chart wiring, event handling)
- `js/finplan-store.js` — reactive state store (EventTarget singleton)
- `js/components/finplan-timeline.js` — Lit component, pure HTML/CSS phase bar

### No build step
ES modules served directly. CDN imports for Tailwind, Chart.js, Lit 3, Poppins, lz-string.

### Two entry points coexist
- `index.html` + `js/app.js` — original tab-based UI
- `finplan.html` + `js/finplan-app.js` — new vertical scroll UI

Same localStorage data, same simulation engine, same Lit components.

### Performance
- Projections (macro + micro) render on every recalculate
- Simulations (Monte Carlo + Guardrails) are on-demand via Run buttons
- Visualizer is on-demand, runs async with 80ms tick animation
- Maximizer is on-demand, uses a Web Worker for the genetic algorithm
- Detail scroll uses container-local scrolling (not page scroll)

---

## 11. Glossary

| Term | Definition |
|------|------------|
| **Macro** | The grouped asset projection chart (stacked bar by asset group) |
| **Micro** | The cash flow rollup chart |
| **Foundation / Details** | The full-width section containing spreadsheet and report |
| **Carry-down badge** | A badge on a foundation component that echoes the active chart metric (future) |
| **Phase-aware toggle** | The metric selector that visually prioritizes different metrics depending on timeline phase (future) |
| **Explore date** | The date selected via the year/month dropdowns, distinct from "now" (the actual current date) |
| **State badge** | A badge that shows qualitative status (e.g., "Above floor") rather than a numeric value (future) |
| **Visualizer** | Hydraulic flow animation showing money movement through the portfolio |
| **Maximizer** | Genetic algorithm optimizer for fund transfers and guardrail parameters |
| **Modern1** | The design system used by finplan.html — Poppins, white/gray palette, glass-card, coral badges |
| **On-demand** | Execution pattern where expensive operations require an explicit Run button click |
