/**
 * app-state.js
 *
 * The app-level state. Setters write persisted fields through to localStorage
 * and notify subscribers, so views subscribe rather than being refreshed by
 * hand after every change.
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
   * Life events are bound to the editing config as they arrive: their derived
   * `triggerDateInt` throws when unbound, and events arrive from several places
   * that never pass through a Portfolio, all of them through this setter.
   *
   * This is the editor's config, not a run's; a Portfolio binds its own, so a
   * run is never affected by what the editor shows.
   */
  set lifeEvents(v) {
    const config = this.editingConfig;
    for (const event of v ?? []) event.bindEnv?.(config);
    this.#lifeEvents = v;
    this.#emit('lifeEvents', v);
  }

  /**
   * The config the editor's derived dates resolve against (see
   * editing-env.js). The app sets a new one whenever the assets change, since
   * the anchor comes from them. Setting it rebinds the events already held,
   * because events and assets can arrive in either order. Defaults to the empty
   * plan's anchor.
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
