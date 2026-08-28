# Spec 9 — SimConfig: the engine stops reading `localStorage`

**Status: COMPLETE.** Steps 0-7 shipped 2026-08-27/28 on `refactor/layer-boundary`
([PR #41](https://github.com/ChartingFinance/src/pull/41)). `engine closure: 35
files, 0 exempt` — the engine takes its configuration as a value, and a full
plan, report and causal chain run with no `localStorage` defined at all.

---

## 1. Why

The engine reads its configuration out of browser storage. Not as a quirk of
one module — as its architecture:

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

`export let global_inflationRate` is a **cache of `localStorage`**. The setter
writes only to storage; the getter reloads the module variable as a side effect
and returns nothing. Two consequences that look like accidents are actually this
design working as built:

- `applySettings` in `run-plan.js` calls the getter and **discards the result**.
  Those calls are load-bearing, not redundant.
- `js/mcp/polyfill.js` exists at all. A headless caller has to fake a browser
  storage API before it can tell the engine its own filing status.

Three things follow, and they are the reasons to do this work.

**1. The headless server is not reentrant.** Two plans in one process share one
configuration. It is safe today only because `chronometer_run` contains zero
`await`s, so a run completes before yielding — verified by probe, recorded
nowhere. `mc-compute.js` awaits a checkpoint every batch, so the moment Monte
Carlo reaches the MCP surface, concurrent calls interleave.

**2. The MCP run-handle cache is forced.** `js/mcp/run-plan.js` documents
handles as "a CORRECTNESS requirement, not an optimisation," and that is true —
but only *because* run state is module state. Thread the config and the claim
expires.

**3. `applySettings` is a six-step sequence with an ordering constraint** — the
`TaxTable` must be built after `filingAs`, or an MFJ plan silently runs on
Single brackets. A sequence every caller must perform correctly is a constructor
argument wearing a disguise.

## 2. The rule, stated once

> **Engine configuration is a value, captured at a known moment, owned by the
> Portfolio, and passed explicitly. The engine never reads it from module state,
> and never from a host API.**

## 3. What the engine actually reads

Measured, not estimated. Of 22 `export let` globals, **13 are read by engine
code at all** — 106 references:

| global | engine refs | read by |
| :--- | ---: | :--- |
| `activeTaxTable` | 51 | chronometer, all 4 `engines/`, financial-package, mc-compute, rule-notes, tax-basis |
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

Three facts in that table shape everything below.

- **`activeTaxTable` is 51 of the 106** — and it is the *easiest*, because it is
  not a scalar setting but a computed object already installed through a setter,
  and nine of its readers are four engine classes constructed at a **single
  site**, `portfolio.js:332-335`.
- **`finplan-app.js`'s 145 references do not move.** That file is the settings
  *editor*; reading them is its job.
- **Four globals are dead** outside `globals.js`: `global_propertyTaxRate` and
  the three `global_equity_*`. A fifth, `global_taxYear`, is *engine*-dead but
  has a live UI control — see step 0.

The `const` data tables — `global_sp500_annual_returns`,
`global_cpi_annual_inflation`, and friends — are immutable reference data, not
state. They stay module constants. This spec does not touch them.

## 4. Design

### 4.1 The shape already exists

`global_workerSnapshot()` (`globals.js:448`) already returns exactly the object
this spec needs. Workers boot on defaults, so every worker payload had to carry
the whole configuration as a serializable bag. **The problem was solved once,
for one transport, and left there.**

SimConfig is that bag promoted from a worker-transport detail to the way the
engine is configured — plus `taxTable`, which the worker path currently rebuilds
on arrival rather than shipping.

```js
{ inflationRate, filingAs, startAge, retirementAge, finishAge,
  propertyTaxDeductionMax, allocateHouseholdTax,
  pensionWithholdingRate, socialSecurityWithholdingRate,
  backtestYear,
  taxTable }   // built from filingAs in the constructor, so §1's ordering
               // constraint becomes an invariant of the object rather than
               // a duty of every caller
```

Frozen on construction.

### 4.2 A captured copy, never a live reference

An object that *forwards* reads to the globals — getters over the live module
bindings — would work in JavaScript, and would be a trap:

```js
const env = { get inflationRate() { return global_inflationRate; } };   // NO
```

It preserves the coupling and merely renames it: two concurrent plans still read
the same cell. And it is **unverifiable**. The gate for every step below is a
bit-identical snapshot, and a live view is trivially bit-identical *because it
is the same value read through one more layer*. Every step would pass while
proving nothing about whether the threading is correct.

Capture implies a moment. That is the whole point.

### 4.3 The Portfolio owns the environment; assets borrow it

`ModelAsset` has no Portfolio back-reference, and its two global reads are both
in **derived getters** — `effectiveAnnualReturnRate` (the inflation fallback for
expense instruments) and `effectiveFinishDateInt` (falls back to the plan's
finish age). Read on demand during a run, not captured at construction, so the
environment must be reachable from the instance.

Binding an environment to each asset is right. Ownership must still be
singular: **one environment per run, held by the Portfolio, bound onto assets by
the Portfolio.** Otherwise there are N copies that must agree, and one stale
copy produces a silently divergent run — concretely, Monte Carlo builds a
Portfolio per iteration, so a missed rebind is a wrong number in one iteration
out of a thousand.

```js
// portfolio.js — the single binding site, alongside the four engines
this.config = config ?? simConfigFromGlobals();
for (const a of this.modelAssets) a.bindEnv(this.config);
```

Three rules. The class already supports two of them:

1. **Excluded from `toJSON()`.** Already the convention there — the existing
   comment draws the config-vs-run-state line explicitly ("events/creditMemos
   are run state"). The environment is a third category on the run-state side.
2. **Not carried by `copy()`.** `copy()` is an explicit allowlist rather than a
   spread, so this is one decision rather than an inherited leak.
   **`Portfolio.copy()` (`portfolio.js:254`) maps `modelAsset.copy()` and must
   rebind** — that is the concrete site.
3. **A read through an unbound environment throws.** The failure mode this
   project keeps hitting is plausible numbers from the wrong source. A fallback
   to the global makes a missed rebind invisible; a throw makes it a stack trace
   on the first run. **See §7.1 — this cannot be switched on until the asset
   list is rerouted.**

### 4.4 Portfolio-first, and why Quick Start already proves it

The rule this implies is that **a Portfolio exists before the assets it owns**.
Quick Start already works that way:

```
buildQuickStart(profile, ageOverrides)
  → resolve ages                                    ← configuration
  → dateAnchors(startAge, retirementAge, finishAge) ← dates derived from it
  → profile.assets(d)                               ← assets derived from those
```

It needs no reworking to support the rule; it is the existing proof the rule is
natural. And the historical MCP defect — age overrides that moved no date — was
caused *precisely* by violating it, setting globals after the assets were built.

The obstacle is `Portfolio`'s constructor, which derives
`birthYear = firstDateInt.year - global_user_startAge` and builds `activeUser`,
so it currently needs assets. Note this is a **duplicate derivation**:
`dateAnchors` already computes `birthYear = currentYear - startAge` from
configuration directly. Under Portfolio-first the config-direct derivation is
the honest one and the asset-derived one goes away — **the inversion removes a
redundancy rather than adding work.** `activeUser` construction moves to
`addAssets`, before `initializeChron`, which already resets its age.

### 4.5 `addAssets`, not `Portfolio.createAsset`

Binding is not constructing. Assets are produced by `ModelAsset.fromJSON` and
`membrane_rawDataToModelAssets` when hydrating a share URL or `localStorage`,
and those must not need a Portfolio.

`portfolio.addAssets(assets)` gets the rule — no asset is ever *used* unbound —
while leaving hydration a free function. `createAsset` would close the
construction-to-binding window by construction; `addAssets` closes it by
convention plus rule 3. The latter is far less invasive, and given §7.1 rule 3
needs scoping anyway.

**Do not invert the constructor in place.** `new Portfolio(assets, reports)`
survives as sugar for *build env from globals → construct → `addAssets`*, so the
45 test sites keep working, while `new Portfolio({ config })` + `addAssets(...)`
becomes the explicit path for `run-plan.js`, `mc-compute.js` and the app.
Migrating the test sites is then optional, and can happen later or never.

### 4.6 Where the globals end up

**The globals survive, and so does their UI.** They are not the problem; the
engine *reading* them is. After this spec they are the browser-side settings
store — the persistence behind the settings editor — and their job is to supply
the values a Portfolio captures when one is created. `globals.html` keeps its
controls, `finplan-app.js` keeps its 134 references, and `globals.js` keeps
`localStorage`, which for a settings store is the right medium.

What changes is only this: **`globals.js` leaves the engine's import closure.**

That has a consequence step 6 has to be explicit about. If `Portfolio` itself
defaults to `simConfigFromGlobals()`, then `Portfolio` imports `globals.js`, and
`globals.js` stays in the closure *forever* — which means the
`tests/layer-boundary.mjs` exemption could never be deleted, and step 6 loses
the signal that says the work is done. So the layers split like this:

| module | layer | knows about |
| :--- | :--- | :--- |
| `js/sim-config.js` | engine | the frozen value type, validation, `simConfigFromPlanSpec()`. Imports no globals. |
| `simConfigFromGlobals()` | UI | reads the settings store and builds a config. Lives with `globals.js`, not with the engine. |
| `run-plan.js` | MCP | builds a config from the plan spec. Never touches globals. |

Under that split the exemption is deleted not because `globals.js` changed, but
because the engine no longer reaches it.

**The cost is that the globals-default is temporary.** It exists to keep the 45
test sites working while behaviour moves (§7.3, §7.5); removing it at step 6
makes `config` a required argument, and those 45 sites migrate then — as a
mechanical change, with no behaviour in flight and a bit-identical snapshot to
prove it. That is the safe moment to do it, and it is the whole reason for
deferring it. §7.5's rule is *not simultaneously*, not *never*.

## 5. Steps

| # | Step | Size |
| :-- | :--- | :--- |
| 0 | Delete the five dead globals | 30 min |
| 1 | `SimConfig` exists, inert, optional on `Portfolio` | ½ day |
| 2 | `taxTable` onto the config — the 51-reference block | 2 days |
| 3 | The scalar values, file by file | 2–3 days |
| 4a | Bind the environment everywhere, fallbacks intact | 1.5 days |
| 4b | Flip to throw-on-unbound; asset-list reroute | 1 day |
| 5 | Flip the callers | 1 day |
| 6 | Remove the mirror | ½ day |
| 7 | Stateless MCP | 1 day |

**Roughly two and a half weeks.** Steps 0–2 are ~60% of the value and land
independently. **Step 4 carries the design risk; step 2 carries the line count.
They are not the same step.**

---

**Step 0 — Delete the dead globals. SHIPPED 2026-08-27.** Four, not five:
`global_propertyTaxRate`, `global_equity_dividend_allocation`,
`global_equity_growth_allocation`, `global_equity_dividend_average_annual_rate`
— removed along with `global_default_propertyTaxRate`, the
`global_set/getPropertyTaxRate` accessor pair, their `global_reset()` and
`global_initialize()` calls, their `global_workerSnapshot()` round-trip, and the
`global_propertyTaxRate` probe knob in `tests/tools/snapshot.mjs`.
`propertyTaxRate` is superseded rather than unwired: property tax is computed
per-asset from `modelAsset.annualTaxRate` in `applyPropertyTaxEscrow`.

**`global_taxYear` was deleted separately, 2026-08-27, after investigation.**
The control was inert *and documented as inert* — the page carried a paragraph
saying the value "does not currently select a different table". Wiring it up was
rejected: a table set is a **base year** the engine indexes forward from once per
simulated year (`inflateTaxes`), so selecting 2025 for a plan starting 2026 would
apply 2025 brackets to 2026 income unless base-year-to-plan-start reconciliation
were added too. The correct base is always the most recently published table — a
data-vintage detail, not a planning lever.

Instead the control was replaced by a derived read-only panel: `TaxTable` now
exposes `baseYear` off the loaded table set (both sets already carried a `year`
field), and `globals.html` constructs a real `TaxTable` to report base year,
standard deduction, filing status and index rate. That also removed a hardcoded
"2026" from the page's prose, which would have gone stale silently at the next
table roll-forward. Mutation-verified: pointing `TaxTable` at `us_2025_taxtables`
makes the page report 2025 / $15,000.

The original note, kept because the lesson is the reusable part:

**`global_taxYear` was NOT deleted in step 0 itself.** The claim that all five were unused came
from a grep scoped to `js/`. It has a live control on `globals.html` — a page
listed in `vite.config.js` and shipped to `dist/` — which reads it into a
`#taxYear` input. Nothing in the engine reads it back, so it is a **dead
control**: the user can set a tax year and it changes nothing. That is a
user-facing decision (wire it up, or remove the control), not a silent cleanup,
and it belongs with the dead-controls item in the 2026-07-25 UI review.

Outcome against prediction: the predicted "no simulated number moved" held
exactly — the complete diff was **112 deletions across 28 baselines, four
`[config]` lines each, zero additions.** The prediction was wrong in one
respect worth recording: it said the baselines would be *unchanged*, but the
snapshot's `[config]` block is generated from `global_workerSnapshot()`
(`snapshot.mjs:432`), so removing fields from the snapshot necessarily rewrites
that preamble in every baseline. **A field's presence in `workerSnapshot()` is
part of the baseline contract** — worth remembering for step 1, which adds to
it.

**Step 1 — Introduce SimConfig; change no behaviour.** New `js/sim-config.js`:
the frozen shape and `simConfigFromPlanSpec(spec)`. `simConfigFromGlobals()`
lives on the UI side, not here (§4.6).
`Portfolio` gains an optional `config` argument defaulting to
`simConfigFromGlobals()`, exposed as `this.config`. **Nothing reads it yet** —
the object exists and is inert, and the snapshot must be untouched.

**Step 2 — `taxTable` onto the config.** Each of the four engine classes takes
`config` in its constructor (single construction site); `activeTaxTable` becomes
`this.config.taxTable`. `TaxTable` takes `filingAs` as a constructor argument
instead of reading the global, which dissolves §1's ordering constraint.
`tax-basis.js` already accepts `{ taxTable }` as an option — this finishes that
seam rather than inventing one.

**Step 3 — The scalar values, file by file. SHIPPED 2026-08-28.** chronometer,
tax-engine, payroll-engine, financial-package, taxes, portfolio. One snapshot
check per group, each mutation-verified.

Two files listed here turned out not to belong:

- **`life-event.js` moves to step 4.** Its `global_user_startAge` read is inside
  `ageToDateInt`, reached only from `ModelLifeEvent`'s `triggerDateInt` getter —
  a *derived getter on an object with no config reference*, which is exactly the
  `ModelAsset` shape §4.3 exists to solve. Threading it here would mean inventing
  a second mechanism for the same problem a step later.
- **`rule-notes.js` moves to step 4** for the sibling reason: its only caller is
  `asset-view-modal`, a Lit component holding no portfolio.

`propertyTaxDeductionMax` landed on `TaxTable` rather than in a threaded
parameter — a cap on a deduction is a parameter of the tax regime, like the
brackets beside it. `global_retirement_withholding_rate` and
`global_deferred_allocation_age` stay module imports: both are `export const`,
not settings state.

**Step 4 — The bound environment. SHIPPED 2026-08-28. Split in two, and the split is the point.**

Steps 1–3 were safe because every change used `X ?? global_X`. That fallback is
*why* each commit could be bit-identical: the new path and the old one provably
agree, and the snapshot proves it. Rule 3 of §4.3 — an unbound read throws — is
the exact opposite, and the two cannot share a commit. A fallback makes a missed
binding invisible; a throw makes the snapshot irrelevant, because the result is
a crash rather than a diff. They answer different questions and need different
gates.

**Step 4a — bind everywhere, fallbacks intact.** Every derived getter reads
`this.env?.X ?? global_X`. Gate: **bit-identical snapshot**. Answers *did I wire
it correctly?*

Bind in `Portfolio.initializeChron()`, which at `portfolio.js:357` already loops
`modelAsset.initializeChron()`. Not the constructor — the same lesson as the tax
table in step 2, and it matters more here, because `initializeChron` is
re-entrant by design (the GA re-runs it thousands of times on one Portfolio), so
binding there is idempotent and survives a config change between runs.

**The mechanism serves two classes, not one.** §4.3 was written about
`ModelAsset`; `ModelLifeEvent` needs the same thing. Its `triggerDateInt` getter
calls `ageToDateInt`, which reads `global_user_startAge` — a derived getter on
an object with no config reference, which is the same shape. Design it once.

**A crash is already visible in `ModelLifeEvent.copy()`:**

```js
copy() { return ModelLifeEvent.fromJSON(JSON.parse(JSON.stringify(this.toJSON()))); }
```

It round-trips through JSON, so an `env` field is dropped automatically — rule 2
satisfied for free. But that means **every copied life event is unbound**, and
`Portfolio.copy()` maps `e.copy()`. Under 4b, `triggerDateInt` on those throws
unless `Portfolio.copy()` rebinds them. Findable now rather than at runtime.

**Step 4a needs its own test, because the snapshot cannot see its failure mode.**
Step 1 demonstrated the gate's blind spot by construction: a live-forwarding
config failed three assertions in `tests/sim-config.mjs` while the snapshot
reported "28 fixtures unchanged". The exposure here is the same shape — if
`copy()` wrongly carried the env, or every asset shared one mutable reference,
the numbers would be identical and the snapshot silent. Assert the semantics
directly: env absent from `toJSON`, not carried by `copy()`, rebound by
`Portfolio.copy()`, one env per run shared by every asset.

**Step 4b — flip to throw.** Remove the fallbacks; an unbound read raises. The
only possible outcomes are "crashes somewhere" or "nothing", which is what makes
it a different question: *did I wire it everywhere?*

Reroute the asset list through `appState.portfolio` first (§7.1) — and note that
§7.1 understates the window. `quick-start` builds **life events** before any
Portfolio too, so the audit covers both classes' derived getters, not just
assets'.

**Deliberately not in step 4:** both `global_getFinishDateInt()` and
`ageToDateInt()` call `new Date().getFullYear()` *inside* the derived getter, so
a plan's finish date and every life-event trigger depend on wall-clock time at
read. Capturing the current year into the env would remove that nondeterminism
and is tempting while touching exactly these getters — but it changes behaviour
across a year boundary, which is a behavioural change wearing a refactor's
clothes. Out of scope, on its own.

**Step 4 outcome.** 4a was bit-identical, as designed. 4b produced exactly one
failure — `tests/mc-worker-sanity.mjs`, which read `triggerDateInt` off a bare
event to prove a worker snapshot shifts life-event triggers; the chain now has
one more link and the test follows it. Three binding gaps the audit found that
§7.1 had not listed:

1. **The Portfolio constructor itself reads a derived getter.** `lastDateInt()`
   maps `effectiveFinishDateInt` over every asset, and ran before binding — so
   4b would have thrown on every Portfolio ever constructed. Binding now happens
   in the constructor too; `initializeChron` rebinds once the tax table is on
   the config.
2. **`appState.lifeEvents` arrives from four places**, none through a Portfolio.
   Bound in AppState's single setter, the one point all four funnel through.
3. The two UI asset lists (§7.1's original finding), via `bindForEditing`.

The UI binds an *editing* environment captured from current settings; a
Portfolio still captures its own and rebinds everything it owns, so nothing the
editor holds can reach a simulation. `model-asset.js` and `life-event.js` now
import nothing from `globals.js`.

**Step 5 — Flip the callers. SHIPPED 2026-08-28**, in three parts.

**5a** moved `taxTable.initializeChron()` inside `Portfolio.initializeChron()`.
Every caller had been running it on the line immediately above — a two-line
sequence repeated at four sites that a caller can get wrong. Bit-identical.

**5b** replaced `applySettings` with `simConfigFromPlanSpec`. It lives in
`run-plan.js`, not `sim-config.js`, because it needs the `global_default_*`
values — which is where §4.6's table puts it. Three of those defaults had no
name and are now consts.

Removing the module-level install is what exposed the remaining ambient reads,
which is the point of the step: `Portfolio.initializeChron` overwrote a supplied
table with the global, and seven `taxableBasis` calls across the three engines
relied on the ambient one. Both crashed on a null table immediately. Four
assertions in `mcp-run-plan` read `global_filingAs`/`activeTaxTable` and now
read the run's own config — the stronger claim, and one of them can now assert
something previously impossible: that two runs held *different* tax tables.

**Verified concurrent.** Two plans running at once keep their filing statuses
and tables apart and produce byte-identical results to running them
sequentially. That is the hazard §1 opens with, now closed rather than unlikely.

**5c** added `allocateHouseholdTax` and both withholding rates to
`global_workerSnapshot()`. All three are read by the engine and none was in the
payload, so a Monte Carlo worker ran on its own defaults for them. Latent — they
all sit at defaults today — but turning spec 4a on would have given MC a
different tax regime than the projection beside it.

**Not done here:** the app and the remaining worker sites still rely on
`Portfolio`'s globals-backed config default. Passing `simConfigFromGlobals()`
explicitly is cosmetic while that default exists, so it belongs with step 6,
which removes it.

**Step 5 — original plan.** `run-plan.js` builds a config from the plan spec
and **deletes `applySettings` entirely** — 32 global references go with it.
`finplan-app.js` builds one from UI state. Workers already ship a snapshot; they
now ship a config. **This is where behaviour actually changes** (§7.3).

**Step 6 — Cut the engine's last link to the settings store. PARTLY SHIPPED
2026-08-28.**

**6a — separate the three things living in globals.js.** Only one was a setting.
`js/market-data.js` took the four historical series (immutable, year-keyed, no
setter); `js/policy-constants.js` took `global_retirement_withholding_rate` and
`global_deferred_allocation_age` (both `export const`); `SIM_CONFIG_DEFAULTS`
moved into `sim-config.js`, with globals.js now deriving its ten
`global_default_*` from it. That last one mattered most: the settings store had
been the source of truth for what the engine does when told nothing, which is
backwards, and it was what kept `run-plan.js` importing globals.

Two things fell out. `mc-compute` still read `global_inflationRate` at three
sites steps 3 and 5 had missed. And `applyRandomRates`'s new rate argument is
**required in calibrated mode rather than defaulted** — `null + deviation` is a
number, so a caller that forgot would get a quietly wrong inflation path, and
the only test touching that function reads the asset rates rather than the
returned inflation.

`chronometer`, `mc-compute`, `tax-engine`, `tax-allocation` and `run-plan` no
longer import globals.js at all.

**6b — `config` is now required on `Portfolio`.** 55 sites across 42 files pass
`simConfigFromGlobals()` explicitly. Provably behaviour-neutral, since the value
passed is exactly what the default computed; bit-identical snapshot confirms.

**Still open before the exemption can go.** `globals.js` remains in the closure
through four files, all holding fallbacks:

| file | holds | needs |
| :--- | :--- | :--- |
| `portfolio.js` | `activeTaxTable` | `simConfigFromGlobals()` to build a table |
| `taxes.js` | `filingAs`, `inflationRate`, `propertyTaxDeductionMax` | `TaxTable` args required (~58 sites) |
| `financial-package.js` | `activeTaxTable`, `propertyTaxDeductionMax` | callers to pass them |
| `tax-basis.js` | `activeTaxTable` | callers to pass it |

The order is forced: `taxes.js` must stop importing globals.js **first**, or
`globals.js` cannot import `TaxTable` to build one without a cycle. Then
`simConfigFromGlobals()` builds the table, and the other three fallbacks drop
out. Only then can `js/mcp/polyfill.js` and the exemption be deleted.

**Step 6 — original plan.** Drop the
globals-default from `Portfolio` so `config` is required, migrate the 45 test
sites to pass one (mechanical; snapshot must stay bit-identical), delete
`js/mcp/polyfill.js`, and **delete the `globals.js` exemption from
`tests/layer-boundary.mjs`** — that test fails while a stale exemption remains,
so it reports when this step is genuinely complete rather than merely believed
complete.

**`globals.js` itself survives, `localStorage` and all**, as the UI's settings
store (§4.6). Nothing about the settings pages changes. The engine simply stops
importing it, which is what drops it from the closure.

**Step 7 — SHIPPED 2026-08-28.** The server keeps the plan **spec**, not the
finished Portfolio. Both halves of the old "handles are a correctness
requirement" argument turned out to be gone: a re-run is byte-identical
(traceIds included) now that two plans share no configuration, and
`resetTraces()` *rebinds* `_scopes = []` rather than emptying it, so a finished
portfolio keeps its own scope list regardless — the old comment assumed the
opposite.

Handles are content-addressed (sha1 of `{spec, opts}`), so the same plan always
yields the same handle. `getRun` is async; a miss re-runs. Measured over six
live handles:

| | held |
| :--- | :--- |
| before | 152,830 trace scopes + 77,286 events, **evicting at four** — two of those six handles would already be dead |
| after | 55 KB of plan specs, plus at most two memoised runs |

Cold-handle resolve: **34 ms**. `tests/mcp-stateless.mjs` (13 assertions)
carries the argument; the load-bearing one renders a chain, evicts the memo,
re-runs from the spec and compares the markdown character for character.

**Step 7 — original plan.** Every tool call constructs its own
config, so concurrent calls share nothing and the handle cache stops being a
correctness requirement. Handles become an honest cache: store the **spec**, not
the finished Portfolio. A miss re-runs in ~47ms instead of erroring, and
re-running is byte-identical *including `traceId`s* (measured), so chains
resolve identically. Retained state drops from 23,276 scopes + 12,290 events per
cached run to a plan spec.

## 6. Verification

**The gate for steps 0–4 is `node tests/tools/snapshot.mjs`, bit-identical.**
These steps are a pure refactor; any diff is a real behaviour change that snuck
in. Per this project's standing rule, the expected diff is written down *before*
the change, never blessed after.

`tests/layer-boundary.mjs` is the second gate, and it is the one that reports
completion: it fails while `globals.js` remains exempt *and* fails if the
exemption is kept after it stops being needed.

Mutation-verify anything load-bearing. Green suites have repeatedly proved
nothing in this codebase — 162 assertions passed a one-letter memo rename; two
of four provenance tags could be inverted with everything green.

## 7. Traps

### 7.1 The UI reads derived getters on unbound assets — blocks rule 3

`finplan-app.js:493` (`assetList.modelAssets = qs.assets`) and
`finplan-app.js:1010` (`= membrane_rawDataToModelAssets(...)`) hand the asset
list raw assets that **never pass through a Portfolio**. `asset-list.js:194`
then calls `classifyAssets`, which reads `asset.effectiveFinishDateInt` at
`asset-groups.js:211`. Unconditional throw-on-unbound crashes the asset list on
page load.

This is not an argument against the rule — it is the rule catching a real
existing problem. **That column is already silently configuration-dependent:**
it renders against whatever `global_user_finishAge` happens to be. The fix is
small and in the spirit of the change, because `appState.portfolio` already
exists (`finplan-app.js:340`): route the asset list through
`portfolio.modelAssets` so it renders bound assets. Do that first; then rule 3
can be unconditional.

`charting.js:78` is fine — it iterates `portfolio.modelAssets`, always bound.

### 7.2 A partially-migrated file is the dangerous state

Some reads from `this.config`, some from the module global, silently disagreeing
once a caller sets one and not the other. Migrate whole files per commit, and
grep the file for `global_` before calling it done.

### 7.3 Optional-config-with-a-globals-default is a crutch, and it hides step 5

Until callers actually pass a config, every step verifies only that the new path
*agrees with* the old one. **Step 5 is where behaviour changes and where
scrutiny belongs** — not step 2, which is merely where the line count is.

### 7.4 The migration is invisible if it goes wrong

Every value involved is a number flowing into a projection. A config field wired
to the wrong source produces a different plan, not an error. The snapshot
harness is the only real defence, and it only works if the expected diff is
written down first.

### 7.5 A required constructor argument would break 45 test files at once

`new Portfolio(...)` appears at **57 sites, 45 of them in tests.** Making config
required lands a 45-file diff across every golden-master suite *simultaneously
with* the behaviour change it is supposed to be verifying — a full green suite
proving nothing because the baseline moved underneath it. Hence §4.5's rule that
the old signature survives as sugar. **This defers the migration, it does not
cancel it** — step 6 removes the globals-default and those 45 sites migrate
then, with no behaviour in flight and a bit-identical snapshot as the check.

## 8. Explicitly out of scope

- **The compounding convention.** `asMonthly()` is rate/12, so a stated 8.5%
  realizes 8.839%. A real bug with a golden-master-sized blast radius, and it
  must not ride along inside a refactor whose entire verification story is "the
  numbers did not change."
- **Splitting the repo.** Three layers, one repo, enforced by a test. If
  separate packages are ever wanted, a passing `layer-boundary.mjs` is the proof
  a split would succeed — and doing it *before* this work would publish
  `global_setX`/`global_getX` as core's API, freezing the exact thing being
  removed.
- **`generators/finplan-ai.js`'s layer.** It reads six globals (14 refs) and is
  a **formatter**, inside the engine closure only because the MCP server imports
  it. It should take config explicitly and move to a presentation layer, but
  that is a separate change. Note the latent bug it carries: the function MCP
  actually calls, `generatePortfolioMarkdown`, reads *no* globals — the six
  reads are in `generateTimelineMarkdown`, which the MCP report omits, and they
  happen **after the `await`**. Adding the plan-settings section to the MCP
  report (natural to want, since the report never states filing status or ages)
  would make a concurrent interleave print one plan's settings on another plan's
  report.
- **`js/mcp/mcp-client.js`.** Dead — nothing imports it, and its own doc comment
  cites a stale path. Delete separately.
