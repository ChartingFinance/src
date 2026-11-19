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
 * A ModelLifeEvent is a user decision that rewires the portfolio when it
 * fires: it closes assets (e.g. the salary at retirement) and installs this
 * phase's fund transfers. Both refer to assets by id, with the asset's name as a
 * label (plan-ids.js). A close can also name a type of asset, a template:
 * Retire's default closes every working income (see assetsClosedBy). `globalOverrides` is stored and saved but not
 * applied (see markdowns/code-issues-from-comments.md).
 *
 * Portfolio.applyLifeEvents calls event.apply(portfolio) in the month
 * triggerDateInt falls in.
 */

import { DateInt }        from './utils/date-int.js';
/** Inline to avoid circular dep with portfolio.js */
function findById(assets, id) { return assets.find(a => a.id === id); }
import { logger, LogCategory } from './utils/logger.js';
import { ageToDateIntFor } from './plan-dates.js';
import { Instrument } from './instruments/instrument.js';

// ── What a phase closes ─────────────────────────────────────────

/**
 * The assets one entry of a phase's `closes` closes when the phase fires.
 *
 * An entry is either one asset, `{ assetId, displayName }` (plan-ids.js), or a
 * template, `{ instrument }`, which names every asset of that type already
 * running in the month the phase fires. "Already running" matters: a job that
 * starts after retirement is a decision made for retirement, and Retire's
 * "close every working income" must not close it before it begins. An asset
 * named by id is closed whenever it starts: the user chose that asset.
 *
 * An entry with no id waits for an asset of its name (plan-ids.js) and closes
 * nothing. A bare string is an id, as a plan not yet prepared can hold one.
 *
 * @param {string|{assetId?: string, displayName?: string}|{instrument: string}} entry
 * @param {ModelAsset[]} assets
 * @param {DateInt} dateInt  the month the phase fires
 * @returns {ModelAsset[]}
 */
export function assetsClosedBy(entry, assets, dateInt) {
  const id = closeAssetId(entry);
  if (id != null) {
    const asset = findById(assets, id);
    return asset ? [asset] : [];
  }
  if (isCloseTemplate(entry)) {
    return assets.filter((a) => a.instrument === entry.instrument
      && !(a.startDateInt && a.startDateInt.isAfter(dateInt)));
  }
  return [];
}

/** True for a `closes` entry that names a type of asset rather than one asset. */
export function isCloseTemplate(entry) {
  return !!entry && typeof entry === 'object' && typeof entry.instrument === 'string';
}

/**
 * The id of the one asset a `closes` entry names, or null: for a template, and
 * for an entry waiting by name for an asset the plan does not have.
 */
export function closeAssetId(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && !isCloseTemplate(entry)) return entry.assetId ?? null;
  return null;
}

// ── Event type enum ─────────────────────────────────────────────

export const LifeEvent = Object.freeze({
  ACCUMULATE: 'accumulate',
  RETIRE:     'retire',
});

// ── Display metadata ────────────────────────────────────────────

export const LifeEventMeta = new Map([
  [LifeEvent.ACCUMULATE, {
    label:       'Accumulate',
    emoji:       '',
    color:       '#1D9E75',
    colorAccent: '#0F6E56',
    projectionTabs: ['value', 'monteCarlo', 'contributions', 'spreadsheet'],
    assetGroupLabels: { income: 'Income', capital: 'Capital', expenses: 'Expenses', taxes: 'Taxes' },
    defaultMutations: {
      closes:  [],
    },
    advisoryChecks: [],
  }],
  [LifeEvent.RETIRE, {
    label:       'Retire',
    emoji:       '',
    color:       '#D85A30',
    colorAccent: '#993C1D',
    projectionTabs: ['value', 'guardrails', 'monteCarlo', 'spreadsheet'],
    assetGroupLabels: { distributions: 'Distributions', capital: 'Capital', expenses: 'Expenses', taxes: 'Taxes' },
    defaultMutations: {
      // Every working income still running at retirement, whatever it is
      // called. It was ['Salary'], a name, which matched nothing in five of the
      // eight quick-start profiles ("Salary A" and "Salary B" were paid on).
      closes:  [{ instrument: Instrument.WORKING_INCOME }],
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

// ── Public classifier API ───────────────────────────────────────

export const LifeEventType = Object.freeze({
  isAccumulation:  (v) => v === LifeEvent.ACCUMULATE,
  isRetirement:    (v) => v === LifeEvent.RETIRE,
  hasGuardrails:   (v) => HAS_GUARDRAILS.has(v),
  hasMonteCarlo:   (v) => HAS_MONTE_CARLO.has(v),

  /** True for phase-level events (Accumulate, Retire) that define timeline segments */
  isPhase:       (v) => v === LifeEvent.ACCUMULATE || v === LifeEvent.RETIRE,

  displayName: (v) => LifeEventMeta.get(v)?.label ?? v,
  emoji:       (v) => LifeEventMeta.get(v)?.emoji ?? '',
  color:       (v) => LifeEventMeta.get(v)?.color ?? '#888780',
  colorAccent: (v) => LifeEventMeta.get(v)?.colorAccent ?? '#5F5E5A',

  all: () => [...LifeEventMeta.entries()]
    .map(([key, meta]) => ({ key, ...meta })),
});

// ── Utility: age → DateInt ──────────────────────────────────────

function ageToDateInt(triggerAge, env) {
  return ageToDateIntFor(env, triggerAge);
}

// ── ModelLifeEvent (instance) ───────────────────────────────────

export class ModelLifeEvent {

  /**
   * @param {Object} opts
   * @param {string|null} [opts.id]       unique within its plan; plan-ids.js gives it out
   * @param {string}  opts.type           LifeEvent enum value
   * @param {string}  opts.displayName    User-facing name
   * @param {number}  opts.triggerAge     Age when event fires
   * @param {Array<{assetId?: string, displayName?: string}|{instrument: string}>} [opts.closes]
   *     What it closes: assets, by id and name, or templates (assetsClosedBy)
   * @param {Object}          [opts.phaseTransfers]   { assetId: [FundTransfer JSON] }
   * @param {Object}          [opts.globalOverrides]    { inflationRate?: number, ... }
   */
  constructor({
    id = null,
    type,
    displayName,
    triggerAge,
    closes  = [],
    phaseTransfers = {},
    globalOverrides   = {},
  }) {
    this.id             = id;
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

  /**
   * Bind the run's config — the same contract as ModelAsset.bindEnv: owned by
   * the Portfolio, borrowed here, non-enumerable. copy() goes through JSON, so a
   * copy is unbound until Portfolio.copy() rebinds it.
   */
  bindEnv(config) {
    Object.defineProperty(this, 'env', {
      value: config, writable: true, enumerable: false, configurable: true,
    });
    return this;
  }

  get triggerDateInt() {
    // See the note on ModelAsset's #boundEnv: the fallback is gone on purpose.
    if (!this.env) {
      throw new Error(
        `ModelLifeEvent "${this.displayName ?? this.type}" has no environment. `
        + `triggerDateInt is derived from the plan's start age. Events are `
        + `bound by Portfolio.bindEnvironment() for a run, and by AppState's `
        + `lifeEvents setter for the editor; this one went through neither.`);
    }
    return ageToDateInt(this.triggerAge, this.env);
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

    // MONTHLY, not GENERAL: per-month detail, and the GA re-runs the
    // chronometer thousands of times. GENERAL is kept for rare, important
    // lines.
    logger.log(LogCategory.MONTHLY,
      () => `LifeEvent.apply: "${this.displayName}" (${this.type}) at ${currentDateInt}`);

    // 1. Close what it names: assets by id, and templates by type
    //    (assetsClosedBy). An entry waiting by name for an asset the plan does
    //    not have closes nothing.
    for (const entry of this.closes) {
      for (const asset of assetsClosedBy(entry, portfolio.modelAssets, currentDateInt)) {
        if (asset.isClosed) continue;
        logger.log(LogCategory.TRANSFER,
          () => `LifeEvent closing asset: ${asset.displayName}`);
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
      // Deep: a template is an object, and must not be shared with the meta.
      closes:           structuredClone(meta.defaultMutations.closes || []),
      phaseTransfers: {},
      globalOverrides:   {},
    });
  }

  /**
   * Build the default two-event timeline: Accumulate + Retire.
   * Takes the ages as arguments; reads no globals.
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
      id:                this.id,
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
      id:                obj.id ?? null,
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
    return ModelLifeEvent.fromJSON(JSON.parse(JSON.stringify(this.toJSON())));
  }
}
