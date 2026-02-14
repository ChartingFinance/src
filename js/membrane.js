import { ModelAsset } from './model-asset.js';
import { FundTransfer } from './fund-transfer.js';
import { colorRange, html_buildRemovableAssetElement } from './html.js';

export function membrane_jsonObjectToModelAsset(jsonObject) {
    var modelAsset = ModelAsset.fromJSON(jsonObject);
    return modelAsset;
}

export function membrane_jsonObjectsToModelAssets(jsonObjects) {
    var modelAssets = [];
    for (const jsonObject of jsonObjects) {
        modelAssets.push(membrane_jsonObjectToModelAsset(jsonObject));
    };    
    return modelAssets;
}

export function membrane_modelAssetToHTML(modelAssets, modelAsset) {
    let html = html_buildRemovableAssetElement(modelAssets, modelAsset);
    return html;
}

export function membrane_modelAssetsToHTML(modelAssets) {
    let html = '';
    let colorId = 0;
    for (let modelAsset of modelAssets) {
        if (colorId >= colorRange.length)
            colorId = 0;
        modelAsset.colorId = colorId++;
        html += membrane_modelAssetToHTML(modelAssets, modelAsset);
    };
    return html;
}

/* This is required in order to turn data objects into object instances-- like Month-Year data to DateInt objects */
export function membrane_rawDataToModelAssets(rawModelAssets) {
    let result = [];
    if (rawModelAssets) {
        for (let ii = 0; ii < rawModelAssets.length; ii++) {
            result.push(membrane_rawModelDataToModelAsset(rawModelAssets[ii]));
        }
    }
    return result;
}

export function membrane_rawModelDataToModelAsset(rawModelData) {
    return ModelAsset.fromJSON(rawModelData);
}

export function membrane_htmlElementToAssetModel(assetElement) {
    const inputElements = assetElement.querySelectorAll('input, select');
    const colorElement = assetElement.querySelector('.card-chart-color');
    return ModelAsset.fromHTML(inputElements, colorElement);
}

export function membrane_htmlElementsToAssetModels(assetsContainerElement) {
    var assetModels = [];
    const assetElements = assetsContainerElement.querySelectorAll('form');
    for (const assetElement of assetElements) {
        // kind of weird to stringify and parse, but matches the pattern
        assetModels.push(membrane_htmlElementToAssetModel(assetElement));
    }
    return assetModels;
}

export function membrane_htmlElementsToFundTransfers(currentDisplayName, scrollableYElement) {
    var fundTransfers = [];
    const fundTransferElements = scrollableYElement.querySelectorAll('.fund-transfer');
    for (const fundTransferElement of fundTransferElements) {
        let fundTransfer = FundTransfer.fromHTML(fundTransferElement);        
        if (fundTransfer.moveValue) {
            fundTransfers.push(fundTransfer);
        }
    }
    return fundTransfers;
}

