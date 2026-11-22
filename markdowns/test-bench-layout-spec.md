# Spec 18 — The Test Bench's layout: conditions, tests, and what a result was found under

Status: **DRAFT 2026-11-21, revised 2026-11-22.** Spec only, no code. On 2026-11-22 John revised loss years (1, 2 or 3 years, each with a loss the user types) and accepted pre-build refinements (Routing floor visibility, explicit Run in Phase 1, mid-year already-retired start year, loss-year input ergonomics, chart column switcher across tabs, and the simulated-markets non-stock draw note for Rules). The open decisions are in §10; nothing is built until they are answered.

The Test Bench is about to get more levers. Spec 17 added Market returns, and the next asked for is starting retirement with up to three years of losses. Today's controls are written as one sentence, and they already had to break onto a second row for Market returns. This spec gives the levers a layout that takes more of them, and defines the first new one: **loss years at the start of retirement**.

Five rules hold throughout:

- **Three kinds of lever, three places.** Conditions about the world sit above both tests. Limits belong to one test. Search effort belongs to the routing test (§2).
- **A result names what it was found under.** One line at the top of every result lists its conditions. It replaces the outlook captions scattered over the table, the notes and the chart.
- **Nothing on screen describes a different set of levers from the ones shown.** A changed lever dims every result it affects until it is run again.
- **The plan is never changed.** As in spec 17, conditions run on a copy, and saving keeps the user's own rates.
- **As entered is today.** With every condition at its neutral setting, every number is today's number, and a test pins it.

---

## 1. What exists

Measured 2026-11-21 on main (5a20a16), Mid Career, in the running app on an isolated origin.

### 1.1 The controls are a sentence

`js/components/test-bench.js` `render()` writes the spending test's limits as prose: "Spend the most that **never runs out** and leaves at least $[0] at the end, in today's dollars, [✓] and lasts in [90]% of simulated markets. [Run]". Spec 17 put Market returns on a row of its own under it, with a line saying what it does.

- **Desktop (1024×768):** the section is **1,289px** tall before any routing result: 103px of controls, 394px of spending result, 137px of routing controls and 456px of chart. A routing result adds its list and its changes table.
- **Phone (375px):** the section is **2,356px** tall, and the controls alone are **314px** before any result. The sentence wraps raggedly: "and lasts in" splits from its checkbox, and the Market returns control wraps Optimistic onto a second line. The Test Bench itself fits its column (293px). The page still lays out 593px wide because of other sections (UI review 2026-09-23, item 5).

### 1.2 The outlook is named in five places

Under Pessimistic or Optimistic, spec 17 names the outlook in the headline, in a line under the table, in the markets note ("On the plan's own path of returns, 1% a year higher than you entered, it could spend…"), in the routing caption and in the chart caption. A second condition done the same way would double each of those.

### 1.3 A change re-runs the test

A change to the floor, the markets limit or the market outlook re-runs the spending test when a result is on screen (`_setFloor`, `_setSuccess`, `_setOutlook`), and marks a routing list outdated (spec 17, decision 5). With the markets limit on, one run takes up to two minutes.

### 1.4 The tests are stacked

Spending, then Routing, then the chart, one under the other. The chart draws a column of the result table, and opens on the newest answer.

### 1.5 Tabs were rejected once, for the main page

In the UI review of 2026-09-23 (item 4, fixed in PR #94), John chose an outcome strip over tabs for the main page. Tabs were rejected because they break the timeline cursor, and because Chart.js draws at zero size in a hidden tab. Neither applies inside the Test Bench: it has no timeline cursor, its curve is SVG, and its one Chart.js chart stays outside the tabs (§3.4).

### 1.6 The engine can already change rates year by year

`js/chronometer.js` replays history on the plan's own path when `config.backtestYear` is set: on each New Year's Day it applies one historical year's rates (`applyBacktestForYear`), and restores the configured rates afterwards. The simulated markets (`js/mc-compute.js`, `runOnce`) draw one year at a time from the first January on or after retirement. Both are the hooks a loss-years condition needs (§4.5).

---

## 2. Three kinds of lever

| Kind | What it is about | Levers | Applies to | Changing it |
|---|---|---|---|---|
| **Conditions** | the world | Market returns (spec 17), Loss years (§4); later inflation, longevity | both tests, their checks and the chart | dims every result |
| **Limits** | what the user requires | never runs out (always on), leaves at least, lasts in N% of markets | the spending test (the floor also ranks routings) | dims the spending result, and a routing list when the floor changes |
| **Search effort** | how hard to look | Depth | the routing test | changes only how long the next search runs |

Conditions and limits behave differently, so they should not sit in the same sentence.

---

## 3. The layout

### 3.1 The Conditions card

At the top of the Test Bench, above both tests:

- **Title row:** "Conditions", with a line under it: "Apply to every test and the chart. Your plan is not changed." On the right, **Reset to as entered** puts every condition back to its neutral setting, and is hidden or disabled when every condition is already neutral.
- **One row per condition:** a label on the left, a segmented control, and one line under it saying what the setting on screen does. Market returns moves here from its row under the limits. Loss years is the second row (§4).
- **The neutral setting is first or centred and named plainly:** Moderate, None.
- **A row may carry inputs under its control.** Loss years carries one figure per year (§4.1).
- **A new condition is one more row.** Nothing else on the page changes to admit it.

### 3.2 The tests as tabs

Under the Conditions card, **Spending** and **Routing** become two tabs of one card (decision 1).

- **Spending:** the limits as a short form, one control each, not a sentence: Never runs out (always on, stated) · Leaves at least $[0] · [✓] Lasts in [90]% of simulated markets. Then Run. Then the result: headline, curve, table, what stops it, notes and Save, as today.
- **Routing:** Depth, the cost line, Search, and the list and changes, as today. Because **Leaves at least** also ranks routing results (§2) while living on the Spending tab, when the floor is above $0 the Routing tab shows a compact indicator (for example, "Ranking with floor: $500,000", with a link to edit it in Spending).
- Switching tabs keeps each tab's result. A routing result still adds its column to the spending table while the floor and conditions match, as today.

### 3.3 "Found under"

The first line of every result, above its headline: **Found under** followed by one chip per condition not at its neutral setting, then the data the markets used when a markets figure is on screen, for example:

> Found under · Optimistic (+1%) · 2 loss years (−30%, −20%) · Calibrated 1970–2025

- With every condition neutral and no markets figure, the line reads "Found under · your plan as entered".
- It replaces the outlook's other four mentions (§1.2): the line under the table, the clause in the markets note, the routing caption's clause and the chart caption's sentence. The headline keeps no clause either; the chips sit directly above it.
- The routing list carries its own Found under line: it was searched under the conditions at the time, plus a floor chip when **Leaves at least** is above $0 (for example, "Floor $500,000").
- **Save** writes the same chips into the scenario's note, as spec 17 does for the outlook.

### 3.4 The chart

Below the tabs, outside them, so Chart.js always draws visibly. When both a Spending result and a matching Routing result exist (same floor and conditions), the chart keeps its column switcher (**As entered · Spend the most · With this routing**) on one shared y-axis so the user can compare columns directly. Switching tabs switches the default selected column (**Spend the most** on Spending, **With this routing** on Routing), and the chart shows the active result's Found under line in its caption.

### 3.5 Run, and what dims

One rule for every lever, shipping in Phase 1 alongside the layout (decision 2):

- **A changed condition or limit dims the results it affects**, with one line: "Conditions changed. Run again." or "Limits changed. Run again." Nothing re-runs by itself.
- **Run** runs the spending test. **Search** runs the routing test. Each is explicit.
- **A click on the curve** sets the floor and runs at once, as today: it is an explicit action on the result.

This replaces spec 17's decision 5 (a changed outlook re-runs) right away, rather than waiting for Phase 2. Moving it into Phase 1 avoids changing the interaction model twice across two releases, and lets a user adjust more than one lever (for example, Floor and Market returns, or later Pessimistic and 2 loss years) without kicking off a run of up to two minutes on the first click and throwing it away on the second.

### 3.6 On a phone

- **The Conditions card collapses to its Found under line**, with an Edit link. Tapping opens the rows, stacked, each segmented control at full width. Loss years' figures sit on one row under it (three fields of about 80px fit at 375px).
- **Limits stack:** label above control, one per row.
- **The tabs stay.** Each holds one test, so a phone scrolls through one test, not both.
- Target: the controls above the first result under 200px when collapsed (314px today), and no wrapped segmented control at 375px.

---

## 4. Loss years at the start of retirement

### 4.1 What it is

A condition: **Loss years: None · 1 · 2 · 3**, and under it **one figure per year**: how far stock prices fall that year, as a percentage the user types (decision 6, John). The fields are labelled with their calendar years and carry a fixed `−` prefix outside the input so the direction is unmistakable:

> Loss years: None · 1 · **2** · 3
> 2031 [ − | 30 ]%  2032 [ − | 20 ]%
> Stock prices fall 30% in 2031 and 20% in 2032, 44% over the two years. For scale: since 1970 stocks have never lost more than 37.6% over one, two or three years in a row.

- **Each figure is a whole percentage from 0 to 100.** 0 is a flat year, and 100 is stocks worth nothing (§4.3). Because people naturally type `-30` for a 30% drop, the page input silently strips a leading `-` (`−`); an explicit `+` (a gain), a fraction, or anything above 100 is refused under the field ("A loss is 0% to 100%"), and Run waits until it is fixed. (The MCP parameter `lossYearsPercent` still refuses negatives so programmatic callers do not mix sign conventions, §4.8.)
- **A new year's field starts at 20%** (decision 7): one year at 20% is a bad but ordinary bear market (2002 −22.1%, 2022 −18.1%), and two at 20% (−36%) is about history's worst run.
- **Changing the count keeps the figures** while the page is open: 3 → 1 → 3 brings back years 2 and 3 as they were typed.
- **The line under the control** says what the figures do, with the combined fall, and gives the same scale line whatever is typed. History's worst runs, from the market data (1970–2025, dividends included):

| Years in a row | Worst | Fall |
|---|---|---|
| 1 | 2008 | 37.0% |
| 2 | 1973–1974 | 37.2% |
| 3 | 2000–2002 | 37.6% |

So the line never calls a typed figure "realistic". It says how far history went, and the user doomsdays from there.

### 4.2 What moves

**Stocks only** (decision 4). A typed loss applies to the assets the simulated markets give stock returns: brokerage, IRA, Roth IRA and 401K. An IRA or 401K counts as stock even if it holds bonds, as it does in every simulated market. US Treasury and corporate bonds keep their own rate on the plan's own path, and take their draw in the simulated markets. Expenses and incomes do the same. A bond loss, if wanted, is one more figure per year, and the engine field leaves room for it (§4.7).

### 4.3 How a year is applied

**The stock assets' rate for that year is the typed figure**, as a fall in price (decision 3):

- **Exact.** The engine compounds a market rate by the twelfth root, so a stock account with no money in or out and no dividend ends the year at exactly (1 − loss) of its start. The quick starts carry no dividend rate, so for them the typed figure is the account's whole loss.
- **Dividends keep paying** at the asset's own rate on the lower balance, so an account that has a dividend rate falls a little less than the figure (about its yield).
- **A 100% loss** empties every stock account in the year's first month, and money paid into one that year is lost with it. No rate goes below −100%, so nothing turns into NaN. The measurement phase checks what an emptied brokerage does with its basis (§11).
- **Nothing else moves a typed figure** (decision 5). This holds in both data modes. Calibrated mode's distance from the pool average is not added, and historical mode's dividend subtraction is not made. The market outlook's 1% is not added either (§4.6). A user who types 30% sees 30%.

### 4.4 When

**The first one, two or three calendar years starting with the first January on or after both the retirement date and the plan's start date.** Every loss year therefore begins on January 1 and runs a full twelve months, so a typed 30% delivers a full 30% fall (§4.3) and matches `chronometer.js` and `mc-compute.js`'s New Year's Day hook. Specifically:

- **A plan retiring mid-year** (for example, June 2031) starts its loss years in **2032**.
- **A plan starting mid-year already retired** (for example, October 2026, like the `Retired` quick-start loaded mid-year) leaves the remaining months of 2026 unchanged and starts its loss years in **2027**.
- **A plan starting in January already retired** (for example, January 2026) starts its loss years in **2026**.
- If the plan ends before the last loss year, only the years inside it apply, and the line says so. A plan that retires after its last year has no loss years, and the line says that too.

### 4.5 Both paths

- **The plan's own path:** the stock assets run at the typed figures in those years. Every other year, and every other asset, runs as entered (or under the outlook).
- **Simulated markets:** each market still draws its years as today, so in a typed loss year only the stock assets take the typed figure — CPI inflation, wages and Treasury yields still come from that trial's random historical draw (a typed crash is not automatically paired with a recession year's inflation or Treasury yields, and `rules.html` says so plainly). "Lasts in 90% of markets" under 2 loss years means 90% of markets that all began retirement with that crash. The Found under chip is what keeps that from reading as an ordinary 90%.
- **Routing** ranks routings on the own path with the loss years in it, so a routing can be found for a bad start.

### 4.6 With the market outlook

**The outlook moves every year except a typed loss** (decision 5). Under Pessimistic, a typed 30% stays 30%. The outlook is about ordinary years, and a figure the user typed should not come back 1% different.

- **On the plan's own path,** a loss year replaces the outlook copy's shifted rate. The next January restores that shifted rate.
- **In the simulated markets,** a loss year reads neither the copy's base rates (calibrated) nor `returnShift` (historical).

### 4.7 Where it lives in the engine

A new SimConfig field, `returnSchedule`: a list of `{ year, stocks }`, where `stocks` is that calendar year's price change for the stock assets (−0.30 for a 30% loss). The field is named for its asset kind so a `bonds` figure can join it later. It is absent by default, so every run and the snapshot are unchanged.

- **`chronometer.js`:** on a scheduled year's New Year's Day (and before the first month when the plan itself starts on January 1 of a scheduled year, mirroring `backtestStartYear`), sets the stock assets' rate to `stocks`, and restores the configured rate the next January. With `backtestYear` also set, a scheduled year's stock rate replaces the backtest's.
- **`mc-compute.js` `runOnce`:** in a scheduled year (including before the first month when the plan starts on January 1 of a scheduled year), draws as usual and then sets the stock assets to `stocks`. No base rate is added, and no `returnShift`.
- **`makeSimConfig`:** refuses unknown fields, so `returnSchedule` is added to its known list. It also refuses a rate below −1 or not finite, and a year listed twice. The engine accepts any rate from −1 up, so a gain could come later; it is the page and MCP that allow only losses.
- **The Test Bench** builds the schedule from the plan's retirement date, the plan's start date, and the figures. A worker gets it in its payload, because a worker builds its config from the settings snapshot (trap 3).

### 4.8 MCP

`max_spending` gains `lossYearsPercent`, under spec 16's one rule: a list of up to three whole numbers from 0 to 100, one per year. `[30, 20]` means 30% in the first loss year and 20% in the second. The default is `[]`, no loss years.

- **Refused:** more than three entries; a negative; a figure above 100; a fraction. A fraction is refused so that 0.3, meant as 30%, does not run as 0.3%. The refusal message says to pass 30.
- **The report** names the loss years and their calendar years in the Found under line and the headline.
- **The plan handed back** has no loss years in it, because they are a condition, not part of the plan, and the report says so.

---

## 5. Words

Each condition supplies three strings, all from one headless module (`js/market-outlook.js` today, renamed to `js/test-conditions.js` when the second condition lands):

- **its chip label** for the Found under line: "Optimistic (+1%)", "2 loss years (−30%, −20%)". None at its neutral setting;
- **the line under its control**, saying what the setting on screen does;
- **the clause for the save note** and the MCP report: "with stock and bond returns 1% a year higher than you entered", "with stock prices falling 30% in 2031 and 20% in 2032".

The Found under line is those chips joined by " · ", plus the markets' data ("Calibrated 1970–2025") when a markets figure is on screen. Nothing else on the page restates a condition.

---

## 6. Presentation surfaces, enumerated

- `js/components/test-bench.js`: the Conditions card, the tabs, the limits form, Found under, the dim-and-Run rule, the phone collapse.
- `index.html`: Test Bench styles, including the phone rules.
- `js/spending-report.js`: the headline and the markets note lose the outlook clause; Found under takes its place.
- `js/finplan-app.js`: the save note from the conditions' clauses.
- `js/mcp/max-spending.js`, `js/mcp/mcp-server.js`: `lossYearsPercent`, the Found under line.
- `help.html` Test Bench section: the Conditions card, Loss years and their figures, Found under, Run.
- `rules.html` Test Bench section: how a loss year is applied (stocks only, as a fall in price, the same in both data modes, untouched by the outlook), when it starts, and that in simulated markets a typed loss year overrides stocks only while CPI inflation, wages and Treasury yields still come from that trial's random historical draw.
- `plugin/README.md`, `plugin/skills/charting-finance/SKILL.md`: `lossYearsPercent`, and that a markets figure under loss years is conditional on that start.
- `markdowns/market-outlook-spec.md` (spec 17): decision 5 superseded by §3.5; one line pointing here.

The static pages change in the same PR as the behaviour.

---

## 7. Traps this codebase has already hit

1. **A condition that reaches only some runs.** Spec 17's outlook had to reach the solver, the markets limit, the check rows, the confirmation run, the guardrails row, the routing test, the routed column's checks and the chart. `returnSchedule` has the same list, and a test checks each, as spec 17's stand-in Worker does.
2. **A typed figure moved by something else.** The calibrated deviation, the outlook's base rates or `returnShift`, and the historical dividend subtraction are each applied to a drawn year today. None of them may touch a loss year (§4.3).
3. **Workers build their config from a snapshot.** A field set on the page's config does not reach a worker unless the payload carries it (worker globals snapshot).
4. **The chart runs on the page.** `benchPlan` builds its own config (`simConfigFromGlobals`); it must carry the schedule, or the chart draws a plan without the loss years under a table with them.
5. **Saving the copy.** A save or an MCP handle built from the conditioned plan would write the conditions into the user's plan.
6. **Clock-pinned fixtures.** The loss years are calendar years from the retirement date, and quick-start dates come from the wall clock. Every test pins it.
7. **Hidden content in tabs.** Nothing that measures itself (Chart.js) may sit in a hidden tab (§1.5).
8. **The plugin install does not follow `main`.** Bump `plugin.json`, rebuild with `npm run build:plugin`, check the install separately.
9. **An emptied account.** A 100% loss leaves a brokerage at $0 with its basis still on it, and contributions that year arrive and vanish. Nothing has run that way before; measure it before shipping (§11).

---

## 8. Fixtures and tests

- **As entered is today:** with every condition neutral, the solver's result, the checks and the measured rates equal today's on every quick-start profile; the snapshot is unchanged.
- **The schedule:** in a scheduled year every stock asset's rate is exactly the typed figure. That holds in both data modes and under every outlook. Treasury, corporate bonds, bank, expenses and incomes keep their rate (own path) or their draw (markets). The rate is undone the next January, and an empty schedule changes nothing.
- **Exact:** a stock account with no flows and no dividend ends a 30% loss year at exactly 70% of its start. With a dividend rate it ends higher by its dividends.
- **100%:** a 100% year empties every stock account with no NaN anywhere in the run. Money paid in that year is lost, and the next January the account earns again.
- **When:** the loss years are the first calendar years starting with the first January on or after both the retirement date and the plan's start date. Covered cases: a plan retiring mid-year, a plan starting mid-year already retired (leaves the partial starting year unchanged and starts the next January), a plan starting in January already retired (starts that year), a plan ending before its third loss year (only the years inside it), and a plan retiring after its last year (none).
- **Both paths:** in a market's loss years the stock assets take the typed figures and everything else takes the draw; the own path runs them; the routing test ranks with them.
- **Order, as a sample, not a law:** on every quick-start profile, the own-path answer under 3 years at 20% is ≤ 1 year at 20%, which is ≤ None. Taxes can bend this, so a failure is a question to look at, not a bug by itself.
- **With the outlook:** under Pessimistic and Optimistic, in both data modes, a scheduled year's stock rate is the typed figure, and the year after it is the copy's shifted rate.
- **Entry:** the page strips a leading `-` (`−`) and refuses an explicit `+`/gain, a fraction, a figure above 100 and a fourth year; `lossYearsPercent` refuses a negative, a fraction, a figure above 100 and a fourth year. Changing the count keeps the figures typed.
- **Every run gets it:** the stand-in Worker of `tests/market-outlook.mjs` checks the payload of each job, and the chart's plan carries the schedule.
- **Saving and MCP:** a saved scenario and `max_spending`'s handed-back plan have no schedule and the user's own rates; the note and the report name the loss years.
- **Layout:** Found under lists exactly the non-neutral conditions (plus the active floor chip on the routing list when `Leaves at least > $0`); the Routing tab shows the floor indicator whenever `Leaves at least > $0`; a changed condition or limit dims affected results and starts nothing; Reset puts every condition back and is hidden or disabled when all conditions are neutral; the chart keeps its 3-column switcher when matching Spending and Routing results exist and defaults to the active tab's column.
- **Mutations that must be caught:**
  - the schedule applied to bank, cash or a Treasury;
  - applied in the wrong year;
  - not undone the next January;
  - dropped from a worker payload;
  - dropped from the chart's plan;
  - `returnShift` added to a loss year;
  - the calibrated deviation added to a loss year;
  - the dividend rate subtracted from a loss year;
  - a market's loss year using its draw for stocks;
  - a save built from the conditioned plan;
  - Found under missing a condition;
  - the figures dropped when the count changes.

---

## 9. Not in scope

- **Compare conditions:** the same test under several conditions, as rows of one small table. The layout leaves room for it; it is its own spec.
- **An inflation condition, a longevity condition.** Each would be one more row (§3.1).
- **Loss years before retirement,** or anywhere other than its start.
- **Gain years,** or a typed figure for bonds, inflation or wages. `returnSchedule` leaves room for a bond figure (§4.7); each is its own decision.
- **More than three loss years.**
- **The rest of the page's phone overflow** (UI review 2026-09-23, item 5).

---

## 10. Decisions

Each has a recommendation; John decides.

1. **Tabs for the two tests, or stacked with one collapsed.** Recommend **tabs**. The main page's objections to tabs (§1.5) do not apply here, and tabs halve what a phone scrolls through. The alternative keeps both stacked and collapses the one not in use.
2. **Explicit Run for every lever.** Recommend **yes, in Phase 1 alongside the layout** (rather than waiting for Phase 2). It supersedes spec 17's decision 5 (a changed outlook re-runs) right away so the interaction model changes once instead of twice, and adjusting multiple levers (such as Floor and Market returns) never triggers an unwanted two-minute run on the first click.
3. **What a typed figure means.** Recommend **a fall in price**: the rate is the figure, and dividends keep paying (§4.3). It is exact, a 100% loss needs no special case, and it is how a crash is usually quoted ("stocks fell 30%"). The alternative is **the account's whole loss, dividends included**, the meaning of the market data's own figures. That needs the dividend taken out of the rate first, and a floor at −100% where loss and dividend together pass it. The quick starts carry no dividend rate, so for them the two agree.
4. **Stocks only.** Recommend **yes**: one figure per year, and bonds keep their rate or their draw. The alternatives: one figure for stocks and bonds both, which would sink a Treasury account 30% when Treasuries gained in 2008; or a second figure per year for bonds, which doubles the fields.
5. **Nothing moves a typed figure.** Recommend **yes**: neither the data mode nor the market outlook changes it, so 30% typed is 30% run. This reverses the draft's earlier recommendation, made when a loss year was a historical year; a typed figure is the user's own.
6. **How many loss years, and what each is.** **Decided (John, 2026-11-22):** None, 1, 2 or 3, each with its own loss as a percentage. Recommend **whole percentages from 0 to 100**: 100 lets a user empty every stock account, which is the doomsday John asked for.
7. **The figure a new year starts at.** Recommend **20%** (§4.1). The alternatives: 30%, or 2008's 37%.
8. **Conditions are not saved with the plan.** Recommend **not saved**, as spec 17 decided: every load starts with every condition neutral, and the typed figures are forgotten.
9. **MCP `lossYearsPercent`.** Recommend **yes**, under spec 16's one rule, with the refusals of §4.8.
10. **The phone collapse of §3.6.** Recommend **yes**.
11. **The data chip in Found under.** Recommend showing it **only when a markets figure is on screen**, since the plan's own path does not use the pool, and loss years do not use it either.

---

## 11. Phases and cost

1. **Layout and explicit Run, no new condition.** The Conditions card with Market returns alone (and Reset hidden/disabled when neutral), the tabs (with the Routing tab's floor indicator when `Leaves at least > $0`), the limits form, Found under replacing the outlook's captions (plus the floor chip on the routing list when `> $0`), the chart under the tabs keeping its 3-column switcher, explicit Run + dim-on-change for every lever (decision 2, superseding spec 17 decision 5), and the phone collapse. The snapshot and every number are unchanged; the work is the page, its styles, Help, Rules and spec 17's pointer. A browser check at 1024px and 375px on an isolated origin.
2. **Loss years.**
   - **First, measure:** run the quick starts under 1, 2 and 3 years at 20%, on the own path and at 90% of markets. Run one profile with a brokerage at 100%, for NaN and for what the emptied account does with its basis and that year's contributions (trap 9). Write the results into §4 before the control ships.
   - **Then build:** `returnSchedule` in SimConfig, `chronometer.js` and `runOnce`; the condition's row and its figures (with the fixed `−` prefix and leading-`-` stripping in the UI); `lossYearsPercent` on `max_spending`; Help, Rules and the plugin docs. Plugin bump.

---

## Sources

- `js/components/test-bench.js` (`render`, `_renderResult`, `_renderRouting`, `_renderChart`, `_setFloor`, `_setSuccess`, `_setOutlook`), `index.html` (Test Bench styles, the 860px grid rule).
- `js/test-bench-run.js` (`benchPlan`, `simFor`, `checkJobs`, `runTestBench`, `runRoutingTest`), `js/mc-worker.js`.
- `js/chronometer.js` (`applyBacktestForYear`, `inflationRateForYear`), `js/mc-compute.js` (`runOnce`, `applyRandomRates`, `buildYearPool`), `js/sim-config.js` (`makeSimConfig`, its known fields), `js/market-data.js`.
- `js/market-outlook.js` (`isStockOrBond`, the outlook's words), `markdowns/market-outlook-spec.md` (spec 17, decision 5).
- The UI review of 2026-09-23 (items 4 and 5).
- Measured 2026-11-21: the section's heights at 1024×768 and 375px; the market data's worst years (2008 −37.0%, 1974 −26.5%, 2002 −22.1%, 2022 −18.1%) and worst two-year stretches (1973–1974 −37.2%, 2007–2008 −33.5%, 2001–2002 −31.4%).
- Measured 2026-11-22: the worst three-year stretches (2000–2002 −37.6%, 1972–1974 −25.3%, 2006–2008 −23.0%); `js/instruments/instrument-behavior.js` (growth by `asMonthlyEffective`, then dividends reinvested by `asMonthlyNominal`); `js/utils/arr.js` (the twelfth root); the quick starts carry no dividend rate.
- Discussion with John, 2026-11-21 and 2026-11-22.
