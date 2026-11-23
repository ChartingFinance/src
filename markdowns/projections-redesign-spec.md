# Spec 19 — Projections: one full-width drill-down chart, real dollars, and where spending comes from

Status: **IMPLEMENTED 2026-11-22 (Phases 1 & 2 complete).**

Today `#sec-projections` gives equal half-width slots to **Macro Projection** and **Micro Projection**. On load, Micro is empty until the user scrolls back up to Portfolio and expands a group; Macro is nominal-only, shows one bar slice on hover, and cannot jump the timeline cursor. This spec merges them into **one full-width drill-down Projections card** that earns its real estate: local drill-down pills, `Today's $ | Nominal` toggle, a metric-aware 4-tile KPI strip, stacked index-mode tooltips with totals, inflection-point markers, click-to-jump cursor sync, and (in Phase 2) a **Where Spending Comes From** view built directly from the ledger.

Five rules hold throughout:

- **No dead half on load.** One full-width chart replaces the 50/50 split; drilling into individual accounts happens right inside Projections, not via remote accordions two sections above.
- **Today's dollars are first-class.** Every view supports `Today's $` and `Nominal` using the simulation's own `monthlyPriceIndex`, matching Timeline and Outcome.
- **Every bar tells the whole year's story.** Hover shows the year, age, every non-zero layer sorted largest-first, and the stacked total; clicking a bar jumps the timeline cursor to that year.
- **Local controls stay local.** Switching Projections' view or drill-down does not silently mutate the Timeline, Asset List, or Visualizer.
- **Zero engine changes for Phase 1.** All Phase 1 data already lives on `portfolio` (`getHistory`, `monthlyPackages`, `monthlyPriceIndex`, `lifeEvents`); Phase 2's funding-sources view reads the existing ledger via `money-flows.js`.

---

## 1. What exists

Measured 2026-11-22 on `main` (`bb0632c`):

- **Side-by-side layout (`index.html`):** `#sec-projections` puts `#finplan-macro-slot` and `#finplan-micro-slot` side by side (`flex gap-6`), each inside a `375px` `.finplan-chart-canvas-wrap`.
- **Empty Micro on load (`js/finplan-app.js`):** Because `expandedGroups` starts empty, half of the section opens as `"Expand a group to see data"`. Expanding a group requires scrolling up past `#sec-simulations` into `#sec-portfolio`.
- **Default single-slice tooltips & nominal-only bars (`js/charting.js`):** `charting_buildGroupedMetric` leaves Chart.js's default `interaction.mode` (`nearest`), so hovering a stacked bar shows one slice with no total, no real-dollar figure, and no age. `hasRealDollarLine` (`js/metric.js`) is commented *"Shared by the Timeline and Projections charts"* but is only wired into `finplan-timeline.js`.
- **Aspect-ratio & narrow-screen issues:** Neither chart sets `maintainAspectRatio: false`, and the `flex gap-6` row never wraps below 860px.
- **Two subtle bugs:**
  1. Changing Macro's `#finplan-metric-select` mutates `appState.metricName` across the entire page (Timeline, Asset List, Visualizer), whereas Micro's dropdown is local-only.
  2. `rebuildMicroChart` omits Macro's `assetsOnly` filter, so expanding `Income`, `Expenses`, or `All` under `Net Worth` plots monthly flow rates as stacked balance-sheet bars.

---

## 2. The unified layout

### 2.1 View bar (top-left)

Primary view tabs plus a **More metrics ▾** dropdown for the full metric list (`MACRO_METRICS` + sub-metrics):

1. **Net Worth** (default): Stacked balance-sheet composition over time (`Real Estate` positive assets, `Capital`, `Retirement`, negative `Mortgage & Debt`) with a dark **Net Worth** line overlaid across the net sum.
2. **Where Spending Comes From** (Phase 2): Annual stacked funding sources (`Salary`, `Social Security`, `Pension`, `Bank & Cash`, `Brokerage & Bonds`, `401(k) & IRA`, `Roth IRA`) with **Total Spending + Taxes** overlaid as a line.
3. **Taxes**: Annual stacked household tax breakdown from `portfolio.monthlyPackages` (`Federal Income`, `FICA / Medicare`, `Capital Gains`, `NIIT`, `Property Tax`).
4. **More metrics ▾**: Keeps full access to every metric (`Net Worth Change`, `Growth`, `Cash Flow`, `Income`, `Net Income`, `Expense`, `Contribution`, `Credit`, `RMD`, etc.) without cluttering the default view.

### 2.2 `Today's $ | Nominal` toggle (top-right)

- Deflates every bar and line point by `portfolio.monthlyPriceIndex` (at the bucket's closing month for `MetricKind.LEVEL` stocks like Net Worth, or month-by-month before summing for `MetricKind.FLOW` flows) using the same `PriceIndex` as Timeline and Outcome.
- **Default:** `Today's $` (decision 1). When switched to `Nominal` on **Net Worth** (`All groups`), a dashed companion line shows `Today's $` so the inflation gap stays visible.

### 2.3 Inline drill-down bar (replaces Micro + Portfolio coupling)

- Under **Net Worth** and **More metrics**, a pill row sits directly above the canvas: **`All groups`** followed by each non-empty asset group applicable to the current metric (`Real Estate`, `Capital`, `Retirement`, plus `Income`/`Expenses` on flow metrics).
- Clicking any group pill drills directly into that group's **individual accounts** (`Retirement` → `401(k)`, `IRA`, `Roth IRA`) using the stable shades from `AssetGroupMeta`.
- Clicking **`All groups`** returns to the grouped overview.
- The `assetsOnly` filter (`InstrumentType.isAsset`) applies identically in grouped and drilled-down views whenever `Metric.VALUE` or `Metric.NET_WORTH_CHANGE` is selected — fixing the existing Micro flow-rate leak.
- Fullscreen (`⛶`) stays on the single chart slot and scales cleanly with `maintainAspectRatio: false`.

---

## 3. Interaction: hover tooltip & click-to-jump

- **Index-mode stacked tooltip:** `interaction: { mode: 'index', intersect: false }`. Shows:
  - Header: **Bucket label + User Age** (e.g., `2048 · Age 65`).
  - Body: every non-zero series in that bar, sorted largest absolute value first, formatted with `formatCurrency`.
  - Footer: bold **Net Total** (or **Total**), plus `In today's $` when viewing `Nominal` Net Worth.
- **Click to scrub the timeline cursor:** Clicking any bar resolves its bucket's `DateInt` and calls `store.setSelectedYearMonth(year, month)` — updating Timeline, Month & Year Details, Portfolio/Sankey, and Credit Memos in sync.
- **Local metric state:** Projections keeps its own view, metric, drill-down, and dollar-mode state rather than overwriting `appState.metricName` (decision 2).

---

## 4. Supporting data: KPI strip & inflection markers

### 4.1 Dynamic 4-tile KPI strip

Placed directly above the chart, updating live when the view, drill-down, or `Today's $ | Nominal` toggle changes:

| View | Tile 1 | Tile 2 | Tile 3 | Tile 4 |
|---|---|---|---|---|
| **Net Worth** (`All`) | **At Retirement** (balance + age) | **Peak Net Worth** (value + year/age) | **At End** (balance + finish age) | **Retirement Tax Mix** (`Taxable% · Deferred% · Roth%` of investable assets at retirement) |
| **Net Worth** (drilled) | **Starting** | **At Retirement** | **Peak** (year/age) | **At End** (or payoff year when mortgage/debt reaches `$0`) |
| **Where Spending Comes From** (Phase 2) | **Avg Retirement Outflow/yr** | **Guaranteed Income Share** (SS + Pension % of retirement outflow) | **First RMD Year** (amount + year) | **Coverage** (`100% funded` or first shortfall) |
| **Taxes** | **Lifetime Taxes** | **Peak Tax Year** (amount + year/age) | **Retirement Avg/yr** | **Effective Lifetime Rate** (`totalTaxes ÷ totalIncome`) |
| **Other metric** | **Lifetime Total** (flows) / **At Retirement** (levels) | **Peak** (year/age) | **Retirement Avg** | **At End** |

### 4.2 Inflection-point markers

Non-overlapping milestone ticks on the x-axis (merging labels that share a bucket, and vertically staggering adjacent labels in `dateMarkerPlugin`):

- **Retire** (retirement life event, if inside horizon)
- **Medicare 65** (only when the plan holds a `healthInsurance` asset ending before plan end)
- **SS** (earliest `retirementIncome` asset start date if after plan start)
- **RMDs** (RMD start age 73, only when the plan holds a tax-deferred IRA or 401(k) and reaches RMD age after plan start)
- **Runs Out** (first exhaustion month from `detectIssues(portfolio)`, if any)
- **`▼` Cursor** (active selected date, always drawn last)

---

## 5. "Where Spending Comes From" (Phase 2 data contract)

Built directly from the existing headless ledger reader `moneyFlows` (`js/money-flows.js`) aggregated in a single pass per bucket:

- **Stacked bars (annual funding sources for `FlowKind.SPENT` + `FlowKind.TAX`):** Salary & Self-Employment, Social Security, Pension, Bank & Cash Draws, Brokerage & Bond Draws, 401(k) & IRA Draws, Roth IRA Draws.
- **Overlay line:** Total annual `Spending + Taxes`. When a plan runs out, the gap between the funding bars and the obligation line visually reveals the unpaid shortfall.
- **Agreement invariant:** Every year's funding bar sum equals `Month & Year Details`'s `Expenses + Taxes` minus any unpaid shortfall.

---

## 6. Presentation surfaces

- `js/projections-view.js`: Pure headless builders for buckets, datasets, KPIs, milestone markers, and Chart.js config (zero DOM or Chart.js runtime dependency).
- `js/charting.js`: Stagger overlapping marker labels in `dateMarkerPlugin` and keep existing exports intact.
- `index.html`: Replace the Macro/Micro side-by-side slots in `#sec-projections` with the unified full-width card (view tabs, metric dropdown, `Today's $ | Nominal` toggle, KPI strip, drill-down pills, single canvas, fullscreen button, AI Summary button).
- `js/finplan-app.js`: Replace `macroChart`/`microChart` with one `projectionChart`, wire local controls, click-to-jump cursor, and fullscreen toggle.
- `help.html` & `rules.html`: Update Projections documentation in the same PR.

---

## 7. Traps to watch

1. **Zero-size canvas / fixed aspect ratio:** Set `maintainAspectRatio: false` inside `.finplan-chart-canvas-wrap` and verify fullscreen entry/exit.
2. **Flow instruments leaking into Net Worth:** Keep `InstrumentType.isAsset` filtering active in both `All groups` and drilled-down modes for `Metric.VALUE` and `Metric.NET_WORTH_CHANGE`.
3. **Bucket alignment & zero dropped months:** Partition months `[0..N-1]` contiguously using `MonthsSpan` (including any leading partial year/quarter when `offsetMonths > 0`), so flow sums equal full-plan totals and the final bucket reaches `lastDateInt`.
4. **Overlapping milestone labels:** Merge labels on the same bucket and stagger nearby labels vertically so text never collides.
5. **Ledger performance on Phase 2:** Compute annual funding sources in one pass over `portfolio` events and memoize per run.

---

## 8. Tests (`tests/projections-view.mjs`)

- `All groups` Net Worth excludes flow instruments, plots mortgages/debt below `$0`, and its Net Worth overlay line equals `sum(bars)` at every bucket and matches `planOutcome.end` / `planOutcome.endReal` at the final bucket.
- Drilled-down view shows only that group's accounts and still excludes flow instruments on `Metric.VALUE` / `Metric.NET_WORTH_CHANGE`.
- `Today's $` deflates balances and flows accurately using `monthlyPriceIndex`; `Nominal` Net Worth carries the dashed `Today's $` companion line.
- `Taxes` sums `monthlyPackages` accurately across buckets (reconciling lifetime taxes with `portfolio.total.totalTaxes()`) and omits all-zero tax layers.
- `Retirement Tax Mix` sums to 100% across Taxable, Tax-Deferred, and Tax-Free investable assets (excluding Real Estate and Mortgage).
- Bucket-index-to-`DateInt` mapping covers every month cleanly and round-trips across monthly, quarterly, semi-annual, and annual `MonthsSpan` horizons.
- Milestone markers appear only when applicable and merge cleanly when sharing a bucket.

---

## 9. Decisions

1. **Default dollar mode (`Today's $` vs `Nominal`).** **Decided (John, 2026-11-22):** `Today's $` by default; `Nominal` adds the dashed `Today's $` companion line on Net Worth.
2. **Decouple Projections' metric selector from the global page metric.** **Decided (John, 2026-11-22):** Yes — Projections controls stay local and do not mutate Timeline, Asset List, or Visualizer.
3. **Portfolio accordion link.** **Decided (John, 2026-11-22):** Fully local drill-down pills inside Projections (no coupling to `#sec-portfolio`'s `expandedGroups`).
4. **Rollout.** **Decided (John, 2026-11-22):** Two PRs — Phase 1 (unified full-width drill-down chart, `Today's $ | Nominal`, KPI strip, stacked index tooltip, Net Worth overlay, inflection markers, click-to-jump, `assetsOnly` fix, Help/Rules) and Phase 2 (single-pass ledger aggregator + *Where Spending Comes From* tab).
