/**
 * asset-edit.js — saving an edited asset form back onto the asset it edits.
 *
 * The form produces a whole new ModelAsset (ModelAsset.fromHTML). The edit
 * keeps the existing object, because the rest of the page holds it, and copies
 * the form's fields onto it. Everything the form does not own stays as it was:
 * one-time events, the funding config of a purchase, the colour.
 *
 * The list lives here, apart from finplan-app.js, so a test can read it:
 * tests/unit/asset-edit.test.js fails when ModelAsset.fromHTML reads a form
 * field that is missing below. Without that, a new field saves on create and is
 * dropped on edit, and nothing reports it.
 */

/** Every ModelAsset field the asset form can set. */
export const ASSET_FORM_FIELDS = Object.freeze([
    'instrument',
    'displayName',
    'startDateInt',
    'startCurrency',
    'startBasisCurrency',
    'finishDateInt',
    'monthsRemaining',
    'annualReturnRate',
    'annualDividendRate',
    'dividendQualifiedRatio',
    'longTermCapitalHoldingPercentage',
    'isSelfEmployed',
    'isPrimaryHome',
    'annualTaxRate',
    'annualMaintenanceRate',
    'annualInsuranceCost',
    'benchmarkPremium',
    'householdSize',
    'advanceCreditShare',
    'estimatedAcaIncome',
    'premiumTaxCreditEnabled',
]);

/**
 * Copy what the form set from `edited` onto `target`.
 *
 * @param {ModelAsset} target  the asset being edited; changed in place
 * @param {ModelAsset} edited  the asset the form produced
 * @returns {ModelAsset} target
 */
export function applyAssetFormEdit(target, edited) {
    for (const field of ASSET_FORM_FIELDS) target[field] = edited[field];
    return target;
}
