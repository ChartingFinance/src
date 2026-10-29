# Spec 12 — A fallback order: who pays when the named account cannot

Status: **DECIDED 2026-10-29 (§11). Spec only, no code.** Phase 1 can start now.
Phase 2 waits for the early-withdrawal penalty's own spec (decision §11.5), and
spec 11 Part B (the MAGI ceiling) waits for Phases 1 and 2 (spec 11 §6.4).

A bill's transfer rules say which accounts pay it. Two things can stop them: the
named account is empty, or a rule caps what it may pay (spec 11 Part B caps IRA,
401(k) and brokerage draws to keep MAGI under a ceiling). Either way the engine
has to pick another account. Today it has one answer, fixed in code: cash, then
savings, then the taxable account, then bonds, never a retirement account, and
only one account deep. This spec lets the user write that answer as a ranked
list of their own accounts, one for each life-event phase: the **fallback order**.

Four rules hold throughout:

- **Rules first.** The user's transfer rules stay the default split. The order
  pays only what they cannot pay, or may not.
- **Nothing moves by default.** A plan with no order of its own runs on the
  default order, deduced from today's backstop rule, so existing plans do not
  move.
- **Nothing hidden.** Every account that can pay is always in the list, on or
  off, and only an account the list shows as on pays from it.
- **Retirement accounts by the user's hand.** An IRA, 401(k) or Roth is listed
  off, and pays from the order only once the user switches it on.

---

## 1. What exists

### 1.1 One resolver, one fixed list

- `FundTransfer.resolveFunding(modelAssets)` in `js/fund-transfer.js` returns the
  first open account with a positive balance, walking `FUNDING_BACKSTOP_PRIORITY`
  in `js/instruments/instrument.js`:

  cash → bank (Savings) → taxableEquity (Taxable Account) → usBond → corpBond

  It replaced three competing policies in July 2026, after review 2026-07-25
  found a savings-only household whose implicit bills were booked with no cash
  leaving any account. `tests/funding-backstop.mjs` guards it.
- **Retirement accounts are left out on purpose.** The comment on
  `FUNDING_BACKSTOP_PRIORITY` says why: spending a 401(k), IRA or Roth has
  consequences (tax, penalties, Roth ordering) the engine should not choose for
  the user, so a plan that spends retirement money says so with an explicit
  transfer. The "Funding Backstop" cards in `help.html` and `rules.html` say the
  same. Real estate is out because it cannot pay a bill.
- **Income and pension instruments must never enter it.** Their `finishCurrency`
  is a monthly rate, so a $3,000 benefit would look like a $3,000 account that
  never empties (spec 4c §2).
- `FundTransfer.resolveDeposit` is the same list without the positive-balance
  filter. It is used only to receive a refund when no account has money.
- `FundTransfer.reportUnfunded` makes a missing payer visible: an UNFUNDED info
  event on the asset that owes, with a `ShortfallOrigin` that decides which
  conservation total it belongs to. A null resolver is never a skip.
- **Within one type, the first account by name pays.** Assets are sorted by
  instrument, then display name (`Portfolio.sortModelAssets`), and the resolver
  takes the first match. With two savings accounts, "Checking" pays before
  "Emergency Fund", and renaming one can change which pays. Nothing documents
  this.

### 1.2 Only one account deep

Three places re-source a draw that clamped at $0, and each asks the resolver
once:

- `FundTransfer.settleOneSided`, for every one-sided draw: mortgage, carrying
  costs, property-tax escrow, the backstop's own draws, every tax payment;
- `FundTransfer.execute()`, for two-sided transfers, which in practice means an
  expense rule whose named account runs dry;
- `TaxEngine.#withholdInScope`, for the withholding a drained IRA or 401(k)
  still owes.

If that fallback clamps too, the rest is reported unfunded (on the two-sided
path since #114). A third account is never asked, so a bill can be reported
unpaid while an everyday account still holds money.

Measured with a read-only probe over the snapshot fixtures (the probe wraps
`reportUnfunded` and checks every balance at the moment of each report): first
on main 9c6947f (39 fixtures, 2026-10-27), and again on main 68d34bd (47
fixtures, 2026-10-29, after #117 and #121 added eight):

| Unfunded reports | 9c6947f | 68d34bd | Amount on 68d34bd |
|---|---:|---:|---:|
| All | 712 | 713 | |
| Made while an everyday account still held money | 0 | 0 | $0 |
| Made while an IRA, 401(k) or Roth still held money | 184 | 185 | $153,909 |

The 185 come from four fixtures:

- **`quickstart-earlyCareer`, a shipped profile:** 178 months of Living Expenses,
  November 2028 to December 2043 (ages 37 to 52), $63,694 in all. Its rule draws
  the brokerage, the brokerage runs dry, the plan has no cash or savings
  account, and the 401(k) and Roth, which never fall below $45,000 and $15,000,
  are never touched.
- `unpayable-annual-true-up`: 5 annual true-ups, $57,966, with $1.5 million in
  an IRA.
- `trueup-draw-unfunded`: 1 monthly true-up, $30,064, with money in a Roth.
- `aca-repayment-unpayable` (new with #117): 1 premium tax credit repayment,
  $2,185, with every other dollar in an IRA.

So in the corpus the walk's depth has never cost a payment, while the lack of a
user order has, in a shipped profile among others.

### 1.3 Every call site

Accounts paying:

| Site | What is paid | Today | The order applies |
|---|---|---|---|
| `ExpenseEngine`, an expense with no rules | the whole bill, grossed up for the first account's gain | first payer, then `settleOneSided`'s one fallback | yes |
| `ExpenseEngine`, expense overflow | the part its rules do not cover | same | yes |
| `ExpenseEngine`, mortgage | the payment its rules do not cover (`data.backstop`) | same | yes |
| `ExpenseEngine`, maintenance and insurance | the cost its rules do not cover | same | yes |
| `TaxEngine`, property-tax escrow | the escrow its rules do not cover | same | yes |
| `TaxEngine.applyMonthlyTaxTrueUp` | the month's tax beyond withholding | same | yes |
| `TaxEngine`, annual true-up | the April bill | same | yes |
| `TaxEngine`, NIIT | the year's NIIT | same | yes |
| Premium tax credit repayment (spec 11 Part A, PR #117, merged 2026-10-29) | excess advance credit | `resolveFunding`, then `settleOneSided` | yes |
| `settleOneSided`'s spill | the clamped part of any one-sided draw, a rule's own included | one fallback | yes |
| `execute()`'s spill | the clamped part of a two-sided transfer | one fallback | yes, for an expense rule (§1.4) |
| `#withholdInScope`'s spill | withholding a drained IRA or 401(k) still owes | one fallback | yes, without tax-deferred entries (§4.4) |

Accounts receiving:

| Site | What lands | Today | The order applies |
|---|---|---|---|
| `PayrollEngine.applyPostTaxTransfers` | take-home pay no rule claims | `resolveFunding` | no (§4.6) |
| `Portfolio.applyAssetCloseFundTransfers` | sale proceeds no close rule claims | `resolveFunding` | no |
| `ExpenseEngine`, RMD top-up | the required distribution | `resolveFunding` | no |
| Annual true-up refund | an overpayment | `resolveFunding`, else `resolveDeposit` | no |
| Premium tax credit still owed (PR #117) | the credit, at reconciliation | `resolveDeposit` | no |

Looked up, no money moves:

| Site | What it asks | Change |
|---|---|---|
| `TaxEngine.#settleAllocatedLeg`, NIIT, annual true-up, and #117's repayment | which account to book the spilled tax on, by asking `resolveFunding` again after the draw | read who paid from the walk (§5.2) |
| `flow-pipelines.js` `addSystemTransfers` | the system route's source, from present state | the order's first payer |
| `rule-notes.js` `funding-backstop`, `unfunded-obligation` | gated on instrument type; the prose names "cash, savings, brokerage or bonds" | name the order in force (§6) |
| `portfolio-issues.js` `no-funding-accounts`, `plan-exhaustion`, `unfunded-obligation` | the same | the same |
| `reportUnfunded`'s SANITY line | the same prose | the same |
| `tax-allocation.js` `isAllocationEligible` | everyday accounts, by type | none: allocation picks payers by income share |
| `ModelAsset.#transact`, the $0 clamp | clamps everyday, tax-deferred and Roth accounts | none: the clamp belongs to the account |

### 1.4 Where an order does not apply

- **Transfers that are not bills.** Rebalance transfers, Roth conversions,
  sweeps and close transfers move a share of their source's own balance, so they
  cannot clamp, and one that did should shrink rather than borrow. Payroll
  transfers come out of pay. (If one did clamp today, the backstop would pay the
  rest into the target, and with no backstop the target is credited in full
  anyway: code-issue #19.)
- **RMDs.** The law names the account. Only the destination uses the resolver,
  and a drained IRA's rare RMD spill keeps today's behavior.
- **Tax allocation** (spec 4a, off by default) picks payers by income share. Only
  its spill reaches the order.
- **Money coming in** (§4.6).

## 2. The first consumer: spec 11 Part B

Spec 11's ceiling (§6.2) holds a chosen MAGI under a ceiling over an age span.
Before each draw that would raise MAGI it works out the room left this year,
then:

- caps an IRA or 401(k) leg at the room, gross;
- lets a brokerage leg use room at its gain fraction (`ModelAsset.planWithdrawal()`);
- caps a Roth conversion at the room;
- leaves cash and Roth draws alone;
- sends what a capped leg cannot pay to the fallback order, through the existing
  settlement path;
- when the fallbacks run dry, has the capped source pay past the ceiling, and
  reports the year (spec 11 decision §13.3).

The first draft proposed brokerage, then cash, then Roth as the ceiling's
fallback (PR #110, its decision §13.2): Roth last, because tax-free growth is the
most valuable money to keep. On 2026-10-26 John decided the order is a feature
of its own (PR #116).

What the order has to give the ceiling:

1. **A limit per account, from a rule.** The order says who pays; the ceiling
   says how much each may pay now. A brokerage in the order is itself limited by
   its gain fraction, and room spent by one leg is gone for the next.
2. **The remainder, handed back.** When the order runs dry, the walk returns what
   is unpaid instead of reporting it, so the ceiling can pay it from the capped
   source past the cap. Every other caller reports it unfunded, as today.
3. **A Roth, switched on.** The default order lists retirement accounts off, so
   "Roth last" exists only once the user switches the Roth on (decision §11.6).
4. **Nothing for conversions.** A capped Roth conversion converts less. It is not
   a bill, so nothing is redirected.
5. **A record of each redirect**, so `explain_month` can answer "why did the
   brokerage pay in March?" (§5.4).

## 3. Prior art

**ProjectionLab**, Plan Settings → Drawdown:

- 2.1.0, November 2021: the drawdown order can be customized.
- 3.6.1, September 2023: the order can decide when eligible real assets are sold.
- 4.1.0, November 2024: Roth entries stay visible in Drawdown when conversions
  are involved.
- 4.2.2, January 2025: each drawdown card previews when it is drawn. The help
  page describes a reset to the default and a red line on withdrawals that may
  carry an early-withdrawal penalty.
- 4.6.0, April 2026: withdrawal shielding. Past a tax target, withdrawals shift to
  tax-free sources.

**Boldin**, Withdrawal Order (help article updated January 2026):

- A "Traditional" order by category: after-tax, reverse-mortgage equity, pre-tax,
  Roth, HSA, each until empty; within a category, the lowest expected return
  first.
- PlannerPlus has a "Customized" order, account by account, and a switch back to
  Traditional.
- An account can be excluded. An excluded account is never drawn, even when
  nothing else is left; the plan models debt instead.
- RMDs count among the withdrawals; an RMD larger than the spending need goes to
  "Excess Income".
- Boldin charges the 10% early-withdrawal penalty since October 2026 (our
  benchmark of 2026-10-26), so its order is priced against it.

What this spec takes from them:

- an order with a reset to the default (both); here there is one for each
  life-event phase, which neither has (decision §11.1);
- accounts, not only categories (Boldin's Customized);
- a switch per account (Boldin's exclusion), with every account always listed,
  so a switched-off retirement account is on screen too (decision §11.3);
- a tax target that changes which accounts pay, never how much is spent
  (ProjectionLab's shielding; here, the ceiling);
- the early-withdrawal penalty, shown on the entry (ProjectionLab's red line) and
  charged, as Boldin does since October 2026 (decision §11.5).

The difference: in both products the order is the spending engine. It covers the
gap between income and expenses. Here per-bill transfer rules come first and the
order covers only what they cannot, so every existing plan's rules stay
authoritative.

## 4. The setting

### 4.1 What the order is

| Field | Meaning | Default |
|---|---|---|
| Accounts, ranked | who pays what a bill's rules cannot, first to last | every account that can pay: the cash, savings, taxable and bond accounts in today's type order, by name within a type, then the IRAs, 401(k)s and Roths |
| On / off | whether the order may draw this account | on for everyday accounts, off for an IRA, 401(k) or Roth |
| From age | the order skips this account before this age | none; 60 when a tax-deferred account is switched on (§4.4) |

- **Entries are the plan's accounts, ranked by the user** (decision §11.2).
  Types cannot say "Emergency Fund last" or "this brokerage before that one".
- **Only accounts that can pay:** cash, savings, taxable, Treasury and corporate
  bonds, IRA, 401(k), Roth. Never income, pension, expense, real estate,
  mortgage or debt.
- **Income is not an account.** Social Security, a pension or a salary pays into
  an account and has no balance to draw. Social Security cannot start before 62
  anywhere in the model (#121, merged 2026-10-29), so no order can bring it
  earlier. Age rules set by law belong to the instrument (Social Security at 62,
  the penalty before 59½); an entry's "from age" is the user's own gate on top
  of them.
- **The default is deduced from today's rule, and computed, never stored.**
  Today's payer depends only on the plan's accounts: type in the backstop's
  order, then display name within a type (§1.1). So any plan's default can be
  written out: its everyday accounts in that order, all on, then its retirement
  accounts, all off. Its first payer is today's in every case, the name
  tie-break included, which is why Phase 1 predicts no drift. A plan saves an
  order only once the user edits it, so a plan saved before this feature runs
  unchanged.
- **A reset** returns to the default.

### 4.2 Every account, always listed

Decision §11.3: every account that can pay is in every list, on or off. Nothing
pays from the order that the list does not show as on, and no account is out of
view.

- An edited order is saved as the complete list.
- An account added later joins every saved list at once, where the user sees it:
  an everyday account on, after the last account that is on, so a new savings
  account is never left unspent while a bill goes unpaid (the failure the July
  backstop fix was for); a retirement account off, at the end, so a new IRA is
  never drawn without the user saying so. The editor marks it as new.
- A deleted account leaves the lists, and a renamed one is rewritten in them
  (§4.7).
- An account not open in a month, not yet started or already closed, stays
  listed. The walk passes over it.

### 4.3 One order per phase

Decision §11.1: each life-event phase carries its own order, installed by
`ModelLifeEvent.apply()` when the phase begins, beside its `phaseTransfers`.

- **An order stays in force until a later phase installs another.** Before any
  phase installs one, the default (§4.1) is in force. A phase that keeps the
  order before it shows that order, marked as inherited, with an action to make
  its own.
- **The "from age" stays on each entry.** A phase can begin at 55 while its IRA
  waits for 60 (§4.4).
- **The ceiling** (spec 11 Part B) is plan-wide over an age span (spec 11
  decision §13.1). In each month it walks the order in force that month
  (decision §11.6).
- **Phases are being widened.** John, 2026-10-29: the phase is underused, and
  any life change (a new job, selling a house, buying a second home) should be
  one. That is its own spec. Today a phase is one of two `LifeEvent` types,
  Accumulate and Retire, each with `closes` and `phaseTransfers`. Because the
  order lives on `ModelLifeEvent`, every phase that spec adds carries an order
  with no further work here.
- **Stored but never applied** is this shape's known trap:
  `ModelLifeEvent.globalOverrides` is saved and has no effect (code-issue #24).
  The order needs a test that changing one phase's order changes a draw in that
  phase and not before it. `ModelLifeEvent.fromJSON` copies fields by name, so
  the order must be added there and to `toJSON`, or every load drops it.

### 4.4 Retirement accounts

Retirement accounts already work as payers: `ModelAsset.#transact` clamps IRA,
401(k) and Roth balances at $0, `recordDistribution` books a draw on the
account's own ledger, and `FinancialPackage.recordTransfer` classifies it by
instrument. What has to be right:

- **A tax-deferred leg is a distribution.** It is booked on the account and in
  the package, never for more than it supplied. The month-end sweep
  (`withholdOnDeferredDistributions`) then withholds 10% at source, as on any
  distribution, and the draw counts toward that account's RMD, because the RMD
  check reads the same ledger.
- **No gross-up on an IRA, 401(k) or Roth leg.** The sweep and the true-up
  collect the tax, as spec 4a §3.2.1 already says for allocated legs.
- **Withholding's own spill skips tax-deferred entries.** `#withholdInScope` runs
  inside the month-end sweep. A deferred leg drawn there is a new distribution
  that the sweep may or may not visit this month, depending on where the account
  sits in `modelAssets`. That walk uses cash, savings, taxable, bond and Roth
  entries only.
- **The age gate** (decision §11.4). Switching on a tax-deferred account sets
  its "from age" to 60, the engine's whole-year rounding of 59½. That is
  `global_deferred_allocation_age`, which gates tax allocation for the same
  reason. The user may lower it.
- **Early withdrawal is allowed, at its real cost** (decision §11.5). Before 59½
  the law allows a distribution and adds a 10% tax, with exceptions. The engine
  charges none and has no concept of 59½ (Rules, "What This Engine Does Not
  Model"; $27,000 uncharged on a probed retirement at 55), so an IRA in the
  order at 45 would look free. The penalty therefore gets its own spec and is
  built before Phase 2. It applies to every early distribution, a rule's as well
  as the order's, and settles the exceptions (separation from service at 55,
  72(t) payments and the rest).
- **Roth.** Every Roth withdrawal is modelled as free of tax and penalty at any
  age. There is no contribution basis and no five-year clock: right for
  contributions, wrong for earnings before 59½. Rules' list of gaps gains that
  line once a Roth can be in the order, unless the penalty spec models earnings,
  which needs a Roth basis first (§9).
- **MAGI.** Without a ceiling, an IRA in the order adds its whole draw to AGI and
  can push a year over the ACA cliff. Spec 11 Part A's TaxYear records it; Part
  B is what prevents it.

Early Career (§1.2) shows why the gate and the Roth line matter: its unpaid
years are ages 37 to 52. With the gate at 60, a 401(k) switched on would still
not pay them; with the gate lowered, it would, and the penalty would be charged.
A Roth would pay at any age, and until a Roth basis exists the engine treats all
of it as contributions.

### 4.5 Rules first, then the order

- The order never edits a rule and never moves money a rule already moves.
- For a bill, the bill's rules pay their shares. The order pays what is left
  (`remaining` in the mortgage, carrying-cost and escrow paths; the overflow in
  the expense path) and what a named account could not supply.
- An account named by a rule and also in the order pays its rule share first.
  Once empty, the walk passes over it.
- A rule may name an account the order has switched off, any retirement account
  included. Rules are authoritative (spec 4a §2).
- The ceiling cuts a rule's leg before it runs; what it cut joins the bill's
  remainder, which the order pays (§5.3).

### 4.6 Money coming in is not covered

Leftover take-home pay, sale proceeds, RMD payouts and refunds keep today's
destination: the first open everyday account with a balance, and for a refund,
`resolveDeposit` when there is none. A deposit into a retirement account is a
contribution, with limits, and the first account to pay is not the obvious first
account to receive. This also leaves a known wart where it is: a savings account
at $0 cannot receive leftover pay. A "deposit to" setting can come later.
(Decision §11.7: unchanged.) So that this one implicit movement is not hidden
either, the editor shows its account beside the order, read-only (§6).

### 4.7 Where it lives and how it travels

- **On each phase, with the plan, not the settings.** It names accounts, as
  transfer rules and life events do, so it is plan content: a field of
  `ModelLifeEvent`, saved with the plan's `lifeEvents` per scenario by
  `js/scenario-store.js`, the only scenario writer, and held like the other plan
  settings while an unsaved Open is on screen (#101).
- **It reaches the engine with the plan**, inside `lifeEvents`, never from
  `globals.js`. Monte Carlo workers boot on defaults and see only their payload,
  so the order rides in the life events they already receive.
- **Share links and the MCP.** `lifeEvents` is already in `SPEC_KEYS`
  (`share-link.js`), so the order travels with no new key. The app's import and
  `build_plan` read it through one reader, as `planSettingsFrom` does for
  settings. `plan_defaults` reports a plan's default order, and `diff_plans`
  shows a changed one.
- **By display name**, like `FundTransfer.toDisplayName`, until the stableId
  migration lands. A rename orphans an entry exactly as it orphans a rule today.
  At run time an entry naming no account is skipped and reported once, never
  thrown on, and the editor rewrites the order on a rename.
- **Where it is edited:** in each phase's editor, beside its transfers. A user
  meets the backstop in Flows' "Moved automatically", in the `funding-backstop`
  rule note and in "What needs attention", so each of those links to the order
  in force that month.

## 5. The engine: one walk

### 5.1 The walk

One primitive replaces the three one-deep fallbacks of §1.2, for example
`FundTransfer.drawFromFallbacks(amount, { order, skip, limitFor, origin, cause })`:

1. Take the accounts of the order in force this month (§4.3) that are on, past
   their age, open, with a positive balance, and not in `skip` (the account
   that just clamped; a capped source).
2. From each in turn, draw `min(remaining, limitFor(account))` with `debit()`
   until the amount is paid.
3. Return the legs and what is still unpaid.

- **In the caller's trace scope.** Each leg is a `debit()` inside the scope that
  opened the draw, never a nested `settleOneSided`, which opens a scope of its
  own. Flows throws when a spillover has no draw in its scope.
- **Each leg is a SPILLOVER** with the origin of the movement it continues
  (`PAIRED` from `execute()`, `ONE_SIDED` from settlements and withholding) and
  the caller's `cause`, as today. Its `depleted` names the account before it in
  the walk.
- **The caller deals with the remainder:** `reportUnfunded` with today's causes,
  or, for the ceiling, a draw from the capped source first.
- **First payer and gross-up.** A bill no rule covers is grossed up for the first
  account's gain, as today (`calculateGrossWithdrawal`), and the walk starts
  there. Later legs are not grossed up again; the true-up collects the tax on
  their gain. That is today's behavior, one account deeper.
- **Destinations get their own function**, keeping today's rule (§4.6), so "the
  order pays, it does not receive" is visible in the code.

### 5.2 Legs, not one spillover

`FundTransferResult` and `settleOneSided`'s result carry one fallback today
(`spillover`, `spilloverGain`, `spilloverInstrument`). They become a list of legs,
each `{ account, supplied, realizedGain }`. `supplied` and `paid` keep their
meaning.

- About a dozen readers in `expense-engine.js` and `tax-engine.js` book the
  fallback with `monthly.recordTransfer(...)`. Each loops over the legs.
- Each leg books what it **supplied**. Today's `spillover` is what was asked of
  the fallback (#105). Booked for an IRA leg, it would put unpaid dollars into
  AGI.
- The three re-asks in `tax-engine.js` (`#settleAllocatedLeg`, NIIT, the annual
  true-up) book the spilled tax on each leg's own account, not on whichever
  account the resolver names after the draw. That also closes code-issue #30 at
  those three sites: they book what the fallbacks paid, not what was asked.
  PR #117's premium tax credit repayment (merged 2026-10-29) re-asks the same
  way, though it already books what was paid. Phase 1 converts it too: four
  sites.

### 5.3 A cap from a rule

For spec 11 Part B:

- The ceiling cuts a rule's IRA, 401(k) or brokerage leg before it runs. The cut
  joins the bill's remainder, the same remainder a bill with no rules has, and
  the walk pays it. A redirect is then an ordinary backstop draw with ordinary
  conservation, not a new kind of movement.
- `limitFor(account)` is the ceiling's room for that account, read at each leg:
  the room for an IRA or 401(k), the room over the gain fraction for a
  brokerage, no limit for cash or a Roth.
- When the walk hands back a remainder, the ceiling draws it from the capped
  source past the cap and records the overshoot for its yearly check (spec 11
  §6.3).

### 5.4 Recording it

- **Phase 1 adds no key and no event type.** Every note, cause and data key stays
  as it is, so the default walk is byte-identical wherever it goes no deeper than
  today.
- **With a user order in force**, each leg carries its place in the order
  (`data.order`), so `explain_month` and the notes can say "Brokerage paid,
  second in your fallback order, after Cash ran out".
- **A ceiling redirect is data on events that already exist:** `data.capped` on
  the capped leg's TRANSFER or SETTLEMENT (the cap, and what it cut), and on the
  remainder's draw (the account it stands in for). Spec 11 §6.2 left "a new
  EventType, or data" to implementation; data is recommended. A new EventType has
  to be declared in `EVENT_RECONCILIATION`, `EXPENDITURE_TREATMENT` and
  `FLOW_TREATMENT`, and rendered by `renderNote` under `memo-vocabulary.mjs`,
  before anything emits it, and each of the three tables throws mid-run if it is
  missed. A redirect must also never render as "Spillover from depleted IRA": the
  issues surface matches that prose and would report a capped IRA as run dry.
  (Decision §11.9: as proposed.)

## 6. Presentation surfaces, enumerated

Spec 8 (NIIT) found a sixth surface after its fix. All of these change in Phase 2:

- **The editor, in each phase:** every account, ranked, with a switch and a
  "from age" on each; the order inherited from the phase before until the user
  makes this phase's own; a reset; the penalty shown on a tax-deferred account
  whose "from age" is under 60; and, read-only, where money no rule claims lands
  (§4.6).
- **Flows** (`money-flows.js`): "Bills no rule covers" and "An account ran
  short, the next one paid" name the order's accounts.
- **Rule notes:** `funding-backstop` fires for an account the order drew, read
  from its events, never from present state; `unfunded-obligation` names the
  order in force instead of "cash, savings, brokerage or bonds".
- **What needs attention:** `no-funding-accounts` becomes "nothing in your
  fallback order can pay"; `plan-exhaustion` and `unfunded-obligation` name the
  order; a new notice when a bill went unpaid while an account switched off in
  the order held money ("Your 401(k) held $412,000 but is switched off in your
  fallback order"). `funding-ran-dry` stays as it is. The penalty's own notices
  belong to its spec.
- **`reportUnfunded`'s SANITY line.**
- **`flow-pipelines.js`:** the system route's source.
- **Month & Year Details** and its ⚡ summary.
- **MCP:** `run_plan` notes, `explain_month`, `plan_defaults`, `build_plan`,
  `share_link`, `diff_plans`.
- **Help:** the "Funding Backstop" card.
- **Rules:** the "Funding Backstop" card, the Cash rule ("the first account the
  funding backstop draws on"), the home's carrying-cost rule, and "What This
  Engine Does Not Model" (the Roth line; the penalty line goes when the penalty
  spec lands).

Phase 1 changes only the Help and Rules sentences that say the first account
with a balance pays. After it, the accounts pay in turn until the bill is paid.

## 7. Traps this codebase has already hit

- **An undeclared EventType throws mid-run**, in three places:
  `monthlySanityCheck` (`EVENT_RECONCILIATION`), `annual-expenditure.js`
  (`EXPENDITURE_TREATMENT`) and Flows (`FLOW_TREATMENT`, and a spillover with no
  draw in its scope). Prefer data on declared types (§5.4).
- **A dry fallback must be reported** (#114). Before it, `execute()` let a
  clamped fallback's shortfall vanish: $3,013 of a bill in
  `transfer-exhausts-fallback` was neither paid nor reported. Any leg of the walk
  can clamp, so the walk returns what is unpaid, and every caller reports it.
- **`spillover` is what was asked, not what was paid** (#105, code-issue #30).
  Legs carry what each account supplied.
- **The funding-backstop policy was never written in a spec.** It lives in the
  comments on `FUNDING_BACKSTOP_PRIORITY`, `resolveFunding` and
  `global_deferred_allocation_age`, in Help and Rules, and in Claude's project
  memory, outside the repo. This spec is its written home from now on: the
  default order, and retirement accounts only when the user switches them on.
  The comments and both static pages change in the same PR as the behavior,
  because no test reads their prose (PR #97).
- **Present state is not history.** `resolveFunding()` at render time answers for
  today, not for a month thirty years ago (rule-notes rule 3). Notes and Flows
  read the order's choice from recorded events.
- **Predict before blessing.** Write the expected drift, run
  `node tests/tools/snapshot.mjs`, read `git diff tests/baselines/`, and only then
  `--bless`. `--bless --only` leaves `_coverage.snap` stale; finish with an
  unfiltered bless.
- **A fixture that does not reach a branch looks the same as a correct engine.**
  No fixture makes the annual true-up, NIIT or the premium tax credit repayment
  spill: measured 2026-10-27 and again 2026-10-29 on main 68d34bd, the one-sided
  spills the corpus reaches are 3 housing settlements, 8 gross-ups and 1 monthly
  true-up. Add those fixtures before the walk replaces those branches.
- **Conservation cannot see a policy.** "Deferrals before taxes" conserved money
  too (PR #99); only a check of the order caught it. The walk needs a check that
  its legs came in the order's order.
- **Stored but never applied:** `globalOverrides` (code-issue #24), on the same
  `ModelLifeEvent` that holds the order (§4.3). The order needs a test that
  changing one phase's order changes a draw in that phase only, and `toJSON` and
  `fromJSON` must carry it.
- **The snapshot cannot see a live view of config** (spec 9). If any part of the
  order reaches the engine through config, test it as `tests/sim-config.mjs`
  does.
- **An unsaved Open must not overwrite the active scenario** (#101): only
  `scenario-store.js` writes, and plan settings are held.
- **The plugin version** is bumped in every PR that changes the bundle.

## 8. Fixtures and tests

New fixtures:

- `fallback-walks-on`: three everyday accounts and a bill that empties the first
  two in one month while the third has money. Today the rest is reported
  unfunded; after Phase 1 the third pays.
- `annual-trueup-spills`, `niit-spills` and `ptc-repayment-spills`: the annual
  true-up, NIIT and a premium tax credit repayment drawn from an account that
  clamps, then from a second that clamps too. All three branches are unreached
  today.
- `fallback-user-order`: brokerage before cash, the reverse of the default.
- `fallback-order-per-phase`: brokerage first while working, cash first once
  retired. The payer changes in the month the Retire phase begins, not before.
- `fallback-account-added`: an account added after the order was edited joins
  it, on after the last account that is on if it is an everyday account, off at
  the end if it is a retirement account.
- `fallback-roth-last`: brokerage and cash run dry and a Roth pays, with no tax
  and a Roth distribution booked.
- `fallback-ira-at-62`: an IRA in the order pays a bill: a distribution in AGI,
  10% withheld at source. A twin at 55 shows the age gate passing over it, a
  twin at 55 with the gate lowered shows the penalty charged, and a twin at 75
  shows the draw counting toward the RMD.
- `fallback-ira-runs-dry-withholding`: the withholding spill passes over a
  tax-deferred entry.
- `fallback-missing-account`: an entry naming no account, skipped and reported
  once.
- `fallback-switched-off-held-money`: a bill unpaid while an account switched off
  in the order held money; the new notice fires.
- **Natural witnesses**, as `--set`-style variants never blessed into the
  existing baselines: `quickstart-earlyCareer` with its Roth on,
  `unpayable-annual-true-up` with its IRA on, `trueup-draw-unfunded` with its
  Roth on. Each turns reported shortfalls into payments.
- **Silence:** every existing fixture unchanged when no order is set.

Tests:

- `tests/funding-backstop.mjs` keeps its six invariants on the default order.
  Invariant 3 becomes "never drafted unless named".
- A conservation test for the walk: for every draw, supplied + the legs + unpaid
  = asked, and `TRANSFER + SPILLOVER(paired) + UNFUNDED(paired) = 0` still holds
  with several legs.
- An order check: the legs come in the order's order.
- Mutations it must catch: reverse the walk; stop after one fallback; book what
  was asked instead of what was supplied; skip `recordDistribution` on a deferred
  leg; let the withholding walk reach a deferred entry; ignore the age gate; let
  a destination use the order; skip an entry for a missing account silently;
  install a phase's order a month early or late; drop the order in `fromJSON`.
- Spec 11 Part B's fixtures (`aca-early-retiree-*` with a ceiling,
  `aca-ceiling-breached`) use the order.

## 9. Not in scope

- **The 10% early-withdrawal penalty.** Its own spec, built before Phase 2
  (decision §11.5).
- **Phases as life changes** (a new job, selling a house, a second home). Its
  own spec (decision §11.1); this one only puts the order on the phase.
- **Roth basis:** contributions versus earnings, and the five-year rule. The
  penalty spec decides whether to take it up.
- **Choosing the order for the user:** a tax-optimal order, a Maximizer search
  over orders, "fill to the bracket" draws. The order is the user's statement;
  spec 11's ceiling is the only rule that steers it.
- **Proportional draws**, a share from each account. The order is sequential.
- **Destinations** (§4.6).
- **Selling real estate to pay bills** (ProjectionLab 3.6.1). A home cannot pay a
  bill here; a sale is a life event.
- **HSA, 529, inherited IRA, annuities.** No such instruments.
- **An RMD the IRA cannot pay** keeps today's behavior.
- **Code-issue #19:** `execute()` credits the target in full when its source is
  short. Its own PR.

## 10. Phases and cost

| Phase | Delivers | PRs | Effort |
|---|---|---|---|
| **1. The walk** | §5.1 and §5.2 on the default order: every fallback walks the whole list, results carry legs, and the four tax re-asks read the legs. No new setting, key or event type. | 2: #30's booking first, then the walk (decision §11.8) | about 2–3 days |
| **Before 2: the penalty** | the 10% tax on early distributions, from rules and the order alike | its own spec (decision §11.5) | its spec's |
| **2. The user's order** | §4 and §6: an order on each phase, every account listed with its switch and age, storage, share link and MCP, the editor, notes, issues, Help and Rules | 2: engine and data, then editor and pages | about 4–6 days |
| **3. Spec 11 Part B** | the ceiling as a limit on the walk (§5.3), and its redirect records | as spec 11 §12 | spec 11's 5–8 days |

Phase 1's prediction, written before any change:

- **The corpus is byte-identical.** The walk differs from today only where a
  fallback clamps while another everyday account still has money, which happened
  in none of 713 unfunded reports (main 68d34bd, 47 fixtures), and in the four
  tax re-asks, which no fixture reaches.
- **The new fixtures move:** `fallback-walks-on` shows the third account paying;
  the annual true-up, NIIT and repayment spill fixtures show the spilled tax
  booked on the accounts that paid it.

Phase 2 also predicts the corpus byte-identical when no order is set. Each
fixture that opts in states its own drift first.

Phase 1 is worth shipping alone. It fixes the one-deep fallback, closes #30 at
its three sites, and gives Phases 2 and 3 the legs they need, without changing
how any plan is set up.

## 11. Decisions

Recorded 2026-10-29 (John). The questions as first asked are in this PR's first
commit.

1. **Per phase.** Each life-event phase carries its own order (§4.3). The phase
   is underused: any life change, such as a new job, selling a house or buying a
   second home, should be one. That gets its own spec.
2. **A ranked list of the plan's accounts** (§4.1), not account types.
3. **Every account always listed, on or off** (§4.2), so nothing pays from a
   hidden transfer. Asked alongside: Social Security must never pay before 62.
   #121 enforces that everywhere (merged 2026-10-29), and Social Security is
   income, not an account the order could draw (§4.1).
4. **An age gate on tax-deferred accounts:** yes (§4.4).
5. **Model reality:** early withdrawal is allowed and costs the 10% penalty. The
   penalty gets its own spec and is built before Phase 2 (§4.4, §10).
6. **The ceiling's order:** as proposed, walking the order in force that month,
   without the account it is capping, limited by each account's MAGI cost
   (§5.3). When that order has the Roth switched off, the ceiling's card offers
   to switch it on at the end, so "Roth last" is one click and still the user's
   choice.
7. **Money coming in:** unchanged (§4.6).
8. **Phase 1 first, alone:** yes, with #30's booking as a small PR ahead of it
   (§10).
9. **Recording a redirect:** as proposed, data on existing events (§5.4).

The two points the draft took as given:

- **The default order is deduced from today's rule.** It can be: today's payer
  depends only on the plan's accounts, by type in the backstop's order and then
  by name (§1.1), so the default is that list, computed and never stored (§4.1).
  Existing plans do not move.
- **Retirement accounts take the user's attention:** confirmed. One pays from the
  order only once the user switches it on, which keeps the backstop policy of
  2026-07-26 (the engine never chooses to spend retirement money).

## Sources

- [ProjectionLab changelog feed](https://projectionlab.com/feed/changelog):
  2.1.0 (2021-11-12, customizable drawdown order), 3.6.1, 4.1.0, 4.2.2 and 4.6.0
  (withdrawal shielding).
- [ProjectionLab: Drawdown Order Visualization](https://projectionlab.com/help/drawdown-order-visualization):
  Settings → Drawdown, the reset to default, the early-withdrawal warning line.
- [Boldin: Planner Operations: Withdrawals](https://help.boldin.com/en/articles/5890649-planner-operations-withdrawals):
  the Traditional and Customized withdrawal orders, excluded accounts, RMDs.
- Measurements in §1.2 and §7: a read-only probe wrapping
  `FundTransfer.reportUnfunded`, `resolveFunding` and `settleOneSided`, preloaded
  with `node --import` into `node tests/tools/snapshot.mjs` (which runs the corpus
  in-process), on main 9c6947f, 2026-10-27. Re-run on main 68d34bd, 2026-10-29,
  with the probes' imports pointed at that checkout. Both times the snapshot
  stayed unchanged.
