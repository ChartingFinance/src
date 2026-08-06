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
