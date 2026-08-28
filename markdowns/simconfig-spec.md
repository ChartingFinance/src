# Spec 9 — SimConfig: the engine stops reading `localStorage`

**Status:** spec, not started. Prerequisite landed 2026-08-27 on
`refactor/layer-boundary`: `tests/layer-boundary.mjs` + `js/utils/util.js` →
`js/ui/util.js`.

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
- **Five globals are dead** outside `globals.js`: `global_taxYear`,
  `global_propertyTaxRate`, and the three `global_equity_*`.

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

## 5. Steps

| # | Step | Size |
| :-- | :--- | :--- |
| 0 | Delete the five dead globals | 30 min |
| 1 | `SimConfig` exists, inert, optional on `Portfolio` | ½ day |
| 2 | `taxTable` onto the config — the 51-reference block | 2 days |
| 3 | The scalar values, file by file | 2–3 days |
| 4 | The bound environment + Portfolio-first + asset-list reroute | 2 days |
| 5 | Flip the callers | 1 day |
| 6 | Remove the mirror | ½ day |
| 7 | Stateless MCP | 1 day |

**Roughly two and a half weeks.** Steps 0–2 are ~60% of the value and land
independently. **Step 4 carries the design risk; step 2 carries the line count.
They are not the same step.**

---

**Step 0 — Delete the five dead globals.** `global_taxYear`,
`global_propertyTaxRate`, `global_equity_dividend_allocation`,
`global_equity_growth_allocation`, `global_equity_dividend_average_annual_rate`.
Zero uses outside `globals.js`. Remove them from `global_workerSnapshot()` too.

**Step 1 — Introduce SimConfig; change no behaviour.** New `js/sim-config.js`:
the frozen shape, `simConfigFromGlobals()`, `simConfigFromPlanSpec(spec)`.
`Portfolio` gains an optional `config` argument defaulting to
`simConfigFromGlobals()`, exposed as `this.config`. **Nothing reads it yet** —
the object exists and is inert, and the snapshot must be untouched.

**Step 2 — `taxTable` onto the config.** Each of the four engine classes takes
`config` in its constructor (single construction site); `activeTaxTable` becomes
`this.config.taxTable`. `TaxTable` takes `filingAs` as a constructor argument
instead of reading the global, which dissolves §1's ordering constraint.
`tax-basis.js` already accepts `{ taxTable }` as an option — this finishes that
seam rather than inventing one.

**Step 3 — The scalar values, file by file.** chronometer, tax-engine,
payroll-engine, financial-package, taxes, portfolio, rule-notes, life-event.
~55 references. One commit and one snapshot check per file (§7.2).

**Step 4 — The bound environment.** §4.3 through §4.5. Reroute the asset list
through `appState.portfolio` first (§7.1), then bind, then switch rule 3 on.

**Step 5 — Flip the callers.** `run-plan.js` builds a config from the plan spec
and **deletes `applySettings` entirely** — 32 global references go with it.
`finplan-app.js` builds one from UI state. Workers already ship a snapshot; they
now ship a config. **This is where behaviour actually changes** (§7.3).

**Step 6 — Remove the mirror.** Delete the `localStorage` read/write pairs for
everything now carried by config, delete `js/mcp/polyfill.js`, and **delete the
`globals.js` exemption from `tests/layer-boundary.mjs`** — that test fails while
a stale exemption remains, so it reports when this step is genuinely complete
rather than merely believed complete.

**Step 7 — Stateless MCP, now nearly free.** Every tool call constructs its own
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
the old signature survives as sugar.

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
