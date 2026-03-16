# Asset Groupings & Panel-Driven Chart — Feature Plan

## Overview

This document captures the design for **grouped portfolio assets** and the **panel-drives-chart** interaction model. It builds on the Life Events & Timeline plan and should be read alongside `LIFE-EVENTS-PLAN.md`.

The core idea: the portfolio asset panel groups assets by financial category with collapsible headers and rolled-up totals. The chart reflects the panel state exactly — collapsed groups render as filled areas, expanded groups render as individual lines. The panel is the single control surface for chart granularity.

---

## Layout

**Chart stays left (8 cols), portfolio stays right (4 cols).** The chart is the first thing a user sees and conveys "right track vs wrong track" at a glance. The portfolio panel to the right is where users configure — the response relationship (panel drives chart) flows right-to-left, which is fine because the chart is the dominant visual output and earns the larger footprint. This matches financial tool conventions (Bloomberg, Google Finance, trading platforms).

```
┌─────────────────────────────────────────────────────┐
│  Timeline Ledger (full width hero)                   │
├──────────────────────────┬──────────────────────────┤
│  Chart (lg:col-span-8)   │  Portfolio (lg:col-span-4)│
│  Responds to panel state │  Drives chart granularity │
│                          │  Grouped + collapsible    │
└──────────────────────────┴──────────────────────────┘
```

---

## Asset Grouping

### Groups and stable colors

Every asset belongs to exactly one group. Groups have **stable colors** that never change across timeline phases — Capital is always purple, Real Estate is always blue, etc. When a group appears or disappears due to life events, the remaining groups keep their colors and relative positions.

| Group | Header bg | Header text | Area fill | Line color | Contains |
|---|---|---|---|---|---|
| Income / Distributions | `#E1F5EE` | `#085041` | `#1D9E75` | teal family | Working income, retirement income, Social Security |
| Real estate | `#E6F1FB` | `#0C447C` | `#378ADD` | blue family | Real estate, mortgage |
| Capital | `#EEEDFE` | `#3C3489` | `#7F77DD` | purple family | 401K, IRA, Roth IRA, taxable equity, savings, bonds |
| Outflows | `#FCEBEB` | `#791F1F` | `#E24B4A` | red family | Monthly expenses, debt |
| Closed | `#F1EFE8` | `#5F5E5A` | — | — | Assets closed by life events (ghosted) |

The group label shifts contextually per phase — "Income" during accumulation becomes "Distributions" during retirement — but the color stays the same teal-green because the *category* is the same (money coming in).

### Asset-level colors

Individual assets within a group use **shades from their group's color family**:

| Group | Asset | Line color |
|---|---|---|
| Capital | 401K | `#7F77DD` (purple 400) |
| Capital | Roth IRA | `#9B8FE8` (purple 300) |
| Capital | Brokerage | `#AFA9EC` (purple 200) |
| Real estate | Home | `#378ADD` (blue 400) |
| Real estate | Mortgage | `#85B7EB` (blue 200) |
| Income | Salary | `#1D9E75` (teal 400) |
| Income | Social Security | `#5DCAA5` (teal 200) |
| Outflows | Living expenses | `#E24B4A` (red 400) |
| Outflows | Rental | `#F09595` (red 200) |

This means even when individual lines are visible, users can visually cluster them by color warmth and mentally reconstruct the groups.

### Group membership mapping

Groups are derived from the existing `InstrumentType` classification sets:

```js
const ASSET_GROUPS = {
  income: (inst) => InstrumentType.isMonthlyIncome(inst)
                 || InstrumentType.isRetirementIncome(inst),
  realestate: (inst) => InstrumentType.isRealEstate(inst)
                     || InstrumentType.isMortgage(inst),
  capital: (inst) => InstrumentType.isTaxableAccount(inst)
                  || InstrumentType.isTaxDeferred(inst)
                  || InstrumentType.isTaxFree(inst)
                  || InstrumentType.isSavingsAccount(inst)
                  || InstrumentType.isIncomeAccount(inst),
  outflows: (inst) => InstrumentType.isMonthlyExpense(inst)
                   || InstrumentType.isDebt(inst),
};
```

---

## Asset States (visual treatment)

Three visual states for assets in the panel, tied to their relationship to the selected timeline phase:

### Active
- Full opacity
- Solid border, left color bar
- Shows current value
- Clickable (edit, transfers, select for chart highlight)

### Ghosted (closed by a life event)
- 30% opacity
- Strikethrough name
- Red "closed" or "sold" badge
- Non-interactive (pointer-events: none)
- Collected in a "Closed" group at bottom of panel

### Future (Social Security only)
- 50% opacity, dashed border
- "SS" icon with "age 62" pill badge
- Appears as standalone row below the last group (not inside a group)
- Only Social Security gets this treatment — it's a universal milestone
- Other future assets from opt-in events (Home, Mortgage) are NOT previewed

### Mutation badges

Badges appear on assets when a life event changes their state. Same badge vocabulary across all phases:

| Badge | Background | Color | Meaning |
|---|---|---|---|
| `new` | `#E1F5EE` | `#085041` | Created by this event |
| `changed` | `#FAEEDA` | `#633806` | Transfers were rewired |
| `distributing` | `#FAEEDA` | `#633806` | Switched from accumulation to distribution |
| `+$NNK` | `#FAEEDA` | `#633806` | Received proceeds from an asset sale |
| `reduced` | `#FAEEDA` | `#633806` | Value/rate was decreased |
| `closed` | `#FCEBEB` | `#791F1F` | Terminated by this event |
| `sold` | `#FCEBEB` | `#791F1F` | Sold (with capital gains implications) |

---

## Panel-Drives-Chart Interaction

### Core principle

**The panel is the single control surface for chart granularity.** There is no separate "grouped vs individual" toggle on the chart. What you see in the panel is what you see in the chart.

### Behavior

| Panel state | Chart rendering | Legend |
|---|---|---|
| Group collapsed (header only) | Single filled area for group, aggregated values | Shows group name + group color |
| Group expanded (assets visible) | Individual lines per asset, no fill | Shows each asset name + asset color |
| Mixed (some collapsed, some expanded) | Mix of filled areas and individual lines | Shows mix of group and asset names |

### Interaction flow

1. User clicks a group header chevron in the portfolio panel
2. Group expands to show individual assets (or collapses back to header)
3. Chart immediately re-renders:
   - Collapsed → one filled area dataset (element-wise sum of member assets)
   - Expanded → N line datasets (one per member asset)
4. Chart legend updates to reflect exactly what the panel shows
5. Event marker vertical lines remain visible in both modes

### Chart rendering details

**Collapsed group (aggregated):**
```js
{
  label: 'Capital',
  data: sumOfMemberDisplayHistories,
  borderColor: '#7F77DD',       // group color
  backgroundColor: '#7F77DD18', // group color at 10% opacity
  fill: true,                   // filled area
  borderWidth: 2,
  pointRadius: 0,
  tension: 0.3,
}
```

**Expanded group (individual assets):**
```js
{
  label: '401K',
  data: assetDisplayHistory,
  borderColor: '#7F77DD',       // asset-specific shade
  fill: false,                  // line only, no fill
  borderWidth: 1.5,
  pointRadius: 0,
  tension: 0.3,
}
```

**Negative values** (outflows, mortgage): use `borderDash: [4, 3]` for dashed lines in both modes.

### Event marker lines

Vertical dashed lines on the chart at each life event's trigger date. Always visible regardless of panel state. Each line uses the event's color from `LifeEventMeta`:

```js
const eventPlugin = {
  id: 'eventLines',
  afterDraw(chart) {
    for (const event of portfolio.lifeEvents) {
      // Draw dashed vertical at event.triggerDateInt
      // Label with event.displayName in event color
    }
  }
};
```

---

## Roll-up Totals

Each group header shows a rolled-up total of its active (non-ghosted, non-future) members:

- **Capital / Real estate**: Total balance (sum of finishCurrency values)
- **Income / Distributions**: Monthly rate (sum of monthly income amounts)
- **Outflows**: Monthly rate (sum of monthly expense amounts)
- **Closed**: No total shown (empty string)

Totals update when the simulation runs. Format: compact currency (`$105K`, `$1.2M`, `-$3K/mo`).

---

## Implementation

### New: Asset group utility

Create `js/asset-groups.js`:

```js
import { InstrumentType } from './instruments/instrument.js';

export const AssetGroup = Object.freeze({
  INCOME:      'income',
  REAL_ESTATE: 'realestate',
  CAPITAL:     'capital',
  OUTFLOWS:    'outflows',
  CLOSED:      'closed',
});

export const AssetGroupMeta = new Map([
  [AssetGroup.INCOME,      { label: 'Income',      altLabel: 'Distributions', bg: '#E1F5EE', fg: '#085041', chartColor: '#1D9E75' }],
  [AssetGroup.REAL_ESTATE, { label: 'Real estate',  bg: '#E6F1FB', fg: '#0C447C', chartColor: '#378ADD' }],
  [AssetGroup.CAPITAL,     { label: 'Capital',      bg: '#EEEDFE', fg: '#3C3489', chartColor: '#7F77DD' }],
  [AssetGroup.OUTFLOWS,    { label: 'Outflows',     bg: '#FCEBEB', fg: '#791F1F', chartColor: '#E24B4A' }],
  [AssetGroup.CLOSED,      { label: 'Closed',       bg: '#F1EFE8', fg: '#5F5E5A', chartColor: '#888780' }],
]);

// Asset-level chart colors (shades within group family)
export const AssetChartColors = {
  '401K':              '#7F77DD',
  'Roth IRA':          '#9B8FE8',
  'Brokerage':         '#AFA9EC',
  'Home':              '#378ADD',
  'Mortgage':          '#85B7EB',
  'Salary':            '#1D9E75',
  'Social Security':   '#5DCAA5',
  'Living expenses':   '#E24B4A',
  'Rental':            '#F09595',
};

export function classifyAssetGroup(instrument, isClosed) {
  if (isClosed) return AssetGroup.CLOSED;
  if (InstrumentType.isMonthlyIncome(instrument))  return AssetGroup.INCOME;
  if (InstrumentType.isRealEstate(instrument))      return AssetGroup.REAL_ESTATE;
  if (InstrumentType.isMortgage(instrument))        return AssetGroup.REAL_ESTATE;
  if (InstrumentType.isMonthlyExpense(instrument))  return AssetGroup.OUTFLOWS;
  if (InstrumentType.isDebt(instrument))            return AssetGroup.OUTFLOWS;
  return AssetGroup.CAPITAL;  // everything else: equity, bonds, savings, tax-advantaged
}

export function groupAssets(modelAssets) {
  const groups = new Map();
  for (const [key] of AssetGroupMeta) {
    groups.set(key, { ...AssetGroupMeta.get(key), assets: [] });
  }
  for (const asset of modelAssets) {
    const groupKey = classifyAssetGroup(asset.instrument, asset.isClosed);
    groups.get(groupKey).assets.push(asset);
  }
  // Remove empty groups (except CLOSED which may be empty)
  for (const [key, group] of groups) {
    if (key !== AssetGroup.CLOSED && group.assets.length === 0) {
      groups.delete(key);
    }
  }
  // Remove CLOSED if empty
  if (groups.get(AssetGroup.CLOSED)?.assets.length === 0) {
    groups.delete(AssetGroup.CLOSED);
  }
  return groups;
}
```

### Modify: `js/components/asset-list.js`

Replace flat `repeat()` rendering with grouped rendering:

- Import `groupAssets`, `AssetGroupMeta`, `AssetChartColors`
- Maintain `expandedGroups` state (Set of group keys that are expanded)
- Render group headers with chevron, label, roll-up total
- Click header → toggle group in `expandedGroups` → dispatch `group-toggle` event
- Render child `asset-card` components only for expanded groups
- Ghosted assets render with `ghost` CSS class
- Social Security future preview renders after the last group when pre-retirement

### Modify: `js/charting.js`

Update `charting_buildPortfolioMetric` (or create new `charting_buildGroupedMetric`):

- Accept `expandedGroups` Set parameter
- For each group:
  - If group is in `expandedGroups`: build one dataset per member asset (line, no fill)
  - If group is NOT in `expandedGroups`: sum member display histories, build one dataset (filled area)
- Use `AssetGroupMeta.chartColor` for collapsed groups
- Use `AssetChartColors[displayName]` for individual assets (with fallback to group color)
- Add the `eventLines` Chart.js plugin for life event markers

### Modify: `js/app.js`

Wire up the group-toggle event:

```js
let expandedGroups = new Set();

assetsContainerElement.addEventListener('group-toggle', (e) => {
    const { groupKey, expanded } = e.detail;
    if (expanded) expandedGroups.add(groupKey);
    else expandedGroups.delete(groupKey);
    updateCharts();  // rebuild chart with new expandedGroups state
});
```

Pass `expandedGroups` to the chart builder:

```js
function updateCharts() {
    if (!activePortfolio) return;
    const chartData = charting_buildGroupedMetric(
        activePortfolio, activeMetric1Name, expandedGroups, true
    );
    if (activeMetric1Canvas) activeMetric1Canvas.destroy();
    activeMetric1Canvas = new Chart(chartMetric1Canvas, chartData);
}
```

### Modify: `js/components/asset-card.js`

Add ghost/future visual states:

- Accept `ghost` boolean property — renders at 30% opacity with strikethrough
- Accept `future` boolean property — renders at 50% opacity with dashed border
- Replace the left border color strip with a thin 3px color bar element
- Use `AssetChartColors[displayName]` for the color bar (stable per-asset color)

---

## Design principles (recap)

1. **Color = meaning, not position.** Group colors are fixed. Asset colors are fixed shades within their group family. Nothing changes color when you switch phases.
2. **One control surface.** The panel drives the chart. No separate chart toggles.
3. **Three states.** Active, ghosted, future. Visually distinct. No ambiguity.
4. **Pieces, not prose.** Badges, color bars, and spatial grouping do the communication. No text summaries or event description boxes.
5. **Strategic first.** Collapsed groups with roll-up totals are the default view. Individual assets are the drill-down.
6. **Social Security is special.** The only future asset that gets previewed, because it's a universal retirement milestone, not an opt-in decision.

---

## Testing checklist

1. **Group rendering** — Assets correctly classified into groups based on instrument type
2. **Stable colors** — Capital is purple in every phase, Real Estate is blue, etc.
3. **Collapse/expand** — Click group header, assets show/hide, chevron rotates
4. **Chart sync** — Collapsed group shows as filled area, expanded shows individual lines
5. **Legend sync** — Legend labels match exactly what the panel shows
6. **Roll-up totals** — Group header totals sum active members correctly
7. **Ghosting** — Closed assets show at 30% opacity with strikethrough in Closed group
8. **Social Security preview** — Dashed row appears pre-retirement, disappears once active
9. **Mutation badges** — Correct badges appear when switching timeline phases
10. **Mixed granularity** — Can expand Capital while Income stays collapsed, chart renders both correctly
11. **Event markers** — Vertical dashed lines on chart at each life event trigger date
12. **Phase switching** — Changing timeline phase re-groups assets correctly, ghosted assets move to Closed group
