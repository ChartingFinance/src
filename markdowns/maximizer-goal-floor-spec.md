# Spec 15 — The Maximizer as a question: how much can I spend, and what is left

Status: **DRAFT 2026-11-12. Spec only, no code. Eleven decisions pending (§14).**

The Maximizer today asks the user to pick a point between "Spending" and
"Terminal Value" on a strip of 21 notches, then runs a genetic search for three
minutes. This spec replaces the strip with the question people ask, "how much
can I spend?", and with the limits that make the question answerable: never run
out, leave at least so much, hold up in simulated markets. The trade-off the
strip stood for is drawn as a real curve, and the curve is the control.

Five rules hold throughout:

- **One dial for spending.** How much the plan can spend is found by turning
  one thing, and never by a search over guardrail settings.
- **Routing is its own question.** Whether the money could be routed better is
  answered by the genetic search (§8), on one measure, and its answer is then
  put through the same spending question.
- **Limits, not weights.** The user states what must stay true. Nothing is
  traded off inside a score the user cannot see.
- **Same rules as the rest of the page.** The plan the Maximizer runs is the
  plan the Timeline runs. Its "as entered" row is the Outcome card's number.
- **Same answer every time.** The same plan and limits give the same result, so
  it can be tested, quoted and compared.

All figures below were measured on main 07ad4a2 with the clock pinned to
2026-11-15, on the eight quick-start profiles.

---

## 1. What exists

`js/simulator.js` (worker) and `js/components/simulator-modal.js` (page).

A chromosome holds one gene for each transfer percentage in each phase, plus
four guardrail genes: withdrawal rate 1–10%, preservation 5–50%, prosperity
5–50%, adjustment 2–25%. Fifty candidates evolve for 200 generations, 10,000
plan runs. The score is

    spendingWeight × min(lifetimeSpending / $10M, 1)
  + terminalWeight × min(endingValue / $50M, 1)
  − penalties

with the two weights set by the strip.

What works: the search runs in a worker, the chart updates as it goes, a plan
that ends at or below $0 always scores below one that does not, home, mortgage
and debt transfers are locked, and Apply to Baseline closes the loop.

### 1.1 Measured defects

| # | Defect | Measured |
|---|---|---|
| 1 | **The Terminal end wins by cutting spending.** It sets the withdrawal rate to its floor and the adjustment to its ceiling, so the guardrails cut spending by a quarter, year after year. | Retired, notch 100: rate 1.0%, adjustment 25%. Lifetime spending $2.74M → $0.76M, ending value $6.57M → $11.2M. Mid Career in the app: $28.2M, 11 cuts. |
| 2 | **The Spending end turns the same dials the other way.** | Rate 9.9% (Retired), 9.8% (Pre-Retirement), against a ceiling of 10%. |
| 3 | **Positions between the ends are noise.** A notch can lose to its neighbour on both measures. | Pre-Retirement: notch 50 found $9.58M spending and $6.96M ending; notch 0 ("100% spending") found $6.67M and $4.60M. Retired: the reverse. |
| 4 | **The middle is not half and half.** Spending is divided by $10M and ending value by $50M, so a dollar spent counts five times a dollar left. Either term stops counting at its cap. | By reading `calculateFitness`. |
| 5 | **Guardrails run from the plan's first year.** The Guardrails panel and Monte Carlo start them at retirement; the Timeline has none. | Mid Career baseline: $3.66M (Timeline), $6.48M (from retirement), $10.83M (from the first year). The report's "Baseline" is a fourth figure, $7.46M, under the page's own guardrail settings. |
| 6 | **After Apply, the Timeline does not show the Maximizer's number.** | Retired, notch 100: Maximizer $11.2M, Timeline after Apply $7.39M. |
| 7 | **Account-to-account genes ignore the law and the missing penalty.** | Mid Career recommended Roth IRA → 401(k) 35% a month, 401(k) → Brokerage 70% a month at 45, Rent paid 7% from the 401(k). Apply writes them into the plan. |
| 8 | **The result is hard to read.** Raw markdown in a monospace box; the summary has no spending row; "Best Spending" is the final year while the score uses the lifetime total; the report warns "consider lowering the withdrawal rate" beside a recommended 1.0%. | In the app. |
| 9 | **Two runs differ.** The search is unseeded. | By reading `generateInitialPopulation`. |
| 10 | **Three minutes a run**, and a click on a notch starts another. | 200 generations took just over three minutes in the app. |

Each setting was run once, so the figures in rows 1–3 are examples, not
averages. Rows 4, 5, 7 and 9 follow from the code.

Monte Carlo did not tell these results apart: with guardrails on it read 100%
before and after in every profile tried.

## 2. The measurement the design rests on

Scale every living expense in a plan by one factor and run it. Ending value in
today's dollars, by factor (`!` = the plan runs out of money):

| Profile | ×0.6 | ×0.8 | ×1 | ×1.2 | ×1.4 | ×1.6 | ×1.8 | ×2 |
|---|---|---|---|---|---|---|---|---|
| Mid Career | $4,576k | $2,765k | $923k | $622k! | $368k! | $114k! | $0! | $0! |
| Pre-Retirement | $5,262k | $4,327k | $3,376k | $2,398k | $1,410k | $1,821k! | $1,648k! | $1,474k! |
| Retired | $4,608k | $4,051k | $3,490k | $2,931k | $2,369k | $1,787k | $1,172k | $551k |
| Dual Income | $13,926k | $12,006k | $10,070k | $8,144k | $6,220k | $4,299k | $3,591k! | $3,365k! |

Three things follow.

**While the plan is funded, ending value falls steadily as spending rises.** In
all eight profiles. So "the most spending that keeps limit L" has one answer,
and halving the interval finds it: 14 runs give the factor to within
0.04%.

**Once the plan runs out, ending value is no longer a guide.** Unpaid bills are
not spent, so the figure can rise again (Pre-Retirement ×1.4 → ×1.6). "Never
runs out" is therefore tested first and always, and the curve stops there.

**A run costs 32 ms.** Fourteen runs take half a second, against three minutes.
A whole curve of 16 points costs another half second.

The largest factor that never runs out, and the largest that also leaves half
of what the plan leaves today:

| Profile | Never runs out | Leaves half |
|---|---|---|
| Early Career | ×0.93 | ×0.93 |
| Mid Career | ×1.03 | ×1.03 |
| Pre-Retirement | ×1.41 | ×1.34 |
| Retired | ×2.12 | ×1.61 |
| Young Couple | ×1.70 | ×1.46 |
| Dual Income | ×1.77 | ×1.52 |
| Couple Nearing Retirement | ×1.84 | ×1.53 |
| Retired Couple | ×2.35 | ×1.73 |

Two rows need explaining, and they shape §5.

- **Mid Career stops at ×1.03 with $923k left.** At ×1.04 the brokerage account
  is empty in September 2065 and $559,554 of bills go unpaid, while the 401(k)
  holds $1.9M and the Roth $1.0M. The plan's transfer rules do not draw them
  fast enough and the backstop never spends a retirement account (spec 12
  §4.4). What limits spending here is which account pays, not how much there
  is.
- **Early Career is below ×1.** The profile as shipped runs out in July 2030
  ($36,771 unpaid) and still ends with $15.5M. The answer to "how much can I
  spend" is "7% less than entered", for the same reason.

Monte Carlo success falls steadily too (Mid Career, 300 runs, no guardrails):
93% at ×1, 76% at ×1.5, 48% at ×2, 30% at ×2.5, 10% at ×3. 300 runs take 9.7 s
and 1,000 take 28.9 s.

## 3. The question

> **Spend the most that keeps these true:**

| Limit | Default | Meaning |
|---|---|---|
| **Never runs out** | always on | No month has an unpaid bill: `planExhaustion(detectIssues(portfolio))` is null. The definition the Outcome card and "What needs attention" already use. |
| **Leaves at least $___** | $0 | Ending value in today's dollars, deflated by the run's own price index, as on the Timeline. |
| **Holds up in ___% of simulated markets** | off | Monte Carlo success, as the Simulations panel defines it. Slower (§7). |

The limits are the "other ranges" the strip did not have. Each is a number the
user types, in units they already see elsewhere on the page.

### 3.1 The dial

The dial is a factor on the plan's adjustable expenses.

- **Which expenses.** The set the guardrails already adjust: every monthly
  expense that is not health insurance. Mortgage, debt, taxes and premiums are
  not in it. (Decision §14.2: whether the user can hold an expense fixed.)
- **From when.** Phase 1 scales an expense for its whole life, which needs no
  engine change: the factor multiplies its starting amount. "From retirement
  only" needs an amount that changes at a phase, which is spec 14's subject
  (decision §14.3).
- **How it reads.** Never as a factor. "Living Expenses $3,000 → $3,090 a
  month", and a total in today's dollars.

### 3.2 What the search does

1. Run the plan as entered. Record it as the first row.
2. Find the largest factor that keeps every limit that is switched on, by
   halving an interval. Stop when the interval is narrower than $10 a month.
3. Sample the curve (§4) between "spend nothing extra" and the factor where
   the plan first runs out.

About 30 runs, one second. No random numbers.

If the plan as entered already breaks a limit, the answer is below ×1 and the
result says so: "This plan runs out in July 2030. Spending 7% less keeps it
funded."

## 4. The curve is the control

One small chart, about 200 px tall, in place of the strip and the 300 px bar
chart:

- **x:** monthly spending, today's dollars. **y:** what is left at the end,
  today's dollars.
- A line through the sampled points, ending where the plan first runs out.
  Beyond that point the area is hatched and labelled "runs out".
- Three marks: **As entered**, **The most you can spend** (the answer to §3),
  and, when a floor is set, a horizontal line at the floor.
- Hover gives both figures for a point. A click on the curve sets "Leaves at
  least" to that point's y and re-solves, so dragging along the curve is the
  old strip, with real numbers at each stop.

This is what the strip was trying to say. Each point on it is an exact plan run,
the two ends are the plan's own, and nothing is weighted.

The stacked bar chart goes. It repeats the Timeline, which already redraws after
Apply.

## 5. The result

A table beside the curve, Apply under it (figures illustrative):

| | As entered | Spend the most |
|---|---|---|
| Monthly spending (today's $) | $5,200 | $5,360 |
| Lifetime spending (today's $) | … | … |
| Left at the end (today's $) | $923k | $871k |
| Runs out | never | never |
| In simulated markets | 93% | 91% |
| With guardrails | … | … |

- The first column is the Outcome card's plan, to the dollar.
- "In simulated markets" is filled by a Monte Carlo run of each column after
  the search, 300 runs each, so it appears a few seconds later.
- "With guardrails" is the Guardrails panel's run of each column, under the
  page's own guardrail settings, from retirement.

### 5.1 What stops you

One sentence under the table, naming the limit that bound and where:

- *"In September 2065 the Brokerage is empty and bills go unpaid, while the
  401(k) holds $1.9M and the Roth IRA $1.0M."* For the never-runs-out limit:
  the first unfunded month, from the exhaustion issue, plus the balances the
  backstop would not touch that month.
- *"The plan would end with less than $500,000."* For the floor.
- *"Fewer than 90% of simulated markets would last."* For the success limit.

Without this line a result like Mid Career's ("3% more, with $923k left")
reads as a bug. With it, the user learns that the next step is a transfer rule
or, after spec 12 Phase 2, switching a retirement account on in the fallback
order. The sentence links to the month in Month Details.

### 5.2 Apply

Apply writes the scaled amounts into the expense accounts. It changes amounts
the user entered, on the user's click, and creates or deletes nothing.

Two ways to apply (decision §14.5): **Save as a new scenario** (the default
proposed here: the entered plan stays, and scenarios already keep their own
settings) or **Change this plan**.

## 6. Guardrails

- **Out of the search.** A guardrail reacts to markets that vary. On one fixed
  path it is only a second spending dial, which is how defects 1 and 2 arise.
- **In the result.** The "With guardrails" row shows the solved plan under the
  user's settings.
- **One offer.** The plan's own first-year retirement withdrawal rate, at the
  solved spending, is a figure the user otherwise guesses at (the setting
  defaults to a round number). The result offers it: "Your plan withdraws 4.6%
  in its first retired year. Use it as the guardrail target rate?" One click,
  never automatic (decision §14.7).

## 7. Monte Carlo

- **As a check, always.** The "In simulated markets" row.
- **As a limit, when switched on.** The search halves the interval on the
  success rate instead of on ending value. Every step uses the same seed and
  the same 300 runs (`runRandom(seed, runIndex)` already makes runs
  repeatable), so steps differ only by spending and the result is the same
  each time. Seven steps reach about 2% of spending in roughly 70 seconds, with
  progress shown, then one 1,000-run confirmation.
- **Never as the score of a wide search.** 10,000 candidates times 300 runs is
  more than a day.

## 8. The routing search

The genetic search stays, with its own question: **"is there a better way to
route my money?"** Section 2 shows why that question matters. Mid Career's
spending is limited by which account pays, not by how much there is, and only a
change of routing moves that limit.

### 8.1 One measure

Spending is out of its score, so no weight and no dividing constant is left. A
candidate is ranked, in order:

1. by the bills it leaves unpaid (less is better, none is best);
2. then by what is left at the end, in today's dollars, at the spending the
   user entered.

The best candidate is then handed to §3's solver. The result reads as the user
would ask it: "With this routing you could spend $X a month more", as a third
column in §5's table.

### 8.2 What it may change

- **In:** how each income is split across accounts, and which accounts pay each
  expense. Home, mortgage and debt stay locked, as today.
- **Out:** the four guardrail settings. Moves from one account to another: a
  401(k) → Roth move is a conversion and wants its own feature, and a Roth →
  401(k) move does not exist.
- **Held at the user's own value until spec 13:** any draw on a retirement
  account before 59½. The penalty is not charged yet, so the search would find
  early draws free.
- **Contributions** are held to the law's annual limits, in place of the flat
  25% of income. What the engine itself enforces is checked at the start of the
  phase.

With these the search no longer waits for specs 12 and 13. Each of them widens
what it may change when it lands.

### 8.3 Against a bad valley

A search over thirty percentages can settle in a local best. Today's does: the
runs in §1.1 row 3 are 10,000 plan runs each and still disagree with each
other. Five measures, all of them visible to the user or to a test:

- **Start from the user's plan.** The first population holds the plan as
  entered and near copies of it. Today's is entirely random, so the user's own
  routing is never bred from.
- **Several searches, not one.** Five restarts from different seeds. The seeds
  are fixed, so the same plan gives the same five results.
- **Polish.** From each restart's best, step each percentage up and down by a
  point and keep any gain, until none is left. A genetic search is good at
  finding the right region and poor at finishing; this finishes.
- **Prune.** Put each changed percentage back to the user's value where that
  costs less than 0.1% of the gain. A recommendation of 28 changes is not
  usable; the few that carry the gain are.
- **Say whether they agree.** If the five results are within 1% of each other:
  "Five searches agree." If not, the best is shown with "The searches differed
  by 6%. A longer search may find more." One answer is never presented as the
  best when the searches did not agree on it.

### 8.4 Run budget

Nothing here shortens the search. A plan run costs 28 ms, so 10,000 runs take
about five minutes on one core, and five restarts would take twenty-five. So
the restarts run side by side, one worker each, up to the machine's cores less
one, and a restart stops early after 30 generations without a gain. On a
six-core machine the wall time is about today's. Progress shows each restart's
best so far.

### 8.5 Measure before building

How rugged this landscape is has not been measured. The phase starts with an
experiment on the eight profiles, on §8.2's genes and §8.1's measure, five
seeds each:

| Arm | Runs per seed |
|---|---|
| Polish alone, from the plan as entered | until no gain |
| Genetic search as today (random start) | 10,000 |
| Genetic search started from the plan | 10,000 |
| Started from the plan, then polish | 10,000 + polish |

Three outcomes, each with its consequence written now:

- **The seeds agree and polish alone matches them:** the landscape is smooth.
  Ship polish alone, in seconds, and keep the genetic search out.
- **The genetic arms beat polish alone, and the seeds agree:** ship §8.3 as
  written. The valleys are real and the search clears them.
- **The seeds still disagree:** ship §8.3 with a larger population or more
  generations, sized by the experiment, and keep the disagreement line.

The experiment's table goes into this spec before the phase's code is written.

### 8.6 How it reads

The changes are shown as a table on the page, by phase: from, to, now,
proposed. Not markdown in a text box. Apply follows §5.2, and applies the
routing and the spending together or the routing alone.

## 9. Code

- **`js/spending-solver.js`**, new, headless (inside the layer boundary):
  `solveSpending({ modelAssets, lifeEvents, config, limits })` →
  `{ asEntered, best, curve, boundBy }`. Pure: it builds its own portfolios
  from serialized assets, mutates nothing it is given, reads no global.
- It runs in the shared simulation worker (`mc-worker.js`, a new `kind`), which
  already hosts Guardrails. The payload carries `global_workerSnapshot()`.
- Runs go through `withoutTracing`. Exhaustion detection does not need the
  trace (checked: Mid Career ×1.04 reports September 2065 either way).
- The page section becomes a small Lit element. `simulator-modal.js` and the
  strip in `index.html` and `finplan-app.js` go.
- `simulator.js` stays and changes in Phase 2: the score (§8.1), the gene map
  (§8.2), a seeded random source, the seeded first population, polish and prune
  (§8.3). Each restart is its own worker.
- **MCP.** A `max_spending` tool over the same function is cheap and fits the
  conversational plan ("how much more could I spend?"). Its own PR (§15).

## 10. Presentation surfaces, enumerated

`index.html` (section, nav label), `finplan-app.js` (launch, Apply),
the new element, `help.html#maximizer`, `rules.html` (Maximizer section),
`markdowns/finplan-ui-spec.md` (four mentions), the Outcome card (unchanged, but
its figure is now the Maximizer's first column and a test pins that), the
projections markdown export if it quotes the Maximizer, `plugin/README.md` and
`SKILL.md` once the MCP tool exists. The static pages change in the same PR as
the behavior.

The name: "Maximizer" still fits. The subtitle becomes "How much can this plan
spend?" (decision §14.10).

## 11. Traps this codebase has already hit

- **A copy that is not the plan.** `ModelAsset.copy()` dropped four fields and
  the Maximizer's page overstated a plan by 5.3% (#126). The solver builds from
  the serialized form, and its first column is tested against the Timeline's
  run.
- **Clock-pinned fixtures.** Quick-start dates come from the wall clock. Every
  solver test pins it.
- **Green is not evidence.** The limits are load-bearing: mutation-verify the
  exhaustion test, the deflation, the halving direction and the stop rule.
- **Past the edge, the measure lies** (§2). Any later change that reads ending
  value without testing "never runs out" first reintroduces defect 3 in a new
  form. One function owns the test.
- **The user owns the accounts.** Apply changes amounts only. If a later phase
  wants to add a transfer rule, it proposes and the user accepts.
- **A what-if must be a family.** The parked what-if library was parked because
  one-off alternatives were off the table. This is not one: it is a solved
  figure on the entered plan, and its "Save as scenario" uses the existing
  scenario slots. It should not grow a second, private compare view.

## 12. Fixtures and tests

- `solver-matches-timeline`: for each quick-start profile, the solver's first
  column equals the plan's own run.
- `solver-is-a-limit`: at the solved factor every limit holds; $20 a month
  above it one fails. For all eight profiles and three floors.
- `solver-repeats`: two solves give identical output.
- `solver-below-entered`: Early Career solves below ×1 and says why.
- `solver-names-what-stops-it`: Mid Career names September 2065 and the two
  retirement balances.
- `curve-stops-at-the-edge`: no curve point lies beyond the first run-out.
- `feasible-is-an-interval`: across 30 sampled factors per profile, once a
  limit fails it keeps failing. This is the assumption the halving rests on,
  and it is measured here on eight profiles only; the test keeps it honest as
  the engine changes. If a plan breaks it, the solver falls back to a scan of
  the samples and takes the largest passing factor below the first failure.
- With the success limit: the same seed gives the same rate; the rate does not
  rise with spending across the samples.
- Routing: `routing-never-worse` (the result ranks at or above the plan as
  entered, for every profile); `routing-repeats` (same plan, same five
  results); `routing-legal` (no result holds an account-to-account move, a
  changed early retirement draw or a contribution over the limit);
  `polish-finishes` (no single one-point step improves the result);
  `prune-keeps-the-gain`; `disagreement-is-reported` (a fixture built to have
  two separated bests shows the line).

Prediction, written before any change: no existing baseline moves in Phase 1.
The solver adds a module and a page section and changes no engine rule.

## 13. Not in scope

- Spending that differs by phase (spec 14).
- Retirement accounts paying when the brokerage is empty (spec 12 Phase 2). The
  solver will show the gain from it once it exists, with no change here.
- Account-to-account moves in the routing search, Roth conversions among them.
- Roth conversions, claiming age, retirement age as dials. Each is a candidate
  second dial for the same solver, and each is its own decision.
- The early-withdrawal penalty (spec 13).
- Tax-aware spending (spending more in low-bracket years).

## 14. Decisions pending

1. **The reframing itself:** replace the strip with "spend the most that keeps
   these limits"? The rest assumes yes.
2. **Which expenses the dial turns:** every monthly expense except health
   insurance (proposed, the guardrails' set), or only those the user marks
   flexible?
3. **From when:** the whole plan in Phase 1 (proposed), with retirement-only
   after spec 14, or wait for spec 14?
4. **The default floor:** $0 (proposed), or what the plan leaves today, which
   makes the default answer "no change" for any plan that is funded?
5. **Apply:** save as a new scenario by default (proposed), change the plan, or
   offer both?
6. **The success limit:** in Phase 3 as proposed, or in Phase 1? And its
   default when switched on: 90%?
7. **The guardrail-rate offer** (§6): yes, or leave guardrail settings alone?
8. **The routing search between phases:** off the page for Phase 1 and back in
   Phase 2 (proposed), or kept visible through Phase 1 with Apply switched off?
9. **The MCP tool:** after Phase 1 as its own PR (proposed), or not yet?
10. **Wording:** keep "Maximizer" with the new subtitle, or rename the section?
11. **The routing search's safeguards** (§8.3): five restarts and a 1% agreement
    band as proposed? And is "the searches differed" acceptable on the page, or
    should a disagreeing search run longer before it shows anything?

## 15. Phases and cost

| Phase | Delivers | Effort |
|---|---|---|
| **1. The solver and the curve** | §3 with the first two limits, §4, §5 without the success limit, §5.1, Apply, Help, Rules, the UI spec. The strip, the bar chart and the genetic search leave the page. | about 3–4 days |
| **2. The routing search** | §8: the experiment (§8.5) first, then the score, the genes, restarts, polish, prune, the agreement line, the third column | about 1–2 days for the experiment, then 4–6 |
| **3. Simulated markets as a limit** | §7, the guardrail-rate offer | about 2 days |
| **4. The MCP tool** | `max_spending`, README, SKILL | about 1 day |

Phase 1 is worth shipping alone. It removes every defect in §1.1, answers in a
second, and takes less room than what it replaces. Phase 2 follows it directly:
for a plan like Mid Career, routing is where the spending is.
