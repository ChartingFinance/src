/**
 * A minimal localStorage for Node, so a test can exercise globals.js.
 *
 * It lived at js/mcp/polyfill.js until Spec 9 step 6, because the MCP server
 * had to fake browser storage before it could tell the engine its own filing
 * status. It does not any more — the engine takes a config as a value — so the
 * only remaining callers are the two tests that exercise the settings store
 * itself, and this is test tooling rather than a shipped shim.
 */

  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
