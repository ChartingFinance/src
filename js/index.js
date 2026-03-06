/**
 * index.js — Barrel export for the model layer
 *
 * import { ModelAsset, Currency, DateInt, InstrumentType } from './model/index.js';
 */

export { Currency }                    from './utils/currency.js';
export { DateInt }                     from './utils/date-int.js';
export { ARR }                         from './utils/arr.js';
export { Instrument, InstrumentType, InstrumentMeta } from './instruments/instrument.js';
export { FundTransfer }                from './fund-transfer.js';
export { ModelAsset }                  from './model-asset.js';
export { TrackedMetric, MetricSet }    from './tracked-metric.js';
export { MonthsSpan }                  from './utils/months-span.js';

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
