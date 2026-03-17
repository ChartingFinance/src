# FinPlan UI specification — implementation guide

## Document purpose
This is the authoritative design specification for the FinPlan financial planning tool UI. It captures architectural decisions, interaction patterns, and phased implementation guidance. Hand this to Claude Code as the source of truth.

---

## 1. Design philosophy

### Core principle: the timeline is the instrument
The entire UI is organized around a single horizontal timeline that represents the user's financial life. Every visual layer below the timeline shares its x-axis. Scroll position determines information density — summary at top, raw data at bottom. There are no tabs, no modals, no hidden panels. Everything is visible on load.

### Information architecture
The page reads top-to-bottom as a progressive density gradient:

```
Global bar          → settings and assumptions
Pinned timeline     → temporal navigation (sacred x-axis)
Macro projection    → grouped asset chart
Micro projection    → individual asset chart
Monte Carlo         → probability simulation
Guardrails          → floor/ceiling thresholds
────────────────────── visual break: full-width foundation ──────
Report              → summary cards + detail table
Spreadsheet         → year-by-year raw data
────────────────────── secondary tools ──────
Visualizer          → what-if scenarios, custom charts
Maximizer           → optimization recommendations
```

### No tabs, no accordions
We explicitly rejected tabbed navigation and collapsible panels. Both force the user to hold mental state across hidden views. The vertical scroll model means the user's position on the page *is* their level of detail.

---

## 2. Layout structure

### Global bar
Fixed at the very top. Contains:
- App identity (logo/name)
- Global assumptions: inflation rate, expected return, tax bracket
- Settings access

Not sticky — scrolls away. These are set-and-forget values.

### Pinned timeline
**Sticky-positioned** below the global bar. Does not scroll away. This is the single most important UI element.

#### X-axis alignment (sacred constraint)
The left edge of the timeline bar aligns pixel-for-pixel with the left edge of every chart below. The right edge does the same. The timeline IS the shared x-axis. This means:
- Timeline and all charts must share the same container width
- Any padding, margins, or borders must be identical across the timeline and all chart layers
- The "now" marker at, say, 35% across the timeline must correspond to 35% across every chart
- Implementation should use a shared constant or CSS variable for the chart content area boundaries

#### Timeline controls
- **Year dropdown** — select any year in the planning horizon
- **Month dropdown** — select month within the year
- No drag-based scrubbing. Dropdowns provide precision without fine motor overhead.

#### Timeline visual elements
- **Phase bar** — horizontal track showing accumulation phase (teal) and retirement phase (blue)
- **"Now" marker** — thin vertical line at the current real-world date
- **Phase labels** — "Accumulation" and "Retirement" text labels, plus "now" and "retire" markers above the bar
- **Viewing badge** — coral pill showing "Viewing: [Month] [Year]" reflecting the dropdown selection

### 80/20 split
Below the pinned timeline, the content area divides:
- **80% left column** — chart layers, stacked vertically
- **20% right column** — portfolio sidebar

This split persists from the macro projection through guardrails. The sidebar border aligns with the right edge of the charts.

### Portfolio sidebar (20% column)
Contains the user's asset hierarchy:
```
My portfolios
  Tax-advantaged
    401k
    Roth IRA
  Taxable
    Brokerage
    Crypto
  Real assets
    Home equity
```

Plus quick tools:
- + Add asset
- + New group

The sidebar is allowed to be tall and partially empty. It does not morph or change content based on scroll position — that was explicitly rejected as too complex. It runs the full height of the 80/20 split zone.

**Future consideration:** The empty sidebar space below the portfolio list could potentially house the Visualizer and Maximizer tools. Not for initial implementation.

### Full-width foundation
Below the 80/20 split, a **visual break** (2px border or heavier divider) signals the transition from chart territory to data territory. Everything below this break is full-width — no sidebar.

This visual break also signals a **sync boundary** — see metric sync rules below.

---

## 3. Chart layers (within 80% column)

All chart layers share the sacred x-axis. A vertical "now" reference line appears at the same horizontal pixel position on every chart.

### Layer 1: Macro — grouped asset projection
- Shows projection lines for each asset group (tax-advantaged, taxable, real assets)
- Color-coded by group with legend labels at the right edge
- **Metric selector** toggle: see section 5
- **Badge** showing the active metric's value at the selected timeline date (e.g., "Wealth · $2.1M")

### Layer 2: Micro — individual asset projection
- Shows projection lines for each individual asset (401k, Roth IRA, brokerage, crypto, home equity)
- Color-coded by asset with legend labels at the right edge
- **Metric selector** toggle: synced bidirectionally with macro (see section 5)
- **Badges** showing top asset values at the selected date (e.g., "401k $890k", "Home $480k")

### Layer 3: Monte Carlo
- Probability cone with P10, P50, P90 bands
- Individual simulation traces at low opacity
- **Metric-aware**: cone recomputes based on active metric (see section 5)
- **Badge** showing success probability or metric-specific summary at the selected date

### Layer 4: Guardrails
- Projected path line against floor (red dashed) and ceiling (green dashed) thresholds
- **Metric-aware**: thresholds adapt to active metric (see section 5)
- **State badge** showing qualitative status: "Above floor", "Near floor", "Below floor" — color-coded green/amber/red

---

## 4. Foundation layers (full-width)

### Layer 5: Report
- **Summary cards** in a 4-column grid: net worth, annual draw, tax burden, success probability
- **Detail table** with columns: account, balance, withdrawal, tax impact, % of total, YoY change
- **Total row** at the bottom with aggregated values
- Synced to the timeline date — all values reflect the selected year/month
- **Carry-down badge** in the header: displays the currently active chart metric and its value (e.g., "Charts showing: Wealth · $2.1M at Jun 2047"). This is informational only — not interactive.
- Column structure does NOT change when the chart metric changes (see section 5)

### Layer 6: Spreadsheet
- Monospace font, year-by-year tabular data
- Columns: year, each account balance, net total
- The selected year's row is **highlighted** with the coral color scheme
- Surrounding rows (±2 years) provide context
- Auto-scrolls so the highlighted row is visible/centered
- **Carry-down badge** in the header: "Scrolled to: [Year]" plus the active chart metric echo
- Column structure does NOT change when the chart metric changes (see section 5)

### Layer 7+: Visualizer and Maximizer
- Placed below the foundation as secondary power tools
- **Visualizer**: scenario comparison, what-if overlays, custom chart builder
- **Maximizer**: optimization suggestions, tax-loss harvesting, rebalance recommendations
- These are not part of the core navigation flow. Implementation is lower priority.

---

## 5. Metric system

### Available metrics (5 total)

| Metric | Description | Primary phase |
|--------|-------------|---------------|
| **Wealth** | Net worth trajectory. The accumulation-phase hero metric. "Is my number going up?" | Accumulation |
| **Balance** | Raw account balances. Phase-neutral accounting view. | Both |
| **Growth** | Rate of return / growth percentage. Phase-neutral analytical view. | Both |
| **Income** | Portfolio-generated income streams. Retirement-phase hero. "What's coming in?" | Retirement |
| **Withdrawal** | Distribution amounts from accounts. Retirement-phase hero. "How much can I take?" | Retirement |

### Phase-aware metric toggle

The metric selector displays all five metrics but **visually prioritizes** metrics relevant to the current timeline phase.

**When viewing a date in the accumulation phase:**
- Primary (full visual weight): Wealth, Balance, Growth
- Demoted (smaller, lighter, or grouped under "more"): Income, Withdrawal

**When viewing a date in the retirement phase:**
- Primary (full visual weight): Withdrawal, Income, Balance
- Demoted (smaller, lighter, or grouped under "more"): Wealth, Growth

All five metrics are always accessible regardless of phase. The filtering is a visual suggestion, not a restriction.

**Phase transition behavior:** When the user changes the timeline date from accumulation to retirement (or vice versa), the toggle layout updates to reflect the new phase's priorities. If the currently active metric becomes demoted, it remains active — the toggle rearranges around it but does not force a metric change.

### Metric sync rules

#### Synced zone (chart layers — within the 80/20 split)

| Component | Syncs? | Behavior |
|-----------|--------|----------|
| Macro | Yes | Bidirectional. Changing metric here updates micro, Monte Carlo, guardrails. |
| Micro | Yes | Bidirectional. Changing metric here updates macro, Monte Carlo, guardrails. |
| Monte Carlo | Yes | Follows the active metric. Probability cone recomputes. Badge updates to reflect metric-appropriate language (e.g., "87% success" for wealth, "87% of scenarios exceed 4.2%" for growth). |
| Guardrails | Yes | Follows the active metric. Floor/ceiling thresholds adapt: dollar thresholds for wealth/balance, rate thresholds for growth, income/withdrawal floors for income/withdrawal metrics. State badge updates accordingly. |

A metric change on ANY synced component propagates to ALL synced components. There is no primary/secondary — macro and micro are peers.

#### Unsynced zone (foundation layers — full-width)

| Component | Syncs? | Behavior |
|-----------|--------|----------|
| Report | No | Columns always show: balance, withdrawal, tax impact, % of total, YoY. Structure never changes. |
| Spreadsheet | No | Columns always show: year, account balances, net total. Structure never changes. |

**Carry-down badges**: Although the report and spreadsheet do not change their data structure, they display a **carry-down badge** that echoes the active chart metric and its aggregate value at the selected date. Example: if the charts are set to "Growth" and the date is Jun 2047, the report header shows a badge reading "Charts showing: Growth · 4.2% at Jun 2047". This provides continuity without requiring the tables to restructure.

**Rationale**: Rebuilding table columns per metric means either maintaining multiple table schemas or handling every format permutation. The visual break to full-width already signals a context shift. The carry-down badge bridges the gap cheaply.

---

## 6. Badge system

### Badge purpose
Badges are small inline indicators that echo synchronized state (timeline date, active metric, computed values) across topographically distant regions of the page. They let the user see connected information without scrolling.

### Badge visual design
- **Color scheme**: coral family — background #FAECE7, text #993C1D
- **Shape**: pill/rounded rectangle, small (fits inline with section headers)
- **Typography**: 10-11px, consistent across all badge instances
- **Exception — state badges**: guardrails status badge uses semantic colors (green for healthy, amber for warning, red for danger) instead of coral

### Badge placements

| Location | Badge content | Updates on |
|----------|--------------|------------|
| Pinned timeline | "Viewing: [Month] [Year]" | Date change |
| Macro chart | "[Metric] · [value]" (e.g., "Wealth · $2.1M") | Date change, metric change |
| Micro chart | Top 2-3 asset values (e.g., "401k $890k · Home $480k") | Date change, metric change |
| Monte Carlo | "[Success %] at [Month] [Year]" or metric-specific summary | Date change, metric change |
| Guardrails | State badge: "Above floor" / "Near floor" / "Below floor" | Date change, metric change |
| Report header | "Charts showing: [Metric] · [value] at [Month] [Year]" | Date change, metric change |
| Spreadsheet header | "Scrolled to: [Year]" + metric echo | Date change, metric change |

### Badge behavior rules
1. All badges update simultaneously when the timeline date changes
2. Chart-zone badges update when the active metric changes
3. Foundation-zone badges update their metric *echo text* but do not alter the table data
4. Badges are read-only — they are not interactive controls
5. Badge values must round appropriately: integers for counts, 1-2 decimals for percentages, abbreviated for currency ($2.1M not $2,112,347)
6. When a metric produces a near-zero or flat value (e.g., withdrawal during accumulation), the badge should still display the value rather than hiding — it reinforces the phase distinction

---

## 7. Timeline date sync

The selected timeline date (via year/month dropdowns) is a global state that drives:

1. **Pinned timeline** — viewing badge updates, selection indicator moves
2. **All chart layers** — if charts support a crosshair or highlight at the selected date, they show it
3. **Monte Carlo** — percentile values recalculated at the selected date
4. **Guardrails** — status assessed at the selected date
5. **Report** — summary cards and detail table show values for the selected date
6. **Spreadsheet** — selected year row is highlighted with coral background, table auto-scrolls to center it
7. **All badges** — update to reflect values at the new date
8. **Phase-aware metric toggle** — if the date crosses the accumulation/retirement boundary, toggle layout updates

---

## 8. Implementation phases

### Phase 1: Layout skeleton and timeline
**Goal**: Establish the sacred x-axis and the full vertical structure.

- [ ] Global bar with editable assumption fields (inflation, return, tax bracket)
- [ ] Pinned (sticky) timeline with year/month dropdown selectors
- [ ] Timeline phase bar with accumulation/retirement coloring
- [ ] "Now" marker and phase transition marker on timeline
- [ ] "Viewing: [date]" badge on timeline
- [ ] 80/20 column split below timeline
- [ ] Portfolio sidebar with static asset hierarchy (grouped and individual)
- [ ] Placeholder containers for each chart layer at correct widths
- [ ] Full-width foundation section below the split with visual break divider
- [ ] Placeholder containers for report and spreadsheet
- [ ] Placeholder containers for visualizer and maximizer

**Acceptance criteria**: Changing the year/month dropdown updates the "Viewing" badge. All placeholder containers share identical left/right content boundaries. The timeline is sticky on scroll. The 80/20 split is visually correct with the sidebar running the full chart zone height.

### Phase 2: Chart rendering with metric sync
**Goal**: Render real projection data in all four chart layers with synchronized metric switching.

- [ ] Macro chart: render grouped asset projection lines from model data
- [ ] Micro chart: render individual asset projection lines from model data
- [ ] Monte Carlo chart: render probability cone with P10/P50/P90 bands
- [ ] Guardrails chart: render projected path against floor/ceiling lines
- [ ] Implement metric toggle UI with all five metrics: wealth, balance, growth, income, withdrawal
- [ ] Phase-aware toggle: visually prioritize metrics based on whether selected date is in accumulation or retirement
- [ ] Metric sync: changing metric on any chart layer propagates to all chart layers
- [ ] Monte Carlo and guardrails respond to metric changes (recompute cone/thresholds per metric)
- [ ] "Now" vertical reference line appears at the same x-position on all four charts
- [ ] Verify x-axis pixel alignment: timeline endpoints match chart endpoints exactly

**Acceptance criteria**: Switching from "Wealth" to "Growth" on the micro chart updates the macro chart, Monte Carlo, and guardrails simultaneously. The "now" line is vertically continuous across all layers. Charts resize correctly if the browser window changes width.

### Phase 3: Badge system
**Goal**: Implement cross-region badges that echo state across the page.

- [ ] Macro chart badge: shows active metric + value at selected date
- [ ] Micro chart badges: show top 2-3 individual asset values at selected date
- [ ] Monte Carlo badge: shows success probability or metric-specific summary at selected date
- [ ] Guardrails state badge: "Above floor" / "Near floor" / "Below floor" with semantic coloring
- [ ] Report carry-down badge: "Charts showing: [Metric] · [value] at [date]"
- [ ] Spreadsheet carry-down badge: "Scrolled to: [Year]" + metric echo
- [ ] All badges update on date change
- [ ] Chart-zone badges update on metric change
- [ ] Foundation carry-down badges update metric echo text on metric change
- [ ] Number formatting: abbreviated currency ($2.1M), 1-2 decimal percentages, integer counts

**Acceptance criteria**: Changing the timeline date from 2035 to 2055 updates every badge on the page. Changing the metric from "Balance" to "Withdrawal" updates all chart-zone badges and the carry-down badge text on report/spreadsheet headers. Badge values are correctly rounded and formatted.

### Phase 4: Foundation tables
**Goal**: Build the report and spreadsheet with timeline date sync.

- [ ] Report summary cards: 4-column grid (net worth, annual draw, tax burden, success probability)
- [ ] Report detail table: account, balance, withdrawal, tax impact, % of total, YoY change
- [ ] Report total row with aggregated values
- [ ] Spreadsheet: monospace year-by-year table with all accounts + net column
- [ ] Spreadsheet row highlight: selected year row gets coral background
- [ ] Spreadsheet context rows: show ±2 years around the selected year
- [ ] Spreadsheet auto-scroll: highlighted row centers in view when date changes
- [ ] Report and spreadsheet column structure remains static regardless of metric changes
- [ ] Carry-down badges in both headers (implemented in phase 3, wired to data here)

**Acceptance criteria**: Changing timeline date to 2047 highlights the 2047 row in the spreadsheet, updates all report card values to 2047 data, and the detail table shows 2047 account-level data. Switching the chart metric does NOT change any column in the report or spreadsheet — only the carry-down badge text updates.

### Phase 5: Portfolio sidebar interactivity
**Goal**: Make the sidebar functional for controlling chart visibility.

- [ ] Clicking an asset group toggles its visibility on the macro chart
- [ ] Clicking an individual asset toggles its visibility on the micro chart
- [ ] Visual indication of toggled-off state (dimmed text, unchecked indicator)
- [ ] "Add asset" and "New group" actions (wire to data model)
- [ ] Sidebar scroll behavior: if the asset list exceeds the chart zone height, the sidebar scrolls independently

**Acceptance criteria**: Toggling off "Taxable" in the sidebar hides the taxable line on the macro chart. Toggling off "Crypto" hides the crypto line on the micro chart. Toggled-off assets do not contribute to badge values.

### Phase 6: Visualizer and Maximizer
**Goal**: Build the secondary power tools below the foundation.

- [ ] Visualizer: scenario comparison (overlay alternate assumption sets on the same chart)
- [ ] Visualizer: what-if builder (adjust a single variable and see the projection delta)
- [ ] Maximizer: optimization suggestions based on current portfolio and goals
- [ ] Maximizer: tax-loss harvesting recommendations
- [ ] Maximizer: rebalance recommendations
- [ ] Placement below foundation, potentially exploring use of empty sidebar space

**Acceptance criteria**: User can create a what-if scenario (e.g., "retire 2 years earlier") and see it overlaid on the main projection. Maximizer surfaces at least one actionable recommendation based on the current portfolio state.

---

## 9. Technical constraints and notes

### X-axis alignment implementation
The sacred x-axis constraint is the hardest technical requirement. Recommended approach:
- Define a shared `chartContentLeft` and `chartContentRight` value (in px or %) that both the timeline and all chart containers use for their drawable area
- Account for y-axis labels on charts — these eat into the left side. The timeline must have an equivalent left offset
- If using a charting library, ensure the plot area boundaries are extractable and matchable
- Test with browser DevTools overlay: a vertical line drawn at any x-position on the timeline should cross the same temporal point on every chart

### State management
Three pieces of global state drive the entire UI:
1. **Selected date** (year + month) — drives timeline position, badge values, report/spreadsheet data, phase-aware toggle
2. **Active metric** (one of: wealth, balance, growth, income, withdrawal) — drives chart rendering, badge content, Monte Carlo/guardrails computation
3. **Asset visibility** (per-asset boolean) — drives which lines appear on charts, which assets contribute to aggregate badge values

These three should be in a single reactive store (React context, Zustand, or similar). Every component subscribes to what it needs.

### Performance considerations
- Monte Carlo recomputation on metric change could be expensive. Consider caching simulation results for all metrics upfront, or debouncing the metric switch.
- Spreadsheet auto-scroll should use `scrollIntoView({ behavior: 'smooth', block: 'center' })` or equivalent.
- Sticky timeline must not cause layout thrashing — use `position: sticky` with a known `top` value, not JS scroll listeners.

### Responsive behavior
- Below ~1024px viewport width, the 80/20 split may need to collapse to a stacked layout (sidebar above or below charts). This is a phase 5+ concern.
- The pinned timeline should remain full-width in all viewport sizes.
- Badge text should truncate gracefully if the viewport is narrow.

---

## 10. Glossary

| Term | Definition |
|------|------------|
| **Sacred x-axis** | The constraint that the timeline and all chart layers share identical horizontal pixel boundaries for their time axis |
| **Pinned timeline** | The sticky-positioned timeline bar with year/month selectors that remains visible on scroll |
| **Macro** | The grouped asset projection chart (layer 1) |
| **Micro** | The individual asset projection chart (layer 2) |
| **Foundation** | The full-width section below the 80/20 split containing report and spreadsheet |
| **Carry-down badge** | A badge on a foundation component that echoes the active chart metric without changing the component's data structure |
| **Phase-aware toggle** | The metric selector that visually prioritizes different metrics depending on whether the selected date falls in accumulation or retirement |
| **Explore date** | The date selected via the year/month dropdowns, distinct from "now" (the actual current date) |
| **State badge** | A badge that shows qualitative status (e.g., "Above floor") rather than a numeric value |
| **Visualizer** | Power tool for scenario comparison and what-if analysis |
| **Maximizer** | Power tool for optimization recommendations |
