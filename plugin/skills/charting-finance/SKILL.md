---
name: charting-finance
description: Use when running or interpreting a Charting Finance simulation — retirement projections, net worth over decades, "will my money last", tax drag, Monte Carlo success rates, or asking why the engine produced a particular number in a particular month. Covers the run_plan / quick_start_report / explain_month / explain_issue tools, how to report their output honestly, and the modeling limits that must be disclosed alongside the numbers.
---

# Charting Finance simulator

A month-by-month simulation of a personal balance sheet over decades. It runs
entirely on the user's machine; no portfolio data leaves it. Federal income tax,
FICA, capital gains, RMDs and NIIT are modeled; the output is a Markdown report
plus a run handle you can interrogate.

## The rule that outranks everything else here

**This tool does not produce financial advice, and neither do you when relaying
it.** The project's own disclaimer is blunt about what it is: unproven
hypotheses, uncertified by any financial or fiduciary body, for entertainment.

Concretely, when reporting a run:

- Attribute every number to the simulation. "The model projects $4.6M at 85"
  — never "you will have $4.6M", and never "you should".
- Do not recommend a contribution rate, an asset allocation, a retirement age,
  a Roth conversion, or a withdrawal strategy. You may run and *compare* the
  scenarios the user names, and report how the model's output differs.
- If asked what they should do, say plainly that you can model scenarios but
  are not a licensed advisor, and suggest one for decisions of consequence.
- Disclose the relevant limits from §"What the model does not do" whenever a
  number depends on one. A projection quoted without its assumptions reads as a
  promise.

The engine's documented failure mode is **numbers, never errors** — it returns
a clean, confident report for a plan nobody meant to describe. Treat a
plausible-looking report as unverified until you have checked that the inputs
are what the user actually meant.

## The tools

| tool | use it for |
| :--- | :--- |
| `list_profiles` | the eight built-in starting points |
| `quick_start_report` | run a built-in profile, optionally re-aged |
| `run_plan` | run a caller-supplied portfolio (the app's Share format) |
| `explain_month` | what happened to an asset in one month, and why |
| `explain_issue` | the causal chain behind one flagged issue |

Start with `quick_start_report` when the user has no portfolio in hand. The
`startAge` / `retirementAge` / `finishAge` arguments genuinely reshape the plan —
every asset date and life-event trigger derives from them — so re-aging a profile
is a real edit, not a relabeling.

`run_plan` takes exactly what the Charting Finance app's Share link encodes, so a
portfolio exported from the app can be passed straight in.

### Handles and causal chains

Every run returns a **run handle** (`plan_ae5b27b733`). Pass it to `explain_month`
or `explain_issue` to interrogate that exact run. The handle is correctness, not
caching: the engine samples with an unseeded RNG in Monte Carlo mode, and re-running
to answer a follow-up would answer it about a different run.

This is the tool's real differentiator. When a number surprises the user, do not
speculate about why — ask the engine. `explain_month` returns the recorded event
chain, e.g. `November 2051 > Pay Living Expenses > Transfer Living Expenses → Roth IRA`.
Derive explanations from that recorded history; never recompute them yourself, and
never narrate a mechanism the chain does not show.

### Monte Carlo

`monteCarlo: <100–5000>` appends a percentile table. It is opt-in; omitting it
leaves the deterministic report byte-identical.

**Caveat to state whenever you show these percentiles:** the distribution is
currently under investigation. On the built-in midCareer profile the deterministic
baseline lands *below* the 25th percentile and the median comes in ~2.6× above it,
which is not the relationship a correctly calibrated spread should show. Report
the percentiles as illustrative of dispersion, not as calibrated probabilities,
until this is resolved.

## Reading the report

The report is long — portfolio, projections, credit memos, lifetime tax, per-asset
summary. Do not paste it back wholesale. Lead with what the user asked about,
then offer the rest.

"**What Needs Attention**" is the section to check first. A ⚠️ there means an
unpayable obligation — an expense or mortgage the plan could not fund from any
eligible account. That is a structural problem with the plan and outranks any
headline number below it. "No issues detected" means every obligation was paid
and every required distribution met; it does *not* mean the plan is good.

## What the model does not do

Disclose these when a number leans on one. All verified against the current source.

- **Returns compound optimistically.** `ARR.asMonthly()` is `rate / 12`
  ([js/utils/arr.js:54](js/utils/arr.js:54)), so a stated 8.5% realizes about
  8.839% annually. Over a 30-year horizon the ending balance runs roughly 10%
  rich. Every long projection carries this.
- **No early-withdrawal penalty.** There is no 10% penalty and no concept of age
  59.5 anywhere in the engine — it cannot express a half-year, so it uses 60 as a
  conservative gate for tax *attribution* only
  ([js/policy-constants.js:39](js/policy-constants.js:39)). A modeled early
  retirement will understate tax owed.
- **Social Security is taxed at a flat 85%** of benefits
  ([js/financial-package.js:69](js/financial-package.js:69)), skipping the
  provisional-income phase-in. Low-income retirees are overtaxed by the model.
- **The NIIT threshold is never indexed** to inflation — correct to statute, but
  it means the 3.8% surtax reaches further into later decades than a
  cost-of-living-adjusted threshold would.
- **State and local income tax are not modeled at all.** Property tax is.
- **One-time income is annualized ×12** for withholding purposes, overstating
  withholding in the year it occurs.
- Historical inputs are simulation assumptions, not forecasts. The model does not
  know about the user's job, health, family, or the next decade of markets.

## Scope

The engine advises; it never mutates a user's plan on its own. Asset creation and
deletion belong to the user. If a run suggests an account is missing or
misconfigured, say so and let them decide.
