/**
 * real-estate-engine.js
 *
 * Day 1 pipeline: property taxes, escrow
 * Day 15 pipeline: tax payment from escrow based on frequency
 * Day 30 pipeline: appreciation.
 *
 * Extracted from Portfolio to separate real estate concerns from the
 * simulation orchestrator.
 */

import { Currency } from '../utils/currency.js';
import { InstrumentType } from '../instruments/instrument.js';
import { Metric } from '../model-asset.js';
import { CreditMemo } from '../results.js';
import { activeTaxTable } from '../globals.js';
import { logger, LogCategory } from '../utils/logger.js';

export class RealEstateEngine {

    constructor(modelAssets, monthly, yearly, activeUser, router) {
        this.modelAssets = modelAssets;
        this.monthly = monthly;
        this.yearly = yearly;
        this.activeUser = activeUser;
        this.router = router;
    }

    applyPreTaxCalculations(modelAsset, currentDateInt) {

        if (InstrumentType.isRealEstate(modelAsset.instrument)) {

            let result = modelAsset.applyMonthly();
            this.monthly.addResult(result);

        }

    }

    // currently expense-engine handles escrow payment

    applyPostTaxTransfers(modelAsset, currentDateInt) {

        if (InstrumentType.isRealEstate(modelAsset.instrument)) {

            // TODO: track payment from source to escrow

        }
    }

}
