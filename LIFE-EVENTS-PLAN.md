# Life Events & Timeline — Feature Plan

## Overview

This document captures the complete design and architecture plan for adding **life events** and a **timeline-driven UI** to Charting Finance. It was developed through a brainstorming session and should serve as the authoritative reference for implementation.

The core idea: a user's financial life has **phases** (accumulation, homeownership, retirement, downsizing) separated by **life events** (decisions that rewire how money flows). The timeline replaces the portfolio ledger as the primary navigation element, and selecting a phase filters the entire app — asset panel, projection tabs, and chart scope.

---

## Design Principles

1. **Strategic first, tactical second.** The timeline communicates the big picture; individual asset cards are the weeds.
2. **Graphics communicate 10x over text.** A horizontal timeline with colored event dots conveys the mission better than stat boxes.
3. **Assets span events.** A 401K is the same 401K before and after retirement — the event changes its behavior (accumulating → distributing), not its identity. This preserves metric continuity (TWRR, CAGR) and avoids duplicate entities.
4. **Events are opt-in.** The default timeline is just Accumulate + Retire. Users add Buy Home / Sell Home only if relevant.
5. **Start and Finish are immutable anchors**, derived from global settings (current age, finish age). Events are user-managed decisions that sit between the anchors.

---

## Architecture

### Pattern: Mirrors Instrument

The implementation follows the exact same pattern as `js/instruments/instrument.js`:

| Instrument Pattern | Life Event Equivalent |
|---|---|
| `Instrument` (frozen enum) | `LifeEvent` (frozen enum) |
| `InstrumentMeta` (Map) | `LifeEventMeta` (Map) |
| `InstrumentType` (Set-based classifiers) | `LifeEventType` (Set-based classifiers) |
| `ModelAsset` (instance class) | `ModelLifeEvent` (instance class) |

### Life Event Types (v1)

- **ACCUMULATE** — Initial financial strategy. Always the first event. Cannot be deleted.
- **BUY_HOME** — Creates real estate + mortgage assets, adjusts fund transfers.
- **SELL_HOME** — Closes real estate + mortgage, allocates proceeds.
- **RETIRE** — Closes working income, creates retirement income (Social Security), flips tax-deferred accounts to distribution mode.

### ModelLifeEvent Shape

```js
{
  type: 'retire',                    // LifeEvent enum value
  displayName: 'Retire',             // User-facing label
  triggerAge: 62,                    // Fires when user reaches this age
  closes: ['Salary'],                // Asset displayNames to close
  creates: [{                        // Asset JSON templates to instantiate
    instrument: 'retirementIncome',
    displayName: 'Social Security',
    startCurrency: { amount: 2800 },
    annualReturnRate: { rate: 0.02 },
  }],
  transferOverrides: {               // Complete replacement fund transfer arrays
    '401K': [{ toDisplayName: 'Cash', frequency: 'monthly', monthlyMoveValue: 100, closeMoveValue: 0 }],
  },
  globalOverrides: {},               // Future: inflation assumptions, etc.
}
```

Key design decision: `transferOverrides` is a **full replacement** of an asset's fund transfer array, not a diff/patch. When someone retires, the entire flow of money changes — a full replacement is more honest and easier to reason about.

### Chronometer Integration

Life events are checked at the **first tick of each month** in the chronometer while loop, **before** `applyMonth`. This is a two-line insertion:

```js
if (currentDateInt.day === 1) {
    portfolio.applyLifeEvents(currentDateInt);
}
```

The `apply()` method on ModelLifeEvent executes four steps in order:
1. Close named assets (uses existing `portfolio.closeAsset()`)
2. Create new assets from JSON templates (uses existing `ModelAsset.fromJSON()`)
3. Overwrite fund transfers on surviving assets
4. Re-sort the portfolio

No changes needed to simulation engines (payroll, expense, tax) — they pick up mutations naturally on the next month tick.

### Portfolio Integration

- `Portfolio.lifeEvents` — array of ModelLifeEvent, sorted by triggerAge
- `Portfolio.applyLifeEvents(currentDateInt)` — iterates events, calls `event.apply()` when trigger matches
- Life event `applied` flags are reset in `initializeChron()` for re-simulation

### Serialization

Life events serialize alongside model assets in localStorage:
- Key: `lifeEvents_{storyArc}_{scenario}`
- Each scenario can have its own timeline
- `toJSON()` / `fromJSON()` roundtrip on ModelLifeEvent

---

## UI Design — Concept A: Timeline Crown

The selected layout (from three options evaluated) places the timeline as a **full-width hero element** at the top, replacing the portfolio ledger's three stat boxes.

### Timeline Component (`<timeline-ledger>`)

Replaces `<portfolio-ledger>` in `index.html`.

**Structure:**
- **Header row**: "Your financial story" title + metric select dropdown + "+" add event button
- **Timeline bar**: Immutable S (Start) anchor → event dots → immutable F (Finish) anchor
- **Labels row**: Event names and ages below each dot
- **Phase bar**: Colored pill with phase name, age span, and inline ledger stats (Open, Close, CAGR)

**Interactions:**
- Click a dot → `phase-select` event fires, entire app responds
- Click the phase pill → `event-edit` event fires, opens rewiring popup
- Click "+" → `event-add` event fires, opens creation flow
- Change metric select → `ledger-metric1-change` for backward compat

### Contextual Projection Tabs

Each event type declares a `projectionTabs` array. When a phase is selected, the projection tab bar morphs:

| Phase | Tabs |
|---|---|
| Accumulate | Value, Monte Carlo, Contributions, Spreadsheet |
| Buy Home (Homeowner) | Value, Amortization, Equity Buildup, Spreadsheet |
| Retire | Value, Guardrails, Monte Carlo, Spreadsheet |
| Sell Home (Downsized) | Value, Cap Gains Impact, Proceeds Allocation, Spreadsheet |

**Value** and **Spreadsheet** are universal — present for every phase. Everything else is contextual.

### Asset Panel Enhancements

When a phase is selected, the right-side asset panel shows:

1. **Event summary box** — what mutations this event applied (e.g., "Close salary, start SS, flip 401K to distributions")
2. **Grouped assets** — accordion-style groups: Distributions, Capital, Outflows (labels vary by phase type via `assetGroupLabels` in meta)
3. **Mutation badges** on individual assets: "new", "now distributing", "closed" (struck through, ghosted), "transfers adjusted"
4. **Closed assets** remain visible but ghosted with strikethrough — the asset spans events, the event changed its state

### Rewiring Popup

When a user adds or edits an event, a modal opens with:

1. **Event type chips** — select from Accumulate, Buy Home, Sell Home, Retire
2. **Name and trigger age** fields
3. **Asset mutations section** — what gets closed, created, modified (pre-populated from `LifeEventMeta.defaultMutations`)
4. **Fund transfer rewiring** — per-asset transfer configuration with:
   - "Before → After" strips showing what changed
   - Slider controls for transfer percentages
   - Ability to add/remove transfers
5. **Delete event** button (except for Accumulate which can't be deleted)

### Chart Integration

- Event markers appear as **vertical dashed lines** on the Value chart
- Selected phase has a **shaded region** highlighting its time span
- Chart can be scoped to show only the selected phase's date range

---

## File Inventory

### New Files (already created)
- `js/life-event.js` — Core data model (LifeEvent enum, LifeEventMeta, LifeEventType, ModelLifeEvent)
- `js/components/timeline-ledger.js` — Lit component for the timeline UI

### New Files (to be created)
- `js/components/event-form-modal.js` — Rewiring popup modal (Lit component)
- Contextual projection views: amortization chart, equity buildup chart, cap gains impact, proceeds allocation (future)

### Existing Files to Modify
- `js/portfolio.js` — Add `lifeEvents[]`, `applyLifeEvents()`, reset in `initializeChron()`
- `js/chronometer.js` — Two-line insertion in both `chronometer_run` and `chronometer_run_animated`
- `js/app.js` — Import timeline-ledger, wire up events, manage activeLifeEvents state, feed to portfolio
- `index.html` — Replace `<portfolio-ledger>` with `<timeline-ledger>`
- `js/utils/util.js` — Add `util_saveLocalLifeEvents` / `util_loadLocalLifeEvents`
- `js/quick-start.js` — Add `quickStartLifeEvents()` exporting default Accumulate + Retire timeline

### Files That DON'T Need Changes
- `js/instruments/instrument.js` — Untouched
- `js/instruments/instrument-behavior.js` — Untouched
- `js/model-asset.js` — Untouched (assets span events, events mutate them)
- `js/fund-transfer.js` — Untouched (events use existing FundTransfer.fromJSON)
- `js/engines/*` — Untouched (payroll, expense, tax engines pick up mutations naturally)
- `js/charting.js` — Minor future enhancement (event marker lines) but not blocking

---

## Implementation Order

### Phase 1: Core Model + Timeline Rendering
1. Add `js/life-event.js` to the project
2. Add `js/components/timeline-ledger.js` to the project
3. Modify `index.html` — swap `<portfolio-ledger>` for `<timeline-ledger>`
4. Modify `js/app.js` — import, create default timeline, feed to component
5. Verify: timeline renders with two dots, phase bar shows, metric select works

### Phase 2: Chronometer Integration
1. Modify `js/portfolio.js` — add `lifeEvents`, `applyLifeEvents()`, reset in `initializeChron`
2. Modify `js/chronometer.js` — add the two-line event check
3. Modify `js/app.js` — attach `activeLifeEvents` to portfolio before simulation
4. Verify: events fire at correct months, assets close/create as expected

### Phase 3: Persistence + Scenarios
1. Modify `js/utils/util.js` — add localStorage helpers
2. Modify `js/app.js` — save/load life events alongside assets
3. Update scenario switching to include life events per scenario
4. Update `js/quick-start.js` — export default timeline
5. Verify: events persist across page reloads, scenarios have independent timelines

### Phase 4: Rewiring Popup
1. Create `js/components/event-form-modal.js` — the full rewiring UI
2. Wire up `event-edit` and `event-add` handlers in `js/app.js`
3. Implement event type selection, mutation editing, transfer rewiring
4. Implement delete event with phase merging
5. Verify: full CRUD lifecycle for events on the timeline

### Phase 5: Contextual Projections
1. Update tab rendering in `js/app.js` to respond to `phase-select` events
2. Show/hide tabs based on `event.projectionTabs`
3. Add event marker vertical lines to existing Chart.js chart
4. Build phase-specific projection views (amortization, equity buildup, etc.)
5. Asset panel grouping + mutation badges

### Phase 6: Polish
1. Chart shading for selected phase time range
2. "Before → After" strips in rewiring popup
3. Asset panel group totals
4. Smooth transitions between phase selections
5. Mobile responsiveness for timeline

---

## Key Code Patterns to Follow

- **Frozen enums**: `Object.freeze({...})` for all type constants
- **Set-based classifiers**: `new Set([...])` with `has()` checks, exposed via frozen API object
- **Lit components**: `createRenderRoot() { return this; }` (no shadow DOM), `html` tagged templates, custom events with `bubbles: true, composed: true`
- **ES modules**: All imports explicit, no globals except via `globals.js` exports
- **Serialization**: `toJSON()` / `static fromJSON()` pair on every model class
- **Currency/DateInt**: Always use the existing utility classes, never raw numbers for money or dates
- **Fund transfers**: `FundTransfer.fromJSON()` for deserialization, `bind()` at runtime for name resolution
- **Logging**: Use `logger.log(LogCategory.GENERAL, ...)` for significant operations

---

## Open Questions for Future Iterations

- Should events support **conditional triggers** (e.g., "retire when 401K reaches $1M")?
- How should the **genetic algorithm optimizer** interact with life events? Evolve transfer percentages within each phase?
- Should **Monte Carlo** run per-phase or across the full timeline?
- Event **templates / presets** — "early retirement at 55" vs "traditional at 67"?
- **Undo/redo** for event mutations during rewiring?
