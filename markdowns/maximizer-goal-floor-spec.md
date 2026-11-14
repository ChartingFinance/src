# Spec 15 — The Test Bench: how much can I spend, and what is left

Status: **DECIDED 2026-11-12 (§14). Phase 1 is built** (the solver, the curve, the
result, the rename). **Phase 2's experiment is run (§8.7, 2026-11-13) and changed
two decided items; §8.8 is the design as decided after it (§14, decisions 12
and 13). **Phases 1 and 2 are merged. Phase 3 (§7) is built, with decisions 14
to 16, and so is Phase 4, the MCP tool (§9).**
The section called Maximizer today is renamed Test Bench (decision §14.10).

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
- **Same rules as the rest of the page.** The plan the Test Bench runs is the
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
all eight profiles. Where that holds, "the most spending that keeps limit L"
has one answer and halving an interval finds it. It does not hold for every
plan (§2.1), so the solver never relies on it.

**Once the plan runs out, ending value is no longer a guide.** Unpaid bills are
not spent, so the figure can rise again (Pre-Retirement ×1.4 → ×1.6). "Never
runs out" is therefore tested first and always, and the curve stops there.

**A run costs 32 ms.** A scan of 40 spending levels and a dozen refining runs
take one to three seconds (measured on the eight profiles once built), against
three minutes.

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

### 2.1 Where the steady fall fails

A ninth plan, built for the health-cost check in §3.3 (age 60, retired, a
$30,000 pension, Checking $30k, Brokerage $900k, IRA $600k, a marketplace
plan, to age 85), breaks it:

| Spending | ×1 | ×1.05 | ×1.1 | ×1.2 |
|---|---|---|---|---|
| Left at the end (today's $) | $5,056k | $5,026k | $5,200k | $5,047k |

Spending 10% more leaves $144k more. The cause is routing, and it is the same
with the health plan removed. At ×1.05 Checking ends with $1,231k that never
earned the brokerage's return; at ×1.1 the bills keep Checking empty, the same
money lands in Brokerage, and Brokerage ends $1.6M higher.

Two consequences:

- **The solver scans.** It runs the whole range of spending levels first and
  only then refines (§3.2). Halving alone, on this plan with a floor of $5.1M,
  can answer "below what you entered" when ×1.1 passes.
- **The result says when the curve rises.** A rise means some lower level of
  spending leaves money idle. The result names the account whose ending balance
  differs most across the rise: "At lower spending, $1.2M stays in Checking."
  That is a routing finding, and the routing search (§8) is where it is acted
  on.

Monte Carlo success falls steadily too (Mid Career, 300 runs, no guardrails):
93% at ×1, 76% at ×1.5, 48% at ×2, 30% at ×2.5, 10% at ×3. 300 runs take 9.7 s
and 1,000 take 28.9 s.

## 3. The question

> **Spend the most that keeps these true:**

| Limit | Default | Meaning |
|---|---|---|
| **Never runs out** | always on | No month has an unpaid bill: `planExhaustion(detectIssues(portfolio))` is null. The definition the Outcome card and "What needs attention" already use. |
| **Leaves at least $___** | $0 | Ending value in today's dollars, deflated by the run's own price index, as on the Timeline. |
| **Lasts in ___% of simulated markets** | on, 90% | Monte Carlo success, as the Simulations panel defines it. Slower (§7). Decision §14.15. |

The limits are the "other ranges" the strip did not have. Each is a number the
user types, in units they already see elsewhere on the page.

### 3.1 The dial

The dial is a factor on the plan's monthly expenses.

- **Which expenses.** Every monthly expense, the marketplace health plan
  included (decision §14.2). Mortgage, debt and taxes are not in it. The
  guardrails keep their own, narrower set: they still leave the health plan
  alone.
- **From when.** The whole plan (decision §14.3): the factor multiplies each
  expense's starting amount, which needs no engine change. "From retirement
  only" needs an amount that changes at a phase, which is spec 14's subject.
- **How it reads.** Never as a factor. "Living Expenses $3,000 → $3,090 a
  month", and a total in today's dollars.

### 3.2 What the search does

1. Run the plan as entered. Record it as the first row.
2. **Scan.** Run 40 spending levels, from half of what was entered up to the
   level where the plan first runs out (found by doubling). These runs are the
   curve (§4).
3. **Pick.** The answer is the highest level at which every switched-on limit
   holds. The scan gives the highest passing sample.
4. **Refine.** Halve the gap between that sample and the failing one above it
   until it is narrower than $10 a month.

About 45 to 55 runs, one to three seconds. No random numbers.

If the plan as entered already breaks a limit, the answer is below what was
entered and the result says so: "This plan runs out in July 2030. Spending 7%
less keeps it funded."

If the scan shows the curve rising anywhere, the result says so and names the
account (§2.1).

### 3.3 Health costs and the step at 65

The dial turns the marketplace health plan with the other expenses. Four things
about that account, and the step to Medicare, shape what the Test Bench does.

- **The benchmark is not turned.** A health plan's credit is worked from the
  benchmark premium, which is the market's and not the user's choice. The
  engine reads it as the entered benchmark grown by the premium's own growth,
  so scaling the starting premium leaves it where it was. Turning the dial
  models choosing a dearer or cheaper plan; the credit is then whatever the
  engine works out. A test pins the benchmark under the dial.
- **Spending moves the credit.** More spending means larger draws, a higher
  income for the credit, and a smaller credit, with a cliff at 400% of the
  poverty line. On the plan in §2.1 the credit moved by tens of dollars a year,
  because its income stayed near 195%. A plan near the cliff has not been
  measured. The scan in §3.2 is what makes a cliff safe: a step down in the
  curve is found, not assumed away. When the plan has a health plan, the result
  table adds a row, **Premium tax credit**, for both columns.
- **The health plan ends the December before 65.** The engine charges nothing
  for Medicare after that: no Part B or D premium, no supplement, and IRMAA is
  recorded but not charged. A cost after 65 exists only if the user entered an
  expense for it. So spending steps at 65, and the result shows monthly
  spending in two rows when the plan has a health plan: **before 65** and
  **from 65**.
- **A plan with no health cost from 65 reads as room to spend.** It is not. When
  a plan has a health plan and no expense that starts within a year of its
  end, the result carries a note: "Nothing in this plan pays for health cover
  from 65. The figure assumes none." The Test Bench advises; it adds no
  account.

The same factor applies on both sides of 65. A different level before and after
is a per-phase amount, and waits for spec 14 with the rest.

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

With a marketplace health plan the first row becomes two, before 65 and from
65, and a Premium tax credit row is added (§3.3).

- The first column is the Outcome card's plan, to the dollar.
- "In simulated markets" is filled by a Monte Carlo run of each column after
  the search, 300 runs each, so it appears a few seconds later.
- "With guardrails" is the Guardrails panel's run of each column, under the
  settings in the Guardrails section, from retirement. The Test Bench reads
  those settings and never changes them (decision §14.7).

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

Apply saves the result as a new scenario (decision §14.5). The plan as entered
stays as it is, and the new scenario holds the scaled expense amounts with a
copy of the plan's settings. Nothing is created or deleted in the entered plan.

The button reads "Save as a scenario", asks for a name, and switches to it.

## 6. Guardrails

- **Out of the search.** A guardrail reacts to markets that vary. On one fixed
  path it is only a second spending dial, which is how defects 1 and 2 arise.
- **In the result.** The "With guardrails" row shows the solved plan under the
  user's settings.
- **Settings left alone.** The Test Bench reads the Guardrails section's
  settings and never proposes or writes one (decision §14.7).

## 7. Monte Carlo

- **As a check, always.** The "In simulated markets" row.
- **As a limit, on by default at 90%** (decision §14.15). The user can change
  the rate or switch the limit off.
- **Never as the score of a wide search.** 10,000 candidates times 300 runs is
  more than a day. The routing test stays on the plan's own path of returns
  (decision §14.14), and says so beside its result.

### 7.1 The limit, as built

The spending solver's answer (§3.2) is the ceiling: no level above it keeps
the other limits. The limit then turns the answer down:

1. Run the ceiling across 300 simulated markets. If the plan lasts in the
   target share, nothing changes, and the note says the limit did not bind and
   what the rate is.
2. Otherwise find a level that does last: what was entered, when that is below
   the ceiling, or else the bottom of the scan. If none does, the result has
   no answer and says so.
3. Halve the interval between the level that lasts and the one that does not,
   at most seven times, stopping early under 0.5% of the entered spending.

Every step uses the same seed and the same 300 markets (`runRandom(seed,
runIndex)` makes runs repeatable), so steps differ only by spending and the
result is the same each time. A step is about ten seconds. The most a solve
costs is ten steps, with progress shown ("Testing spending level 3 across 300
simulated markets").

- **The rate is the Simulations section's:** the share of markets in which net
  worth never reaches $0 from retirement on, without guardrails, in the data
  mode and era chosen there. The same markets fill the check row, so a rate
  the limit measured is not measured again.
- **Halving assumes the rate never rises with spending.** A test pins that on
  the quick-starts.
- **Rates are kept for the plan.** They depend on the spending level and not
  on the floor or the target, so a click on the curve, or another target,
  reuses them: a level at or below one known to last is known to last.
- **Below what was entered** (decision §14.16). Mid Career as entered lasts in
  88% of markets, so at 90% the answer is 5% less than entered, and the result
  says so in the same words as a plan that runs out as entered.
- **What the limit cost.** When it binds, the result keeps the solver's own
  answer beside it: a grey mark on the curve, and "On the plan's own path of
  returns it could spend $5,316 a month. Lasting in 90% of simulated markets
  costs $407 a month of that."
- **A confirmation.** The answer is then run across 1,000 markets, as its own
  job after the answer is shown: 300 markets chose it, so they cannot also be
  the check on it.

**A limit of the definition, stated on the page.** A market counts as lasting
while net worth stays above $0, retirement accounts included. The backstop
does not spend those accounts, so a plan can leave bills unpaid in a market
that counts as lasting. "Never runs out" (§3) is the stricter test, and it is
applied on the plan's own path only.

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

### 8.7 The experiment, as run

Run 2026-11-13 on main 05ca2ca, clock pinned to 2026-11-15, the eight
quick-start profiles, on §8.2's percentages (6 to 30 per profile, fewer than
the thirty §8.3 assumed). Every "can spend" figure is the spending solver's
(§3) for the routed plan, in today's dollars a month, with a floor of $0.

**1. The measure in §8.1 fails.** Ranked by what is left at the entered
spending, a climb from the plan ("polish", §8.3) finds routings that leave
more and can spend less:

| Profile | Left as entered | Left, routed | Can spend as entered | Can spend, routed | |
|---|---|---|---|---|---|
| Early Career | $2.88M | $2.55M | $3,659 | $3,929 | +7.4% |
| Mid Career | $0.92M | $0.97M | $5,316 | $5,181 | −2.5% |
| Pre-Retirement | $3.37M | $3.41M | $5,638 | $4,485 | −20.4% |
| Retired | $3.49M | $3.51M | $9,503 | $8,725 | −8.2% |
| Young Couple | $12.03M | $12.11M | $7,627 | $5,839 | −23.4% |
| Dual Income | $10.07M | $10.36M | $9,431 | $6,945 | −26.4% |
| Couple Nearing Retirement | $7.10M | $7.13M | $10,109 | $9,301 | −8.0% |
| Retired Couple | $5.43M | $5.46M | $14,061 | $13,027 | −7.4% |

Seven of eight can spend less. The routing that leaves the most sends money
into retirement accounts, where it is taxed least and where a bill cannot
reach it, so the plan runs out sooner. (Early Career runs out as entered, so
its first rank, fewer unpaid bills, did the work.) Ranking by unpaid bills at
a spending level 20% past the entered routing's most was tried as well: six
of eight still spend less. The genetic arms were not run to the end on this
measure; the climb had already settled it.

**2. Ranked by what the plan can spend, every profile gains.** A routing's
rank is the highest spending level at which it never runs out and leaves the
floor: the question §3 asks. Finding that level costs about ten runs, so a
candidate is run once, just above the best so far, and its own level is found
only when it pays every bill there.

| Profile | Percentages | As entered | Polish from the plan | Genetic, random start (5 seeds) | Genetic, from the plan (5 seeds) | From the plan, then polish | Plan runs: polish / genetic |
|---|---|---|---|---|---|---|---|
| Early Career | 13 | $3,659 | $4,354 (+19.0%) | $4,353 to $4,354 | $4,353 to $4,354 | $4,353 to $4,354 | 181 / 9,834 |
| Mid Career | 13 | $5,316 | $5,627 (+5.8%) | $5,636 to $5,648 | $5,636 to $5,644 | $5,631 to $5,643 | 315 / 10,029 |
| Pre-Retirement | 11 | $5,638 | $6,648 (+17.9%) | $6,641 to $6,673 | $6,648 to $6,674 | $6,648 to $6,674 | 306 / 10,091 |
| Retired | 6 | $9,503 | $9,782 (+2.9%) | $9,782 | $9,782 | $9,782 | 229 / 7,772 |
| Young Couple | 30 | $7,627 | $8,470 (+11.1%) | $8,456 to $8,470 | $8,465 to $8,470 | $8,470 | 2,944 / 10,459 |
| Dual Income | 25 | $9,431 | $10,332 (+9.6%) | $10,329 to $10,351 | $10,331 to $10,354 | $10,332 to $10,354 | 1,691 / 10,550 |
| Couple Nearing Retirement | 30 | $10,109 | $11,219 (+11.0%) | $10,873 to $11,201 | $11,178 to $11,232 | $11,219 to $11,257 | 4,523 / 10,447 |
| Retired Couple | 8 | $14,061 | $14,364 (+2.2%) | $14,364 to $14,367 | $14,364 to $14,367 | $14,364 | 337 / 9,524 |

- **Polish alone, from the plan, is within 0.4% of the best any arm found**,
  on every profile. The most a genetic arm added was $39 a month (Couple
  Nearing Retirement); the solver itself answers to within $10.
- **The genetic seeds agree** to within 0.5%, with one exception: from a random
  start on Couple Nearing Retirement (30 percentages) the five seeds differ by
  2.9% before polish. 10,000 runs did not finish that search.
- **A stall rule of 30 generations is too short**: it would have stopped some
  searches at 90% of the level they went on to reach. Last gains came as late
  as generation 192 of 200.
- **Prune works**: 3 to 15 changed percentages become 2 to 10, for at most $5 a
  month.

**3. There are valleys, away from the plan.** Polish from five other starting
points:

| Profile | From the plan | From near the plan | From random routings |
|---|---|---|---|
| Early Career | $4,354 | $4,353 to $4,354 | $4,355 |
| Mid Career | $5,627 | $5,618 to $5,631 | $5,618 to $5,626 |
| Pre-Retirement | $6,648 | $6,641 to $6,650 | $6,200 to $6,675 |
| Retired | $9,782 | $9,782 | $9,782 to $9,788 |
| Young Couple | $8,470 | $8,470 | $8,465 to $8,470 |
| Dual Income | $10,332 | $10,327 to $10,333 | $10,187 to $10,352 |
| Couple Nearing Retirement | $11,219 | $11,212 to $11,219 | $10,768 to $11,219 |
| Retired Couple | $14,364 | $14,364 to $14,367 | $14,364 to $14,367 |

"Near the plan" moves every percentage by up to 30 points. From there all five
climbs land within 0.2% of the climb from the plan. From a random routing a
climb can stick 1% to 7% lower (Pre-Retirement, Dual Income, Couple Nearing
Retirement). So the concern behind §8.3 is real: a climb alone, from a bad
start, does settle in a valley, and the genetic search from the same random
starts mostly clears it. On these eight plans the user's own routing is a good
start, and from it the climb needs no help.

**Cost.** On an idle machine the climb from the plan takes 4 seconds (Retired),
9 (Mid Career), 46 (Couple Nearing Retirement) and about 150 (Young Couple). A
genetic search of 10,000 runs takes three to eight minutes for the same plans
at the measured cost of a run (18 to 49 ms).

The second and third parts can be run again with
`node tests/tools/routing-experiment.mjs <src> <out.jsonl> [workers]`.

**Which of §8.5's outcomes this is.** The first, for a start from the plan:
the seeds agree and polish alone matches them. With one thing §8.5 did not
foresee, the measure (finding 1), and one qualification, the valleys away from
the plan (finding 3).

Not measured: plans other than the eight quick-starts. A plan whose entered
routing is poor is the case finding 3 warns about, and no fixture here is one.

Two smaller findings:

- **A phase that says nothing about a source leaves its rules in force.**
  Writing one rule for it in a later phase replaces them all. The search reads
  and writes the rules in force, so a proposal never drops an inherited rule
  by accident. The experiment ran before this was fixed; it moved Young
  Couple's entered figure by $33 of $12M and no result above.
- **The engine enforces the annual 401(k) and IRA limits itself**, cutting a
  contribution and paying the rest as take-home (§8.2 asked for this check).
  The flat 25% cap is not needed.

### 8.8 The routing test, as decided after the experiment

Decided 2026-11-13 (§14, decisions 12 and 13). This section replaces §8.1,
§8.3 and §8.4.

**The measure.** A routing is ranked by what the plan can spend under it: the
highest level of §3's dial at which it never runs out and leaves the floor the
user set. Nothing else is in the rank. What is left at the end is shown beside
it, as it is for the other columns; with a floor of $0 it will usually be near
$0, because that is what spending the most means.

**Depth.** The user picks a depth before the search starts. A deeper search is
more searches, so more computing, and the page says so beside the control: how
many searches the depth runs, and about how long they will take on this
machine. Everything runs locally.

| Depth | Searches | Adds |
|---|---|---|
| 1 | 1 | a climb from the plan as entered |
| 2 | 5 | four climbs from near the plan (every percentage moved by up to 30 points) |
| 3 | 10 | five climbs from random routings |
| 4 | 20 | five genetic searches from the plan and five from random routings, 10,000 plan runs each, each followed by a climb |

The default is 3. Seeds are fixed, so the same plan and depth give the same
list. The genetic search has no stall rule (§8.7, finding 2).

- **A climb** steps each percentage, and each pair within a group, by 20, 10,
  5, 2 and 1 points, keeping every gain, until no one-point step helps.
- **Prune** follows every search: a changed percentage goes back to the user's
  value where that costs less than 0.1% of the gain.
- **Side by side.** Each search is its own worker, up to the machine's cores
  less one; the rest wait their turn.

**The list.** The result is every search, ranked by what the plan can spend
under the routing it found: where it started, the monthly figure, the gain on
the plan as entered, and how many percentages it changes. Searches that found
the same routing share a row. Rows fill in as searches finish. The top row is
selected; selecting another shows that routing instead.

**Whether they agree.** Under the list: "7 of 10 searches came within 1% of
the best", or, when none did, "No other search came within 1% of the best. A
deeper search may find more."

**A lone best is marked** (John, 2026-11-13). When every search has finished
and no other came within 1% of the best, the top row carries an amber mark,
"Alone at the top". Of the highlights considered (a lone best, searches that
fell well short, large moves in the changes table), this is the one built.

**The selected routing** is shown as §8.6's table of changes and as a third
column, "With this routing", in §5's table. Its figures are the spending
solver's for the routed plan, and its simulated-markets and guardrails rows
are run as for the other columns.

**Apply** follows §5.2: a new scenario with the routing alone, or with the
routing and its spending.

**Unchanged:** §8.2 (what may change) and §8.6 (how it reads).

## 9. Code

- **`js/spending-solver.js`**, new, headless (inside the layer boundary):
  `solveSpending({ modelAssets, lifeEvents, config, limits })` →
  `{ asEntered, best, curve, boundBy }`. Pure: it builds its own portfolios
  from serialized assets, mutates nothing it is given, reads no global.
- It runs in the shared simulation worker (`mc-worker.js`, a new `kind`), which
  already hosts Guardrails. The payload carries `global_workerSnapshot()`.
- Runs are traced. Exhaustion detection does not need the trace (checked: Mid
  Career ×1.04 reports September 2065 either way), but spending does: a draw
  counts as spending when its causal chain roots in an obligation, the same
  reading as `annual-expenditure.js`. This is why a solve takes one to three
  seconds and not under two.
- The page section becomes a small Lit element. `simulator-modal.js` and the
  strip in `index.html` and `finplan-app.js` go.
- Phase 2: `js/routing-search.js`, new and headless, holds the gene map
  (§8.2), the ranker, the climb, prune, the seeded genetic search and the
  depth table (§8.8). Each search is a `kind: 'routing'` job in its own
  simulation worker. `simulator.js`, the old search, is deleted.
- **MCP.** A `max_spending` tool over the same function is cheap and fits the
  conversational plan ("how much more could I spend?"). Built in Phase 4 as
  `js/mcp/max-spending.js`:
  - it takes a run handle, a share link or a payload, with `leaveAtLeast` and
    an optional `simulatedMarketsPercent`;
  - it returns the answer as Markdown (the plan as entered beside the most,
    what stops it, each expense at that level) and a run handle for the plan
    at the answer, which is the plan given with `solvedAssets` applied;
  - **the simulated-markets limit is off unless asked for.** In the app it is
    on at 90%. Here it costs one to two minutes, long for a tool call, so the
    tool leaves it off, and the report then says the answer is for one fixed
    path and how to ask for the other figure. With it on, the markets are the
    app's (300, seed 1, from retirement, the plan's data mode), so the figure
    is the Test Bench's.

## 10. Presentation surfaces, enumerated

`index.html` (section, nav label), `finplan-app.js` (launch, Apply),
the new element, `help.html#maximizer`, `rules.html` (Maximizer section),
`markdowns/finplan-ui-spec.md` (four mentions), the Outcome card (unchanged, but
its figure is now the Test Bench's first column and a test pins that), the
projections markdown export if it quotes the Maximizer, `plugin/README.md` and
`SKILL.md` once the MCP tool exists. The static pages change in the same PR as
the behavior.

**The name.** The section becomes **Test Bench** (decision §14.10): the nav
label, the heading, Help, Rules and the UI spec. It holds two tests, "Spending"
(§3) and, from Phase 2, "Routing" (§8). The section id and the Help anchor are
renamed, and `help.html#maximizer` stays as a second anchor so existing links
land. Code names (`simulator.js`, `max_spending`) do not change for the
rename.

## 11. Traps this codebase has already hit

- **A copy that is not the plan.** `ModelAsset.copy()` dropped four fields and
  the Maximizer's page overstated a plan by 5.3% (#126). The solver builds from
  the serialized form, and its first column is tested against the Timeline's
  run.
- **Clock-pinned fixtures.** Quick-start dates come from the wall clock. Every
  solver test pins it.
- **Green is not evidence.** The limits are load-bearing: mutation-verify the
  exhaustion test, the deflation, the pick of the highest passing level and the
  stop rule.
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
- `solver-finds-the-highest`: on the plan in §2.1 with a floor of $5.1M the
  answer lies above what was entered, where halving alone answers below it.
- `rising-curve-is-named`: the same plan's result says the curve rises and
  names Checking.
- `steady-on-the-quick-starts`: the eight profiles' curves do not rise while
  funded. Not a law (§2.1): a record of what was measured, so a change that
  breaks it is seen.
- `dial-leaves-the-benchmark`: a health plan's benchmark is the same at every
  spending level.
- `two-rows-at-65`: a plan with a health plan shows spending before and from
  65, and the note when nothing follows it.
- `credit-cliff-is-found`: a fixture whose income crosses 400% of the poverty
  line inside the scan shows the step, and the answer respects the floor on
  both sides of it.
- With the success limit: `rate-repeats` (the same seed gives the same rate);
  `rate-never-rises` (across the samples); `limit-is-a-limit` (the answer
  lasts in the target share and the next level tested does not);
  `limit-keeps-the-floor`; `limit-off-changes-nothing`; `known-rates-are-used`
  (a second solve of the same plan runs no market it does not need).
- Routing: `routing-never-worse` (the result ranks at or above the plan as
  entered, for every profile); `routing-repeats` (same plan and search, same
  result); `depth-adds-searches` (each depth holds the one before it);
  `routing-legal` (no result holds an account-to-account move, a
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
- Charging Medicare premiums or IRMAA. The Test Bench says the plan carries no
  health cost from 65 (§3.3); it does not add one.
- Changing a guardrail setting.

## 14. Decisions

Recorded 2026-11-12 (John). The questions as first asked are in this branch's
second commit.

1. **Replace the strip** with "spend the most that keeps these limits". Yes.
2. **The dial turns every monthly expense, health care included,** and the
   design is aware of the step to Medicare at 65 (§3.3). The draft proposed
   leaving health insurance out, as the guardrails do.
3. **The whole plan** in Phase 1. Spending that differs by phase waits for
   spec 14.
4. **The default floor is $0.**
5. **Apply saves a new scenario.** There is no "change this plan" (§5.2).
6. **The simulated-markets limit is Phase 3.**
7. **Guardrail settings are left alone.** The "With guardrails" row copies the
   Guardrails section's settings; nothing is offered or written (§6).
8. **The routing search is off the page for Phase 1 and back in Phase 2.**
9. **The MCP tool follows Phase 1** as its own PR.
10. **The section is renamed Test Bench** (§10).
11. **The routing search's safeguards are as proposed** (§8.3): five restarts, a
    1% agreement band, and "the searches differed" shown on the page.

Recorded 2026-11-13 (John), after Phase 2's experiment (§8.7):

12. **A routing is ranked by what the plan can spend** (§8.8). §8.1 ranked it
    by what it leaves, which lowered what the plan can spend on seven of eight
    profiles.
13. **The user sets a Depth before the search, and the result is the ranked
    list of every search** (§8.8). This replaces decision 11's fixed five
    restarts. The proposal after the experiment put the genetic search behind
    a "Search wider" button; John: the bench should list a wide array in the
    first place, with a depth value chosen up front so the cost of a wider
    list (more searching, more time) is known before it starts. It all runs
    locally, so the cost is acceptable.

Recorded 2026-11-13 (John), before Phase 3:

14. **The routing test does not use simulated markets.** One consistent path
    of returns is what lets the effect of a routing change be seen. The limit
    of §7 applies to the Spending test only, and the page says the routings
    are compared without it.
15. **The simulated-markets limit is on by default, at 90%** (§7).
16. **A plan already under the limit gets an answer below what was entered,**
    said in the same way as a plan that runs out as entered (§7.1).

Found while recording decision 2, and built into the design:

- **Ending value does not always fall as spending rises** (§2.1). The draft's
  solver halved an interval and kept a scan as a fallback. The scan is now the
  method.

## 15. Phases and cost

| Phase | Delivers | Effort |
|---|---|---|
| **1. The solver and the curve** | §3 with the first two limits, §4, §5 without the success limit, §5.1, Apply, Help, Rules, the UI spec. The strip, the bar chart and the genetic search leave the page. | about 3–4 days |
| **2. The routing search** | §8: the experiment (§8.5) first, then §8.8: the measure, the genes, Depth, the ranked list, prune, the agreement line, the third column | about 1–2 days for the experiment, then 4–6 |
| **3. Simulated markets as a limit** | §7 | about 2 days |
| **4. The MCP tool** | `max_spending`, README, SKILL | about 1 day |

Phase 1 is worth shipping alone. It removes every defect in §1.1, answers in
one to three seconds, and takes less room than what it replaces. Phase 2 follows it directly:
for a plan like Mid Career, routing is where the spending is.
