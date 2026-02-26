# Model Layer Refactor — Migration Guide

## File Map

| Old File(s)          | New File(s)                  | What Changed                                           |
|----------------------|------------------------------|--------------------------------------------------------|
| `util.js` (1-250)   | `currency.js`, `date-int.js`, `arr.js` | Value types extracted into standalone ES modules       |
| `util.js` (252-430) | `asset-queries.js`, `months-span.js` | Collection queries & chart bucketing separated         |
| `util.js` (365-515) | `instrument.js`              | 30+ `isXxx()` functions → Set-based `InstrumentType`   |
| `model.js` (1-155)  | `results.js`                 | Result data classes, modernised constructors            |
| `model.js` (155-266)| `fund-transfer.js`           | FundTransfer extracted, own module                      |
| `model.js` (268-1311)| `model-asset.js`            | God class slimmed: MetricSet, InstrumentType, factories |
| —                    | `tracked-metric.js`          | New: eliminates 120+ lines of init/push/zero repetition |
| —                    | `index.js`                   | New: barrel export for clean imports                    |

## Key Architecture Changes

### 1. Instrument Classification (30 functions → 1 object)

**Before** — scattered free functions with chains of `if/else`:
```js
function isFundableAsset(value) {
    if (value == sInstrumentNames[sInstrumentsIDs.cash]) return true;
    else if (value == sInstrumentNames[sInstrumentsIDs.bank]) return true;
    else if (value == sInstrumentNames[sInstrumentsIDs.taxableEquity]) return true;
    // ... 5 more branches
    else return false;
}
```

**After** — Set membership lookup:
```js
import { InstrumentType } from './instrument.js';

InstrumentType.isFundable('cash')        // true — O(1) Set lookup
InstrumentType.isCapital('rothIRA')       // true
InstrumentType.displayName('home')        // "House"
InstrumentType.emoji('home')              // "🏡"
InstrumentType.all()                      // [{ key, emoji, label, sortOrder }, ...]
```

**Why**: The old approach was O(n) string comparisons, error-prone (easy to forget a branch), and scattered across 300 lines. Sets are self-documenting and exhaustive.

---

### 2. TrackedMetric (120 lines → 10 lines of declaration)

**Before** — `initializeChron()` had 25 identical blocks:
```js
this.mortgageInterestCurrency = new Currency();
this.monthlyMortgageInterests = [];
// ... repeated 24 more times
```

And `monthlyChron()` had 25 identical push-then-zero blocks:
```js
this.monthlyMortgageInterests.push(this.mortgageInterestCurrency.toCurrency());
this.mortgageInterestCurrency.zero();
// ... repeated 24 more times
```

**After** — declare metric names, MetricSet handles lifecycle:
```js
const METRIC_NAMES = [
  'cashFlow', 'income', 'afterTax', 'mortgageInterest', // ... etc
];

// In constructor:
this.metrics = new MetricSet(METRIC_NAMES);

// In initializeChron:
this.metrics.initializeAll();

// In monthlyChron:
this.metrics.snapshotAll(KEEP_ON_SNAPSHOT);
```

**Why**: The old pattern was the single largest source of duplication. Every new metric required changes in 3 places. Now you just add a string to the array.

---

### 3. addMonthlyXxx() → addToMetric() (15 methods → 1)

**Before** — 15 nearly identical methods:
```js
addMonthlyMortgageInterest(amount) {
    logger.log(this.displayName + ' add mortgageInterest: ' + amount.toString());
    this.mortgageInterestCurrency.add(amount);
    return this.mortgageInterestCurrency.copy();
}
// ... repeated 14 more times
```

**After**:
```js
asset.addToMetric('mortgageInterest', amount);
```

**Backwards compat**: The old method names can be added as one-liner aliases if needed during migration:
```js
addMonthlyMortgageInterest(amt) { return this.addToMetric('mortgageInterest', amt); }
```

---

### 4. ES Modules

**Before**: Everything was global, loaded via `<script>` tags or `importScripts()`. Dependencies were implicit.

**After**: Every file declares its imports explicitly:
```js
import { Currency }       from './currency.js';
import { InstrumentType } from './instrument.js';
```

**Migration for web workers** (`simulator.js`): Replace `importScripts(...)` with module worker:
```js
// Old
importScripts('model.js', 'util.js', ...);

// New — in the Worker constructor
new Worker('simulator.js', { type: 'module' });
// Then in simulator.js:
import { ModelAsset, Currency, ... } from './model/index.js';
```

---

### 5. Value Type Improvements

**Currency**:
- `add()`/`subtract()` no longer silently skip when amount is 0 (old code used `if (currency && currency.amount)` which skipped zero values)
- Added immutable variants: `plus()`, `minus()`, `times()` for functional pipelines
- Rounding only on output, not construction (avoids floating point drift over 300+ months)

**DateInt**:
- `diffMonths()` is now arithmetic instead of a while-loop: `O(1)` vs `O(n)`
- `addMonths()` same — no more looping
- Added `equals()`, `isBefore()`, `isAfter()` — clearer than `d1.toInt() > d2.toInt()`

---

## Incremental Migration Strategy

You don't need to convert everything at once. Here's the recommended order:

1. **Drop in the value types** (`currency.js`, `date-int.js`, `arr.js`)
   — These have no dependencies on the rest and are the foundation.

2. **Add `instrument.js`** and update call sites from `isXxx(thing)` to `InstrumentType.isXxx(thing)`
   — You can keep the old free functions as thin wrappers temporarily:
   ```js
   function isCapital(v) { return InstrumentType.isCapital(v); }
   ```

3. **Add `tracked-metric.js`** and refactor `initializeChron()` / `monthlyChron()` in ModelAsset
   — This is the biggest bang for the buck in terms of code reduction.

4. **Extract `fund-transfer.js`** and `results.js`
   — Clean separations, minimal risk.

5. **Switch to `model-asset.js`**
   — By this point most of the building blocks are in place.

6. **Add ES module `type="module"` to your script tags** (or bundler config)
   — And update `simulator.js` to use `new Worker(..., { type: 'module' })`.

---

## Things NOT Changed

- **Financial logic**: All monthly/yearly calculation formulas are preserved exactly.
- **Portfolio.js**: Not touched — it consumes ModelAsset's public API which is maintained.
- **Taxes.js**: Not touched — same reason.
- **HTML templates**: The `html.js` template strings still work because ModelAsset
  exposes the same `.toHTML()` methods on its value types.
- **Charting**: `monthlyValues`, `monthlyCashFlows` etc. are still accessible (via getter aliases).

---

## Testability Gains

The refactored code is much easier to unit test because:

- **Value types are pure**: `Currency`, `DateInt`, `ARR` have no DOM or global dependencies
- **InstrumentType is stateless**: just functions over an enum, trivially testable
- **MetricSet is isolated**: test init/snapshot/add without instantiating a full ModelAsset
- **ModelAsset.fromJSON()** takes a plain object — no DOM parsing needed for test fixtures
- **No globals required**: the old code needed `sInstrumentNames`, `sInstrumentsIDs`, `colorRange` etc. to be in global scope
