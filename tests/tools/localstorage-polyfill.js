/**
 * A minimal localStorage for Node, so a test can exercise globals.js.
 *
 * The engine takes its config as a value, so only tests that exercise the
 * settings store itself need this. Test tooling, not a shipped shim.
 */

  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
