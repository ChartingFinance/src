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

/**
 * What is wrong with a name typed into the asset form, or null.
 *
 * An asset's name is how everything else refers to it: fund transfers name
 * their target, phases key their rules by it, and the asset list keys its cards
 * by it. Two assets with one name make each of those ambiguous, and an asset
 * with no name cannot be referred to at all, so the form takes neither.
 * Names differing only in case or outer spaces count as the same: nobody can
 * tell "Savings" from "savings " in a list.
 *
 * @param {string} name          as typed
 * @param {string[]} otherNames  the names of the plan's other assets
 * @returns {string|null}
 */
export function assetNameProblem(name, otherNames = []) {
    const wanted = String(name ?? '').trim();
    if (!wanted) return 'Give this asset a name.';
    const taken = otherNames.find((n) => String(n ?? '').trim().toLowerCase() === wanted.toLowerCase());
    return taken != null
        ? `Another asset is already called "${taken}". Names have to differ: transfers refer to an asset by its name.`
        : null;
}
