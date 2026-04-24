import { describe, it, expect, beforeEach } from 'vitest';

function mockLocalStorage() {
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _dump: () => ({ ...store }),
  };
}

const { AppState } = await import('../../js/app-state.js');

describe('AppState', () => {
  beforeEach(() => { mockLocalStorage(); });

  it('applies constructor defaults for ephemeral fields', () => {
    const s = new AppState({ metricName: 'value', microMetric: 'growth', portfolioView: 'flows' });
    expect(s.metricName).toBe('value');
    expect(s.microMetric).toBe('growth');
    expect(s.portfolioView).toBe('flows');
  });

  it('load() hydrates persisted fields from localStorage', () => {
    localStorage.setItem('activeStoryArc', 'retirement');
    localStorage.setItem('activeStoryName', '2026-03');
    const s = new AppState();
    s.load();
    expect(s.storyArc).toBe('retirement');
    expect(s.storyName).toBe('2026-03');
  });

  it('load() falls back to defaults when localStorage empty', () => {
    const s = new AppState();
    s.load();
    expect(s.storyArc).toBe('default');
    expect(s.storyName).toBeNull();
  });

  it('storyArc setter writes to localStorage', () => {
    const s = new AppState();
    s.storyArc = 'emergency';
    expect(localStorage.getItem('activeStoryArc')).toBe('emergency');
  });

  it('storyName setter writes to localStorage; null removes the key', () => {
    const s = new AppState();
    s.storyName = '2026-04';
    expect(localStorage.getItem('activeStoryName')).toBe('2026-04');
    s.storyName = null;
    expect(localStorage.getItem('activeStoryName')).toBeNull();
  });

  it('ephemeral fields do NOT touch localStorage', () => {
    const s = new AppState();
    s.portfolio = { id: 1 };
    s.lifeEvents = [{ type: 'retire' }];
    s.phaseIndex = 2;
    s.metricName = 'growth';
    s.microMetric = 'value';
    s.portfolioView = 'sankey';
    expect(localStorage._dump()).toEqual({});
  });

  it('emits change events to subscribers; unsubscribe stops emission', () => {
    const s = new AppState();
    const seen = [];
    const off = s.on('portfolio', v => seen.push(v));
    s.portfolio = { id: 1 };
    s.portfolio = { id: 2 };
    off();
    s.portfolio = { id: 3 };
    expect(seen).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('emitters are isolated per field', () => {
    const s = new AppState();
    const seen = [];
    s.on('storyArc', v => seen.push(['arc', v]));
    s.on('storyName', v => seen.push(['name', v]));
    s.storyArc = 'a';
    s.storyName = 'b';
    expect(seen).toEqual([['arc', 'a'], ['name', 'b']]);
  });
});
