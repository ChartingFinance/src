/**
 * membrane.js
 *
 * Model conversion utilities — bridges between raw data/HTML forms
 * and ModelAsset instances.
 */

import { ModelAsset } from './model-asset.js';

export function membrane_jsonObjectsToModelAssets(jsonObjects) {
    return jsonObjects.map(obj => ModelAsset.fromJSON(obj));
}

export function membrane_rawDataToModelAssets(rawModelAssets) {
    if (!rawModelAssets) return [];
    return rawModelAssets.map(raw => ModelAsset.fromJSON(raw));
}

export function membrane_htmlElementToAssetModel(assetElement) {
    const inputElements = assetElement.querySelectorAll('input, select');
    const colorElement = assetElement.querySelector('.card-chart-color');
    return ModelAsset.fromHTML(inputElements, colorElement);
}
