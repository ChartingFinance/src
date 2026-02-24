import { InstrumentType, InstrumentMeta } from './instrument.js';
import { util_buildStoryArcKey, storyNamesKey, util_YYYYmmToDisplay, util_escapedJSONStringify } from './util.js';
import { findByName } from './asset-queries.js';

const htmlPlus = '➕';
const htmlMinus = '➖';

const htmlAssetCard =
`<form class="asset glass-card p-4" style="--card-color: $BACKGROUNDCOLOR$; border-left: 4px solid $BACKGROUNDCOLOR$">
    <span class="asset-action-btn edit" title="Edit">&#x270E;</span>
    <span class="asset-action-btn transfers" title="Transfers">&#x21C4;</span>
    <div class="asset-card-icon">$EMOJI$</div>
    <div class="asset-card-name">$DISPLAYNAME_VIS$</div>
    <div class="asset-card-value">$VALUE$</div>
    <span class="asset-action-btn remove" title="Remove">&#x2715;</span>
    <div class="card-chart-color" style="background-color: $BACKGROUNDCOLOR$; display: none;"></div>
    <select name="instrument" style="display:none">$INSTRUMENTOPTIONS$</select>
    <input type="hidden" name="displayName" value="$DISPLAYNAME$" />
    <input type="hidden" name="startDate" value="$STARTDATE$" />
    <input type="hidden" name="startValue" value="$STARTVALUE$" />
    <input type="hidden" name="finishDate" value="$FINISHDATE$" />
    <input type="hidden" name="finishValue" value="$FINISHVALUE$" />
    <input type="hidden" name="annualReturnRate" value="$ANNUALRETURNRATE$" />
    <input type="hidden" name="accumulatedValue" value="$ACCUMULATEDVALUE$" />
    <input type="hidden" name="basisValue" value="$BASISVALUE$" />
    <input type="hidden" name="monthsRemaining" value="$MONTHSREMAINING$" />
    <input type="hidden" name="dividendRate" value="$DIVIDENDRATE$" />
    <input type="hidden" name="longTermRate" value="$LONGTERMRATE$" />
    <input type="hidden" name="fundTransfers" data-fundtransfers="$FUNDTRANSFERS$" />
    <input type="hidden" name="isSelfEmployed" value="$ISSELFEMPLOYED$" />
</form>`;

const htmlInvisibleDisplay = `<label class="invisible" for="invisiblePlaceholder">Invisible</label><br class="invisible" />
    <input class="invisible" type="number" style=""width: 125px" name="invisiblePlaceholder" placeholder="invisible" />`;

const htmlInvisibleHidden = `<label class="invisible" style="display: none" for="invisiblePlaceholder">Invisible</label><br class="invisible" style="display: none" />
    <input class="invisible" type="number" style="display: none; width: 125px" name="invisiblePlaceholder" placeholder="invisible" />`;

const htmlMonthsRemainingDisplay = `<label for="monthsRemaining">Months Remaining</label><br />
    <input type="number" style="width: 125px" name="monthsRemaining" value="$MONTHSREMAINING$" placeholder="months" />`;

const htmlBasisValueDisplay = `<label for="basisValue">Basis Value</label><br />
    <input type="number" style="width: 125px" name="basisValue" value="$BASISVALUE$" placeholder="original asset cost" />`;

/*
const htmlMonthsRemainingHidden = `<label class="hidable" for="monthsRemaining" style="display: none">Months Remaining</label><br class="hidable" style="display: none" />
    <input class="hidable" type="number" style="display: none; width: 125px" name="monthsRemaining" value="$MONTHSREMAINING$" placeholder="months" />`;
*/

const htmlUseForTaxesDisplayUnchecked = `<label for="taxChoice">Use for Taxes</label><br />
        <input type="radio" name="taxChoice" value="useForTaxes" />`;

const htmlUseForTaxesDisplayChecked = `<label for="taxChoice">Use for Taxes</label><br />
        <input type="radio" name="taxChoice" value="useForTaxes" checked />`;

const htmlSlotHidden = '';

const htmlHoldAllUntilFinishDisplayUnchecked = `<label for="taxChoice">Hold All Until Finish</label><br />
        <input type="radio" name="taxChoice" value="holdAllUntilFinish" />`;

const htmlHoldAllUntilFinishDisplayChecked = `<label for="taxChoice">Hold All Until Finish</label><br />
        <input type="radio" name="taxChoice" value="holdAllUntilFinish" checked />`;

const htmlAssetExpense = '';

const htmlAssets = '<div class="scrollable-x" id="assets"></div>';

const assetBase = 'asset';

export const positiveBackgroundColor = '#76ad76';
export const negativeBackgroundColor = '#ad7676';

//const colorRange = ['#33cc00','#cc3300','#0033cc','#cc9900','#00cc99','#9900cc','#cc33cc','#cc3333','#556B2F','#8FBC8B'];
export const colorRange = ['#3366cc', '#dc3912', '#ff9900', '#109618', '#990099', '#3b3eac', '#0099c6','#dd4477', '#66aa00', '#b82e2e', '#316395', '#994499', '#22aa99', '#aaaa11','#6633cc', '#e67300', '#8b0707', '#329262', '#5574a6', '#651067'];

function html_buildInstrumentOptions(instrument) {

    let html = '';
    const instruments = InstrumentType.all();
    for (const inst of instruments) {
        html += '<option value="' + inst.key + '"';
        if (inst.key == instrument)
            html += ' selected';
        html += '>' + inst.label + '</option>';
    }
    return html;

}

function html_buildStoryNameOptionsFromLocalStorage(activeStoryArc, activeStoryName) {

    let storyArcNamesKey = util_buildStoryArcKey(activeStoryArc, storyNamesKey);
    let storyNamesAsString = localStorage.getItem(storyArcNamesKey);
    if (!storyNamesAsString)
        storyNamesAsString = '[]';

    let storyNames = JSON.parse(storyNamesAsString);
    let html = '';
    for (const storyName of storyNames) {
        html += '<option value="' + storyName + '"';
        if (storyName == activeStoryName)
            html += ' selected';
        html += '>' + util_YYYYmmToDisplay(storyName) + '</option>';
    }
    return html;

}

function formatCompactCurrency(amount) {
    const num = parseFloat(amount);
    if (isNaN(num)) return '$0';
    const abs = Math.abs(num);
    const sign = num < 0 ? '-' : '';
    if (abs >= 1000000) return sign + '$' + (abs / 1000000).toFixed(1) + 'M';
    if (abs >= 1000) return sign + '$' + Math.round(abs / 1000).toLocaleString() + 'K';
    return sign + '$' + Math.round(abs);
}

function html_buildAssetHeader(modelAsset) {
    // Legacy — no longer called by html_buildRemovableAssetElement
    return '';
}

function html_buildInstrumentFields(instrument, modelAsset) {
    if (InstrumentType.isMonthlyIncome(instrument)) {
        const checked = modelAsset && modelAsset.isSelfEmployed ? ' checked' : '';
        return '<div class="instrument-fields-grid">'
            + '<div class="form-field">'
            + '<label class="flex items-center gap-2 cursor-pointer">'
            + '<input type="checkbox" name="isSelfEmployed"' + checked + ' />'
            + ' Self-Employed'
            + '</label>'
            + '</div>'
            + '</div>';
    }
    if (InstrumentType.isMonthsRemainingAble(instrument)) {
        const monthsVal = modelAsset ? modelAsset.monthsRemaining : 0;
        return '<div class="instrument-fields-grid">'
            + '<div class="form-field">'
            + '<label>Months Remaining</label>'
            + '<input type="number" class="width-full" name="monthsRemaining" value="' + monthsVal + '" placeholder="months" />'
            + '</div>'
            + '</div>';
    }
    if (InstrumentType.isTaxableAccount(instrument)) {
        const basisVal = modelAsset ? modelAsset.basisCurrency.toHTML() : '0';
        const divVal = modelAsset ? modelAsset.annualDividendRate.toHTML() : '0';
        const ltVal = modelAsset ? modelAsset.longTermCapitalGainRate.toHTML() : '0';
        return '<div class="instrument-fields-grid">'
            + '<div class="form-field">'
            + '<label>Basis Value</label>'
            + '<input type="number" class="width-full" name="basisValue" value="' + basisVal + '" step="0.01" placeholder="original cost" />'
            + '</div>'
            + '<div class="form-field">'
            + '<label>Dividend Rate %</label>'
            + '<input type="number" class="width-full" name="dividendRate" value="' + divVal + '" step="0.01" placeholder="annual %" />'
            + '</div>'
            + '<div class="form-field">'
            + '<label>Long-Term Rate %</label>'
            + '<input type="number" class="width-full" name="longTermRate" value="' + ltVal + '" step="0.01" placeholder="annual %" />'
            + '</div>'
            + '</div>';
    }
    if (InstrumentType.isHome(instrument)) {
        const basisVal = modelAsset ? modelAsset.basisCurrency.toHTML() : '0';
        return '<div class="instrument-fields-grid">'
            + '<div class="form-field">'
            + '<label>Basis Value</label>'
            + '<input type="number" class="width-full" name="basisValue" value="' + basisVal + '" step="0.01" placeholder="original cost" />'
            + '</div>'
            + '</div>';
    }
    return '';
}


function html_buildRemovableAssetElement(modelAssets, modelAsset) {
    let html = htmlAssetCard.slice();

    const color = colorRange[modelAsset.colorId] || colorRange[0];
    html = html.replaceAll('$BACKGROUNDCOLOR$', color);
    html = html.replace('$INSTRUMENTOPTIONS$', html_buildInstrumentOptions(modelAsset.instrument));

    // Emoji from InstrumentMeta
    const meta = InstrumentMeta.get(modelAsset.instrument);
    html = html.replace('$EMOJI$', meta ? meta.emoji : '');

    // Visible display name
    html = html.replace('$DISPLAYNAME_VIS$', modelAsset.displayName);

    // Hidden input values
    html = html.replace('$DISPLAYNAME$', modelAsset.displayName);
    html = html.replace('$STARTDATE$', modelAsset.startDateInt.toHTML());
    html = html.replace('$STARTVALUE$', modelAsset.startCurrency.toHTML());
    html = html.replace('$FINISHDATE$', modelAsset.finishDateInt.toHTML());

    const finishVal = ('finishCurrency' in modelAsset) ? modelAsset.finishCurrency.toHTML() : '0.0';
    html = html.replace('$FINISHVALUE$', finishVal);

    html = html.replace('$ANNUALRETURNRATE$', modelAsset.annualReturnRate.toHTML());

    const accVal = ('accumulatedCurrency' in modelAsset) ? modelAsset.accumulatedCurrency.toHTML() : '0.0';
    html = html.replace('$ACCUMULATEDVALUE$', accVal);

    const basisVal = ('basisCurrency' in modelAsset) ? modelAsset.basisCurrency.toHTML() : '0';
    html = html.replace('$BASISVALUE$', basisVal);

    html = html.replace('$MONTHSREMAINING$', modelAsset.monthsRemaining || '0');
    html = html.replace('$DIVIDENDRATE$', modelAsset.annualDividendRate ? modelAsset.annualDividendRate.toHTML() : '0');
    html = html.replace('$LONGTERMRATE$', modelAsset.longTermCapitalGainRate ? modelAsset.longTermCapitalGainRate.toHTML() : '0');

    if (modelAsset.fundTransfers)
        html = html.replace('$FUNDTRANSFERS$', util_escapedJSONStringify(modelAsset.fundTransfers));
    else
        html = html.replace('$FUNDTRANSFERS$', '');

    html = html.replace('$ISSELFEMPLOYED$', modelAsset.isSelfEmployed ? 'true' : 'false');

    // Displayed value — prefer finish value, fall back to start value
    const displayAmount = parseFloat(finishVal) !== 0 ? finishVal : modelAsset.startCurrency.toHTML();
    html = html.replace('$VALUE$', formatCompactCurrency(displayAmount));

    return html;
}

function html_buildAssetsElement() {
    return htmlAssets.slice();
}


// BEGIN TRANSFER ASSETS

const htmlTransferAsset =
`<form class="fund-transfer glass-card p-4" style="border-left: 4px solid $CARDCOLOR$">
    <div class="flex items-center gap-3 mb-3">
        <div class="text-2xl">$EMOJI$</div>
        <div class="flex-1 min-w-0">
            <div class="text-sm font-semibold text-gray-800 truncate">$TODISPLAYNAME$</div>
            <div class="text-xs text-gray-400">$INSTRUMENT$</div>
        </div>
    </div>
    <input type="hidden" name="toDisplayName" value="$TODISPLAYNAME$" />
    <div class="flex items-center gap-4">
        <label class="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
            <input type="checkbox" class="rounded" name="moveOnFinishDate" $MOVEONFINISHDATE$ />
            Move on Finish
        </label>
        <div class="flex items-center gap-2 ml-auto">
            <label class="text-xs text-gray-600">Move %</label>
            <input type="number" class="fin-input w-20 text-center text-sm" name="moveValue" value="$MOVEVALUE$" step="0.1" />
        </div>
    </div>
</form>`;

function html_applyModelAssetToPopupTransfers(modelAsset, popupFormsTransfersElement) {
    popupFormsTransfersElement.querySelector('#popupFormTransfers-title').innerHTML = modelAsset.displayName;
    //popupFormsTransfersElement.querySelector('#popupFormTransfers-monthlyEarning').value = modelAsset.monthlyEarnings[0];
    //popupFormsTransfersElement.querySelector('#popupFormTransfers-monthlyAfterTax').value = modelAsset.monthlyAfterTaxes[0];
    //popupFormsTransfersElement.querySelector('#popupFormTransfers-monthlyCredits').value = modelAsset.monthlyCredits[0];
    //popupFormsTransfersElement.querySelector('#popupFormTransfers-monthlyDebits').value = modelAsset.monthlyDebits[0];
}

function html_buildTransferrableAssets(modelAssets, currentDisplayName) {

    let currentModelAsset = findByName(modelAssets, currentDisplayName);

    let html = '';
    for (const modelAsset of modelAssets) {
        if (InstrumentType.isFundable(modelAsset.instrument)) {
            if (modelAsset.displayName != currentDisplayName) {
                html += html_buildTransferrableAsset(currentModelAsset, modelAsset);
            }
        }
    }
    return html;

}

function html_buildTransferrableAsset(currentModelAsset, transferrableModelAsset) {

    let html = htmlTransferAsset;
    html = html.replaceAll('$TODISPLAYNAME$', transferrableModelAsset.displayName);

    const color = colorRange[transferrableModelAsset.colorId] || colorRange[0];
    html = html.replace('$CARDCOLOR$', color);

    const meta = InstrumentMeta.get(transferrableModelAsset.instrument);
    html = html.replace('$EMOJI$', meta ? meta.emoji : '');
    html = html.replace('$INSTRUMENT$', meta ? meta.label : '');

    let moveOnFinishDate = '';
    let moveValue = 0;
    for (const fundTransfer of currentModelAsset.fundTransfers) {
        if (fundTransfer.toDisplayName == transferrableModelAsset.displayName) {
            moveValue = fundTransfer.moveValue;
            if (fundTransfer.moveOnFinishDate) {
                moveOnFinishDate = 'checked';
            }
            break;
        }
    }

    html = html.replace('$MOVEONFINISHDATE$', moveOnFinishDate);
    html = html.replace('$MOVEVALUE$', moveValue.toString());
    return html;

}

function html_setAssetElementFundTransfers(assetsContainerElement, currentDisplayName, fundTransfers) {
    const assetElements = assetsContainerElement.querySelectorAll('form');
    for (const assetElement of assetElements) {
        const displayName = assetElement.querySelector('[name="displayName"]').value;
        if (displayName == currentDisplayName) {
            fundTransfersElement = assetElement.querySelector('[name="fundTransfers"]');
            fundTransfersElement.setAttribute('data-fundtransfers', util_escapedJSONStringify(fundTransfers));
        }
    }
}

// Export for ES6 modules
export {
    html_buildInstrumentOptions,
    html_buildInstrumentFields,
    html_buildStoryNameOptionsFromLocalStorage,
    html_buildAssetHeader,
    html_buildRemovableAssetElement,
    html_buildAssetsElement,
    html_applyModelAssetToPopupTransfers,
    html_buildTransferrableAssets,
    html_buildTransferrableAsset,
    html_setAssetElementFundTransfers
};

