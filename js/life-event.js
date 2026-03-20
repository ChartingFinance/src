/**
 * life-event.js
 *
 * First-class life event model for the financial timeline.
 * Mirrors the Instrument / InstrumentType / InstrumentMeta pattern:
 *
 *  1. LifeEvent       — frozen enum of event type keys
 *  2. LifeEventMeta   — Map of display metadata, default mutations, projection tabs
 *  3. LifeEventType   — Set-based O(1) classifiers
 *  4. ModelLifeEvent   — instance class with apply(), toJSON(), fromJSON()
 *
 * A ModelLifeEvent represents a user decision that rewires the portfolio:
 *   - Closing assets (e.g. stop salary)
 *   - Creating assets (e.g. Social Security income)
 *   - Owning fund transfers for assets during this phase
 *   - Overriding global parameters (e.g. inflation assumptions)
 *
 * The chronometer checks portfolio.lifeEvents each month and calls
 * event.apply(portfolio) when triggerDateInt matches.
 */

import { DateInt }        from './utils/date-int.js';
/** Inline to avoid circular dep with portfolio.js */
function findByName(assets, name) { return assets.find(a => a.displayName === name); }
import { logger, LogCategory } from './utils/logger.js';
import { global_user_startAge } from './globals.js';

// ── Event type enum ─────────────────────────────────────────────

export const LifeEvent = Object.freeze({
  ACCUMULATE: 'accumulate',
  BUY_HOME:   'buyHome',
  SELL_HOME:  'sellHome',
  RETIRE:     'retire',
});

// ── Display metadata ────────────────────────────────────────────

export const LifeEventMeta = new Map([
  [LifeEvent.ACCUMULATE, {
    label:       'Accumulate',
    color:       '#1D9E75',
    colorAccent: '#0F6E56',
    projectionTabs: ['value', 'monteCarlo', 'contributions', 'spreadsheet'],
    assetGroupLabels: { income: 'Income', capital: 'Capital', expenses: 'Expenses', taxes: 'Taxes' },
    defaultMutations: {
      closes:  [],
    },
    advisoryChecks: [],
  }],
  [LifeEvent.BUY_HOME, {
    label:       'Buy home',
    color:       '#378ADD',
    colorAccent: '#185FA5',
    projectionTabs: ['value', 'amortization', 'equityBuildup', 'spreadsheet'],
    assetGroupLabels: { income: 'Income', realestate: 'Real estate', capital: 'Capital', expenses: 'Expenses', taxes: 'Taxes' },
    defaultMutations: {
      closes:  [],
    },
    advisoryChecks: [
      { instrument: 'realEstate', message: 'No real estate asset found. Would you like to add one?' },
      { instrument: 'mortgage', message: 'No mortgage found. Would you like to add one?' },
    ],
  }],
  [LifeEvent.SELL_HOME, {
    label:       'Sell home',
    color:       '#888780',
    colorAccent: '#5F5E5A',
    projectionTabs: ['value', 'capitalGainsImpact', 'proceedsAllocation', 'spreadsheet'],
    assetGroupLabels: { distributions: 'Distributions', capital: 'Capital', closed: 'Closed', expenses: 'Expenses', taxes: 'Taxes' },
    defaultMutations: {
      closes:  ['Home', 'Mortgage'],
    },
    advisoryChecks: [],
  }],
  [LifeEvent.RETIRE, {
    label:       'Retire',
    color:       '#D85A30',
    colorAccent: '#993C1D',
    projectionTabs: ['value', 'guardrails', 'monteCarlo', 'spreadsheet'],
    assetGroupLabels: { distributions: 'Distributions', capital: 'Capital', expenses: 'Expenses', taxes: 'Taxes' },
    defaultMutations: {
      closes:  ['Salary'],
    },
    advisoryChecks: [
      { instrument: 'retirementIncome', message: 'No retirement income found. Would you like to add one?' },
    ],
  }],
]);

// ── Classification sets ─────────────────────────────────────────

const HAS_GUARDRAILS = new Set([
  LifeEvent.RETIRE,
]);

const HAS_MONTE_CARLO = new Set([
  LifeEvent.ACCUMULATE,
  LifeEvent.RETIRE,
]);

const CREATES_REAL_ESTATE = new Set([
  LifeEvent.BUY_HOME,
]);

const CLOSES_REAL_ESTATE = new Set([
  LifeEvent.SELL_HOME,
]);

// ── Public classifier API ───────────────────────────────────────

export const LifeEventType = Object.freeze({
  isAccumulation:  (v) => v === LifeEvent.ACCUMULATE,
  isRetirement:    (v) => v === LifeEvent.RETIRE,
  isHomePurchase:  (v) => v === LifeEvent.BUY_HOME,
  isHomeSale:      (v) => v === LifeEvent.SELL_HOME,
  hasGuardrails:   (v) => HAS_GUARDRAILS.has(v),
  hasMonteCarlo:   (v) => HAS_MONTE_CARLO.has(v),
  createsRealEstate: (v) => CREATES_REAL_ESTATE.has(v),
  closesRealEstate:  (v) => CLOSES_REAL_ESTATE.has(v),

  displayName: (v) => LifeEventMeta.get(v)?.label ?? v,
  color:       (v) => LifeEventMeta.get(v)?.color ?? '#888780',
  colorAccent: (v) => LifeEventMeta.get(v)?.colorAccent ?? '#5F5E5A',

  all: () => [...LifeEventMeta.entries()]
    .map(([key, meta]) => ({ key, ...meta })),
});

// ── Utility: age → DateInt ──────────────────────────────────────

function ageToDateInt(triggerAge) {
  const currentYear = new Date().getFullYear();
  const birthYear = currentYear - global_user_startAge;
  const triggerYear = birthYear + triggerAge;
  return DateInt.from(triggerYear, 1);
}

// ── ModelLifeEvent (instance) ───────────────────────────────────

export class ModelLifeEvent {

  /**
   * @param {Object} opts
   * @param {string}  opts.type           LifeEvent enum value
   * @param {string}  opts.displayName    User-facing name
   * @param {number}  opts.triggerAge     Age when event fires
   * @param {string[]}        [opts.closes]            Asset displayNames to close
   * @param {Object}          [opts.phaseTransfers]   { assetDisplayName: [FundTransfer JSON] }
   * @param {Object}          [opts.globalOverrides]    { inflationRate?: number, ... }
   */
  constructor({
    type,
    displayName,
    triggerAge,
    closes  = [],
    phaseTransfers = {},
    globalOverrides   = {},
  }) {
    this.type           = type;
    this.displayName    = displayName;
    this.triggerAge      = triggerAge;
    this.closes          = closes;
    this.phaseTransfers = phaseTransfers;
    this.globalOverrides   = globalOverrides;

    // Derived
    this.applied = false;
  }

  // ── Computed ──────────────────────────────────────────────────

  get triggerDateInt() {
    return ageToDateInt(this.triggerAge);
  }

  get meta() {
    return LifeEventMeta.get(this.type);
  }

  get projectionTabs() {
    return this.meta?.projectionTabs ?? ['value', 'spreadsheet'];
  }

  // ── Apply (called by chronometer) ─────────────────────────────

  /**
   * Execute this life event's mutations against the portfolio.
   * Called once when triggerDateInt matches the current simulation month.
   *
   * @param {Portfolio} portfolio
   * @param {DateInt}   currentDateInt
   */
  apply(portfolio, currentDateInt) {
    if (this.applied) return;
    this.applied = true;

    logger.log(LogCategory.GENERAL,
      `LifeEvent.apply: "${this.displayName}" (${this.type}) at ${currentDateInt}`);

    // 1. Close named assets
    for (const name of this.closes) {
      const asset = findByName(portfolio.modelAssets, name);
      if (asset && !asset.isClosed) {
        logger.log(LogCategory.TRANSFER,
          `LifeEvent closing asset: ${name}`);
        portfolio.closeAsset(asset, currentDateInt);
      }
    }

    // 2. Apply this phase's fund transfers to surviving assets
    portfolio.applyPhaseTransfers(this);

    // 3. Re-sort after closing
    portfolio.modelAssets = portfolio.sortModelAssets(portfolio.modelAssets);
  }

  // ── Factory (with defaults from meta) ─────────────────────────

  /**
   * Create a new ModelLifeEvent with sensible defaults for its type.
   * User can override any field.
   */
  static createDefault(type, triggerAge) {
    const meta = LifeEventMeta.get(type);
    if (!meta) throw new Error(`Unknown LifeEvent type: ${type}`);

    return new ModelLifeEvent({
      type,
      displayName:      meta.label,
      triggerAge,
      closes:           [...(meta.defaultMutations.closes || [])],
      phaseTransfers: {},
      globalOverrides:   {},
    });
  }

  /**
   * Build the default two-event timeline: Accumulate + Retire.
   * Uses global_user_startAge and global_user_retirementAge.
   */
  static defaultTimeline(startAge, retirementAge) {
    return [
      ModelLifeEvent.createDefault(LifeEvent.ACCUMULATE, startAge),
      ModelLifeEvent.createDefault(LifeEvent.RETIRE, retirementAge),
    ];
  }

  // ── Serialization ─────────────────────────────────────────────

  toJSON() {
    return {
      type:              this.type,
      displayName:       this.displayName,
      triggerAge:        this.triggerAge,
      closes:            this.closes,
      phaseTransfers: this.phaseTransfers,
      globalOverrides:   this.globalOverrides,
    };
  }

  static fromJSON(obj) {
    return new ModelLifeEvent({
      type:              obj.type,
      displayName:       obj.displayName,
      triggerAge:        obj.triggerAge,
      closes:            obj.closes ?? [],
      phaseTransfers: obj.phaseTransfers ?? obj.transferOverrides ?? {},
      globalOverrides:   obj.globalOverrides ?? {},
    });
  }

  // ── Copy ──────────────────────────────────────────────────────

  copy() {
    return ModelLifeEvent.fromJSON(structuredClone(this.toJSON()));
  }
}
