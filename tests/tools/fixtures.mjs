/**
 * fixtures.mjs — the snapshot corpus.
 *
 * A shared, deliberately-chosen set of portfolios for tools/snapshot.mjs. Two
 * kinds, and both are needed:
 *
 *   REAL      the four quick-start profiles the product actually ships. Phased,
 *             with life events, salaries, mortgages and retirement transitions.
 *             These are the shapes users see; a change that moves them is a
 *             change that matters.
 *
 *   ADVERSARIAL  small synthetic plans built to reach a specific branch that the
 *             real profiles never touch. Every one of these exists because a bug
 *             hid in that branch, or because a test was found to be vacuous
 *             without it. Each carries a `reaches:` note saying what it is for —
 *             if you are tempted to delete or "simplify" one, that note is the
 *             reason not to.
 *
 * Adding a fixture is cheap and almost always right. The snapshot's coverage
 * section reports which EventTypes no fixture emits, so gaps are visible rather
 * than assumed.
 *
 * IMPORTANT: fixtures must be pure data plus a builder. No wall-clock reads, no
 * randomness — see the clock pin in snapshot.mjs.
 */

import { ModelAsset } from '../../js/model-asset.js';
import { DateInt } from '../../js/utils/date-int.js';
import { quickStartProfiles, buildQuickStart } from '../../js/quick-start.js';

// ── Synthetic fixture shorthand ──────────────────────────────────────

const START = { year: 2026, month: 1 };
const DEC = { year: 2030, month: 12 };   // finishes ON a year boundary
const JUL = { year: 2030, month: 7 };    // finishes mid-year

/** Asset JSON with the boilerplate filled in. */
const asset = (finish) => (x) => ({
  startDateInt: START,
  finishDateInt: finish,
  annualReturnRate: { rate: 0 },
  ...x,
});

const xfer = (to, monthly, close = 0) => ({
  toDisplayName: to, monthlyMoveValue: monthly, closeMoveValue: close,
});

// ── The corpus ───────────────────────────────────────────────────────

/**
 * @typedef {object} Fixture
 * @property {string} name          stable — it is the baseline filename
 * @property {string} kind          'real' | 'adversarial'
 * @property {string} reaches       what this fixture exists to exercise
 * @property {object} config        ages and any non-default globals
 * @property {() => {assets, lifeEvents, guardrails}} build
 */

/** The four shipped profiles, snapshotted under a pinned clock. */
const realFixtures = quickStartProfiles.map((profile) => ({
  name: `quickstart-${profile.key}`,
  kind: 'real',
  reaches:
    'the shipped product shape: phased life events, payroll, contributions, ' +
    'retirement transition, close transfers',
  config: {
    startAge: profile.startAge,
    retirementAge: profile.retirementAge,
    finishAge: profile.finishAge,
  },
  build() {
    const qs = buildQuickStart(profile);
    return { assets: qs.assets, lifeEvents: qs.lifeEvents.map((e) => e.copy()) };
  },
}));

const adversarialFixtures = [
  {
    name: 'housing-carrying-costs',
    kind: 'adversarial',
    reaches:
      'one-sided settlement of maintenance / insurance / property tax against a ' +
      'funded backstop, plus mortgage interest-vs-principal sign conventions',
    config: { startAge: 50, retirementAge: 65 },
    build: () => ({
      assets: [
        asset(DEC)({ instrument: 'realEstate', displayName: 'Home', isPrimaryHome: true,
          startCurrency: { amount: 500000 }, startBasisCurrency: { amount: 500000 },
          annualReturnRate: { rate: 0.03 }, annualTaxRate: { rate: 0.012 },
          annualMaintenanceRate: { rate: 0.01 }, annualInsuranceCost: { amount: 2400 } }),
        asset(DEC)({ instrument: 'mortgage', displayName: 'Mortgage',
          startCurrency: { amount: -300000 }, startBasisCurrency: { amount: 0 },
          annualReturnRate: { rate: 0.065 }, monthsRemaining: 360 }),
        asset(DEC)({ instrument: 'bank', displayName: 'Checking',
          startCurrency: { amount: 4000 }, startBasisCurrency: { amount: 4000 } }),
        asset(DEC)({ instrument: 'taxableEquity', displayName: 'Brokerage',
          startCurrency: { amount: 400000 }, startBasisCurrency: { amount: 200000 },
          annualReturnRate: { rate: 0.07 } }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'retired-deferred-draw',
    kind: 'adversarial',
    reaches:
      'retirement income withholding at source (spec 4b/4c), IRA distributions, ' +
      'and a monthly true-up billed to a well-funded bank backstop',
    config: { startAge: 75, retirementAge: 65 },
    build: () => ({
      assets: [
        asset(DEC)({ instrument: 'retirementIncome', displayName: 'Social Security',
          startCurrency: { amount: 3000 }, startBasisCurrency: { amount: 0 },
          fundTransfers: [xfer('Savings', 100)] }),
        asset(DEC)({ instrument: 'ira', displayName: 'IRA',
          startCurrency: { amount: 800000 }, startBasisCurrency: { amount: 0 } }),
        asset(DEC)({ instrument: 'bank', displayName: 'Savings',
          startCurrency: { amount: 200000 }, startBasisCurrency: { amount: 200000 } }),
        asset(DEC)({ instrument: 'monthlyExpense', displayName: 'Living',
          startCurrency: { amount: -5000 }, startBasisCurrency: { amount: 0 } }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'annual-trueup-from-brokerage',
    kind: 'adversarial',
    reaches:
      'THE LAST THING THE RUN DOES. chronometer_run calls applyYear after ' +
      'monthlyChron, so the annual tax true-up emits past the reconciliation ' +
      'scan index; the final year has no next month to catch it. This plan ends ' +
      'in December AND settles a real residual from a brokerage, so the trailing ' +
      'pass sees both a taxTrueUp and a capitalGainRecognized. Without a fixture ' +
      'that reaches it, Portfolio.finalSanityCheck could be deleted with the ' +
      'whole suite green (verified by mutation 2026-08-05).',
    config: { startAge: 75, retirementAge: 65 },
    build: () => ({
      assets: [
        asset(DEC)({ instrument: 'retirementIncome', displayName: 'Social Security',
          startCurrency: { amount: 3000 }, startBasisCurrency: { amount: 0 } }),
        asset(DEC)({ instrument: 'ira', displayName: 'IRA',
          startCurrency: { amount: 600000 }, startBasisCurrency: { amount: 0 } }),
        asset(DEC)({ instrument: 'taxableEquity', displayName: 'Brokerage',
          startCurrency: { amount: 500000 }, startBasisCurrency: { amount: 150000 },
          annualReturnRate: { rate: 0.06 } }),
        asset(DEC)({ instrument: 'bank', displayName: 'Checking',
          startCurrency: { amount: 2000 }, startBasisCurrency: { amount: 2000 } }),
        asset(DEC)({ instrument: 'monthlyExpense', displayName: 'Living',
          startCurrency: { amount: -7000 }, startBasisCurrency: { amount: 0 } }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'mid-year-finish',
    kind: 'adversarial',
    reaches:
      'the OTHER side of the year-boundary branch: a plan whose last month is ' +
      'July never rolls into January, so the final annual pass never runs and the ' +
      'trailing reconciliation must find nothing. Also the stub-year guardrail ' +
      'snapshot, which is skipped entirely on a December finish.',
    config: { startAge: 75, retirementAge: 65 },
    build: () => ({
      assets: [
        asset(JUL)({ instrument: 'retirementIncome', displayName: 'Social Security',
          startCurrency: { amount: 3000 }, startBasisCurrency: { amount: 0 } }),
        asset(JUL)({ instrument: 'ira', displayName: 'IRA',
          startCurrency: { amount: 800000 }, startBasisCurrency: { amount: 0 } }),
        asset(JUL)({ instrument: 'bank', displayName: 'Savings',
          startCurrency: { amount: 200000 }, startBasisCurrency: { amount: 200000 } }),
        asset(JUL)({ instrument: 'monthlyExpense', displayName: 'Living',
          startCurrency: { amount: -5000 }, startBasisCurrency: { amount: 0 } }),
      ].map(ModelAsset.fromJSON),
      guardrails: {
        withdrawalRate: 4, preservation: 20, prosperity: 20, adjustment: 10,
        retirementDateInt: DateInt.from(2026, 1),
      },
    }),
  },
  {
    name: 'settlement-spills',
    kind: 'adversarial',
    reaches:
      'a one-sided settlement whose funding account clamps at $0 and re-sources ' +
      'from the next backstop — SPILLOVER tagged with the ONE_SIDED origin. The ' +
      'quick-start profiles never spill from a settlement, which is why tagging ' +
      'that path wrongly was invisible for months.',
    config: { startAge: 50, retirementAge: 65 },
    build: () => ({
      assets: [
        asset(DEC)({ instrument: 'realEstate', displayName: 'Home', isPrimaryHome: true,
          startCurrency: { amount: 600000 }, startBasisCurrency: { amount: 600000 },
          annualReturnRate: { rate: 0.03 }, annualTaxRate: { rate: 0.015 },
          annualMaintenanceRate: { rate: 0.02 }, annualInsuranceCost: { amount: 6000 } }),
        asset(DEC)({ instrument: 'bank', displayName: 'Checking',
          startCurrency: { amount: 3000 }, startBasisCurrency: { amount: 3000 } }),
        asset(DEC)({ instrument: 'taxableEquity', displayName: 'Brokerage',
          startCurrency: { amount: 900000 }, startBasisCurrency: { amount: 600000 },
          annualReturnRate: { rate: 0.06 } }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'settlement-unfunded',
    kind: 'adversarial',
    reaches:
      'settleOneSided with NO fallback at all — the UNFUNDED branch. The spill ' +
      'fixture above never reaches it because it has a Brokerage to fall back on.',
    config: { startAge: 50, retirementAge: 65 },
    build: () => ({
      assets: [
        asset(DEC)({ instrument: 'realEstate', displayName: 'Home', isPrimaryHome: true,
          startCurrency: { amount: 600000 }, startBasisCurrency: { amount: 600000 },
          annualReturnRate: { rate: 0.03 }, annualTaxRate: { rate: 0.015 },
          annualMaintenanceRate: { rate: 0.02 }, annualInsuranceCost: { amount: 6000 } }),
        asset(DEC)({ instrument: 'bank', displayName: 'Checking',
          startCurrency: { amount: 3000 }, startBasisCurrency: { amount: 3000 } }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'settlement-exhausts-fallback',
    kind: 'adversarial',
    reaches:
      'DOUBLE depletion — the funding account clamps AND its fallback clamps in ' +
      'the same draw, reaching settleOneSided\'s inner unfunded branch. Needs an ' +
      'obligation big enough to exhaust both in one month, hence the punitive ' +
      'carrying costs against tiny balances.',
    config: { startAge: 50, retirementAge: 65 },
    build: () => ({
      assets: [
        asset(DEC)({ instrument: 'realEstate', displayName: 'Home', isPrimaryHome: true,
          startCurrency: { amount: 1200000 }, startBasisCurrency: { amount: 1200000 },
          annualReturnRate: { rate: 0.03 }, annualTaxRate: { rate: 0.02 },
          annualMaintenanceRate: { rate: 0.05 }, annualInsuranceCost: { amount: 24000 } }),
        asset(DEC)({ instrument: 'cash', displayName: 'Wallet',
          startCurrency: { amount: 1200 }, startBasisCurrency: { amount: 1200 } }),
        asset(DEC)({ instrument: 'taxableEquity', displayName: 'Brokerage',
          startCurrency: { amount: 2500 }, startBasisCurrency: { amount: 2500 } }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'dividends-caps-and-windfalls',
    kind: 'adversarial',
    reaches:
      'three EventTypes the rest of the corpus never emitted, found by this ' +
      'tool\'s own coverage report rather than by guessing: DIVIDEND (qualified ' +
      'AND non-qualified, via a split ratio), CONTRIBUTION_CAPPED (a 401K ' +
      'transfer deliberately set above the annual limit), and ONE_TIME (a ' +
      'windfall credit and a one-off debit). Every assertion about those three ' +
      'was vacuous until this fixture existed.',
    config: { startAge: 40, retirementAge: 65 },
    build: () => ({
      assets: [
        asset(DEC)({ instrument: 'workingIncome', displayName: 'Salary',
          startCurrency: { amount: 14000 }, startBasisCurrency: { amount: 0 },
          // Well above the annual 401(k) limit, which is the point.
          fundTransfers: [xfer('401K', 4000), xfer('Brokerage', 2000)] }),
        asset(DEC)({ instrument: '401K', displayName: '401K',
          startCurrency: { amount: 250000 }, startBasisCurrency: { amount: 0 },
          annualReturnRate: { rate: 0.05 } }),
        asset(DEC)({ instrument: 'taxableEquity', displayName: 'Brokerage',
          startCurrency: { amount: 300000 }, startBasisCurrency: { amount: 200000 },
          annualReturnRate: { rate: 0.04 },
          // Split ratio so BOTH dividend branches fire — a ratio of 1.0 leaves
          // the non-qualified recordEvent unreached.
          annualDividendRate: { rate: 0.025 }, dividendQualifiedRatio: 0.7 }),
        asset(DEC)({ instrument: 'bank', displayName: 'Checking',
          startCurrency: { amount: 25000 }, startBasisCurrency: { amount: 25000 },
          oneTimeEvents: [
            { dateInt: { year: 2027, month: 6 }, amount: { amount: 50000 }, note: 'Inheritance' },
            { dateInt: { year: 2028, month: 9 }, amount: { amount: -18000 }, note: 'Roof replacement' },
          ] }),
        asset(DEC)({ instrument: 'monthlyExpense', displayName: 'Living',
          startCurrency: { amount: -6000 }, startBasisCurrency: { amount: 0 } }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  // ── Married Filing Jointly (spec 5) ────────────────────────────────
  // Every fixture below declares `filingAs: 'MFJ'`. They exist because the
  // Single-filer corpus cannot reach the branches MFJ changes — measured, not
  // assumed: under `--set global_filingAs=MFJ` the entire 13-fixture corpus
  // showed byte-identical socialSecurityTax and LOST capitalGainsTax from
  // coverage altogether.
  {
    name: 'mfj-two-earners',
    kind: 'adversarial',
    reaches:
      'TWO working-income assets, each earning above the Social Security wage ' +
      'base. TaxTable keeps ONE yearlySocialSecurityAccumulator and ' +
      'payroll-engine calls addYearlySocialSecurity once per income asset, so ' +
      'both salaries share a single $184,500 base and the second earner stops ' +
      'paying SS tax early. No other fixture has more than one working income, ' +
      'which is why the whole corpus reported identical socialSecurityTax under ' +
      'MFJ — the branch was unreachable, not correct.',
    config: { startAge: 45, retirementAge: 67, filingAs: 'MFJ' },
    build: () => ({
      assets: [
        asset(DEC)({ instrument: 'workingIncome', displayName: 'Salary A',
          startCurrency: { amount: 18000 }, startBasisCurrency: { amount: 0 } }),
        asset(DEC)({ instrument: 'workingIncome', displayName: 'Salary B',
          startCurrency: { amount: 18000 }, startBasisCurrency: { amount: 0 } }),
        asset(DEC)({ instrument: 'bank', displayName: 'Checking',
          startCurrency: { amount: 20000 }, startBasisCurrency: { amount: 20000 } }),
        asset(DEC)({ instrument: 'monthlyExpense', displayName: 'Living',
          startCurrency: { amount: -9000 }, startBasisCurrency: { amount: 0 } }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'mfj-high-earner-ltcg',
    kind: 'adversarial',
    reaches:
      'capitalGainsTax UNDER MFJ. The married 0% LTCG bracket is $98,900 against ' +
      "single's $49,450, and quickstart-earlyCareer is the only fixture in the " +
      'corpus that emits capitalGainsTax at all — so switching it to MFJ drops ' +
      'the type out of [emitted] entirely and every assertion about capital-gains ' +
      'tax becomes vacuous with the suite green. Found by this tool\'s own ' +
      'coverage report, not by guessing.\n' +
      '      Two things had to be true, and the first draft got both wrong. ' +
      'CAPITAL_GAINS_TAX is emitted only on CLOSE (tax-engine reads ' +
      'finishCurrency − finishBasisCurrency), not on ongoing withdrawals, so the ' +
      'brokerage must survive to its close date rather than being drained by an ' +
      'expense — a draft that funded a large expense from it closed at ~$0 gain ' +
      'and emitted nothing. And the tax is computed against annualised income at ' +
      'the moment of close, so the brokerage closes in 2029 while the salary is ' +
      'still running; closing it in the final month would price the gain against ' +
      'almost no income (the known close-time-LTCG gap, review 2026-07-25) and ' +
      'the doubled 0% bracket would swallow it again.',
    config: { startAge: 55, retirementAge: 67, filingAs: 'MFJ' },
    build: () => ({
      assets: [
        asset(DEC)({ instrument: 'workingIncome', displayName: 'Salary',
          startCurrency: { amount: 20000 }, startBasisCurrency: { amount: 0 } }),
        asset({ year: 2029, month: 6 })({ instrument: 'taxableEquity', displayName: 'Brokerage',
          startCurrency: { amount: 2000000 }, startBasisCurrency: { amount: 400000 },
          annualReturnRate: { rate: 0.06 } }),
        asset(DEC)({ instrument: 'bank', displayName: 'Checking',
          startCurrency: { amount: 25000 }, startBasisCurrency: { amount: 25000 } }),
        asset(DEC)({ instrument: 'monthlyExpense', displayName: 'Living',
          startCurrency: { amount: -8000 }, startBasisCurrency: { amount: 0 } }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'mfj-two-401ks',
    kind: 'adversarial',
    reaches:
      'the household-vs-per-person 401(k) cap. four01KContributionLimit returns ' +
      'the SAME $24,500 for married as for single, and payroll-engine compares it ' +
      'against this.yearly.four01KContribution — a household aggregate summed ' +
      'across every income asset. Each salary here defers $24,000/yr, which no ' +
      'per-person limit would cap, so the contributionCapped this fixture emits ' +
      'is exactly the defect. When spec 5 step 4 makes the limit per-person, this ' +
      'baseline must lose those events.',
    config: { startAge: 45, retirementAge: 67, filingAs: 'MFJ' },
    build: () => ({
      assets: [
        asset(DEC)({ instrument: 'workingIncome', displayName: 'Salary A',
          startCurrency: { amount: 12000 }, startBasisCurrency: { amount: 0 },
          fundTransfers: [xfer('401K A', 2000)] }),
        asset(DEC)({ instrument: 'workingIncome', displayName: 'Salary B',
          startCurrency: { amount: 12000 }, startBasisCurrency: { amount: 0 },
          fundTransfers: [xfer('401K B', 2000)] }),
        asset(DEC)({ instrument: '401K', displayName: '401K A',
          startCurrency: { amount: 150000 }, startBasisCurrency: { amount: 0 },
          annualReturnRate: { rate: 0.05 } }),
        asset(DEC)({ instrument: '401K', displayName: '401K B',
          startCurrency: { amount: 90000 }, startBasisCurrency: { amount: 0 },
          annualReturnRate: { rate: 0.05 } }),
        asset(DEC)({ instrument: 'bank', displayName: 'Checking',
          startCurrency: { amount: 15000 }, startBasisCurrency: { amount: 15000 } }),
        asset(DEC)({ instrument: 'monthlyExpense', displayName: 'Living',
          startCurrency: { amount: -8000 }, startBasisCurrency: { amount: 0 } }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'mfj-home-sale',
    kind: 'adversarial',
    reaches:
      'the primary-home capital-gains exclusion, sized to the window where filing ' +
      'status is the whole answer. The home closes after more than 24 months with ' +
      'a gain of roughly $400k: single excludes $250k and taxes the rest, MFJ ' +
      'excludes $500k and taxes nothing. Today the exclusion is the hardcoded ' +
      'global_home_sale_capital_gains_discount = 250000 with no filing check ' +
      '(taxes.js), so THIS BASELINE IS EXPECTED TO BE WRONG when first recorded. ' +
      'It exists so spec 5 step 2 has something that must move; a gain outside ' +
      'that $250k-$500k window would leave step 2 with an empty diff and no proof.',
    config: { startAge: 55, retirementAge: 67, filingAs: 'MFJ' },
    build: () => ({
      assets: [
        asset({ year: 2029, month: 6 })({ instrument: 'realEstate', displayName: 'Home',
          isPrimaryHome: true,
          startCurrency: { amount: 800000 }, startBasisCurrency: { amount: 400000 },
          annualReturnRate: { rate: 0.03 }, annualTaxRate: { rate: 0.011 },
          annualMaintenanceRate: { rate: 0.01 }, annualInsuranceCost: { amount: 3000 } }),
        asset(DEC)({ instrument: 'workingIncome', displayName: 'Salary',
          startCurrency: { amount: 9000 }, startBasisCurrency: { amount: 0 } }),
        asset(DEC)({ instrument: 'bank', displayName: 'Checking',
          startCurrency: { amount: 30000 }, startBasisCurrency: { amount: 30000 } }),
        asset(DEC)({ instrument: 'monthlyExpense', displayName: 'Living',
          startCurrency: { amount: -6000 }, startBasisCurrency: { amount: 0 } }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'single-home-sale',
    kind: 'adversarial',
    reaches:
      'the SINGLE-filer half of the §121 exclusion, and the only fixture where ' +
      'part of a home gain is excluded and part is genuinely taxed — the same ' +
      '$488,452 gain as mfj-home-sale, $250,000 excluded here against $500,000 ' +
      'there.\n' +
      '      It exists because §121 was reachable from ONE fixture, and that ' +
      'fixture was married — so spec 5 step 2b could have been implemented for ' +
      'married filers alone with the whole suite green. The partial-exclusion ' +
      'case is also the one that distinguishes "exclusion applied once" from ' +
      '"exclusion applied at close and handed back by the annual true-up": a ' +
      'fully-excluded gain leaves no tax to get wrong.\n' +
      '      THE $150,000 CHECKING BALANCE IS LOAD-BEARING, and is the only ' +
      'thing that stops this fixture being vacuous. A single filer pays ' +
      'materially more tax here than the married one, and at $30,000 Checking ' +
      'ran dry — at which point FundTransfer.resolveFunding returns null and ' +
      'applyAnnualTaxTrueUp SILENTLY RETURNS without booking anything ' +
      '(tax-engine.js, `if (!liquidAsset) return;`). The true-up then produced ' +
      'the same nothing whether the exclusion was subtracted or not, so ' +
      'mutating the fix left this fixture green. Caught by mutation testing on ' +
      '2026-08-06; do not trim this balance.',
    config: { startAge: 55, retirementAge: 67, filingAs: 'Single' },
    build: () => ({
      assets: [
        asset({ year: 2029, month: 6 })({ instrument: 'realEstate', displayName: 'Home',
          isPrimaryHome: true,
          startCurrency: { amount: 800000 }, startBasisCurrency: { amount: 400000 },
          annualReturnRate: { rate: 0.03 }, annualTaxRate: { rate: 0.011 },
          annualMaintenanceRate: { rate: 0.01 }, annualInsuranceCost: { amount: 3000 } }),
        asset(DEC)({ instrument: 'workingIncome', displayName: 'Salary',
          startCurrency: { amount: 9000 }, startBasisCurrency: { amount: 0 } }),
        asset(DEC)({ instrument: 'bank', displayName: 'Checking',
          startCurrency: { amount: 150000 }, startBasisCurrency: { amount: 150000 } }),
        asset(DEC)({ instrument: 'monthlyExpense', displayName: 'Living',
          startCurrency: { amount: -6000 }, startBasisCurrency: { amount: 0 } }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'deferred-close-distribution',
    kind: 'adversarial',
    reaches:
      'applyDeferredCloseDistribution, which on 2026-08-06 was reached by ' +
      'NOTHING. Multiplying its withholding by 7.77 left all 18 baselines ' +
      'unchanged and all 34 integration suites passing — the entire branch, ' +
      'including its incremental tax(income+distribution) − tax(income) ' +
      'calculation, could be deleted or inverted in silence.\n' +
      '      The reason it was unreachable is a property of the engine worth ' +
      'knowing: an asset only CLOSES when its finishDateInt precedes the plan ' +
      'end. Every IRA and 401(K) in the corpus ran to the end, so none of them ' +
      'ever closed. Hence the 2029-06 finish dates here against a 2030-12 plan.\n' +
      '      The salary is load-bearing too. The marginal calculation is only ' +
      'meaningfully different from a standalone tax(distribution) when other ' +
      'income already exists — with no salary it would walk the brackets from ' +
      '$0 and the branch would be exercised but not DISCRIMINATED. Two deferred ' +
      'accounts closing in the same month also pin the ordering: the second ' +
      "one's baseline income includes the first one's distribution.",
    config: { startAge: 62, retirementAge: 67, filingAs: 'Single' },
    build: () => ({
      assets: [
        asset(DEC)({ instrument: 'workingIncome', displayName: 'Salary',
          startCurrency: { amount: 9000 }, startBasisCurrency: { amount: 0 } }),
        asset({ year: 2029, month: 6 })({ instrument: 'ira', displayName: 'IRA',
          startCurrency: { amount: 400000 }, startBasisCurrency: { amount: 0 },
          annualReturnRate: { rate: 0.05 } }),
        asset({ year: 2029, month: 6 })({ instrument: '401K', displayName: '401K',
          startCurrency: { amount: 300000 }, startBasisCurrency: { amount: 0 },
          annualReturnRate: { rate: 0.05 } }),
        asset(DEC)({ instrument: 'bank', displayName: 'Checking',
          startCurrency: { amount: 60000 }, startBasisCurrency: { amount: 60000 } }),
        asset(DEC)({ instrument: 'monthlyExpense', displayName: 'Living',
          startCurrency: { amount: -6000 }, startBasisCurrency: { amount: 0 } }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'grossup-at-the-ltcg-boundary',
    kind: 'adversarial',
    reaches:
      'calculateGrossWithdrawal — the gross-up that enlarges a withdrawal to ' +
      'cover the tax on the gain the withdrawal itself realises, W = X / ' +
      '(1 − t·g). It was reached only incidentally, by two fixtures built for ' +
      'other things.\n' +
      '      Reaching it is not enough, because it consumes the tax base ONLY ' +
      'through getMarginalLTCGRate — a three-step function. A base that shifts ' +
      'without crossing 0%/15%/20% changes nothing, so a fixture parked deep ' +
      'inside a band reports "no drift" for almost any error and proves ' +
      'nothing. This one straddles the 0%/15% boundary, with an 80% gain ratio ' +
      '(basis $100,000 on $500,000) so the gross-up is worth ~13.6% of a ' +
      'withdrawal whenever the rate is 15%.\n' +
      '      MEASURED, not assumed. It catches forcing the rate to 0.5, and it ' +
      'catches replacing the taxable base with the gross rollup — the second ' +
      'being the realistic error, which annual-trueup-from-brokerage also ' +
      'catches but dividends-caps-and-windfalls does not. The three fixtures ' +
      'are complementary rather than redundant.\n' +
      '      WHAT IT DOES NOT CATCH: skipping limitDeductions, or capping ' +
      'before annualising instead of after. Both shift the base by the 401(k) ' +
      'overage without moving it across a bracket edge here, so ' +
      'dividends-caps-and-windfalls remains the ONLY fixture catching those ' +
      'two. The primary guard for them is tests/unit/tax-basis.test.js, which ' +
      'asserts both directly. The deferral below is still deliberately above ' +
      'the annual limit — it exercises the capping path and emits ' +
      'contributionCapped — it just does not discriminate it here.\n' +
      '      Probing this fixture also showed the base is not a stable annual ' +
      'quantity at all: within 2026 alone this one site saw $14,500, $79,900 ' +
      'and $151,900, because this.monthly is mid-accumulation when the call ' +
      'happens and ×12 amplifies whatever has landed so far. That is evidence ' +
      'for spec 6, not an argument against this fixture.',
    config: { startAge: 50, retirementAge: 67, filingAs: 'Single' },
    build: () => ({
      assets: [
        asset(DEC)({ instrument: 'workingIncome', displayName: 'Salary',
          startCurrency: { amount: 8000 }, startBasisCurrency: { amount: 0 },
          fundTransfers: [xfer('401K', 2500)] }),
        asset(DEC)({ instrument: '401K', displayName: '401K',
          startCurrency: { amount: 120000 }, startBasisCurrency: { amount: 0 },
          annualReturnRate: { rate: 0.05 } }),
        asset(DEC)({ instrument: 'taxableEquity', displayName: 'Brokerage',
          startCurrency: { amount: 500000 }, startBasisCurrency: { amount: 100000 },
          annualReturnRate: { rate: 0.04 } }),
        asset(DEC)({ instrument: 'bank', displayName: 'Checking',
          startCurrency: { amount: 3000 }, startBasisCurrency: { amount: 3000 } }),
        asset(DEC)({ instrument: 'monthlyExpense', displayName: 'Living',
          startCurrency: { amount: -10000 }, startBasisCurrency: { amount: 0 } }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'transfer-unfunded',
    kind: 'adversarial',
    reaches:
      'the PAIRED shortfall origin: a two-sided execute() whose source cannot ' +
      'supply the transfer. Only the paired total is expected to net to zero, so ' +
      'this and settlement-unfunded together are what keep the origin split ' +
      'honest.',
    config: { startAge: 50, retirementAge: 65 },
    build: () => ({
      assets: [
        asset(DEC)({ instrument: 'monthlyExpense', displayName: 'Living',
          startCurrency: { amount: -6000 }, startBasisCurrency: { amount: 0 },
          fundTransfers: [xfer('Brokerage', 100)] }),
        asset(DEC)({ instrument: 'taxableEquity', displayName: 'Brokerage',
          startCurrency: { amount: 40000 }, startBasisCurrency: { amount: 40000 } }),
      ].map(ModelAsset.fromJSON),
    }),
  },
];

export const SNAPSHOT_FIXTURES = [...realFixtures, ...adversarialFixtures];
