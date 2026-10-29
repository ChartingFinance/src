/**
 * fixtures.mjs — the snapshot corpus.
 *
 * A shared, deliberately-chosen set of portfolios for tools/snapshot.mjs. Two
 * kinds, and both are needed:
 *
 *   REAL      the eight quick-start profiles the product ships. Phased,
 *             with life events, salaries, mortgages and retirement transitions.
 *             These are the shapes users see; a change that moves them is a
 *             change that matters.
 *
 *   ADVERSARIAL  small synthetic plans built to reach a specific branch that the
 *             real profiles never touch, because a bug hid there or a test was
 *             vacuous without it. Each carries a `reaches:` note saying what it
 *             is for; read it before deleting or simplifying one.
 *
 * Adding a fixture is cheap and almost always right. The snapshot's coverage
 * section reports which EventTypes no fixture emits, so gaps are visible rather
 * than assumed.
 *
 * Fixtures must be pure data plus a builder: no wall-clock reads and no
 * randomness (see the clock pin in snapshot.mjs).
 */

import { ModelAsset } from '../../js/model-asset.js';
import { ModelLifeEvent, LifeEvent } from '../../js/life-event.js';
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

const JUN29 = { year: 2029, month: 6 };  // closes BEFORE the plan end, so it closes at all

/**
 * Instrument shorthands.
 *
 * These remove boilerplate; they are not a way to generate fixtures cheaply.
 * Each adversarial fixture depends on tuned specifics (a balance large enough
 * for a true-up to be collectible, income parked next to a bracket edge, a
 * finish date before the plan end) that a helper cannot know, and generated
 * plans tend to reach code without testing it. The skeleton is shared; the
 * specifics stay written out where a reader can question them.
 *
 * Each builds on `asset(DEC)`, so it inherits the START date and the zero
 * default return rate, and the trailing `x` spread overrides anything —
 * including `instrument` and `finishDateInt`.
 */

/** Any account whose basis equals its balance: bank, cash. */
const bank = (displayName, amount, x = {}) => asset(DEC)({
  instrument: 'bank', displayName,
  startCurrency: { amount }, startBasisCurrency: { amount }, ...x });

/** Monthly outgoing. Takes a MAGNITUDE — the sign convention lives here, once. */
const expense = (displayName, monthly, x = {}) => asset(DEC)({
  instrument: 'monthlyExpense', displayName,
  startCurrency: { amount: -Math.abs(monthly) }, startBasisCurrency: { amount: 0 }, ...x });

/** Earned income. */
const salary = (displayName, monthly, x = {}) => asset(DEC)({
  instrument: 'workingIncome', displayName,
  startCurrency: { amount: monthly }, startBasisCurrency: { amount: 0 }, ...x });

/** Social Security or a pension. */
const benefit = (displayName, monthly, x = {}) => asset(DEC)({
  instrument: 'retirementIncome', displayName,
  startCurrency: { amount: monthly }, startBasisCurrency: { amount: 0 }, ...x });

/** Taxable brokerage. Basis is explicit because the gain ratio is usually the point. */
const equity = (displayName, amount, basis, x = {}) => asset(DEC)({
  instrument: 'taxableEquity', displayName,
  startCurrency: { amount }, startBasisCurrency: { amount: basis }, ...x });

/** ira | 401K | rothIRA — zero basis, because distributions are fully taxable. */
const deferred = (instrument, displayName, amount, x = {}) => asset(DEC)({
  instrument, displayName,
  startCurrency: { amount }, startBasisCurrency: { amount: 0 }, ...x });

/** Primary residence by default — §121 only applies to one, and every fixture here wants it. */
const home = (displayName, amount, basis, x = {}) => asset(DEC)({
  instrument: 'realEstate', displayName, isPrimaryHome: true,
  startCurrency: { amount }, startBasisCurrency: { amount: basis }, ...x });

/**
 * A marketplace health plan. Takes the monthly premium and benchmark as
 * MAGNITUDES, like `expense`.
 */
const healthCard = (displayName, premium, benchmark, x = {}) => asset(DEC)({
  instrument: 'healthInsurance', displayName,
  startCurrency: { amount: -Math.abs(premium) }, startBasisCurrency: { amount: 0 },
  benchmarkPremium: { amount: benchmark }, ...x });

/** Re-date one asset, or a whole list, off the DEC default. */
const by = (finish, a) => (Array.isArray(a)
  ? a.map((one) => ({ ...one, finishDateInt: finish }))
  : { ...a, finishDateInt: finish });

// ── The corpus ───────────────────────────────────────────────────────

/**
 * @typedef {object} Fixture
 * @property {string} name          stable — it is the baseline filename
 * @property {string} kind          'real' | 'adversarial'
 * @property {string} reaches       what this fixture exists to exercise
 * @property {object} config        ages and any non-default globals
 * @property {() => {assets, lifeEvents, guardrails}} build
 */

/** The shipped quick-start profiles, snapshotted under a pinned clock. */
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
    // The profile owns its filing status, exactly as loadQuickStartProfile
    // applies it in the app. A fixture that inherited the reset default would
    // snapshot the MFJ profile under single brackets and prove nothing.
    filingAs: profile.filingAs,
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
        home('Home', 500000, 500000, { annualReturnRate: { rate: 0.03 },
          annualTaxRate: { rate: 0.012 }, annualMaintenanceRate: { rate: 0.01 },
          annualInsuranceCost: { amount: 2400 } }),
        asset(DEC)({ instrument: 'mortgage', displayName: 'Mortgage',
          startCurrency: { amount: -300000 }, startBasisCurrency: { amount: 0 },
          annualReturnRate: { rate: 0.065 }, monthsRemaining: 360 }),
        bank('Checking', 4000),
        equity('Brokerage', 400000, 200000, { annualReturnRate: { rate: 0.07 } }),
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
        benefit('Social Security', 3000, { fundTransfers: [xfer('Savings', 100)] }),
        deferred('ira', 'IRA', 800000),
        bank('Savings', 200000),
        expense('Living', 5000),
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
        benefit('Social Security', 3000),
        deferred('ira', 'IRA', 600000),
        equity('Brokerage', 500000, 150000, { annualReturnRate: { rate: 0.06 } }),
        bank('Checking', 2000),
        expense('Living', 7000),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'gain-harvest-under-the-deduction',
    kind: 'adversarial',
    reaches:
      'the IRC 63 deduction OVERFLOW onto capital gains. An early retiree with ' +
      'no salary and no Social Security yet has essentially zero ordinary ' +
      'income, so the standard deduction is not consumed and the remainder ' +
      'shelters long-term gain before the 0% band even starts. Every other ' +
      'fixture here either has ordinary income comfortably above the deduction ' +
      'or realises no gain, so all 26 of them were bit-identical before and ' +
      'after the rule went in (measured 2026-08-18) — the engine-level ' +
      'behaviour had no witness at all and tax-basis.js could have gone back to ' +
      'flooring at zero with the whole suite green. The brokerage is mostly ' +
      'gain so the draw realises enough to cross out of the shelter, which is ' +
      'what makes the true-up move rather than just sit at zero.',
    config: { startAge: 55, retirementAge: 55 },
    build: () => ({
      assets: [
        equity('Brokerage', 1200000, 200000, { annualReturnRate: { rate: 0.05 } }),
        bank('Checking', 20000),
        expense('Living', 5500),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'niit-from-a-deferred-draw',
    kind: 'adversarial',
    reaches:
      'the IRC 1411 ASYMMETRY, and nothing else in the corpus does. A '
      + 'qualified-plan distribution is OUT of net investment income but IN '
      + 'MAGI, so a large IRA draw can never be taxed by NIIT itself yet drags '
      + 'the household over the threshold and exposes investment income that '
      + 'would otherwise sit far below it. This retiree has NO wages: MAGI is '
      + 'carried over $200,000 almost entirely by the 1%/month IRA '
      + 'distribution, while the taxed base is the brokerage dividends. '
      + 'Delete the distribution and the same dividends owe nothing. '
      + 'It is also the only fixture where the NII side of the min binds — '
      + 'single-home-sale and mfj-high-earner-ltcg both bind on the MAGI '
      + 'excess, so without this one an implementation could drop the NII '
      + 'argument entirely and stay green. Both halves verified by mutation '
      + 'on 2026-08-18.',
    config: { startAge: 70, retirementAge: 65, filingAs: 'Single' },
    build: () => ({
      assets: [
        // 1%/month of a large balance: the draw that moves MAGI, taxable as
        // ordinary income and invisible to NII.
        deferred('ira', 'IRA', 2200000, { annualReturnRate: { rate: 0.05 },
          fundTransfers: [xfer('Brokerage', 1)] }),
        // The dividends are the NII. Small next to the draw, which is the
        // point — they are what gets taxed.
        equity('Brokerage', 400000, 300000, { annualReturnRate: { rate: 0.04 },
          annualDividendRate: { rate: 0.025 }, dividendQualifiedRatio: 0.7 }),
        bank('Checking', 40000),
        expense('Living', 6000),
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
      assets: by(JUL, [
        benefit('Social Security', 3000),
        deferred('ira', 'IRA', 800000),
        bank('Savings', 200000),
        expense('Living', 5000),
      ]).map(ModelAsset.fromJSON),
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
        home('Home', 600000, 600000, { annualReturnRate: { rate: 0.03 },
          annualTaxRate: { rate: 0.015 }, annualMaintenanceRate: { rate: 0.02 },
          annualInsuranceCost: { amount: 6000 } }),
        bank('Checking', 3000),
        equity('Brokerage', 900000, 600000, { annualReturnRate: { rate: 0.06 } }),
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
        home('Home', 600000, 600000, { annualReturnRate: { rate: 0.03 },
          annualTaxRate: { rate: 0.015 }, annualMaintenanceRate: { rate: 0.02 },
          annualInsuranceCost: { amount: 6000 } }),
        bank('Checking', 3000),
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
        home('Home', 1200000, 1200000, { annualReturnRate: { rate: 0.03 },
          annualTaxRate: { rate: 0.02 }, annualMaintenanceRate: { rate: 0.05 },
          annualInsuranceCost: { amount: 24000 } }),
        bank('Wallet', 1200, { instrument: 'cash' }),
        equity('Brokerage', 2500, 2500),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'transfer-exhausts-fallback',
    kind: 'adversarial',
    reaches:
      'DOUBLE depletion on the TWO-SIDED path: an expense rule draws a Roth ' +
      'that runs dry in February 2026, and the backstop it spills to (Savings) ' +
      'runs dry in the same draw. execute() took the fallback to cover the ' +
      'whole shortfall, so $3,013 of the bill was neither paid nor reported ' +
      'unfunded. settlement-exhausts-fallback is the one-sided twin.',
    config: { startAge: 60, retirementAge: 60 },
    build: () => ({
      assets: [
        expense('Living', 5000, { fundTransfers: [xfer('Roth', 100)] }),
        deferred('rothIRA', 'Roth', 6000),
        bank('Savings', 1000),
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
        // Transfers well above the annual 401(k) limit, which is the point.
        salary('Salary', 14000, { fundTransfers: [xfer('401K', 4000), xfer('Brokerage', 2000)] }),
        deferred('401K', '401K', 250000, { annualReturnRate: { rate: 0.05 } }),
        // Split ratio so BOTH dividend branches fire — a ratio of 1.0 leaves
        // the non-qualified recordEvent unreached.
        equity('Brokerage', 300000, 200000, { annualReturnRate: { rate: 0.04 },
          annualDividendRate: { rate: 0.025 }, dividendQualifiedRatio: 0.7 }),
        bank('Checking', 25000, { oneTimeEvents: [
          { dateInt: { year: 2027, month: 6 }, amount: { amount: 50000 }, note: 'Inheritance' },
          { dateInt: { year: 2028, month: 9 }, amount: { amount: -18000 }, note: 'Roof replacement' },
        ] }),
        expense('Living', 6000),
      ].map(ModelAsset.fromJSON),
    }),
  },
  // ── Married Filing Jointly ─────────────────────────────────────────
  // Every fixture below declares `filingAs: 'MFJ'`. The Single-filer fixtures
  // cannot reach the branches MFJ changes: run under MFJ, they show identical
  // socialSecurityTax and no capital-gains tax at all.
  {
    name: 'mfj-two-earners',
    kind: 'adversarial',
    reaches:
      'TWO working-income assets, each earning above the Social Security wage ' +
      'base. TaxTable keys its accumulator by TaxOwner but ships with exactly ' +
      'ONE owner, and payroll-engine passes PRIMARY for every income asset, so ' +
      'both salaries share a single $184,500 base and the second earner stops ' +
      'paying SS tax early. No other fixture has more than one working income, ' +
      'which is why the whole corpus reported identical socialSecurityTax under ' +
      'MFJ — the branch was unreachable, not correct.',
    config: { startAge: 45, retirementAge: 67, filingAs: 'MFJ' },
    build: () => ({
      assets: [
        salary('Salary A', 18000),
        salary('Salary B', 18000),
        bank('Checking', 20000),
        expense('Living', 9000),
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
        salary('Salary', 20000),
        by(JUN29, equity('Brokerage', 2000000, 400000, { annualReturnRate: { rate: 0.06 } })),
        bank('Checking', 25000),
        expense('Living', 8000),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'mfj-two-401ks',
    kind: 'adversarial',
    reaches:
      'the household 401(k) ceiling with two earners under it.\n' +
      '      xfer takes a PERCENTAGE of the source, not an amount — 16% of a ' +
      '$12,000/month salary is $23,040 a year each, $46,080 for the household. ' +
      'That sits above the $24,500 this engine used to allow a married couple ' +
      '(the single figure, undoubled) and below the $49,000 it allows now, so ' +
      'this fixture is the one that moves when the policy changes and nothing ' +
      'else does.\n' +
      '      An earlier version passed 2000, meaning 2000% of salary, and its ' +
      'note claimed that was $24,000 a year. It capped every month for a reason ' +
      'that had nothing to do with the policy under test. Corrected 2026-08-07 ' +
      'when step 4 made the units visible: the caps did not disappear as ' +
      'predicted, because the request had always been absurd.',
    config: { startAge: 45, retirementAge: 67, filingAs: 'MFJ' },
    build: () => ({
      assets: [
        salary('Salary A', 12000, { fundTransfers: [xfer('401K A', 16)] }),
        salary('Salary B', 12000, { fundTransfers: [xfer('401K B', 16)] }),
        deferred('401K', '401K A', 150000, { annualReturnRate: { rate: 0.05 } }),
        deferred('401K', '401K B', 90000, { annualReturnRate: { rate: 0.05 } }),
        bank('Checking', 15000),
        expense('Living', 8000),
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
        by(JUN29, home('Home', 800000, 400000, { annualReturnRate: { rate: 0.03 },
          annualTaxRate: { rate: 0.011 }, annualMaintenanceRate: { rate: 0.01 },
          annualInsuranceCost: { amount: 3000 } })),
        salary('Salary', 9000),
        bank('Checking', 30000),
        expense('Living', 6000),
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
        by(JUN29, home('Home', 800000, 400000, { annualReturnRate: { rate: 0.03 },
          annualTaxRate: { rate: 0.011 }, annualMaintenanceRate: { rate: 0.01 },
          annualInsuranceCost: { amount: 3000 } })),
        salary('Salary', 9000),
        bank('Checking', 150000),
        expense('Living', 6000),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'retirement-sells-a-rental',
    kind: 'adversarial',
    reaches:
      'a life event that closes a capital asset: Retire, in January 2028, ends ' +
      'the paycheck and sells a rental with a $300k gain. Life events fire on ' +
      'the month\'s first tick, before the assets\' clocks move, so the sale ' +
      'recorded its capital-gains tax and proceeds a month early, in December ' +
      '2027, while the figures booked them in January. No quick-start profile ' +
      'closes anything but a paycheck, which records nothing.',
    config: { startAge: 58, retirementAge: 60, filingAs: 'Single' },
    build: () => {
      const living = { Living: [xfer('Checking', 100)] };
      const accumulate = ModelLifeEvent.createDefault(LifeEvent.ACCUMULATE, 58);
      accumulate.phaseTransfers = living;
      const retire = ModelLifeEvent.createDefault(LifeEvent.RETIRE, 60);
      retire.closes = ['Salary', 'Rental'];
      retire.phaseTransfers = living;
      return {
        assets: [
          salary('Salary', 9000),
          asset(DEC)({ instrument: 'realEstate', displayName: 'Rental', isPrimaryHome: false,
            startCurrency: { amount: 600000 }, startBasisCurrency: { amount: 300000 } }),
          bank('Checking', 50000),
          expense('Living', 5000),
        ].map(ModelAsset.fromJSON),
        lifeEvents: [accumulate, retire],
      };
    },
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
        salary('Salary', 9000),
        by(JUN29, deferred('ira', 'IRA', 400000, { annualReturnRate: { rate: 0.05 } })),
        by(JUN29, deferred('401K', '401K', 300000, { annualReturnRate: { rate: 0.05 } })),
        bank('Checking', 60000),
        expense('Living', 6000),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'withholding-exceeds-paycheck',
    kind: 'adversarial',
    reaches:
      'payroll withholding larger than the paycheck it comes out of. A 401(k) ' +
      'that closes mid-plan books its whole balance as income on day 1, before ' +
      'payroll runs, and payroll sizes the household withholding from that ' +
      'month x12, so the close month asks one $6,000 paycheck for a six-figure ' +
      'withholding. A paycheck pays taxes first and deferrals from what is ' +
      'left, so it withholds everything after FICA, the IRA deferral gets ' +
      'nothing, and the rest of the estimate goes to the true-ups as unpaid. ' +
      'Booked as withheld instead, it would count as paid and be refunded in ' +
      'cash.\n' +
      '      The deferral is load-bearing: it is what a paycheck short of its ' +
      'taxes gives up, so a pipeline that paid deferrals before taxes would ' +
      'move this baseline. So is the salary running past the close: end it ' +
      'first and there is nothing to over-withhold. Every rate is zero, so the ' +
      'money can be followed by hand. deferred-close-distribution reaches the ' +
      'same month with growth and no deferral; ' +
      'tests/payroll-withholding-conservation.mjs holds the conservation law.',
    config: { startAge: 60, retirementAge: 67, finishAge: 65, filingAs: 'Single' },
    build: () => ({
      assets: [
        // 10% of pay, under the $8,600 IRA limit at 50+, so it is never capped.
        salary('Salary', 6000, { fundTransfers: [xfer('IRA', 10)] }),
        bank('Checking', 400000),
        expense('Living', 4000),
        deferred('ira', 'IRA', 1000),
        by({ year: 2027, month: 6 }, deferred('401K', '401K', 400000,
          { fundTransfers: [xfer('Checking', 0, 100)] })),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'trueup-draw-unfunded',
    kind: 'adversarial',
    reaches:
      'a monthly tax true-up that the everyday accounts cannot pay. A 401(k) ' +
      'closed to a Roth books its whole balance as income that month, and ' +
      'the true-up sizes the month\'s tax from that income x12, so it asks ' +
      'for far more than the close withheld. The single-backstop draw takes ' +
      'the Wallet, spills to Checking, Checking clamps too, and the rest is ' +
      'reported unfunded. Only what the two accounts paid counts as ' +
      'withheld; booked in full, the annual true-up would refund the ' +
      'unpaid part in cash.\n' +
      '      Both everyday accounts are load-bearing. With Checking alone the ' +
      'named account supplies everything that is paid, so booking ' +
      'settled.supplied would look right; the second account is what ' +
      'separates "what the accounts paid" from both "what the first account ' +
      'paid" and "what was handed to the fallback". Having a fallback, it ' +
      'does not reach the draw with none; the conservation test\'s first ' +
      'plan does. The close goes to a Roth, ' +
      'not to Checking, so no deposit lands where the true-up draws. Every ' +
      'rate is zero and nothing runs after the close, so the year\'s refund ' +
      'is collected minus owed, by hand. ' +
      'tests/trueup-withholding-conservation.mjs holds the conservation law.',
    config: { startAge: 62, retirementAge: 60, finishAge: 64, filingAs: 'Single' },
    build: () => ({
      assets: [
        by({ year: 2026, month: 6 }, deferred('401K', '401K', 300000,
          { fundTransfers: [xfer('Roth IRA', 0, 100)] })),
        ...by({ year: 2027, month: 12 }, [
          deferred('rothIRA', 'Roth IRA', 1000),
          bank('Wallet', 1000, { instrument: 'cash' }),
          bank('Checking', 2000),
        ]),
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
        salary('Salary', 8000, { fundTransfers: [xfer('401K', 2500)] }),
        deferred('401K', '401K', 120000, { annualReturnRate: { rate: 0.05 } }),
        equity('Brokerage', 500000, 100000, { annualReturnRate: { rate: 0.04 } }),
        bank('Checking', 3000),
        expense('Living', 10000),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'unfundable-tax-bill',
    kind: 'adversarial',
    reaches:
      'an annual tax true-up that NOTHING can pay, and the funded true-ups that '
      + 'precede it in the same plan. '
      + '      FundTransfer.resolveFunding only considers everyday accounts — '
      + 'cash, bank, brokerage, bonds — with a positive balance, by deliberate '
      + 'policy, so it returns null both when a household is broke and when its '
      + 'money is all in a 401(k) the engine will not raid implicitly. Either '
      + 'way applyAnnualTaxTrueUp used to hit `if (!liquidAsset) return;` and '
      + 'the bill vanished: no event, no metric, no issue raised. '
      + '      The brokerage has an 83% gain ratio and funds an expense larger '
      + 'than Social Security covers, so every withdrawal realises a gain that '
      + 'nothing withheld against — which is what creates a real annual '
      + 'residual. It is collectible for the first years and then is not, so '
      + 'the fixture pins BOTH sides of the branch rather than only the broken '
      + 'one. There is deliberately no Home: an earlier draft had one and its '
      + 'monthly maintenance, insurance and property tax buried the tax bill '
      + 'under 74 unfunded events.',
    config: { startAge: 68, retirementAge: 65, filingAs: 'Single' },
    build: () => ({
      assets: [
        benefit('Social Security', 3000),
        equity('Brokerage', 120000, 20000, { annualReturnRate: { rate: 0.04 } }),
        bank('Checking', 2000),
        expense('Living', 7000),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'rebalance-drawdown-and-conversion',
    kind: 'adversarial',
    reaches:
      'RebalanceEngine, which the corpus did not touch at all. Day 1 runs it '
      + 'after payroll to move money between capital accounts, and every kind of '
      + 'move it makes has a tax consequence: a retirement account drawn into a '
      + 'taxable one is ordinary income, and a Roth conversion is ordinary income '
      + 'that never leaves the shelter. '
      + 'A mutation sweep on 2026-08-07 found the whole engine resting on ONE '
      + 'suite, transfer-tax-conservation, and two subtle changes that nothing '
      + 'at all caught: deleting _trackDistribution, which is what makes a '
      + 'retirement withdrawal taxable — the money still moves, it is simply '
      + 'never taxed. The fixture now catches that one, and three others: '
      + 'booking gains against the destination, dropping the contribution '
      + 'metric, and skipping the contribution limits. '
      + 'The hasRecurring guard is NOT covered here, and measurement says '
      + 'it cannot be: a close-only transfer has monthlyMoveValue 0, so '
      + 'calculate() returns 0 on the monthly pass and a zero transfer '
      + 'moves nothing whether the guard runs or not. Removing hasRecurring '
      + 'AND the amount<=0 guard together still produces no drift. It is '
      + 'redundant clarity, not an unguarded path — the same conclusion as '
      + "monthsRemaining's `|| 0` and Currency.parse's isNaN check. "
      + 'The IRA draws to a taxable Brokerage (unsheltered distribution) while '
      + 'the 401K converts to a Roth (sheltered distribution, so the source is '
      + 'taxed but nothing is withheld at it). The Bonds asset carries a '
      + 'close-only transfer alongside the recurring ones, so the two cadences '
      + 'are pinned against each other rather than assumed.',
    config: { startAge: 70, retirementAge: 65, filingAs: 'Single' },
    build: () => ({
      assets: [
        benefit('Social Security', 2500),
        deferred('ira', 'IRA', 600000, { annualReturnRate: { rate: 0.05 },
          fundTransfers: [xfer('Brokerage', 2)] }),
        deferred('401K', '401K', 300000, { annualReturnRate: { rate: 0.05 },
          fundTransfers: [xfer('Roth IRA', 1)] }),
        deferred('rothIRA', 'Roth IRA', 50000, { annualReturnRate: { rate: 0.05 } }),
        // Close-only: monthlyMoveValue 0, closeMoveValue 100. Nothing should
        // move until it closes in 2029-06.
        by(JUN29, asset(DEC)({ instrument: 'usBond', displayName: 'Bonds',
          startCurrency: { amount: 80000 }, startBasisCurrency: { amount: 80000 },
          annualReturnRate: { rate: 0.03 },
          fundTransfers: [xfer('Brokerage', 0, 100)] })),
        equity('Brokerage', 100000, 60000, { annualReturnRate: { rate: 0.04 } }),
        bank('Checking', 20000),
        expense('Living', 5000),
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
        expense('Living', 6000, { fundTransfers: [xfer('Brokerage', 100)] }),
        equity('Brokerage', 40000, 40000),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'brokerage-only-retirement',
    kind: 'adversarial',
    reaches:
      'a gross-up premium on EVERY monthly draw, in a plan whose tax line is ' +
      'not made of premium. It exists for the annual-expenditure split: a ' +
      'grossed-up withdrawal is one debit carrying both the bill and the tax ' +
      'on the gain it realises, its causal chain roots in EXPENSE, so the ' +
      'whole thing is counted as spending, and the TAX_PROVISION naming the ' +
      'premium is excluded to avoid booking the same dollars twice. The total ' +
      'is right; the split is not.\n' +
      '      COMPLEMENTARY TO grossup-at-the-ltcg-boundary, not redundant ' +
      'with it. That fixture provisions $32,896 and its expenditure tax line ' +
      'reads $0 — every tax dollar it withdraws IS premium, so it cannot tell ' +
      'a correct split from one that moved ALL spending into tax. This one ' +
      'carries an annual true-up (correctly counted as tax) alongside the ' +
      'premium (currently counted as spending) in the same years, so it ' +
      'discriminates a partial fix and a double count. Measured 2027: tax ' +
      'reads $4,929 where $27,837 left the account for tax — 82% low.\n' +
      '      THE SHAPE IS LOAD-BEARING, all three parts.\n' +
      '      No cash and no bank: fundingBackstopPriority puts both ahead of ' +
      'taxableEquity, and the gross-up only fires on a taxable account.\n' +
      '      A pension large enough to carry ordinary income past the 0% LTCG ' +
      'band: at $2,000/mo instead of $8,000 the marginal rate is 0%, so ' +
      't*gain is 0 and the premium vanishes entirely (measured).\n' +
      '      Spending well above that income: planWithdrawal draws the ' +
      'fresh deposits of the month FIRST at zero gain, and the pension lands ' +
      'in the brokerage on its own because resolveDeposit picks the same ' +
      'backstop. A $20,000 draw against an $8,000 deposit is what leaves a ' +
      'taxable remainder to realise; at a $10,000 expense the premium falls ' +
      'to a fifth.',
    config: { startAge: 70, retirementAge: 65, filingAs: 'Single' },
    build: () => ({
      assets: [
        // 20% basis: the embedded gain is the whole point.
        equity('Brokerage', 3000000, 600000, { annualReturnRate: { rate: 0.05 } }),
        // A pension, not Social Security: benefit() builds the Social
        // Security instrument whatever its display name, and IRC §86 would
        // then tax little of it, leaving the gross-up at a 0% LTCG rate and
        // shrinking the premium this fixture exists to witness. A pension is
        // fully taxable ordinary income.
        asset(DEC)({ instrument: 'pension', displayName: 'Pension',
          startCurrency: { amount: 8000 }, startBasisCurrency: { amount: 0 } }),
        expense('Living', 20000),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'ira-drained-by-a-bill',
    kind: 'adversarial',
    reaches:
      'an expense rule that drains an IRA. In April 2026, the month it empties, ' +
      'the withholding on its last distribution is a $0 debit on the empty IRA ' +
      'plus a SPILLOVER from the brokerage. A reader that skips $0 draws cannot ' +
      'say what that spillover paid; the Flows view threw there.',
    config: { startAge: 70, retirementAge: 65, filingAs: 'Single' },
    build: () => ({
      assets: [
        benefit('Social Security', 2000),
        deferred('ira', 'IRA', 20000),
        equity('Brokerage', 500000, 400000),
        expense('Living', 5000, { fundTransfers: [xfer('IRA', 100)] }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'home-sold-by-its-rule',
    kind: 'adversarial',
    reaches:
      'one rule with both halves: the home pays its property costs from the ' +
      'brokerage monthly, and sends its sale to the brokerage at close (it ' +
      'finishes in June 2027 and closes in July). The halves move money ' +
      'opposite ways, into the home and out of it; read as one direction, the ' +
      'sale proceeds went unclaimed.',
    config: { startAge: 50, retirementAge: 65 },
    build: () => ({
      assets: [
        salary('Salary', 10000),
        equity('Brokerage', 100000, 80000),
        bank('Checking', 20000),
        by({ year: 2027, month: 6 }, home('Home', 500000, 400000, { annualReturnRate: { rate: 0.03 },
          annualTaxRate: { rate: 0.012 }, fundTransfers: [xfer('Brokerage', 100, 100)] })),
        expense('Living', 4000),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'housing-rules-cover-half',
    kind: 'adversarial',
    reaches:
      'mortgage and property rules that each cover 50% from Checking, which is ' +
      'also the backstop that pays the other 50%. The rule\'s settlement and the ' +
      'backstop\'s name the same accounts and label, so only the backstop marker ' +
      'on the event tells them apart.',
    config: { startAge: 50, retirementAge: 65 },
    build: () => ({
      assets: [
        salary('Salary', 9000),
        home('Home', 500000, 500000, { annualTaxRate: { rate: 0.012 },
          annualMaintenanceRate: { rate: 0.01 }, fundTransfers: [xfer('Checking', 50)] }),
        asset(DEC)({ instrument: 'mortgage', displayName: 'Mortgage',
          startCurrency: { amount: -300000 }, startBasisCurrency: { amount: 0 },
          annualReturnRate: { rate: 0.065 }, monthsRemaining: 360,
          fundTransfers: [xfer('Checking', 50)] }),
        bank('Checking', 100000),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'mortgage-paid-and-prepaid',
    kind: 'adversarial',
    reaches:
      'Checking pays the mortgage by the mortgage\'s rule AND prepays it by its ' +
      'own: two rules between the same two accounts, one paying a bill, the ' +
      'other moving money into a (negative) account.',
    config: { startAge: 50, retirementAge: 65 },
    build: () => ({
      assets: [
        salary('Salary', 12000),
        asset(DEC)({ instrument: 'mortgage', displayName: 'Mortgage',
          startCurrency: { amount: -300000 }, startBasisCurrency: { amount: 0 },
          annualReturnRate: { rate: 0.065 }, monthsRemaining: 360,
          fundTransfers: [xfer('Checking', 100)] }),
        bank('Checking', 200000, { fundTransfers: [xfer('Mortgage', 1)] }),
        expense('Living', 4000),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'unpayable-annual-true-up',
    kind: 'adversarial',
    reaches:
      'an annual true-up nothing can pay: every dollar is in an IRA, which the ' +
      'backstop never draws, and Checking is empty. The unpaid bill is an ' +
      'annual-pass event, stamped December and booked in January, so a reader ' +
      'dating events by their own month put it in the wrong year.',
    config: { startAge: 70, retirementAge: 65, filingAs: 'Single' },
    build: () => ({
      assets: [
        deferred('ira', 'IRA', 1500000),
        bank('Checking', 0),
        expense('Living', 12000, { fundTransfers: [xfer('IRA', 100)] }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'home-bought-with-a-down-payment',
    kind: 'adversarial',
    reaches:
      'a home bought in April 2027, 20% down from the brokerage: the debit-only ' +
      'funding TRANSFER (cadence "funding") no other fixture emits.',
    config: { startAge: 40, retirementAge: 65 },
    build: () => ({
      assets: [
        salary('Salary', 12000),
        equity('Brokerage', 300000, 200000),
        bank('Checking', 20000),
        home('House', 500000, 500000, { startDateInt: { year: 2027, month: 4 },
          annualTaxRate: { rate: 0.012 },
          fundingConfig: { purchaseType: 'mortgage', sourceDisplayName: 'Brokerage', downPaymentPercent: 20 } }),
        asset(DEC)({ instrument: 'mortgage', displayName: 'Mortgage', startDateInt: { year: 2027, month: 4 },
          startCurrency: { amount: -400000 }, startBasisCurrency: { amount: 0 },
          annualReturnRate: { rate: 0.065 }, monthsRemaining: 360 }),
        expense('Living', 4000),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'aca-early-retiree-single',
    kind: 'adversarial',
    reaches:
      'the ACA premium tax credit (spec 11 Part A) for a single early retiree '
      + 'living on IRA draws. No estimated income and no year before the plan, '
      + 'so 2026 advances nothing and the whole credit is paid on the return: '
      + 'the positive ptcReconciliation no other fixture reaches. From 2027 the '
      + 'advance is paid on the year before, and as income creeps up the advance '
      + 'runs ahead of the credit and is repaid. The premium steps each January '
      + 'at 8%, above plan inflation.',
    config: { startAge: 60, retirementAge: 60, filingAs: 'Single' },
    build: () => ({
      assets: [
        deferred('ira', 'IRA', 900000, { annualReturnRate: { rate: 0.05 } }),
        bank('Checking', 30000),
        expense('Living', 2800, { fundTransfers: [xfer('IRA', 100)] }),
        healthCard('Marketplace Plan', 1100, 1000, { annualReturnRate: { rate: 0.08 },
          fundTransfers: [xfer('IRA', 100)] }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'aca-early-retiree-mfj',
    kind: 'adversarial',
    reaches:
      'the credit for a married couple living on a low-basis brokerage, so only '
      + 'the gain fraction of each draw reaches ACA MAGI, with an estimated income '
      + 'for the first year and Social Security from 2030. ACA MAGI counts all of '
      + 'Social Security, so the untaxed part §86 leaves out is in it here. Filing '
      + 'jointly makes the household two for the poverty line.',
    config: { startAge: 58, retirementAge: 58, filingAs: 'MFJ' },
    build: () => ({
      assets: [
        equity('Brokerage', 1200000, 400000, { annualReturnRate: { rate: 0.06 } }),
        bank('Checking', 40000),
        benefit('Social Security', 2500, { startDateInt: { year: 2030, month: 1 },
          fundTransfers: [xfer('Checking', 100)] }),
        expense('Living', 5000, { fundTransfers: [xfer('Brokerage', 100)] }),
        healthCard('Marketplace Plan', 2000, 1800, { annualReturnRate: { rate: 0.07 },
          estimatedAcaIncome: { amount: 60000 }, fundTransfers: [xfer('Brokerage', 100)] }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'aca-partial-first-year',
    kind: 'adversarial',
    reaches:
      'a plan that starts in October. Its first tax year holds three months, so it '
      + 'is settled against the card\'s estimate rather than a MAGI the plan only '
      + 'part-saw. Only 80% of the credit is advanced, so the return pays the rest. '
      + '2027 is advanced on the estimate again, because 2026 was not a full year '
      + 'on the marketplace; 2028 renews on 2027.',
    config: { startAge: 62, retirementAge: 62, filingAs: 'Single' },
    build: () => ({
      assets: [
        deferred('ira', 'IRA', 700000, { startDateInt: { year: 2026, month: 10 },
          annualReturnRate: { rate: 0.05 } }),
        bank('Checking', 25000, { startDateInt: { year: 2026, month: 10 } }),
        expense('Living', 2600, { startDateInt: { year: 2026, month: 10 },
          fundTransfers: [xfer('IRA', 100)] }),
        healthCard('Marketplace Plan', 950, 900, { startDateInt: { year: 2026, month: 10 },
          annualReturnRate: { rate: 0.06 }, estimatedAcaIncome: { amount: 40000 },
          advanceCreditShare: 0.8, fundTransfers: [xfer('IRA', 100)] }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'aca-over-the-cliff',
    kind: 'adversarial',
    reaches:
      'the 400% cliff with an advance outstanding. 2027 is advanced on 2026\'s '
      + 'income, then an old 401(k) closes in June and its whole balance is '
      + 'ordinary income, so 2027 is over the cliff: no credit at all, and every '
      + 'dollar advanced is repaid, with no cap. 2028 renews on 2027, which is '
      + 'over the cliff, so nothing is advanced, and the whole 2028 credit comes '
      + 'back on the return. The card has no finish date, so it ends in December '
      + '2029, before the household turns 65 and Medicare takes over: 2030 has '
      + 'no coverage and no credit.',
    config: { startAge: 61, retirementAge: 61, filingAs: 'Single' },
    build: () => ({
      assets: [
        deferred('ira', 'IRA', 800000, { annualReturnRate: { rate: 0.05 } }),
        deferred('401K', 'Old 401K', 150000, { finishDateInt: { year: 2027, month: 6 },
          annualReturnRate: { rate: 0.05 }, fundTransfers: [xfer('Checking', 0, 100)] }),
        bank('Checking', 20000),
        expense('Living', 2800, { fundTransfers: [xfer('IRA', 100)] }),
        healthCard('Marketplace Plan', 900, 850, { finishDateInt: null,
          fundTransfers: [xfer('IRA', 100)] }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'aca-below-the-floor',
    kind: 'adversarial',
    reaches:
      'the edges under 100% of the poverty line. A high-basis brokerage leaves '
      + '2026\'s ACA MAGI under the floor, but the advance was paid on an estimate '
      + 'over it, so the credit is kept at the lowest band (Treas. Reg. '
      + '1.36B-2(b)(6)). The IRA closing in June 2027 puts that year over the '
      + 'cliff, so 2028 renews on it and nothing is advanced; with no advance to '
      + 'keep it, 2028 and 2029 under the floor get no credit at all, the coverage '
      + 'gap. 2030 crosses 100% and the whole credit comes back on the return.',
    config: { startAge: 61, retirementAge: 61, filingAs: 'Single' },
    build: () => ({
      assets: [
        deferred('ira', 'IRA', 150000, { finishDateInt: { year: 2027, month: 6 },
          annualReturnRate: { rate: 0.05 }, fundTransfers: [xfer('Checking', 0, 100)] }),
        equity('Brokerage', 600000, 500000, { annualReturnRate: { rate: 0.05 } }),
        bank('Checking', 20000),
        expense('Living', 3000, { fundTransfers: [xfer('Brokerage', 100)] }),
        healthCard('Marketplace Plan', 900, 850, { estimatedAcaIncome: { amount: 35000 },
          fundTransfers: [xfer('Brokerage', 100)] }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'aca-household-of-three',
    kind: 'adversarial',
    reaches:
      'the household-size override. A couple with a dependent on the plan is a '
      + 'household of three for the poverty line, which moves the applicable '
      + 'percentage and the cliff; filing status alone would make it two. '
      + 'Part-time wages keep income in the middle of the bands.',
    config: { startAge: 55, retirementAge: 65, filingAs: 'MFJ' },
    build: () => ({
      assets: [
        salary('Part-time Work', 4000, { fundTransfers: [xfer('Checking', 100)] }),
        equity('Brokerage', 500000, 300000, { annualReturnRate: { rate: 0.05 } }),
        bank('Checking', 30000),
        expense('Living', 4000, { fundTransfers: [xfer('Checking', 100)] }),
        healthCard('Family Plan', 2400, 2200, { householdSize: 3,
          estimatedAcaIncome: { amount: 55000 }, fundTransfers: [xfer('Brokerage', 100)] }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'aca-repayment-unpayable',
    kind: 'adversarial',
    reaches:
      'an excess advance the household cannot fully repay: every dollar is in an '
      + 'IRA, which the backstop never draws, and Checking holds only what earlier '
      + 'tax refunds left in it. The low estimate advances too much; Checking pays '
      + 'what it can, and the rest of the repayment is reported unfunded instead '
      + 'of vanishing.',
    config: { startAge: 60, retirementAge: 60, filingAs: 'Single' },
    build: () => ({
      assets: [
        deferred('ira', 'IRA', 800000, { annualReturnRate: { rate: 0.04 } }),
        bank('Checking', 0),
        expense('Living', 3200, { fundTransfers: [xfer('IRA', 100)] }),
        healthCard('Marketplace Plan', 1000, 950, { estimatedAcaIncome: { amount: 22000 },
          fundTransfers: [xfer('IRA', 100)] }),
      ].map(ModelAsset.fromJSON),
    }),
  },
  {
    name: 'social-security-dated-before-62',
    kind: 'adversarial',
    reaches:
      'SOCIAL_SECURITY_DEFERRED: a benefit dated before 62 is held until January ' +
      'of the year the household turns 62, and the deferral is recorded in the ' +
      'month it was dated. No real profile reaches it: quick start never dates ' +
      'a benefit before 62.\n' +
      '      The household is 60 in 2026, so 2028 is the first claimable year, ' +
      'and the plan runs on to show the first payment. The pension dated in the ' +
      'same month pays from the start: the rule is Social Security\'s alone. ' +
      'Checking covers the two years without it, so nothing goes unpaid.',
    config: { startAge: 60, retirementAge: 60 },
    build: () => ({
      assets: [
        benefit('Social Security', 2000, { fundTransfers: [xfer('Checking', 100)] }),
        asset(DEC)({ instrument: 'pension', displayName: 'Pension',
          startCurrency: { amount: 1500 }, startBasisCurrency: { amount: 0 },
          fundTransfers: [xfer('Checking', 100)] }),
        bank('Checking', 80000),
        expense('Living', 3000),
      ].map(ModelAsset.fromJSON),
    }),
  },
];

export const SNAPSHOT_FIXTURES = [...realFixtures, ...adversarialFixtures];
