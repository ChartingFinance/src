# Spec 10 — Conversational plan construction: `build_plan`

**Status: specification only. No code.**

PRs #33 and #34 gave the MCP surface *what happened* and *why*. Spec 7 designs
*what if*. All three assume a plan already exists. This is the design for the
step before them: turning a sentence into a plan the engine can run.

---

## 1. The scenario this exists for

> A user asks: *"I make $100K a year. If I save 10%, how much will I have in
> 10 years?"* The plugin builds a salary, an account, and a savings split, runs
> ten years of accumulation, and shows the result. The user then says *"what
> about 5% to a brokerage and 5% to savings?"* — and the plan changes and re-runs.

Everything in this spec follows from taking that exchange literally.

Three verbs fall out of it, and they are the whole surface:

| verb | what it does |
| :--- | :--- |
| **describe** | a sentence becomes a new plan spec |
| **show** | an existing plan spec becomes a sentence |
| **modify** | a sentence changes an existing plan spec |

`run_plan` is downstream of all three.

---

## 2. `build_plan` is a gate, not a helper

The engine's documented failure mode is **numbers, never errors**. Every defect
this project has found in the MCP layer had that shape: ages that moved no date,
life events dropped on the floor, a filing status never set. Each produced a
clean report of a plan nobody asked for.

A conversational surface makes that worse in two ways. The user supplies less
information than any UI would demand, and an agent renders whatever it receives
as prose — which is to say, as advice.

So `build_plan` is not a convenience wrapper over `run_plan`. It is the gate
that stands in front of it, and **its most valuable output is a refusal or a
question.** It is the only component in this system positioned to say *"that
sentence does not determine a plan"* — the engine cannot, because by the time
the engine sees a spec, every ambiguity has already been resolved into a number.

That framing is why this is likely to grow into its own engine over time:
it has state (the plan under construction), a closed vocabulary of operations,
a validation pass, and a set of rules that can fail. Where `runPlan` is a
runtime, `build_plan` is a **compiler** — and compilers report errors.

Design consequence, applied throughout this spec: whenever `build_plan` must
choose between guessing and asking, the tie goes to asking; and whenever it
guesses anyway, the guess is recorded (§6).

**What the gate restrains is ambiguity, not capability.** `build_plan` holds
full rights to add, edit and remove assets — that is §9.1, and it is the point
of having a build step at all. It refuses unclear *sentences*, never its own
powers. And what it emits is a draft meant to be corrected, possibly by a
professional the user shares it with (§9.3), which is why every value it
supplies stays labelled as its own.

---

## 3. Measured, not argued: transfers are a property of the phase

The scenario says "1 fund transfer." The plan spec has no such thing.

`planFromProfile('midCareer')` was probed on 2026-08-31. Every asset in the
emitted spec:

```
Salary  ft:0   Social Security  ft:0   401K  ft:0   Roth IRA  ft:0
Brokerage  ft:0   Home  ft:0   Mortgage  ft:0   Rent  ft:0   Living Expenses  ft:0
```

`ModelAsset.toJSON()` (`model-asset.js:1095`) destructures `fundTransfers` out
of the payload. The transfers live on the **life event**:

```json
{"type":"accumulate","triggerAge":45,
 "phaseTransfers":{"Salary":[{"toDisplayName":"401K","monthlyMoveValue":5},
                             {"toDisplayName":"Roth IRA","monthlyMoveValue":2},
                             {"toDisplayName":"Brokerage","monthlyMoveValue":93}]}}
```

The run that produced those assets fired **6,928 transfer events**, all of them
sourced from `phaseTransfers`.

**Therefore:** the scenario's three objects are two assets plus a life event.
A `build_plan` that emits a salary, a bank and an asset-level transfer produces
a salary that earns, a bank that never receives, and a confident `$0`.

### 3.1 The dead path that makes this worse

`ModelAsset.fromJSON` (`model-asset.js:226`) **does** read `obj.fundTransfers`,
and `fromHTML` (`:249`) reads a `data-fundtransfers` attribute. So asset-level
transfers are live-looking code on the read side with no writer: `share-modal.js:65`
maps `a.toJSON()`, which strips them.

This is harmless today only because quick-start routes everything through
phases. It is a trap for whoever implements this spec, who will read `fromJSON`,
conclude asset-level transfers are supported, and be right for exactly as long
as their test uses a hand-authored fixture. See §11.3.

---

## 4. The intent vocabulary

`run_plan`'s asset schema is `z.array(z.record(z.string(), z.any()))`. That is
correct for its job — passing through a portfolio the app exported — and wrong
for this one. It gives the caller no guidance on `startDateInt` encoding, on
whether `startCurrency` is a number or a `Currency`, on `annualReturnRate` being
an `ARR`. Every wrong guess is silent.

Worse, authoring assets by hand means re-deriving construction that
`quick-start.js` already owns. That is the mistake `run-plan.js`'s own header
was written about:

> That is what a second client of the engine costs when it reimplements setup.

**So `build_plan` takes intent, and owns construction.** The caller supplies
meaning; the server supplies `Instrument` keys, dates, rates and phases.

```
build_plan({
  horizonYears: 10,                       // OR finishAge
  income:   [{ label: "Salary", annual: 100000, kind?: "working" | "pension" | "socialSecurity" }],
  accounts: [{ label: "Savings", kind?: InstrumentKey, startingBalance?: number }],
  savingsSplit: [{ from: "Salary", to: "Savings", percent: 10 }],
  expenses?: [{ label, monthly | annual }],
  settingsOverrides?: { startAge, retirementAge, finishAge, inflationRate, filingAs },
})
```

Like Spec 7's adjustments, this is a **typed closed vocabulary, never a JSON
patch**, and for the same three reasons: it must be expressible in the app,
nameable in one phrase, and reversible.

It returns a *plan spec* — the same `{name, settings, modelAssets, lifeEvents,
guardrailParams}` shape everything else already speaks — plus the assumption
ledger (§6). It does not run anything. `run_plan` remains the only run path.

---

## 5. Construction rules

These are the rules that turn intent into a spec. Each one is a place the naive
implementation is silently wrong.

### 5.1 The horizon is a finish age, and the default plan is 37 years

`SIM_CONFIG_DEFAULTS` (`sim-config.js:62`) is `startAge: 50, retirementAge: 67,
finishAge: 87`. "How much in 10 years" against those defaults simulates a
50-year-old to 87 — **a 37-year run, not a 10-year one.**

`horizonYears: N` must derive `finishAge = startAge + N`, and the derivation
must be declared, because it silently pins the user's age at 50.

Note what luck is doing here: from age 50, ten years lands at 60, so retirement
at 67 never fires and accumulation holds throughout. The same question from a
60-year-old crosses the boundary and quietly becomes a different plan with a
drawdown in it. §7's preamble is what makes that visible before it happens.

### 5.2 The accumulate phase triggers at `startAge`

Not at a default, not at 45. Every profile in `quick-start.js` does exactly
this — `ModelLifeEvent.createDefault(LifeEvent.ACCUMULATE, ages.startAge)` at
lines 91, 158, 217, 344, 428, 498 — and a phase whose `triggerAge` postdates the
plan's start transfers nothing while producing a complete, plausible report.

`LifeEvent` has exactly two members: `ACCUMULATE` and `RETIRE`. A plan whose
horizon ends before `retirementAge` emits one life event, not two.

### 5.3 Income is a flow, and every dollar of it must be routed

Quick-start's accumulate splits Salary 5 / 2 / 93. **It sums to 100.**

"Save 10%" names one leg of a two-leg split. Per the decision of 2026-08-31, the
residual routes to a **Living Expenses** asset (`Instrument.MONTHLY_EXPENSE`)
created by `build_plan`:

```
Salary → Savings          10%
Salary → Living Expenses  90%
```

This makes the plan a complete flow and the net worth figure real. It also
invents a spending assumption the user never stated, so it is a first-class
entry in the assumption ledger and must appear in the reply — not as a footnote.

**It is the canonical `structural` asset of §9.2**: one created by a
construction rule rather than by anything the user said. `build_plan` is
entitled to create it (§9.1) and obliged to say that it did. The rule that makes
the number honest is the same rule that puts an asset in the plan nobody asked
for — which is exactly why provenance has to travel with it (§9.3).

The answer changes shape as a result, and that is the point. Not *"you'll have
$X"* but *"$X, with the other 90% spent and inflating at 3.1%."*

**Validation:** splits from a single source must total 100. `stochasticLimit`
(`model-asset.js:948`) scales down only when the total exceeds 100, and says
nothing; under 100 nothing checks at all. `build_plan` refuses both.

### 5.4 Percentages are of the source, not of each other

The turn-two split — 5% brokerage, 5% savings — is still 10% saved. A user who
believes they doubled their saving rate has misread the plan, and the reply
must not encourage it. See §10.

---

## 6. The assumption ledger

**Every field in the emitted spec carries a provenance, and the report renders
all of them.**

```
type Provenance = 'stated' | 'inferred' | 'derived' | 'default'
```

- `stated` — the user said it. *"$100K", "10%"*
- `inferred` — resolved from wording. *"brokerage" → `taxableEquity`*
- `derived` — computed from something stated. *`finishAge = startAge + 10`*
- `default` — taken from `SIM_CONFIG_DEFAULTS` untouched. *`startAge: 50`*

This is the same shape as `EVENT_RECONCILIATION` and `ShortfallOrigin`: a field
with no declared provenance is a **build error**, not a blank. The failure mode
being defended against is documented and specific — an agent handed a number and
a footnote reports the number.

The ledger is machine-readable so the reply cannot quietly omit it, and it is
what makes the modify loop honest: when the user corrects an assumption, both
sides know which of the plan's values were never theirs to begin with.

The ledger carries a second entry kind alongside field provenance:
**structural changes** — assets created or removed. These have their own small
vocabulary (`stated` | `implied` | `structural`, §9.2), deliberately not merged
with `Provenance`, because a field and an asset are not the same kind of thing
and only one of them is the user's to own.

Both kinds exist to be read, not to gate anything — and both must survive export,
because a professional tuning this plan needs to know which numbers came from
the client and which the tool supplied (§9.3).

---

## 7. Turn 0: the settings preamble

Per the decision of 2026-08-31, the first interaction **states the defaults and
invites changes** before anything runs.

| | default | how to say it |
| :--- | :--- | :--- |
| `startAge` | 50 | how old you are now |
| `retirementAge` | 67 | when work income stops |
| `finishAge` | 87 | how far out to project |
| `inflationRate` | 3.1% | |
| `filingAs` | Single | |

A `plan_defaults` tool returning these with that gloss is the smallest possible
addition and the highest-leverage one: it converts the largest class of silent
wrongness (a plan about a person the user is not) into a visible sentence.

It runs once per conversation, not once per plan.

---

## 8. Account types are inferred, then offered by category

`InstrumentMeta` (`instruments/instrument.js:33`) is already the vocabulary:

| said | `Instrument` | label |
| :--- | :--- | :--- |
| brokerage, taxable, after-tax | `TAXABLE_EQUITY` | Taxable Account |
| savings, bank, cash account | `BANK` | Savings |
| 401k | `FOUR_01K` | 401K |
| IRA, traditional IRA | `IRA` | IRA |
| Roth | `ROTH_IRA` | Roth IRA |
| pension | `PENSION` | Pension |

When wording does not determine one, `build_plan` does **not** pick. It offers
by category, which the classification sets already provide —
`isTaxDeferred` / `isTaxFree` / `isTaxableAccount` / `isSavingsAccount`, and
`InstrumentType.all()` for a sorted list:

> *Retirement (401K, IRA, Roth IRA) or capital (Taxable Account, Savings)?*

### 8.1 "Savings" is ambiguous and the scenario proves it

From the scenario itself: *"splitting savings by 5% to brokerage and 5% to
savings."* The first is the act of saving; the second is the `BANK` instrument
whose label is literally **Savings**.

Resolve by position where it is unambiguous, ask where it is not. Do not route
10% into a single account and report a tidy number. This case is a required
fixture.

---

## 9. Modify is a patch on the spec — never a rebuild from the description

`show` lifts a plan spec into intent. That lift is **lossy by construction**: an
arbitrary portfolio exported from the app contains structure the vocabulary
cannot express — mortgages, property tax, per-asset basis, guardrail params.

The trap: if `modify` works by describing a plan, editing the description, and
rebuilding, then **everything the vocabulary could not express is silently
deleted**, and the resulting report looks fine.

**Therefore:** `modify` applies a typed patch to the stored plan spec. The
description is a view. Lossy lifting must never become lossy lowering.

`show` marks what it could not express — *"this plan also contains a mortgage
and a home, which I can show but not change here"* — so the user is never
surprised by what modification does or does not reach.

### 9.1 Build mutates; run does not

Per Spec 7 §5, an adjustment returns a **new handle** with the parent intact;
plans form a lineage. That applies here unchanged.

Spec 7 §4 — *adjustments never create or delete assets* — does not.

The rule it inherits from, `feedback_user_owns_assets`, is on its own terms a
**run-step rule**. Its stated rationale:

> Automatic asset creation *during simulation* … caused duplicate assets on
> recalculation, phantom assets that couldn't be deleted, and state leaking into
> localStorage.

Duplicates on recalculation, phantoms, persistence leaks: every failure it names
is an artifact of mutating an asset list *while or after simulating*. None of
them is reachable by a step that produces a spec and runs nothing.

So the boundary is not who owns the assets. It is **which step is allowed to
move**:

| step | rights | why |
| :--- | :--- | :--- |
| **build** | add, edit, remove assets and transfers | construction is the entire job; a builder that cannot add an account is not a builder |
| **run** | none — the spec is frozen | a scenario that mutates its own inputs cannot be reproduced or compared |

`run_plan` treating the spec as immutable is not politeness. It is the
reproducibility requirement of §11.1 restated as a rights boundary — and the P0
bug is exactly a run step reaching outside its frozen input, for the clock
rather than the asset list, but the same violation.

**`build_plan` therefore has explicit and unrestricted rights to add, edit and
remove assets and fund transfers. That capability is the feature.** Helping
someone assemble a plan they could not have specified up front is what this
surface is *for*; a build step hedged about with permissions would be a worse
tool that produced the same numbers.

One condition survives from the original rule, and it is binding:

> **Nothing built here writes back to the user's saved portfolio.** A plan
> created in conversation lives in the conversation until the user explicitly
> exports it. Import into the app is a user action, always.

That is what keeps `feedback_user_owns_assets` intact where it does apply: the
app's advisory surface, which still advises and never mutates.

### 9.2 Provenance travels with the plan

Granting build full rights removes the permission gate. It does **not** remove
the ledger of §6 — it changes the ledger's job. It stops being a request to
proceed and becomes **metadata carried by the plan**, recording for each asset
whether the user stated it, implied it by naming it, or a construction rule
produced it:

| origin | example |
| :--- | :--- |
| `stated` | *"add a brokerage account"* |
| `implied` | *"5% to a brokerage"* — the account is named in the request itself |
| `structural` | a Living Expenses asset appears because §5.3 must route the residual |

The disclosure shrinks to match. Not a rule restated at every creation — that
version bought rigor at the price of burying the answer in ceremony — but one
plain statement of what was built and what was assumed, where the plan is shown:

> *Living Expenses — $90,000/yr — added to absorb the 90% you aren't saving.
> You never mentioned spending.*

Structural additions say what they are. That is the whole obligation.

Enforcement is unchanged in shape: an asset carrying no origin is a build error,
because an unattributed asset is indistinguishable from one the user supplied.

### 9.3 The plan is a draft, and a professional may read it

A plan built here is shareable — the spec format *is* the share payload — and a
likely destination is someone qualified to tune it.

That raises the value of §9.2 rather than lowering it. **An adviser needs to
know which figures came from their client and which the tool invented.** A
$90,000/yr living-expense line nobody ever stated is precisely the sort of
number a professional would otherwise take as reported fact and build on.

It also settles what the output *is*: not an answer to be trusted, but a **draft
to be corrected** — by the user this turn, or by someone with credentials later.
Drafts are meant to be provisional and mutable, which is where §9.1 arrives from
the other direction.

Consequence for the payload: **provenance must survive export.** A plan whose
ledger is dropped at the share boundary arrives as unattributed assertion, and
the professional inherits the tool's guesses as the client's facts.

### 9.4 Silent deletion is still a bug — correctness, not permission

`build_plan` may remove an asset when asked. What it may never do is remove one
when *nobody asked*, and that failure has nothing to do with rights. Four places
it hides, none of which mention assets in the user's request:

1. **A split that drops to zero.** *"Actually put it all in the brokerage."*
   The savings account keeps a 0% share; it is **not deleted**. Zero is a share,
   not an absence — and a user who re-splits next turn expects it to still exist.
2. **A rename.** `displayName` is the foreign key: `phaseTransfers` addresses
   targets by `toDisplayName`. Renaming an account orphans every transfer
   pointing at it, which is deletion in effect with none of the appearance.
   This is the latent bug the stableId migration exists to fix; until it lands,
   `modify` must not rename.
3. **The lossy-lowering trap of §9.** The most dangerous of the four, because
   the request that triggers it is about something else entirely.
4. **A shortened horizon** that ends the plan before a later asset begins. The
   asset survives in the spec and vanishes from every result.

Cases 2 and 3 are why §9's "patch, never rebuild" is a hard constraint rather
than an implementation preference: both are deletions that a rebuild performs
silently and a patch structurally cannot. Case 1 is a modelling rule — zero is a
share, not an absence.

---

## 10. No delta without its bias, stated inline

Inherited from Spec 7 §6 and non-negotiable here, because a chat surface is
where footnotes go to die.

Every comparison names the modelling gaps biasing *that* comparison, in the same
breath as the number:

- **`rate/12` compounding** — a stated 8.5% realizes 8.839%. Any comparison of
  two return rates within ~0.5% of each other is noise.
- **No early-withdrawal penalty** — every "retire earlier" answer is optimistic,
  and the error grows the earlier the retirement.
- **Flat 85% Social Security** — biases anything that shifts the benefit ratio.

Caveats are declared per adjustment type and **fail loudly when undeclared**,
same shape as `EVENT_RECONCILIATION` throwing on an unmapped event type. An
adjustment with no caveat entry is a build error.

For the scenario's turn two specifically: 5+5 and 10 differ by roughly nothing in
ending balance. The honest headline is the **tax treatment difference**, not the
delta.

---

## 11. Preconditions

### 11.1 P0 — the date anchoring bug, now load-bearing

Spec 7 §2 measured it: one frozen spec replayed under different wall clocks
produced 12,282 / 12,508 / 12,921 events and a 13.7% swing in ending net worth
from nothing but the calendar.

A conversational plan supplies **no age and no start date**, so it is maximally
exposed. This is a prerequisite, not a follow-up.

Spec 7 named three leak sites (`globals.js:598`, `:605`, `life-event.js:100`).
Those citations are **stale as of 2026-08-31** — they have since been
consolidated into `plan-dates.js`, which is good news: the engine-side leak is
now a single expression.

```js
// plan-dates.js:29 — feeds finishDateIntFor() and ageToDateIntFor()
export function birthYearFor(env) {
    return new Date().getFullYear() - env.startAge;
}

// quick-start.js:23 — a second copy, in the builder this spec would inherit
const birthYear = currentYear - startAge;
```

Two expressions, not three, and the second is the one `build_plan` would
otherwise copy. Both must anchor from the plan, per `portfolio.js:195`.
(`finplan-app.js:858`, `finplan-timeline.js:129` and `globals.js:330/337` hold
the same expression but are UI and settings-store code, outside the engine.)

### 11.2 `MAX_CACHED_RUNS = 4` is too small

Already flagged in Spec 7 §5.0. A three-turn conversation is a lineage, and
evicting an ancestor breaks the comparison depending on it. Eviction must become
ancestor-aware before the modify loop ships.

### 11.3 Close the asset-level transfer path

Either make `toJSON` emit `fundTransfers` (and confirm nothing downstream
double-applies them against `phaseTransfers`), or delete the read side and let
`fromJSON` throw on an asset carrying them. Live-looking code with no writer is
how the next person loses a day. §3.1.

---

## 12. Sequencing

| step | ships | verified by |
| :--- | :--- | :--- |
| 0 | P0 date anchoring (§11.1) | replay across a year boundary, compare **event streams** |
| 1 | `plan_defaults` (§7) | trivial; a snapshot of the gloss |
| 2 | `build_plan` describe-only, income + accounts + split (§4, §5) | the scenario's turn one, end to end |
| 3 | assumption ledger (§6) + structural declarations (§9.2) | a field with no provenance fails the build; a `structural` asset that reaches the reply undeclared fails the build |
| 4 | `show` (§9) | round-trip a quick-start profile; assert the unexpressible is *named*, not dropped |
| 5 | ancestor-aware eviction (§11.2) | a 4-deep lineage keeps its root |
| 6 | `modify` as typed patch (§9) | the scenario's turn two; mutation tests that a mortgage survives a split change, that a 0% account is not deleted, and that no unrequested deletion occurs (§9.4); provenance survives a share round-trip (§9.3) |

Step 2 is the first point at which the scenario runs. Steps 0 and 1 are not
optional preamble — without them it runs *wrong*, plausibly.

---

## 13. Explicitly out of scope

- **Optimization.** "You should save 15%" is advice, not simulation.
- **Creating assets on the user's behalf in the app.** §9.1's binding condition.
- **A curated scenario library.** Still Spec 7's separate design pass, still
  needs the app's compare UX.
- **Monte Carlo comparison.** Percentiles of differences are not differences of
  percentiles.
- **Free-form asset authoring.** If the vocabulary cannot express it, the answer
  is "build that one in the app and share it here," not a JSON escape hatch.

---

## 14. Open questions

1. **Does `build_plan` return a spec, or a handle?** A handle makes the lineage
   uniform with Spec 7. A spec keeps the gate honest about not running anything.
   Leaning: return the spec, and let `run_plan` mint the handle.
2. **How does a conversational plan get into the app?** The share format is
   already the plan spec, so a share URL is the obvious carrier — but §9.1's
   condition means the user must perform the import, and there is no flow for
   "here is a link, open it."
3. **Should `show` describe plans the vocabulary cannot build?** §9 says yes,
   marked. That means the describe surface is strictly larger than the build
   surface, which is unusual and worth confirming before it hardens.
4. **Starting balances.** The scenario has none. A user who says "I already have
   $50K saved" is one sentence away, and basis handling for a taxable account
   with a stated balance is not obvious — `startBasisCurrency` defaults to zero,
   which would make the entire balance a future capital gain.
