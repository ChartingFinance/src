/**
 * app-state.js
 *
 * Single source of truth for app-level state previously held as module-scope
 * `active*` vars in finplan-app.js. Setters write through to localStorage for
 * persisted fields and fire a simple event emitter so views can subscribe
 * instead of being hand-wired after every mutation.
 *
 * Persisted fields: storyArc, storyName.
 * Ephemeral fields (per session): portfolio, lifeEvents, editingConfig,
 *   phaseIndex, metricName, microMetric, portfolioView.
 */

import { editingConfigFor } from './editing-env.js';

const STORAGE_KEY_STORY_ARC  = 'activeStoryArc';
const STORAGE_KEY_STORY_NAME = 'activeStoryName';

export class AppState {
  #portfolio     = null;
  #lifeEvents    = [];
  #storyArc      = 'default';
  #storyName     = null;
  #phaseIndex    = 0;
  #metricName    = null;
  #microMetric   = null;
  #portfolioView = 'assets';
  #editingConfig = null;

  #listeners = new Map();

  /**
   * @param {Object} [defaults]
   * @param {string} [defaults.metricName]
   * @param {string} [defaults.microMetric]
   * @param {string} [defaults.portfolioView]
   */
  constructor(defaults = {}) {
    if (defaults.metricName    != null) this.#metricName    = defaults.metricName;
    if (defaults.microMetric   != null) this.#microMetric   = defaults.microMetric;
    if (defaults.portfolioView != null) this.#portfolioView = defaults.portfolioView;
  }

  /** Hydrate persisted fields from localStorage. */
  load() {
    this.#storyArc  = localStorage.getItem(STORAGE_KEY_STORY_ARC)  || 'default';
    this.#storyName = localStorage.getItem(STORAGE_KEY_STORY_NAME) || null;
  }

  // ── Subscription ──────────────────────────────────────────────

  /**
   * Subscribe to field changes. Returns an unsubscribe function.
   * @param {string} field
   * @param {(value:any) => void} callback
   */
  on(field, callback) {
    if (!this.#listeners.has(field)) this.#listeners.set(field, new Set());
    this.#listeners.get(field).add(callback);
    return () => this.#listeners.get(field)?.delete(callback);
  }

  #emit(field, value) {
    const subs = this.#listeners.get(field);
    if (!subs) return;
    for (const cb of subs) cb(value);
  }

  // ── Persisted fields ──────────────────────────────────────────

  get storyArc() { return this.#storyArc; }
  set storyArc(v) {
    this.#storyArc = v;
    localStorage.setItem(STORAGE_KEY_STORY_ARC, v);
    this.#emit('storyArc', v);
  }

  get storyName() { return this.#storyName; }
  set storyName(v) {
    this.#storyName = v;
    if (v != null) localStorage.setItem(STORAGE_KEY_STORY_NAME, v);
    else           localStorage.removeItem(STORAGE_KEY_STORY_NAME);
    this.#emit('storyName', v);
  }

  // ── Ephemeral fields ──────────────────────────────────────────

  get portfolio() { return this.#portfolio; }
  set portfolio(v) { this.#portfolio = v; this.#emit('portfolio', v); }

  get lifeEvents() { return this.#lifeEvents; }

  /**
   * Life events are bound to an editing environment as they arrive (Spec 9
   * step 4b).
   *
   * `triggerDateInt` is a DERIVED getter — it needs the plan's start age — and
   * under 4b an unbound read throws. Events reach the app from four places
   * (Quick Start, localStorage, defaultTimeline, the legacy quick-start
   * helper) and NONE of them passes through a Portfolio, so binding at the one
   * setter they all funnel through is the single place that covers every route.
   *
   * This environment is the EDITING one, captured from the current settings so
   * the timeline renders what the user has configured. It is deliberately not
   * the same object as a run's: `Portfolio` captures its own at construction
   * and rebinds everything it owns, so a run can never be affected by whatever
   * the editor happens to be showing.
   */
  set lifeEvents(v) {
    const config = this.editingConfig;
    for (const event of v ?? []) event.bindEnv?.(config);
    this.#lifeEvents = v;
    this.#emit('lifeEvents', v);
  }

  /**
   * The environment the editor's derived dates resolve against — see
   * editing-env.js for why it must be anchored to the plan rather than to the
   * clock.
   *
   * The app pushes a fresh one whenever the asset list changes, because the
   * anchor is derived from the assets and this object never sees them. Setting
   * it REBINDS the events already held: the two collections do not arrive in a
   * fixed order (loading a shared scenario sets the events first, so it can
   * migrate legacy per-asset transfers onto the accumulate phase before the
   * assets exist), and an anchor that only applied to whatever arrived last
   * would leave the other half resolving against a stale plan.
   *
   * The default is the empty plan's anchor, which is what a first-run app with
   * nothing loaded actually has.
   */
  get editingConfig() {
    return this.#editingConfig ??= editingConfigFor([]);
  }

  set editingConfig(config) {
    this.#editingConfig = config;
    for (const event of this.#lifeEvents ?? []) event.bindEnv?.(config);
    this.#emit('editingConfig', config);
  }

  get phaseIndex() { return this.#phaseIndex; }
  set phaseIndex(v) { this.#phaseIndex = v; this.#emit('phaseIndex', v); }

  get metricName() { return this.#metricName; }
  set metricName(v) { this.#metricName = v; this.#emit('metricName', v); }

  get microMetric() { return this.#microMetric; }
  set microMetric(v) { this.#microMetric = v; this.#emit('microMetric', v); }

  get portfolioView() { return this.#portfolioView; }
  set portfolioView(v) { this.#portfolioView = v; this.#emit('portfolioView', v); }
}
