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
| `plan_defaults` | the assumptions a new plan inherits — call ONCE, first |
| `build_plan` | turn a described situation into a plan spec |
| `list_profiles` | the eight built-in starting points |
| `quick_start_report` | run a built-in profile, optionally re-aged |
| `run_plan` | run a profile-free or built plan (the app's Share format) |
| `explain_month` | what happened to an asset in one month, and why |
| `explain_issue` | the causal chain behind one flagged issue |
| `share_link` | a link that opens the same plan in the web app, for charts |
| `run_plan` (shareUrl) | read a link, payload or handle back — the return leg |

Start with `quick_start_report` when the user has no portfolio in hand. The
`startAge` / `retirementAge` / `finishAge` arguments genuinely reshape the plan —
every asset date and life-event trigger derives from them — so re-aging a profile
is a real edit, not a relabeling.

`run_plan` takes exactly what the Charting Finance app's Share link encodes, so a
portfolio exported from the app can be passed straight in.

### Building a plan from a description

When someone describes their situation rather than picking a profile —
*"I make $100K, if I save 10% what do I have in 10 years?"* — the path is
`plan_defaults` → `build_plan` → `run_plan`.

**Call `plan_defaults` once, at the start, and say the defaults back.** A plan
inherits a start age of 50, retirement at 67, and a finish age of 87 unless
someone says otherwise, so an unanswered question silently produces a plan about
a person the user is not. Ten years from 50 lands at 60 and never reaches
retirement; the same ten years from 60 crosses it and becomes a different plan
with a drawdown in it. State the assumptions before building, not after.

`build_plan` returns a **spec and runs nothing**. Pass the spec to `run_plan`
for numbers.

**A refusal is the tool working, not failing.** `build_plan` returns a
`question` when the description does not determine a plan — an account whose
type cannot be read, splits that exceed 100%, a horizon and a finish age that
disagree. Relay that question to the user. Do not pick a value on their behalf
and re-call; the whole reason this step exists is that the engine cannot tell
you a plan is wrong, only what it computes.

**Report what it built and what it assumed.** The response carries a `ledger`:
every setting with where it came from (`stated`, `inferred`, `derived`,
`default`) and every asset with its origin (`stated`, `implied`, `structural`).
The `notes` are not footnotes — they name assets the tool created that nobody
asked for. The common one is a Living Expenses line absorbing the income that
is not being saved, which is usually the largest number in the plan and was
never stated by the user. Say so in the reply.

Two things worth stating plainly when they come up:

- **Percentages are shares of the income they come from.** 5% to one account
  and 5% to another is 10% saved, not 10% each.
- **Nothing built here reaches the user's saved portfolio.** A plan made in
  conversation lives in the conversation. Importing it into the app at
  charting.finance is always the user's own action.

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

### Seeing the plan, not just reading it

`share_link` turns a run handle into a URL that opens the same plan in the
Charting Finance web app — the timeline, the projection charts, the interactive
views this transcript cannot show. Offer it when someone wants to *look* at a
plan rather than ask about a number, and after a long report when the next
useful thing is a picture.

Three things to say when you hand one over, because "share" usually means upload
and here it does not:

- **The plan is in the URL fragment**, after the `#`. Browsers never transmit a
  fragment, so opening the link does not send the portfolio to the website's
  server or to anyone else. It travels only in the link itself — which means a
  link pasted into a chat or an email carries the whole portfolio inside it, and
  is exactly as private as the place you paste it.
- **The site asks, and it offers two different answers.** The page reads the
  link and prompts: *Dismiss*, *Open*, *Open & Save*. **Open** views the plan
  without writing it into their saved scenarios; **Open & Save** keeps it.
  Nothing already there changes until one is chosen. Name the distinction —
  looking at a modeled plan is not the same as adopting it, and the prompt is
  the only place that difference is offered.
- **Opening it is theirs to do.** Give them the link rather than navigating
  anywhere on their behalf, and do not treat the link as the plan having been
  "saved" somewhere — a plan made in conversation still lives in the
  conversation.

**Prefer a pane beside the conversation over sending them out of it.** Some
clients — Claude Code among them — can open a URL in a browser pane next to the
transcript. Where that exists, offer it first and open the link there on request:
the user sees the real app, with the charts, without leaving the conversation
they are having. Where it does not, hand over the URL and let them open it.

Two things worth knowing before offering it. A pane's browser profile is
separate from the user's own browser, so an import there does **not** touch what
they have saved in their normal one — which makes it right for looking and wrong
for keeping, and worth saying out loud when someone is about to click *Open &
Save*. And a link that arrives in a tab already showing the app is handled, so
pointing an open pane at a new plan works.

The link is a function of the plan, not of the run, so asking for one never
costs a simulation and an old handle works as well as a fresh one.

### Reading a plan back

The loop closes: `run_plan({ shareUrl })` takes what the user has and returns a
report on exactly that plan. Three shapes are accepted and told apart for you —
a share link, the bare compressed payload after the `#`, or a run handle like
`plan_688bcae498`.

This is the move when someone edits in the browser. They drag a life event,
change a contribution, hit **Share**, and paste. You then explain the plan they
are actually looking at rather than the one you last built, which are not the
same plan and have no reason to be.

Two things about it:

- **A round trip is verifiable.** Handles are content addresses, so a plan sent
  out as a link and read back yields the *same handle*. If it does not, the plan
  changed in between — which is usually the point, and worth saying: "that is a
  different plan from the one I ran, so here is what it does now."
- **A handle only lives as long as the server.** It resolves from memory, so it
  is the cheap way to refer to a plan inside one conversation and useless after
  a restart or on someone else's machine. A share link always works. Prefer the
  handle when both are to hand, and never ask a user to keep one.

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

**Ask for less when you need less.** `sections` takes any of `portfolio`,
`projections`, `creditmemos`, `reports`, `spreadsheet`; omit it for all of them.
The full report is several thousand tokens and most questions want one number
out of it — `sections: ['portfolio']` is the headline at roughly a sixth the
size, and the rest is still there against the same handle. The plan's ages and
What Needs Attention appear in every report regardless, because a smaller report
is a request to read less, not to be told less about whether the plan can pay
its bills.

"**What Needs Attention**" is the section to check first. A ⚠️ there means an
unpayable obligation — an expense or mortgage the plan could not fund from any
eligible account. That is a structural problem with the plan and outranks any
headline number below it. "No issues detected" means every obligation was paid
and every required distribution met; it does *not* mean the plan is good.

### Annual by default, monthly when the question is a detail

The report is written at two granularities and holds a third. **Lifetime Tax
Summary** is the whole run in one column; **Annual Cash Flow** is one row per
year; and behind both, the run records a package for every month and an event
log finer still. Report the annual figures by default — a year is the unit a
person plans in, and thirty rows is already a lot of table.

Reach for the monthly data whenever the question is about a *detail*, and say
that you are doing so:

- **A year that does not look like its neighbours.** An annual row is a sum, and
  a sum is silent about its own shape. A home sale, an inherited lump, a Roth
  conversion, a large December true-up — each lands in one month and is spread
  invisibly across twelve in the annual view. If a user asks why one year is
  different, the annual row cannot answer it; the months can.
- **Any "why" about a specific number.** `explain_month` returns recorded events
  with their causal chains — `explain_month(handle, date: 'YYYY-MM')` for one
  month, or `explain_month(handle, eventType: '...')` with no date to find every
  occurrence across the plan. That second form is how you locate *which* month a
  charge landed in before you go read it.
- **A total that seems too round.** Query the events before repeating the total.

Tell the user the finer view exists rather than leaving them with the annual
row. They cannot ask for a month they do not know was recorded — and the annual
table, read alone, invites the assumption that a year was uniform when the whole
reason it stands out is that one month in it was not.

### When nothing is flagged

A run with no ⚠️ is the easy report to get wrong. Everything above is guidance
for explaining problems, and when there are none the honest content is mostly
the model's limits — so a clean run legitimately reads as a headline number
followed by caveats. Do not pad it back toward reassurance to compensate.

Three things make that report useful rather than merely hedged:

- **Say what “no issues” actually asserts** — every obligation was payable from an
  eligible account and every required distribution was met. That is a claim about
  the plan's internal consistency, not about whether the outcome is good or the
  assumptions are right.
- **Rank the disclosures by their effect on THIS run, and stop at two or three.**
  Over a long horizon nearly every number leans on the compounding convention, so
  “disclose what a number depends on” otherwise expands into the whole list and
  reads as boilerplate. Lead with the limit that moves the largest number in the
  report.
- **Interrogate the suspiciously clean number.** A zero is the easiest thing to
  pass through unexamined — a $0 lifetime capital gains tax on a large taxable
  account, a tax line that never appears at all. Query the handle before
  repeating it, and report what the recorded events show rather than what the
  total implies.

Naming an input worth confirming is in scope and is not advice. The built-in
profiles encode specific strategies — a savings split, a withdrawal order — that
the user never chose; point at the ones driving the result and let them decide.

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
