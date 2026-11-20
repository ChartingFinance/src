# Spec 17 — Market outlook on the Test Bench: stock and bond returns 1% better or worse

Status: **DECIDED 2026-11-19 (§10), and built** on branch `claude/market-outlook`. John chose ±1% over leaving years out and stocks and bonds only, then agreed to all seven recommendations in §10.

The Test Bench answers "how much can this plan spend?" on the returns the user entered, and, with the simulated-markets limit on, across history's returns re-centred on them. This spec adds one control: **Market returns: Pessimistic (−1%), Moderate, Optimistic (+1%)**. Pessimistic and Optimistic run the whole test with every stock and bond return one percentage point a year lower or higher. Moderate is the Test Bench as it is today.

Five rules hold throughout:

- **One number.** Stock and bond returns move by 1% a year. Nothing else changes: not inflation, wages, cash, real estate, debt or the plan's expenses.
- **One outlook per test, everywhere in it.** The plan's own path, the simulated markets, the guardrails check, the routing test and the chart all run under the outlook the test started with.
- **The plan is never changed.** The outlook is applied to a copy for the test. Saving a result keeps the user's own rates.
- **Moderate is today, exactly.** Every number the Test Bench shows at Moderate equals today's, and a test pins it.
- **The page says which outlook a result is under.** A result is never shown without it.

---

## 1. What exists

### 1.1 The Test Bench

- `js/components/test-bench.js` runs two tests of the plan on screen, through `js/test-bench-run.js`, in simulation workers (`mc-worker.js`).
- **Spending** (`js/spending-solver.js`): the most the plan can spend that never runs out and leaves the floor. With the simulated-markets limit on (the default, at 90%), `js/success-limit.js` turns the answer down until the plan lasts in that share of 300 simulated markets.
- **Routing** (`js/routing-search.js`): searches for better transfer percentages, ranked by what the plan could spend under each. It runs on the plan's own path only (spec 15, decision 14).
- **The chart** (`js/test-bench-chart.js`) runs each column of the result table again from `benchPlan(plan)`, the copy the test ran on.
- **Saving** sends only `{ factor, lifeEvents? }` (`testbench-save`). The app scales the expenses of the plan on screen by `factor` (`saveSpendingAsScenario`) and writes a note: "From the Test Bench: every monthly expense at the most the plan can pay for."
- A change to the floor or the markets limit re-runs the spending test when a result is on screen (`_setFloor`, `_setSuccess`). A change to the floor marks the routing list outdated.

### 1.2 Where returns come from

- **The plan's own path:** each asset's `annualReturnRate`, as entered. For a stock or bond asset that is also its effective rate (`ModelAsset.effectiveAnnualReturnRate` substitutes plan inflation only for an expense left at 0).
- **Simulated markets** (`js/mc-compute.js`): each simulated year draws one whole historical year from the pool (`buildYearPool`: 1970–2025, 56 years), so that year's stocks, bonds, inflation and wages arrive together. `applyRandomRates` overwrites:
  - **stocks**, from the S&P 500: `taxableEquity`, `ira`, `rothIRA`, `401K`;
  - **bonds**, from the 10-year Treasury: `usBond`;
  - expenses from CPI, and incomes from wage growth.

  `corpBond`, `bank`, `cash`, real estate and debt keep their own rates in every market.
- **Two data modes** (the Simulations section's; `simDataMode`, default `calibrated` in `js/sim-config.js`):
  - `calibrated`: a draw is the asset's own rate plus that year's distance from the pool's long-run average (`calibrationBaseRates`). The user's assumptions, with history's swings.
  - `historical`: a draw is the year's raw return, minus the asset's dividend rate. The asset's own rate is not used.

### 1.3 Caches

`test-bench-run.js` keeps the plan as entered's checks (`enteredCache`) and the rates the markets limit measured (`rateCache`), keyed by `JSON.stringify([base, entered, guardrailParams, simDataMode])`: the plan's assets as the test received them.

### 1.4 MCP

`max_spending` (`js/mcp/max-spending.js`) is the Spending test over MCP. It solves on `spec.modelAssets` and returns a handle for the plan at the answer, built as `solvedAssets(spec.modelAssets, factor)`. `simulatedMarketsPercent` turns the markets limit on, in the plan's data mode.

---

## 2. The measurement the design rests on

John proposed two ways to tilt the markets (2026-11-19): leave the two worst or two best years out of the pool, or move every drawn year's return by 1%. Both were measured before choosing.

**On the pool** (the S&P series alone, 20,000 runs of 30 years, raw returns; scratch script, not the engine):

| Outlook | Pool's long-run average | 30-year annual return, 10th percentile | Median |
|---|---|---|---|
| Moderate | 11.1% | 6.8% | 11.2% |
| Leave out the 2 worst years (2008, 1974) | 13.1% (+2.0) | 9.5% (+2.7) | 13.2% (+2.0) |
| Leave out the 2 best years (1995, 1975) | 10.2% (−0.9) | 6.0% (−0.8) | 10.3% (−0.8) |
| +1% | 12.1% (+1.0) | 7.8% (+1.0) | 12.2% (+1.1) |
| −1% | 10.1% (−1.0) | 5.8% (−1.0) | 10.2% (−1.0) |

Leaving years out was rejected:

- **It is lopsided.** The worst years are further from the average (−37%, −26.5%) than the best are (+37%), so Optimistic moved twice as far as Pessimistic.
- **Optimistic deletes the crash tail**, which is what the 90% limit measures: +2.7 points at the 10th percentile.
- **In `calibrated` mode it would mostly undo itself.** `buildYearPool` takes the long-run average from the pool's own years, so a trimmed pool re-centres on the user's rate and only the spread narrows.
- **It touches the simulated markets only.** With the limit off, or in the routing test, it changes nothing.
- **"Two years" drifts in meaning** as each year's data is added, and with a backtest era it is a larger share of a smaller pool.

**On the answer** (the Spending test on the plan's own path, the markets limit off, every quick-start profile, stock and bond rates moved as §3 says; measured 2026-11-19, so quick-start dates are this month's):

| Profile | As entered | −1% | Moderate | +1% | −1% vs Moderate | +1% vs Moderate |
|---|---|---|---|---|---|---|
| earlyCareer | $3,840 | $3,650 | $3,659 | $3,665 | −0% | +0% |
| midCareer | $5,185 | $5,082 | $5,316 | $5,545 | −4% | +4% |
| preRetirement | $3,990 | $5,576 | $5,638 | $5,705 | −1% | +1% |
| retired | $4,489 | $9,057 | $9,503 | $9,967 | −5% | +5% |
| youngCouple | $4,869 | $7,619 | $7,627 | $7,642 | −0% | +0% |
| dualIncome | $5,989 | $9,080 | $9,412 | $9,561 | −4% | +2% |
| coupleNearingRetirement | $5,486 | $9,670 | $10,062 | $10,165 | −4% | +1% |
| retiredCouple | $5,985 | $13,441 | $14,061 | $14,709 | −4% | +5% |

"As entered" is the plan's spending as entered at Moderate. Under Pessimistic, Mid Career as entered runs out (May 2066), so its headline there takes the "cannot all be paid" form (PR #137). Early Career as entered runs out in 2030 under every outlook.

Three findings:

1. **The answer moves the same way as the outlook on every profile**: Pessimistic ≤ Moderate ≤ Optimistic. A test pins this (§9).
2. **The size is a few percent, not 1% of anything.** A point of return over decades is worth 4–5% of spending to a plan that lives on its investments.
3. **Some plans barely move.** When what stops spending is not returns, no outlook changes the answer. Early Career moves $15 across all three: what stops it is October 2035, while still working, when its everyday money runs out and bills go unpaid with $174K in the 401K and $62K in the Roth IRA, because the plan does not draw retirement accounts to pay a bill. Young Couple stops the same way in December 2036. The page must not let that read as the control being broken (§4.3).

---

## 3. The outlook

### 3.1 What moves

- **Stock and bond assets:** `taxableEquity`, `ira`, `rothIRA`, `401K`, `usBond`, and `corpBond` (decision §10.2). Each one's `annualReturnRate.rate` moves by +0.01 (Optimistic) or −0.01 (Pessimistic). 7% becomes 8% or 6%.
- **The growth part only.** The dividend rate (`annualDividendRate`) is unchanged, so growth plus dividends, the total return, moves by exactly 1%. The extra return is growth, taxed as growth.
- It compounds as any measured rate does, by the twelfth root (the compounding convention of #72).
- **Nothing else moves:** expenses (inflation), incomes (wages), `bank`, `cash`, `realEstate`, `mortgage`, `debt`, `pension`, `retirementIncome`. Inflation stays as entered, so the 1% is 1% of real return too.

### 3.2 One copy, made at the start of a test

- A new headless module, `js/market-outlook.js`:
  - `MarketOutlook`: `pessimistic` (−0.01), `moderate` (0), `optimistic` (+0.01);
  - `isStockOrBond(instrument)`: the six instruments of §3.1, the one list every reader uses;
  - `outlookAssets(modelAssets, outlook)`: a copy of the assets with those rates moved. It changes nothing it is given, and at `moderate` it returns an exact copy.
- The Test Bench applies it once, to the plan it reads when a test starts (`run()`, `runRouting()`). Everything after that receives the copy: `runTestBench`, `runRoutingTest`, `benchPlan`, the checks and the chart. No later step applies the outlook again.

### 3.3 In simulated markets

- **`calibrated`:** a draw adds the year's deviation to the asset's own rate (`calibrationBaseRates`), and the copy's rate already carries the 1%. Nothing more is needed.
- **`historical`:** a draw overwrites the rate with the raw year, so the copy's 1% is lost for the assets the markets draw. `applyRandomRates` gains a `returnShift` argument, added to the drawn stock and bond rates **in `historical` mode only**. `computeMonteCarlo`, `simulatedRate` (`sim.returnShift`) and the worker payloads carry it.
- `corpBond` is never drawn, so in both modes it keeps the copy's moved rate in every market, as it keeps its own rate today.
- **Never both.** Adding `returnShift` in `calibrated` mode would count the 1% twice. A test pins this (§9).

### 3.4 Moderate

`moderate` is not a special case in the code: `outlookAssets` moves rates by 0 and `returnShift` is 0. So every number at Moderate is today's number, and a test compares them on every quick-start profile.

---

## 4. On the page

### 4.1 The control

- In the Test Bench's limits, beside the floor and the markets limit: **Market returns** with three choices, **Pessimistic (−1%)**, **Moderate** and **Optimistic (+1%)** (labels: decision §10.3).
- A line under it: "Stock and bond returns 1% a year lower / higher than you entered. Inflation, wages and cash stay as entered."
- It starts at Moderate. It is a setting of the Test Bench, like the floor, and is not saved with the plan (decision §10.4).
- Changing it re-runs the spending test when a result is on screen, as the floor and the markets limit do (decision §10.5). It marks the routing list outdated: "The plan, its settings, the floor or the market outlook changed after this test. Search again."

### 4.2 The result

- **The headline names the outlook** when it is not Moderate: "With stock and bond returns 1% a year higher than you entered, the most this plan can spend is $5,545 a month, $359 a month more than you entered (+7%)." (Mid Career.) At Moderate the headline is today's.
- **Above the table**, when not Moderate: "Every column assumes stock and bond returns 1% a year lower than you entered."
- **"As entered" is the plan as entered under the outlook.** So at Pessimistic or Optimistic it is not the Outcome card's figure. Spec 15's rule (the first column is the Outcome card's number) holds at Moderate, and the line above the table is why the two differ otherwise.
- **The markets note** (`successNote`) is unchanged, read under the outlook: "On the plan's own path of returns…" becomes "On the plan's own path of returns, 1% higher…" when not Moderate.
- **"What stops you"** is unchanged.

### 4.3 When the answer barely moves

The page shows one outlook at a time and does not run the other two, so it cannot say how far the answer moved. Help says it instead (§7): "If changing the outlook barely moves the answer, returns are not what limits this plan. What stops you names what does."

### 4.4 Saving

- Saving sends `{ factor, lifeEvents?, outlook }`. The app applies `factor` and the routing to the plan on screen, with the user's own rates, as today. The copy is never saved.
- When the outlook is not Moderate, the note says so: "From the Test Bench: every monthly expense at the most the plan can pay for, with stock and bond returns 1% a year higher than entered. The saved plan keeps your own return rates." (decision §10.7)

---

## 5. The routing test

- It runs on the outlook copy, so a routing is ranked by what the plan could spend under that outlook. The best routing can differ between outlooks: higher stock returns favour routing more into stock accounts.
- The selected routing's column, its guardrails check and its markets check run under the same outlook.
- The list records the outlook it was run under, and a change marks it outdated (§4.1).

---

## 6. MCP

- `max_spending` gains `marketOutlook`: `"pessimistic"`, `"moderate"` (the default) or `"optimistic"` (decision §10.6).
- It solves on `outlookAssets(spec.modelAssets, outlook)`, and passes `returnShift` to the markets limit when that is on.
- **The handle it returns is for the plan at the answer with the user's own rates:** `solvedAssets(spec.modelAssets, factor)`, as today, never built from the copy. Run as it stands, that plan has the user's returns, not the outlook's, and the report says so: "The handle is for the plan at this spending with your own return rates. Under them it may not last; this answer assumed returns 1% a year higher."
- The report's headline and table name the outlook, in the page's words.
- `plugin/skills/charting-finance/SKILL.md` says what the outlook is and is not: a stress of the return assumption, one point either way; not a forecast, and not a probability.
- `plugin/.claude-plugin/plugin.json` is bumped and the bundle rebuilt (trap 8).

---

## 7. Presentation surfaces, enumerated

- `js/components/test-bench.js`: the control, the stale and outdated rules, the line above the table, the save detail.
- `js/spending-report.js`: `spendingHeadline`, `successNote` and the table's lead line take the outlook.
- `js/finplan-app.js`: the save note.
- `help.html` Test Bench section: what the outlook does, what it does not move, why Moderate's first column is the Outcome card's and the others are not, and §4.3's sentence.
- `rules.html` Test Bench section: which instruments move, the growth-only rule, the two data modes.
- `plugin/README.md`, `SKILL.md`, `mcp-server.js` (the tool's description and schema).
- `markdowns/maximizer-goal-floor-spec.md` (spec 15): one line in §7 pointing here.

The static pages change in the same PR as the behaviour.

---

## 8. Traps this codebase has already hit

1. **Saving the copy.** The test runs on a copy with moved rates; a save or an MCP handle built from it would write the outlook into the user's plan for good. Both paths take the user's assets, and a test checks the saved rates.
2. **Counting the 1% twice.** In `calibrated` mode the copy carries it; `returnShift` must stay 0 there.
3. **Caches keyed on the wrong plan.** `enteredCache` and `rateCache` are keyed by the assets the test receives. Because the outlook is applied before the test starts, each outlook gets its own key. A key built from the uncopied plan would hand Optimistic's measured rates to Pessimistic.
4. **The chart drawing a different plan.** The chart reruns columns from `benchPlan`; it must be the copy, or Moderate's bars sit under an Optimistic table.
5. **A copy that is not the plan** (#126). `outlookAssets` copies the serialized form, as `scaledAssets` does, and a test checks it is exact at Moderate.
6. **Clock-pinned fixtures.** Quick-start dates come from the wall clock; every test here pins it.
7. **Green is not evidence.** Mutation-verify §9's load-bearing checks.
8. **The plugin install does not follow `main`.** Bump `plugin.json`, rebuild with `npm run build:plugin`, check the install separately.

---

## 9. Fixtures and tests

- **`outlookAssets`:** moves exactly the six instruments of §3.1 by ±0.01, leaves every other field and asset equal, leaves dividend rates alone, changes nothing it is given, and is an exact copy at Moderate.
- **Moderate is today:** on every quick-start profile, the solver's result, the checks and the measured rates at Moderate equal those with no outlook at all.
- **Order:** on every quick-start profile, Pessimistic ≤ Moderate ≤ Optimistic on the plan's own path (§2, finding 1).
- **`calibrated`, no double count:** a markets run with an outlook equals a run of the moved copy with `returnShift` 0, and a drawn stock rate equals the copy's rate plus the year's deviation.
- **`historical`:** a drawn stock or `usBond` rate equals the raw year less dividends, plus `returnShift`; `corpBond` keeps the copy's rate.
- **Caches:** a Pessimistic test after an Optimistic one on the same plan measures its own rates.
- **Saving:** after an Optimistic result, the saved scenario's stock and bond rates equal the plan's, and its note names the outlook.
- **MCP:** `marketOutlook` changes the answer; the returned handle's spec has the user's rates; the report names the outlook; an unknown value is refused.
- **Mutations that must be caught:** the shift applied to `bank` or `cash`; the shift on the dividend rate; `returnShift` added in `calibrated` mode; `returnShift` left out in `historical` mode; the cache key taken before the copy; the chart given the uncopied plan; the save built from the copy; the MCP handle built from the copy.

---

## 10. Decisions

### 10.1 Decided (John, 2026-11-19)

- **Move every return by 1%, not leave years out** (§2).
- **Stocks and bonds only:** inflation and wages are not moved.

### 10.2 to 10.8 Decided (John, 2026-11-19: "Agreed on all seven")

Each was agreed as recommended.

2. **Corporate bonds.** The simulated markets never draw `corpBond`; it keeps its own rate. Move it with the other bonds? Recommend **yes**: it is a bond, and since it is never drawn its moved rate holds in every market, in both modes.
3. **Labels.** Recommend **Pessimistic (−1%) · Moderate · Optimistic (+1%)**, the size in the label, so nobody reads "Pessimistic" as a forecast of a bad decade.
4. **Saved or not.** Recommend **not saved**: the control starts at Moderate on every load, as the floor starts at $0, so a plan never opens under a tilt nobody remembers choosing.
5. **A change re-runs the test.** Recommend **yes**, as a change to the floor or the markets limit does; the routing list is marked outdated, not re-run, because a routing test takes minutes.
6. **MCP.** Add `marketOutlook` to `max_spending`, default Moderate. Recommend **yes**, under the one rule of spec 16 (the same tools in the app and over MCP).
7. **The saved scenario's note names the outlook.** Recommend **yes**: a plan saved at Optimistic's spending will not last at its own returns, and the note is the only place that says why.
8. **Where it lives.** Recommend **the Test Bench only**. The Simulations section, the Outcome card and the timeline keep the plan's own returns, so the page's headline numbers always describe the plan as entered.

---

## 11. Not in scope

- **A bad start.** Drawing the first years of retirement from the worst years is the classic test of sequence risk (early losses hurt more than late ones). It is a different question from a 1% tilt and would get its own spec.
- **A size other than 1%,** or a free-form shift.
- **Moving inflation or wages.**
- **The Simulations section, the Outcome card, Guardrails as a section.**
- **Leaving years out of the pool** (measured and rejected, §2).

---

## 12. Phases and cost

One PR, in three commits:

1. **The engine:** `js/market-outlook.js`, `returnShift` through `applyRandomRates`, `computeMonteCarlo`, `simulatedRate` and the worker payloads, with §9's engine tests and their mutations. The snapshot harness (`node tests/tools/snapshot.mjs`) must stay unchanged: nothing outside the Test Bench changes.
2. **The page:** the control, the copy at the start of each test, the wording, the save note, `help.html` and `rules.html`, and a browser check on an isolated origin (`refcheck.localhost`): each outlook on a quick start, the routing list going outdated, a save at Optimistic keeping the plan's own rates.
3. **MCP:** `marketOutlook` on `max_spending`, the report wording, `README.md` and `SKILL.md`, the plugin bump and rebuild.

---

## Sources

- `js/components/test-bench.js` (`run`, `runRouting`, `_setFloor`, `_setSuccess`, `testbench-save`), `js/test-bench-run.js` (`benchPlan`, `runTestBench`, `runRoutingTest`, `enteredCache`, `rateCache`, `simFor`, `checkJobs`).
- `js/spending-solver.js` (`scaledAssets`, `solvedAssets`, `solveSpending`), `js/success-limit.js` (`simulatedRate`), `js/spending-report.js` (`spendingHeadline`, `successNote`).
- `js/mc-compute.js` (`buildYearPool`, `applyRandomRates`, `calibrationBaseRates`), `js/market-data.js`, `js/sim-config.js` (`simDataMode: 'calibrated'`).
- `js/instruments/instrument.js` (`TAXABLE_ACCOUNT`, `isIRA`, `isRothIRA`, `is401K`, `Instrument.US_BOND`, `Instrument.CORP_BOND`), `js/model-asset.js` (`effectiveAnnualReturnRate`).
- `js/finplan-app.js` (`testBench.planSource`, the `testbench-save` handler, the `spending` save note), `js/mcp/max-spending.js`, `js/mcp/mcp-server.js`.
- `markdowns/maximizer-goal-floor-spec.md` (spec 15: §7 the markets limit, decision 14 the routing test's path).
- Measurements: scratch scripts `outlook-pool.mjs` (the pool) and `outlook-spending.mjs` (the quick starts), 2026-11-19.
- Discussion with John, 2026-11-19.
