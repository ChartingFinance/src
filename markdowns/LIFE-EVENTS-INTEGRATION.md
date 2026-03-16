# Life Events — Integration Guide

## New files to add
- `js/life-event.js` — Core data model
- `js/components/timeline-ledger.js` — Timeline UI component

## Existing files to modify

---

### 1. `js/portfolio.js`

#### Add import at top:
```js
import { ModelLifeEvent } from './life-event.js';
```

#### Add `lifeEvents` to constructor (after `this.yearlySnapshots = []`):
```js
// Life events timeline
this.lifeEvents = [];
```

#### Add `applyLifeEvents` method (after `initializeChron`):
```js
/**
 * Check and apply any life events whose triggerDateInt matches
 * the current simulation month. Called at day=1 of each month
 * by the chronometer, BEFORE applyMonth.
 */
applyLifeEvents(currentDateInt) {
    for (const event of this.lifeEvents) {
        if (event.applied) continue;
        const trigger = event.triggerDateInt;
        if (trigger.year === currentDateInt.year && trigger.month === currentDateInt.month) {
            event.apply(this, currentDateInt);
        }
    }
}
```

#### Add `resetLifeEvents` call inside `initializeChron` (after the modelAsset loop):
```js
// Reset life event applied flags for re-simulation
for (const event of this.lifeEvents) {
    event.applied = false;
}
```

---

### 2. `js/chronometer.js`

#### In `chronometer_run` — add life event check at the TOP of the while loop:

**Before:**
```js
while (currentDateInt.toInt() <= lastDateInt.toInt()) {
    totalMonths += portfolio.applyMonth(currentDateInt);
```

**After:**
```js
while (currentDateInt.toInt() <= lastDateInt.toInt()) {

    // Life events fire at the first tick of their trigger month,
    // before any financial calculations for that month.
    if (currentDateInt.day === 1) {
        portfolio.applyLifeEvents(currentDateInt);
    }

    totalMonths += portfolio.applyMonth(currentDateInt);
```

#### Same change in `chronometer_run_animated`:

**Before:**
```js
while (currentDateInt.toInt() <= lastDateInt.toInt()) {
    // Break out of the loop if the popup was closed
```

**After:**
```js
while (currentDateInt.toInt() <= lastDateInt.toInt()) {

    if (currentDateInt.day === 1) {
        portfolio.applyLifeEvents(currentDateInt);
    }

    // Break out of the loop if the popup was closed
```

---

### 3. `js/app.js`

#### Add imports:
```js
import { ModelLifeEvent, LifeEvent } from './life-event.js';
import './components/timeline-ledger.js';
```

#### Add DOM reference (near existing element refs):
```js
const timelineLedger = document.getElementById('timelineLedger');
```

#### Add app state for life events (near `let activePortfolio`):
```js
let activeLifeEvents = [];
```

#### In `initiateActiveData` or `loadLocalData` — load life events:
```js
// Load life events (or create defaults)
const savedEvents = util_loadLocalLifeEvents(activeStoryArc, activeScenario);
if (savedEvents) {
    activeLifeEvents = savedEvents.map(ModelLifeEvent.fromJSON);
} else {
    activeLifeEvents = ModelLifeEvent.defaultTimeline(
        global_user_startAge, global_user_retirementAge
    );
}
timelineLedger.lifeEvents = activeLifeEvents;
timelineLedger.startAge   = global_user_startAge;
timelineLedger.finishAge  = global_user_finishAge;
```

#### In the `calculate` function — attach life events to portfolio before chronometer_run:
```js
// After creating the portfolio, before chronometer_run:
portfolio.lifeEvents = activeLifeEvents.map(e => e.copy());
```

#### After chronometer_run — feed results back to timeline:
```js
timelineLedger.portfolio = activePortfolio;
```

#### Wire up timeline events:
```js
timelineLedger.addEventListener('phase-select', (e) => {
    const { event, index } = e.detail;
    // Update chart tabs based on event.projectionTabs
    // Filter asset list to show phase-relevant assets
    // Update chart with phase time range
});

timelineLedger.addEventListener('event-edit', (e) => {
    const { event, index } = e.detail;
    // Open the rewiring modal (future component)
});

timelineLedger.addEventListener('event-add', () => {
    // Open event creation flow (future component)
});
```

---

### 4. `index.html`

#### Replace the `<portfolio-ledger>` element:

**Before:**
```html
<portfolio-ledger id="portfolioLedger"></portfolio-ledger>
```

**After:**
```html
<timeline-ledger id="timelineLedger"></timeline-ledger>
```

Note: The `ledger-metric1-change` event is still dispatched by
timeline-ledger for backward compatibility with the metric select
sync in app.js.

---

### 5. `js/utils/util.js`

#### Add save/load helpers for life events (alongside existing asset save/load):

```js
export function util_saveLocalLifeEvents(storyArc, scenario, events) {
    const key = `lifeEvents_${storyArc}_${scenario}`;
    localStorage.setItem(key, JSON.stringify(events));
}

export function util_loadLocalLifeEvents(storyArc, scenario) {
    const key = `lifeEvents_${storyArc}_${scenario}`;
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
}
```

---

## Quick start integration

Update `js/quick-start.js` to export a default timeline alongside assets:

```js
import { ModelLifeEvent, LifeEvent } from './life-event.js';

export function quickStartLifeEvents() {
    return [
        ModelLifeEvent.createDefault(LifeEvent.ACCUMULATE, 35),
        ModelLifeEvent.createDefault(LifeEvent.RETIRE, 62),
    ];
}
```

---

## Testing checklist

1. **Basic timeline renders** — Two dots (Accumulate + Retire) between S and F anchors
2. **Phase select works** — Click dots, phase bar updates with correct label/age range
3. **Ledger stats compute** — Opening, closing, CAGR show real values after simulation
4. **Metric select syncs** — Changing metric in timeline updates chart (backward compat)
5. **Chronometer integration** — Life events fire at correct months during simulation
6. **Serialization roundtrip** — Save to localStorage, reload, events persist
7. **Multiple scenarios** — Each scenario can have its own life events
