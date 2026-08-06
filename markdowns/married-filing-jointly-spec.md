# Spec 5 — Married Filing Jointly

Status: **specification only, no code written.** Written 2026-08-06 against
`claude/mystifying-easley-5e452d` (the snapshot-harness branch), because every
measurement below was produced with `tests/tools/snapshot.mjs` and cannot be
reproduced on `main` until that branch lands.

---

## 1. What already exists

MFJ is not absent. It is roughly half-built, and — this is the important part —
**it is reachable from the shipped UI today**, producing numbers nobody has
checked.

| Piece | State |
| --- | --- |
| `married` income brackets, 2025 and 2026 | present, `js/taxes.js:54,121` |
| `married` capital-gains brackets | present, `js/taxes.js:79,146` |
| `married` standard deduction | present, `js/taxes.js:92,159` |
| Table selection by filing status | present, `js/taxes.js:226` |
| UI selector with a `MFJ` option | present, `index.html:804` |
| Change handler that rebuilds `TaxTable` | present, `js/finplan-app.js:932` |
| Snapshot config header records `filingAs` | present |

`TaxTable.initializeChron` branches on `global_filingAs == 'Single'` and takes
the married tables in the `else`. The UI emits the string `'MFJ'`, which is not
`'Single'`, so it lands in the married branch by falling through rather than by
being recognised. That works, but it means *any* unrecognised string — a
corrupted `localStorage` value, a future `'MFS'` option — silently files a
household jointly. Section 3.7 makes this explicit rather than incidental.

---

## 2. The harness setter is a silent no-op — fix this before anything else

**FIXED 2026-08-06.** The section is kept because the failure mode is the reason
the rest of this spec exists, and because it turned out to be four knobs, not one.

`tests/tools/snapshot.mjs:316` read:

```js
global_filingAs: (v) => G.global_setFilingAs(v),
```

`global_setFilingAs` writes `localStorage` and **does not assign the module
variable**. Only `global_getFilingAs()` copies it back (`js/globals.js:485-493`).
Every other entry in `applyConfig` that touches a `localStorage`-backed global
does the set-then-get pair — the age setters at lines 290-292 do it explicitly.
`global_filingAs` is the one that does not.

Measured:

```
node tests/tools/snapshot.mjs --set global_filingAs=MFJ --only quickstart-midCareer

  config override: global_filingAs=MFJ
  ok       quickstart-midCareer
  1 fixture(s) unchanged. No simulated number moved.
```

Independently confirmed away from the harness, with a throwaway probe:

```
after reset                 global_filingAs=Single   stdDed=16100  10%-bracket-top=12400  iraLimit=7500
setFilingAs(MFJ) only       global_filingAs=Single   stdDed=16100  10%-bracket-top=12400  iraLimit=7500
setFilingAs + getFilingAs   global_filingAs=MFJ      stdDed=32200  10%-bracket-top=24800  iraLimit=15000
```

This is the same shape as the `export let` live-binding trap that already hid a
bug in the 4c work: the write goes somewhere real, so nothing errors, and the
read never changes.

Note the second tell, for the record: under the override the baseline header
still printed `filingAs = Single`. The snapshot format already carried the
evidence; the summary line is what misleads. The config header is the thing to
read first when a `--set` run reports no drift.

### 2.1 It was four of the eight knobs, not one

Checking the other `SETTERS` entries before fixing this one found the same defect
in `global_inflationRate`, `global_taxYear` and `global_propertyTaxRate` — every
`localStorage`-backed global exposed to `--set`. Only
`global_setAllocateHouseholdTax` and `global_setBacktestYearDirect` assign
directly.

Measured before the fix: `--set global_inflationRate=0.02 --only
quickstart-midCareer` reported **"No simulated number moved."** After the fix,
the same command moves finish value by **+$5,165,102 (+126.40%)** — consistent
with the ~$6M swing recorded by hand-built probe in `d5e649a`.

### 2.2 The fix is structural, not per-knob

Fixing four call sites would have left the fifth for whoever adds the next knob.
Each `SETTERS` entry is now `{apply, read}`, and `applyConfig` verifies the value
came back. A knob wired without its getter now exits 2 with a message naming the
cause, instead of reporting that the flag does nothing.

Mutation-verified: dropping `G.global_getFilingAs()` from the entry produces

```
snapshot: --set global_filingAs=MFJ did not take — the global still reads "Single".
```

and exit code 2.

### 2.3 Two findings that fell out of the fix

- **`global_propertyTaxRate` is dead.** With the write now landing, `--set
  global_propertyTaxRate=0.05` *still* produces no drift — because nothing in
  `js/` outside `globals.js` reads it. Property tax comes from each asset's own
  `annualTaxRate`. The global is recorded in the baseline config header and
  exposed to `--set`, implying an influence it does not have.
- **§3.8 is confirmed empirically.** `--set global_taxYear=2025` now lands (the
  guard passes) and still moves nothing, because `initializeChron` hardcodes
  `us_2026_taxtables`. The knob is real, the wiring is not.

Both are worth their own chips; neither belongs in this spec's implementation.

---

## 3. What is actually wrong

### 3.1 The 401(k) limit is not doubled, and is enforced household-wide

`js/taxes.js:230-243` sets, for married:

```js
this.iraContributionLimitBelow50   = 15000;   // doubled from 7500
this.four01KContributionLimit50AndOver = 32500;   // NOT doubled
this.four01KContributionLimitBelow50   = 24500;   // NOT doubled
```

The IRA limit was doubled for married. The 401(k) limit was not. Only one of
those two decisions can be right, and which one is right depends on whether the
limit is a *per-person* limit or a *household* one.

It is enforced as a household one. `js/engines/payroll-engine.js:341` compares
against `this.yearly.four01KContribution` — a `FinancialPackage` field summed
across **all** working-income assets. So an MFJ couple with two salaries and two
401(k)s is capped at a single person's $24,500 rather than $49,000. The same
household-aggregate treatment appears in `js/financial-package.js:49` and
`js/engines/rebalance-engine.js:102`.

The IRA side has the mirror-image defect: $15,000 against a household total is
right for a two-IRA couple, but nothing stops a plan with **one** IRA asset from
receiving the full $15,000 — double the per-person limit — because the cap has
no way to say which spouse an account belongs to.

### 3.2 Every age gate keys off a single `activeUser`

`js/portfolio.js:190` constructs exactly one `User`. Its `age` and `birthYear`
drive:

- the 50-and-over catch-up in both contribution limits (`js/taxes.js:638-650`)
- `rmdRequired()` / `rmdAge()`, which is birth-year banded 72/73/75 (`js/user.js`)
- the tax-allocation deferred-account eligibility gate at age 60
  (`js/engines/tax-engine.js:536`)

A couple with an age gap gets one age for both. The younger spouse's IRA starts
RMDs early, or the older spouse's starts late; the catch-up begins for both on
one 50th birthday. There is **no owner concept on `ModelAsset` at all** —
grepping for `owner` / `spouse` in `js/model-asset.js` and
`js/instruments/instrument.js` returns nothing.

### 3.3 One shared Social Security wage base — and the corpus cannot see it

`TaxTable.yearlySocialSecurityAccumulator` is a single accumulator.
`js/engines/payroll-engine.js:97-98` calls `addYearlySocialSecurity` once per
working-income asset, so **all** salaries share one $184,500 base. Two earners
at $150k each should both pay SS tax on their full wages; today the second one
stops at the household's shared cap. This under-withholds.

**The harness proves this is currently invisible.** Across all 13 fixtures under
`--set global_filingAs=MFJ`, `total.socialSecurityTax` is byte-identical:

```
-   total.socialSecurityTax = -214841.287875      (quickstart-earlyCareer)
+   total.socialSecurityTax = -214841.287875
-   total.socialSecurityTax = -52080.000000       (dividends-caps-and-windfalls)
+   total.socialSecurityTax = -52080.000000
```

Not because the branch is correct — because **no fixture has two working-income
assets**. Section 5.2 turns that into a required fixture.

### 3.4 The home-sale exclusion is hardcoded at $250,000

`js/globals.js:373` — `global_home_sale_capital_gains_discount = 250000`, applied
at `js/taxes.js:455` with no filing-status check. MFJ is $500,000. This is the
cheapest correct fix in the whole spec and it is worth doing on its own.

It also leaks to the UI: `js/rule-notes.js:169` interpolates the same global into
the user-facing note, so an MFJ household is *told* the wrong exclusion, which is
worse than computing it wrong silently.

### 3.5 SS taxability is flat 85%, so filing status cannot reach it

`js/financial-package.js:59-63` adds Social Security to IRS taxable income at a
flat `0.85`. The real rule is a provisional-income ramp with thresholds of
$25k/$34k (single) versus $32k/$44k (MFJ). Because the engine uses a flat rate,
filing status has no effect on it.

This is **pre-existing and already recorded** (code review 2026-07-25) — MFJ does
not cause it. But MFJ is where it hurts most, because a joint retired household's
provisional income is far more likely to sit below the threshold where the ramp
matters. **Out of scope for this spec; call it out so the next reader does not
think it was missed.**

### 3.6 Not modelled for either status — explicitly out of scope

None of these exist today for Single either, so their absence under MFJ is not a
regression:

- NIIT 3.8% over $200k / $250k
- Additional Medicare 0.9% over $200k / $250k (`calculateMedicareTax` is flat,
  with no threshold at all)
- Roth and traditional-IRA income phase-outs
- IRMAA

### 3.7 Filing status is a bare string with no validated domain

`'Single'` in `js/globals.js:252`, `'MFJ'` in `index.html:806`, `"single"` /
`"married"` as `filingType` keys in the tax tables, and a `!= 'Single'` test as
the only branch. Three vocabularies for one concept. Adding MFS or HoH later
means touching every one of them.

### 3.8 Side observation — `taxYear` is decorative

Not MFJ, but found while reading: the baseline header records `taxYear = 2025`
while `TaxTable.initializeChron` hardcodes `us_2026_taxtables` (`js/taxes.js:225`).
`us_2025_taxtables` is exported and never selected. Worth its own chip; do not
fold it into this work.

---

## 4. Scope — DECIDED 2026-08-06

**Household-level MFJ now; per-person MFJ as its own later spec.**

In scope: filing status changes brackets, the standard deduction, contribution
limits and the home-sale exclusion. There is still one `User` and one age.
Contribution limits become explicitly "household, doubled where the law is
per-person". This fixes 3.1, 3.4 and 3.7, and documents 3.2 and 3.3 as known
limits rather than pretending they are handled.

Deferred: `owner: 'primary' | 'spouse'` on `ModelAsset`, a second `User` with its
own age and birth year, per-owner FICA accumulators and per-owner contribution
limits. That work touches `ModelAsset` persistence, the asset editor UI, the
quick-start profiles and the GA, and it collides directly with the in-flight
`stableId` migration.

**The ownership seam is built now so the deferred work is purely additive.**
Concretely:

- both contribution limits route through a single `limitFor(kind, user)` helper
  rather than the five scattered `activeTaxTable.*ContributionLimit(...)` call
  sites in `payroll-engine`, `rebalance-engine` and `financial-package`
- FICA accumulation routes through a per-owner keyed accumulator that this spec
  instantiates with exactly one key

The later spec then adds a second key and a second `User`, rather than rewriting
call sites. Both seams are step 3 and step 5 below, and both are expected to
produce an **empty** baseline diff — which is how we will know the seam changed
structure and not behaviour.

A consequence worth stating plainly: while one age serves both spouses, an MFJ
household with an age gap gets the wrong RMD start and the wrong catch-up start.
That is a documented limitation of this spec, not an oversight, and it should be
surfaced in the UI copy for the MFJ option rather than left for a user to
discover.

---

## 5. How the harness verifies this

This is the part worth the most. The harness does four separable jobs here, and
three of them are things an assertion suite structurally cannot do.

### 5.1 It answers "what would MFJ do?" before any code exists

Already run, with the section-2 fix applied temporarily and then reverted.
**9 of 13 fixtures drift.** The four shipped profiles:

| Fixture | finish value | lifetime income tax |
| --- | --- | --- |
| quickstart-earlyCareer | 18,593,499 → 20,699,403 (+11.33%) | −765,703 → −603,944 (+21.13%) |
| quickstart-midCareer | 4,086,291 → 6,101,601 (+49.32%) | −412,809 → −339,012 (+17.88%) |
| quickstart-preRetirement | 11,768,933 → 12,904,468 (+9.65%) | −687,121 → −414,847 (+39.63%) |
| quickstart-retired | 8,462,112 → 9,044,552 (+6.88%) | −525,412 → −304,429 (+42.06%) |

Directionally this is what doubled brackets and a doubled standard deduction must
do, and `total.employedIncome` and `total.socialSecurityIncome` are unchanged in
every case, which is the check that nothing but tax moved. That is the "actual"
half of predict-before-engine-fix, obtained without writing a probe — which is
exactly the cost the house rule used to carry.

The midCareer +49% is the one to interrogate before trusting any of it. A
household-level rate cut should not nearly double terminal wealth on its own;
compounding over 46 years on the retained tax is the likely explanation, and it
is the first prediction to write down and check.

### 5.2 It shows which branches MFJ makes vacuous

Under MFJ, `capitalGainsTax` **drops out of `[emitted]` entirely.** It is
currently reached by exactly one fixture (`quickstart-earlyCareer`), and doubling
the 0% LTCG bracket from $49,450 to $98,900 swallows every realised gain in the
corpus.

So if MFJ fixtures are added — or worse, if the default is ever flipped — every
assertion about capital-gains tax becomes vacuous, silently, with the suite
green. That is precisely the failure mode this project keeps hitting, and the
coverage report caught it in the first exploratory run.

**Required fixtures, therefore:**

| Fixture | Exists to reach |
| --- | --- |
| `mfj-two-earners` | two `workingIncome` assets, each above the SS wage base — the only way to reach the shared-accumulator bug in 3.3, which is currently unreachable |
| `mfj-high-earner-ltcg` | gains large enough to clear the doubled 0% LTCG bracket, so `capitalGainsTax` stays emitted under MFJ |
| `mfj-two-401ks` | two 401(k) destinations, so the household-vs-per-person cap in 3.1 produces a visible `contributionCapped` difference |
| `mfj-home-sale` | primary home sold after 24 months with a gain between $250k and $500k — the exclusion in 3.4 changes the answer only in that window |

Each needs a `reaches:` note per the fixtures.mjs convention.

### 5.3 It proves the negatives, which is the part assertions get wrong

The byte-identical `socialSecurityTax` in 3.3 is a *finding*, not a pass. An
assertion suite would have reported green and said nothing. The snapshot says
"this number did not move across 13 fixtures", and that statement is what tells
us the two-earner branch is untested rather than correct.

Same pattern applies to the eventual MFJ work: after each commit, the fixtures
that should be untouched must show an **empty** baseline diff. Single-filer
fixtures must not move at all when contribution limits are made per-person — and
"must not move" is checkable as bytes rather than as a claim.

### 5.4 It makes the PR reviewable as text

Because the baselines are committed, "MFJ changes tax and nothing else" stops
being a claim and becomes `git diff tests/baselines/`. For a change this broad,
that is the difference between a reviewable PR and an unreviewable one.

### 5.5 Harness changes this work requires

1. **The section-2 setter fix.** One line, first commit.
2. **`filingAs` in the fixture `config` block.** `applyConfig` currently reads
   `startAge` / `retirementAge` / `finishAge`; it needs `filingAs` so an MFJ
   fixture declares its status rather than inheriting the reset default. Its
   value already appears in the recorded header, so no format change is needed.
3. **Mutation-verify each fixture as it is added** — per the house rule, a new
   fixture that does not move when its target line is mutated is not coverage.

---

## 6. Proposed sequencing

Each step is one commit, each ends with a blessed baseline diff that matches a
written prediction.

| # | Change | Expected baseline effect |
| --- | --- | --- |
| 0 | Fix the `--set global_filingAs` no-op | none — `--set` is not blessed |
| 1 | Add `filingAs` to fixture config; add the four MFJ fixtures | new baselines only; Single fixtures byte-identical |
| 2 | Home-sale exclusion by filing status (3.4) + the rule note | `mfj-home-sale` only |
| 3 | Filing-status vocabulary: one validated enum, `'MFJ'` recognised rather than defaulted (3.7) | none — pure refactor, empty diff is the proof |
| 4 | Contribution limits: per-person semantics behind `limitFor(kind, user)` (3.1) | `mfj-two-401ks`; Single fixtures unchanged |
| 5 | Owner-keyed FICA accumulator with a single key (3.3, seam only) | none — empty diff is the proof |

Steps 3 and 5 are the ones where an **empty** baseline diff is the deliverable.
That is a thing this harness can assert and the previous test suite could not.

Deferred to their own specs: per-person `User` and asset ownership (§4), SS
provisional-income taxability (3.5), `taxYear` selection (3.8).

---

## 7. Predictions, and what actually happened

Recorded before step 1 was written, checked after. Steps 0 and 1 are done.

**1. Adding the four MFJ fixtures leaves all 13 existing baselines
byte-identical. — HELD.** All 13 reported `ok`; only the four new fixtures were
`MISSING` and `_coverage` drifted.

**2. `mfj-two-earners` shows the two salaries sharing one Social Security wage
base. — HELD, and it is stark.** Each earner makes $18,000/month ($216,000/year),
so each should pay SS tax until roughly month 11 of each year. In the baseline,
withholding for Salary A drops from $1,377/month (6.2% SS + 1.45% Medicare) to
$261/month (Medicare only) in **June** — month 6. The two earners are splitting a
single $184,500 base. This is the first time bug 3.3 has been visible anywhere in
the corpus.

**3. `mfj-high-earner-ltcg` restores `capitalGainsTax` to `[emitted]`. — FAILED
FIRST, then held.** The first draft emitted `capitalGainRecognized` and no tax at
all. Two reasons, both worth recording because they are properties of the engine
and not of the fixture:

- `CAPITAL_GAINS_TAX` is emitted **only on close** — `tax-engine.js:287` reads
  `finishCurrency − finishBasisCurrency`. Ongoing withdrawals recognise gains but
  never emit it. The draft funded a $22,000/month expense from the brokerage, so
  the account closed at ~$0 and there was no gain left to tax.
- the tax is priced against annualised income *at the moment of close*, so an
  asset closing in the plan's final month is valued against almost no income —
  the known close-time-LTCG gap from the 2026-07-25 review. Under MFJ's doubled
  0% bracket that swallows the gain entirely.

The fixture now closes the brokerage in 2029-06 while a salary is still running.
Result: a $2,066,065 gain taxed $363,327, and `[never emitted]` still reads
"(none)".

**4. `mfj-two-401ks` emits `contributionCapped` where a per-person limit would
not have capped. — HELD.** Present in its coverage entry. Step 4 must remove it.

**5. Step 3 (the vocabulary refactor) produces an empty baseline diff.** Not yet
checked — step 3 is not written.

### 7.1 Two harness defects found while doing this

- **`--set` was a no-op for four of eight knobs.** Section 2. Fixed in step 0.
- **`--bless --only` silently leaves `_coverage.snap` stale.** Coverage is
  corpus-wide so a filtered run correctly skips it, but the combination rewrites
  the filtered baselines and leaves the coverage report describing the corpus as
  it used to be. That is how a branch going unreached would go unnoticed — the
  exact failure this file exists to prevent. It cost real confusion here: a
  partial bless left an entry describing a fixture two revisions old, which read
  as "prediction 3 failed" after it had actually started passing. The tool now
  prints a NOTE when both flags are used.
