/**
 * index.js — Barrel export for the model layer
 *
 * import { ModelAsset, Currency, DateInt, InstrumentType } from './model/index.js';
 */

export { Currency }                    from './currency.js';
export { DateInt }                     from './date-int.js';
export { ARR }                         from './arr.js';
export { Instrument, InstrumentType, InstrumentMeta } from './instrument.js';
export { FundTransfer }                from './fund-transfer.js';
export { ModelAsset }                  from './model-asset.js';
export { TrackedMetric, MetricSet }    from './tracked-metric.js';
export { MonthsSpan }                  from './months-span.js';

export {
  AssetAppreciationResult,
  MortgageResult,
  IncomeResult,
  ExpenseResult,
  InterestResult,
  WithholdingResult,
  FundTransferResult,
  CapitalGainsResult,
} from './results.js';

export {
  firstDateInt,
  lastDateInt,
  findByName,
  removeByName,
  filterByInstrument,
  sortByInstrument,
} from './asset-queries.js';
