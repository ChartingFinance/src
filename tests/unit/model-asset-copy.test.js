/**
 * model-asset-copy.test.js — a copied asset is the same plan.
 *
 * ModelAsset.copy() rebuilds an asset from a hand-written list of constructor
 * options, and the list had fallen four behind: the maintenance rate, the
 * insurance cost, the one-time events and the purchase funding were dropped.
 *
 * Only Portfolio.copy() calls it, and only the Maximizer uses that — but the
 * Maximizer's page RE-RUNS the copy to draw its chart and its Best Terminal and
 * Best Spending figures. Mid Career with a home's usual costs and one $40,000
 * one-time expense showed $3,663,579 where the plan ends at $3,479,119.
 *
 * So the copy is checked two ways: against the constructor's own option list,
 * so an option added later cannot be left out, and by running it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

const { Currency }     = await import('../../js/utils/currency.js');
const { DateInt }      = await import('../../js/utils/date-int.js');
const { ARR }          = await import('../../js/utils/arr.js');
const { ModelAsset }   = await import('../../js/model-asset.js');
const { OneTimeEvent } = await import('../../js/one-time.js');
const { Portfolio }    = await import('../../js/portfolio.js');
const { Instrument }   = await import('../../js/instruments/instrument.js');
const { ModelLifeEvent } = await import('../../js/life-event.js');
const { chronometer_run } = await import('../../js/chronometer.js');
const { planFromProfile, simConfigFromPlanSpec } = await import('../../js/mcp/run-plan.js');
const { membrane_jsonObjectsToModelAssets, membrane_rawDataToModelAssets } = await import('../../js/membrane.js');

/** Every constructor option, each with a value that is not its default. */
const everyOption = () => ({
  instrument: Instrument.REAL_ESTATE,
  displayName: 'Home',
  startDateInt: DateInt.from(2027, 3),
  startCurrency: new Currency(500000),
  startBasisCurrency: new Currency(350000),
  finishDateInt: DateInt.from(2045, 6),
  monthsRemaining: 120,
  annualReturnRate: new ARR(0.03),
  annualDividendRate: new ARR(0.015),
  longTermCapitalHoldingPercentage: new ARR(0.02),
  fundTransfers: [],
  isSelfEmployed: true,
  isPrimaryHome: false,
  annualTaxRate: new ARR(0.011),
  dividendQualifiedRatio: 0.4,
  annualMaintenanceRate: new ARR(0.01),
  annualInsuranceCost: new Currency(2400),
  fundingConfig: { purchaseType: 'downPayment', sourceDisplayName: 'Savings', downPaymentPercent: 20 },
  oneTimeEvents: [new OneTimeEvent(DateInt.from(2030, 6), new Currency(-40000), 'Roof')],
  benchmarkPremium: new Currency(950),
  householdSize: 4,
  advanceCreditShare: 0.5,
  estimatedAcaIncome: new Currency(60000),
  premiumTaxCreditEnabled: false,
});

/**
 * The constructor's option names, read from its source: the destructured
 * parameter list between `constructor({` and `}) {`.
 */
function constructorOptions() {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../js/model-asset.js');
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf('constructor({');
  const list = source.slice(start + 'constructor({'.length, source.indexOf('}) {', start));
  return list.split('\n').map((line) => line.trim().match(/^([A-Za-z0-9_]+)/)?.[1]).filter(Boolean);
}

/** What a run reads from an asset: its serialized form, less what copy() resets on purpose. */
const config = (asset) => {
  const json = JSON.parse(JSON.stringify(asset.toJSON()));
  delete json.colorId;
  return json;
};

describe('ModelAsset.copy', () => {
  it('the fixture sets every constructor option', () => {
    // Otherwise an option added to the constructor, and left out of copy(),
    // would also be missing here, and the check below would still pass.
    expect(Object.keys(everyOption()).sort()).toEqual(constructorOptions().sort());
  });

  it('the fixture leaves no option at its default', () => {
    const made = new ModelAsset(everyOption());
    const plain = new ModelAsset({
      instrument: Instrument.BANK, displayName: 'Plain',
      startDateInt: DateInt.from(2026, 1), startCurrency: new Currency(1),
      annualReturnRate: new ARR(0),
    });
    const same = constructorOptions()
      .filter((k) => k !== 'fundTransfers')          // a copy's are empty on purpose: phases hold them
      .filter((k) => JSON.stringify(made[k]) === JSON.stringify(plain[k]));
    expect(same).toEqual([]);
  });

  it('carries everything a run reads', () => {
    const source = new ModelAsset(everyOption());
    expect(config(source.copy())).toEqual(config(source));
  });

  it('keeps the home costs, the one-time events and the purchase funding', () => {
    const copy = new ModelAsset(everyOption()).copy();
    expect(copy.annualMaintenanceRate.rate).toBe(0.01);
    expect(copy.annualInsuranceCost.amount).toBe(2400);
    expect(copy.oneTimeEvents).toHaveLength(1);
    expect(copy.oneTimeEvents[0].amount.amount).toBe(-40000);
    expect(copy.fundingConfig).toEqual({ purchaseType: 'downPayment', sourceDisplayName: 'Savings', downPaymentPercent: 20 });
  });

  it('does not share its lists with the source', () => {
    const source = new ModelAsset(everyOption());
    const copy = source.copy();
    copy.oneTimeEvents.push('added to the copy');
    copy.fundingConfig.downPaymentPercent = 99;
    expect(source.oneTimeEvents).toHaveLength(1);
    expect(source.fundingConfig.downPaymentPercent).toBe(20);
  });
});

describe('a copied portfolio, run again, ends where its source did', () => {
  it('as the Maximizer page re-runs the plan its worker sends', async () => {
    // Mid Career, with what a home entered through the form carries (1%
    // maintenance, insurance) and one one-time expense.
    const spec = planFromProfile('midCareer');
    const home = spec.modelAssets.find((a) => a.instrument === Instrument.REAL_ESTATE);
    home.annualMaintenanceRate = { rate: 0.01 };
    home.annualInsuranceCost = { amount: 2400 };
    const brokerage = spec.modelAssets.find((a) => a.instrument === Instrument.TAXABLE_EQUITY);
    brokerage.oneTimeEvents = [{ dateInt: { year: 2030, month: 6 }, amount: { amount: -40000 }, note: 'Roof' }];

    const run = async (assets) => {
      const p = new Portfolio(assets, false, simConfigFromPlanSpec(spec));
      p.lifeEvents = spec.lifeEvents.map((e) => ModelLifeEvent.fromJSON(e));
      await chronometer_run(p);
      return p;
    };
    const source = await run(membrane_rawDataToModelAssets(spec.modelAssets));

    // The old Maximizer posted `bestPortfolio.modelAssets` as JSON, and its
    // dialog rebuilt and ran them. Anything that sends a copied portfolio's
    // assets to be run again depends on the same thing.
    const sent = JSON.parse(JSON.stringify(source.copy().modelAssets));
    const shown = await run(membrane_jsonObjectsToModelAssets(sent));

    expect(Math.round(shown.finishValue().amount)).toBe(Math.round(source.finishValue().amount));
    // The costs are in the plan at all: without them it would end richer.
    const bare = JSON.parse(JSON.stringify(spec.modelAssets));
    for (const a of bare) { delete a.annualMaintenanceRate; delete a.annualInsuranceCost; a.oneTimeEvents = []; }
    const without = await run(membrane_rawDataToModelAssets(bare));
    expect(without.finishValue().amount - source.finishValue().amount).toBeGreaterThan(100000);
  });
});
