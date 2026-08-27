# SimConfig — threading engine configuration explicitly

**Status:** plan, not started. Prerequisite landed: `tests/layer-boundary.mjs`
(branch `refactor/layer-boundary`).

## The problem, stated once

The engine reads its configuration out of `localStorage`. Not as a quirk of one
module — as its architecture:

```js
export function global_setInflationRate(value) {
    localStorage.setItem('inflationRate', value.toFixed(4));   // module var NOT updated
}
export function global_getInflationRate() {
    let localIR = localStorage.getItem('inflationRate');
    if (localIR == null) localIR = global_inflationRate.toFixed(4);
    global_inflationRate = parseFloat(localIR);                // side effect; returns nothing
}
```

`export let global_inflationRate` is a **cache of browser storage**. The setter
writes only to storage; the getter reloads the variable as a side effect and
returns nothing. That is why `applySettings` in `js/mcp/run-plan.js` calls the
getter and discards the result — those calls are load-bearing, not redundant —
and why `js/mcp/polyfill.js` has to fake `localStorage` before the engine can
be told its own filing status.

Three consequences follow, and they are the reasons to do this work:

1. **The headless server is not reentrant.** Two plans in one process share one
   configuration. It is safe today only because `chronometer_run` contains zero
   `await`s, so a run completes before yielding. Nothing records that invariant,
   and `mc-compute.js` awaits a checkpoint every batch — the moment Monte Carlo
   reaches the MCP surface, concurrent calls interleave.
2. **The MCP run-handle cache is forced.** It exists because run state is module
   state. With config threaded, statelessness falls out for free.
3. **`applySettings` is a six-step sequence with an ordering constraint** (the
   `TaxTable` must be built *after* `filingAs`). A sequence that must be
   performed correctly by every caller is a constructor argument wearing a
   disguise.

## What the engine actually reads

Measured, not estimated. Of 22 `export let` globals, **13 are read by engine
code at all**:

| global | engine refs | read by |
| :--- | ---: | :--- |
| `activeTaxTable` | 51 | chronometer, all 4 engines/, financial-package, mc-compute, rule-notes, tax-basis |
| `global_inflationRate` | 13 | chronometer, finplan-ai, mc-compute, model-asset, taxes |
| `global_propertyTaxDeductionMax` | 8 | financial-package, taxes |
| `global_user_startAge` | 8 | finplan-ai, life-event, portfolio |
| `global_backtestYear` | 7 | chronometer, finplan-ai |
| `global_filingAs` | 5 | finplan-ai, taxes |
| `global_allocate_household_tax` | 4 | tax-engine, portfolio, rule-notes |
| `global_user_retirementAge` | 3 | finplan-ai, life-event |
| `global_pension_withholding_rate` | 2 | payroll-engine |
| `global_social_security_withholding_rate` | 2 | payroll-engine |
| `global_user_finishAge` | 2 | finplan-ai |
| `global_showEngineDiagnostics` | 1 | logger |

`activeTaxTable` dominates at 51 of 106. It is also the easiest: it is not a
scalar setting but a computed object already installed through a setter, and
**nine of its readers are four engine classes constructed at a single site**,
`js/portfolio.js:332-335`.

Five globals are dead outside `globals.js` entirely — `global_taxYear`,
`global_propertyTaxRate`, and the three `global_equity_*` — and can be deleted.

The `const` data tables (`global_sp500_annual_returns`,
`global_cpi_annual_inflation`, and friends) are immutable reference data, not
state. They stay module constants. This plan does not touch them.

## The shape already exists

`global_workerSnapshot()` at `js/globals.js:448` already returns exactly the
object this plan needs. Web Workers boot on defaults, so every worker payload
had to carry the full configuration as a serializable bag — the problem was
solved once, for one transport, and left there.

**SimConfig is that bag, promoted from a worker-transport detail to the way the
engine is configured.** Plus `taxTable`, which the worker path rebuilds on
arrival rather than shipping.

```js
{ inflationRate, filingAs, startAge, retirementAge, finishAge,
  propertyTaxDeductionMax, allocateHouseholdTax,
  pensionWithholdingRate, socialSecurityWithholdingRate,
  backtestYear,
  taxTable }        // built from filingAs at construction — ordering constraint
                    // becomes an invariant of the object instead of a caller's duty
```

Frozen on construction. It lives at `portfolio.config` — the engine already
threads `portfolio` everywhere, so this is a field access, not a new parameter
on 200 functions.

## The constraint that shapes everything

`new Portfolio(...)` appears at **57 sites, 45 of them in tests.**

A required constructor argument means a 45-file diff touching every golden-master
suite in the repo, landing at the same time as the behaviour change it is
supposed to be verifying. That is the shape of change this codebase has been
burned by before: a full green suite proving nothing because the baseline moved
underneath it.

**So config is optional throughout the migration**, defaulting to a snapshot of
the current globals. Every existing test passes unchanged at every step. The
globals become a *source* for the default rather than the engine's reading
surface, and only the final step removes them.

## Steps

Each step is independently landable and independently verifiable. The gate for
steps 0–4 is the same: **`node tests/tools/snapshot.mjs` must be bit-identical.**
This is a pure refactor; any diff is a real behaviour change that snuck in, and
per the project's own rule the expected diff gets written down *before* the
change, not blessed after.

---

**Step 0 — Delete the five dead globals.** `global_taxYear`,
`global_propertyTaxRate`, `global_equity_dividend_allocation`,
`global_equity_growth_allocation`, `global_equity_dividend_average_annual_rate`.
Zero uses outside `globals.js`. Also remove them from `global_workerSnapshot()`.
*Half an hour. Verified by the suite and a grep.*

**Step 1 — Introduce SimConfig; change no behaviour.** New `js/sim-config.js`:
the frozen shape, `simConfigFromGlobals()`, and `simConfigFromPlanSpec(spec)`.
`Portfolio` gains an optional `config` argument defaulting to
`simConfigFromGlobals()`, exposed as `this.config`. **Nothing reads it yet.**
*Half a day. Snapshot must be untouched — the object exists and is inert.*

**Step 2 — `taxTable` onto the config.** The 51-reference block. Each of the four
engine classes takes `config` in its constructor (single construction site) and
`activeTaxTable` becomes `this.config.taxTable`. `taxes.js` `TaxTable` takes
`filingAs` as a constructor argument instead of reading the global — which
dissolves the ordering constraint that `applySettings` documents. `tax-basis.js`
already accepts `{ taxTable }` as an option; this finishes that seam rather than
inventing one. *Two days — the largest mechanical chunk, and the highest-value.*

**Step 3 — The scalar values, file by file.** chronometer, tax-engine,
payroll-engine, financial-package, taxes, portfolio, rule-notes, life-event.
~55 references. Each file is its own commit with its own snapshot check.
*Two to three days.*

**Step 4 — Resolve the two files that do not fit.** These need a decision, not
just an edit, and are called out separately for that reason:

- `model-asset.js` reads `global_inflationRate` (4 refs) and has **no reference
  to a Portfolio.** Either config is passed to the specific methods, or the
  asset holds a back-reference. Cheapest is probably passing it at the call
  site, but it is a genuine design choice.
- `generators/finplan-ai.js` reads six globals (14 refs) and is a **formatter**,
  not engine code. It sits inside the engine closure only because the MCP server
  imports it. It should take config as an explicit argument and move to a
  presentation layer. Note that `generatePortfolioMarkdown` — the function the
  MCP server actually calls — reads *no* globals; the six reads are in
  `generateTimelineMarkdown`, which the MCP report does not currently include.
  **This is also a latent bug:** those reads happen after the `await`, so adding
  the plan-settings section to the MCP report (a natural thing to want, since
  the report never states filing status or ages) would make a concurrent
  interleave print one plan's settings on another plan's report.

*One day, plus the design conversation.*

**Step 5 — Flip the callers.** `run-plan.js` builds a config from the plan spec
and **deletes `applySettings` entirely** (32 global references go with it).
`finplan-app.js` builds one from UI state — its 145 references stay where they
are, because that file is the settings *editor* and reading them is its job.
Workers already ship a snapshot; they now ship a config. *One day.*

**Step 6 — Remove the mirror.** Delete the localStorage read/write pairs for
everything now carried by config, delete `js/mcp/polyfill.js`, and **delete the
`globals.js` exemption from `tests/layer-boundary.mjs`.** That test currently
fails if the exemption is stale, so it will tell you when this step is genuinely
complete rather than merely believed complete. *Half a day.*

**Step 7 — Stateless MCP, which is now nearly free.** Every tool call
constructs its own config, so concurrent calls share nothing and the run-handle
cache stops being a correctness requirement. Handles become an honest cache:
store the *spec*, not the finished Portfolio; a cache miss re-runs in ~47ms
instead of erroring. Re-running is byte-identical including `traceId`s
(verified), so chains resolve identically. *One day.*

**Total: roughly two weeks.** Steps 0–2 are ~60% of the value and can land
before anyone commits to the rest.

## What this plan does not do

- **It does not fix the compounding convention.** `asMonthly()` is rate/12, so a
  stated 8.5% realizes 8.839%. That is a real bug with a golden-master-sized
  blast radius and it must not ride along inside a refactor whose entire
  verification story is "the numbers did not change."
- **It does not split the repo.** Three layers, one repo, enforced by a test. If
  separate packages are ever wanted, a passing `layer-boundary.mjs` is the proof
  the split will succeed — and doing it *before* this work would publish
  `global_setX`/`global_getX` as core's API, freezing the exact thing being
  removed.
- **It does not touch `mcp-client.js`,** which is dead — nothing imports it, and
  its own doc comment references a stale path. Delete it separately.

## Risks

**The migration is invisible if it goes wrong.** Every value involved is a
number that flows into a projection; a config wired to the wrong field produces
a different plan, not an error. The snapshot harness is the only real defence,
and it only works if the expected diff is written down first.

**A partially-migrated file is the dangerous state** — some reads from
`this.config`, some from the module global, silently disagreeing after the first
caller sets one and not the other. Migrate whole files per commit, and grep the
file for `global_` before considering it done.

**Optional-config-with-a-globals-default is a temporary crutch, and it hides
step 5.** Until callers actually pass a config, every step verifies only that
the new path *agrees with* the old one. Step 5 is where the behaviour changes
and where real scrutiny belongs — not step 2, which is where the line count is.
