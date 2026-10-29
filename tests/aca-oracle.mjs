/**
 * aca-oracle.mjs — the ACA premium tax credit against an independent Form 8962.
 *
 * ── Why ──────────────────────────────────────────────────────────────
 *
 * The credit is a long chain of small rules: a poverty line by household size,
 * a sliding percentage within bands, whole-percent and whole-dollar rounding, a
 * cliff tested in dollars, a premium cap, an exception under 100%. A slip in any
 * of them is self-consistent: the engine would agree with itself. This file
 * re-derives each figure from the form's own lines, written here without the
 * engine's code, and holds the engine to it.
 *
 * ── What is asserted ─────────────────────────────────────────────────
 *
 *   THE LAW         premium-tax-credit.js against the form, for 2026 and 2027,
 *                   households of one to four, every income on a grid from 0 to
 *                   450% of the poverty line plus every band edge, the dollar
 *                   either side of 100% and 400%, and the premium cap.
 *   INDEXING        past the last published year the poverty line follows the
 *                   price level and the percentages the premium-growth factor.
 *   THE RUNS        every aca-* fixture: each covered year's credit recomputed
 *                   from the card's own premium history and the year's ACA MAGI;
 *                   each month's advance from the estimate it records; the
 *                   advance totals, the January settlement, its package, the
 *                   premium stepping only in January, and the card's expense
 *                   netting the advance.
 *   THE EDGES       a card with no finish date ends before 65; a card with the
 *                   credit off gets none; a backtest keeps the card's growth over
 *                   CPI; a card survives a JSON round trip without its run state.
 *
 * Run: node tests/aca-oracle.mjs   (from src/)
 */

import assert from 'node:assert/strict';

const RealDate = Date;
const PINNED = new RealDate(2026, 0, 15);
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(PINNED.getTime());
    else super(...args);
  }
  static now() { return PINNED.getTime(); }
};

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

const G = await import('../js/globals.js');
const { Portfolio } = await import('../js/portfolio.js');
const { chronometer_run } = await import('../js/chronometer.js');
const { ModelAsset } = await import('../js/model-asset.js');
const { Metric } = await import('../js/metric.js');
const { EventType } = await import('../js/sim-event.js');
const { applyRandomRates } = await import('../js/mc-compute.js');
const { global_cpi_annual_inflation } = await import('../js/market-data.js');
const PTC = await import('../js/premium-tax-credit.js');
const { SNAPSHOT_FIXTURES } = await import('./tools/fixtures.mjs');

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

const near = (got, want, what, tol = 0.01) =>
  assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want}`);

// ── Form 8962, written from the form ─────────────────────────────────
//
// Line 4: the poverty line for the family size, from the year before the
// coverage year. Line 5: line 3 / line 4 as a whole percentage. Line 7: the
// applicable figure from Table 2. Line 8a: line 3 × line 7, to the dollar. Line
// 8b: 8a / 12, to the dollar. Lines 11-23: per month, (e) = min((a), max(0,
// (b) − (c))) with (a) the enrollment premium, (b) the SLCSP and (c) line 8b.

const FORM_TABLES = {
  // Rev. Proc. 2025-25 and the 2025 HHS guidelines.
  2026: {
    fpl: [15650, 5500],
    // [low %, high %, figure at low, figure at high]
    bands: [[0, 133, 2.10, 2.10], [133, 150, 3.14, 4.19], [150, 200, 4.19, 6.60],
            [200, 250, 6.60, 8.44], [250, 300, 8.44, 9.96], [300, 400, 9.96, 9.96]],
  },
  // Rev. Proc. 2026-26 and the 2026 HHS guidelines.
  2027: {
    fpl: [15960, 5680],
    bands: [[0, 133, 2.15, 2.15], [133, 150, 3.23, 4.30], [150, 200, 4.30, 6.78],
            [200, 250, 6.78, 8.66], [250, 300, 8.66, 10.22], [300, 400, 10.22, 10.22]],
  },
};

function formLine4(year, size) {
  const [one, more] = FORM_TABLES[year].fpl;
  return one + more * (size - 1);
}

/**
 * A year past 2027, as the engine is meant to index it in a run at a steady
 * plan inflation: the poverty line grows at plan inflation, and each figure by
 * (1 + the card's rate) / (1 + plan inflation) a year. Rounded to hundredths
 * of a percent, which is all the form works in.
 */
function indexedFormYear(year, inflation, cardRate) {
  if (FORM_TABLES[year]) return year;
  const key = `${year}@${inflation}/${cardRate}`;
  if (FORM_TABLES[key]) return key;
  const n = year - 2027;
  const g = ((1 + cardRate) / (1 + inflation)) ** n;
  const base = FORM_TABLES[2027];
  FORM_TABLES[key] = {
    fpl: base.fpl.map((x) => x * (1 + inflation) ** n),
    bands: base.bands.map(([lo, hi, a, b]) => [lo, hi, Math.round(a * g * 100) / 100, Math.round(b * g * 100) / 100]),
  };
  return key;
}

/**
 * Table 2: the applicable figure at a whole percentage, to four decimals. The
 * band figures are whole hundredths of a percent, so the line is worked in those
 * units and a point exactly half way rounds up.
 */
function formTable2(year, pct) {
  const bands = FORM_TABLES[year].bands;
  for (let i = 0; i < bands.length; i++) {
    const [lo, hi, a, b] = bands[i];
    const last = i === bands.length - 1;
    if (pct < hi || (last && pct <= hi)) {
      const aU = Math.round(a * 100), bU = Math.round(b * 100);
      const atU = pct < lo ? aU : aU + (bU - aU) * (pct - lo) / (hi - lo);
      return Math.floor(atU + 0.5) / 10000;
    }
  }
  return null;
}

function formCredit({ year, size, income, months, advanceIncome = null }) {
  const line4 = formLine4(year, size);
  if (income > 4 * line4) return { total: 0, eligible: false };
  if (income < line4) {
    const exception = advanceIncome != null && advanceIncome >= line4 && advanceIncome <= 4 * line4;
    if (!exception) return { total: 0, eligible: false };
  }
  const line5 = Math.round((income / line4) * 100);
  const line7 = formTable2(year, Math.max(0, line5));
  const line8a = Math.round(Math.max(0, income) * line7);
  const line8b = Math.round(line8a / 12);
  let total = 0;
  for (const { premium, benchmark } of months) {
    total += Math.min(premium, Math.max(0, benchmark - line8b));
  }
  return { total, eligible: true, line5, line7, line8b };
}

// ── The law ──────────────────────────────────────────────────────────

console.log('\n── premium-tax-credit.js against the form ──\n');

await check('the published years are 2026 and 2027, and both are this file\'s', () => {
  assert.equal(PTC.FIRST_PUBLISHED_YEAR, 2026);
  assert.equal(PTC.LAST_PUBLISHED_YEAR, 2027);
});

for (const year of [2026, 2027]) {
  await check(`${year}: the poverty line and the cliff, households of one to six`, () => {
    const table = PTC.ptcTableFor(year);
    for (let size = 1; size <= 6; size++) {
      assert.equal(PTC.povertyLine(table, size), formLine4(year, size), `size ${size}`);
    }
    assert.equal(table.cliff, 4);
  });

  await check(`${year}: Table 2 at every whole percentage from 0 to 400`, () => {
    const table = PTC.ptcTableFor(year);
    for (let pct = 0; pct <= 400; pct++) {
      assert.equal(PTC.applicableFigure(table, pct), formTable2(year, pct), `${pct}%`);
    }
    assert.equal(PTC.applicableFigure(table, 401), null, 'no figure above the cliff');
  });

  await check(`${year}: the credit on a grid of incomes, sizes and premiums`, () => {
    const table = PTC.ptcTableFor(year);
    let compared = 0, capped = 0, zero = 0;
    for (let size = 1; size <= 4; size++) {
      const line = formLine4(year, size);
      const incomes = [];
      for (let i = 0; i <= 4.5 * line; i += 250) incomes.push(i);
      for (const m of [1, 1.33, 1.5, 2, 2.5, 3, 4]) incomes.push(m * line, m * line - 1, m * line + 1);
      for (const income of incomes) {
        for (const [premium, benchmark] of [[1100, 1000], [400, 1000], [2400, 2200], [600, 600]]) {
          const months = Array.from({ length: 12 }, () => ({ premium, benchmark }));
          const got = PTC.premiumTaxCredit({ table, householdSize: size, householdIncome: income, months });
          const want = formCredit({ year, size, income, months });
          near(got.total, want.total, `${year} size ${size} income ${income} premium ${premium}`);
          compared++;
          if (want.total === 0) zero++;
          else if (want.total === 12 * premium) capped++;
        }
      }
    }
    assert.ok(compared > 1000 && capped > 0 && zero > 0,
      `grid too narrow: ${compared} cases, ${capped} at the premium cap, ${zero} with no credit`);
  });

  await check(`${year}: one dollar over 400% loses the credit; 400% exactly keeps it`, () => {
    const table = PTC.ptcTableFor(year);
    const line = formLine4(year, 1);
    const months = Array.from({ length: 12 }, () => ({ premium: 1500, benchmark: 1400 }));
    const at = PTC.premiumTaxCredit({ table, householdSize: 1, householdIncome: 4 * line, months });
    const over = PTC.premiumTaxCredit({ table, householdSize: 1, householdIncome: 4 * line + 1, months });
    assert.ok(at.total > 0, 'at 400% there is a credit');
    assert.equal(over.total, 0);
    assert.equal(over.eligibility, PTC.PtcEligibility.OVER_CLIFF);
  });

  await check(`${year}: under 100%, the credit only with an advance on an estimate of 100% to 400%`, () => {
    const table = PTC.ptcTableFor(year);
    const line = formLine4(year, 1);
    const months = Array.from({ length: 12 }, () => ({ premium: 900, benchmark: 850 }));
    const income = 0.6 * line;
    const none = PTC.premiumTaxCredit({ table, householdSize: 1, householdIncome: income, months });
    assert.equal(none.total, 0);
    assert.equal(none.eligibility, PTC.PtcEligibility.UNDER_FLOOR);
    const kept = PTC.premiumTaxCredit({ table, householdSize: 1, householdIncome: income, months,
      advanceIncome: 2 * line });
    assert.equal(kept.eligibility, PTC.PtcEligibility.ADVANCE_EXCEPTION);
    near(kept.total, formCredit({ year, size: 1, income, months, advanceIncome: 2 * line }).total, 'kept');
    for (const estimate of [0.9 * line, 4 * line + 1]) {
      const lost = PTC.premiumTaxCredit({ table, householdSize: 1, householdIncome: income, months,
        advanceIncome: estimate });
      assert.equal(lost.total, 0, `an advance on ${estimate} does not keep it`);
    }
  });
}

// ── Indexing ─────────────────────────────────────────────────────────

console.log('\n── Past the published tables ──\n');

await check('the poverty line follows the price level, the percentages the premium factor', () => {
  const last = PTC.ptcTableFor(2027);
  const t = PTC.ptcTableFor(2030, { priceLevel: 1.09, percentageGrowth: 1.04 });
  assert.equal(t.indexed, true);
  near(t.povertyLine.first, last.povertyLine.first * 1.09, 'first person', 1e-9);
  near(t.povertyLine.additional, last.povertyLine.additional * 1.09, 'each additional', 1e-9);
  for (let i = 0; i < last.bands.length; i++) {
    near(t.bands[i].initial, last.bands[i].initial * 1.04 ** 3, `band ${i} initial`, 1e-12);
    near(t.bands[i].final, last.bands[i].final * 1.04 ** 3, `band ${i} final`, 1e-12);
    assert.equal(t.bands[i].upTo, last.bands[i].upTo, 'the band edges do not move');
  }
  assert.equal(t.cliff, 4);
});

await check('at a factor of one the percentages hold, and a published year is never indexed', () => {
  const t = PTC.ptcTableFor(2031, { priceLevel: 1.2, percentageGrowth: 1 });
  assert.deepEqual(t.bands.map((b) => [b.initial, b.final]),
    PTC.PTC_TABLES[2027].bands.map((b) => [b.initial, b.final]));
  const published = PTC.ptcTableFor(2027, { priceLevel: 2, percentageGrowth: 2 });
  assert.equal(published.indexed, false);
  assert.equal(published.povertyLine.first, 15960);
});

// ── The runs ─────────────────────────────────────────────────────────

/** The snapshot harness's configuration for a fixture, then a run. */
async function runFixture(fixture, { backtestYear = 'current' } = {}) {
  G.global_reset();
  G.global_setAllocateHouseholdTax(false);
  G.global_setBacktestYearDirect?.(backtestYear);
  const c = fixture.config ?? {};
  if (c.startAge != null) { G.global_setUserStartAge(c.startAge); G.global_getUserStartAge(); }
  if (c.retirementAge != null) { G.global_setUserRetirementAge(c.retirementAge); G.global_getUserRetirementAge(); }
  if (c.finishAge != null) { G.global_setUserFinishAge(c.finishAge); G.global_getUserFinishAge?.(); }
  if (c.filingAs != null) { G.global_setFilingAs(c.filingAs); G.global_getFilingAs(); }
  G.setActiveTaxTable(G.makeActiveTaxTable());

  const built = fixture.build();
  const portfolio = new Portfolio(built.assets, true, G.simConfigFromGlobals());
  if (built.lifeEvents) portfolio.lifeEvents = built.lifeEvents;
  await chronometer_run(portfolio);
  return portfolio;
}

const monthIndex = (p, year, month) => (year - p.firstDateInt.year) * 12 + (month - p.firstDateInt.month);

/** A covered year's months from the card's own history, as the form takes them. */
function coveredMonths(p, card, year) {
  const premiums = card.getHistory(Metric.HEALTH_PREMIUM);
  const start = Math.abs(card.startCurrency.amount);
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const i = monthIndex(p, year, m);
    if (i < 0 || i >= premiums.length) continue;
    const premium = -premiums[i];
    if (!(premium > 0)) continue;
    months.push({ i, premium, benchmark: card.benchmarkPremium.amount * premium / start });
  }
  return months;
}

console.log('\n── Every aca-* fixture against the form ──\n');

const ACA = SNAPSHOT_FIXTURES.filter((f) => f.name.startsWith('aca-'));
const reached = { advance: 0, credit: 0, repayment: 0, partial: 0, exception: 0, cliff: 0, unfunded: 0, indexed: 0 };

for (const fixture of ACA) {
  const p = await runFixture(fixture);
  const cards = p.modelAssets.filter((a) => a.instrument === 'healthInsurance');
  const married = fixture.config.filingAs === 'MFJ';

  await check(`${fixture.name}: each covered year's credit is the form's`, () => {
    assert.equal(cards.length, 1, 'one card per aca-* fixture');
    const card = cards[0];
    const size = card.householdSize ?? (married ? 2 : 1);
    const cardRate = card.annualReturnRate.rate || p.config.inflationRate;
    for (const t of p.taxYears) {
      const months = coveredMonths(p, card, t.year);
      if (months.length === 0) {
        assert.equal(t.fplPercent, null, `${t.year} has no coverage but a percentage`);
        continue;
      }
      const advances = card.events.filter((e) => e.type === EventType.PREMIUM_TAX_CREDIT
        && e.dateInt.year === t.year);
      const estimate = advances[0]?.data.estimate ?? card.estimatedAcaIncome?.amount ?? null;
      const income = t.ptcOnEstimate ? estimate : t.magi.aca;
      if (t.ptcOnEstimate) reached.partial++;
      if (income == null) { assert.equal(t.ptc, 0, `${t.year}: no income to test, no credit`); continue; }
      // Past 2027 the year is the last published one, indexed. The history
      // holds premiums to the cent, so those years agree to a few cents.
      const year = indexedFormYear(t.year, p.config.inflationRate, cardRate);
      if (typeof year === 'string') reached.indexed++;
      const want = formCredit({ year, size, income, months,
        advanceIncome: advances.length ? estimate : null });
      near(t.ptc, want.total, `${t.year} ptc`, typeof year === 'string' ? 0.15 : 0.01);
      if (income < formLine4(year, size) && want.total > 0) reached.exception++;
      if (income > 4 * formLine4(year, size)) reached.cliff++;
    }
  });

  await check(`${fixture.name}: each month's advance is the form's credit at its estimate`, () => {
    const card = cards[0];
    const size = card.householdSize ?? (married ? 2 : 1);
    const cardRate = card.annualReturnRate.rate || p.config.inflationRate;
    for (const e of card.events.filter((x) => x.type === EventType.PREMIUM_TAX_CREDIT)) {
      reached.advance++;
      const year = indexedFormYear(e.dateInt.year, p.config.inflationRate, cardRate);
      const i = monthIndex(p, e.dateInt.year, e.dateInt.month);
      const premium = -card.getHistory(Metric.HEALTH_PREMIUM)[i];
      const benchmark = card.benchmarkPremium.amount * premium / Math.abs(card.startCurrency.amount);
      const one = formCredit({ year, size, income: e.data.estimate,
        months: [{ premium, benchmark }] });
      near(e.amount.amount, one.total * e.data.share, `${e.dateInt} advance`, 0.015);
      assert.equal(e.data.share, card.advanceCreditShare, `${e.dateInt} advanced at the card's share`);
    }
  });

  await check(`${fixture.name}: the advance, the settlement and the packages agree`, () => {
    const card = cards[0];
    for (const t of p.taxYears) {
      const advanced = card.events
        .filter((e) => e.type === EventType.PREMIUM_TAX_CREDIT && e.dateInt.year === t.year)
        .reduce((s, e) => s + e.amount.amount, 0);
      near(t.aptc, advanced, `${t.year} aptc`);

      // Booked in the January after the year, in that month's package.
      const jan = p.monthlyPackages[monthIndex(p, t.year + 1, 1)];
      if (jan) near(jan.ptcReconciliation.amount, t.ptcReconciliation, `${t.year} settlement package`);

      const settledEvents = p.modelAssets.flatMap((a) => a.events)
        .filter((e) => e.type === EventType.PTC_RECONCILIATION && e.dateInt.year === t.year);
      const unfunded = p.modelAssets.flatMap((a) => a.events)
        .filter((e) => e.type === EventType.UNFUNDED && e.dateInt.year === t.year
          && /premium tax credit/i.test(e.data?.cause ?? ''))
        .reduce((s, e) => s + Math.abs(e.amount.amount), 0);
      if (unfunded > 0) reached.unfunded++;
      const net = t.ptc - t.aptc;
      if (Math.abs(net) < 1) {
        assert.equal(settledEvents.length, 0, `${t.year}: under the $1 gate, nothing settles`);
        continue;
      }
      if (net > 0) {
        reached.credit++;
        near(t.ptcReconciliation, net, `${t.year} credit owed`);
      } else {
        reached.repayment++;
        // What the accounts paid, plus what nothing could pay, is the repayment.
        near(-t.ptcReconciliation + unfunded, -net, `${t.year} repaid + unfunded`);
      }
    }
  });

  await check(`${fixture.name}: the premium steps only in January, and the card's expense nets the advance`, () => {
    const card = cards[0];
    const premiums = card.getHistory(Metric.HEALTH_PREMIUM);
    const credits = card.getHistory(Metric.PREMIUM_TAX_CREDIT);
    const expenses = card.getHistory(Metric.EXPENSE);
    const rate = card.annualReturnRate.rate || p.config.inflationRate;
    for (let i = 1; i < premiums.length; i++) {
      if (premiums[i] === 0 || premiums[i - 1] === 0) continue;
      const month = ((p.firstDateInt.month - 1 + i) % 12) + 1;
      if (month === 1) near(premiums[i], premiums[i - 1] * (1 + rate), `month ${i} January step`, 0.02);
      else assert.equal(premiums[i], premiums[i - 1], `month ${i} moved outside January`);
    }
    // Each history entry is rounded to the cent on its own, so two can be a
    // cent off their rounded sum.
    for (let i = 0; i < premiums.length; i++) {
      near(expenses[i], premiums[i] + credits[i], `month ${i} expense`, 0.015);
      near(p.monthlyPackages[i].premiumTaxCredit.amount, credits[i], `month ${i} package advance`, 0.015);
    }
  });
}

await check('the corpus reaches advances, credits owed, repayments, the partial year, the exception, the cliff, an unpayable repayment and indexed years', () => {
  for (const [what, n] of Object.entries(reached)) assert.ok(n > 0, `nothing reached: ${what}`);
});

// ── The edges ────────────────────────────────────────────────────────

console.log('\n── The edges ──\n');

const cliff = SNAPSHOT_FIXTURES.find((f) => f.name === 'aca-over-the-cliff');

await check('a card with no finish date ends the December before the household turns 65', async () => {
  const p = await runFixture(cliff);
  const card = p.modelAssets.find((a) => a.instrument === 'healthInsurance');
  assert.equal(card.finishDateInt, null);
  assert.equal(card.effectiveFinishDateInt.toString(), '2029-12');   // 61 in 2026, 65 in 2030
  const t2030 = p.taxYears.find((t) => t.year === 2030);
  assert.equal(t2030.fplPercent, null);
  assert.equal(t2030.ptc, 0);
});

await check('a card with the credit off is an expense and nothing more', async () => {
  const fixture = {
    ...cliff,
    build: () => {
      const built = cliff.build();
      for (const a of built.assets) if (a.instrument === 'healthInsurance') a.premiumTaxCreditEnabled = false;
      return built;
    },
  };
  const p = await runFixture(fixture);
  const card = p.modelAssets.find((a) => a.instrument === 'healthInsurance');
  assert.equal(card.events.filter((e) => e.type === EventType.PREMIUM_TAX_CREDIT).length, 0);
  assert.ok(p.taxYears.every((t) => t.ptc === 0 && t.aptc === 0 && t.fplPercent === null));
  assert.equal(p.total.ptcReconciliation.amount, 0);
});

await check('a backtest keeps the card\'s growth over plan inflation on top of each year\'s CPI', async () => {
  const single = SNAPSHOT_FIXTURES.find((f) => f.name === 'aca-early-retiree-single');
  const backtestYear = 1973;
  const p = await runFixture(single, { backtestYear });
  const card = p.modelAssets.find((a) => a.instrument === 'healthInsurance');
  const premiums = card.getHistory(Metric.HEALTH_PREMIUM);
  const excess = 0.08 - p.config.inflationRate;
  let steps = 0;
  for (let year = 2027; year <= 2030; year++) {
    const dec = premiums[monthIndex(p, year - 1, 12)];
    const jan = premiums[monthIndex(p, year, 1)];
    const cpi = global_cpi_annual_inflation[backtestYear + (year - 2026)] / 100;
    // The history holds cents, so the ratio of two entries is good to about 1e-5.
    near(jan / dec - 1, cpi + excess, `${year} step`, 1e-5);
    steps++;
  }
  assert.equal(steps, 4);
});

await check('a historical Monte Carlo draw does the same, and leaves other expenses at CPI', () => {
  G.global_reset();
  const config = G.simConfigFromGlobals();
  const card = ModelAsset.fromJSON({ instrument: 'healthInsurance', displayName: 'Plan',
    startDateInt: { year: 2026, month: 1 }, startCurrency: { amount: -1000 },
    annualReturnRate: { rate: 0.09 } });
  const living = ModelAsset.fromJSON({ instrument: 'monthlyExpense', displayName: 'Living',
    startDateInt: { year: 2026, month: 1 }, startCurrency: { amount: -3000 },
    annualReturnRate: { rate: 0 } });
  for (const a of [card, living]) { a.bindEnv(config); a.initializeChron(); }
  const pool = { years: [1990], means: { sp500: 0, treasury: 0, cpi: 0, wage: 0 } };
  const draw = applyRandomRates([card, living], pool, 'historical', null, config.inflationRate, () => 0);
  near(living.annualReturnRate.rate, draw.cpi, 'living at CPI', 1e-12);
  near(card.annualReturnRate.rate, draw.cpi + (0.09 - config.inflationRate), 'card at CPI + excess', 1e-12);
});

await check('the estimate: the card\'s until a full year on the marketplace, then that year', async () => {
  const p = await runFixture(SNAPSHOT_FIXTURES.find((f) => f.name === 'aca-partial-first-year'));
  const card = p.modelAssets.find((a) => a.instrument === 'healthInsurance');
  const estimateIn = (year) => card.events.find((e) => e.type === EventType.PREMIUM_TAX_CREDIT
    && e.dateInt.year === year)?.data.estimate;
  assert.equal(estimateIn(2026), 40000, '2026: the plan has no year before it');
  assert.equal(estimateIn(2027), 40000, '2027: 2026 was three months, not a full year');

  // The three months of 2026 are settled on the estimate, not on the MAGI of
  // the three months the plan saw, which would put the household under 100%.
  const t2026 = p.taxYears.find((t) => t.year === 2026);
  assert.equal(t2026.months, 3);
  assert.equal(t2026.ptcOnEstimate, true);
  assert.ok(t2026.magi.aca < formLine4(2026, 1), 'the three months alone are under the floor');
  near(t2026.ptc, formCredit({ year: 2026, size: 1, income: 40000,
    months: coveredMonths(p, card, 2026), advanceIncome: 40000 }).total, '2026 on the estimate');
  near(estimateIn(2028), p.taxYears.find((t) => t.year === 2027).magi.aca, '2028 renews on 2027', 1e-6);
  near(estimateIn(2029), p.taxYears.find((t) => t.year === 2028).magi.aca, '2029 renews on 2028', 1e-6);
});

await check('the accounts pay the premium net of the advance, every month', async () => {
  for (const fixture of ACA) {
    const p = await runFixture(fixture);
    const card = p.modelAssets.find((a) => a.instrument === 'healthInsurance');
    const expenses = card.getHistory(Metric.EXPENSE);
    const paid = new Map();
    for (const e of card.events) {
      if (![EventType.TRANSFER, EventType.GROSS_UP, EventType.SETTLEMENT].includes(e.type)) continue;
      const i = monthIndex(p, e.dateInt.year, e.dateInt.month);
      paid.set(i, (paid.get(i) ?? 0) + e.amount.amount);
    }
    // The card records what its transfers moved as positive; its expense is
    // negative.
    for (const [i, amount] of paid) {
      near(amount, -expenses[i], `${fixture.name} month ${i}: paid vs the net premium`, 0.015);
    }
    assert.ok(paid.size > 12, `${fixture.name}: too few months paid to check`);
  }
});

await check('a card round-trips through JSON with its settings and without its run state', async () => {
  const p = await runFixture(SNAPSHOT_FIXTURES.find((f) => f.name === 'aca-partial-first-year'));
  const card = p.modelAssets.find((a) => a.instrument === 'healthInsurance');
  const json = JSON.parse(JSON.stringify(card));
  for (const runState of ['monthlyAdvanceCredit', 'monthlyAdvanceData', 'premiumExcessOverInflation']) {
    assert.ok(!(runState in json), `${runState} reached the JSON`);
  }
  const back = ModelAsset.fromJSON(json);
  assert.equal(back.instrument, 'healthInsurance');
  assert.equal(back.benchmarkPremium.amount, 900);
  assert.equal(back.estimatedAcaIncome.amount, 40000);
  assert.equal(back.advanceCreditShare, 0.8);
  assert.equal(back.householdSize, null);
  assert.equal(back.premiumTaxCreditEnabled, true);
});

console.log(`\n───────────────────────────────────────────────────────`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`───────────────────────────────────────────────────────`);
if (failed > 0) process.exit(1);
