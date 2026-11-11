/**
 * asset-edit.test.js — an edited asset form saves every field it shows.
 *
 * Editing keeps the existing ModelAsset and copies the form's fields onto it
 * (js/asset-edit.js). That list was once written out by hand in
 * finplan-app.js, and the health-insurance fields were never added to it:
 * creating a card saved its benchmark premium, income estimate, household size,
 * advance share and credit checkbox, and editing one saved the premium and
 * silently kept the old values of the rest.
 *
 * So the list is checked against ModelAsset.fromHTML, which decides what a
 * form can set: a form with every input filled in, applied to a blank asset,
 * must leave the two assets serializing alike.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

const { ModelAsset } = await import('../../js/model-asset.js');
const { ASSET_FORM_FIELDS, applyAssetFormEdit } = await import('../../js/asset-edit.js');

const el = (name, value, extra = {}) => ({ name, value, getAttribute: () => null, ...extra });
const box = (name, checked) => el(name, 'on', { type: 'checkbox', checked });

/** Every input the asset form can render, each with a value that is not its default. */
const everyInput = () => [
  el('instrument', 'healthInsurance'),
  el('displayName', 'Edited'),
  el('startDate', '2031-04'),
  el('startValue', '-1200'),
  el('startBasisValue', '777'),
  el('finishDate', '2040-06'),
  el('monthsRemaining', '120'),
  el('annualReturnRate', '6.5'),
  el('dividendRate', '1.5'),
  el('dividendQualifiedRatio', '40'),
  el('longTermRate', '3'),
  box('isSelfEmployed', true),
  box('isPrimaryHome', false),
  el('annualTaxRate', '1.1'),
  el('annualMaintenanceRate', '2'),
  el('annualInsuranceCost', '1800'),
  el('benchmarkPremium', '950'),
  el('householdSize', '4'),
  el('advanceCreditShare', '50'),
  el('estimatedAcaIncome', '60000'),
  box('premiumTaxCreditEnabled', false),
];

const blank = () => ModelAsset.fromHTML([
  el('instrument', 'bank'), el('displayName', 'Original'),
  el('startDate', '2026-01'), el('startValue', '100'),
], null);

/** What the form does not own, and an edit must leave alone. */
const KEPT = ['oneTimeEvents', 'fundingConfig', 'colorId'];
/** Run state the constructor seeds and every run re-seeds from the fields above. */
const RUN_STATE = ['finishBasisCurrency', 'monthsRemainingDynamic'];
const config = (asset) => {
  const json = JSON.parse(JSON.stringify(asset.toJSON()));
  for (const k of [...KEPT, ...RUN_STATE]) delete json[k];
  return json;
};

describe('applyAssetFormEdit', () => {
  it('carries every field the form can set', () => {
    const edited = ModelAsset.fromHTML(everyInput(), null);
    const target = applyAssetFormEdit(blank(), edited);
    expect(config(target)).toEqual(config(edited));
  });

  it('the fixture exercises every listed field', () => {
    // A field the fixture leaves at its default would pass the check above
    // whether or not it is copied.
    const before = blank();
    const edited = ModelAsset.fromHTML(everyInput(), null);
    const same = ASSET_FORM_FIELDS.filter(
      (f) => JSON.stringify(before[f]) === JSON.stringify(edited[f]));
    expect(same).toEqual([]);
  });

  it('saves the health-insurance fields', () => {
    const target = applyAssetFormEdit(blank(), ModelAsset.fromHTML(everyInput(), null));
    expect(target.benchmarkPremium.amount).toBe(950);
    expect(target.estimatedAcaIncome.amount).toBe(60000);
    expect(target.householdSize).toBe(4);
    expect(target.advanceCreditShare).toBe(0.5);
    expect(target.premiumTaxCreditEnabled).toBe(false);
  });

  it('leaves what the form does not own', () => {
    const target = blank();
    target.oneTimeEvents = ['kept'];
    target.colorId = 7;
    applyAssetFormEdit(target, ModelAsset.fromHTML(everyInput(), null));
    expect(target.oneTimeEvents).toEqual(['kept']);
    expect(target.colorId).toBe(7);
  });
});

/**
 * A Lit template with an attribute whose closing quote is missing does not
 * fail until it renders. <one-time-modal> carried `class="${...}>` on a branch
 * drawn only once an asset had one-time events: from then on the modal threw
 * on every render and could not be opened for that asset.
 */
describe('component templates', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../js/components');
  it('no attribute binding is missing its closing quote', () => {
    const found = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      readFileSync(path.join(dir, file), 'utf8').split('\n').forEach((line, i) => {
        if (/="\$\{[^"`]*\}>/.test(line)) found.push(`${file}:${i + 1}`);
      });
    }
    expect(found).toEqual([]);
  });
});
