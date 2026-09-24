/**
 * share-link.js — the portfolio share link, in one place.
 *
 * The one definition of the share format, used by both the app's Share button
 * and the MCP server. DOM-free (no window, document or localStorage), so the
 * headless server can import it.
 *
 * ── The fragment, not the query ──────────────────────────────────────
 *
 * Links are built as `#portfolio=…`, not `?portfolio=…`.
 *
 * A query string is sent to the web server (and any proxy logs); a fragment is
 * never transmitted, so the portfolio stays on the machines that already had
 * it. Older query links are still accepted, but none are built.
 *
 * ── About `+` ────────────────────────────────────────────────────────
 *
 * `compressToEncodedURIComponent` emits `+`, which `URLSearchParams` reads back
 * as spaces; lz-string turns them back into `+`, so it works. Do not escape the
 * payload to "fix" it: that would break existing links.
 */

import LZString from 'lz-string';

/** The parameter name, in both the fragment and the legacy query. */
export const SHARE_PARAM = 'portfolio';

/**
 * A run handle: `plan_` followed by ten hex characters (mcp/run-plan.js mints
 * these from a sha1 of the spec).
 *
 * Anchored: this tells a handle from a payload, which works because `_` is not
 * in lz-string's URI-safe alphabet (tests/share-link.mjs checks this).
 */
export const PLAN_HANDLE_RE = /^plan_[0-9a-f]{10}$/;

/**
 * What did the user paste?
 *
 * Handle first — it is the strictest pattern and cannot collide. Then anything
 * carrying a scheme or starting at the fragment or query is a URL. Everything
 * else is treated as a bare payload, which is the shape you get when someone
 * copies the part after the "#" by itself.
 */
export function classifyPlanReference(text) {
    const s = String(text ?? '').trim();
    if (!s) return { kind: 'empty', value: s };
    if (PLAN_HANDLE_RE.test(s)) return { kind: 'handle', value: s };
    if (s.includes('://') || s.startsWith('#') || s.startsWith('?')) return { kind: 'url', value: s };
    return { kind: 'payload', value: s };
}

/** Where a link points when the caller does not say. */
export const DEFAULT_ORIGIN = 'https://charting.finance/';

/**
 * A length past which a link is worth mentioning, NOT refusing.
 *
 * The fragment has no hard length limit (it is never sent); only address bars
 * and mail clients may truncate a long link. Built-in profiles are a few KB, so
 * this flags only a genuinely enormous plan.
 */
export const SHARE_URL_SOFT_LIMIT = 16000;

/**
 * The share payload: what the app's importer reads, key for key.
 *
 * A plan spec ALREADY has this shape — `planFromProfile` returns exactly these
 * five keys — so this is a normalisation, not a translation. Anything else on
 * the spec is dropped rather than shipped, because the importer would ignore it
 * and a link should not carry what it cannot deliver.
 */
/**
 * The five keys that ARE the plan.
 *
 * A run handle is a hash of the spec, so anything else a link carries (such as
 * `handle` below) is stripped before the spec reaches the engine — otherwise a
 * plan sent out and read back would get a different handle.
 */
export const SPEC_KEYS = ['name', 'settings', 'modelAssets', 'lifeEvents', 'guardrailParams'];

export function sharePayloadFromPlan(spec, { name, handle } = {}) {
    if (!spec?.modelAssets?.length) {
        throw new Error('Cannot build a share link for a plan with no assets.');
    }
    const payload = {
        name:            name ?? spec.name ?? 'Shared Portfolio',
        settings:        spec.settings ?? {},
        modelAssets:     spec.modelAssets,
        lifeEvents:      spec.lifeEvents ?? [],
        guardrailParams: spec.guardrailParams ?? null,
    };

    // Provenance, not identity: the run this link was made from, so the app
    // can show which report it matches. Not part of the spec, and omitted when
    // absent (the app's own Share button has none).
    if (handle) payload.handle = handle;

    return payload;
}

/**
 * The spec inside a payload, with anything that is not the plan removed.
 *
 * Call this on the way IN. `planFromShareUrl` returns what the link carried,
 * which the app wants whole; the engine must only ever see the five keys.
 */
export function specFromPayload(payload) {
    if (!payload) return payload;
    const spec = {};
    for (const k of SPEC_KEYS) if (k in payload) spec[k] = payload[k];
    return spec;
}

export function encodeSharePayload(payload) {
    return LZString.compressToEncodedURIComponent(JSON.stringify(payload));
}

/** null — never a throw — for anything that does not decode to an object. */
export function decodeSharePayload(compressed) {
    if (!compressed) return null;
    try {
        const json = LZString.decompressFromEncodedURIComponent(compressed);
        if (!json) return null;
        const data = JSON.parse(json);
        return (data && typeof data === 'object') ? data : null;
    } catch {
        return null;
    }
}

/**
 * A plan spec to a link.
 *
 * Returns the length alongside the URL so a caller can say something about it
 * instead of discovering the size in a truncated mail client.
 */
export function shareUrlFromPlan(spec, { origin = DEFAULT_ORIGIN, name, handle } = {}) {
    const payload = sharePayloadFromPlan(spec, { name, handle });
    const compressed = encodeSharePayload(payload);
    const url = `${origin}#${SHARE_PARAM}=${compressed}`;
    return {
        url,
        length: url.length,
        oversize: url.length > SHARE_URL_SOFT_LIMIT,
        assetCount: payload.modelAssets.length,
        name: payload.name,
    };
}

/**
 * Pull the compressed payload out of a location, fragment first.
 *
 * Takes the two pieces rather than a `window`, so the server and the tests can
 * call it with strings. Either may be empty.
 */
export function sharePayloadParamFrom(search = '', hash = '') {
    const fromHash = String(hash).replace(/^#/, '');
    // A plain split, not URLSearchParams: the fragment is ours, and hand-parsing
    // it keeps `+` intact instead of relying on a second round of substitution.
    for (const part of fromHash.split('&')) {
        const eq = part.indexOf('=');
        if (eq > 0 && part.slice(0, eq) === SHARE_PARAM) return part.slice(eq + 1);
    }
    const params = new URLSearchParams(String(search));
    return params.get(SHARE_PARAM);   // legacy links, mailed before the fragment
}

/** A whole URL back to a payload, for tests and for anything holding a link. */
export function planFromShareUrl(url) {
    const hashAt = String(url).indexOf('#');
    const queryAt = String(url).indexOf('?');
    const hash = hashAt >= 0 ? url.slice(hashAt) : '';
    const search = queryAt >= 0 ? url.slice(queryAt, hashAt >= 0 ? hashAt : undefined) : '';
    return decodeSharePayload(sharePayloadParamFrom(search, hash));
}
