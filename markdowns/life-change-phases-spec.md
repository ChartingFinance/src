# Spec 14 — Phases as life changes: a new job, a home sold, a home bought

Status: **PROPOSED 2026-10-29. Spec only, no code. Decisions for John in §13.**
Spec 12's Phase 2 (a fallback order on each phase) builds on Phase 0 here (§12).

A phase is a stretch of the plan with its own rules. Today there are two,
Accumulate and Retire, so the rules can change once, at retirement. On
2026-10-29, answering spec 12's §11.1, John said the phase is underused: any life
change, such as a new job, selling a house or buying a second home, should be
one. This spec makes a life change a phase: a dated chapter of the plan that can
close assets, rewire transfers and, with spec 12, change who pays when a rule
cannot. Spec 12 puts its order on `ModelLifeEvent` (its §4.3), so every phase
added here carries one.

Five rules hold throughout:

- **One shape.** Every phase, Accumulate and Retire included, is a
  `ModelLifeEvent`, and the engine applies them all the same way. A kind of life
  change is a template: a label, a color, what it is dated by, the assets it
  needs and what its form proposes. The engine never branches on the kind.
- **Retired is a stage, not the latest phase.** Only Accumulate and Retire decide
  whether the household is working or retired. Selling a home at 70 does not make
  anyone working again.
- **The user owns the assets.** A phase closes, rewires and re-orders assets the
  user created. It never creates or deletes one. How buying a home meets that
  rule is John's decision (§5).
- **Nothing moves by default.** A plan with only Accumulate and Retire runs
  byte-identical through Phase 0 (§12).
- **Nothing is stored that is not applied.** Every field a phase saves has a test
  that changing it changes the run from that phase on, and not a month before.
  `globalOverrides` is why (§1.1).

---

## 1. What exists

### 1.1 The model

`js/life-event.js`:

- `LifeEvent` has two members, `ACCUMULATE` and `RETIRE`.
- `LifeEventMeta` gives each a label, two colors (Accumulate green `#1D9E75`,
  Retire coral `#D85A30`), `projectionTabs`, `assetGroupLabels`,
  `defaultMutations.closes` (Retire: `['Salary']`) and `advisoryChecks` (Retire:
  "No retirement income found. Would you like to add one?").
- `LifeEventType` classifies: `isAccumulation`, `isRetirement`, `hasGuardrails`,
  `hasMonteCarlo`, and `isPhase`, which is true for exactly the two types. An
  unknown type is colored grey.
- `ModelLifeEvent` holds `type`, `displayName`, `triggerAge`, `closes` (asset
  names), `phaseTransfers` (`{ assetName: [FundTransfer JSON] }`) and
  `globalOverrides`, plus the run state `applied` and a borrowed, non-enumerable
  `env`. `triggerDateInt` is derived from the age and throws when unbound.
- `apply()` closes each named asset that is open, installs the phase's transfers
  through `Portfolio.applyPhaseTransfers`, and re-sorts the assets. A name in
  `closes` that matches no asset is skipped without a word.
- `toJSON()` and `fromJSON()` copy the six fields by name (`fromJSON` also reads
  the legacy `transferOverrides`). `copy()` goes through both.

Declared, and no effect:

| Field | What happens to it |
|---|---|
| `globalOverrides` | Saved, carried through the event form, never applied (code-issue #24). Measured: `{ inflationRate: 0.10 }` on every phase leaves the whole event stream unchanged (§1.8). |
| `advisoryChecks` | Read nowhere. |
| `projectionTabs`, and the getter of the same name | Read nowhere. |
| `hasGuardrails`, `hasMonteCarlo` | Called nowhere. |
| `assetGroupLabels` | Read by `getGroupLabel`, but every entry repeats the group's default label, except Retire's `distributions`, which names no group. No label ever changes. |

The advisory check is the piece the asset-ownership rule asks for ("check for the
missing instrument, prompt the user"). It was declared and never wired.

### 1.2 How a phase runs

- **The starting phase is the list's first entry, whatever its date.**
  `Portfolio.initializeChron` installs its transfers and records it at month 0.
- **The rest fire by date.** `Portfolio.applyLifeEvents` runs on day 1 of each
  month, before `applyMonth`. For each phase not yet applied whose
  `triggerDateInt` is this month, it moves the assets' clocks first (#113), opens
  the phase's own trace root, "Life event: <name>", applies it, and records the
  rules in force.
- **Rules are inherited per asset.** `applyPhaseTransfers` replaces the rules of
  each asset the phase lists. An asset it leaves out keeps the rules it had, and a
  closed asset is skipped.
- **The record.** `Portfolio.phaseRules` (#111) keeps one frozen record per
  change: `fromIndex`, the phase's name and type, and every asset's rules.
  `phaseRulesAt(portfolio, i)` reads it, so Flows shows a past month its own
  rules, not the last phase's. A second phase in the same month replaces the first
  one's record (§1.8).
- **Three loops call `applyLifeEvents`:** `chronometer_run` (`js/chronometer.js`),
  and `runOnce` and `computeBaseline` (`js/mc-compute.js`). The Maximizer
  (`simulator.js`) and Guardrails (`gr-compute.js`) run `chronometer_run`.
  Whatever a phase changes has to reach all three loops.
- **Monte Carlo and Guardrails** take the month their withdrawal regime starts
  from the Retirement Age setting (`global_getRetirementDateInt()` in the app,
  `ageToDateIntFor(config, config.retirementAge)` in `run-plan.js`), not from the
  Retire phase. `calculate()` keeps the two equal (§1.4).

### 1.3 How a phase is dated

- **By age, in January.** `triggerDateInt` is `ageToDateIntFor(env, triggerAge)`:
  January of `birthYear + triggerAge`. The birth year comes from the plan,
  `firstDateInt.year − startAge` (PR #47), never from the clock.
- **Assets carry months.** A salary, a sale or a purchase can start and end in any
  month. An asset is active through its finish month and closes on the first of
  the next (`ModelAsset.handleCurrentDateInt`). Social Security pays from 62 at
  the earliest (`activeFromDateInt`, #121).
- **Every phase in the corpus starts in January:** 16 life events in 47 fixtures
  (§1.8). `tests/fund-transfer-phase.mjs` overrides `triggerDateInt` with
  `Object.defineProperty` to fire a Retire in July. The model cannot say July.
- **The anchor moves phases, not assets.** Adding an asset that starts before the
  plan's first month moves that month, and the birth year with it, so every phase
  moves while every asset stays.
  Spec 7 decided that is correct, because a plan that now begins earlier is a
  different plan (its §10.1, 2026-08-08). It also means a phase and the asset it
  was meant to line up with can come apart.
- **One place keeps a phase and asset dates together:** `js/retirement-move.js`.
  Changing Retirement Age moves the Retire phase and the income dated exactly at
  the old retirement month (a salary that ends then, Social Security or a pension
  that starts then), and says what moved. It edits dates in response to the
  user's own setting, which the asset-ownership rule allows.
- **A phase can close an asset that its own dates still pay.** Retire closes
  "Salary" on January 1. Mid Career's salary is dated to finish in January 2048,
  and its last paycheck is December 2047. Dual Income's "Salary A", dated the
  same, is paid through January 2048, because Retire's `closes` says "Salary" and
  the couples' incomes are "Salary A" and "Salary B" (§1.8). Same date, one month
  of pay apart, decided by a name.

### 1.4 How a phase is edited

- **The event form** (`event-form-modal.js`) offers every `LifeEventMeta` type, so
  a second Retire can be added. It takes a name, a trigger age (no lower than the
  start age, and fixed for Accumulate once created) and a checkbox per asset to
  close. It can delete an event when there is more than one.
- **The form rebuilds the event field by field.** `_onSubmit` constructs a new
  `ModelLifeEvent` from the form and carries over `phaseTransfers` and
  `globalOverrides` only. A new field not named there is dropped by every edit,
  just as `fromJSON` drops it.
- **Order is kept on create only.** Adding an event sorts the list by
  `triggerAge`; editing one replaces it in place.
- **The timeline's popover** offers Edit, and a disabled Remove: "phases are
  structural; adjust ages in Edit instead". Its code comment expects removable
  life events to join the row one day.
- **Transfers, from an asset card:** the modal shows the selected phase's own list
  for that asset, `phaseTransfers[name] || []`, so a rule the phase inherits shows
  as 0%. Verified in the app: Mid Career with Retire selected shows the Home's
  rules at 0% for every account, while Accumulate's "Home → Brokerage 100%" is the
  rule in force. Saving writes the list into the selected phase.
- **Transfers, from Flows:** `phaseSetting()` finds the phase that set the rule by
  walking back through the list by index, and saving edits it there, which
  changes it in every later phase that inherits it. The two entry points disagree
  about inheritance.
- **`calculate()` rewrites phases before every run.** Retire's age sets the
  Retirement Age setting (with no assets, both phases follow the settings).
  Accumulate is deleted once the start age reaches the retirement age. And every
  `phaseTransfers` entry or target that names an asset not in the plan is
  deleted.
- **So a rename deletes rules.** The asset form renames in place and nothing
  rewrites the phases, so the next `calculate()` prunes every rule that named the
  old name. Verified in the app: renaming Mid Career's "Brokerage" to "Schwab"
  deleted eight rules across both phases: the salary's 93% deposit, the payers of
  the home, mortgage, rent and living expenses, Social Security's deposit, and the
  brokerage's 60% of rent and of living expenses in Retire. `closes` is not
  pruned; an old name stays there and is skipped.
- **Indexes stand in for identity.** `appState.phaseIndex` is an index into the
  timeline's visible phases, while `showPopupTransfers` indexes
  `appState.lifeEvents`. They agree because `calculate()` deletes the one phase
  the timeline hides. The Maximizer's genes carry a phase index, and "Apply to
  Baseline" copies `phaseTransfers` back by index. Everywhere else a phase is its
  name: `phaseSetting()`, Flows' phase pills and edit link, `phaseRules`, and the
  trace root that `tests/life-event-dating.mjs` matches.

### 1.5 How phases show

| Surface | Today |
|---|---|
| Timeline bands (`finplan-timeline.js`) | One band per phase that `isPhase` admits, from its age to the next one's, colored by type, with its name and growth rate (a dash where there is none, #119) and a value checkpoint at each interior boundary. Accumulate is hidden once the start age reaches retirement. |
| Timeline chips | Name and age range, Edit, and "+ Life event". |
| Timeline pins | Real estate bought and sold, a mortgage opened and paid off, Social Security and a pension starting. All from asset dates; none from a phase. |
| Projections charts | `charting_buildPhaseMarkers` marks Accumulate and Retire only; `charting_buildDateMarkers` marks every life event after the first. |
| Monte Carlo and Guardrails charts | `buildSimulationMarkers` marks Accumulate only; Retire is drawn by its own plugin. |
| "Viewing" badge | The phase at the cursor's age (`currentPhaseEvent`), colored by type. |
| Asset list | Group order from whether the first phase is Retire (`isRetiredPhase`); group labels from `appState.lifeEvents[0]`, which change nothing (§1.1). |
| Flows | The rules in force from `phaseRules`, pills "name · from month", and a note in a year that changes phase. `buildPipelines` calls the household retired when the record's type is Retire, which hides "No retirement savings configured". |
| Maximizer | Genes per phase. The cap on retirement contributions is 25% when `isAccumulation(type)`, else 10%. |
| Reports, Month & Year Details | Nothing about phases. |
| ⚡ timeline summary (`finplan-ai.js`) | Every life event, its type and date. |
| Help, Rules, Globals | Two phases, green and coral. Rules' "Life Events & Phases" ("Salary closes automatically") and "Phase-Aware Optimization"; Globals' "Retirement Age is where the Accumulate phase ends". |

### 1.6 How phases travel

- **Scenarios:** `saveScenario` (`js/scenario-store.js`, the only scenario writer)
  stores `lifeEvents` as JSON per scenario, and in the month's snapshot.
- **Share links:** `lifeEvents` is one of the five `SPEC_KEYS`, and
  `readSharedPlan` reads it with `fromJSON`.
- **MCP:** `run_plan` accepts any objects as life events (`z.record`), and
  `runPlan` and `runMonteCarloFor` read them with `fromJSON`. None of these paths
  sorts them. `build_plan` emits Accumulate at the start age and Retire when the
  plan reaches it ("LifeEvent has exactly two members"), and has no word for a
  home. `diff_plans` says only "Changed — N in A, M in B".
- **Workers** (Monte Carlo, Guardrails, the Maximizer) receive `toJSON()` and
  rebuild with `fromJSON`.

### 1.7 Life changes the plans already contain

The asset side of each change John named can already be written:

- **A home sold.** Three shipped profiles sell their home mid-plan and start
  paying rent, by asset dates alone: Early Career and Young Couple 25 years in
  (age 60), Mid Career 10 years in (age 55). Their Accumulate phase already holds
  Rent's rule, waiting for Rent to start. No phase marks the sale. In Mid Career
  it comes twelve years before retirement, so nothing about who pays can change
  at it. And Rent starts in the home's finish month: Mid Career's January 2036
  pays the first rent and the home's property tax, and the home is sold in
  February (§1.8). When two assets carry one change, the month boundary is easy
  to get wrong.
- **A home bought.** A real-estate asset dated in the future opens the funding
  modal: bought outright or with a down payment from a named account
  (`fundingConfig`), and a down payment chains a pre-filled mortgage form. In the
  home's first month `applyAssetOpenFundTransfer` debits the payment.
- **A home sold by a phase.** In `retirement-sells-a-rental`, Retire closes a
  rental. It is the only fixture where a phase closes a capital asset.
- **A new job.** The old salary's finish date and the new salary's start date. The
  new salary's rules sit in whichever phase is in force.

What cannot be written: rules that change on the day of the change (except at
retirement), a fallback order that changes then (spec 12), and the change itself
as a named chapter of the plan.

### 1.8 Measured

A read-only probe on main 21603db, with the clock pinned and fixtures from the
snapshot corpus (Sources):

| Probe | Result |
|---|---|
| `globalOverrides: { inflationRate: 0.10 }` on every phase | Event stream unchanged: `retirement-sells-a-rental` 392 events, `quickstart-midCareer` 12,382 events, same hashes. |
| A third event, typed Retire, "Sell the rental" at 59, in `retirement-sells-a-rental` | Fires: the rental closes in January 2027, and there are three records. In June 2027 the salary is still paid (until January 2028), but the record's type is Retire, so Flows calls the household retired. |
| The same with an unknown type, `newJob` | Fires and closes the rental. `isPhase` is false, so the timeline draws nothing; grey. |
| A `closes` name no asset has | Event stream unchanged, nothing reported. |
| `fromJSON` and `copy()` given a field they do not name | The field is gone. |
| The list out of date order, `[Retire, Accumulate]`, with Retire alone listing "Salary → 50% Brokerage" | In the Accumulate years the salary paid the brokerage 24 times, $84,945. In date order, never. |
| A phase at 50 in a plan that starts at 58 | Never applied, and its `closes` never ran. |
| Mid Career begun in October 2026 (clock pinned to October) | Accumulate is dated January 2026: never applied, no trace root, in force from month 0 only as the list's first entry. |
| Retire and a second phase in the same month | Both applied; one record, naming the second. |
| Trigger months across the corpus | 16 life events in 47 fixtures, all in January. |
| Retire's `closes: ['Salary']` | Mid Career's last paycheck is December 2047; Dual Income's "Salary A" is paid through January 2048. Both are dated to finish in January 2048. |
| Mid Career's home sale and rent | Home dated to finish January 2036, sold February 2036; Rent starts January 2036. That January books the first rent and the home's property tax. |

Two more were checked in the app (§1.4): an inherited rule shown at 0%, and a
rename that deleted eight rules. And five of the eight shipped profiles carry a
Retire `closes: ['Salary']` that names no asset: the three couples ("Salary A",
"Salary B") and the two retired profiles, which have no salary.

## 2. Prior art

**ProjectionLab, Milestones** (v2.5.0, 2022-02-03): a milestone is a named life
stage, and "the start/end of anything in your plan" can be bound to one, so moving
the milestone moves everything bound to it. A milestone can be conditional, for
example "when liquid net worth reaches X times annual expenses", so in Monte Carlo
it lands in a different year in each trial, and a table reports when. v2.7.0
(2022-03-27) combined several criteria with logical operators.

**Boldin, "Future changes to primary residence"** (help articles updated
2026-06-25 and 2026-10-29): one relocation, dated by the primary user's age, with
the account for the proceeds or the down payment, the new home's price, a
mortgage, and the destination state, whose income tax applies from then on.
Capital gains on the sale are not computed. A second move needs a workaround
through "Future Real Estate Sales" and "Future Real Estate Purchases" at matching
ages, and the workaround can model at most one change of state.

What this spec takes from them:

- named chapters, shown on the timeline (both);
- a change dated by something the plan already contains: ProjectionLab binds plan
  items to a milestone, and here a phase is dated by an asset, the other direction,
  because assets carry the plan's dates (§4.1);
- any number of changes (Boldin's limit of one is the thing to avoid);
- a home change that names the account for the proceeds or the down payment
  (Boldin), which here is the home's close rule and its `fundingConfig`, both of
  which exist.

What it leaves: conditional milestones (§11), and building the new home from
fields on the change, as Boldin does, which the asset-ownership rule rules out
(§5).

## 3. The shape

### 3.1 One shape, kinds as templates

- A phase stays a `ModelLifeEvent`: a name, a date, and what changes. `apply()`
  treats every kind alike.
- The kind (`type`, unchanged in JSON) becomes a template in `LifeEventMeta`: its
  label and color, what it is dated by (§4.1), the assets it needs
  (`advisoryChecks`, read at last), and what its form proposes.
- `isPhase` is true for every kind. A kind the app does not know, from a plan made
  by a newer version, runs as it does today and is drawn as Other, never hidden.
  Every phase that runs is on the timeline.

### 3.2 Stage and chapter

- **The stage** is working or retired. Accumulate and Retire set it; a life change
  inherits the stage in force.
- `stageAt(month)` is the stage of the latest Accumulate or Retire that has begun.
  Each phase record stores it, so a reader of history never derives it from a
  type.
- Every reader that asks "retired?" moves from the type to the stage: Flows'
  warning, the Maximizer's cap, the asset list's order, the chart markers, and the
  timeline's rule for hiding Accumulate.
- Monte Carlo and Guardrails keep the Retirement Age setting (§1.2).

### 3.3 What a phase can change

| Lever | Today | Proposed |
|---|---|---|
| Closes | Asset names; a missing one skipped silently | Kept, for an asset whose own dates do not end it that month. A missing name is reported (§7). Retire's default is decision §13.10. |
| Transfers | Per asset, inherited | Unchanged in the engine. The editor shows what a phase inherits (§7, decision §13.9). |
| Fallback order | Spec 12 | On every phase, inherited until a phase makes its own (spec 12 §4.3). |
| Expenses | Assets with dates | Through assets only (decision §13.5). The phase form offers to set the dates of the expenses that change with it. |
| Settings | `globalOverrides`, inert | Deleted (decision §13.6). |

**Expenses.** A step on an existing expense ("Living Expenses less $800 a month
from the move") would be a second place an expense's amount lives, beside the
asset: the shape that left `globalOverrides` inert. It would also have to say what
the step grows from, since an expense grows at its own rate or at plan inflation
(`effectiveAnnualReturnRate`). Two assets with dates say the same thing with no
new field: Living Expenses ends with the sale, and "Living Expenses after the
move" starts with it. The phase form can offer those two date edits; editing dates
at the user's request is what `retirement-move.js` already does.

**Settings.** Which settings could a life change move?

| Setting | As a phase lever |
|---|---|
| Inflation | An economy assumption, not a life change. From retirement on, Monte Carlo resets every expense's growth from a sampled inflation rate each year (`applyRandomRates`), which would overwrite a phase's rate in the very years it covers. And three loops and the premium credit engine read the rate. |
| Filing status | The real life change: a marriage, a divorce, a death. But the tax table is built for one status per run (`new TaxTable(filingAs, …)`), and a status holds for a whole tax year. Its own spec. |
| Withholding on pensions and Social Security | An election, of little value as a lever. |
| Ages, backtest year, data mode, household tax allocation, the property-tax cap | The plan's identity or the law, never a phase's. |

No setting is ready to be a lever. Proposed: delete `globalOverrides`, which
closes #24 by removal. When filing status gets its spec, it adds a named field
with its own test. Deleting the field changes no run (measured, §1.8).

### 3.4 The kinds

| Kind | Dated by | Needs | Its form proposes |
|---|---|---|---|
| Accumulate (stage) | The start age | — | As today. |
| Retire (stage) | Retirement Age, in January | — | As today; its default close is decision §13.10. |
| New job | The new salary's first month | A working income that starts inside the plan | The new salary's split, copied from the old salary's rules; to end the old salary the month before. |
| Sell a home | The month the home closes, the month after its finish date | A real-estate asset with a finish date inside the plan, or the offer to set one | The home's close rule in this phase (where the proceeds go), and who now pays the bills the home's account paid. |
| Buy a home | The new home's first month | A real-estate asset that starts inside the plan (§5). A second home is not the primary home (`isPrimaryHome: false`). | Who pays the new home's costs and its mortgage. |
| Other | An age and a month, or any asset's start or close | — | Nothing. |

- **Downsizing** is a Sell a home and a Buy a home, often in the same month
  (§4.3).
- **What Other covers** among changes John did not name: children leaving home (an
  expense ends), a sabbatical (a gap between two salaries), a marriage (until
  filing status has a spec, only rules and the order change).
- **A new job also ends service with the old employer.** Spec 13 decides whether
  the penalty's exception for leaving a job at 55 or later is modeled. If it is,
  it reads the working income's end date, the date a New job is dated next to, so
  neither spec waits for the other.

## 4. Dating and order

### 4.1 Three ways to date a phase

| Way | Reads | Moves with the anchor | Month | Fits |
|---|---|---|---|---|
| Age (today) | "at 67" | Yes | January | Accumulate, Retire |
| Age and month | "at 55, in June" | Yes | Any | Other |
| An asset's start or close | "when the Home is sold" | No: the asset carries the date | Any | New job, Sell a home, Buy a home |

- **Proposed (decision §13.3):** a life change tied to an asset is dated by it. It
  can never disagree with the asset, it takes the asset's month, and when the user
  moves the sale, the phase moves with it. Retire keeps its age: the Retirement
  Age setting, Monte Carlo and Guardrails read it, and `retirement-move.js`
  already moves the income dated at it.
- **The two edges.** A start is the asset's first active month
  (`activeFromDateInt`, so Social Security is never before 62). A close is the
  month after its last active month, the month `closeAsset` runs by date.
- **A phase dated by a close is in force for the sale.** Life events run before
  `applyMonth`, so the phase begins on the first of the month and the home closes
  later that day, under the phase's rules: the home's close rule in that phase
  decides where the proceeds go.
- **One function resolves every date**, for the run and the editor alike, from the
  phases and the assets: for example `phaseSchedule(lifeEvents, assets, env)`.
  `triggerDateInt` stays for age-dated phases. The editor and the run must agree,
  as `tests/editing-anchor.mjs` checks for the anchor.
- **A phase whose asset is gone or undated** (deleted, or a home with no sale
  date) does not run, and What needs attention says so. It is never dropped
  silently.

### 4.2 Order

- **By date.** The engine sorts its own copy of the phases by resolved month and
  stops depending on the list's order. The starting phase is the one in force at
  the plan's first month, not the list's first entry.
- **Ties:** a stage phase first, then life changes in the order listed. A life
  change's rules then win over Retire's for an asset both list.
- **Every writer keeps the list sorted** as well (create, edit, import, the MCP),
  so the timeline's spans and the inheritance walk read what runs.

### 4.3 Two phases in one month

One record per month, naming every phase that began in it, with the stage. Flows'
pills and the reports list them all.

### 4.4 Before the plan starts

- A plan starts at the user's age today, so a job change at 45 can predate a plan
  begun at 50.
- **Proposed:** a phase dated before the plan's first month folds into the start.
  Its transfers and order apply before the run, in date order. Its closes do not
  run, because an asset still in the plan was not sold, and they are reported. It
  opens no trace root.
- **A phase dated in the first month still fires on its first day,** as today.
  That keeps the trace roots in the baselines ("1x Life event: Accumulate") where
  they are.
- **This is today's behavior for the first phase, extended.** Measured: a Mid
  Career plan begun in October 2026 dates Accumulate in January 2026, before its
  first month. Accumulate is never applied and opens no trace root; it is in force
  only because it is first in the list. The corpus pins its clock to January, so
  every first phase there fires in month 0, while in the app a plan begun in any
  other month never fires it.
- **It is reachable today:** raising Current Age on a loaded plan moves the birth
  year, and with it every age-dated phase, earlier.

### 4.5 Identity

- Today a phase is a name in some places and an index in others (§1.4).
- **Proposed (decision §13.7):** unique names, enforced by the form and refused by
  the reader with a reason, until the stableId migration. The indexes go: the
  selected phase, the Maximizer's genes and "Apply to Baseline" use the name.
- **The alternative is an id stored now.** It would have to be stored in the plan,
  never minted on load: a run handle is a hash of the spec, and an id invented on
  every load would change it (`tests/mcp-stateless.mjs`).

### 4.6 Moving and renaming

- **Moving an asset's date moves the phase dated by it**, with no extra step.
- **Retirement Age keeps `retirement-move.js`.**
- **One rename function** rewrites every by-name reference to an asset in the
  plan: `phaseTransfers` keys and targets, `closes`, the asset a phase is dated
  by, spec 12's order, `fundingConfig.sourceDisplayName`, and the targets of the
  assets' own rules. `calculate()` then prunes only what names a deleted asset.
  That stops a rename from deleting rules, a defect today (§1.4). The stableId
  migration stays the lasting fix.

## 5. The user's assets: buying a home

This is decision §13.4, and the spec does not settle it.

The rule, as spec 7 §4 states it: only the user creates or removes an asset. Life
events may close assets, rewire transfers and change behavior. A missing
instrument is met with the advisory pattern: check for it, prompt, and open the
create-asset form with the instrument chosen. The rule binds the run and anything
that writes the saved plan. Since 2026-08-31 it does not bind a build step that
emits a plan and runs nothing (`build_plan`, spec 10 §9.1).

A Sell a home or a New job needs an asset that usually exists already. A Buy a
home needs one that does not exist until someone creates it. The options:

- **A. The asset first.** The user creates the home (and its mortgage) with the
  forms that exist today, then adds a Buy a home phase and picks the home it is
  dated by. If the plan has no home starting inside it, the form says so and
  offers "Add a home…", which opens the asset form set to Real Estate
  (`advisoryChecks`, wired at last) and comes back to the phase.
- **B. One guided flow.** Choosing Buy a home opens the asset form set to Real
  Estate, then the funding modal, then the pre-filled mortgage form (the chain
  that exists today), then the phase form, dated by the new home. Each asset is
  created by the user's own Save, and Cancel at any step keeps what was saved and
  creates no phase. More convenient than A, under the same rule.
- **C. The phase carries the home and creates it when it fires.** Rejected by the
  rule: the failures it was written for (duplicate assets on recalculation,
  phantom assets that could not be deleted, state leaking into storage) all come
  from creating assets while running.
- **D. `build_plan` emits both.** As a build step it may add assets. It has no
  word for a home today, so this needs that vocabulary first, as a step of spec 10.

Whichever is chosen:

- Deleting a phase never deletes an asset, including one created alongside it.
- Deleting the asset a phase is dated by leaves the phase undated and reported
  (§4.1), never silently gone.
- The form for a second home sets `isPrimaryHome: false`, so the sale is not
  treated as a primary residence's.

## 6. The engine

### 6.1 The schedule (Phase 0)

`Portfolio.initializeChron` builds the run's schedule once, from the phases, the
assets and the anchor:

1. Resolve each phase's month (§4.1), and set aside, with a report, any phase that
   cannot be dated.
2. Sort by month, stage phases first within a month (§4.2).
3. Fold the phases dated before the first month into the start (§4.4).

`applyLifeEvents` then fires the schedule's entries in their months. Building it
in `initializeChron` gives it to all three loops (§1.2) without touching any of
them. `apply()` itself does not change.

### 6.2 The record

`phaseRules` gains the names of every phase that began in the month, the kinds,
and the stage. It keeps its rules snapshot. Flows and the reports read the list.

### 6.3 Recording

No new EventType. A phase's trace root already names it, and every event it
causes is in that chain, so `explain_month` can say "the Home closed because Sell
a home began". A new EventType would have to be declared in
`EVENT_RECONCILIATION`, `EXPENDITURE_TREATMENT` and `FLOW_TREATMENT` first, and
each of the three throws mid-run when one is missed.

## 7. Presentation surfaces, enumerated

Spec 8 (NIIT) found a sixth surface after its fix. The phase form and its
advisory come with Phase 1, the `closes` notice with Retire's default close, and
the rest with Phase 2:

- **The phase form:** the kind; a unique name; the date (an asset's start or
  close, picked from the plan's assets of the right instrument, or an age and a
  month for Other); closes; the transfers and, with spec 12, the order, each shown
  as inherited until the phase makes its own; Remove for a life change, while
  Accumulate and Retire stay structural.
- **The advisory:** a kind whose asset is missing offers it (§5).
- **The timeline (decision §13.8):** the two stage bands as today; each life change
  as a boundary and a chip inside them, its boundary dot where the asset's pin is
  (one mark, not two); chips in date order, "from Month Year"; a chapter's growth
  rate on hover. Every phase that runs is drawn.
- **The transfer editor (decision §13.9):** inherited rules shown and marked "from
  Accumulate"; saving writes into the selected phase; a reset returns to
  inheriting. Both entry points behave the same.
- **Flows:** every phase that began in the window; the stage, not the type, for the
  retirement-savings warning.
- **Month & Year Details:** the phase in force; in a month a phase begins, what it
  changed (assets closed, rules changed, the order changed), read from consecutive
  records, never from present state.
- **Reports:** a yearly report names the phases that began in its year.
- **Projections, Monte Carlo and Guardrails charts:** a marker for every phase,
  with the stage changes drawn strongest.
- **The "Viewing" badge:** the phase at the cursor's month, not its age.
- **The asset list:** group order from the stage at the cursor, not the first
  phase.
- **What needs attention:** a phase whose asset is missing or undated; a `closes`
  name that matches no asset; a close skipped because its phase predates the plan.
- **The Maximizer:** genes by phase name; the cap by stage.
- **MCP:** `run_plan`'s report lists the phases and their months; `explain_month`
  names the phase in force and any that began; `diff_plans` lists phases added,
  removed and changed, by name and field; `build_plan` comes later (§5, D).
- **The ⚡ timeline summary.**
- **Help, Rules, Globals:** every phase sentence in §1.5: two phases in green and
  coral, "Salary closes automatically", "Accumulate and Retire can route money
  differently", "Phase-Aware Optimization", and Globals' Retirement Age sentence.
  They change in the same PR as the behavior they describe, because no test reads
  their prose (PR #97).

## 8. How it travels

- **No new key.** Phases already travel inside `lifeEvents`, in scenarios, share
  links and plan specs, and spec 12's order rides inside them the same way, to
  the workers too (its §4.7).
- **One reader** for scenario load, share-link import and the MCP, as
  `planSettingsFrom` is for settings, and the one spec 12 §4.7 asks for its order
  too: it sorts the phases, refuses duplicate names
  with a reason the import dialog can show, keeps an unknown kind (drawn as
  Other), and leaves a missing asset to be reported rather than dropping the
  phase.
- **Every path carries every field:** `toJSON`, `fromJSON`, `copy()`, the form's
  submit, "Apply to Baseline", the worker payloads, share links and scenario
  storage. One round-trip test covers them all (§10).
- **The plugin** gets a version bump in every PR that changes the bundle.

## 9. Traps this codebase has already hit

- **Stored but never applied.** `globalOverrides` (code-issue #24) is saved,
  carried through the form, and inert, measured. Three more `LifeEventMeta` fields
  and two classifiers have no effect (§1.1). Every lever ships with a test that changing it changes
  the run from its phase's month on, and not a month before.
- **`fromJSON` drops what it does not name, and so does the form.** Measured for
  `fromJSON` and `copy()`; found by reading for the form's `_onSubmit` and "Apply
  to Baseline". Workers see only `toJSON`. Spec 12 §4.3 already warned that its
  order must be added to `toJSON` and `fromJSON`; the form is a third place.
- **Present state read as history.** The transfer editor shows a phase's own list
  as if it were the rules in force (verified in the app). The asset list orders
  its groups by the first phase, whatever the cursor. Flows called a salaried
  month retired because of a type (measured). Read the record, `phaseRulesAt`,
  with the stage in it.
- **Blessing without a prediction.** Each PR writes its expected drift first
  (§12), runs `node tests/tools/snapshot.mjs`, reads `git diff tests/baselines/`,
  and only then blesses. `--bless --only` leaves `_coverage.snap` stale, so finish
  with an unfiltered `--bless`. The baselines record trace roots, so a fold that
  stopped the first phase from firing would show; that is why §4.4 folds only
  phases dated before the first month.
- **The list's order is load-bearing.** $84,945 moved by a rule from the wrong
  phase (measured). Create sorts, edit does not, and the MCP and share links take
  any order.
- **One record per month.** A second phase in a month replaces the first one's
  record (measured).
- **A phase before the plan never fires unless it is first** (measured), and
  raising Current Age can make one.
- **Names are identity, and a rename deletes rules** (verified in the app). A
  `closes` name that matches nothing is skipped silently (measured), and five of
  eight shipped profiles carry one.
- **A phase and an asset can both own one date,** and disagree by a month (Retire
  and the salary, measured; Rent and the home it replaces, §1.7). A phase dated by
  an asset's edge has one source for its date.
- **A type is not a stage** (Flows, the Maximizer, the asset list, the chart
  markers).
- **Three loops.** Anything a phase changes must reach `chronometer_run`,
  `runOnce` and `computeBaseline`. The schedule is built in `initializeChron` for
  that reason (§6.1). A per-phase setting would need all three plus the premium
  credit engine, which is part of why §3.3 defers settings.
- **A getter that throws, at every binding site.** `triggerDateInt` throws when
  unbound, and the app crashed on every Quick Start click when one reader was
  missed (PR #47, fixed in #48). Every reader of a phase's date goes through the
  schedule function, and the editor-versus-run test covers each.
- **An undeclared EventType throws mid-run,** in three tables. Phases add none
  (§6.3).
- **A fixture that does not reach a branch looks like a correct engine.** No
  fixture today has a third phase, two phases in a month, a phase before the
  plan, or a phase dated by an asset. And the corpus pins its clock to January,
  so it never shows the app's common case, a first phase dated before the plan's
  first month (§4.4). §10 adds each before the code that handles it.
- **Static pages change with the behavior** they describe (PR #97).

## 10. Fixtures and tests

New fixtures:

- `phases-out-of-order`: Retire listed before Accumulate, with a rule only Retire
  lists. Today it leaks into the Accumulate years (§1.8); after Phase 0 the run
  equals the sorted plan's.
- `phases-same-month`: Retire and a life change in one January. Both are in the
  record, the stage is retired, and the life change's rule wins for an asset both
  list.
- `phase-before-plan-start`: a life change dated two years before the first month.
  Its transfers are in force from month 0; its closes do not run and are reported;
  it opens no trace root.
- `new-job-mid-year`: the old salary ends in June, the new one starts in July with
  a different split, and the phase is dated July. Neither split ever pays from the
  other salary.
- `home-sold-by-a-phase`: a Sell a home dated by the home's close. Its close rule
  sends the proceeds to a different account than the phase before; Living
  Expenses are paid from that account afterwards; the sale's tax is booked as the
  asset books it today.
- `home-bought-by-a-phase`: a future home with a down payment and a mortgage, both
  created as the user would, and a Buy a home dated by the home. The payer of the
  carrying costs changes in that month and not before.
- `phase-dated-by-missing-asset`: dated by an asset the plan does not have. It
  does not run, and it is reported.
- With decision §13.10, `retire-closes-by-role`: a couple's two salaries closed by
  Retire.
- **Natural witnesses,** as `--set`-style variants never blessed into the existing
  baselines: Mid Career with a Sell a home at its sale (age 55) that moves Living
  Expenses to the account the proceeds went to, and Early Career likewise at 60.
- **Silence:** every existing fixture unchanged by Phase 0.

The first three come with Phase 0, before the new kinds exist, so their extra
phase is a third event of today's types; Phase 1 rewrites them with the kinds.

Tests:

- **Order independence:** shuffle the phases; the event stream hashes the same,
  across the corpus and the new fixtures.
- **Each lever** (closes, transfers, and spec 12's order): changing it in one phase
  changes the run from that phase's month, and not a month before.
- **Round trip:** every field through `toJSON` and `fromJSON`, `copy()`, the form's
  submit, "Apply to Baseline", a worker payload, a share link
  (`tests/share-link.mjs`), a scenario save and load (`tests/scenario-store.mjs`)
  and `run_plan`. A field added to `ModelLifeEvent` and missing from any one of
  these fails.
- **Dating:** `tests/life-event-dating.mjs` grows to phases dated by an asset: every
  event a phase records carries the month it began. The editor and the run agree on
  every phase's month, as `tests/editing-anchor.mjs` checks for the anchor.
- **Stage:** `stageAt`, and each reader moved to it: Flows' warning in a salaried
  month after a life change, and the Maximizer's cap.
- **Rename:** rename an asset named by a rule, a close, a dated-by and an order
  entry. Nothing is deleted, and every reference reads the new name.
- **Mutations it must catch:** sort by name instead of date; run a folded phase's
  closes; keep only the last phase's name in a month's record; read the stage from
  the type; date a close in the finish month instead of the month after; drop a
  field in the form's submit; let the rename prune; mint an id on load.

## 11. Not in scope

- **Conditional phases** ("when net worth reaches X"), ProjectionLab's conditional
  milestones. A phase's month would differ in each Monte Carlo trial.
- **Filing status as a lever:** its own spec (§3.3). Spec 5 (Married Filing
  Jointly) is household-level for the whole plan.
- **State income tax on a move.** No state tax is modeled.
- **`build_plan`'s words for life changes:** a step of spec 10, after it can build
  a home (§5, D).
- **A step on an expense's amount** (decision §13.5).
- **Creating assets from a phase** (§5).
- **Retire by month.** The Retirement Age setting, Monte Carlo and Guardrails read
  an age.
- **The early-withdrawal penalty** and its exception at 55: spec 13 (§3.4).
- **The stableId migration.** The rename function of §4.6 is the interim.
- **What-if over phases:** spec 7's `adjust_plan` can add `move_phase` later.

## 12. Phases and cost

| Phase | Delivers | PRs | Effort |
|---|---|---|---|
| **0. The schedule** | §6.1 and §6.2: phases dated by one function, sorted, folded before the start; every phase of a month in its record, with the stage; `stageAt`. Then the rename function (§4.6). No new kind or field. | 2: the schedule, then the rename | about 2–3 days |
| **Retire's default close** | Decision §13.10, and the notice for a `closes` name that matches no asset | 1 | about 1 day |
| **1. Kinds and dating** | §3 and §4: New job, Sell a home, Buy a home and Other; dating by an asset's edge or an age and month; `advisoryChecks` wired; unique names; `globalOverrides` deleted; the reader (§8); the form | 1–2 | about 3–5 days |
| **2. Showing them** | §7: the timeline, the transfer editor, Flows, Month & Year Details, reports, charts, the asset list, What needs attention, the MCP report and diff, Help, Rules and Globals | 2: engine-facing readers, then the views and pages | about 4–6 days |
| **Later** | `build_plan`'s vocabulary (spec 10); filing status as a lever (its own spec) | — | their specs' |

Spec 12's Phase 2 installs its order when a phase begins, so it relies on phases
beginning in date order: Phase 0 first. Its editor goes into Phase 1's form.

Predictions, written before any change:

- **Phase 0: the corpus is byte-identical, trace roots included.** Its 16 life
  events are listed in date order, one per month, and each plan's first phase is
  dated in its first month, so it still fires there. No fixture renames an asset.
- **Phase 0's new fixtures move:** `phases-out-of-order` loses its $84,945 leak,
  `phases-same-month` names two phases in one record, and
  `phase-before-plan-start` has its rules in force from month 0.
- **Phase 1: byte-identical** for any plan without a new kind. Deleting
  `globalOverrides` changes no run (§1.8).
- **Retire's default close:** with option A of §13.10, the three couple profiles
  each lose both salaries' January pay in their retirement year; with option B,
  the three single working profiles each gain it; with option C, nothing moves.

Phase 0 is worth shipping alone. It makes the engine read phases by date, which
the MCP and share links can break today, records what Flows shows, and gives
spec 12 the phase boundaries its order needs.

## 13. Decisions for John

1. **The kinds.** Proposed: New job, Sell a home, Buy a home (a second home
   included) and Other, each a template over one shape (§3.1, §3.4).
   Alternative: kinds with behavior of their own in the engine.
2. **Retired is a stage.** Proposed: only Accumulate and Retire decide whether the
   household is retired, and every reader that asks reads the stage (§3.2).
   Alternative: each kind declares a stage of its own.
3. **Dating.** Proposed: a life change tied to an asset is dated by that asset's
   start or close; Other may take an age and a month instead; Accumulate and
   Retire stay as they are (§4.1). Alternative: every phase by age and month.
4. **Buying a home: who creates the assets.** Not settled here (§5). A: the asset
   first, with the form offering to add it. B: one guided flow through the
   existing forms, each asset saved by the user. C is rejected by the
   asset-ownership rule. D: `build_plan` may emit both, once it can build a home.
   Which of A and B, and is D wanted?
5. **Expenses.** Proposed: through assets only; the phase form offers the date
   edits (§3.3). Alternative: a phase-level step on an existing expense.
6. **Settings.** Proposed: delete `globalOverrides`, closing #24; filing status,
   the setting a life change really moves, gets its own spec and a named field
   (§3.3). Alternative: a closed list of settings now.
7. **Identity.** Proposed: unique phase names, enforced and refused, until the
   stableId migration; no more indexes (§4.5). Alternative: a stored id now.
8. **The timeline.** Proposed: the two stage bands stay, and each life change is a
   boundary and a chip, with its growth rate on hover (§7). Alternative: a band
   and a rate for every phase.
9. **Editing an inherited rule.** Proposed: show it, marked as inherited; saving
   writes it into the selected phase; a reset returns to inheriting (§7).
   Alternative: edit it where it was set, as Flows does today.
10. **Retire's default close.** Today Retire closes the asset named "Salary". In
    three profiles that stops pay a month before the salary's own date; in five
    the name matches nothing (§1.3, §1.8). A: close every working income still
    paying, chosen when the phase is created, so the couples' pay stops in
    December too. B: close nothing by default and let each salary's date end it,
    so the single profiles are paid through January, with the Retire form
    flagging any working income still paying after it. C: leave the default.
    Under all three, a name that matches nothing is reported, so saved plans show
    it. Proposed: A, which keeps "Salary closes automatically" true for every
    plan.
11. **Phase 0 first, alone.** Proposed: yes, predicted byte-identical (§12).

Taken as given rather than asked, and open to reopening:

- Phases dated before the plan's first month fold into the start, without their
  closes (§4.4).
- In one month, stage phases apply first, then life changes in list order, and
  the record names them all (§4.2, §4.3).
- Every phase that runs is drawn, an unknown kind as Other (§3.1).
- No phase creates or deletes an asset (§5).

## Sources

- [ProjectionLab: Do More with Milestones](https://projectionlab.com/blog/milestones)
  (v2.5.0, 2022-02-03): milestones, binding the start and end of plan items to
  one, conditional milestones in Monte Carlo.
- [ProjectionLab: Fine-Tune Your Plans](https://projectionlab.com/blog/fine-tune-your-plans)
  (v2.7.0, 2022-03-27): several criteria per milestone, with logical operators.
- [Boldin: Selling your primary residence and purchasing a new residence](https://help.boldin.com/en/articles/4315667-selling-your-primary-residence-and-purchasing-a-new-residence)
  (updated 2026-06-25): the relocation's inputs; capital gains on the sale not
  computed.
- [Boldin: Multiple relocations](https://help.boldin.com/en/articles/5647869-article-multiple-relocations)
  (updated 2026-10-29): one change to the primary residence; the workaround and
  its limit of one change of state.
- Measurements in §1 and §4.4: read-only probes that build fixtures from
  `tests/tools/fixtures.mjs` (and one quick-start profile with the clock pinned
  to October), run them with `chronometer_run` under a pinned clock, and hash each
  event stream (asset, type, date, amount), on main 21603db, 2026-10-29. The app
  checks in §1.4 ran on the dev server on the same commit, in the in-app
  browser's own storage, which was cleared afterwards. The probes are kept outside
  the repo, in this group of sessions' notes folder (`spec-14-probes/`).
